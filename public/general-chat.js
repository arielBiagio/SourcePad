import {CHAT_LIMITS} from './contracts.js';
import {buildChatRequest} from './chat-context.js';
import {createStreamRenderer} from './stream-renderer.js';
import {createHttpClient} from './http.js';

const http=createHttpClient({onUnauthorized:()=>location.replace('/auth.html')});
// URL relativa: evita CORS y usa el mismo origen que sirve este frontend.
const API_URL = '/api/chat';
const API_LABEL = `${window.location.host}/api/chat`;

// Keep only the existing context window in request memory.
let historialDeMensajes = [];

// Cancel both the active request and any pending render for this generation.
let cancelarGeneracionActual = null;

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
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 128) + 'px';
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
  autoScrollActivo = true;
});

// Detecta si el usuario está leyendo mensajes anteriores (scrolleó hacia arriba)
messages.addEventListener('scroll', () => {
  const distanciaAlFondo = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  autoScrollActivo = distanciaAlFondo <= UMBRAL_SCROLL_PX;
});

function scrollToBottom() {
  if (!autoScrollActivo) return;
  messages.scrollTop = messages.scrollHeight;
}

function addMessage({ role, text }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg-in flex flex-col gap-1.5 max-w-[85%] ${role === 'user' ? 'items-end self-end' : 'items-start self-start'}`;

  const label = document.createElement('span');
  label.className = 'mono text-[10px] uppercase tracking-wider';
  label.style.color = 'var(--text-dim)';
  label.textContent = role === 'user' ? 'vos' : 'asistente';

  const bubble = document.createElement('div');
  bubble.className = `rounded-xl px-4 py-3 border text-sm leading-relaxed ${role === 'user' ? 'rounded-tr-sm whitespace-pre-wrap' : 'rounded-tl-sm markdown-content'}`;

  if (role === 'user') {
    bubble.style.background = 'var(--accent-dim)';
    bubble.style.borderColor = 'var(--accent)';
    bubble.style.color = 'var(--text)';
  } else {
    bubble.style.background = 'var(--surface-2)';
    bubble.style.borderColor = 'var(--border)';
    bubble.style.color = 'var(--text)';
  }

  bubble.textContent = text;
  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

function addLoadingBubble() {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-in flex flex-col gap-1.5 max-w-[85%] items-start self-start';
  wrapper.id = 'loadingBubble';

  const label = document.createElement('span');
  label.className = 'mono text-[10px] uppercase tracking-wider';
  label.style.color = 'var(--text-dim)';
  label.textContent = 'asistente';

  const bubble = document.createElement('div');
  bubble.className = 'rounded-xl rounded-tl-sm px-4 py-3.5 border flex items-center gap-1.5';
  bubble.style.background = 'var(--surface-2)';
  bubble.style.borderColor = 'var(--border)';

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot w-1.5 h-1.5 rounded-full';
    dot.style.background = 'var(--text-dim)';
    bubble.appendChild(dot);
  }

  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
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
    statusText.textContent = 'esperando respuesta...';
  } else if (state === 'error') {
    statusDot.style.background = '#F87171';
    statusPing.style.background = '#F87171';
    statusText.textContent = 'error de conexión';
  } else {
    statusDot.style.background = 'var(--ok)';
    statusPing.style.background = 'var(--ok)';
    statusText.textContent = API_LABEL;
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
  let respuestaDeLaIA = '', bubbleActiva = null, finished = false, reader;
  const renderer = createStreamRenderer({render: value => {
    if (!bubbleActiva) { removeLoadingBubble(); bubbleActiva = addMessage({role:'assistant',text:''}); }
    bubbleActiva.innerHTML = DOMPurify.sanitize(marked.parse(value)); scrollToBottom();
  }});
  function settle(state, save) {
    if (finished) return;
    finished = true; renderer.stop(); removeLoadingBubble();
    if (save && respuestaDeLaIA) historialDeMensajes = [...historialDeMensajes,{role:'assistant',content:respuestaDeLaIA}].slice(-CHAT_LIMITS.contextMessages);
    setStatus(state); setLoadingUI(false); input.focus(); cancelarGeneracionActual = null;
  }
  const cancel = () => {
    if (finished) return;
    controller.abort(); renderer.finish(); settle('idle',true);
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
    addMessage({role:'assistant',text:'No se pudo conectar con '+API_URL+'.\nDetalle: '+error.message});
    settle('error',false);
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
  addMessage({ role: 'user', text });
  input.value = '';
  input.style.height = 'auto';
  sendMessage(text);
});

async function initializeSession() {
  try {
    const session = await http.json('/api/me');
    userName.textContent = session.user?.name || session.user?.email || 'sesión activa';
    input.focus();
  } catch (error) {
    setStatus('error');
    statusText.textContent = 'no se pudo validar la sesión';
  }
}

initializeSession();
