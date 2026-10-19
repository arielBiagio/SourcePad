import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

test('Better Auth sigue funcionando, probado en SQLite en memoria sin abrir auth.sqlite', async () => {
  const database = new Database(':memory:');
  const auth = betterAuth({
    database, secret: 'test-only-secret-at-least-32-characters-123456',
    baseURL: 'http://localhost:3000', emailAndPassword: { enabled: true },
  });
  await (await getMigrations(auth.options)).runMigrations();
  const app = await createApp({
    config: readConfig({ AUTH_PROVIDER: 'legacy' }),
    authAdapter: {
      mount: app => app.all('/api/auth/*splat', toNodeHandler(auth)),
      getUser: async req => (await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }))?.user || null,
    },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(base + '/api/auth/sign-up/email', {
      method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legacy Test', email: 'legacy@example.test', password: 'Testing123!' }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    assert.equal((await fetch(base + '/api/me', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/notebooks', { headers: { cookie } })).status, 503);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    database.close();
  }
});
