function availableHeight(container){
  const style=getComputedStyle(container);
  return Math.max(0,container.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
}
export function releaseTurn(turn){turn.style.minHeight='';}
export function pinQuestion(container,turn,question){
  turn.style.minHeight=availableHeight(container)+'px';
  const padding=parseFloat(getComputedStyle(container).paddingTop);
  container.scrollTop+=question.getBoundingClientRect().top-container.getBoundingClientRect().top-container.clientTop-padding;
}
export function restoreQuestion(container,turn,question,top){
  turn.style.minHeight=availableHeight(container)+'px';
  container.scrollTop+=question.getBoundingClientRect().top-top;
}
export function showLatest(container){container.scrollTop=container.scrollHeight;}
