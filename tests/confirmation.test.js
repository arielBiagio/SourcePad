import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { fakeSupabase } from './helpers/fake-supabase.js';

let fake, server, base;
const cookiesFrom = response => response.headers.getSetCookie().filter(value => !value.includes('Max-Age=0')).map(value => value.split(';')[0]).join('; ');
before(async () => {
  fake = await fakeSupabase();
  fake.setConfirmEmail(true);
  const config = readConfig({ AUTH_PROVIDER: 'supabase', SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  const app = await createApp({ config });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fake.close();
});
async function signup() {
  const email = randomUUID() + '@confirm.example.test';
  const response = await fetch(base + '/api/auth/sign-up/email', {
    method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Confirmación', email, password: 'Testing123!' }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).confirmationRequired, true);
  return { email, cookie: cookiesFrom(response), code: fake.confirmationCode(email) };
}
const callback = (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

test('registro prepara PKCE y solicita redirigir el correo predeterminado al callback', async () => {
  const account = await signup();
  assert.equal(fake.signupRedirect(account.email), 'http://localhost:3000/auth/callback');
  assert.match(account.cookie, /mc-session-code-verifier=/);
});
test('el callback intercambia el código por cookies HttpOnly y abre los cuadernos', async () => {
  const { cookie, code } = await signup();
  const response = await callback('/auth/callback?code=' + code + '&next=https://evil.test', cookie);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/notebooks.html');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.getSetCookie().every(value => value.includes('HttpOnly')));
  const me = await fetch(base + '/api/me', { headers: { cookie: cookiesFrom(response) } });
  assert.equal(me.status, 200);
  const replay = await callback('/auth/callback?code=' + code, cookie);
  assert.equal(replay.headers.get('location'), '/auth.html?confirmation=error');
});
test('si el correo se abre en otro navegador se ofrece entrar con email y contraseña', async () => {
  const { code } = await signup();
  const response = await callback('/auth/callback?code=' + code);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/auth.html?confirmation=browser');
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith('mc-session=') && !value.includes('Max-Age=0')), false);
});
test('códigos vacíos, repetidos, inválidos y errores del proveedor vuelven al login', async () => {
  for (const query of ['', '?code=', '?code=a&code=b', '?error=access_denied&error_description=secret', '?next=https://evil.test']) {
    const response = await callback('/auth/callback' + query);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/auth.html?confirmation=error');
  }
});
test('los enlaces previos que vuelven a auth.html también completan PKCE', async () => {
  const { cookie, code } = await signup();
  const response = await callback('/auth.html?code=' + code, cookie);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/notebooks.html');
});
