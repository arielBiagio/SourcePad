import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';

// Dobles locales de Auth/PostgREST. NO certifican RLS de PostgreSQL.
export async function fakeSupabase() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  const users = new Map();
  const sessions = new Map();
  const refreshTokens = new Map();
  const notebooks = new Map();
  const documents = new Map();
  const objects = new Map();
  const jobs = new Map();
  const chunks = new Map();
  const embeddingJobs = new Map();
  const embeddings = new Map();
  const confirmationCodes = new Map();
  const queries = [];
  let confirmEmail = false;
  let unavailable = false;
  let failUpload = false;
  let failRemove = false;
  let failEmbeddingStore = false;
  let expireNext = false;
  const makeTokens = user => {
    const exp = Math.floor(Date.now() / 1000) + (expireNext ? -60 : 3600);
    const access_token = [ { alg: 'HS256', typ: 'JWT' }, { sub: user.id, exp, aud: 'authenticated', role: 'authenticated', jti: randomUUID() } ]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.test-signature';
    const session = { access_token, refresh_token: randomUUID(), user, token_type: 'bearer', expires_in: expireNext ? -60 : 3600, expires_at: exp };
    expireNext = false;
    sessions.set(access_token, user);
    refreshTokens.set(session.refresh_token, user);
    return session;
  };
  app.use((req, res, next) => {
    res.set('X-Supabase-Api-Version', '2024-01-01');
    if (unavailable) return res.status(503).json({ message: 'Simulated unavailable' });
    next();
  });
  app.post('/auth/v1/signup', (req, res) => {
    const { email, password, data } = req.body;
    if (users.has(email)) return res.status(400).json({ code: 'user_already_exists', msg: 'User exists' });
    const user = { id: randomUUID(), email, user_metadata: data || {}, aud: 'authenticated', created_at: new Date().toISOString() };
    users.set(email, { user, password });
    const pending = confirmEmail || email.endsWith('@confirm.example.test');
    if (pending) confirmationCodes.set(randomUUID(), { user, challenge: req.body.code_challenge, redirectTo: req.query.redirect_to });
    res.json(pending ? user : makeTokens(user));
  });
  app.post('/auth/v1/token', (req, res) => {
    if (req.query.grant_type === 'pkce') {
      const record = confirmationCodes.get(req.body.auth_code);
      const challenge = typeof req.body.code_verifier === 'string'
        ? createHash('sha256').update(req.body.code_verifier).digest('base64url') : '';
      if (!record || record.challenge !== challenge) return res.status(400).json({ code: 'bad_code_verifier', msg: 'Invalid or used code' });
      confirmationCodes.delete(req.body.auth_code);
      return res.json(makeTokens(record.user));
    }
    if (req.query.grant_type === 'refresh_token') {
      const user = refreshTokens.get(req.body.refresh_token);
      if (!user) return res.status(400).json({ code: 'refresh_token_not_found', msg: 'Refresh invalid' });
      refreshTokens.delete(req.body.refresh_token);
      return res.json(makeTokens(user));
    }
    const account = users.get(req.body.email);
    if (!account || account.password !== req.body.password) {
      return res.status(400).json({ code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    res.json(makeTokens(account.user));
  });
  app.get('/auth/v1/user', (req, res) => {
    const user = sessions.get(req.headers.authorization?.replace('Bearer ', ''));
    if (!user) return res.status(401).json({ code: 'bad_jwt', msg: 'Invalid JWT' });
    res.json(user);
  });
  app.post('/auth/v1/logout', (req, res) => {
    sessions.delete(req.headers.authorization?.replace('Bearer ', ''));
    res.status(204).end();
  });
  app.post('/auth/v1/verify', (req, res) => res.status(403).json({ code: 'otp_expired', msg: 'Expired' }));
  // Simula el enlace ConfirmationURL del correo estándar (nunca envía correos).
  app.get('/auth/v1/verify', (req, res) => {
    const record = confirmationCodes.get(req.query.token);
    if (!record) return res.status(403).json({ code: 'otp_expired' });
    const destination = new URL(record.redirectTo);
    destination.searchParams.set('code', req.query.token);
    res.redirect(destination.href);
  });
  app.all('/rest/v1/notebooks', (req, res) => {
    queries.push({ method: req.method, query: req.query, body: req.body });
    const user = sessions.get(req.headers.authorization?.replace('Bearer ', ''));
    if (!user) return res.status(401).json({ message: 'Not authenticated' });
    const matches = row => row.owner_id === user.id
      && (!req.query.id || 'eq.' + row.id === req.query.id)
      && (!req.query.owner_id || 'eq.' + row.owner_id === req.query.owner_id);
    const visible = [...notebooks.values()].filter(matches);
    if (req.method === 'GET') return res.json(visible);
    if (req.method === 'POST') {
      if (req.body.owner_id !== user.id) return res.status(403).json({ message: 'Owner mismatch' });
      const row = { ...req.body, id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      notebooks.set(row.id, row);
      return res.status(201).json(row);
    }
    if (req.method === 'PATCH') {
      for (const row of visible) Object.assign(row, req.body, { updated_at: new Date().toISOString() });
      return res.json(visible[0] || null);
    }
    if (req.method === 'DELETE') {
      for (const row of visible) notebooks.delete(row.id);
      return res.json(visible[0] || null);
    }
    res.sendStatus(405);
  });
  const userFor = req => sessions.get(req.headers.authorization?.replace('Bearer ', ''));
  const turns = new Map();
  let failHistory = false;
  app.all('/rest/v1/notebook_turns',(req,res) => {
    const user = userFor(req);
    if (!user) return res.status(401).json({});
    if (failHistory) { failHistory = false; return res.status(503).json({ message: 'Simulated history failure' }); }
    const matches = row => row.owner_id === user.id && notebooks.get(row.notebook_id)?.owner_id === user.id
      && (!req.query.notebook_id || 'eq.'+row.notebook_id === req.query.notebook_id)
      && (!req.query.owner_id || 'eq.'+row.owner_id === req.query.owner_id);
    if (req.method === 'GET') return res.json([...turns.values()].filter(matches).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,Number(req.query.limit || 31)));
    if (req.method === 'POST') {
      if (req.body.owner_id !== user.id || notebooks.get(req.body.notebook_id)?.owner_id !== user.id) return res.status(403).json({});
      const row = { ...req.body,id: randomUUID(),created_at: new Date().toISOString() }; turns.set(row.id,row); return res.status(201).json(row);
    }
    if (req.method === 'DELETE') { for (const [id,row] of turns) if (matches(row)) turns.delete(id); return res.status(204).end(); }
    res.sendStatus(405);
  });
  const ownedDocument = (req, path) => [...documents.values()].find(d => d.owner_id === userFor(req)?.id && d.object_path === path);
  app.all('/rest/v1/documents', (req, res) => {
    const user = userFor(req);
    if (!user) return res.status(401).json({});
    const matches = row => row.owner_id === user.id
      && (!req.query.id || 'eq.' + row.id === req.query.id)
      && (!req.query.notebook_id || 'eq.' + row.notebook_id === req.query.notebook_id)
      && (!req.query.owner_id || 'eq.' + row.owner_id === req.query.owner_id)
      && (!req.query.status || 'neq.' + row.status !== req.query.status);
    if (req.method === 'GET') return res.json([...documents.values()].filter(matches));
    if (req.method === 'POST') {
      if (req.body.owner_id !== user.id || notebooks.get(req.body.notebook_id)?.owner_id !== user.id) return res.status(403).json({});
      const data = { ...req.body, status: 'uploading', error_message: null, deleted_at: null, page_count: null, empty_page_count: 0, chunk_count: 0, processed_at: null, processing_version: null,
        index_status: 'not_indexed', indexed_chunk_count: 0, embedding_profile: null, embedded_at: null, embedding_error: null, created_at: new Date().toISOString(),
        object_path: req.body.owner_id + '/' + req.body.notebook_id + '/' + req.body.id + '.' + req.body.extension };
      documents.set(data.id, data);
      return res.status(201).json(data);
    }
    res.sendStatus(405);
  });
  app.get('/rest/v1/document_chunks', (req, res) => {
    const user = userFor(req);
    if (!user) return res.status(401).json({});
    const data = [...chunks.values()].flat().filter(row => row.owner_id === user.id
      && ['extracted','ready'].includes(documents.get(row.document_id)?.status)
      && (!req.query.document_id || 'eq.' + row.document_id === req.query.document_id)
      && (!req.query.notebook_id || 'eq.' + row.notebook_id === req.query.notebook_id)
      && (!req.query.owner_id || 'eq.' + row.owner_id === req.query.owner_id));
    const offset = Number(req.query.offset || 0), limit = Number(req.query.limit || 20);
    res.json(data.sort((a,b) => a.position - b.position).slice(offset, offset + limit));
  });
  app.post('/rest/v1/rpc/:name', (req, res) => {
    const user = userFor(req);
    const failure = code => res.status(400).json({ code, message: 'Simulated transition failure' });
    if (!user) return failure('P0002');
    const profile = 'baai/bge-m3:dense:1024:cosine:v1';
    if (['notebook_indexed_source_count','match_notebook_chunks'].includes(req.params.name)) {
      const notebook = notebooks.get(req.body.notebook_id);
      if (!notebook || notebook.owner_id !== user.id) return failure('P0002');
      const ready = [...documents.values()].filter(d => d.owner_id === user.id && d.notebook_id === notebook.id && d.status === 'ready' && d.index_status === 'indexed' && d.embedding_profile === profile);
      const ids = req.body.source_ids;
      if (ids && (!ids.length || ids.length > 20 || ids.some(id => !ready.some(d => d.id === id)))) return failure('P0002');
      const selected = ready.filter(d => !ids || ids.includes(d.id));
      if (req.params.name === 'notebook_indexed_source_count') return res.json(selected.length);
      const query = JSON.parse(req.body.query_embedding);
      const matches = selected.flatMap(d => (embeddings.get(d.id) || []).map(e => {
        const chunk = chunks.get(d.id).find(c => c.position === e.position);
        return { document_id: d.id, filename: d.filename, position: chunk.position, page_number: chunk.page_number, content: chunk.content, char_start: chunk.char_start, char_end: chunk.char_end,
          similarity: e.embedding.reduce((sum,value,index) => sum + value * query[index],0) };
      })).sort((a,b) => b.similarity - a.similarity).slice(0,req.body.match_limit);
      return res.json(matches);
    }
    if (req.params.name === 'delete_empty_notebook') {
      const notebook = notebooks.get(req.body.notebook_id);
      if (!notebook || notebook.owner_id !== user.id) return failure('P0002');
      if ([...documents.values()].some(d => d.notebook_id === notebook.id && d.status !== 'deleted')) return failure('55000');
      notebooks.delete(notebook.id); return res.json(null);
    }
    const document = documents.get(req.body.document_id);
    if (!document || document.owner_id !== user.id) return failure('P0002');
    const job = jobs.get(document.id);
    const embeddingJob = embeddingJobs.get(document.id);
    if (req.params.name === 'begin_document_indexing') {
      if (!['extracted','ready'].includes(document.status) || !document.chunk_count
        || (embeddingJob?.status === 'running' && new Date(embeddingJob.lease_until) > new Date())) return failure('55000');
      const existing = embeddings.get(document.id) || [];
      const pending = (chunks.get(document.id) || []).map(c => ({ position: c.position, content: c.content, content_sha256: createHash('sha256').update(c.content).digest('hex') }))
        .filter(c => !existing.some(e => e.position === c.position && e.content_sha256 === c.content_sha256)).slice(0,32);
      if (!pending.length) { Object.assign(document,{ status: 'ready', index_status: 'indexed', indexed_chunk_count: document.chunk_count, embedding_profile: profile }); return res.json({ complete: true }); }
      const next = { run_id: randomUUID(), attempts: (embeddingJob?.attempts || 0) + 1, status: 'running', lease_until: new Date(Date.now() + 120000).toISOString(), pending_positions: pending.map(c => c.position) };
      embeddingJobs.set(document.id,next); document.index_status = 'indexing'; document.embedding_error = null;
      return res.json({ complete: false, run_id: next.run_id, chunks: pending });
    } else if (req.params.name === 'store_document_embeddings') {
      if (failEmbeddingStore) { failEmbeddingStore = false; return res.status(503).json({ message: 'Simulated embedding store failure' }); }
      if (!['extracted','ready'].includes(document.status) || embeddingJob?.status !== 'running' || embeddingJob.run_id !== req.body.indexing_run || new Date(embeddingJob.lease_until) <= new Date()) return failure('55000');
      embeddings.set(document.id,[...(embeddings.get(document.id) || []).filter(e => !req.body.items.some(i => i.position === e.position)),...req.body.items]);
      const count = embeddings.get(document.id).length, complete = count === document.chunk_count;
      Object.assign(document,{ index_status: complete ? 'indexed' : 'partial', status: complete ? 'ready' : 'extracted', indexed_chunk_count: count, embedding_profile: profile, embedded_at: complete ? new Date().toISOString() : null, embedding_error: null });
      embeddingJob.status = complete ? 'succeeded' : 'pending'; embeddingJob.lease_until = null;
    } else if (req.params.name === 'fail_document_indexing') {
      if (['extracted','ready'].includes(document.status) && embeddingJob?.status === 'running' && embeddingJob.run_id === req.body.indexing_run) {
        document.index_status = 'error'; document.embedding_error = 'La indexación se interrumpió. Podés reintentar.';
        embeddingJob.status = 'failed'; embeddingJob.lease_until = null; embeddingJob.error_code = req.body.failure_code;
      }
    } else if (req.params.name === 'begin_document_processing') {
      if (!['uploaded','error','processing'].includes(document.status) || !objects.has(document.object_path)
        || (job?.status === 'running' && new Date(job.lease_until) > new Date())) return failure('55000');
      const next = { document_id: document.id, run_id: randomUUID(), attempts: (job?.attempts || 0) + 1, status: 'running', lease_until: new Date(Date.now() + 120000).toISOString() };
      jobs.set(document.id, next); document.status = 'processing'; document.error_message = null;
      document.processing_version = 'text-v1-char1200-overlap180';
      return res.json({ run_id: next.run_id, attempts: next.attempts });
    } else if (req.params.name === 'complete_document_processing') {
      if (document.status !== 'processing' || job?.status !== 'running' || job.run_id !== req.body.processing_run || new Date(job.lease_until) <= new Date()) return failure('55000');
      chunks.set(document.id, req.body.chunks.map((chunk, position) => ({ ...chunk, position, document_id: document.id, notebook_id: document.notebook_id, owner_id: document.owner_id, version: document.processing_version })));
      Object.assign(document, { status: 'extracted', page_count: req.body.page_total, chunk_count: req.body.chunks.length, processed_at: new Date().toISOString(), error_message: null,
        empty_page_count: req.body.page_total ? req.body.page_total - new Set(req.body.chunks.map(c => c.page_number)).size : 0 });
      job.status = 'succeeded'; job.lease_until = null;
    } else if (req.params.name === 'fail_document_processing') {
      if (document.status === 'processing' && job?.status === 'running' && job.run_id === req.body.processing_run) {
        document.status = 'error'; document.error_message = req.body.failure_code === 'NO_TEXT' ? 'No se encontró texto seleccionable. Si es un escaneo, necesita OCR (todavía no disponible).' : 'No se pudo procesar el documento. Intentá nuevamente.';
        job.status = 'failed'; job.error_code = req.body.failure_code; job.lease_until = null;
      }
    } else if (req.params.name === 'complete_document_upload') {
      if (document.status !== 'uploading' || !objects.has(document.object_path)) return failure('55000');
      document.status = 'uploaded';
    } else if (req.params.name === 'fail_document_upload') {
      if (document.status === 'uploading') { document.status = 'error'; document.error_message = 'Subida fallida'; }
    } else if (req.params.name === 'begin_document_delete') {
      document.status = 'deleting'; document.chunk_count = 0; document.page_count = null; document.empty_page_count = 0; document.processed_at = null;
      chunks.delete(document.id);
      embeddings.delete(document.id);
      Object.assign(document,{ index_status: 'not_indexed', indexed_chunk_count: 0, embedding_profile: null, embedded_at: null, embedding_error: null });
      if (embeddingJob) { embeddingJob.status = 'cancelled'; embeddingJob.lease_until = null; }
      if (job?.status === 'running') { job.status = 'cancelled'; job.lease_until = null; }
    }
    else if (req.params.name === 'complete_document_delete') {
      if (document.status !== 'deleting' || objects.has(document.object_path)) return failure('55000');
      document.status = 'deleted'; document.deleted_at = new Date().toISOString();
    } else return failure('42883');
    res.json(null);
  });
  app.post('/storage/v1/object/notebook-sources/*path', express.raw({ type: () => true, limit: '11mb' }), (req, res) => {
    const path = req.params.path.join('/');
    const document = ownedDocument(req, path);
    if (!document || document.status !== 'uploading') return res.status(403).json({ message: 'Denied' });
    if (failUpload) { failUpload = false; return res.status(503).json({ message: 'Simulated upload failure' }); }
    objects.set(path, Buffer.from(req.body));
    res.json({ Key: 'notebook-sources/' + path, Id: document.id });
  });
  app.get('/storage/v1/object/notebook-sources/*path', (req, res) => {
    const path = req.params.path.join('/');
    const document = ownedDocument(req, path);
    if (!document || document.status === 'deleted' || !objects.has(path)) return res.status(404).json({});
    res.type(document.mime_type).send(objects.get(path));
  });
  app.delete('/storage/v1/object/notebook-sources', (req, res) => {
    if (failRemove) { failRemove = false; return res.status(503).json({ message: 'Simulated delete failure' }); }
    for (const path of req.body.prefixes || []) {
      if (ownedDocument(req, path)?.status !== 'deleting') return res.status(403).json({});
      objects.delete(path);
    }
    res.json([]);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    queries, users, sessions, documents, objects, jobs, chunks, embeddings, embeddingJobs,turns,
    failNextHistory: () => { failHistory = true; },
    failNextEmbeddingStore: () => { failEmbeddingStore = true; },
    failNextUpload: () => { failUpload = true; },
    failNextRemove: () => { failRemove = true; },
    confirmationCode: email => [...confirmationCodes.entries()].find(([, record]) => record.user.email === email)?.[0],
    confirmationLink: email => {
      const code = [...confirmationCodes.entries()].find(([, record]) => record.user.email === email)?.[0];
      return code ? 'http://127.0.0.1:' + server.address().port + '/auth/v1/verify?token=' + code : null;
    },
    signupRedirect: email => [...confirmationCodes.values()].find(record => record.user.email === email)?.redirectTo,
    setConfirmEmail: value => { confirmEmail = value; },
    expireNextSession: () => { expireNext = true; },
    setUnavailable: value => { unavailable = value; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
