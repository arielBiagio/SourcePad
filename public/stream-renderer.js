// Coalesce provider chunks, not individual characters. Sanitization belongs in render.
export function createStreamRenderer({render,schedule=fn=>requestAnimationFrame(fn),cancel=id=>cancelAnimationFrame(id)}) {
  let text='',painted='',frame=null,stopped=false;
  function flush(){
    if(frame!==null){cancel(frame);frame=null;}
    if(!stopped&&text!==painted){painted=text;render(text);}
  }
  return {
    append(chunk){if(stopped)return;text+=chunk;if(frame===null)frame=schedule(flush);},
    finish(){if(stopped)return;flush();stopped=true;},
    stop(){if(frame!==null)cancel(frame);frame=null;stopped=true;},
  };
}
