import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildChatRequest} from '../public/chat-context.js';
import {createStreamRenderer} from '../public/stream-renderer.js';
import {validateHistory} from '../src/chat.js';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {once} from 'node:events';

test('contexto: sólo transporta los últimos seis mensajes sin modificar el historial visible',()=>{
  const history=Array.from({length:14},(_,i)=>({role:i%2?'user':'assistant',content:'x'.repeat(10000)}));
  const raw=buildChatRequest(history);
  assert.equal(JSON.parse(raw).historial.length,6);
  assert.equal(Buffer.byteLength(raw),60204);
  assert.equal(history.length,14);
  assert.equal(validateHistory(JSON.parse(raw)).length,7);
});

test('contexto: respeta el presupuesto de bytes con Unicode y escapes, conserva siempre la pregunta',()=>{
  for(const content of ['😎'.repeat(8000),'\u0001'.repeat(16000)]){
    const history=Array.from({length:6},(_,i)=>({role:i%2?'user':'assistant',content}));
    const raw=buildChatRequest(history),sent=JSON.parse(raw).historial;
    assert.ok(Buffer.byteLength(raw)<=120*1024);
    assert.equal(sent.at(-1).content,content);
    assert.equal(history.length,6);
    validateHistory(JSON.parse(raw));
  }
  assert.throws(()=>buildChatRequest([{role:'user',content:'x'.repeat(16001)}]),/16000/);
});

function frames(){
  const queued=new Map();let id=0;
  return {schedule:fn=>{queued.set(++id,fn);return id;},cancel:token=>queued.delete(token),run(){const current=[...queued.values()];queued.clear();for(const fn of current)fn();},get size(){return queued.size;}};
}
test('render: agrupa 1000 chunks en un frame y termina sin cola artificial',()=>{
  const clock=frames(),renders=[];
  const view=createStreamRenderer({render:text=>renders.push(text),schedule:clock.schedule,cancel:clock.cancel});
  for(let i=0;i<1000;i++)view.append('a');
  assert.equal(clock.size,1);assert.equal(renders.length,0);
  clock.run();assert.deepEqual(renders,['a'.repeat(1000)]);
  view.append('😎');view.finish();
  assert.equal(renders.at(-1),'a'.repeat(1000)+'😎');assert.equal(clock.size,0);
  clock.run();assert.equal(renders.length,2);
});
test('render: detener cancela el frame y no vuelve a pintar',()=>{
  const clock=frames(),renders=[];
  const view=createStreamRenderer({render:text=>renders.push(text),schedule:clock.schedule,cancel:clock.cancel});
  view.append('parcial');view.stop();clock.run();view.append('no pintar');view.finish();
  assert.deepEqual(renders,[]);assert.equal(clock.size,0);
});

test('chat HTTP: cancelar antes del primer texto no se registra como fallo del proveedor',async()=>{
  let ready,aborted;
  const entered=new Promise(resolve=>{ready=resolve;}),closed=new Promise(resolve=>{aborted=resolve;});
  const app=await createApp({config:readConfig({AUTH_PROVIDER:'legacy'}),authAdapter:{mount(){},getUser:async()=>({id:'synthetic'})},notebookRepository:{},chatStream:async(_messages,signal)=>(async function*(){
    ready();await new Promise(resolve=>signal.addEventListener('abort',()=>{resolve();aborted();},{once:true}));signal.throwIfAborted();
  })()});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const logs=[],original=console.error;console.error=(...args)=>logs.push(args.join(' '));
  try{
    const controller=new AbortController();
    const pending=fetch('http://127.0.0.1:'+server.address().port+'/api/chat',{method:'POST',signal:controller.signal,headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({historial:[{role:'user',content:'Prueba sintética'}]})});
    const rejected=assert.rejects(pending,{name:'AbortError'});
    await entered;controller.abort();await rejected;await closed;
    await new Promise(setImmediate);
    assert.deepEqual(logs,[]);
  }finally{console.error=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
