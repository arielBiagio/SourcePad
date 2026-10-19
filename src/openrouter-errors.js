import { HttpError } from './errors.js';

// Nunca se devuelve message/metadata/raw del proveedor: pueden contener texto privado.
export function openRouterFailure(error, kind = 'CHAT') {
  if (error instanceof HttpError) return error;
  const upstream = error?.error && typeof error.error === 'object' ? error.error : error;
  const status = [error?.status,upstream?.code,error?.code].map(Number).find(n => Number.isInteger(n) && n >= 400 && n <= 599);
  let http = 502, code = 'UNAVAILABLE', message = 'OpenRouter no pudo completar la solicitud. Intentá más tarde.';
  if ([401,403].includes(status)) {
    http = 503; code = 'ACCESS'; message = 'OpenRouter rechazó la clave o sus permisos. Revisá la configuración del servidor.';
  } else if (status === 402) {
    http = 402; code = 'CREDITS'; message = 'OpenRouter rechazó la solicitud por saldo o límite de crédito. Revisá tu cuenta.';
  } else if (status === 429) {
    http = 429; code = 'RATE_LIMIT'; message = 'OpenRouter o el proveedor del modelo limitó las solicitudes (429). Esperá antes de reintentar; también podés elegir otro modelo.';
  } else if (status === 503 || /no endpoints|no available provider|data policy/i.test(String(upstream?.message || ''))) {
    http = 503; code = 'ROUTING'; message = 'No hay proveedores disponibles compatibles con el modelo y las políticas configuradas. No se relajaron esas políticas.';
  } else if (status === 404) {
    http = 503; code = 'MODEL_UNAVAILABLE'; message = 'OpenRouter no encontró un proveedor para el modelo solicitado. Revisá su disponibilidad.';
  } else if (status === 400 || status === 422) {
    http = 502; code = 'REQUEST_REJECTED'; message = 'OpenRouter rechazó los parámetros de la solicitud. Revisá el modelo y su configuración.';
  } else if ([408,504,524].includes(status) || /Timeout/.test(error?.name || '')) {
    http = 504; code = 'TIMEOUT'; message = 'OpenRouter tardó demasiado. Reintentá más tarde.';
  } else if (error?.name === 'APIConnectionError' || error?.cause?.code) {
    code = 'NETWORK'; message = 'No se pudo establecer la conexión con OpenRouter. Revisá la red y la conexión del servidor.';
  }
  const result = new HttpError(http,message,kind+'_'+code);
  const wait = Number(error?.headers?.get?.('retry-after'));
  if (Number.isInteger(wait) && wait > 0 && wait <= 86400) result.retryAfter = wait;
  return result;
}
