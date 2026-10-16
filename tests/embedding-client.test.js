import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import OpenAI from 'openai';
import { createEmbedder, normalizedVector, EMBEDDING_MODEL } from '../src/embeddings/client.js';
import { fixtureEmbedding } from './helpers/embedding-fixture.js';

test('contrato embeddings: SDK real, modelo BGE-M3, flotantes, lotes e índices desordenados', async () => {
  const app = express(); app.use(express.json());
  const requests = [];
  app.post('/api/v1/embeddings',(req,res) => {
    requests.push(req.body);
    res.json({ model: EMBEDDING_MODEL, object: 'list', data: req.body.input.map((text,index) => ({ index, object: 'embedding', embedding: fixtureEmbedding(text).map(n => n * 3) })).reverse(), usage: { total_tokens: 4 } });
  });
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const transport = new OpenAI({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:' + server.address().port + '/api/v1', maxRetries: 0 });
    const embed = createEmbedder({ openRouterKey: 'test-key' },{ transport });
    const result = await embed(['Energía solar','Una planta']);
    assert.equal(result[0][0],1); assert.equal(result[1][1],1);
    assert.equal(requests[0].model,'baai/bge-m3');
    assert.equal(requests[0].dimensions,undefined);
    assert.equal(requests[0].encoding_format,'float');
    assert.deepEqual(requests[0].provider,{ data_collection: 'deny', require_parameters: true });
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('rechaza vectores vacíos, dimensión incorrecta y valores no finitos', () => {
  for (const value of [Array(1024).fill(0),[1,2],Array(1024).fill(NaN),Array(1024).fill(Infinity),Array(1024).fill('1')]) assert.throws(() => normalizedVector(value));
});

test('acepta BAAI/bge-m3 como identificador del proveedor sin cambiar el modelo solicitado', async () => {
  const app = express(); app.use(express.json());
  let requestedModel;
  app.post('/embeddings',(req,res) => {
    requestedModel = req.body.model;
    // Variante documentada por DeepInfra. Lote completo y desordenado, como los otros tests.
    res.json({ model: 'BAAI/bge-m3', data: req.body.input.map((text,index) => ({ index,embedding: fixtureEmbedding(text) })).reverse() });
  });
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const transport = new OpenAI({ apiKey: 'test-key',baseURL: 'http://127.0.0.1:'+server.address().port,maxRetries: 0 });
    const result = await createEmbedder({ openRouterKey: 'test-key' },{ transport })(Array.from({ length: 32 },(_,i) => 'Texto de prueba '+i));
    assert.equal(requestedModel,'baai/bge-m3');
    assert.equal(result.length,32); assert.equal(result[0].length,1024);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('acepta el alias parasail-bge-m3 observado en un lote real de 32 sin cambiar el perfil', async () => {
  const texts = Array.from({ length: 32 },(_,i) => 'Frase sintética '+i);
  let calls = 0;
  const embed = createEmbedder({ openRouterKey: 'test' },{ transport: { embeddings: { create: async request => {
    calls++;
    assert.equal(request.model,EMBEDDING_MODEL);
    assert.deepEqual(request.input,texts);
    return { object: 'list',model: 'parasail-bge-m3',data: texts.map((text,index) => ({ index,embedding: fixtureEmbedding(text).map(n => n * 3) })) };
  } } } });
  const vectors = await embed(texts);
  assert.equal(calls,1);
  assert.equal(vectors.length,32);
  for (const vector of vectors) {
    assert.equal(vector.length,1024);
    assert.ok(Math.abs(Math.hypot(...vector)-1) < 1e-12);
  }
});

test('distingue modelo inesperado de lote incompleto y rechaza respuestas malformadas', async () => {
  const row = { index: 0,embedding: fixtureEmbedding('uno') };
  for (const [response,message] of [
    [{ model: 'other/model',data: [row] },/modelo/],
    [{ model: 'bge-m3',data: [row] },/modelo/],
    [{ model: 'parasail-other-model',data: [row] },/modelo/],
    [{ model: 'BAAI/bge-m3',data: [] },/0 vectores.*1/],
    [{ model: 'BAAI/bge-m3',data: [row,row] },/2 vectores.*1/],
    [{ model: 'BAAI/bge-m3',data: [null] },/índices/],
    [null,/modelo/],
    [{ model: 'BAAI/bge-m3' },/lote/],
  ]) {
    const embed = createEmbedder({ openRouterKey: 'test' },{ transport: { embeddings: { create: async () => response } } });
    await assert.rejects(embed(['uno']),error => error.status === 502 && error.code === 'INVALID_EMBEDDING' && message.test(error.message));
  }
});

test('no acepta modelos alternativos, lotes incompletos ni índices duplicados', async () => {
  const row = { index: 0, embedding: fixtureEmbedding('uno') };
  for (const response of [
    { model: 'other/model', data: [row] }, { model: EMBEDDING_MODEL, data: [] },
    { model: EMBEDDING_MODEL, data: [{ ...row,index: 2 }] },
    { model: EMBEDDING_MODEL, data: [row,row] },
  ]) {
    const embed = createEmbedder({ openRouterKey: 'test' },{ transport: { embeddings: { create: async () => response } } });
    await assert.rejects(embed(response.data.length === 2 ? ['uno','dos'] : ['uno']),{ code: 'INVALID_EMBEDDING' });
  }
});

test('errores de saldo, permisos y límites son públicos seguros; no hay reintentos implícitos', async () => {
  for (const [status,code] of [[402,'EMBEDDINGS_CREDITS'],[401,'EMBEDDINGS_ACCESS'],[429,'EMBEDDINGS_RATE_LIMIT'],[500,'EMBEDDINGS_UNAVAILABLE']]) {
    let calls = 0;
    const embed = createEmbedder({ openRouterKey: 'test' },{ transport: { embeddings: { create: async () => { calls++; throw { status,message: 'provider-private-details' }; } } } });
    await assert.rejects(embed(['Consulta']), error => error.code === code && !error.message.includes('provider-private-details'));
    assert.equal(calls,1);
  }
  await assert.rejects(createEmbedder({})(['Consulta']),{ code: 'EMBEDDINGS_NOT_CONFIGURED' });
});
