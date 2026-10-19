import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './extract.js';

try {
  parentPort.postMessage({ result: await extractDocument(workerData.bytes, workerData.extension) });
} catch (error) {
  // No se devuelven detalles del parser, rutas, fragmentos privados ni stack traces.
  parentPort.postMessage({ error: error.code || 'PROCESSING_FAILED' });
} finally { parentPort.close(); }
