import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { publicConfig } from './config.js';
import { createSupabaseAuth, safeUser } from './auth/supabase.js';
import { createNotebookRepository, mountNotebooks } from './notebooks.js';
import { createDocumentRepository, mountDocuments } from './documents.js';
import { createProcessingRepository, mountDocumentProcessing } from './processing/service.js';
import { createEmbeddingRepository, mountEmbeddings } from './embeddings/service.js';
import { createChatStream, validateHistory } from './chat.js';
import { createRagRepository, mountRag } from './rag.js';
import { createConversationRepository,mountConversations,withConversationHistory } from './conversations.js';
import { HttpError, asyncRoute, errorHandler } from './errors.js';
import { CHAT_LIMITS } from '../public/contracts.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function createApp({ config, authAdapter, notebookRepository, documentRepository, extractionRunner, embedder, chatStream, rateLimitFactory = rateLimit } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) res.set('Cache-Control', 'private, no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.appURL) {
      return next(new HttpError(403, 'Origen de la petición no permitido.'));
    }
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json(publicConfig(config)));
  app.use('/api/auth', rateLimitFactory({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiados intentos. Esperá unos minutos.' },
  }));

  let auth = authAdapter;
  if (config.authProvider === 'legacy') {
    if (!auth) {
      // El sistema anterior sólo se carga en modo legacy; Supabase no abre SQLite.
      const [{ auth: legacy }, { toNodeHandler, fromNodeHeaders }] = await Promise.all([
        import('../auth.js'), import('better-auth/node'),
      ]);
      auth = {
        mount: () => app.all('/api/auth/*splat', toNodeHandler(legacy)),
        getUser: async (req) => {
          const session = await legacy.api.getSession({ headers: fromNodeHeaders(req.headers) });
          return session ? safeUser(session.user) : null;
        },
      };
    }
    auth.mount(app); // Better Auth lee el cuerpo crudo.
    app.use(express.json({ limit: CHAT_LIMITS.requestBytes }));
  } else {
    app.use(express.json({ limit: CHAT_LIMITS.requestBytes }));
    auth ||= createSupabaseAuth(config);
    auth.mount?.(app);
  }
  const requireAuth = asyncRoute(async (req, res, next) => {
    const user = await auth.getUser(req, res);
    if (!user) throw new HttpError(401, 'Iniciá sesión para continuar.', 'UNAUTHENTICATED');
    req.user = user;
    next();
  });
  app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user, home: publicConfig(config).home }));
  const repository = notebookRepository || createNotebookRepository(auth.getClient);
  mountNotebooks(app, requireAuth, repository, config.authProvider === 'supabase' && config.supabaseReady);
  mountDocuments(app, documentRepository || createDocumentRepository(auth.getClient), config, rateLimitFactory);
  mountDocumentProcessing(app, createProcessingRepository(auth.getClient, extractionRunner), rateLimitFactory);
  const embeddings = createEmbeddingRepository(auth.getClient, config, embedder);
  mountEmbeddings(app, embeddings, rateLimitFactory);

  const streamFromModel = chatStream || createChatStream(config);
  const conversations = createConversationRepository(auth.getClient);
  mountConversations(app,conversations);
  mountRag(app, withConversationHistory(createRagRepository(embeddings, streamFromModel, config),conversations), rateLimitFactory);
  app.post('/api/chat', requireAuth, rateLimitFactory({
    windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Esperá un momento antes de enviar más mensajes.' },
  }), asyncRoute(async (req, res) => {
    const messages = validateHistory(req.body);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const stream = await streamFromModel(messages, controller.signal);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    try {
      for await (const chunk of stream) {
        if (controller.signal.aborted) break;
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) res.write(text);
      }
      res.end();
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) res.destroy();
      else throw error instanceof HttpError ? error : new HttpError(502, 'La respuesta del modelo se interrumpió.');
    }
  }));

  // Allowlist: ninguna base, backup, credencial ni archivo del backend es público.
  for (const [route, file] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/auth.html', 'auth.html'], ['/notebooks.html', 'notebooks.html']]) {
    app.get(route, (req, res) => res.sendFile(file, { root }));
  }
  app.get('/assets/purify.min.js', (req, res) => res.sendFile('node_modules/dompurify/dist/purify.min.js', { root }));
  app.get('/assets/marked.umd.js', (req, res) => res.sendFile('node_modules/marked/lib/marked.umd.js', { root }));
  app.get('/assets/pdf.mjs', (req, res) => res.sendFile('node_modules/pdfjs-dist/build/pdf.mjs', { root }));
  app.get('/assets/pdf.worker.mjs', (req, res) => res.sendFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', { root }));
  app.use('/assets', express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: false, dotfiles: 'deny' }));
  app.use((req, res, next) => next(new HttpError(404, 'Recurso no encontrado.')));
  app.use(errorHandler);
  return app;
}
