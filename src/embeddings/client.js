import OpenAI from 'openai';
import { HttpError } from '../errors.js';
import { openRouterFailure } from '../openrouter-errors.js';

export const EMBEDDING_MODEL = 'baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_PROFILE = 'baai/bge-m3:dense:1024:cosine:v1';
export const EMBEDDING_BATCH_SIZE = 32;
// Identificadores observados para la misma solicitud fija baai/bge-m3.
const RESPONSE_MODEL_IDS = new Set([EMBEDDING_MODEL, 'parasail-bge-m3']);

export function normalizedVector(value) {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new HttpError(502, 'El proveedor devolvió un vector inválido.', 'INVALID_EMBEDDING');
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new HttpError(502, 'El proveedor devolvió un vector vacío.', 'INVALID_EMBEDDING');
  return value.map(n => n / norm);
}

// Mismo modelo, dimensiones y tratamiento para consultas y documentos. Sin prefijos
// ni parámetro dimensions: BGE-M3 usa sus 1024 dimensiones nativas (no Matryoshka).
export function createEmbedder(config, { transport } = {}) {
  let client;
  return async (texts, signal) => {
    if (!config.openRouterKey) throw new HttpError(503, 'Falta OPENROUTER_API_KEY para indexar o buscar.', 'EMBEDDINGS_NOT_CONFIGURED');
    if (!Array.isArray(texts) || !texts.length || texts.length > EMBEDDING_BATCH_SIZE
      || !texts.every(t => typeof t === 'string' && t.trim() && Array.from(t).length <= 1200)) {
      throw new HttpError(400, 'Lote de embeddings inválido.');
    }
    client ||= transport || new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.openRouterKey, timeout: 30000, maxRetries: 0 });
    let response;
    try {
      response = await client.embeddings.create({
        model: EMBEDDING_MODEL, input: texts, encoding_format: 'float',
        provider: { data_collection: 'deny', require_parameters: true },
      }, { signal });
    } catch (error) {
      throw openRouterFailure(error,'EMBEDDINGS');
    }
    if (response?.error) throw openRouterFailure(response.error,'EMBEDDINGS');
    // DeepInfra devuelve BAAI/bge-m3 y Parasail parasail-bge-m3. Sólo estos alias
    // conocidos; nunca se acepta un modelo arbitrario por tener 1024 dimensiones.
    const returnedModel = typeof response?.model === 'string' ? response.model.trim().toLowerCase() : '';
    if (!RESPONSE_MODEL_IDS.has(returnedModel)) {
      throw new HttpError(502, 'OpenRouter devolvió un modelo no reconocido para BGE-M3. No se guardó este lote.', 'INVALID_EMBEDDING');
    }
    if (!Array.isArray(response.data)) {
      throw new HttpError(502, 'OpenRouter devolvió un lote de embeddings inválido. No se guardó este lote.', 'INVALID_EMBEDDING');
    }
    if (response.data.length !== texts.length) {
      throw new HttpError(502, `OpenRouter devolvió ${response.data.length} vectores para ${texts.length} textos. No se guardó este lote.`, 'INVALID_EMBEDDING');
    }
    const vectors = new Array(texts.length);
    for (const item of response.data) {
      if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index]) {
        throw new HttpError(502, 'El proveedor devolvió índices de embeddings inválidos.', 'INVALID_EMBEDDING');
      }
      vectors[item.index] = normalizedVector(item.embedding);
    }
    return vectors;
  };
}
