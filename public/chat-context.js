import {CHAT_LIMITS} from './contracts.js';

export function buildChatRequest(history) {
  const last=history.at(-1);
  if(last?.role!=='user'||typeof last.content!=='string'||!last.content.trim())throw new Error('Ingresá una pregunta.');
  if(last.content.length>CHAT_LIMITS.maxMessageChars)throw new Error(`El mensaje admite hasta ${CHAT_LIMITS.maxMessageChars} caracteres.`);
  // The DOM keeps the conversation; only the existing server context window travels.
  const context=history.slice(-CHAT_LIMITS.contextMessages).filter(item=>item&&['user','assistant'].includes(item.role)
    &&typeof item.content==='string'&&item.content.trim()&&item.content.length<=CHAT_LIMITS.maxMessageChars);
  const encoder=new TextEncoder();
  let body=JSON.stringify({historial:context});
  while(encoder.encode(body).byteLength>CHAT_LIMITS.clientRequestBytes&&context.length>1){
    context.shift();body=JSON.stringify({historial:context});
  }
  if(encoder.encode(body).byteLength>CHAT_LIMITS.clientRequestBytes)throw new Error('La pregunta supera el tamaño permitido.');
  return body;
}
