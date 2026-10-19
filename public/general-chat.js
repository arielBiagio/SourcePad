import {CHAT_LIMITS} from './contracts.js';
import {buildChatRequest} from './chat-context.js';
import {createStreamRenderer} from './stream-renderer.js';
import {createHttpClient} from './http.js';
import {pinQuestion,releaseTurn,showLatest} from './chat-scroll.js';
import {createChatSession,clearChatSessions} from './chat-session.js';

const http=createHttpClient({onUnauthorized:()=>{
  clearTimeout(saveTimer); sessionChat=null; clearChatSessions(); location.replace('/auth.html');
}});
// URL relativa: evita CORS y usa el mismo origen que sirve este frontend.
const API_URL = '/api/chat';

// Keep only the existing context window in request memory.
let historialDeMensajes = [];

// Cancel both the active request and any pending render for this generation.
let cancelarGeneracionActual = null;
let activeTurn=null,lastTurn=null;
let sessionChat=null,transcript=[],saveTimer;

// Scroll inteligente: si el usuario sube a leer mensajes viejos, dejamos de forzar el scroll al fondo
let autoScrollActivo = true;
const UMBRAL_SCROLL_PX = 48;

const form = document.getElementById('chatForm');
const input = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');
const sendIcon = document.getElementById('sendIcon');
const messages = document.getElementById('messages');
const clearBtn = document.getElementById('clearBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userName = document.getElementById('userName');
const statusDot = document.getElementById('statusDot');
const statusPing = document.getElementById('statusPing');
const statusText = document.getElementById('statusText');

// auto-resize textarea
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
}
function persistChat() {
  clearTimeout(saveTimer);
  if (sessionChat && !sessionChat.save(transcript,input.value)) statusText.textContent='No se pudo conservar el chat en esta pestaña.';
}
function scheduleSave() {
  clearTimeout(saveTimer); saveTimer=setTimeout(persistChat,250);
}
input.addEventListener('input', () => { resizeInput(); scheduleSave(); });
window.addEventListener('pagehide', () => { cancelarGeneracionActual?.(); persistChat(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  messages.hidden=true;setLoadingUI(true);clearBtn.disabled=true;void initializeSession();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    form.requestSubmit();
  }
});

clearBtn.addEventListener('click', () => {
  cancelarGeneracionActual?.();
  messages.replaceChildren();
  historialDeMensajes = [];
  transcript=[];clearTimeout(saveTimer);sessionChat?.clear();input.value='';resizeInput();
  activeTurn=null;lastTurn=null;
  autoScrollActivo = true;
});

// Detecta si el usuario está leyendo mensajes anteriores (scrolleó hacia arriba)
messages.addEventListener('scroll', () => {
  const distanciaAlFondo = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  autoScrollActivo = distanciaAlFondo <= UMBRAL_SCROLL_PX;
});

function scrollToBottom() {
  if (activeTurn || !autoScrollActivo) return;
  messages.scrollTop = messages.scrollHeight;
}

function addMessage({ role, text }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg-in message ${role === 'user' ? 'message-user' : 'message-assistant'}`;

  const label = document.createElement('span');
  label.className = 'sr-only';
  label.style.color = 'var(--text-dim)';
  label.textContent = role === 'user' ? 'vos' : 'asistente';

  const bubble = document.createElement('div');
  bubble.className = `message-bubble${role === 'user' ? '' : ' markdown-content'}`;

  bubble.textContent = text;
  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  (activeTurn||messages).appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

function addLoadingBubble() {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-in message message-assistant';
  wrapper.id = 'loadingBubble';

  const label = document.createElement('span');
  label.className = 'sr-only';
  label.style.color = 'var(--text-dim)';
  label.textContent = 'asistente';

  const bubble = document.createElement('div');
  bubble.className = 'loading-dots';

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'loading-dot';
    bubble.appendChild(dot);
  }

  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  (activeTurn||messages).appendChild(wrapper);
  scrollToBottom();
}

function removeLoadingBubble() {
  const el = document.getElementById('loadingBubble');
  if (el) el.remove();
}

function setStatus(state) {
  // state: 'idle' | 'loading' | 'error'
  if (state === 'loading') {
    statusDot.style.background = 'var(--accent)';
    statusPing.style.background = 'var(--accent)';
    statusText.textContent = 'Respondiendo…';
  } else if (state === 'error') {
    statusDot.style.background = 'var(--danger)';
    statusPing.style.background = 'var(--danger)';
    statusText.textContent = 'error de conexión';
  } else {
    statusDot.style.background = 'var(--ok)';
    statusPing.style.background = 'var(--ok)';
    statusText.textContent = '';
  }
}

function setLoadingUI(isLoading) {
  sendBtn.disabled = isLoading;
  input.disabled = isLoading;
  sendIcon.style.opacity = isLoading ? '0' : '1';

  if (isLoading) {
    sendBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    cancelBtn.classList.add('flex');
  } else {
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    cancelBtn.classList.remove('flex');
  }
}

async function sendMessage(text) {
  setLoadingUI(true); setStatus('loading'); addLoadingBubble();
  historialDeMensajes = [...historialDeMensajes,{role:'user',content:text}].slice(-CHAT_LIMITS.contextMessages);
  const controller = new AbortController();
  let respuestaDeLaIA = '', bubbleActiva = null, answerEntry = null, finished = false, reader;
  const renderer = createStreamRenderer({render: value => {
    if (!bubbleActiva) {
      removeLoadingBubble(); bubbleActiva = addMessage({role:'assistant',text:''});
      answerEntry={role:'assistant',content:'',context:false,interrupted:true};transcript.push(answerEntry);
    }
    answerEntry.content=value;scheduleSave();
    bubbleActiva.innerHTML = DOMPurify.sanitize(marked.parse(value)); scrollToBottom();
  }});
  function settle(state, save, interrupted=false) {
    if (finished) return;
    finished = true; renderer.stop(); removeLoadingBubble();
    if (save && respuestaDeLaIA) historialDeMensajes = [...historialDeMensajes,{role:'assistant',content:respuestaDeLaIA}].slice(-CHAT_LIMITS.contextMessages);
    if(answerEntry){answerEntry.context=save;answerEntry.interrupted=interrupted;}
    setStatus(state); setLoadingUI(false); input.focus({preventScroll:true}); cancelarGeneracionActual = null;activeTurn=null;
    persistChat();
  }
  const cancel = () => {
    if (finished) return;
    controller.abort(); renderer.finish(); settle('idle',true,true);
  };
  cancelarGeneracionActual = cancel;
  try {
    const response = await http.response(API_URL,{method:'POST',body:buildChatRequest(historialDeMensajes),signal:controller.signal});
    if (finished) return;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const {done,value} = await reader.read();
      if (finished) return;
      const chunk = done ? decoder.decode() : decoder.decode(value,{stream:true});
      if (chunk) { respuestaDeLaIA += chunk; renderer.append(chunk); }
      if (done) break;
    }
    renderer.finish(); settle('idle',true);
  } catch (error) {
    if (finished) return;
    if (error.name === 'AbortError') { cancel(); return; }
    renderer.stop(); removeLoadingBubble();
    const message='No se pudo completar la respuesta.\n'+error.message;
    transcript.push({role:'assistant',content:message,context:false,error:true});
    addMessage({role:'assistant',text:message});
    settle('error',false,true);
  } finally {
    if (reader) { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  }
}

cancelBtn.addEventListener('click', () => {
  if (cancelarGeneracionActual) {
    cancelarGeneracionActual();
  }
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;

  try {
    await http.json('/api/auth/sign-out',{method:'POST'});
    cancelarGeneracionActual?.();clearTimeout(saveTimer);sessionChat=null;clearChatSessions();
    window.location.replace('/auth.html');
  } catch (error) {
    statusText.textContent = error.message;
    logoutBtn.disabled = false;
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;

  autoScrollActivo = true; // al mandar un mensaje nuevo, siempre volvemos a seguir el flujo del chat
  if(lastTurn)releaseTurn(lastTurn);
  activeTurn=document.createElement('article');activeTurn.className='general-turn';lastTurn=activeTurn;messages.append(activeTurn);
  const question=addMessage({ role: 'user', text });
  transcript.push({role:'user',content:text,context:true});
  input.value = '';
  input.style.height = 'auto';
  persistChat();
  sendMessage(text);
  pinQuestion(messages,lastTurn,question);
});

async function initializeSession() {
  try {
    const session = await http.json('/api/me');
    sessionChat=createChatSession(session.user.id);
    const saved=sessionChat.load();
    transcript=saved?.messages||[];
    historialDeMensajes=transcript.filter(message=>message.context).slice(-CHAT_LIMITS.contextMessages).map(({role,content})=>({role,content}));
    messages.replaceChildren();activeTurn=null;lastTurn=null;
    for(const message of transcript){
      if(message.role==='user'||!activeTurn){
        activeTurn=document.createElement('article');activeTurn.className='general-turn';messages.append(activeTurn);lastTurn=activeTurn;
      }
      const bubble=addMessage({role:message.role,text:message.content});
      if(message.role==='assistant'&&!message.error)bubble.innerHTML=DOMPurify.sanitize(marked.parse(message.content));
      if(message.interrupted){
        const note=document.createElement('small');note.className='interrupted-answer';note.textContent='Respuesta interrumpida.';bubble.append(note);
      }
    }
    activeTurn=null;messages.hidden=false;
    input.value=saved?.draft||'';resizeInput();setLoadingUI(false);clearBtn.disabled=false;
    setStatus('idle');
    requestAnimationFrame(()=>showLatest(messages));
    userName.textContent = session.user?.name || session.user?.email || 'sesión activa';
    input.focus({preventScroll:true});
  } catch (error) {
    setStatus('error');
    statusText.textContent = 'no se pudo validar la sesión';
  }
}

initializeSession();
