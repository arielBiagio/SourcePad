export const PROCESSING_VERSION = 'text-v1-char1200-overlap180';
export const LIMITS = Object.freeze({ bytes: 10485760, pages: 200, characters: 1000000, chunks: 1500, chunkSize: 1200, overlap: 180 });

export class ProcessingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function normalizeText(text) {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[^\S\n]+/gu, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Offsets en puntos de código Unicode, base cero y fin exclusivo, sobre el texto
// normalizado de CADA página (o del archivo completo en TXT/MD). Nunca cruza páginas.
export function chunkPages(pages) {
  let total = 0;
  const chunks = [];
  for (const { page_number, text } of pages) {
    const chars = Array.from(normalizeText(text));
    total += chars.length;
    if (total > LIMITS.characters) throw new ProcessingError('LIMIT_EXCEEDED');
    for (let start = 0; start < chars.length;) {
      let end = Math.min(start + LIMITS.chunkSize, chars.length);
      if (end < chars.length) {
        // Preferir párrafo/salto/espacio en la segunda mitad, sin perder contenido.
        for (const separator of ['\n', ' ']) {
          let boundary = end;
          while (boundary > start + LIMITS.chunkSize / 2 && chars[boundary - 1] !== separator) boundary--;
          if (boundary > start + LIMITS.chunkSize / 2) { end = boundary; break; }
        }
      }
      const content = chars.slice(start, end).join('');
      if (content.trim()) chunks.push({ position: chunks.length, page_number, content, char_start: start, char_end: end });
      if (chunks.length > LIMITS.chunks) throw new ProcessingError('LIMIT_EXCEEDED');
      if (end === chars.length) break;
      start = end - LIMITS.overlap;
    }
  }
  if (!chunks.length) throw new ProcessingError('NO_TEXT');
  return chunks;
}

export async function extractDocument(bytes, extension) {
  if (!bytes?.byteLength || bytes.byteLength > LIMITS.bytes) throw new ProcessingError('LIMIT_EXCEEDED');
  if (['txt', 'md'].includes(extension)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ProcessingError('INVALID_FILE'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new ProcessingError('INVALID_FILE');
    return { page_count: null, chunks: chunkPages([{ page_number: null, text }]), version: PROCESSING_VERSION };
  }
  if (extension !== 'pdf') throw new ProcessingError('INVALID_FILE');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { fileURLToPath } = await import('node:url');
  const assets = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: Uint8Array.from(bytes), verbosity: 0,
    useWorkerFetch: false, useSystemFonts: false, disableFontFace: true,
    enableXfa: false, stopAtErrors: true, useWasm: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    cMapUrl: fileURLToPath(new URL('cmaps/', assets)).replaceAll('\\', '/'), cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', assets)).replaceAll('\\', '/'),
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > LIMITS.pages) throw new ProcessingError('LIMIT_EXCEEDED');
    const pages = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent().getReader();
      const parts = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const piece = item.str + (item.hasEOL ? '\n' : ' ');
            // Cota conservadora antes de acumular y normalizar el texto.
            characters += piece.length;
            if (characters > LIMITS.characters) throw new ProcessingError('LIMIT_EXCEEDED');
            parts.push(piece);
          }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      pages.push({ page_number: number, text: parts.join('') });
    }
    return { page_count: pdf.numPages, chunks: chunkPages(pages), version: PROCESSING_VERSION };
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError(error.name === 'PasswordException' ? 'PDF_PASSWORD' : 'INVALID_FILE');
  } finally { await task.destroy(); }
}
