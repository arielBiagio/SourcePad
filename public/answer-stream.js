import {RAG_LIMITS as limits} from './contracts.js';
import {responseError} from './http.js';
const interrupted=()=>new Error('La conexión terminó sin una respuesta completa. No se reintentó automáticamente.');

function validAnswer(answer) {
  return answer && typeof answer.insufficientEvidence==='boolean' && Array.isArray(answer.sources) && answer.sources.length<=limits.sources
    && answer.sources.every(s=>s&&typeof s.id==='string'&&typeof s.content==='string'&&typeof s.filename==='string')
    && Array.isArray(answer.segments) && answer.segments.length<=limits.blocks
    && (answer.insufficientEvidence ? !answer.segments.length&&!answer.sources.length : answer.segments.length>0)
    && answer.segments.every(s=>s&&typeof s.text==='string'&&s.text.trim()&&s.text.length<=limits.blockChars
      &&Array.isArray(s.citations)&&s.citations.length>0&&s.citations.length<=limits.citations
      &&s.citations.every(c=>c&&typeof c.quote==='string'&&c.quote.length<=limits.previewChars
        &&(c.kind==='source_reference'?c.quote.length>0:c.kind===undefined&&c.quote.trim().length>=12)
        &&answer.sources.some(source=>source.id===c.sourceId&&source.content.includes(c.quote)
          &&(c.kind!=='source_reference'||source.content.startsWith(c.quote)))));
}

// A bounded NDJSON protocol, not raw model tokens. Legacy JSON clients remain supported.
export async function readAnswerResponse(response,onBlock=()=>{}) {
  if(!response.ok){
    const body=await response.json().catch(()=>null);
    throw responseError(body,'No se pudo completar la consulta.');
  }
  if(response.headers.get('content-type')?.includes('application/json')){
    const result=await response.json();if(!validAnswer(result))throw interrupted();return result;
  }
  if(!response.headers.get('content-type')?.includes('application/x-ndjson')||!response.body)throw interrupted();
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  const blocks=[],snapshots=new Map();let pending='',bytes=0,result=null;
  function line(raw){
    if(!raw.trim())return;
    let event;try{event=JSON.parse(raw);}catch{throw interrupted();}
    if(!event||result)throw interrupted();
    if(event.type==='error')throw responseError(event,'La respuesta se interrumpió.');
    if(event.type==='block'){
      if(event.index!==blocks.length||blocks.length>=limits.blocks||!validAnswer({insufficientEvidence:false,segments:[event.segment],sources:event.sources}))throw interrupted();
      for(const source of event.sources){
        const snapshot=JSON.stringify(source);
        if(snapshots.has(source.id)&&snapshots.get(source.id)!==snapshot)throw interrupted();
        snapshots.set(source.id,snapshot);
      }
      blocks.push(event.segment);onBlock(event);return;
    }
    if(event.type!=='done'||!validAnswer(event.result))throw interrupted();
    if(blocks.some((segment,index)=>JSON.stringify(segment)!==JSON.stringify(event.result.segments[index])))throw interrupted();
    for(const [id,snapshot] of snapshots)if(JSON.stringify(event.result.sources.find(s=>s.id===id))!==snapshot)throw interrupted();
    result=event.result;
  }
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done){pending+=decoder.decode();if(pending.trim())line(pending);break;}
      bytes+=value.byteLength;if(bytes>limits.transportBytes)throw interrupted();
      pending+=decoder.decode(value,{stream:true});
      let end;while((end=pending.indexOf('\n'))>=0){line(pending.slice(0,end));pending=pending.slice(end+1);}
    }
    if(!result)throw interrupted();return result;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
