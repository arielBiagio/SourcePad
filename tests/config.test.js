import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig, publicConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { validateHistory } from '../src/chat.js';

test('Qwen3.8 es el generador predeterminado, configurable sin modificar BGE-M3', () => {
  const config = readConfig({});
  assert.equal(config.chatModel,'qwen/qwen3.8-flash');
  assert.equal(publicConfig(config).embeddingModel,'baai/bge-m3');
  const overridden = readConfig({ OPENROUTER_CHAT_MODEL: 'test/another-model' });
  assert.equal(overridden.chatModel,'test/another-model');
  assert.equal(publicConfig(overridden).embeddingModel,'baai/bge-m3');
});

test('configuraciones inválidas y clave administrativa fallan explícitamente', () => {
  assert.throws(() => readConfig({ AUTH_PROVIDER: 'typo' }));
  assert.throws(() => readConfig({ PORT: 'NaN' }));
  assert.throws(() => readConfig({ APP_URL: 'file:///tmp/test' }));
  assert.throws(() => readConfig({ SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test' }));
  for (const limit of ['0', '-1', 'NaN', '1.5', '10485761']) assert.throws(() => readConfig({ MAX_UPLOAD_BYTES: limit }));
  const jwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.signature';
  assert.throws(() => readConfig({ SUPABASE_ANON_KEY: jwt }));
});
test('Supabase sin proyecto arranca y comunica setup pendiente, sin fallback de cuentas', async () => {
  const app = await createApp({ config: readConfig({ AUTH_PROVIDER: 'supabase' }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.ready, false);
    assert.equal(config.authProvider, 'supabase');
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/me')).status, 503);
    assert.equal((await fetch(base + '/api/notebooks')).status, 503);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
test('se preserva la ventana de historial existente y los límites de mensajes', () => {
  const history = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  const result = validateHistory({ historial: history });
  assert.equal(result.length, 7);
  assert.equal(result[0].role, 'system');
  assert.equal(result[1].content, '3');
  assert.throws(() => validateHistory({ historial: [] }));
  assert.throws(() => validateHistory({ historial: [{ role: 'user', content: 'a'.repeat(16001) }] }));
});
