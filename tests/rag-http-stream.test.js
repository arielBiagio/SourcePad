import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import express from 'express';
import {createRagRepository,mountRag} from '../src/rag.js';
import {withConversationHistory} from '../src/conversations.js';
import {errorHandler,HttpError} from '../src/errors.js';
import {readAnswerResponse} from '../public/answer-stream.js';

const source={id:'F1',filename:'solar.txt',content:'La energía solar proviene del sol.',position:0};
const segment=text=>({text,citations:[{sourceId:'F1'}]});
const chunk=content=>({choices:[{delta:{content}}]});
const prefix='{"insufficientEvidence":false,"segments":[';
async function api(generator,run,{failSave=false}={}){
  const saves=[];let aborted=false;
  const rag=createRagRepository({search:async()=>({matches:[source],indexedSources:1})},async(_messages,signal)=>{
    signal.addEventListener('abort',()=>{aborted=true;},{once:true});return generator(signal);
  },{chatModel:'test/model'});
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:'fixture'};next();});
  mountRag(app,withConversationHistory(rag,{save:async(_req,_res,result)=>{if(failSave)throw Error('private DB error');saves.push(result);return{id:'turn',created_at:'date'};}}),()=> (_req,_res,next)=>next());
  app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port+'/api/notebooks/fixture/answer';
  try{await run({saves,aborted:()=>aborted,send:(body={query:'Consulta',confirmExternalProcessing:true},signal)=>fetch(url,{method:'POST',signal,headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify(body)})});}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('HTTP publica un bloque antes del cierre, con headers de streaming y persistencia única al terminar',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  await api(async function*(){yield chunk(prefix+JSON.stringify(segment('Primero.')));await gate;yield chunk(','+JSON.stringify(segment('Segundo.'))+']}');},async({send,saves})=>{
    const response=await send();assert.match(response.headers.get('content-type'),/application\/x-ndjson/);assert.equal(response.headers.get('x-accel-buffering'),'no');assert.match(response.headers.get('cache-control'),/no-store/);
    let ready;const first=new Promise(r=>{ready=r;});const events=[];
    const pending=readAnswerResponse(response,event=>{events.push(event);ready();});
    try{await first;assert.equal(events.length,1);assert.equal(saves.length,0);}finally{release();}
    const result=await pending;assert.equal(events.length,2);assert.equal(result.saved,true);assert.equal(saves.length,1);
  });
});
test('HTTP conserva errores antes del primer bloque y termina con evento seguro tras una cita inválida',async()=>{
  await api(async function*(){throw new HttpError(402,'Sin saldo.','CHAT_CREDITS');},async({send,saves})=>{
    const response=await send();assert.equal(response.status,402);assert.equal((await response.json()).code,'CHAT_CREDITS');assert.equal(saves.length,0);
  });
  await api(async function*(){yield chunk(prefix+JSON.stringify(segment('Bueno.'))+',');const bad=segment('NO PUBLICAR');bad.citations[0].sourceId='F99';yield chunk(JSON.stringify(bad)+']}');},async({send,saves})=>{
    const response=await send(),events=[];assert.equal(response.status,200);
    await assert.rejects(readAnswerResponse(response,e=>events.push(e)),/citas válidas/);assert.equal(events.length,1);assert.equal(saves.length,0);
  });
});
test('HTTP abortar a mitad del stream cancela el proveedor y no guarda; fallo de guardado no regenera',async()=>{
  await api(async function*(signal){yield chunk(prefix+JSON.stringify(segment('Primero.')));await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();},async({send,saves,aborted})=>{
    const controller=new AbortController(),response=await send(undefined,controller.signal);
    await assert.rejects(readAnswerResponse(response,()=>controller.abort()),{name:'AbortError'});
    // A new event-loop turn lets the socket-close handler deliver cancellation.
    for(let i=0;i<50&&!aborted();i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(aborted(),true);assert.equal(saves.length,0);
  });
  await api(async function*(){yield chunk(prefix+JSON.stringify(segment('Completo.'))+']}');},async({send,saves})=>{
    const result=await readAnswerResponse(await send());assert.equal(result.saved,false);assert.match(result.historyWarning,/no se guardó/);assert.equal(saves.length,0);
  },{failSave:true});
});
