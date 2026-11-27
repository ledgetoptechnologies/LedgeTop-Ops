// Streaming baseline JPEG encoder (JFIF, YCbCr 4:2:0, standard Huffman
// tables) for full-resolution orthophoto exports. Rows arrive in strips of
// any height; 16-row MCU bands are encoded as soon as they are complete, so
// memory stays at one strip plus one band whatever the image size.
// Transparent pixels are composited over white.

export const JPEG_MAX_EDGE = 65535;

// Natural (row-major) index -> zig-zag position.
const ZIGZAG = Uint8Array.from([0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63]);
// ITU T.81 Annex K quantisation tables, natural order.
const LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99)];

// Huffman tables: code counts per length 1..16, then symbols. The AC symbol
// lists are every (run, size) pair; their order follows Annex K.
const acSymbols = (head) => { const seen = new Set(head), out = [...head]; for (let r = 0; r < 16; r++) for (let s = 1; s <= 10; s++) { const v = (r << 4) | s; if (!seen.has(v)) out.push(v); } return out; };
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], values: acSymbols([0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a,
  0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a]) };
const AC_CHROMA = { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], values: acSymbols([0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17,
  0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a]) };
export const JPEG_HUFFMAN = { DC_LUMA, DC_CHROMA, AC_LUMA, AC_CHROMA };

/** Canonical codes: symbol -> [code, length]. */
function huffmanCodes({ bits, values }) {
  const codes = new Array(256);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]; i++) codes[values[k++]] = [code++, length];
    code <<= 1;
  }
  return codes;
}

function scaledTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const factor = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * factor + 50) / 100))));
}

const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];
const divisors = (table) => { const out = new Float64Array(64); for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) out[k] = 1 / (table[k] * AAN[r] * AAN[c] * 8); return out; };

/** AAN forward DCT in place, then quantise into `out` in zig-zag order. */
function fdctQuantise(d, div, out) {
  for (let o = 0; o < 64; o += 8) {
    const t0 = d[o] + d[o + 7], t7 = d[o] - d[o + 7], t1 = d[o + 1] + d[o + 6], t6 = d[o + 1] - d[o + 6];
    const t2 = d[o + 2] + d[o + 5], t5 = d[o + 2] - d[o + 5], t3 = d[o + 3] + d[o + 4], t4 = d[o + 3] - d[o + 4];
    let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; let t12 = t1 - t2;
    d[o] = t10 + t11; d[o + 4] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781; d[o + 2] = t13 + z1; d[o + 6] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[o + 5] = z13 + z2; d[o + 3] = z13 - z2; d[o + 1] = z11 + z4; d[o + 7] = z11 - z4;
  }
  for (let o = 0; o < 8; o++) {
    const t0 = d[o] + d[o + 56], t7 = d[o] - d[o + 56], t1 = d[o + 8] + d[o + 48], t6 = d[o + 8] - d[o + 48];
    const t2 = d[o + 16] + d[o + 40], t5 = d[o + 16] - d[o + 40], t3 = d[o + 24] + d[o + 32], t4 = d[o + 24] - d[o + 32];
    let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; let t12 = t1 - t2;
    d[o] = t10 + t11; d[o + 32] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781; d[o + 16] = t13 + z1; d[o + 48] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[o + 40] = z13 + z2; d[o + 24] = z13 - z2; d[o + 8] = z11 + z4; d[o + 56] = z11 - z4;
  }
  for (let i = 0; i < 64; i++) out[ZIGZAG[i]] = Math.round(d[i] * div[i]);
}

/**
 * `sink.write(Uint8Array)`; `writeRows(rgba, rows)` takes `rows` full rows of
 * RGBA; `finish()` encodes the last partial band and writes EOI.
 */
export function createJpegEncoder({ width, height, sink, quality = 90 }) {
  if (!(width >= 1 && height >= 1 && width <= JPEG_MAX_EDGE && height <= JPEG_MAX_EDGE)) {
    throw Object.assign(new Error(`JPEG is limited to ${JPEG_MAX_EDGE.toLocaleString('en-US')} px per side. Choose PNG or TIFF for this area.`), { code: 'print_jpeg_too_large' });
  }
  const lq = scaledTable(LUMA_Q, quality), cq = scaledTable(CHROMA_Q, quality);
  const ldiv = divisors(lq), cdiv = divisors(cq);
  const dcL = huffmanCodes(DC_LUMA), acL = huffmanCodes(AC_LUMA), dcC = huffmanCodes(DC_CHROMA), acC = huffmanCodes(AC_CHROMA);

  // Output buffer with bit packing and 0xFF stuffing.
  let out = new Uint8Array(1 << 20), at = 0, bitBuffer = 0, bitCount = 0;
  const pending = [];
  const room = (n) => { if (at + n > out.length) { pending.push(out.subarray(0, at)); out = new Uint8Array(Math.max(1 << 20, n)); at = 0; } };
  const byte = (b) => { room(1); out[at++] = b; };
  const bytes = (list) => { room(list.length); out.set(list, at); at += list.length; };
  const writeBits = (code, length) => {
    bitBuffer = (bitBuffer << length) | code; bitCount += length;
    while (bitCount >= 8) {
      const b = (bitBuffer >>> (bitCount - 8)) & 0xff;
      room(2); out[at++] = b; if (b === 0xff) out[at++] = 0;
      bitCount -= 8;
    }
    bitBuffer &= (1 << bitCount) - 1;
  };
  const drain = async () => {
    if (at) { pending.push(out.subarray(0, at)); out = new Uint8Array(1 << 20); at = 0; }
    for (const part of pending.splice(0)) await sink.write(part);
  };

  const segment = (marker, payload) => { byte(0xff); byte(marker); const n = payload.length + 2; byte(n >> 8); byte(n & 0xff); bytes(payload); };
  function header() {
    byte(0xff); byte(0xd8);
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const zig = (table) => { const z = new Array(64); for (let i = 0; i < 64; i++) z[ZIGZAG[i]] = table[i]; return z; };
    segment(0xdb, [0, ...zig(lq), 1, ...zig(cq)]);
    segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const dht = (cls, id, table) => [(cls << 4) | id, ...table.bits, ...table.values];
    segment(0xc4, [...dht(0, 0, DC_LUMA), ...dht(1, 0, AC_LUMA), ...dht(0, 1, DC_CHROMA), ...dht(1, 1, AC_CHROMA)]);
    segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  }

  const block = new Float64Array(64), coeffs = new Int32Array(64);
  const magnitude = (v) => { let n = 0, a = v < 0 ? -v : v; while (a) { n++; a >>= 1; } return n; };
  function encodeBlock(div, previousDc, dc, ac) {
    fdctQuantise(block, div, coeffs);
    const diff = coeffs[0] - previousDc, size = magnitude(diff);
    writeBits(dc[size][0], dc[size][1]);
    if (size) writeBits(diff < 0 ? diff + (1 << size) - 1 : diff, size);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coeffs[k];
      if (!v) { run++; continue; }
      while (run > 15) { writeBits(ac[0xf0][0], ac[0xf0][1]); run -= 16; }
      const s = magnitude(v), symbol = (run << 4) | s;
      writeBits(ac[symbol][0], ac[symbol][1]);
      writeBits(v < 0 ? v + (1 << s) - 1 : v, s);
      run = 0;
    }
    if (run) writeBits(ac[0][0], ac[0][1]);
    return coeffs[0];
  }

  // One 16-row band of Y, Cb, Cr planes (width rounded up to 16).
  const padded = Math.ceil(width / 16) * 16;
  const Y = new Float32Array(padded * 16), Cb = new Float32Array(padded * 16), Cr = new Float32Array(padded * 16);
  let bandRows = 0, rowsDone = 0, started = false, dcY = 0, dcCb = 0, dcCr = 0;

  function addRow(rgba, offset) {
    const base = bandRows * padded;
    for (let x = 0; x < padded; x++) {
      const i = offset + Math.min(x, width - 1) * 4, a = rgba[i + 3] / 255;
      const r = rgba[i] * a + 255 * (1 - a), g = rgba[i + 1] * a + 255 * (1 - a), b = rgba[i + 2] * a + 255 * (1 - a);
      Y[base + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      Cb[base + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[base + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    bandRows++;
  }
  function encodeBand() {
    // Short last band: repeat its last row.
    for (let y = bandRows; y < 16; y++) { const from = (bandRows - 1) * padded; Y.copyWithin(y * padded, from, from + padded); Cb.copyWithin(y * padded, from, from + padded); Cr.copyWithin(y * padded, from, from + padded); }
    for (let mx = 0; mx < padded; mx += 16) {
      for (const [ox, oy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = Y[(oy + y) * padded + mx + ox + x];
        dcY = encodeBlock(ldiv, dcY, dcL, acL);
      }
      for (const [plane, which] of [[Cb, 0], [Cr, 1]]) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const i = (2 * y) * padded + mx + 2 * x;
          block[y * 8 + x] = (plane[i] + plane[i + 1] + plane[i + padded] + plane[i + padded + 1]) / 4;
        }
        if (which === 0) dcCb = encodeBlock(cdiv, dcCb, dcC, acC); else dcCr = encodeBlock(cdiv, dcCr, dcC, acC);
      }
    }
    bandRows = 0;
  }

  return {
    async writeRows(rgba, rows) {
      if (!started) { started = true; header(); }
      if (rowsDone + rows > height) throw new Error('More rows than the image has.');
      for (let y = 0; y < rows; y++) {
        addRow(rgba, y * width * 4);
        if (bandRows === 16) encodeBand();
      }
      rowsDone += rows;
      await drain();
    },
    async finish() {
      if (!started) { started = true; header(); }
      if (rowsDone !== height) throw new Error('The image is incomplete.');
      if (bandRows) encodeBand();
      if (bitCount) writeBits((1 << (8 - bitCount)) - 1, 8 - bitCount); // pad with 1-bits
      byte(0xff); byte(0xd9);
      await drain();
    },
    abort() { pending.length = 0; at = 0; },
  };
}
