import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { fakeSupabase } from './helpers/fake-supabase.js';
import { fixtureEmbedder } from './helpers/embedding-fixture.js';

let fake, server, base, a, b, notebook, other, embed, calls;
let generate, generations;
const request = (path,cookie = a,method = 'GET',body) => fetch(base+path,{
  method,headers: { origin: 'http://localhost:3000',...(cookie ? { cookie } : {}),'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const root = () => '/api/notebooks/'+notebook;
const index = (id,body = { confirmExternalProcessing: true }) => request(root()+'/documents/'+id+'/index',a,'POST',body);
const search = (body = { query: 'Energía solar' }) => request(root()+'/search',a,'POST',body);
async function source(text = 'La energía solar proviene del sol.',name = 'notas.txt') {
  const form = new FormData(); form.append('file',new Blob([text]),name);
  const uploaded = await fetch(base+root()+'/documents',{ method: 'POST',headers: { origin: 'http://localhost:3000',cookie: a },body: form });
  assert.equal(uploaded.status,201);
  const id = (await uploaded.json()).document.id;
  assert.equal((await request(root()+'/documents/'+id+'/process',a,'POST')).status,200);
  return id;
}
before(async () => {
  fake = await fakeSupabase();
  const config = readConfig({ AUTH_PROVIDER: 'supabase',SUPABASE_URL: fake.url,SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',OPENROUTER_API_KEY: 'test-not-real' });
  const app = await createApp({ config,embedder: async texts => { calls.push(texts); return embed(texts); },chatStream: async (messages,signal,options) => {
    generations.push({ messages,options });
    return (async function* () { yield { choices: [{ delta: { content: await generate(messages,signal) } }] }; })();
  } });
  server = app.listen(0,'127.0.0.1'); await once(server,'listening'); base = 'http://127.0.0.1:'+server.address().port;
});
beforeEach(async () => {
  calls = []; embed = fixtureEmbedder;
  generations = [];
  generate = async messages => {
    const source = JSON.parse(messages[1].content).untrustedSources[0];
    return JSON.stringify({ insufficientEvidence: false,segments: [{ text: 'Respuesta basada en la fuente.',citations: [{ sourceId: source.id,quote: source.text.slice(0,100) }] }] });
  };
  const account = async () => {
    const r = await request('/api/auth/sign-up/email',null,'POST',{ name: 'QA',email: randomUUID()+'@example.test',password: 'Testing123!' });
    assert.equal(r.status,201); return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  };
  a = await account(); b = await account();
  const book = async cookie => (await (await request('/api/notebooks',cookie,'POST',{ title: 'Embeddings' })).json()).notebook.id;
  notebook = await book(a); other = await book(b);
});
after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await fake.close(); });

test('indexa, busca fragmentos con fuente y no vuelve a llamar al proveedor al repetir',async () => {
  const id = await source();
  assert.equal((await index(id,{})).status,400); assert.equal(calls.length,0);
  const result = await (await index(id)).json();
  assert.equal(result.complete,true); assert.equal(result.document.status,'ready');
  assert.equal(result.document.indexed_chunk_count,1); assert.equal(result.document.embedding_profile,'baai/bge-m3:dense:1024:cosine:v1');
  assert.equal((await index(id)).status,200); assert.equal(calls.length,1);
  const r = await search(); assert.equal(r.status,200); assert.match(r.headers.get('cache-control'),/no-store/);
  const data = await r.json(); assert.equal(data.matches[0].document_id,id); assert.equal(data.matches[0].filename,'notas.txt');
  assert.equal(data.matches[0].content,'La energía solar proviene del sol.');
  assert.equal(data.matches[0].embedding,undefined); assert.equal(data.matches[0].owner_id,undefined);
  assert.equal(data.matches[0].similarity,1); assert.equal(calls.length,2);
});

test('preflight: anónimo, fuente ajena o sin índice no disparan llamadas con costo',async () => {
  const id = await source();
  assert.equal((await request(root()+'/documents/'+id+'/index',null,'POST',{ confirmExternalProcessing: true })).status,401);
  assert.equal((await request(root()+'/documents/'+id+'/index',b,'POST',{ confirmExternalProcessing: true })).status,404);
  assert.equal((await request('/api/notebooks/'+other+'/documents/'+id+'/index',b,'POST',{ confirmExternalProcessing: true })).status,404);
  assert.equal((await request(root()+'/search',b,'POST',{ query: 'Consulta' })).status,404);
  assert.equal((await search({ query: 'Consulta',sourceIds: [id] })).status,404);
  const empty = await (await search()).json(); assert.equal(empty.indexedSources,0); assert.deepEqual(empty.matches,[]);
  assert.equal(calls.length,0);
});

test('selección de fuentes y validación de consultas antes de OpenRouter',async () => {
  const first = await source('Energía solar.','solar.txt'), second = await source('Las plantas hacen fotosíntesis.','plantas.txt');
  await index(first); await index(second); calls = [];
  const result = await (await search({ query: 'La energía del sol',sourceIds: [second] })).json();
  assert.equal(result.matches.length,1); assert.equal(result.matches[0].document_id,second);
  for (const input of [{ query: '' },{ query: 'a'.repeat(1001) },{ query: 'Consulta',sourceIds: [] },{ query: 'Consulta',sourceIds: [first,first] },{ query: 'Consulta',sourceIds: ['invalid'] },{ query: 'Consulta',owner_id: randomUUID() }]) {
    assert.equal((await search(input)).status,400);
  }
  assert.equal(calls.length,1);
});

test('reanuda desde los lotes persistidos tras error de saldo sin repetir sus fragmentos',async () => {
  const id = await source(Array.from({ length: 1000 },(_,i) => 'Nota ' + i + ': Un tema solar con palabras y notas. ').join(''));
  const first = await (await index(id)).json();
  assert.equal(first.complete,false); assert.equal(first.document.indexed_chunk_count,32);
  embed = async () => { throw new HttpError(402,'Saldo insuficiente.','EMBEDDINGS_CREDITS'); };
  assert.equal((await index(id)).status,402); assert.equal(fake.documents.get(id).indexed_chunk_count,32);
  assert.equal(fake.documents.get(id).index_status,'error');
  const sentBefore = [...calls[0]];
  embed = fixtureEmbedder;
  const retry = await (await index(id)).json(); assert.equal(retry.complete,true);
  assert.ok(calls.at(-1).every(text => !sentBefore.includes(text)));
  assert.equal((await search()).status,200);
});

test('un vector inválido o un fallo de guardado no deja listo un índice parcial',async () => {
  const id = await source();
  embed = async () => [[1,2]];
  assert.equal((await index(id)).status,502);
  assert.equal(fake.embeddings.has(id),false); assert.equal(fake.documents.get(id).status,'extracted');
  embed = fixtureEmbedder; fake.failNextEmbeddingStore();
  assert.equal((await index(id)).status,503); assert.equal(fake.documents.get(id).index_status,'error');
  assert.equal((await index(id)).status,200); assert.equal(fake.documents.get(id).status,'ready');
});

test('rechaza lote simultáneo; lease vencido permite continuar y borrar invalida resultados atrasados',async () => {
  const id = await source(); let enter,release;
  const ready = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  embed = async texts => { enter(); await gate; return fixtureEmbedder(texts); };
  const pending = index(id);
  try {
    await ready; assert.equal((await index(id)).status,409);
    assert.equal((await request(root()+'/documents/'+id,a,'DELETE')).status,204);
    release(); assert.equal((await pending).status,409);
    assert.equal(fake.embeddings.has(id),false); assert.equal(fake.embeddingJobs.get(id).status,'cancelled');
  } finally { release(); await pending; }
  embed = fixtureEmbedder;
  const retryId = await source();
  fake.embeddingJobs.set(retryId,{ status: 'running',run_id: randomUUID(),attempts: 1,lease_until: new Date(Date.now()-1000).toISOString() });
  assert.equal((await index(retryId)).status,200); assert.equal(fake.embeddingJobs.get(retryId).attempts,2);
});

const answer = (body = { query: '¿De dónde viene la energía solar?',confirmExternalProcessing: true },cookie = a) => request(root()+'/answer',cookie,'POST',body);

test('RAG API: usa sólo fuentes seleccionadas y devuelve citas con metadatos de Supabase',async () => {
  const first = await source('La energía solar proviene del sol.','solar.txt');
  const second = await source('Las plantas realizan fotosíntesis.','plantas.txt');
  await index(first); await index(second); calls = [];
  const response = await answer({ query: '¿Qué hacen las plantas?',sourceIds: [second],confirmExternalProcessing: true });
  assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/);
  const result = await response.json();
  assert.equal(result.model,'qwen/qwen3.8-flash'); assert.equal(result.insufficientEvidence,false);
  assert.equal(result.sources.length,1); assert.equal(result.sources[0].document_id,second);
  assert.equal(result.sources[0].filename,'plantas.txt'); assert.equal(result.sources[0].page_number,null);
  assert.equal(result.sources[0].owner_id,undefined); assert.equal(result.sources[0].storage_path,undefined);
  assert.equal(generations.length,1); assert.deepEqual(generations[0].options,{ grounded: true });
  const payload = JSON.parse(generations[0].messages[1].content);
  assert.equal(payload.untrustedSources.length,1); assert.ok(!JSON.stringify(payload).includes('solar.txt'));
  assert.equal(calls.length,1);
});

test('RAG API: anónimo, cuenta ajena y validación no consumen IA; cuaderno vacío se abstiene',async () => {
  for (const [cookie,status] of [[null,401],[b,404]]) assert.equal((await answer(undefined,cookie)).status,status);
  for (const body of [{ query: 'Consulta' },{ query: '',confirmExternalProcessing: true },{ query: 'Consulta',confirmExternalProcessing: true,messages: [] },{ query: 'Consulta',confirmExternalProcessing: true,sourceIds: ['invalid'] }]) assert.equal((await answer(body)).status,400);
  const result = await (await answer()).json(); assert.equal(result.insufficientEvidence,true); assert.equal(result.model,null);
  assert.equal(calls.length,0); assert.equal(generations.length,0);
  const id = await source();
  assert.equal((await answer({ query: 'Consulta',sourceIds: [id],confirmExternalProcessing: true })).status,404);
  assert.equal(calls.length,0); assert.equal(generations.length,0);
});

test('RAG API: una cita inventada se rechaza sin devolver el texto; 429 no cierra la sesión',async () => {
  await index(await source());
  generate = async () => JSON.stringify({ insufficientEvidence: false,segments: [{ text: 'Texto que no debe mostrarse',citations: [{ sourceId: 'F99',quote: 'Cita inventada y privada' }] }] });
  const invalid = await answer(); assert.equal(invalid.status,502); assert.equal((await invalid.json()).code,'RAG_INVALID_RESPONSE');
  generate = async () => { throw new HttpError(429,'Proveedor ocupado.','CHAT_RATE_LIMIT'); };
  const limited = await answer(); assert.equal(limited.status,429); assert.equal((await limited.json()).code,'CHAT_RATE_LIMIT');
  assert.equal((await request('/api/me')).status,200);
});

test('RAG API: la falta de evidencia no publica una respuesta improvisada',async () => {
  await index(await source());
  generate = async () => '{"insufficientEvidence":true,"segments":[]}';
  const result = await (await answer({ query: '¿Quién ganó un partido?',confirmExternalProcessing: true })).json();
  assert.equal(result.insufficientEvidence,true); assert.deepEqual(result.sources,[]); assert.deepEqual(result.segments,[]);
});

test('RAG API: limita a dos generaciones concurrentes y libera el cupo al terminar',async () => {
  await index(await source());
  let ready,release;
  const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  generate = async () => { if (++count === 2) ready(); await gate; return '{"insufficientEvidence":true,"segments":[]}'; };
  const first = answer(), second = answer();
  try { await entered; assert.equal((await answer()).status,429); }
  finally { release(); }
  assert.equal((await first).status,200); assert.equal((await second).status,200);
  assert.equal((await answer()).status,200);
});

test('historial API: guarda pregunta y respuesta validadas sin otra generación; cuenta ajena no accede',async () => {
  await index(await source());
  const response = await answer(); const result = await response.json();
  assert.equal(result.saved,true); assert.ok(result.turnId);
  const saved = await request(root()+'/conversation'); assert.equal(saved.status,200);
  const { turns } = await saved.json(); assert.equal(turns.length,1);
  assert.equal(turns[0].question,'¿De dónde viene la energía solar?');
  assert.equal(turns[0].answer.sources[0].filename,'notas.txt');
  assert.equal(generations.length,1);
  assert.equal((await request(root()+'/conversation',b)).status,404);
  assert.equal((await request(root()+'/conversation',null)).status,401);
});

test('historial API: un fallo de guardado no oculta la respuesta ni repite una llamada con costo',async () => {
  await index(await source()); fake.failNextHistory();
  const response = await answer(); assert.equal(response.status,200);
  const result = await response.json(); assert.equal(result.saved,false); assert.match(result.historyWarning,/no se guardó/);
  assert.equal(result.segments.length,1); assert.equal(generations.length,1);
  assert.equal((await (await request(root()+'/conversation')).json()).turns.length,0);
});

test('historial API: requiere confirmación para borrar y no permite borrar otro cuaderno',async () => {
  await index(await source()); await answer();
  assert.equal((await request(root()+'/conversation',a,'DELETE',{})).status,400);
  assert.equal((await request(root()+'/conversation',b,'DELETE',{ confirm: true })).status,404);
  assert.equal((await request(root()+'/conversation',a,'DELETE',{ confirm: true })).status,204);
  assert.equal((await (await request(root()+'/conversation')).json()).turns.length,0);
  assert.equal(fake.documents.size > 0,true);
});
