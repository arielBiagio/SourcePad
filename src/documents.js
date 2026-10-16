import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { HttpError, asyncRoute } from './errors.js';

const bucket = 'notebook-sources';
const fields = 'id,notebook_id,filename,extension,mime_type,byte_size,status,error_message,created_at,deleted_at,page_count,empty_page_count,chunk_count,processed_at,processing_version,index_status,indexed_chunk_count,embedding_profile,embedded_at,embedding_error';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const types = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown' };
export const safeDocument = row => Object.fromEntries(fields.split(',').map(field => [field, row[field]]));

export function checkDocumentError(error) {
  if (!error) return;
  if (error.code === 'P0002') throw new HttpError(404, 'Fuente no encontrada.');
  if (error.code === '55000') throw new HttpError(409, 'La operación no pudo completarse en el estado actual. Actualizá e intentá nuevamente.');
  throw new HttpError(503, 'No se pudo acceder a las fuentes. Verificá la conexión y las migraciones de Supabase.', 'DOCUMENT_SERVICE_UNAVAILABLE');
}
const check = checkDocumentError;

export function validateFile(file) {
  if (!file?.buffer?.length) throw new HttpError(400, 'Elegí un archivo que no esté vacío.');
  const filename = file.originalname.normalize('NFC');
  if (filename.length > 180 || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new HttpError(400, 'El nombre del archivo no es válido.');
  const extension = filename.split('.').at(-1).toLowerCase();
  if (!types[extension]) throw new HttpError(415, 'Sólo se admiten PDF, TXT y Markdown (.md).');
  if (extension === 'pdf') {
    if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) || !file.buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) {
      throw new HttpError(415, 'El archivo no parece ser un PDF válido.');
    }
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); }
    catch { throw new HttpError(415, 'Los archivos TXT y Markdown deben usar UTF-8.'); }
    if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new HttpError(415, 'El archivo debe contener texto UTF-8 legible.');
  }
  // El MIME declarado por el navegador no se utiliza como prueba de formato.
  return { filename, extension, mime_type: types[extension], byte_size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') };
}

export function createDocumentRepository(getClient) {
  function client(req, res) { return getClient(req, res); }
  async function find(req, res, includeDeleted = false) {
    const { data, error } = await client(req, res).from('documents').select('*')
      .eq('id', req.params.documentId).eq('notebook_id', req.params.notebookId).eq('owner_id', req.user.id).maybeSingle();
    check(error);
    if (!data || (!includeDeleted && data.status === 'deleted')) throw new HttpError(404, 'Fuente no encontrada.');
    return data;
  }
  async function transition(req, res, name, id) {
    const { error } = await client(req, res).rpc(name, { document_id: id });
    check(error);
  }
  return {
    async assertNotebook(req, res) {
      const { data, error } = await client(req, res).from('notebooks').select('id')
        .eq('id', req.params.notebookId).eq('owner_id', req.user.id).maybeSingle();
      check(error);
      if (!data) throw new HttpError(404, 'Cuaderno no encontrado.');
    },
    async list(req, res) {
      const { data, error } = await client(req, res).from('documents').select(fields)
        .eq('notebook_id', req.params.notebookId).eq('owner_id', req.user.id).neq('status', 'deleted')
        .order('created_at', { ascending: false }).order('id').limit(201);
      check(error);
      return { documents: data.slice(0, 200).map(safeDocument), hasMore: data.length > 200 };
    },
    async upload(req, res, file) {
      const input = validateFile(file);
      const id = randomUUID();
      const { data, error } = await client(req, res).from('documents').insert({
        ...input, id, notebook_id: req.params.notebookId, owner_id: req.user.id,
      }).select('*').single();
      check(error);
      try {
        const { error: storageError } = await client(req, res).storage.from(bucket).upload(data.object_path, file.buffer, {
          contentType: input.mime_type, upsert: false,
        });
        check(storageError);
        await transition(req, res, 'complete_document_upload', id);
      } catch (error) {
        // Se conserva la fila para poder eliminar un posible archivo parcial y reintentar.
        await client(req, res).rpc('fail_document_upload', { document_id: id }).then(() => {}, () => {});
        throw error;
      }
      return safeDocument({ ...data, status: 'uploaded' });
    },
    async download(req, res) {
      const document = await find(req, res);
      if (document.status === 'deleting') throw new HttpError(409, 'Esta fuente se está eliminando.');
      const { data, error } = await client(req, res).storage.from(bucket).download(document.object_path);
      check(error);
      return { document: safeDocument(document), bytes: Buffer.from(await data.arrayBuffer()) };
    },
    async remove(req, res) {
      const document = await find(req, res, true);
      if (document.status === 'deleted') return;
      await transition(req, res, 'begin_document_delete', document.id);
      const { error } = await client(req, res).storage.from(bucket).remove([document.object_path]);
      check(error);
      await transition(req, res, 'complete_document_delete', document.id);
    },
  };
}

export function mountDocuments(app, repository, config, rateLimitFactory = rateLimit) {
  const base = '/api/notebooks/:notebookId/documents';
  // Hereda la autenticación y el control de modo Supabase de /api/notebooks.
  app.use(base, asyncRoute(async (req, res, next) => { await repository.assertNotebook(req, res); next(); }));
  app.param('documentId', (req, res, next, id) => next(uuid.test(id) ? undefined : new HttpError(400, 'Identificador de fuente inválido.')));
  app.get(base, asyncRoute(async (req, res) => res.json(await repository.list(req, res))));
  const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1 } }).single('file');
  // Dos archivos como máximo en memoria por proceso; los demás reciben una respuesta reintentable.
  let uploads = 0;
  app.post(base, rateLimitFactory({
    windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Esperá un momento antes de subir más archivos.' },
  }), asyncRoute(async (req, res) => {
    if (uploads >= 2) throw new HttpError(429, 'Hay otras subidas en curso. Intentá nuevamente en unos segundos.');
    uploads++;
    try {
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      res.status(201).json({ document: await repository.upload(req, res, req.file) });
    } catch (error) {
      if (error instanceof multer.MulterError) {
        throw new HttpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
          error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño permitido.' : 'Subí un solo archivo usando el campo file.');
      }
      throw error;
    } finally { uploads--; }
  }));
  app.get(base + '/:documentId/download', asyncRoute(async (req, res) => {
    const { document, bytes } = await repository.download(req, res);
    const encodedName = encodeURIComponent(document.filename).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="source.${document.extension}"; filename*=UTF-8''${encodedName}`, 'Content-Security-Policy': "sandbox; default-src 'none'" });
    res.send(bytes);
  }));
  app.delete(base + '/:documentId', asyncRoute(async (req, res) => { await repository.remove(req, res); res.status(204).end(); }));
}
