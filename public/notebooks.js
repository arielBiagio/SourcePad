import { readAnswerResponse } from './answer-stream.js?v=20261016-cleanup';
import {createHttpClient} from './http.js';
import {createSourceViewer} from './source-viewer.js';
import {createChatView} from './chat-view.js';
import {createSourceList} from './source-list.js';

const $ = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
let notebooks = [];
let selected = null;
let mode = 'create';
let busy = false;
let sources = [];
let sourcesBusy = false;
let sourceVersion = 0;
let pendingDelete = null;
let maxUploadBytes = 10485760;
let embeddingsConfigured = false;
let pendingIndexSource = null;
let stopIndexRequested = false;
let answerController = null;
let turns = [];
let historyLoading = false;
let conversationVersion = 0;
const localTurns = new Map();
const previewSources = new Map();
const previewFiles = new Map();
const expandedSources = new Set();

const http=createHttpClient({onUnauthorized:()=>location.replace('/auth.html')});
const api=http.json;
const {downloadSource,openSource,showSourceText,closeSourceText}=createSourceViewer({$,api,http,preview,previewFiles,getNotebook:()=>selected,isBusy:()=>sourcesBusy,lockSources,sourceFeedback});
const {clearAnswer,clearStreaming,followingChat,populateAnswer,validTurn,renderConversation}=createChatView({$,closeSourceText,getTurns:()=>turns});

const {renderSources}=createSourceList({$,getSources:()=>sources,isConfigured:()=>embeddingsConfigured,expandedSources,openSource,processSource,showSourceText,downloadSource,
  onIndex:source=>{pendingIndexSource=source;$('indexSourceMessage').textContent='Fuente: “'+source.filename+'”. Fragmentos pendientes: '+(source.chunk_count-(source.indexed_chunk_count||0))+'.';$('indexSourcePrompt').showModal();$('confirmIndexing').focus();},
  onRemove:source=>{pendingDelete=source;$('deleteSourceMessage').textContent='¿Eliminar la fuente “'+source.filename+'”? El archivo dejará de estar disponible.';$('deleteSourcePrompt').showModal();$('confirmSourceDelete').focus();},
});

function resizeQuery() {
  const input = $('semanticQuery');
  if (!input.clientWidth) return;
  const previousHeight = input.getBoundingClientRect().height;
  const style = getComputedStyle(input);
  const min = parseFloat(style.minHeight), max = parseFloat(style.maxHeight);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  // Measure the natural wrapped content, then animate from the current pixel height.
  input.style.transition = 'none'; input.style.height = '0px';
  const natural = input.scrollHeight + borders;
  input.style.height = previousHeight + 'px'; input.getBoundingClientRect();
  input.style.transition = '';
  input.style.height = Math.min(max,Math.max(min,natural)) + 'px';
  input.style.overflowY = natural > max ? 'auto' : 'hidden';
}
$('semanticQuery').addEventListener('input',resizeQuery);
$('semanticQuery').addEventListener('keydown',event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat && !$('answerNotebook').disabled && $('semanticQuery').value.trim()) $('semanticSearchForm').requestSubmit($('answerNotebook'));
});
let queryWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width && width !== queryWidth) { queryWidth = width; resizeQuery(); }
}).observe($('semanticQuery'));

function feedback(message = '', error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}

function render() {
  $('notebookCount').textContent = String(notebooks.length);
  $('listLabel').textContent = `${notebooks.length} cuaderno${notebooks.length === 1 ? '' : 's'}`;
  const term = $('search').value.trim().toLocaleLowerCase();
  const filtered = notebooks.filter(n => `${n.title} ${n.description}`.toLocaleLowerCase().includes(term));
  $('emptyState').hidden = notebooks.length !== 0;
  $('noResults').hidden = !notebooks.length || filtered.length > 0;
  $('notebookGrid').replaceChildren();
  for (const notebook of filtered) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'card-icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h2'); title.textContent = notebook.title;
    const description = document.createElement('p'); description.textContent = notebook.description || 'Un nuevo espacio para explorar.';
    const footer = document.createElement('span'); footer.className = 'card-footer mono';
    const date = document.createElement('span');
    date.textContent = new Date(notebook.updated_at).toLocaleDateString('es', { day: 'numeric', month: 'short' });
    const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
    footer.append(date, arrow); card.append(icon, title, description, footer);
    card.addEventListener('click', () => openDetail(notebook));
    $('notebookGrid').append(card);
  }
  renderWorkspaceNotebooks();
}

function renderWorkspaceNotebooks() {
  $('workspaceNotebooks').replaceChildren();
  for (const book of notebooks) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = '▤  ' + book.title; button.setAttribute('aria-current',String(book.id === selected?.id));
    button.disabled = sourcesBusy; button.addEventListener('click',() => openDetail(book)); $('workspaceNotebooks').append(button);
  }
}
function showPanel(name) {
  for (const panel of document.querySelectorAll('[data-panel]')) panel.classList.toggle('is-active',panel.dataset.panel === name);
  for (const button of document.querySelectorAll('[data-show-panel]')) button.setAttribute('aria-pressed',String(button.dataset.showPanel === name));
  if (name === 'chat') resizeQuery();
}
for (const button of document.querySelectorAll('[data-show-panel]')) button.addEventListener('click',() => showPanel(button.dataset.showPanel));
function closeWorkspace() {
  if (sourcesBusy) return;
  closeSourceText(); $('detailDialog').hidden = true; document.body.classList.remove('workspace-open');
  const url = new URL(location.href); url.searchParams.delete('notebook'); history.replaceState(null,'',url);
  selected = null; conversationVersion++; renderWorkspaceNotebooks(); $('createNotebook').focus();
}

function openDetail(notebook) {
  if (sourcesBusy) return;
  selected = notebook;
  $('detailTitle').textContent = notebook.title;
  $('detailDescription').textContent = notebook.description || 'Todavía no agregaste una descripción.';
  $('detailDialog').hidden = false; document.body.classList.add('workspace-open');
  const url = new URL(location.href); url.searchParams.set('notebook',notebook.id); history.replaceState(null,'',url);
  $('deleteSourcePrompt').close();
  pendingDelete = null;
  pendingIndexSource = null; $('indexSourcePrompt').close();
  $('semanticQuery').value = '';
  expandedSources.clear();
  clearStreaming();
  turns = []; clearAnswer(); $('conversationHistory').replaceChildren(); $('chatEmpty').hidden = false;
  showPanel('chat'); renderWorkspaceNotebooks(); loadConversation();
  loadSources();
}

function openEditor(nextMode) {
  if (busy || sourcesBusy) return;
  mode = nextMode;
  $('notebookForm').reset();
  $('formFeedback').textContent = '';
  $('editorFields').hidden = mode === 'delete';
  $('deleteMessage').hidden = mode !== 'delete';
  $('title').required = mode !== 'delete';
  $('dialogTitle').textContent = mode === 'create' ? 'Nuevo cuaderno' : mode === 'edit' ? 'Editar cuaderno' : 'Eliminar cuaderno';
  $('saveNotebook').textContent = mode === 'delete' ? 'Eliminar cuaderno' : mode === 'edit' ? 'Guardar cambios' : 'Crear cuaderno';
  $('saveNotebook').className = mode === 'delete' ? 'danger' : 'primary';
  if (mode !== 'create') {
    $('title').value = selected.title;
    $('description').value = selected.description;
  }
  $('notebookDialog').showModal();
}

$('createNotebook').addEventListener('click', () => openEditor('create'));
$('emptyCreate').addEventListener('click', () => openEditor('create'));
$('editNotebook').addEventListener('click', () => openEditor('edit'));
$('deleteNotebook').addEventListener('click', () => openEditor('delete'));
$('closeDetail').addEventListener('click',closeWorkspace);
$('workspaceCreate').addEventListener('click',() => openEditor('create'));
for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', () => { if (!busy) $('notebookDialog').close(); });
$('notebookDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('search').addEventListener('input', render);
$('notebookForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const input = { title: $('title').value.trim(), description: $('description').value.trim() };
  if (mode !== 'delete' && !input.title) {
    $('formFeedback').textContent = 'Ingresá un título para el cuaderno.';
    return;
  }
  busy = true;
  $('saveNotebook').disabled = true;
  $('formFeedback').textContent = '';
  try {
    if (mode === 'delete') {
      if (!preview) await api(`/api/notebooks/${selected.id}`, { method: 'DELETE' });
      notebooks = notebooks.filter(n => n.id !== selected.id);
    } else {
      const notebook = preview
        ? { ...selected, ...input, id: mode === 'create' ? crypto.randomUUID() : selected.id, updated_at: new Date().toISOString() }
        : (await api(mode === 'create' ? '/api/notebooks' : `/api/notebooks/${selected.id}`, {
          method: mode === 'create' ? 'POST' : 'PATCH', body: JSON.stringify(input),
        })).notebook;
      notebooks = [notebook, ...notebooks.filter(n => n.id !== notebook.id)];
    }
    render();
    $('notebookDialog').close();
    if (mode === 'delete') closeWorkspace();
    else if (selected && mode === 'edit') { selected = notebooks.find(n => n.id === selected.id); $('detailTitle').textContent = selected.title; $('detailDescription').textContent = selected.description; renderWorkspaceNotebooks(); }
    else if (selected) openDetail(notebooks[0]);
    else $('createNotebook').focus();
    feedback(mode === 'delete' ? 'Cuaderno eliminado.' : 'Cuaderno guardado.');
  } catch (error) {
    $('formFeedback').textContent = error.name === 'TimeoutError' ? 'La conexión tardó demasiado. Intentá nuevamente.' : error.message;
    $('formFeedback').classList.add('error');
  } finally { busy = false; $('saveNotebook').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  if (preview) { location.assign('/auth.html'); return; }
  $('logout').disabled = true;
  try {
    await api('/api/auth/sign-out', { method: 'POST' });
    location.replace('/auth.html');
  } catch (error) { feedback(error.message, true); $('logout').disabled = false; }
});

async function initialize() {
  $('createNotebook').disabled = true;
  $('emptyCreate').disabled = true;
  $('loading').hidden = false;
  $('retry').hidden = true;
  feedback();
  try {
    if (preview) {
      $('previewBanner').hidden = false;
      $('userName').textContent = 'vista de ejemplo';
      for (const element of document.querySelectorAll('.brand,.nav-active')) element.href = '/notebooks.html?preview=1';
      notebooks = [
        { id: crypto.randomUUID(), title: 'Inteligencia artificial', description: 'Ideas, conceptos y preguntas para aprender sobre modelos de lenguaje.', updated_at: new Date().toISOString() },
        { id: crypto.randomUUID(), title: 'Mi próximo proyecto', description: 'Un lugar para ordenar lo que quiero construir.', updated_at: new Date().toISOString() },
      ];
    } else {
      const config = await api('/api/config');
      maxUploadBytes = config.maxUploadBytes || maxUploadBytes;
      embeddingsConfigured = Boolean(config.embeddingsConfigured);
      if (!config.notebooksEnabled) {
        $('setupState').hidden = false; $('library').hidden = true; $('userName').textContent = 'conexión pendiente';
        $('logout').hidden = true;
        return;
      }
      const { user } = await api('/api/me');
      $('userName').textContent = user.name || user.email;
      const data = await api('/api/notebooks');
      notebooks = data.notebooks;
      if (data.hasMore) feedback('Se muestran los 200 cuadernos más recientes.');
    }
    render();
    const requested = new URLSearchParams(location.search).get('notebook');
    const book = notebooks.find(n => n.id === requested);
    if (book) openDetail(book);
    $('createNotebook').disabled = false;
    $('emptyCreate').disabled = false;
  } catch (error) {
    feedback(error.name === 'TimeoutError' ? 'La conexión tardó demasiado. Volvé a intentar.' : error.message, true);
    $('retry').hidden = false;
  } finally { $('loading').hidden = true; }
}
$('retry').addEventListener('click', initialize);
initialize();

function sourceFeedback(message = '', error = false) {
  $('sourceFeedback').textContent = message;
  $('sourceFeedback').classList.toggle('error', error);
  if ($('uploadDialog').open) { $('uploadFeedback').textContent = message; $('uploadFeedback').classList.toggle('error',error); }
}
function lockSources(value) {
  sourcesBusy = value;
  for (const id of ['uploadSources', 'sourceFiles', 'refreshSources', 'closeDetail', 'editNotebook', 'confirmSourceDelete', 'cancelSourceDelete', 'moreSourceText', 'confirmIndexing', 'cancelIndexing', 'semanticQuery', 'addSources', 'closeUpload', 'workspaceCreate', 'clearConversation']) $(id).disabled = value;
  $('answerNotebook').disabled = value || historyLoading || !embeddingsConfigured || !sources.some(s => s.status === 'ready' && s.index_status === 'indexed');
  $('clearConversation').disabled = value || historyLoading;
  $('embeddingsSetupNote').hidden = embeddingsConfigured && !preview;
  $('deleteNotebook').disabled = value || sources.length > 0;
  $('deleteNotebook').title = sources.length ? 'Eliminá las fuentes antes de eliminar el cuaderno.' : '';
  $('deleteNotebookNote').hidden = !sources.length;
  for (const button of $('sourceList').querySelectorAll('button')) button.disabled = value || button.dataset.needsEmbeddings === 'true' && !embeddingsConfigured;
  for (const button of $('workspaceNotebooks').querySelectorAll('button')) button.disabled = value;
}
async function loadSources() {
  closeSourceText();
  $('searchFeedback').textContent = '';
  const notebookId = selected.id;
  const version = ++sourceVersion;
  sources = []; renderSources(); lockSources(true);
  $('noSources').hidden = true;
  sourceFeedback('Cargando fuentes…');
  $('uploadLimits').textContent = 'PDF, TXT o Markdown · hasta ' + (maxUploadBytes / 1048576).toLocaleString('es') + ' MiB por archivo';
  try {
    const result = preview ? { documents: previewSources.get(notebookId) || [] } : await api('/api/notebooks/' + notebookId + '/documents');
    if (version !== sourceVersion || selected.id !== notebookId) return;
    sources = result.documents; renderSources();
    sourceFeedback(result.hasMore ? 'Se muestran las 200 fuentes más recientes.' : '');
  } catch (error) {
    sourceFeedback(error.message, true);
  } finally { if (version === sourceVersion) lockSources(false); }
}
$('refreshSources').addEventListener('click', loadSources);
$('addSources').addEventListener('click',() => { if (!sourcesBusy) { $('uploadFeedback').textContent = ''; $('uploadDialog').showModal(); } });
$('closeUpload').addEventListener('click',() => { if (!sourcesBusy) $('uploadDialog').close(); });
for (const id of ['uploadDialog','deleteSourcePrompt','indexSourcePrompt','clearChatDialog']) $(id).addEventListener('cancel',event => { if (sourcesBusy || busy) event.preventDefault(); });
$('sourceTextPanel').addEventListener('cancel',event => { event.preventDefault(); closeSourceText(); });
$('cancelSourceDelete').addEventListener('click', () => { $('deleteSourcePrompt').close(); pendingDelete = null; });
$('confirmSourceDelete').addEventListener('click', async () => {
  if (sourcesBusy || !pendingDelete) return;
  const document = pendingDelete;
  lockSources(true); sourceFeedback('Eliminando fuente…');
  try {
    if (preview) {
      previewSources.set(selected.id, sources.filter(item => item.id !== document.id)); previewFiles.delete(document.id);
    } else await api('/api/notebooks/' + selected.id + '/documents/' + document.id, { method: 'DELETE' });
    $('deleteSourcePrompt').close(); pendingDelete = null;
    await loadSources(); sourceFeedback('Fuente eliminada.');
  } catch (error) { await loadSources(); sourceFeedback(error.message, true); }
  finally { lockSources(false); }
});
$('uploadForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (sourcesBusy) return;
  const files = [...$('sourceFiles').files];
  if (!files.length || files.length > 10) { sourceFeedback('Elegí entre 1 y 10 archivos para esta subida.', true); return; }
  for (const file of files) {
    if (!/\.(pdf|txt|md)$/i.test(file.name) || !file.size || file.size > maxUploadBytes) {
      sourceFeedback('Revisá “' + file.name + '”: debe ser PDF, TXT o MD, no estar vacío y respetar el límite de tamaño.', true); return;
    }
  }
  lockSources(true);
  let uploaded = 0, lastError = '';
  for (const [index, file] of files.entries()) {
    sourceFeedback('Subiendo ' + (index + 1) + ' de ' + files.length + ': ' + file.name);
    try {
      if (preview) {
        const source = { id: crypto.randomUUID(), filename: file.name, extension: file.name.split('.').at(-1).toLowerCase(), byte_size: file.size, status: 'uploaded' };
        previewSources.set(selected.id, [...(previewSources.get(selected.id) || []), source]); previewFiles.set(source.id, file);
      } else {
        const form = new FormData(); form.append('file', file);
        await api('/api/notebooks/' + selected.id + '/documents', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      }
      uploaded++;
    } catch (error) { lastError = error.message; }
  }
  $('sourceFiles').value = '';
  await loadSources();
  sourceFeedback(uploaded + ' archivo(s) subido(s), pendientes de procesamiento.' + (lastError ? ' Hubo un error: ' + lastError : ''), Boolean(lastError));
  lockSources(false);
  if (!lastError) { $('uploadDialog').close(); showPanel('sources'); }
});
async function processSource(source) {
  if (sourcesBusy) return;
  if (preview) { sourceFeedback('El procesamiento requiere una cuenta conectada. Esta vista de ejemplo no envía archivos al servidor.'); return; }
  source.status = 'processing'; renderSources(); lockSources(true);
  sourceFeedback('Extrayendo texto y creando fragmentos… Si recargás o se interrumpe, podés reintentar después de dos minutos.');
  try {
    const { document } = await api('/api/notebooks/' + selected.id + '/documents/' + source.id + '/process', { method: 'POST', signal: AbortSignal.timeout(90000) });
    await loadSources();
    sourceFeedback('Texto extraído: ' + document.chunk_count + ' fragmento(s). Indexá la fuente para buscar o preguntar.');
  } catch (error) {
    await loadSources(); sourceFeedback(error.name === 'TimeoutError' ? 'La conexión tardó demasiado. Actualizá el estado antes de reintentar.' : error.message, true);
  } finally { lockSources(false); }
}
$('cancelIndexing').addEventListener('click',() => { pendingIndexSource = null; $('indexSourcePrompt').close(); });
$('stopIndexing').addEventListener('click',() => { stopIndexRequested = true; $('stopIndexing').disabled = true; });
$('confirmIndexing').addEventListener('click',async () => {
  if (sourcesBusy || !pendingIndexSource) return;
  let document = pendingIndexSource;
  pendingIndexSource = null; $('indexSourcePrompt').close();
  lockSources(true); stopIndexRequested = false; $('stopIndexing').hidden = false; $('stopIndexing').disabled = false;
  try {
    let complete = false;
    for (let batch = 0; batch < 50 && !stopIndexRequested; batch++) {
      sourceFeedback('Indexando con BGE-M3: ' + (document.indexed_chunk_count || 0) + '/' + document.chunk_count + ' fragmentos guardados…');
      const result = await api('/api/notebooks/' + selected.id + '/documents/' + document.id + '/index', {
        method: 'POST', body: JSON.stringify({ confirmExternalProcessing: true }), signal: AbortSignal.timeout(90000),
      });
      if (!result.complete && result.document.indexed_chunk_count <= (document.indexed_chunk_count || 0)) throw new Error('No hubo avance. Actualizá antes de reintentar.');
      document = result.document; complete = result.complete;
      sources = sources.map(s => s.id === document.id ? document : s); renderSources(); lockSources(true);
      if (complete) break;
    }
    await loadSources(); sourceFeedback(complete ? 'Fuente indexada. Ya podés buscar en este cuaderno.' : 'Indexación detenida. Los lotes guardados se conservan; podés continuar.');
  } catch (error) { await loadSources(); sourceFeedback(error.name === 'TimeoutError' ? 'La conexión se interrumpió. Actualizá el estado antes de reintentar.' : error.message,true); }
  finally { $('stopIndexing').hidden = true; lockSources(false); }
});
async function loadConversation() {
  const version = ++conversationVersion, bookId = selected.id;
  historyLoading = true;
  $('historyFeedback').textContent = ''; $('historyFeedback').classList.remove('error');
  try {
    const result = preview ? { turns: localTurns.get(bookId) || [] } : await api('/api/notebooks/'+bookId+'/conversation');
    if (version !== conversationVersion || selected?.id !== bookId) return;
    const unsaved = (localTurns.get(bookId) || []).filter(t => t.answer.saved === false && validTurn(t));
    turns = [...result.turns.filter(validTurn),...unsaved]; localTurns.set(bookId,[...turns]); renderConversation();
    $('historyFeedback').textContent = unsaved.length ? 'Hay respuestas sin guardar, disponibles sólo hasta cerrar o recargar esta página.' : result.hasMore ? 'Mostrando las últimas 30 preguntas guardadas.' : '';
    $('historyFeedback').classList.toggle('error',unsaved.length > 0);
  } catch (error) {
    if (version !== conversationVersion || selected?.id !== bookId) return;
    turns = localTurns.get(bookId) || []; renderConversation();
    $('historyFeedback').textContent = error.message + ' Las respuestas nuevas se mostrarán igualmente.'; $('historyFeedback').classList.add('error');
  } finally { if (version === conversationVersion) { historyLoading = false; lockSources(sourcesBusy); } }
}
$('clearConversation').addEventListener('click',() => { if (!sourcesBusy) { $('clearChatFeedback').textContent = ''; $('clearChatDialog').showModal(); } });
$('cancelClearChat').addEventListener('click',() => { if (!busy) $('clearChatDialog').close(); });
$('confirmClearChat').addEventListener('click',async () => {
  if (sourcesBusy || busy) return;
  conversationVersion++; historyLoading = false;
  busy = true; lockSources(true); $('confirmClearChat').disabled = true;
  try {
    if (!preview) await api('/api/notebooks/'+selected.id+'/conversation',{ method: 'DELETE',body: JSON.stringify({ confirm: true }) });
    localTurns.delete(selected.id); turns = []; renderConversation(); $('clearChatDialog').close(); $('historyFeedback').textContent = ''; $('historyFeedback').classList.remove('error');
  } catch (error) { $('clearChatFeedback').textContent = error.message; }
  finally { busy = false; lockSources(false); $('confirmClearChat').disabled = false; }
});
$('cancelAnswer').addEventListener('click',() => answerController?.abort());
$('semanticSearchForm').addEventListener('submit',async event => {
  event.preventDefault(); if (sourcesBusy || preview || $('answerNotebook').disabled) return;
  const query = $('semanticQuery').value.trim();
  if (!query) return;
  const restoreQueryFocus = [$('semanticQuery'),$('answerNotebook')].includes(document.activeElement);
  conversationVersion++; historyLoading = false;
  lockSources(true);
  $('searchFeedback').classList.remove('error'); $('searchFeedback').textContent = 'Consultando tus fuentes…';
  answerController = new AbortController(); $('cancelAnswer').hidden = false;
  $('semanticSearchForm').setAttribute('aria-busy','true');
  clearStreaming();
  const follow=followingChat();
  $('streamingQuestion').textContent=query;$('streamingTurn').hidden=false;$('chatEmpty').hidden=true;
  $('streamingBlocks').setAttribute('aria-busy','true');$('streamingStatus').textContent='Buscando en tus fuentes…';
  if(follow)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;
  let receivedBlocks=0;
  try {
    const response = await http.response('/api/notebooks/' + selected.id + '/answer', {
      method: 'POST',headers:{Accept:'application/x-ndjson'},body: JSON.stringify({ query,confirmExternalProcessing: true }),
      signal: AbortSignal.any([answerController.signal,AbortSignal.timeout(100000)]),
    });
    const result=await readAnswerResponse(response,event=>{
      const follow=followingChat();receivedBlocks++;
      populateAnswer({insufficientEvidence:false,segments:[event.segment],sources:event.sources},$('streamingBlocks'));
      $('streamingStatus').textContent='Recibiendo bloques con referencias a tus fuentes…';$('searchFeedback').textContent='';
      if(follow)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;
    });
    const shouldFollow=followingChat(),scrollTop=$('chatScroll').scrollTop;
    const turn = { id: result.turnId || crypto.randomUUID(),question: query,answer: result };
    turns = [...turns,turn].slice(-30); localTurns.set(selected.id,[...turns]); renderConversation();
    $('chatScroll').scrollTop=shouldFollow?$('chatScroll').scrollHeight:scrollTop;
    $('searchFeedback').textContent = result.insufficientEvidence ? 'No hay evidencia suficiente en los fragmentos consultados.' : '';
    if (result.saved === false) { $('historyFeedback').textContent = result.historyWarning; $('historyFeedback').classList.add('error'); }
    else if (!turns.some(t => t.answer.saved === false)) { $('historyFeedback').textContent = ''; $('historyFeedback').classList.remove('error'); }
    $('semanticQuery').value = ''; resizeQuery();
  } catch (error) {
    if(receivedBlocks){
      const rejected=['RAG_INVALID_RESPONSE','RAG_OUTPUT_TRUNCATED','RAG_OUTPUT_TOO_LARGE'].includes(error.code);
      $('streamingStatus').textContent=rejected?'Respuesta incompleta · la generación fue rechazada y los bloques no se guardaron.':'Respuesta incompleta · guardado sin confirmar. Revisá el historial antes de repetirla.';
      $('streamingStatus').classList.add('error');$('streamingBlocks').setAttribute('aria-busy','false');
    }else clearStreaming();
    $('searchFeedback').textContent = error.name === 'AbortError' ? 'Respuesta cancelada. Las llamadas ya enviadas pueden generar un cargo; no se reintentó automáticamente.' : error.name === 'TimeoutError' ? 'La respuesta tardó demasiado. No se reintentó automáticamente.' : error.message;
    $('searchFeedback').classList.add('error');
  }
  finally {
    answerController = null; $('cancelAnswer').hidden = true; $('semanticSearchForm').setAttribute('aria-busy','false'); lockSources(false);
    if (restoreQueryFocus && !document.querySelector('dialog[open]')) $('semanticQuery').focus({preventScroll:true});
  }
});
