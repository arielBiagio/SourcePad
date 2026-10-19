// Sólo se dibuja el documento: no se ejecutan acciones ni scripts del PDF.
export function createPdfPreview(blob, host, {signal, onError} = {}) {
  let loading, document, renderTask, observer, destroyed = false, pageNumber = 1, zoom = 1, revision = 0;
  const toolbar = window.document.createElement('div');
  toolbar.className = 'pdf-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Controles del PDF');
  const button = (label, text, action) => {
    const el = window.document.createElement('button');
    el.type = 'button'; el.className = 'quiet'; el.textContent = text; el.setAttribute('aria-label', label);
    el.addEventListener('click', action); toolbar.append(el); return el;
  };
  const previous = button('Página anterior', '←', () => { pageNumber--; void render(); });
  const label = window.document.createElement('span'); label.setAttribute('role', 'status'); toolbar.append(label);
  const next = button('Página siguiente', '→', () => { pageNumber++; void render(); });
  const smaller = button('Alejar PDF', '−', () => { zoom = Math.max(.5, zoom - .25); void render(); });
  const larger = button('Acercar PDF', '+', () => { zoom = Math.min(3, zoom + .25); void render(); });
  const stage = window.document.createElement('div'); stage.className = 'pdf-stage';
  const canvas = window.document.createElement('canvas'); canvas.setAttribute('role', 'img'); stage.append(canvas);
  host.replaceChildren(toolbar, stage); host.classList.add('pdf-preview');
  function controls(busy) {
    previous.disabled = busy || pageNumber <= 1; next.disabled = busy || pageNumber >= (document?.numPages || 1);
    smaller.disabled = busy || zoom <= .5; larger.disabled = busy || zoom >= 3;
  }
  controls(true);
  async function render() {
    if (destroyed || !document) return;
    const version = ++revision;
    const previousTask = renderTask;
    previousTask?.cancel(); controls(true);
    try {
      await previousTask?.promise.catch(() => {});
      if (destroyed || version !== revision) return;
      const page = await document.getPage(pageNumber);
      if (destroyed || version !== revision) return;
      const natural = page.getViewport({scale: 1});
      const scale = Math.max(1, stage.clientWidth - 32) / natural.width * zoom;
      const viewport = page.getViewport({scale});
      // Limita la memoria de rasterizado incluso con páginas o pantallas enormes.
      const density = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
      canvas.setAttribute('aria-label', 'Página ' + pageNumber + ' de ' + document.numPages);
      label.textContent = pageNumber + ' / ' + document.numPages;
      renderTask = page.render({canvasContext: canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0]});
      await renderTask.promise;
      if (!destroyed && version === revision) stage.scrollTo(0, 0);
    } catch (error) {
      if (!destroyed && version === revision && error.name !== 'RenderingCancelledException') onError?.('No se pudo mostrar esta página del PDF. Podés descargar el original.');
    } finally { if (!destroyed && version === revision) controls(false); }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; revision++; observer?.disconnect(); renderTask?.cancel();
    void loading?.destroy().catch(() => {});
    signal?.removeEventListener('abort', destroy); host.classList.remove('pdf-preview');
  }
  signal?.addEventListener('abort', destroy, {once: true});
  if (signal?.aborted) destroy();
  const ready = (async () => {
    const pdf = await import('/assets/pdf.mjs');
    if (destroyed) return;
    pdf.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.mjs';
    const data = new Uint8Array(await blob.arrayBuffer());
    if (destroyed) return;
    loading = pdf.getDocument({data, useWasm: false, useSystemFonts: true});
    document = await loading.promise;
    if (destroyed) return;
    await render();
    let width = stage.clientWidth;
    observer = new ResizeObserver(() => {
      if (stage.clientWidth === width) return;
      width = stage.clientWidth; void render();
    });
    if (!destroyed) observer.observe(stage);
  })();
  return {ready, destroy};
}
