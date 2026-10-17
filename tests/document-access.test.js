import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findDocument} from '../src/document-access.js';

test('consulta documental común siempre incluye documento, cuaderno y propietario',async()=>{
  const filters=[];
  const query={select:()=>query,eq:(key,value)=>{filters.push([key,value]);return query;},maybeSingle:async()=>({data:{id:'doc',status:'uploaded'}})};
  const row=await findDocument({from:name=>{assert.equal(name,'documents');return query;}},{params:{documentId:'doc',notebookId:'book'},user:{id:'owner'}});
  assert.equal(row.id,'doc');assert.deepEqual(filters,[['id','doc'],['notebook_id','book'],['owner_id','owner']]);
});
test('consulta documental conserva las políticas de borrado diferentes por operación',async()=>{
  const req={params:{},user:{id:'test'}};
  for(const status of ['deleted','deleting']){
    const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{status}})},client={from:()=>query};
    await assert.rejects(findDocument(client,req),{status:404});
    assert.equal((await findDocument(client,req,{hiddenStatuses:[]})).status,status);
    if(status==='deleting')assert.equal((await findDocument(client,req,{hiddenStatuses:['deleted']})).status,status);
  }
});
