import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { validateFile } from '../src/documents.js';
import { fakeSupabase } from './helpers/fake-supabase.js';

let fake, server, base, a, b, first, second, foreign;
const json = (path, cookie, method = 'GET', body) => fetch(base + path, {
  method, headers: { origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const docs = notebook => '/api/notebooks/' + notebook + '/documents';
const upload = (notebook, cookie, filename = 'notas.txt', bytes = 'Contenido de prueba', extraFile = false) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  if (extraFile) form.append('file', new Blob(['otra fuente']), 'otra.txt');
  return fetch(base + docs(notebook), { method: 'POST', headers: { origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) }, body: form });
};
before(async () => {
  fake = await fakeSupabase();
  const config = readConfig({ AUTH_PROVIDER: 'supabase', SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', MAX_UPLOAD_BYTES: '1024' });
  const app = await createApp({ config });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  async function account() {
    const response = await json('/api/auth/sign-up/email', null, 'POST', { name: 'Test', email: randomUUID() + '@example.test', password: 'Testing123!' });
    return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  }
  a = await account(); b = await account();
  const create = async cookie => (await (await json('/api/notebooks', cookie, 'POST', { title: 'Documentos' })).json()).notebook.id;
  first = await create(a); second = await create(a); foreign = await create(b);
});
after(async () => {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fake.close();
});

test('formatos: extensión, contenido, UTF-8 y nombres se validan en backend', () => {
  const file = (name, content) => ({ originalname: name, buffer: Buffer.from(content) });
  assert.equal(validateFile(file('apuntes.md', '# Tema')).mime_type, 'text/markdown');
  assert.equal(validateFile(file('informe.PDF', '%PDF-1.7\nobj\n%%EOF')).extension, 'pdf');
  for (const invalid of [file('x.pdf', 'no soy PDF'), file('x.txt', [0, 255]), file('x.exe', 'texto'), file('x.txt', '  '), file('../ruta.txt', 'texto')]) {
    assert.throws(() => validateFile(invalid));
  }
});
test('sube una fuente privada, la lista sin rutas de storage y permite descargarla', async () => {
  const response = await upload(first, a, 'guía de estudio 📝.txt');
  assert.equal(response.status, 201);
  const { document } = await response.json();
  assert.equal(document.status, 'uploaded');
  assert.equal(document.filename, 'guía de estudio 📝.txt');
  assert.equal(document.object_path, undefined);
  assert.equal(document.sha256, undefined);
  assert.equal(document.owner_id, undefined);
  const list = await (await json(docs(first), a)).json();
  assert.equal(list.documents[0].id, document.id);
  const download = await json(docs(first) + '/' + document.id + '/download', a);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'Contenido de prueba');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  assert.match(download.headers.get('cache-control'), /no-store/);
});
test('autenticación y aislamiento por usuario Y cuaderno', async () => {
  const { document } = await (await upload(second, a)).json();
  assert.equal((await upload(second, null)).status, 401);
  assert.equal((await upload(foreign, a)).status, 404);
  for (const [notebook, cookie] of [[first, a], [second, b]]) {
    assert.equal((await json(docs(notebook) + '/' + document.id + '/download', cookie)).status, 404);
    assert.equal((await json(docs(notebook) + '/' + document.id, cookie, 'DELETE')).status, 404);
  }
  assert.equal((await json(docs(foreign), a)).status, 404);
});
test('rechaza tamaño, contenido y multipart con varios archivos', async () => {
  assert.equal((await upload(first, a, 'grande.txt', 'a'.repeat(1025))).status, 413);
  assert.equal((await upload(first, a, 'falso.pdf', 'texto')).status, 415);
  assert.equal((await upload(first, a, 'vacio.txt', '')).status, 400);
  assert.equal((await upload(first, a, 'binary.txt', Buffer.from([255, 0]))).status, 415);
  assert.equal((await upload(first, a, 'ejecutable.exe', 'texto')).status, 415);
  assert.equal((await upload(first, a, 'uno.txt', 'uno', true)).status, 400);
});
test('fallo de subida visible y posibilidad de eliminar la fila de error', async () => {
  fake.failNextUpload();
  const response = await upload(first, a, 'fallido.txt');
  assert.equal(response.status, 503);
  const { documents } = await (await json(docs(first), a)).json();
  const failed = documents.find(d => d.filename === 'fallido.txt');
  assert.equal(failed.status, 'error');
  assert.equal((await json(docs(first) + '/' + failed.id, a, 'DELETE')).status, 204);
});
test('borrado reintentable y referencia conservada como eliminada', async () => {
  const { document } = await (await upload(first, a, 'borrar.txt')).json();
  fake.failNextRemove();
  assert.equal((await json(docs(first) + '/' + document.id, a, 'DELETE')).status, 503);
  assert.equal(fake.documents.get(document.id).status, 'deleting');
  assert.equal((await json(docs(first) + '/' + document.id + '/download', a)).status, 409);
  assert.equal((await json(docs(first) + '/' + document.id, a, 'DELETE')).status, 204);
  assert.equal(fake.documents.get(document.id).status, 'deleted');
  assert.equal(fake.objects.has(fake.documents.get(document.id).object_path), false);
  assert.equal((await (await json(docs(first), a)).json()).documents.some(d => d.id === document.id), false);
  assert.equal((await json(docs(first) + '/' + document.id, a, 'DELETE')).status, 204);
});
test('cuadernos con fuentes activas no pueden eliminarse y dejar archivos huérfanos', async () => {
  assert.equal((await json('/api/notebooks/' + second, a, 'DELETE')).status, 409);
  const { documents } = await (await json(docs(second), a)).json();
  for (const document of documents) assert.equal((await json(docs(second) + '/' + document.id, a, 'DELETE')).status, 204);
  assert.equal((await json('/api/notebooks/' + second, a, 'DELETE')).status, 204);
});

test('limita a dos subidas simultáneas por proceso y libera el cupo al terminar', async () => {
  let entered = 0;
  let ready, release;
  const bothReady = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await createApp({
    config: readConfig({ AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'http://localhost', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }),
    authAdapter: { getUser: async () => ({ id: randomUUID() }) },
    documentRepository: {
      assertNotebook: async () => {},
      upload: async () => { if (++entered === 2) ready(); await gate; return { status: 'uploaded' }; },
    },
  });
  const local = app.listen(0, '127.0.0.1'); await once(local, 'listening');
  const send = () => {
    const form = new FormData(); form.append('file', new Blob(['Prueba']), 'nota.txt');
    return fetch('http://127.0.0.1:' + local.address().port + docs(randomUUID()), {
      method: 'POST', headers: { origin: 'http://localhost:3000' }, body: form,
    });
  };
  let pending;
  try {
    pending = Promise.all([send(), send()]);
    await bothReady;
    assert.equal((await send()).status, 429);
    release();
    assert.deepEqual((await pending).map(response => response.status), [201, 201]);
    assert.equal((await send()).status, 201);
  } finally {
    release();
    await pending;
    await new Promise(resolve => { local.close(resolve); local.closeAllConnections(); });
  }
});
