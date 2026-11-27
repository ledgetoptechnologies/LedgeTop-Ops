// Full-resolution orthophoto export, streamed. The image is rendered in
// horizontal strips (and canvas tiles no wider than TILE_WIDTH), encoded as
// it goes and written to a sink, so memory stays bounded by one strip no
// matter how large the orthophoto is. PNG (opaque, white outside the image)
// or a deflate-compressed RGBA GeoTIFF (BigTIFF past 4 GiB).
import { drawContours } from './contours.mjs';
import { isRgbNoData } from './orthophoto-mask.mjs';
import { createJpegEncoder } from './ortho-export-jpeg.mjs';
import { clampExtent, drawPrintLegend, printLayout, renderOrthoPixels } from './ortho-print-export.mjs';

export const TILE_WIDTH = 4096;
export const STRIP_PIXELS = 8_000_000;
const PROPERTY_LINE = Object.freeze({ color: '#FFD60A', halo: 'rgba(17,17,17,0.55)', width: 2.5, haloWidth: 5 });
const PARCEL_EDGE = Object.freeze({ color: '#ee5007', halo: 'rgba(17,17,17,0.6)', width: 3, haloWidth: 6 });

const cancelled = () => new DOMException('Export cancelled.', 'AbortError');
const abortIf = (signal) => { if (signal?.aborted) throw cancelled(); };

/** Bounding box of UTM rings ([[e, n], ...]). */
export function ringsExtent(rings) {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const ring of rings || []) for (const [e, n] of ring) {
    if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n;
  }
  return maxE > minE && maxN > minN ? { minE, minN, maxE, maxN } : null;
}

/**
 * Output grid for an export. Native: the orthophoto's own full-resolution
 * pixels covering the extent (snapped to its grid). Otherwise `longEdge` px
 * on the long side (used only where access caps the size).
 */
export function exportGrid(ds, requested, { longEdge = null } = {}) {
  const extent = clampExtent(requested, ds);
  if (!extent) return null;
  if (longEdge) return { ...printLayout(extent, longEdge), extent, native: false };
  const image = ds.images[0], iw = image.getWidth(), ih = image.getHeight();
  const cellE = (ds.maxE - ds.minE) / iw, cellN = (ds.maxN - ds.minN) / ih;
  const x0 = Math.max(0, Math.floor((extent.minE - ds.minE) / cellE + 1e-6));
  const x1 = Math.min(iw, Math.ceil((extent.maxE - ds.minE) / cellE - 1e-6));
  const y0 = Math.max(0, Math.floor((ds.maxN - extent.maxN) / cellN + 1e-6));
  const y1 = Math.min(ih, Math.ceil((ds.maxN - extent.minN) / cellN - 1e-6));
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    width: x1 - x0, height: y1 - y0, gsdE: cellE, gsdN: cellN, native: true, x0, y0,
    extent: { minE: ds.minE + x0 * cellE, maxE: ds.minE + x1 * cellE, maxN: ds.maxN - y0 * cellN, minN: ds.maxN - y1 * cellN },
  };
}

/** Native pixels for rows [r0, r1) of a native grid, copied without resampling. */
async function nativeRows(ds, grid, r0, r1, { background, signal, pool }) {
  const { width, x0, y0 } = grid, rows = r1 - r0;
  const raster = await ds.images[0].readRasters({ window: [x0, y0 + r0, x0 + width, y0 + r1], interleave: false, pool, signal });
  abortIf(signal);
  const R = raster[0], G = raster[1] || R, B = raster[2] || R, A = raster.length >= 4 ? raster[3] : null;
  const out = new Uint8ClampedArray(width * rows * 4);
  for (let i = 0, o = 0; i < width * rows; i++, o += 4) {
    const alpha = A ? A[i] / 255 : (isRgbNoData(R[i], G[i], B[i], ds.nodata) ? 0 : 1);
    if (background) {
      out[o] = R[i] * alpha + background[0] * (1 - alpha); out[o + 1] = G[i] * alpha + background[1] * (1 - alpha);
      out[o + 2] = B[i] * alpha + background[2] * (1 - alpha); out[o + 3] = 255;
    } else { out[o] = R[i]; out[o + 1] = G[i]; out[o + 2] = B[i]; out[o + 3] = Math.round(alpha * 255); }
  }
  return out;
}

async function gridRows(ds, grid, r0, r1, options) {
  if (grid.native) return nativeRows(ds, grid, r0, r1, options);
  const { extent, width, gsdN } = grid;
  const strip = { minE: extent.minE, maxE: extent.maxE, maxN: extent.maxN - r0 * gsdN, minN: extent.maxN - r1 * gsdN };
  const { rgba } = await renderOrthoPixels({ ds, extent: strip, width, height: r1 - r0, signal: options.signal, pool: options.pool, background: options.background });
  return rgba;
}

/**
 * Draws everything that goes over the imagery on one tile whose top-left
 * is output pixel (tx, ty). All drawing uses whole-image coordinates, so
 * lines and labels meet exactly across tile edges.
 */
function decorateTile(ctx, { tx, ty, tw, th, grid, layers, scale, print }) {
  const { extent, gsdE, gsdN, width, height } = grid;
  const project = (e, n) => [(e - extent.minE) / gsdE, (extent.maxN - n) / gsdN];
  const path = (lines) => {
    ctx.beginPath();
    for (const line of lines) line.forEach(([e, n], i) => { const [x, y] = project(e, n); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  };
  ctx.save();
  ctx.translate(-tx, -ty);
  if (layers.contours?.features?.length) {
    drawContours(ctx, layers.contours.features, project, { colors: layers.colors, scale, width, height, print });
  }
  if (layers.propertyLines?.length) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const color = layers.propertyStyle?.color || PROPERTY_LINE.color;
    for (const [style, w] of [[PROPERTY_LINE.halo, PROPERTY_LINE.haloWidth], [color, PROPERTY_LINE.width]]) {
      path(layers.propertyLines); ctx.strokeStyle = style; ctx.lineWidth = w * scale; ctx.stroke();
    }
  }
  if (layers.clip?.length) {
    // Keep only what lies inside the selected parcels: each parcel's rings
    // even-odd (holes stay out), parcels unioned on a mask canvas.
    ctx.restore(); ctx.save();
    const maskCanvas = layers.createCanvas(tw, th); maskCanvas.width = tw; maskCanvas.height = th;
    const mctx = maskCanvas.getContext('2d');
    mctx.translate(-tx, -ty); mctx.fillStyle = '#000';
    for (const parcel of layers.clip) { mctx.beginPath(); for (const ring of parcel) ring.forEach(([e, n], i) => { const [x, y] = project(e, n); if (i) mctx.lineTo(x, y); else mctx.moveTo(x, y); }); mctx.closePath(); mctx.fill('evenodd'); }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas, 0, 0);
    maskCanvas.width = 0; maskCanvas.height = 0;
    if (print) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th); }
    ctx.globalCompositeOperation = 'source-over';
    if (layers.clipEdge) {
      ctx.translate(-tx, -ty); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [style, w] of [[PARCEL_EDGE.halo, PARCEL_EDGE.haloWidth], [layers.propertyStyle?.color || PARCEL_EDGE.color, PARCEL_EDGE.width]]) {
        path(layers.clip.flat()); ctx.strokeStyle = style; ctx.lineWidth = w * scale; ctx.stroke();
      }
    }
    ctx.restore(); ctx.save(); ctx.translate(-tx, -ty);
  }
  if (print && layers.legend !== false) drawPrintLegend(ctx, { width, height, gsdE, units: layers.contours?.units || layers.units, contours: layers.contours, scale, colors: layers.colors });
  ctx.restore();
}

/** Line and label scale for an output size: thicker on big images so they read at print size. */
export const overlayScale = (width, height) => Math.max(1, Math.min(4, Math.max(width, height) / 1600));

/** Whole-image features grouped so each strip only draws what can reach it. */
function stripLayers(layers, grid, r0, r1, scale) {
  if (!layers.contours?.features?.length) return layers;
  const margin = 400 * scale, top = r0 - margin, bottom = r1 + margin;
  layers._contourRows ||= layers.contours.features.map(f => {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < f.coords.length; i += 2) { const y = (grid.extent.maxN - f.coords[i]) / grid.gsdN; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return [minY, maxY];
  });
  const features = layers.contours.features.filter((_, i) => layers._contourRows[i][1] >= top && layers._contourRows[i][0] <= bottom);
  return { ...layers, contours: { ...layers.contours, features } };
}

/**
 * Renders rows [r0, r1) of the export with every overlay into `rgba`
 * (width x rows x 4), tile by tile.
 */
async function renderStrip({ ds, grid, r0, r1, layers, print, createCanvas, signal, pool, scale }) {
  const { width } = grid, rows = r1 - r0;
  const rgba = await gridRows(ds, grid, r0, r1, { background: print ? [255, 255, 255] : null, signal, pool });
  const decorate = layers.contours?.features?.length || layers.propertyLines?.length || layers.clip?.length || print;
  if (!decorate) return rgba;
  const local = stripLayers(layers, grid, r0, r1, scale);
  for (let tx = 0; tx < width; tx += TILE_WIDTH) {
    abortIf(signal);
    const tw = Math.min(TILE_WIDTH, width - tx);
    const canvas = createCanvas(tw, rows); canvas.width = tw; canvas.height = rows;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width !== tw) throw Object.assign(new Error('This browser could not prepare the image.'), { code: 'print_too_large' });
    const tile = new Uint8ClampedArray(tw * rows * 4);
    for (let y = 0; y < rows; y++) tile.set(rgba.subarray((y * width + tx) * 4, (y * width + tx + tw) * 4), y * tw * 4);
    ctx.putImageData(new ImageData(tile, tw, rows), 0, 0);
    decorateTile(ctx, { tx, ty: r0, tw, th: rows, grid, layers: { ...local, createCanvas }, scale, print });
    const back = ctx.getImageData(0, 0, tw, rows).data;
    for (let y = 0; y < rows; y++) rgba.set(back.subarray(y * tw * 4, (y + 1) * tw * 4), (y * width + tx) * 4);
    canvas.width = 0; canvas.height = 0;
  }
  return rgba;
}

/** Rows per strip: about STRIP_PIXELS output pixels per strip. */
export const stripRows = (width, budget = STRIP_PIXELS) => Math.max(8, Math.min(1024, Math.floor(budget / Math.max(1, width))));

// ── Encoders ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** One deflate (zlib) stream, fed in pieces; `onChunk` gets compressed bytes as they come. */
function deflater(onChunk) {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
  // A failed onChunk (the sink refused a write) stops the reader; the stream
  // would then hold every later write forever. Fail them instead.
  const drained = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; await onChunk(value); } })();
  drained.catch(() => { writer.abort().catch(() => {}); });
  return {
    write: (bytes) => Promise.race([writer.write(bytes), drained]),
    close: () => Promise.all([writer.close(), drained]),
    abort() { writer.abort().catch(() => {}); reader.cancel().catch(() => {}); },
  };
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Opaque RGB PNG, rows streamed through deflate into IDAT chunks of about 1 MiB. */
export function createPngEncoder({ width, height, sink }) {
  let pending = [], pendingBytes = 0;
  const flush = async (force) => {
    if (!pendingBytes || (!force && pendingBytes < 1 << 20)) return;
    const data = new Uint8Array(pendingBytes); let at = 0;
    for (const part of pending) { data.set(part, at); at += part.length; }
    pending = []; pendingBytes = 0;
    await sink.write(pngChunk('IDAT', data));
  };
  const z = deflater(async (chunk) => { pending.push(chunk); pendingBytes += chunk.length; await flush(false); });
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  let started = false;
  return {
    async writeRows(rgba, rows) {
      if (!started) { started = true; await sink.write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); await sink.write(pngChunk('IHDR', ihdr)); }
      const stride = width * 3 + 1, out = new Uint8Array(stride * rows);
      for (let y = 0; y < rows; y++) {
        const o = y * stride; out[o] = 1; // Sub filter
        let pr = 0, pg = 0, pb = 0;
        for (let x = 0, i = y * width * 4, j = o + 1; x < width; x++, i += 4, j += 3) {
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          out[j] = r - pr; out[j + 1] = g - pg; out[j + 2] = b - pb; pr = r; pg = g; pb = b;
        }
      }
      await z.write(out);
    },
    async finish() { await z.close(); await flush(true); await sink.write(pngChunk('IEND', new Uint8Array(0))); },
    abort: () => z.abort(),
  };
}

/**
 * RGBA GeoTIFF (PixelIsArea, north-up) in the orthophoto's projected CRS,
 * one deflate strip per call. The IFD goes at the end and the header is
 * written last into 16 reserved bytes, so it can switch to BigTIFF when
 * the file passes 4 GiB.
 */
export function createGeoTiffEncoder({ width, height, extent, epsg, rowsPerStrip, sink }) {
  if (!Number.isInteger(epsg) || epsg <= 0 || epsg > 65535) throw Object.assign(new Error('GeoTIFF needs a verified coordinate reference. Export PNG instead.'), { code: 'print_crs' });
  const offsets = [], counts = [];
  let position = 16, started = false;
  return {
    async writeRows(rgba, rows) {
      if (!started) { started = true; await sink.write(new Uint8Array(16)); }
      const parts = []; let size = 0;
      const z = deflater(async (chunk) => { parts.push(chunk); size += chunk.length; });
      await z.write(new Uint8Array(rgba.buffer, rgba.byteOffset, width * rows * 4));
      await z.close();
      offsets.push(position); counts.push(size);
      for (const part of parts) await sink.write(part);
      position += size;
    },
    async finish() {
      const gsdE = (extent.maxE - extent.minE) / width, gsdN = (extent.maxN - extent.minN) / height;
      const big = position + 4096 + offsets.length * 16 > 0xffffffff;
      const ifdAt = position + (position % 8 ? 8 - (position % 8) : 0);
      const SHORT = 3, LONG = 4, DOUBLE = 12, LONG8 = 16, OFF = big ? LONG8 : LONG;
      const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [LONG8]: 8 };
      const entries = [
        [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, [8, 8, 8, 8]], [259, SHORT, [8]], [262, SHORT, [2]],
        [273, OFF, offsets], [277, SHORT, [4]], [278, LONG, [rowsPerStrip]], [279, OFF, counts], [284, SHORT, [1]],
        [338, SHORT, [2]], [339, SHORT, [1, 1, 1, 1]],
        [33550, DOUBLE, [gsdE, gsdN, 0]], [33922, DOUBLE, [0, 0, 0, extent.minE, extent.maxN, 0]],
        [34735, SHORT, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg]],
      ];
      const entrySize = big ? 20 : 12, inline = big ? 8 : 4, countSize = big ? 8 : 2, nextSize = big ? 8 : 4;
      let cursor = ifdAt + countSize + entries.length * entrySize + nextSize;
      const layout = entries.map(([tag, type, values]) => {
        const bytes = values.length * size[type];
        if (bytes <= inline) return { tag, type, values, at: null };
        cursor += cursor % 8 ? 8 - (cursor % 8) : 0;
        const at = cursor; cursor += bytes; return { tag, type, values, at };
      });
      const out = new Uint8Array(cursor - position), view = new DataView(out.buffer), rel = (abs) => abs - position;
      const put = (type, abs, v) => {
        const o = rel(abs);
        if (type === SHORT) view.setUint16(o, v, true); else if (type === LONG) view.setUint32(o, v, true);
        else if (type === LONG8) view.setBigUint64(o, BigInt(v), true); else view.setFloat64(o, v, true);
      };
      if (big) view.setBigUint64(rel(ifdAt), BigInt(entries.length), true); else view.setUint16(rel(ifdAt), entries.length, true);
      layout.forEach(({ tag, type, values, at }, i) => {
        const e = ifdAt + countSize + i * entrySize;
        view.setUint16(rel(e), tag, true); view.setUint16(rel(e) + 2, type, true);
        if (big) view.setBigUint64(rel(e) + 4, BigInt(values.length), true); else view.setUint32(rel(e) + 4, values.length, true);
        const valueAt = e + (big ? 12 : 8);
        if (at === null) values.forEach((v, j) => put(type, valueAt + j * size[type], v));
        else { if (big) view.setBigUint64(rel(valueAt), BigInt(at), true); else view.setUint32(rel(valueAt), at, true); values.forEach((v, j) => put(type, at + j * size[type], v)); }
      });
      await sink.write(out);
      const header = new Uint8Array(16), hv = new DataView(header.buffer);
      hv.setUint16(0, 0x4949);
      if (big) { hv.setUint16(2, 43, true); hv.setUint16(4, 8, true); hv.setUint16(6, 0, true); hv.setBigUint64(8, BigInt(ifdAt), true); }
      else { hv.setUint16(2, 42, true); hv.setUint32(4, ifdAt, true); }
      await sink.writeHeader(header);
    },
    abort() {},
  };
}

// ── Sinks ─────────────────────────────────────────────────────────────────

/**
 * In-memory sink. Parts are folded into Blobs every 64 MiB so the bytes
 * leave the JavaScript heap (the browser may keep large Blobs on disk).
 */
export function createBlobSink({ type, BlobRef = Blob } = {}) {
  let blobs = [], parts = [], bytes = 0, header = null;
  const fold = () => { if (parts.length) { blobs.push(new BlobRef(parts)); parts = []; bytes = 0; } };
  return {
    async write(chunk) { parts.push(chunk); bytes += chunk.length; if (bytes >= 64 << 20) fold(); },
    async writeHeader(head) { header = head; },
    async close() {
      fold();
      let all = blobs; blobs = [];
      // The header replaces the bytes reserved for it at the start.
      if (header) all = [header, all[0].slice(header.length), ...all.slice(1)];
      return new BlobRef(all, { type });
    },
    abort() { blobs = []; parts = []; },
  };
}

/** Writes straight to a file the person chose (File System Access API). */
export function createFileSink(writable) {
  return {
    write: (chunk) => writable.write(chunk),
    writeHeader: (head) => writable.write({ type: 'write', position: 0, data: head }),
    async close() { await writable.close(); return null; },
    abort() { writable.abort?.().catch?.(() => {}); },
  };
}

/**
 * Render and encode the whole export into `sink`. `layers`: { contours,
 * colors, propertyLines, propertyStyle, clip (UTM rings per parcel),
 * clipEdge, units }. `onProgress(fraction)` after each strip.
 */
export async function streamOrthoExport({ ds, grid, format = 'png', epsg = null, layers = {}, sink, createCanvas, pool, signal, onProgress, beforeClose }) {
  const print = format !== 'tif';
  const rows = stripRows(grid.width);
  const encoder = format === 'jpg' ? createJpegEncoder({ width: grid.width, height: grid.height, sink })
    : print ? createPngEncoder({ width: grid.width, height: grid.height, sink })
    : createGeoTiffEncoder({ width: grid.width, height: grid.height, extent: grid.extent, epsg, rowsPerStrip: rows, sink });
  const scale = overlayScale(grid.width, grid.height);
  try {
    for (let r0 = 0; r0 < grid.height; r0 += rows) {
      abortIf(signal);
      const r1 = Math.min(grid.height, r0 + rows);
      const rgba = await renderStrip({ ds, grid, r0, r1, layers, print, createCanvas, signal, pool, scale });
      abortIf(signal);
      await encoder.writeRows(rgba, r1 - r0);
      onProgress?.(r1 / grid.height);
    }
    await encoder.finish();
    // Last check before the file is committed (a file sink is final on close).
    abortIf(signal);
    await beforeClose?.();
  } catch (error) { encoder.abort(); sink.abort(); throw error; }
  return sink.close();
}

/** A small preview of the same export on one canvas (coarse overview levels, same overlays). */
export async function renderExportPreview({ ds, extent, longEdge = 900, format = 'png', layers = {}, createCanvas, pool, signal }) {
  const grid = exportGrid(ds, extent, { longEdge });
  if (!grid) return null;
  const print = format !== 'tif';
  const scale = overlayScale(grid.width, grid.height) * 0.5;
  const rgba = await renderStrip({ ds, grid, r0: 0, r1: grid.height, layers: { ...layers, legend: false }, print, createCanvas, signal, pool, scale });
  const canvas = createCanvas(grid.width, grid.height); canvas.width = grid.width; canvas.height = grid.height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
  return { canvas, grid };
}
