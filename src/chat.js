import OpenAI from 'openai';
import { HttpError } from './errors.js';
import { openRouterFailure } from './openrouter-errors.js';

export function createChatStream(config, { transport } = {}) {
  let client;
  return async (messages, signal, { grounded = false } = {}) => {
    if (!config.openRouterKey) throw new HttpError(503, 'Falta configurar OpenRouter para usar el chat.', 'CHAT_NOT_CONFIGURED');
    client ||= transport || new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.openRouterKey, timeout: 60000, maxRetries: 0 });
    try {
      const pending = client.chat.completions.create({
        model: config.chatModel, messages, stream: true, max_tokens: 2048,
        ...(grounded ? {
          response_format: { type: 'json_object' }, reasoning: { enabled: false },
          provider: { data_collection: 'deny', require_parameters: true },
        } : {}),
      }, { signal });
      const { data: stream,response } = await pending.withResponse();
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const body = await response.json().catch(() => null);
        if (body?.error) throw openRouterFailure(body.error);
        throw new HttpError(502,'OpenRouter no devolvió un stream de texto válido.','CHAT_INVALID_RESPONSE');
      }
      return (async function* () {
        let hasText = false;
        try {
          for await (const chunk of stream) {
            if (chunk.error) throw openRouterFailure(chunk.error);
            const text = chunk.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length) hasText = true;
            yield chunk;
          }
          if (!hasText && !signal?.aborted) throw new HttpError(502,'El modelo terminó sin texto visible. Puede haber agotado el límite de salida en razonamiento. Revisá el modelo antes de reintentar.','CHAT_EMPTY_RESPONSE');
        } catch (error) { throw openRouterFailure(error); }
      })();
    } catch (error) {
      throw openRouterFailure(error);
    }
  };
}

export function validateHistory(body) {
  const history = body?.historial;
  if (!Array.isArray(history) || !history.length || history.length > 500) throw new HttpError(400, 'Historial inválido.');
  if (!history.every(item => item && ['user', 'assistant'].includes(item.role)
    && typeof item.content === 'string' && item.content.trim() && item.content.length <= 16000)) {
    throw new HttpError(400, 'Los mensajes deben contener texto y un rol válido.');
  }
  if (history.at(-1).role !== 'user') throw new HttpError(400, 'La conversación debe terminar con una pregunta.');
  return [{ role: 'system', content: 'Eres un asistente de IA integrado en una interfaz personalizada. Sé amigable y conciso.' }, ...history.slice(-6)];
}
