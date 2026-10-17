import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readAnswerResponse} from '../public/answer-stream.js';

const source={id:'F1',filename:'solar.txt',content:'La energía solar proviene del sol.',position:0};
const segment={text:'Conceptos:\n• Energía solar 😎',citations:[{sourceId:'F1',quote:source.content}]};
const result={insufficientEvidence:false,segments:[segment],sources:[source],saved:true,turnId:'fixture'};
const block={type:'block',index:0,segment,sources:[source]};
function response(events,bytewise=false){
  const bytes=new TextEncoder().encode(events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n');
  const body=new ReadableStream({start(controller){
    if(bytewise)for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));else controller.enqueue(bytes);
    controller.close();
  }});
  return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
}
test('lector de bloques maneja UTF-8 y líneas partidas en cada byte y conserva citas',async()=>{
  const events=[];
  assert.deepEqual(await readAnswerResponse(response([block,{type:'done',result}],true),e=>events.push(e)),result);
  assert.deepEqual(events,[block]);
});
test('lector de bloques rechaza EOF sin done, errores, cambios de contenido y eventos tras el final',async()=>{
  for(const frames of [
    [block], [block,{type:'error',error:'Proveedor ocupado.'}], [block,'BROKEN'],
    [block,{type:'done',result:{...result,segments:[{...segment,text:'Otro texto.'}]}}],
    [block,{type:'done',result},{type:'block',...block}],
  ]){
    const events=[];await assert.rejects(readAnswerResponse(response(frames),e=>events.push(e)));
    assert.equal(events.length,1);
  }
});
test('lector de bloques no publica una cita inválida ni acepta cuerpos desmedidos',async()=>{
  for(const frames of [[{...block,segment:{...segment,citations:[{sourceId:'F99',quote:source.content}]}}],['x'.repeat(256*1024+1)]]){
    const events=[];await assert.rejects(readAnswerResponse(response(frames),e=>events.push(e)));assert.equal(events.length,0);
  }
});
test('lector mantiene compatibilidad JSON y errores HTTP sin reintentar',async()=>{
  assert.deepEqual(await readAnswerResponse(Response.json(result)),result);
  await assert.rejects(readAnswerResponse(Response.json({error:'Sin saldo.'},{status:402})),/Sin saldo/);
  await assert.rejects(readAnswerResponse(new Response('unexpected')));
});

test('lector conserva el diagnóstico del servidor en JSON y en eventos de error',async()=>{
  const body={error:'La cita está vacía.',code:'RAG_INVALID_RESPONSE',reason:'CITATION_FIELDS_MISSING'};
  for(const incoming of [Response.json(body,{status:502}),response([{type:'error',...body}])]){
    await assert.rejects(readAnswerResponse(incoming),error=>error.code===body.code&&error.reason===body.reason&&error.message===body.error);
  }
});

test('lector acepta vistas previas del servidor, incluso cortas, sin perder compatibilidad con citas históricas',async()=>{
  const shortSource={...source,content:'Sol ☀'};
  const shortSegment={...segment,citations:[{sourceId:'F1',quote:shortSource.content,kind:'source_reference'}]};
  const answer={...result,segments:[shortSegment],sources:[shortSource]};
  assert.deepEqual(await readAnswerResponse(response([{type:'block',index:0,segment:shortSegment,sources:[shortSource]},{type:'done',result:answer}],true)),answer);
  assert.deepEqual(await readAnswerResponse(Response.json(result)),result);
  for(const bad of [{...shortSegment.citations[0],kind:'invented'}, {...shortSegment.citations[0],quote:'☀'}]){
    await assert.rejects(readAnswerResponse(Response.json({...answer,segments:[{...shortSegment,citations:[bad]}]})));
  }
});
