// The streaming JPEG encoder round-trips through a small independent baseline
// decoder (below): sizes, any strip height, transparency over white, and the
// 65,535 px limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJpegEncoder, JPEG_HUFFMAN, JPEG_MAX_EDGE } from '../ortho-export-jpeg.mjs';

async function encode(width, height, pixel, { strip = 37, quality = 92 } = {}) {
  const parts = [];
  const encoder = createJpegEncoder({ width, height, quality, sink: { write: async (bytes) => { parts.push(Uint8Array.from(bytes)); } } });
  for (let y = 0; y < height; y += strip) {
    const rows = Math.min(strip, height - y), rgba = new Uint8Array(width * rows * 4);
    for (let r = 0; r < rows; r++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y + r), (r * width + x) * 4);
    await encoder.writeRows(rgba, rows);
  }
  await encoder.finish();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Minimal baseline (SOF0) decoder: Huffman, dequantise, float IDCT, chroma upsampling.
function decode(bytes) {
  let pos = 2;
  const qt = [], dc = [], ac = [], comps = [];
  let width = 0, height = 0;
  const u16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  const zig = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'SOI');
  for (;;) {
    assert.equal(bytes[pos], 0xff);
    const marker = bytes[pos + 1], length = u16(pos + 2), seg = pos + 4;
    if (marker === 0xdb) { for (let i = seg; i < pos + 2 + length; i += 65) qt[bytes[i] & 15] = bytes.subarray(i + 1, i + 65); }
    else if (marker === 0xc0) {
      height = u16(seg + 1); width = u16(seg + 3);
      for (let c = 0; c < bytes[seg + 5]; c++) { const o = seg + 6 + c * 3; comps.push({ h: bytes[o + 1] >> 4, v: bytes[o + 1] & 15, q: bytes[o + 2] }); }
    } else if (marker === 0xc4) {
      for (let i = seg; i < pos + 2 + length;) {
        const cls = bytes[i] >> 4, id = bytes[i] & 15, bits = bytes.subarray(i + 1, i + 17), n = bits.reduce((a, b) => a + b, 0);
        const values = bytes.subarray(i + 17, i + 17 + n), map = new Map();
        let code = 0, k = 0;
        for (let len = 1; len <= 16; len++) { for (let j = 0; j < bits[len - 1]; j++) map.set(`${len}:${code++}`, values[k++]); code <<= 1; }
        (cls ? ac : dc)[id] = map; i += 17 + n;
      }
    } else if (marker === 0xda) {
      const tables = []; for (let c = 0; c < bytes[seg]; c++) tables.push({ dc: bytes[seg + 2 + c * 2] >> 4, ac: bytes[seg + 2 + c * 2] & 15 });
      pos = pos + 2 + length; return { width, height, ...scan(pos, tables) };
    }
    pos += 2 + length;
  }
  function scan(start, tables) {
    let p = start, bit = 0, cur = 0;
    const readBit = () => {
      if (!bit) { cur = bytes[p++]; if (cur === 0xff) { assert.equal(bytes[p], 0, 'stuffed 0xFF'); p++; } bit = 8; }
      return (cur >> --bit) & 1;
    };
    const huff = (map) => { let code = 0; for (let len = 1; len <= 16; len++) { code = (code << 1) | readBit(); const v = map.get(`${len}:${code}`); if (v !== undefined) return v; } throw new Error('bad code'); };
    const receive = (s) => { let v = 0; for (let i = 0; i < s; i++) v = (v << 1) | readBit(); return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v; };
    const mcuX = Math.ceil(width / 16), mcuY = Math.ceil(height / 16), W = mcuX * 16, H = mcuY * 16;
    const planes = [new Float32Array(W * H), new Float32Array(W * H / 4), new Float32Array(W * H / 4)], pred = [0, 0, 0];
    const block = new Float32Array(64);
    const idct = (out, stride, ox, oy) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
          const c = block[v * 8 + u]; if (!c) continue;
          s += (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) * c * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
        }
        out[(oy + y) * stride + ox + x] = s / 4;
      }
    };
    for (let my = 0; my < mcuY; my++) for (let mx = 0; mx < mcuX; mx++) {
      for (let c = 0; c < 3; c++) {
        const { h, v, q } = comps[c];
        for (let by = 0; by < v; by++) for (let bx = 0; bx < h; bx++) {
          block.fill(0);
          const s = huff(dc[tables[c].dc]); pred[c] += s ? receive(s) : 0; block[0] = pred[c] * qt[q][0];
          for (let k = 1; k < 64;) {
            const rs = huff(ac[tables[c].ac]), r = rs >> 4, size = rs & 15;
            if (!size) { if (r === 15) { k += 16; continue; } break; }
            k += r; block[zig[k]] = receive(size) * qt[q][k]; k++;
          }
          const stride = c ? W / 2 : W;
          idct(planes[c], stride, (mx * h + bx) * 8, (my * v + by) * 8);
        }
      }
    }
    const rgb = new Uint8ClampedArray(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const Y = planes[0][y * W + x] + 128, cb = planes[1][(y >> 1) * (W / 2) + (x >> 1)], cr = planes[2][(y >> 1) * (W / 2) + (x >> 1)], i = (y * width + x) * 3;
      rgb[i] = Y + 1.402 * cr; rgb[i + 1] = Y - 0.344136 * cb - 0.714136 * cr; rgb[i + 2] = Y + 1.772 * cb;
    }
    assert.deepEqual([bytes[bytes.length - 2], bytes[bytes.length - 1]], [0xff, 0xd9], 'EOI');
    return { rgb };
  }
}

const psnr = (rgb, width, height, expected) => {
  let error = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const e = expected(x, y), i = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) error += (rgb[i + c] - e[c]) ** 2;
  }
  return 10 * Math.log10(255 ** 2 / (error / (width * height * 3)));
};

test('Huffman tables cover every symbol baseline JPEG can need', () => {
  for (const [name, table] of Object.entries(JPEG_HUFFMAN)) {
    const count = table.bits.reduce((a, b) => a + b, 0);
    assert.equal(count, table.values.length, name);
    assert.equal(new Set(table.values).size, table.values.length, `${name}: no repeats`);
    assert.equal(count, name.startsWith('AC') ? 162 : 12, name);
  }
});

test('a smooth image round-trips closely, in any strip height and odd sizes', async () => {
  const smooth = (x, y) => [Math.round(128 + 100 * Math.sin(x / 9)), Math.round(128 + 90 * Math.cos(y / 7)), (x + y) % 256, 255];
  for (const [w, h, strip] of [[203, 117, 37], [16, 16, 16], [1, 1, 8], [65, 33, 1]]) {
    const bytes = await encode(w, h, smooth, { strip });
    const image = decode(bytes);
    assert.deepEqual([image.width, image.height], [w, h]);
    assert.ok(psnr(image.rgb, w, h, smooth) > 30, `${w}x${h}: ${psnr(image.rgb, w, h, smooth).toFixed(1)} dB`);
  }
});

test('transparent pixels come out white (nodata in a print)', async () => {
  const bytes = await encode(32, 32, (x) => (x < 16 ? [20, 120, 40, 0] : [20, 120, 40, 255]));
  const { rgb } = decode(bytes);
  const at = (x, y) => [...rgb.subarray((y * 32 + x) * 3, (y * 32 + x) * 3 + 3)];
  assert.ok(at(4, 4).every(v => v > 245), `white ${at(4, 4)}`);
  assert.ok(Math.abs(at(28, 28)[1] - 120) < 8, `green ${at(28, 28)}`);
});

test('more than 65,535 px per side is refused before anything is written', () => {
  assert.throws(() => createJpegEncoder({ width: JPEG_MAX_EDGE + 1, height: 10, sink: { write() { throw new Error('wrote'); } } }), { code: 'print_jpeg_too_large' });
  assert.doesNotThrow(() => createJpegEncoder({ width: JPEG_MAX_EDGE, height: 1, sink: { write() {} } }));
});
