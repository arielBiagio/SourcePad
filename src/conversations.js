import { HttpError,asyncRoute } from './errors.js';

const fields = 'id,question,answer,created_at';
const unavailable = () => new HttpError(503,'No se pudo consultar el historial. Verificá la conexión y la migración 005 de conversaciones.','HISTORY_UNAVAILABLE');

export function createConversationRepository(getClient) {
  async function clientFor(req,res) {
    const client = getClient(req,res);
    const { data,error } = await client.from('notebooks').select('id').eq('id',req.params.notebookId).eq('owner_id',req.user.id).maybeSingle();
    if (error) throw unavailable();
    if (!data) throw new HttpError(404,'Cuaderno no encontrado.');
    return client;
  }
  return {
    async list(req,res) {
      const client = await clientFor(req,res);
      const { data,error } = await client.from('notebook_turns').select(fields).eq('notebook_id',req.params.notebookId).eq('owner_id',req.user.id)
        .order('created_at',{ ascending: false }).order('id',{ ascending: false }).limit(31);
      if (error) throw unavailable();
      return { turns: data.slice(0,30).reverse(),hasMore: data.length > 30 };
    },
    async save(req,res,answer) {
      const client = await clientFor(req,res);
      const { data,error } = await client.from('notebook_turns').insert({
        notebook_id: req.params.notebookId,owner_id: req.user.id,question: req.body.query.trim(),answer,
      }).select(fields).single();
      if (error) throw unavailable();
      return data;
    },
    async clear(req,res) {
      const client = await clientFor(req,res);
      const { error } = await client.from('notebook_turns').delete().eq('notebook_id',req.params.notebookId).eq('owner_id',req.user.id);
      if (error) throw unavailable();
    },
  };
}

export function mountConversations(app,repository) {
  app.get('/api/notebooks/:notebookId/conversation',asyncRoute(async (req,res) => res.json(await repository.list(req,res))));
  app.delete('/api/notebooks/:notebookId/conversation',asyncRoute(async (req,res) => {
    if (req.body?.confirm !== true) throw new HttpError(400,'Confirmá el borrado de la conversación.');
    await repository.clear(req,res); res.sendStatus(204);
  }));
}

export function withConversationHistory(rag,history) {
  return {
    async answer(req,res,signal,onBlock) {
      const result = await rag.answer(req,res,signal,onBlock);
      signal?.throwIfAborted();
      try {
        const turn = await history.save(req,res,result);
        signal?.throwIfAborted();
        return { ...result,saved: true,turnId: turn.id,createdAt: turn.created_at };
      } catch {
        signal?.throwIfAborted();
        // No se transforma un fallo posterior al cobro en una invitación a regenerar.
        return { ...result,saved: false,historyWarning: 'La respuesta se generó, pero no se guardó. No la regeneres para intentar guardarla: revisá la conexión o aplicá la migración 005.' };
      }
    },
  };
}
