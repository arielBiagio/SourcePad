export function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido');
  const authProvider = env.AUTH_PROVIDER || 'legacy';
  if (!['legacy', 'supabase'].includes(authProvider)) throw new Error('AUTH_PROVIDER debe ser legacy o supabase');
  const parsedAppURL = new URL(env.APP_URL || `http://localhost:${port}`);
  if (!['https:', 'http:'].includes(parsedAppURL.protocol) || parsedAppURL.username || parsedAppURL.password) throw new Error('APP_URL debe ser un origen HTTP o HTTPS válido');
  const appURL = parsedAppURL.origin;
  const supabaseURL = env.SUPABASE_URL || '';
  if (supabaseURL && !['https:', 'http:'].includes(new URL(supabaseURL).protocol)) throw new Error('SUPABASE_URL inválida');
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
  const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES || 10485760);
  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > 10485760) throw new Error('MAX_UPLOAD_BYTES debe estar entre 1 y 10485760');
  // La clave administrativa no es necesaria para operaciones de usuarios: todas pasan por RLS.
  if (supabaseKey.startsWith('sb_secret_')) throw new Error('Usá la clave publishable, no la clave secreta');
  if (supabaseKey.split('.').length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(supabaseKey.split('.')[1], 'base64url'));
      if (claims.role === 'service_role') throw new Error('No uses service_role como clave pública');
    } catch (error) {
      if (error.message.includes('service_role')) throw error;
      throw new Error('La clave anon no tiene formato JWT válido');
    }
  }
  return {
    port, appURL, authProvider, supabaseURL, supabaseKey, maxUploadBytes,
    supabaseReady: Boolean(supabaseURL && supabaseKey),
    openRouterKey: env.OPENROUTER_API_KEY || '',
    chatModel: env.OPENROUTER_CHAT_MODEL || 'qwen/qwen3.8-flash',
  };
}

export function publicConfig(config) {
  return {
    authProvider: config.authProvider,
    ready: config.authProvider === 'legacy' || config.supabaseReady,
    notebooksEnabled: config.authProvider === 'supabase' && config.supabaseReady,
    home: config.authProvider === 'supabase' ? '/notebooks.html' : '/index.html',
    maxUploadBytes: config.maxUploadBytes,
    embeddingsConfigured: Boolean(config.openRouterKey),
    embeddingModel: 'baai/bge-m3',
  };
}
