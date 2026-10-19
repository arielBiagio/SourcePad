import { Worker } from 'node:worker_threads';
import { ProcessingError, LIMITS } from './extract.js';

// Aísla el parser del event loop; límite V8 + tiempo real. No es una sandbox de SO.
export function runExtraction(bytes, extension, { timeoutMs = 25000, workerURL = new URL('./worker.js', import.meta.url) } = {}) {
  if (!bytes?.byteLength || bytes.byteLength > LIMITS.bytes) return Promise.reject(new ProcessingError('LIMIT_EXCEEDED'));
  return new Promise((resolve, reject) => {
    const data = Uint8Array.from(bytes);
    const worker = new Worker(workerURL, {
      workerData: { bytes: data, extension }, transferList: [data.buffer],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
      stdout: true, stderr: true,
    });
    // El parser no escribe contenido del documento en los logs de la aplicación.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      worker.terminate().then(() => error ? reject(error) : resolve(result), () => reject(new ProcessingError('PROCESSING_FAILED')));
    };
    const timer = setTimeout(() => finish(new ProcessingError('TIMEOUT')), timeoutMs);
    worker.once('message', message => finish(message.error ? new ProcessingError(message.error) : null, message.result));
    worker.once('error', () => finish(new ProcessingError('PROCESSING_FAILED')));
    worker.once('exit', () => { if (!settled) finish(new ProcessingError('PROCESSING_FAILED')); });
  });
}
