import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGroundedAnswer,groundedMessages,createRagRepository} from '../src/rag.js';
import {groundedResponseFormat} from '../src/rag-contract.js';
import {withConversationHistory} from '../src/conversations.js';

const source={id:'F1',filename:'synthetic.txt',page_number:3,position:0,content:'Primera línea.\nLa  energía solar es renovable. “Texto original” 😎. '+ 'Contenido adicional. '.repeat(30)};
const modelSegment={text:'La energía solar es renovable.',citations:[{sourceId:'F1'}]};
const response=segments=>JSON.stringify({insufficientEvidence:false,segments});
const req={body:{query:'Explicá la energía solar',confirmExternalProcessing:true}};

test('contrato de referencias: el generador sólo elige IDs; no copia extractos',()=>{
  const citation=groundedResponseFormat.json_schema.schema.properties.segments.items.properties.citations.items;
  assert.deepEqual(citation.required,['sourceId']);
  assert.deepEqual(Object.keys(citation.properties),['sourceId']);
  const prompt=groundedMessages(req.body.query,[source])[0].content;
  assert.match(prompt,/No copies extractos/);
  assert.match(prompt,/parcial/);
  assert.match(prompt,/ninguna parte de la pregunta/);
});

test('referencias: el servidor añade una vista previa literal y los metadatos confiables',()=>{
  const result=validateGroundedAnswer(response([modelSegment]),[source]);
  const citation=result.segments[0].citations[0];
  assert.deepEqual(citation,{sourceId:'F1',quote:source.content.slice(0,300),kind:'source_reference'});
  assert.ok(source.content.includes(citation.quote));
  assert.equal(result.segments[0].text,modelSegment.text);
  assert.equal(result.sources[0].page_number,3);
  const short={...source,content:'Sol ☀'};
  assert.equal(validateGroundedAnswer(response([modelSegment]),[short]).segments[0].citations[0].quote,short.content);
});

test('referencias: deduplica un ID repetido y no publica fuentes no citadas',()=>{
  const repeated={...modelSegment,citations:[{sourceId:'F1'},{sourceId:'F1'}]};
  const result=validateGroundedAnswer(response([repeated]),[source,{...source,id:'F2'}]);
  assert.equal(result.segments[0].citations.length,1);
  assert.deepEqual(result.sources,[source]);
});

test('referencias: cada ID conserva su fuente y la vista previa no corta un emoji',()=>{
  const second={...source,id:'F2',filename:'otra.txt',page_number:9,content:'a'.repeat(299)+'😎 Final.'};
  const result=validateGroundedAnswer(response([{...modelSegment,citations:[{sourceId:'F2'},{sourceId:'F1'}]}]),[source,second]);
  assert.deepEqual(result.segments[0].citations.map(c=>c.sourceId),['F2','F1']);
  assert.equal(result.segments[0].citations[0].quote,'a'.repeat(299));
  assert.equal(result.sources.find(s=>s.id==='F2').page_number,9);
});

test('referencias: rechaza IDs desconocidos, objetos vacíos y metadatos o extractos del modelo',()=>{
  for(const [citation,reason] of [[{sourceId:'F99'},'UNKNOWN_SOURCE'],[{},'CITATION_FIELDS_MISSING'],[{sourceId:'F1',quote:'Texto inventado'},'CITATION_FIELDS_MISSING'],[{sourceId:'F1',filename:'falso.pdf'},'CITATION_FIELDS_MISSING']]){
    assert.throws(()=>validateGroundedAnswer(response([{...modelSegment,citations:[citation]}]),[source]),error=>error.reason===reason&&!error.message.includes(source.content));
  }
});

test('referencias: streaming hidrata cada bloque antes de publicarlo y conserva el mismo resultado al guardar',async()=>{
  const events=[],saved=[];
  const raw=response([modelSegment,{...modelSegment,text:'Es una fuente renovable.'}]);
  const rag=withConversationHistory(createRagRepository({search:async()=>({matches:[source],indexedSources:1})},async()=> (async function*(){for(const char of raw)yield {choices:[{delta:{content:char}}]};})(),{}),{save:async(_req,_res,answer)=>{saved.push(answer);return{id:'turn'};}});
  const result=await rag.answer(req,{},undefined,event=>events.push(event));
  assert.equal(events.length,2);assert.equal(saved.length,1);
  assert.deepEqual(events.map(event=>event.segment),result.segments);
  assert.deepEqual(saved[0].segments,result.segments);
  assert.equal(events[0].segment.citations[0].kind,'source_reference');
});

test('referencias: conserva abstención explícita y no genera si no hay fragmentos',async()=>{
  let calls=0;
  for(const matches of [[],[source]]){
    const rag=createRagRepository({search:async()=>({matches,indexedSources:matches.length})},async()=>{calls++;return (async function*(){yield {choices:[{delta:{content:'{"insufficientEvidence":true,"segments":[]}'}}]};})();},{});
    const result=await rag.answer(req,{});
    assert.equal(result.insufficientEvidence,true);assert.deepEqual(result.sources,[]);
    assert.match(result.message,/No encontré información suficiente/);
  }
  assert.equal(calls,1);
});
