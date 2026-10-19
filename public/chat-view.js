import {releaseTurn} from './chat-scroll.js';
export function createChatView({$,closeSourceText,getTurns}) {
  function clearAnswer() {
    releaseTurn($('latestTurn'));
    $('ragAnswer').hidden = true; $('ragAnswerText').replaceChildren();
    $('latestQuestion').hidden = true; $('latestQuestion').textContent = '';
  }
  function clearStreaming() {
    releaseTurn($('streamingTurn'));
    $('streamingTurn').hidden=true;$('streamingBlocks').replaceChildren();$('streamingQuestion').textContent='';
    $('streamingStatus').textContent='';$('streamingStatus').classList.remove('error');$('streamingBlocks').setAttribute('aria-busy','false');
    $('chatEmpty').hidden=getTurns().length>0;
  }
  function openCitation(result,citation) {
    const source = result.sources.find(s => s.id === citation.sourceId);
    if (!source) return;
    closeSourceText();
    $('sourceTextTitle').textContent = source.filename;
    $('sourceViewerFeedback').textContent = '';
    $('citationMeta').textContent = '[' + source.id + ']' + (source.page_number ? ' · Página ' + source.page_number : '') + ' · Fragmento ' + (source.position + 1);
    $('citationMeta').hidden = false; $('citationQuote').textContent = citation.quote; $('citationQuote').hidden = false;
    document.querySelector('.viewer-tabs').hidden = true; $('originalPreview').hidden = true; $('sourceTextChunks').hidden = false;
    const article = document.createElement('details'); article.className = 'text-chunk citation-context';
    const label = document.createElement('summary'); label.textContent = 'Ver fragmento completo';
    const text = document.createElement('pre'); text.textContent = source.content; article.append(label,text); $('sourceTextChunks').append(article);
    $('sourceTextPanel').showModal();
  }
  function populateAnswer(result,textHost) {
    if (result.insufficientEvidence) {
      const p = document.createElement('p'); p.className = 'rag-paragraph'; p.textContent = result.message; textHost.append(p);
    }
    for (const segment of result.segments) {
      const p = document.createElement('p'); p.className = 'rag-paragraph'; p.textContent = segment.text;
      const occurrences=new Map();
      for (const citation of segment.citations) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'rag-citation'; button.textContent = citation.sourceId.replace(/^F/,'');
        const occurrence=(occurrences.get(citation.sourceId)||0)+1;occurrences.set(citation.sourceId,occurrence);
        const multiple=segment.citations.filter(c=>c.sourceId===citation.sourceId).length>1;
        const label='Ver cita '+citation.sourceId+(multiple?' · extracto '+occurrence:'');
        button.setAttribute('aria-label',label);button.title=label;
        button.addEventListener('click',() => openCitation(result,citation)); p.append(button);
      }
      textHost.append(p);
    }
  }
  function renderAnswer(result) {
    clearAnswer(); $('ragAnswer').hidden = false;
    populateAnswer(result,$('ragAnswerText'));
  }
  function validTurn(turn) {
    const answer = turn?.answer;
    return typeof turn?.question === 'string' && answer && Array.isArray(answer.segments) && Array.isArray(answer.sources)
      && answer.sources.every(s => s && typeof s.id === 'string' && typeof s.content === 'string')
      && answer.segments.every(s => s && typeof s.text === 'string' && Array.isArray(s.citations) && s.citations.every(c => c && answer.sources.some(source => source.id === c.sourceId) && typeof c.quote === 'string'));
  }
  function renderConversation() {
    const turns=getTurns();
    clearStreaming();
    $('conversationHistory').replaceChildren(); clearAnswer(); $('chatEmpty').hidden = turns.length > 0;
    for (const [index,turn] of turns.entries()) {
      if (index === turns.length-1) {
        renderAnswer(turn.answer); $('latestQuestion').textContent = turn.question; $('latestQuestion').hidden = false; continue;
      }
      const article = document.createElement('article'); article.className = 'chat-turn';
      const question = document.createElement('p'); question.className = 'chat-question'; question.textContent = turn.question;
      const answer = document.createElement('div'); answer.className = 'rag-answer';
      answer.setAttribute('role','region'); answer.setAttribute('aria-label','Respuesta del asistente');
      const text = document.createElement('div');
      populateAnswer(turn.answer,text); answer.append(text); article.append(question,answer); $('conversationHistory').append(article);
    }
  }

  return {clearAnswer,clearStreaming,populateAnswer,validTurn,renderConversation};
}
