import {HttpError} from './errors.js';

export function checkDocumentError(error) {
  if (!error) return;
  if (error.code === 'P0002') throw new HttpError(404, 'Fuente no encontrada.');
  if (error.code === '55000') throw new HttpError(409, 'La operación no pudo completarse en el estado actual. Actualizá e intentá nuevamente.');
  throw new HttpError(503, 'No se pudo acceder a las fuentes. Verificá la conexión y las migraciones de Supabase.', 'DOCUMENT_SERVICE_UNAVAILABLE');
}

export async function findDocument(client,req,{hiddenStatuses=['deleted','deleting']}={}) {
  const {data,error}=await client.from('documents').select('*')
    .eq('id',req.params.documentId).eq('notebook_id',req.params.notebookId).eq('owner_id',req.user.id).maybeSingle();
  checkDocumentError(error);
  if(!data||hiddenStatuses.includes(data.status))throw new HttpError(404,'Fuente no encontrada.');
  return data;
}
