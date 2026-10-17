export function createSourceViewer({$,api,http,preview,previewFiles,getNotebook,isBusy,lockSources,sourceFeedback}) {
    let textSource=null,nextChunkOffset=null,viewerController=null,originalURL=null,viewerVersion=0;
    const originalBlob=(source,bookId,signal)=>preview ? Promise.resolve(previewFiles.get(source.id))
      : http.blob('/api/notebooks/'+bookId+'/documents/'+source.id+'/download',{signal});
  async function downloadSource(source) {
    if (isBusy()) return;
    lockSources(true);
    try {
      const blob = await originalBlob(source,getNotebook().id,AbortSignal.timeout(60000));
      if (!blob) throw new Error('El archivo ya no está disponible en esta vista.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = source.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { sourceFeedback(error.message, true); }
    finally { lockSources(false); }
  }

  function openSource(source) {
    if (isBusy()) return;
    if (['extracted','ready'].includes(source.status)) return showSourceText(source);
    closeSourceText(); textSource = source; $('sourceTextTitle').textContent = source.filename; $('sourceTextPanel').showModal(); showOriginalSource();
  }
  $('showOriginal').addEventListener('click',showOriginalSource);
  $('showExtracted').addEventListener('click',() => {
    if (!textSource) return;
    if (!['extracted','ready'].includes(textSource.status)) { $('sourceViewerFeedback').textContent = 'Procesá la fuente para ver el texto extraído.'; return; }
    showSourceText(textSource);
  });
  async function showOriginalSource() {
    if (!textSource || !getNotebook()) return;
    viewerController?.abort(); viewerController = new AbortController();
    const version = ++viewerVersion; const source = textSource; const bookId = getNotebook().id;
    if (originalURL) URL.revokeObjectURL(originalURL); originalURL = null;
    $('sourceTextChunks').hidden = true; $('moreSourceText').hidden = true;
    $('originalPreview').hidden = false; $('originalPreview').replaceChildren(); $('sourceViewerFeedback').textContent = 'Abriendo original privado…';
    try {
      const blob = await originalBlob(source,bookId,AbortSignal.any([viewerController.signal,AbortSignal.timeout(60000)]));
      if (!blob) throw new Error('El archivo ya no está disponible en esta vista.');
      if (version !== viewerVersion || getNotebook()?.id !== bookId) return;
      if (source.extension === 'pdf') {
        originalURL = URL.createObjectURL(new Blob([blob],{ type: 'application/pdf' }));
        const frame = document.createElement('iframe'); frame.title = 'Vista previa de '+source.filename; frame.src = originalURL;
        $('originalPreview').append(frame);
      } else {
        const text = await blob.text(); if (version !== viewerVersion) return;
        const pre = document.createElement('pre'); pre.textContent = text.slice(0,100000); $('originalPreview').append(pre);
        if (text.length > 100000) $('sourceViewerFeedback').textContent = 'Vista previa limitada a 100.000 caracteres. Descargá el archivo para leerlo completo.';
      }
      if (version === viewerVersion && !$('sourceViewerFeedback').textContent.startsWith('Vista previa limitada')) $('sourceViewerFeedback').textContent = '';
    } catch (error) { if (version === viewerVersion && error.name !== 'AbortError') $('sourceViewerFeedback').textContent = error.message; }
  }


  function closeSourceText() {
    viewerVersion++; viewerController?.abort(); viewerController = null;
    if (originalURL) URL.revokeObjectURL(originalURL); originalURL = null;
    $('sourceTextPanel').close(); $('sourceTextChunks').replaceChildren(); $('originalPreview').replaceChildren();
    $('moreSourceText').hidden = true; textSource = null; nextChunkOffset = null;
    $('citationQuote').hidden = true; $('citationQuote').textContent = '';
    $('citationMeta').hidden = true; $('citationMeta').textContent = '';
    document.querySelector('.viewer-tabs').hidden = false;
    $('viewerNote').textContent = 'El texto extraído conserva la página original; tablas y columnas pueden requerir revisión.';
  }
  $('closeSourceText').addEventListener('click', closeSourceText);
  $('moreSourceText').addEventListener('click', () => showSourceText(textSource, true));
  async function showSourceText(source, append = false) {
    if (isBusy() || !source) return;
    const offset = append ? nextChunkOffset : 0;
    if (offset === null) return;
    if (!append) { closeSourceText(); $('sourceTextPanel').showModal(); }
    textSource = source; $('originalPreview').hidden = true; $('sourceTextChunks').hidden = false;
    const version = viewerVersion; const notebookId = getNotebook().id;
    $('sourceTextTitle').textContent = source.filename;
    $('sourceViewerFeedback').textContent = 'Cargando texto…'; $('moreSourceText').disabled = true;
    try {
      const result = await api('/api/notebooks/' + getNotebook().id + '/documents/' + source.id + '/chunks?offset=' + offset);
      if (version !== viewerVersion || getNotebook()?.id !== notebookId) return;
      for (const chunk of result.chunks) {
        const article = document.createElement('article'); article.className = 'text-chunk';
        const heading = document.createElement('h4');
        heading.textContent = (chunk.page_number ? 'Página ' + chunk.page_number + ' · ' : '') + 'Fragmento ' + (chunk.position + 1);
        const text = document.createElement('pre'); text.textContent = chunk.content;
        article.append(heading, text); $('sourceTextChunks').append(article);
      }
      nextChunkOffset = result.nextOffset;
      $('moreSourceText').hidden = nextChunkOffset === null;
      $('sourceViewerFeedback').textContent = '';
      if (!append) {
        $('sourceTextTitle').tabIndex = -1; $('sourceTextTitle').focus({ preventScroll: true });
      }
    } catch (error) { if (version === viewerVersion) $('sourceViewerFeedback').textContent = error.message; }
    finally { if (version === viewerVersion) $('moreSourceText').disabled = false; }
  }


  return {downloadSource,openSource,showSourceText,closeSourceText};
}
