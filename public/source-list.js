export function createSourceList({$,getSources,isConfigured,expandedSources,openSource,processSource,showSourceText,downloadSource,onIndex,onRemove}) {
  const statusLabels = {
    uploading: 'Subida interrumpida o en curso',
    uploaded: 'Pendiente de procesamiento',
    processing: 'Procesando',
    extracted: 'Texto extraído',
    ready: 'Indexado para búsqueda',
    error: 'Error de subida',
    deleting: 'Eliminación pendiente',
  };
  function renderSources() {
    const sources=getSources(),embeddingsConfigured=isConfigured();
    $('sourceCount').textContent = String(sources.length);
    $('noSources').hidden = sources.length !== 0;
    $('sourceList').replaceChildren();
    for (const source of sources) {
      const row = document.createElement('li'); row.className = 'source-row';
      const extension = document.createElement('span'); extension.className = 'source-extension mono'; extension.textContent = source.extension.toUpperCase();
      const info = document.createElement('div'); info.className = 'source-info';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'source-open'; name.textContent = source.filename;
      name.setAttribute('aria-label','Abrir fuente ' + source.filename); name.addEventListener('click',() => openSource(source));
      const details = document.createElement('details'); details.className = 'source-details'; details.open = expandedSources.has(source.id);
      const summary = document.createElement('summary'); summary.textContent = 'Detalles y opciones'; details.append(summary);
      details.addEventListener('toggle',() => { if (details.open) expandedSources.add(source.id); else expandedSources.delete(source.id); });
      const meta = document.createElement('p'); meta.className = 'source-meta';
      const status = document.createElement('span'); status.className = 'source-status' + (['error', 'deleting'].includes(source.status) ? ' error' : '');
      status.textContent = source.status === 'error' && source.processing_version ? 'Error de procesamiento' : statusLabels[source.status] || 'Estado pendiente';
      meta.append(status, document.createTextNode(' · ' + Math.max(1, Math.round(source.byte_size / 1024)) + ' KiB'));
      if (source.chunk_count) meta.append(document.createTextNode(' · ' + source.chunk_count + ' fragmento(s)' + (source.page_count ? ' · ' + source.page_count + ' página(s)' : '')));
      if (source.index_status && !['not_indexed','indexed'].includes(source.index_status)) {
        meta.append(document.createTextNode(' · Índice: ' + (source.indexed_chunk_count || 0) + '/' + source.chunk_count + (source.index_status === 'error' ? ' · Interrumpido' : '')));
      }
      info.append(name, details); details.append(meta);
      if (source.empty_page_count) {
        const warning = document.createElement('p'); warning.className = 'source-warning';
        warning.textContent = source.empty_page_count + ' página(s) sin texto seleccionable. No se aplicó OCR.'; details.append(warning);
      }
      if (source.error_message) {
        const error = document.createElement('p'); error.className = 'source-error'; error.textContent = source.error_message; details.append(error);
      }
      if (source.embedding_error) {
        const error = document.createElement('p'); error.className = 'source-error'; error.textContent = source.embedding_error; details.append(error);
      }
      const actions = document.createElement('div'); actions.className = 'source-actions';
      if (['uploaded', 'processing'].includes(source.status) || (source.status === 'error' && source.processing_version)) {
        const process = document.createElement('button'); process.type = 'button'; process.className = 'primary';
        process.textContent = source.status === 'uploaded' ? 'Procesar' : 'Reintentar';
        process.setAttribute('aria-label', 'Procesar ' + source.filename);
        process.addEventListener('click', () => processSource(source)); actions.append(process);
      }
      if (['extracted', 'ready'].includes(source.status)) {
        const view = document.createElement('button'); view.type = 'button'; view.className = 'primary'; view.textContent = 'Ver texto';
        view.setAttribute('aria-label', 'Ver texto de ' + source.filename);
        view.addEventListener('click', () => showSourceText(source)); actions.append(view);
        if (source.index_status !== 'indexed') {
          const index = document.createElement('button'); index.type = 'button'; index.className = 'primary';
          index.textContent = source.indexed_chunk_count ? 'Continuar índice' : 'Indexar';
          index.setAttribute('aria-label', 'Indexar ' + source.filename); index.dataset.needsEmbeddings = 'true';
          index.disabled = !embeddingsConfigured; index.title = embeddingsConfigured ? 'Envía texto a OpenRouter y consume saldo.' : 'Falta configurar OpenRouter.';
          index.addEventListener('click',()=>onIndex(source)); actions.append(index);
        }
      }
      if (!['uploading', 'deleting', 'error'].includes(source.status)) {
        const download = document.createElement('button'); download.type = 'button'; download.className = 'quiet'; download.textContent = 'Descargar';
        download.setAttribute('aria-label', 'Descargar ' + source.filename);
        download.addEventListener('click', () => downloadSource(source)); actions.append(download);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'source-remove';
      remove.textContent = '×'; remove.title = 'Quitar fuente';
      remove.setAttribute('aria-label', 'Eliminar ' + source.filename);
      remove.addEventListener('click',()=>onRemove(source));
      details.append(actions); row.append(extension, info, remove); $('sourceList').append(row);
    }
  }

  return {renderSources};
}
