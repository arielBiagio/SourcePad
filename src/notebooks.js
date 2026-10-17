import { HttpError, asyncRoute } from './errors.js';
import {isUuid} from './validation.js';

const fields = 'id,title,description,created_at,updated_at';

function validateNotebook(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
    throw new HttpError(400, 'El título debe tener entre 1 y 120 caracteres.');
  }
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) {
    throw new HttpError(400, 'La descripción admite hasta 1000 caracteres.');
  }
  return { title: body.title.trim(), description: (body.description || '').trim() };
}

export function createNotebookRepository(getClient) {
  function check(error) {
    if (error) throw new HttpError(503, 'No se pudieron guardar o consultar los cuadernos. Verificá la conexión y la migración de Supabase.');
  }
  return {
    async list(req, res) {
      const { data, error } = await getClient(req, res).from('notebooks').select(fields)
        .eq('owner_id', req.user.id).order('updated_at', { ascending: false }).order('id').limit(201);
      check(error);
      return { notebooks: data.slice(0, 200), hasMore: data.length > 200 };
    },
    async create(req, res, input) {
      const { data, error } = await getClient(req, res).from('notebooks')
        .insert({ ...input, owner_id: req.user.id }).select(fields).single();
      check(error);
      return data;
    },
    async update(req, res, id, input) {
      const { data, error } = await getClient(req, res).from('notebooks').update(input)
        .eq('id', id).eq('owner_id', req.user.id).select(fields).maybeSingle();
      check(error);
      if (!data) throw new HttpError(404, 'Cuaderno no encontrado.');
      return data;
    },
    async remove(req, res, id) {
      const { error } = await getClient(req, res).rpc('delete_empty_notebook', { notebook_id: id });
      if (error?.code === 'P0002') throw new HttpError(404, 'Cuaderno no encontrado.');
      if (error?.code === '55000') throw new HttpError(409, 'Eliminá primero las fuentes del cuaderno.');
      check(error);
    },
  };
}

export function mountNotebooks(app, requireAuth, repository, enabled) {
  app.use('/api/notebooks', (req, res, next) => {
    if (!enabled) return next(new HttpError(503, 'Los cuadernos requieren conectar Supabase.', 'SETUP_REQUIRED'));
    next();
  }, requireAuth);
  app.get('/api/notebooks', asyncRoute(async (req, res) => res.json(await repository.list(req, res))));
  app.post('/api/notebooks', asyncRoute(async (req, res) => {
    res.status(201).json({ notebook: await repository.create(req, res, validateNotebook(req.body)) });
  }));
  app.param('notebookId', (req, res, next, id) => next(isUuid(id) ? undefined : new HttpError(400, 'Identificador inválido.')));
  app.patch('/api/notebooks/:notebookId', asyncRoute(async (req, res) => {
    res.json({ notebook: await repository.update(req, res, req.params.notebookId, validateNotebook(req.body)) });
  }));
  app.delete('/api/notebooks/:notebookId', asyncRoute(async (req, res) => {
    await repository.remove(req, res, req.params.notebookId);
    res.status(204).end();
  }));
}
