import { createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { HttpError, asyncRoute } from '../errors.js';
import { safeDocument, checkDocumentError as check } from '../documents.js';
import { createEmbedder, EMBEDDING_PROFILE, normalizedVector } from './client.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function searchInput(body) {
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !['query','sourceIds'].includes(k))
    || typeof body.query !== 'string' || !body.query.trim() || Array.from(body.query.trim()).length > 1000) throw new HttpError(400, 'Ingresá una consulta de entre 1 y 1000 caracteres.');
  if (body.sourceIds !== undefined && (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.length > 20
    || !body.sourceIds.every(id => typeof id === 'string' && uuid.test(id)) || new Set(body.sourceIds).size !== body.sourceIds.length)) throw new HttpError(400, 'Elegí entre 1 y 20 fuentes indexadas distintas.');
  return { query: body.query.trim(), sourceIds: body.sourceIds || null };
}
export function createEmbeddingRepository(getClient, config, embed = createEmbedder(config)) {
  function configured() {
    if (!config.openRouterKey) throw new HttpError(503, 'Falta OPENROUTER_API_KEY para indexar o buscar.', 'EMBEDDINGS_NOT_CONFIGURED');
  }
  async function find(req, res) {
    const { data, error } = await getClient(req, res).from('documents').select('*')
      .eq('id', req.params.documentId).eq('notebook_id', req.params.notebookId).eq('owner_id', req.user.id).maybeSingle();
    check(error);
    if (!data || ['deleting','deleted'].includes(data.status)) throw new HttpError(404, 'Fuente no encontrada.');
    return data;
  }
  return {
    async index(req, res) {
      if (!req.body || req.body.confirmExternalProcessing !== true || Object.keys(req.body).some(k => k !== 'confirmExternalProcessing')) {
        throw new HttpError(400, 'Confirmá el envío de texto a OpenRouter y el uso de saldo para indexar.');
      }
      const document = await find(req, res);
      if (document.status === 'ready' && document.index_status === 'indexed' && document.embedding_profile === EMBEDDING_PROFILE) return { document: safeDocument(document), complete: true };
      configured();
      const client = getClient(req, res);
      const { data: job, error } = await client.rpc('begin_document_indexing', { document_id: document.id });
      check(error);
      if (job.complete) return { document: safeDocument(await find(req, res)), complete: true };
      try {
        const texts = [...new Set(job.chunks.map(c => c.content))];
        const vectors = (await embed(texts)).map(normalizedVector);
        if (vectors.length !== texts.length) throw new HttpError(502, 'El proveedor devolvió un lote incompleto.', 'INVALID_EMBEDDING');
        const byText = new Map(texts.map((text, index) => [text, vectors[index]]));
        const items = job.chunks.map(chunk => {
          const hash = createHash('sha256').update(chunk.content).digest('hex');
          if (hash !== chunk.content_sha256) throw new HttpError(409, 'El texto cambió. Actualizá antes de indexar.');
          return { position: chunk.position, content_sha256: hash, embedding: byText.get(chunk.content) };
        });
        const { error: saveError } = await client.rpc('store_document_embeddings', { document_id: document.id, indexing_run: job.run_id, items });
        check(saveError);
        const updated = await find(req, res);
        return { document: safeDocument(updated), complete: updated.index_status === 'indexed' };
      } catch (error) {
        await client.rpc('fail_document_indexing', { document_id: document.id, indexing_run: job.run_id, failure_code: error.code || 'INDEXING_FAILED' }).then(() => {}, () => {});
        throw error;
      }
    },
    async search(req, res, { input = req.body, signal } = {}) {
      const { query, sourceIds } = searchInput(input);
      const client = getClient(req, res);
      // Se comprueban cuaderno/fuentes ANTES de cualquier petición con costo.
      const { data: count, error } = await client.rpc('notebook_indexed_source_count', { notebook_id: req.params.notebookId, source_ids: sourceIds });
      check(error);
      if (!count) return { matches: [], indexedSources: 0, profile: EMBEDDING_PROFILE };
      configured();
      const vectors = await embed([query], signal);
      if (vectors.length !== 1) throw new HttpError(502, 'El proveedor devolvió una consulta inválida.', 'INVALID_EMBEDDING');
      const { data, error: searchError } = await client.rpc('match_notebook_chunks', {
        notebook_id: req.params.notebookId, query_embedding: JSON.stringify(normalizedVector(vectors[0])), source_ids: sourceIds, match_limit: 5,
      });
      check(searchError);
      const fields = ['document_id','filename','position','page_number','content','char_start','char_end','similarity'];
      return { matches: data.map(row => Object.fromEntries(fields.map(key => [key,row[key]]))), indexedSources: count, profile: EMBEDDING_PROFILE };
    },
  };
}
export function mountEmbeddings(app, repository, rateLimitFactory = rateLimit) {
  let active = 0;
  const limit = rateLimitFactory({ windowMs: 600000, limit: 100, keyGenerator: req => req.user.id, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Esperá unos minutos antes de seguir indexando o buscando.' } });
  const bounded = handler => asyncRoute(async (req, res) => {
    if (active >= 2) throw new HttpError(429, 'Hay otras operaciones de embeddings en curso. Reintentá en unos segundos.');
    active++;
    try { res.json(await handler(req, res)); } finally { active--; }
  });
  app.post('/api/notebooks/:notebookId/documents/:documentId/index', limit, bounded(repository.index));
  app.post('/api/notebooks/:notebookId/search', limit, bounded(repository.search));
}
