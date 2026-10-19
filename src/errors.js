export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status
    : error.type === 'entity.parse.failed' ? 400
    : error.type === 'entity.too.large' ? 413 : 500;
  const message = error instanceof HttpError ? error.message
    : status === 400 ? 'JSON inválido.'
    : status === 413 ? 'La petición supera el tamaño permitido.'
    : 'No se pudo completar la operación. Intentá nuevamente.';
  const code = error.code && error instanceof HttpError ? error.code : 'REQUEST_FAILED';
  const reason=error instanceof HttpError && error.code==='RAG_INVALID_RESPONSE' && /^[A-Z_]{3,48}$/.test(error.reason||'')?error.reason:undefined;
  if (status >= 500 || status === 429) console.error(`Error ${status} [${code}]${reason?' ['+reason+']':''} en ${req.method} ${req.path}`);
  if (error instanceof HttpError && error.retryAfter) res.set('Retry-After',String(error.retryAfter));
  res.status(status).type('application/json').json({ error: message, code,...(reason?{reason}:{}) });
}
