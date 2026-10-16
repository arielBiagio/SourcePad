import { createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { safeDocument, checkDocumentError as check } from '../documents.js';
import { HttpError, asyncRoute } from '../errors.js';
import { runExtraction } from './runner.js';
import { ProcessingError, LIMITS } from './extract.js';

const messages = {
  NO_TEXT: 'No se encontró texto seleccionable. Si es un escaneo, necesita OCR (todavía no disponible).',
  PDF_PASSWORD: 'El PDF está protegido con contraseña. Subí una copia sin protección.',
  INVALID_FILE: 'No se pudo leer el archivo. Revisá que no esté dañado y volvé a subirlo.',
  LIMIT_EXCEEDED: 'El documento supera los límites de procesamiento. Dividilo en archivos más pequeños.',
  TIMEOUT: 'El procesamiento tardó demasiado. Podés reintentarlo o dividir el archivo.',
  INTEGRITY: 'El original no coincide con la subida registrada. Eliminá la fuente y volvé a subirla.',
};

export function createProcessingRepository(getClient, extract = runExtraction) {
  async function find(req, res) {
    const { data, error } = await getClient(req, res).from('documents').select('*')
      .eq('id', req.params.documentId).eq('notebook_id', req.params.notebookId).eq('owner_id', req.user.id).maybeSingle();
    check(error);
    if (!data || ['deleted', 'deleting'].includes(data.status)) throw new HttpError(404, 'Fuente no encontrada.');
    return data;
  }
  return {
    async process(req, res) {
      const document = await find(req, res);
      if (['extracted', 'ready'].includes(document.status)) return safeDocument(document);
      const client = getClient(req, res);
      const { data: job, error } = await client.rpc('begin_document_processing', { document_id: document.id });
      check(error);
      try {
        const { data, error: downloadError } = await client.storage.from('notebook-sources').download(document.object_path);
        check(downloadError);
        if (data.size > LIMITS.bytes || data.size !== document.byte_size) throw new ProcessingError('INTEGRITY');
        const bytes = Buffer.from(await data.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new ProcessingError('INTEGRITY');
        const result = await extract(bytes, document.extension);
        const { error: completionError } = await client.rpc('complete_document_processing', {
          document_id: document.id, processing_run: job.run_id, page_total: result.page_count, chunks: result.chunks,
        });
        check(completionError);
        return safeDocument(await find(req, res));
      } catch (error) {
        await client.rpc('fail_document_processing', {
          document_id: document.id, processing_run: job.run_id, failure_code: error instanceof ProcessingError ? error.code : 'PROCESSING_FAILED',
        }).then(() => {}, () => {});
        if (error instanceof ProcessingError) throw new HttpError(error.code === 'TIMEOUT' ? 504 : 422, messages[error.code] || 'No se pudo procesar el documento. Intentá nuevamente.', error.code);
        throw error;
      }
    },
    async chunks(req, res) {
      const document = await find(req, res);
      if (!['extracted', 'ready'].includes(document.status)) throw new HttpError(409, 'El texto todavía no está disponible. Procesá el documento primero.');
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (!Number.isInteger(offset) || offset < 0 || offset >= LIMITS.chunks) throw new HttpError(400, 'Posición de fragmento inválida.');
      const { data, error } = await getClient(req, res).from('document_chunks')
        .select('position,page_number,content,char_start,char_end,version')
        .eq('document_id', document.id).eq('notebook_id', req.params.notebookId).eq('owner_id', req.user.id)
        .order('position').range(offset, offset + 19);
      check(error);
      return { document: safeDocument(document), chunks: data, nextOffset: offset + data.length < document.chunk_count ? offset + data.length : null };
    },
  };
}

export function mountDocumentProcessing(app, repository, rateLimitFactory = rateLimit) {
  const base = '/api/notebooks/:notebookId/documents/:documentId';
  let running = 0;
  app.post(base + '/process', rateLimitFactory({
    windowMs: 600000, limit: 10, keyGenerator: req => req.user.id,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Esperá unos minutos antes de procesar más documentos.' },
  }), asyncRoute(async (req, res) => {
    if (running) throw new HttpError(429, 'Hay un documento procesándose. Intentá nuevamente en unos segundos.');
    running++;
    try { res.json({ document: await repository.process(req, res) }); }
    finally { running--; }
  }));
  app.get(base + '/chunks', asyncRoute(async (req, res) => res.json(await repository.chunks(req, res))));
}
