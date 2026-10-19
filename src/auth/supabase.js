import { createServerClient } from '@supabase/ssr';
import { parseCookie as parse, stringifySetCookie } from 'cookie';
import { HttpError, asyncRoute } from '../errors.js';

const serialize = (name, value, options) => stringifySetCookie({ name, value, ...options });

export function safeUser(user) {
  return { id: user.id, email: user.email, name: user.user_metadata?.name || user.name || user.email };
}

function authFailure(error) {
  if (error.code === 'invalid_credentials') return new HttpError(401, 'Email o contraseña incorrectos.');
  if (error.code === 'email_not_confirmed') return new HttpError(403, 'Confirmá tu email antes de entrar.');
  if (error.status === 429) return new HttpError(429, 'Demasiados intentos. Esperá unos minutos.');
  if (error.status >= 500 || !error.status) return new HttpError(503, 'No se pudo conectar con el servicio de acceso.');
  return new HttpError(400, 'No se pudo completar el acceso. Revisá los datos e intentá nuevamente.');
}

function validateCredentials(body, registration = false) {
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Ingresá un email válido.');
  if (typeof password !== 'string' || password.length < (registration ? 8 : 1) || password.length > 128) {
    throw new HttpError(400, registration ? 'La contraseña debe tener entre 8 y 128 caracteres.' : 'Ingresá tu contraseña.');
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (registration && (!name || name.length > 100)) throw new HttpError(400, 'El nombre debe tener entre 1 y 100 caracteres.');
  return { email, password, name };
}

export function createSupabaseAuth(config, clientFactory = createServerClient) {
  function getClient(req, res) {
    if (!config.supabaseReady) throw new HttpError(503, 'Todavía falta conectar Supabase.', 'SETUP_REQUIRED');
    if (req.supabase) return req.supabase;
    const cookies = parse(req.headers.cookie || '');
    const remember = typeof req.body?.rememberMe === 'boolean' ? req.body.rememberMe : cookies['mc-remember'] !== '0';
    req.supabase = clientFactory(config.supabaseURL, config.supabaseKey, {
      global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }) },
      cookieOptions: { name: 'mc-session', httpOnly: true, sameSite: 'lax', secure: config.appURL.startsWith('https://'), path: '/' },
      cookies: {
        getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
        setAll: (updates, headers = {}) => {
          for (const [name, value] of Object.entries(headers)) res.set(name, value);
          for (const { name, value, options } of updates) {
            cookies[name] = value;
            res.append('Set-Cookie', serialize(name, value, {
              ...options,
              maxAge: options.maxAge === 0 ? 0 : remember ? options.maxAge : undefined,
              httpOnly: true, sameSite: 'lax', secure: config.appURL.startsWith('https://'), path: '/',
            }));
          }
        },
      },
    });
    return req.supabase;
  }

  async function getUser(req, res) {
    const client = getClient(req, res);
    const { data, error } = await client.auth.getUser();
    const invalidSession = ['bad_jwt', 'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired'].includes(error?.code);
    if (error && !invalidSession && error.status !== 401 && error.status !== 403 && error.name !== 'AuthSessionMissingError') throw authFailure(error);
    return error || !data.user ? null : safeUser(data.user);
  }

  function mount(app) {
    app.post('/api/auth/sign-in/email', asyncRoute(async (req, res) => {
      const { email, password } = validateCredentials(req.body);
      const { data, error } = await getClient(req, res).auth.signInWithPassword({ email, password });
      if (error) throw authFailure(error);
      res.append('Set-Cookie', serialize('mc-remember', req.body.rememberMe === false ? '0' : '1', {
        httpOnly: true, sameSite: 'lax', secure: config.appURL.startsWith('https://'), path: '/',
        ...(req.body.rememberMe === false ? {} : { maxAge: 60 * 60 * 24 * 365 }),
      }));
      res.json({ user: safeUser(data.user) });
    }));
    app.post('/api/auth/sign-up/email', asyncRoute(async (req, res) => {
      const { name, email, password } = validateCredentials(req.body, true);
      const { data, error } = await getClient(req, res).auth.signUp({
        email, password, options: { data: { name }, emailRedirectTo: config.appURL + '/auth/callback' },
      });
      if (error) throw authFailure(error);
      // Con confirmación de email activa no existe sesión todavía.
      res.status(201).json({ confirmationRequired: !data.session, ...(data.session ? { user: safeUser(data.user) } : {}) });
    }));
    app.post('/api/auth/sign-out', asyncRoute(async (req, res) => {
      const { error } = await getClient(req, res).auth.signOut({ scope: 'local' });
      if (error) throw authFailure(error);
      res.json({ ok: true });
    }));
    const completePkce = asyncRoute(async (req, res) => {
      res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store' });
      const code = req.query.code;
      // El correo estándar verifica el email en Supabase y vuelve con un código.
      // La cookie del registro contiene el verificador PKCE, nunca lo acepta el cliente por query.
      if (req.query.error || typeof code !== 'string' || !code.trim() || code.length > 4096) {
        return res.redirect('/auth.html?confirmation=error');
      }
      const { data, error } = await getClient(req, res).auth.exchangeCodeForSession(code);
      if (error || !data.session) {
        const browserChanged = error?.code === 'pkce_code_verifier_not_found';
        return res.redirect('/auth.html?confirmation=' + (browserChanged ? 'browser' : 'error'));
      }
      // Destino fijo: no se acepta un redirect externo proporcionado por el enlace.
      res.redirect('/notebooks.html');
    });
    app.get('/auth/callback', completePkce);
    // Admite también los correos anteriores que redirigían a /auth.html.
    app.get('/auth.html', (req, res, next) => {
      if (Object.hasOwn(req.query, 'code') || Object.hasOwn(req.query, 'error')) return completePkce(req, res, next);
      next();
    });
    app.get('/auth/confirm', asyncRoute(async (req, res) => {
      res.set('Referrer-Policy', 'no-referrer');
      if (typeof req.query.token_hash !== 'string' || req.query.type !== 'email') {
        return res.redirect('/auth.html?confirmation=error');
      }
      const { error } = await getClient(req, res).auth.verifyOtp({ token_hash: req.query.token_hash, type: 'email' });
      res.redirect(error ? '/auth.html?confirmation=error' : '/notebooks.html');
    }));
  }
  return { getUser, mount, getClient };
}
