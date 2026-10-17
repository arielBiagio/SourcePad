export function responseError(body,fallback,status) {
  const message=[body?.message,body?.error?.message,body?.error].find(value=>typeof value==='string'&&value.trim());
  const error=new Error(message?.slice(0,500)||fallback);
  if(status!==undefined)error.status=status;
  if(typeof body?.code==='string')error.code=body.code;
  if(typeof body?.reason==='string')error.reason=body.reason;
  return error;
}

export function createHttpClient({fetchImpl=(...args)=>fetch(...args),onUnauthorized,timeoutMs=15000}={}) {
  async function request(path,options={}, {kind='json',sessionRequired=true,errorMessage='No se pudo completar la operación.'}={}) {
    const headers=new Headers(options.headers);
    if(options.body!==undefined&&!(options.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    const response=await fetchImpl(path,{...options,headers,credentials:'same-origin',signal:options.signal||AbortSignal.timeout(timeoutMs)});
    if(!response.ok){
      const body=await response.json().catch(()=>null);
      const error=responseError(body,errorMessage,response.status);
      if(response.status===401&&sessionRequired&&onUnauthorized){onUnauthorized();error.message='Tu sesión finalizó.';}
      throw error;
    }
    if(kind==='response')return response;
    if(response.status===204)return null;
    return kind==='blob'?response.blob():response.json();
  }
  return {
    json:(path,options,policy)=>request(path,options,policy),
    blob:(path,options,policy)=>request(path,options,{...policy,kind:'blob'}),
    response:(path,options,policy)=>request(path,options,{...policy,kind:'response'}),
  };
}
