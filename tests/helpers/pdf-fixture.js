// PDF de texto sintético con xref real. Ningún archivo ni contenido del usuario.
export function pdfFixture(pages = ['First page', 'Second page']) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const ids = pages.map(text => {
    const escaped = text.replace(/[\\()]/g, char => '\\' + char);
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : '';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${ids.map(id => id + ' 0 R').join(' ')}] >>`;
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
