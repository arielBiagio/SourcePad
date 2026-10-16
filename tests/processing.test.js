import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { runExtraction } from '../src/processing/runner.js';
import { ProcessingError } from '../src/processing/extract.js';
import { fakeSupabase } from './helpers/fake-supabase.js';
import { pdfFixture } from './helpers/pdf-fixture.js';

let fake, server, base, a, b, notebook, other, extractor;
const request = (path, cookie = a, method = 'GET', body) => fetch(base + path, {
  method, headers: { origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const root = () => '/api/notebooks/' + notebook + '/documents';
const process = id => request(root() + '/' + id + '/process', a, 'POST');
const upload = async (bytes = pdfFixture(), name = 'prueba.pdf') => {
  const form = new FormData(); form.append('file', new Blob([bytes]), name);
  const response = await fetch(base + root(), { method: 'POST', headers: { origin: 'http://localhost:3000', cookie: a }, body: form });
  assert.equal(response.status, 201);
  return (await response.json()).document.id;
};
before(async () => {
  fake = await fakeSupabase();
  const config = readConfig({ AUTH_PROVIDER: 'supabase', SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  const app = await createApp({ config, extractionRunner: (...args) => extractor(...args) });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async () => {
  extractor = runExtraction;
  const account = async () => {
    const response = await request('/api/auth/sign-up/email', null, 'POST', { name: 'QA', email: randomUUID() + '@example.test', password: 'Testing123!' });
    assert.equal(response.status, 201);
    return response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  };
  a = await account(); b = await account();
  const book = async cookie => (await (await request('/api/notebooks', cookie, 'POST', { title: 'Procesamiento' })).json()).notebook.id;
  notebook = await book(a); other = await book(b);
});
after(async () => {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fake.close();
});

test('procesa PDF por página, guarda fragmentos privados y repetir no duplica el trabajo', async () => {
  const id = await upload(pdfFixture(['First page', '', 'Third page']));
  const response = await process(id);
  assert.equal(response.status, 200);
  const { document } = await response.json();
  assert.equal(document.status, 'extracted');
  assert.equal(document.page_count, 3);
  assert.equal(document.empty_page_count, 1);
  assert.equal(document.chunk_count, 2);
  assert.equal(document.object_path, undefined);
  const chunks = await request(root() + '/' + id + '/chunks');
  assert.equal(chunks.status, 200);
  assert.match(chunks.headers.get('cache-control'), /no-store/);
  const result = await chunks.json();
  assert.deepEqual(result.chunks.map(c => c.page_number), [1, 3]);
  assert.equal(result.nextOffset, null);
  assert.equal((await process(id)).status, 200);
  assert.equal(fake.jobs.get(id).attempts, 1);
});

test('no se puede procesar ni leer fragmentos de otra cuenta o de otro cuaderno', async () => {
  const id = await upload();
  for (const method of ['GET','POST']) {
    const suffix = method === 'GET' ? '/chunks' : '/process';
    assert.equal((await request(root() + '/' + id + suffix, null, method)).status, 401);
    assert.equal((await request(root() + '/' + id + suffix, b, method)).status, 404);
    assert.equal((await request('/api/notebooks/' + other + '/documents/' + id + suffix, b, method)).status, 404);
  }
  assert.equal((await request(root() + '/' + id + '/chunks')).status, 409);
  assert.equal((await request(root() + '/' + id + '/process', a, 'POST', {})).status, 200);
  assert.equal((await request(root() + '/' + id + '/chunks', b)).status, 404);
});

test('PDF sin texto o dañado falla de forma explícita sin dejar fragmentos parciales', async () => {
  for (const [bytes, code] of [[pdfFixture(['']), 'NO_TEXT'], [Buffer.from('%PDF-1.7\nbroken\n%%EOF'), 'INVALID_FILE']]) {
    const id = await upload(bytes);
    const response = await process(id);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, code);
    assert.equal(fake.jobs.get(id).status, 'failed');
    assert.equal(fake.documents.get(id).status, 'error');
    assert.equal(fake.chunks.has(id), false);
    assert.equal((await request(root() + '/' + id + '/chunks')).status, 409);
  }
});

test('verifica tamaño y hash del original antes de extraerlo', async () => {
  const id = await upload(Buffer.from('Texto original'), 'notas.txt');
  fake.objects.set(fake.documents.get(id).object_path, Buffer.from('Texto cambiado'));
  const response = await process(id);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'INTEGRITY');
  assert.equal(fake.chunks.has(id), false);
});

test('un timeout persistido puede reintentarse y recuperar un trabajo con lease vencido', async () => {
  const id = await upload(Buffer.from('Texto recuperable'), 'notas.txt');
  extractor = async () => { throw new ProcessingError('TIMEOUT'); };
  assert.equal((await process(id)).status, 504);
  assert.equal(fake.jobs.get(id).error_code, 'TIMEOUT');
  extractor = runExtraction;
  // Simular proceso anterior interrumpido: no permitir trabajo duplicado mientras vive el lease.
  Object.assign(fake.jobs.get(id), { status: 'running', lease_until: new Date(Date.now() + 120000).toISOString() });
  fake.documents.get(id).status = 'processing';
  assert.equal((await process(id)).status, 409);
  fake.jobs.get(id).lease_until = new Date(Date.now() - 1000).toISOString();
  assert.equal((await process(id)).status, 200);
  assert.equal(fake.jobs.get(id).attempts, 2);
});

test('pagina fragmentos TXT sin páginas inventadas y valida offsets', async () => {
  const id = await upload(Buffer.from('Palabras de prueba. '.repeat(2000)), 'grande.txt');
  assert.equal((await process(id)).status, 200);
  const first = await (await request(root() + '/' + id + '/chunks')).json();
  assert.equal(first.chunks.length, 20);
  assert.equal(first.nextOffset, 20);
  const next = await (await request(root() + '/' + id + '/chunks?offset=20')).json();
  assert.equal(next.chunks[0].position, 20);
  assert.equal(next.chunks[0].page_number, null);
  for (const value of ['-1','1.5','NaN','1500']) assert.equal((await request(root() + '/' + id + '/chunks?offset=' + value)).status, 400);
});

test('borrar durante la extracción cancela el trabajo y un resultado atrasado no revive la fuente', async () => {
  const id = await upload(Buffer.from('Texto para borrar'), 'notas.txt');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  extractor = async (...args) => { entered(); await gate; return runExtraction(...args); };
  const running = process(id);
  try {
    await ready;
    assert.equal((await process(id)).status, 429);
    assert.equal((await request(root() + '/' + id, a, 'DELETE')).status, 204);
    release();
    assert.equal((await running).status, 409);
    assert.equal(fake.documents.get(id).status, 'deleted');
    assert.equal(fake.jobs.get(id).status, 'cancelled');
    assert.equal(fake.chunks.has(id), false);
  } finally { release(); await running; }
});
