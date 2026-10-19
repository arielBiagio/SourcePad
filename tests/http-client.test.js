import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHttpClient} from '../public/http.js';

test('HTTP común: JSON, multipart, blob y 204 mantienen credenciales y señal',async()=>{
  const calls=[],controller=new AbortController();
  const client=createHttpClient({fetchImpl:async(path,options)=>{calls.push({path,options});return path==='/empty'?new Response(null,{status:204}):path==='/blob'?new Response('archivo'):Response.json({ok:true});}});
  assert.deepEqual(await client.json('/json',{method:'POST',body:'{}',signal:controller.signal}),{ok:true});
  assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.signal,controller.signal);
  assert.equal(new Headers(calls[0].options.headers).get('Content-Type'),'application/json');
  const form=new FormData();form.append('file','fixture');await client.json('/upload',{method:'POST',body:form});
  assert.equal(new Headers(calls[1].options.headers).has('Content-Type'),false);
  assert.equal(await (await client.blob('/blob')).text(),'archivo');assert.equal(await client.json('/empty'),null);
});
test('HTTP común: auth incorrecta no redirige; sesión requerida sí, sin reintentos ni perder códigos',async()=>{
  let redirects=0,calls=0;
  const client=createHttpClient({onUnauthorized:()=>redirects++,fetchImpl:async()=>{calls++;return Response.json({error:'Email incorrecto.',code:'UNAUTHENTICATED'},{status:401});}});
  await assert.rejects(client.json('/login',{}, {sessionRequired:false}),/Email incorrecto/);
  assert.equal(redirects,0);
  await assert.rejects(client.json('/private'),error=>error.status===401&&error.code==='UNAUTHENTICATED');
  assert.equal(redirects,1);assert.equal(calls,2);
});
test('HTTP común: admite formato de Better Auth, errores no JSON y no consume un stream exitoso',async()=>{
  for(const body of [{message:'Credenciales inválidas.'},{error:{message:'Credenciales inválidas.'}}]){
    const client=createHttpClient({fetchImpl:async()=>Response.json(body,{status:400})});
    await assert.rejects(client.json('/auth'),/Credenciales inválidas/);
  }
  const client=createHttpClient({fetchImpl:async()=>new Response('privado',{status:502})});
  await assert.rejects(client.json('/bad'),error=>!error.message.includes('privado'));
  const streamClient=createHttpClient({fetchImpl:async()=>new Response('stream',{headers:{'Content-Type':'text/plain'}})});
  const response=await streamClient.response('/chat');assert.equal(response.bodyUsed,false);assert.equal(await response.text(),'stream');
});
