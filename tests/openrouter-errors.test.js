import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import OpenAI from 'openai';
import { createChatStream } from '../src/chat.js';
import { createEmbedder } from '../src/embeddings/client.js';
import { readConfig } from '../src/config.js';

async function provider(handler, run) {
  const app = express(); app.use(express.json()); app.post(/.*/,handler);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try { return await run(new OpenAI({ baseURL: 'http://127.0.0.1:'+server.address().port,apiKey: 'test-not-real',maxRetries: 0,timeout: 1000 })); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
const config = { openRouterKey: 'test-not-real',chatModel: 'test/model' };
const messages = [{ role: 'user',content: 'Fixture' }];
async function consume(stream) { for await (const _ of stream) {} }

test('chat conserva diagnóstico de clave/saldo/modelo/routing sin exponer mensajes privados',async () => {
  for (const [status,code] of [[401,'CHAT_ACCESS'],[402,'CHAT_CREDITS'],[404,'CHAT_MODEL_UNAVAILABLE'],[429,'CHAT_RATE_LIMIT'],[503,'CHAT_ROUTING']]) {
    await provider((req,res) => res.status(status).json({ error: { code: status,message: 'private text sk-test-secret' } }),async transport => {
      await assert.rejects(createChatStream(config,{ transport })(messages),e => e.code === code && !e.message.includes('private text') && !e.message.includes('sk-test'));
    });
  }
});

test('HTTP 200 con error JSON se reconoce tanto en chat como en embeddings',async () => {
  await provider((req,res) => res.json({ error: { code: 402,message: 'private provider error' } }),async transport => {
    await assert.rejects(createChatStream(config,{ transport })(messages),{ code: 'CHAT_CREDITS' });
    await assert.rejects(createEmbedder(config,{ transport })(['Fixture']),{ code: 'EMBEDDINGS_CREDITS' });
  });
});

test('chat detecta errores SSE antes del primer texto y streams vacíos',async () => {
  for (const [body,code] of [
    ['data: {"error":{"code":429,"message":"private provider error"}}\n\ndata: [DONE]\n\n','CHAT_RATE_LIMIT'],
    ['data: {"choices":[{"delta":{"reasoning":"reasoning-only"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n','CHAT_EMPTY_RESPONSE'],
  ]) {
    await provider((req,res) => res.type('text/event-stream').send(body),async transport => {
      const stream = await createChatStream(config,{ transport })(messages);
      await assert.rejects(consume(stream),{ code });
    });
  }
});

test('chat conserva streaming normal usando el SDK real contra HTTP local',async () => {
  await provider((req,res) => {
    assert.equal(req.body.model,'qwen/qwen3.8-flash');
    assert.equal(req.body.stream,true);
    assert.equal(req.body.max_tokens,2048);
    res.type('text/event-stream').send('data: {"choices":[{"delta":{"content":"Respuesta"}}]}\n\ndata: [DONE]\n\n');
  },async transport => {
    const stream = await createChatStream(readConfig({ OPENROUTER_API_KEY: 'test-not-real' }),{ transport })(messages);
    let text = ''; for await (const chunk of stream) text += chunk.choices[0].delta.content;
    assert.equal(text,'Respuesta');
  });
});

test('RAG exige esquema estricto con campos de cita obligatorios y mantiene privacidad sin retries',async () => {
  let calls = 0;
  await provider((req,res) => {
    calls++;
    assert.equal(req.body.response_format.type,'json_schema');
    assert.equal(req.body.response_format.json_schema.strict,true);
    const schema=req.body.response_format.json_schema.schema;
    assert.deepEqual(schema.required,['insufficientEvidence','segments']);
    const citation=schema.properties.segments.items.properties.citations.items;
    assert.deepEqual(citation.required,['sourceId']);
    assert.deepEqual(Object.keys(citation.properties),['sourceId']);
    assert.equal(citation.additionalProperties,false);
    assert.deepEqual(citation.properties.sourceId.enum,['F1','F2','F3','F4','F5']);
    assert.deepEqual(req.body.reasoning,{ enabled: false });
    assert.deepEqual(req.body.provider,{ data_collection: 'deny',require_parameters: true });
    assert.equal(req.body.model,'qwen/qwen3.8-flash');
    res.type('text/event-stream').send('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n');
  },async transport => {
    const stream = await createChatStream(readConfig({ OPENROUTER_API_KEY: 'test-not-real' }),{ transport })(messages,undefined,{ grounded: true });
    await consume(stream); assert.equal(calls,1);
  });
});
