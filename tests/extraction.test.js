import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPages, extractDocument, normalizeText, LIMITS } from '../src/processing/extract.js';
import { runExtraction } from '../src/processing/runner.js';
import { pdfFixture } from './helpers/pdf-fixture.js';

test('normaliza texto y fragmenta con solapamiento sin perder caracteres ni mezclar páginas', () => {
  const text = ('Línea con emoji 📝 y palabras. '.repeat(130) + '\n\nFinal').normalize('NFD');
  const normalized = Array.from(normalizeText(text));
  const chunks = chunkPages([{ page_number: 1, text }, { page_number: 3, text: 'Otra página' }]);
  assert.ok(chunks.length > 3);
  let covered = 0;
  for (const chunk of chunks.filter(c => c.page_number === 1)) {
    assert.ok(chunk.char_start <= covered);
    assert.equal(chunk.content, normalized.slice(chunk.char_start, chunk.char_end).join(''));
    assert.ok(Array.from(chunk.content).length <= LIMITS.chunkSize);
    if (covered) assert.equal(covered - chunk.char_start, LIMITS.overlap);
    covered = chunk.char_end;
  }
  assert.equal(covered, normalized.length);
  assert.equal(chunks.at(-1).page_number, 3);
  assert.equal(chunks.at(-1).char_start, 0);
});

test('TXT/Markdown UTF-8 conservan contenido literal, sin páginas inventadas ni HTML ejecutado', async () => {
  const result = await runExtraction(Buffer.from('# Título\r\n<img onerror="alert(1)">\r\nTexto 📝'), 'md');
  assert.equal(result.page_count, null);
  assert.equal(result.chunks[0].page_number, null);
  assert.match(result.chunks[0].content, /<img onerror/);
  assert.match(result.chunks[0].content, /Texto 📝/);
});

test('PDF real: extracción por página, incluyendo páginas vacías sin renumerar', async () => {
  const result = await runExtraction(pdfFixture(['First page', '', 'Third page']), 'pdf');
  assert.equal(result.page_count, 3);
  assert.deepEqual(result.chunks.map(c => c.page_number), [1, 3]);
  assert.equal(result.chunks[0].content, 'First page');
  assert.equal(result.chunks[1].content, 'Third page');
});

test('errores de formato, PDF dañado, sin texto y límites no producen resultados parciales', async () => {
  await assert.rejects(runExtraction(pdfFixture(['']), 'pdf'), { code: 'NO_TEXT' });
  await assert.rejects(runExtraction(Buffer.from('%PDF-1.7\nbroken\n%%EOF'), 'pdf'), { code: 'INVALID_FILE' });
  await assert.rejects(extractDocument(Buffer.from([255, 0]), 'txt'), { code: 'INVALID_FILE' });
  await assert.rejects(extractDocument(Buffer.from('  '), 'md'), { code: 'NO_TEXT' });
  await assert.rejects(extractDocument(Buffer.from('a'.repeat(LIMITS.characters + 1)), 'txt'), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(runExtraction(pdfFixture(Array(201).fill('Page')), 'pdf'), { code: 'LIMIT_EXCEEDED' });
});

test('el worker tiene un plazo máximo y puede iniciarse otro tras un timeout', async () => {
  await assert.rejects(runExtraction(pdfFixture(), 'pdf', { timeoutMs: 1 }), { code: 'TIMEOUT' });
  assert.equal((await runExtraction(Buffer.from('Reintento'), 'txt')).chunks[0].content, 'Reintento');
});
