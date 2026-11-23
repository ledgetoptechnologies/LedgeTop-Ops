// A one-page PDF holding one JPEG, edge to edge. No library, no coordinates,
// no metadata beyond the title.

// A PDF text string: UTF-16 with a byte order mark, in hex, so nothing in it can end the string.
function pdfText(text) {
  let hex = 'FEFF';
  for (const unit of String(text ?? '').slice(0, 200)) for (let i = 0; i < unit.length; i++) hex += unit.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/**
 * jpeg: Uint8Array of a baseline RGB JPEG, `pixelWidth` x `pixelHeight`.
 * widthIn x heightIn: the paper. Returns the PDF's bytes.
 */
export function encodeSheetPdf({ jpeg, pixelWidth, pixelHeight, widthIn, heightIn, title = '' }) {
  if (!(jpeg instanceof Uint8Array) || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new TypeError('A JPEG image is required.');
  if (!(widthIn > 0 && heightIn > 0 && Number.isInteger(pixelWidth) && pixelWidth > 0 && Number.isInteger(pixelHeight) && pixelHeight > 0)) throw new RangeError('Invalid page size.');
  const points = inches => Number((inches * 72).toFixed(3));
  const w = points(widthIn), h = points(heightIn), content = `q ${w} 0 0 ${h} 0 0 cm /Map Do Q`;
  const encoder = new TextEncoder(), parts = [], offsets = [];
  let length = 0;
  const add = part => { const bytes = typeof part === 'string' ? encoder.encode(part) : part; parts.push(bytes); length += bytes.length; };
  const object = (...body) => { offsets.push(length); add(`${offsets.length} 0 obj\n`); for (const part of body) add(part); add('\nendobj\n'); };
  add('%PDF-1.4\n');
  add(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // a comment of high bytes: this file is binary
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Map 5 0 R >> >> /Contents 4 0 R >>`);
  object(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  object(`<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream');
  object(`<< /Title ${pdfText(title)} >>`);
  const start = length;
  add(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  add(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A plain file name from a title. */
export function sheetFilename(title, extension = 'pdf') {
  const base = String(title ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${base || 'map'}.${extension}`;
}
