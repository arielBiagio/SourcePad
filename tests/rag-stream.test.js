import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRagRepository } from '../src/rag.js';
import { withConversationHistory } from '../src/conversations.js';

const source={id:'F1',filename:'solar.txt',position:0,page_number:null,content:'La energía solar proviene del sol y es renovable.'};
const segment=text=>({text,citations:[{sourceId:'F1'}]});
const chunk=content=>({choices:[{delta:{content}}]});
const req={body:{query:'Consulta',confirmExternalProcessing:true}};
const prefix='{"insufficientEvidence":false,"segments":[';
const repository=generator=>createRagRepository({search:async()=>({matches:[source],indexedSources:1})},async()=>generator(),{chatModel:'test/model'});

test('stream RAG publica el primer bloque validado antes de recibir el segundo y sólo guarda al finalizar',async()=>{
  const first=segment('Conceptos:\n• Sol\n• Renovable 😎 con "comillas" y {llaves}.');
  const second=segment('Segundo bloque.');
  let release,ready;const gate=new Promise(r=>{release=r;}),entered=new Promise(r=>{ready=r;});
  const events=[];let saves=0;
  const rag=withConversationHistory(repository(async function*(){
    const raw=prefix+JSON.stringify(first);
    for(const char of raw) yield chunk(char);
    ready();await gate;yield chunk(','+JSON.stringify(second)+']}');
  }),{save:async()=>{saves++;return{id:'turn',created_at:'date'};}});
  const pending=rag.answer(req,{},new AbortController().signal,event=>events.push(event));
  try{await entered;assert.equal(events.length,1);assert.equal(events[0].index,0);assert.equal(events[0].segment.text,first.text);assert.deepEqual(events[0].segment.citations,[{sourceId:'F1',quote:source.content,kind:'source_reference'}]);assert.equal(saves,0);}
  finally{release();}
  const result=await pending;assert.equal(events.length,2);assert.equal(saves,1);assert.equal(result.saved,true);
});

test('stream RAG no emite el bloque con cita falsa ni guarda la respuesta parcial',async()=>{
  const bad=segment('NO PUBLICAR');bad.citations[0].sourceId='F99';
  const events=[];let saves=0;
  const rag=withConversationHistory(repository(async function*(){yield chunk(prefix+JSON.stringify(segment('Bueno.'))+',');yield chunk(JSON.stringify(bad)+']}');}),{save:async()=>{saves++;}});
  await assert.rejects(rag.answer(req,{},new AbortController().signal,event=>events.push(event)),{code:'RAG_INVALID_RESPONSE'});
  assert.equal(events.length,1);assert.equal(saves,0);
});

test('stream RAG cancelación, truncamiento y JSON final inválido no guardan bloques parciales',async()=>{
  for(const failure of ['abort','length','json']){
    let saves=0;const events=[],controller=new AbortController();
    const rag=withConversationHistory(repository(async function*(){
      yield chunk(prefix+JSON.stringify(segment('Bueno.')));
      if(failure==='abort')controller.abort();
      if(failure==='length')yield {choices:[{delta:{},finish_reason:'length'}]};
      else yield chunk(failure==='json'?',BROKEN':']}');
    }),{save:async()=>{saves++;}});
    await assert.rejects(rag.answer(req,{},controller.signal,event=>events.push(event)));
    assert.equal(events.length,1);assert.equal(saves,0);
  }
});

test('stream RAG rechaza bloques extra, comas inválidas y sobrescrituras del JSON final',async()=>{
  const good=JSON.stringify(segment('Bueno.'));
  for(const raw of [prefix+Array(5).fill(good).join(',')+']}',prefix+good+',]}',prefix+good+'],"insufficientEvidence":true}',prefix+good+'],"segments":['+JSON.stringify(segment('Distinto.'))+']}']){
    const events=[];await assert.rejects(repository(async function*(){yield chunk(raw);}).answer(req,{},new AbortController().signal,e=>events.push(e)),{code:'RAG_INVALID_RESPONSE'});
    assert.ok(events.length>=1&&events.length<=4);
  }
});

test('stream RAG acepta orden alternativo y abstención sin publicar texto sin validar',async()=>{
  for(const answer of [{segments:[segment('Bueno.')],insufficientEvidence:false},{insufficientEvidence:true,segments:[]}]){
    const events=[];const result=await repository(async function*(){yield chunk(JSON.stringify(answer));}).answer(req,{},new AbortController().signal,e=>events.push(e));
    assert.equal(events.length,answer.segments.length);assert.equal(result.insufficientEvidence,answer.insufficientEvidence);
  }
});
