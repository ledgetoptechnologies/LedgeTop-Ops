// Orthophoto print: a high-resolution, grid-north-up image of the published
// orthophoto with contour lines (and optionally property lines) burned in.
// PNG for printing (white background, small legend and scale bar) or a
// georeferenced RGBA GeoTIFF in the orthophoto's own projected CRS.
import { BRAND_COLORS } from './brand-colors.mjs';
import { CONTOUR_COLORS, CONTOUR_INDEX_EVERY, drawContours, unitMeters, unitSuffix } from './contours.mjs';
import { isRgbNoData } from './orthophoto-mask.mjs';

export const PRINT_SIZES = Object.freeze([2048, 4096, 6144]);
export const PRINT_STRIP_SOURCE_PIXELS = 12_000_000;
// Goes with every export that shows property lines: a band on a PNG, the
// description tag in a GeoTIFF (whose pixels and bounds are map data).
export const PROPERTY_LINES_NOTE = 'Property lines are approximate, not a survey.';
const PROPERTY_LINE = Object.freeze({ color: BRAND_COLORS.orange, halo: 'rgba(17,17,17,0.55)', width: 2.5, haloWidth: 5 });

const cancelled = () => new DOMException('Export cancelled.', 'AbortError');
const abortIf = (signal) => { if (signal?.aborted) throw cancelled(); };

export function clampExtent(extent, ds) {
  const out = {
    minE: Math.max(ds.minE, extent.minE), maxE: Math.min(ds.maxE, extent.maxE),
    minN: Math.max(ds.minN, extent.minN), maxN: Math.min(ds.maxN, extent.maxN),
  };
  return out.maxE > out.minE && out.maxN > out.minN ? out : null;
}

/** Output size for an extent: `longEdge` px on the longer side, square pixels. */
export function printLayout(extent, longEdge) {
  const spanE = extent.maxE - extent.minE, spanN = extent.maxN - extent.minN;
  const edge = Math.max(16, Math.round(longEdge));
  const width = spanE >= spanN ? edge : Math.max(1, Math.round(edge * spanE / spanN));
  const height = spanE >= spanN ? Math.max(1, Math.round(edge * spanN / spanE)) : edge;
  return { width, height, gsdE: spanE / width, gsdN: spanN / height };
}

/** Coarsest overview whose pixels are no larger than the output pixels. */
export function pickOrthoLevel(ds, gsd) {
  const spanE = ds.maxE - ds.minE;
  let level = 0;
  ds.images.forEach((image, i) => { if (spanE / image.getWidth() <= gsd * 1.0001) level = i; });
  return level;
}

/**
 * Resample the orthophoto into an RGBA buffer for the output grid, reading
 * the source in horizontal strips so decode memory stays bounded.
 */
export async function renderOrthoPixels({ ds, extent, width, height, signal, pool, background = null,
  maxStripPixels = PRINT_STRIP_SOURCE_PIXELS }) {
  const gsdE = (extent.maxE - extent.minE) / width, gsdN = (extent.maxN - extent.minN) / height;
  const level = pickOrthoLevel(ds, Math.min(gsdE, gsdN));
  const image = ds.images[level];
  const iw = image.getWidth(), ih = image.getHeight();
  const cellE = (ds.maxE - ds.minE) / iw, cellN = (ds.maxN - ds.minN) / ih;
  const sxOf = x => (extent.minE + (x + 0.5) * gsdE - ds.minE) / cellE - 0.5;
  const syOf = y => (ds.maxN - (extent.maxN - (y + 0.5) * gsdN)) / cellN - 0.5;
  const sx0 = Math.max(0, Math.floor(sxOf(0)) - 1), sx1 = Math.min(iw, Math.ceil(sxOf(width - 1)) + 2);
  const srcCols = Math.max(1, sx1 - sx0);
  const srcRowsPerOut = gsdN / cellN;
  const rowsPerStrip = Math.max(1, Math.floor((maxStripPixels / srcCols - 4) / Math.max(srcRowsPerOut, 1e-9)));
  const out = new Uint8ClampedArray(width * height * 4);
  const bg = background ? [background[0], background[1], background[2]] : null;
  const sxs = new Float64Array(width);
  for (let x = 0; x < width; x++) sxs[x] = sxOf(x);
  for (let r0 = 0; r0 < height; r0 += rowsPerStrip) {
    abortIf(signal);
    const r1 = Math.min(height, r0 + rowsPerStrip);
    const sy0 = Math.max(0, Math.floor(syOf(r0)) - 1), sy1 = Math.min(ih, Math.ceil(syOf(r1 - 1)) + 2);
    if (sy1 <= sy0 || sx1 <= sx0) continue;
    const raster = await image.readRasters({ window: [sx0, sy0, sx1, sy1], interleave: false, pool, signal });
    abortIf(signal);
    const ww = sx1 - sx0, wh = sy1 - sy0;
    const R = raster[0], G = raster[1] || R, B = raster[2] || R, A = raster.length >= 4 ? raster[3] : null;
    for (let y = r0; y < r1; y++) {
      const fy = syOf(y) - sy0;
      const y0 = Math.max(0, Math.min(wh - 1, Math.floor(fy))), y1 = Math.min(wh - 1, y0 + 1);
      const ty = Math.max(0, Math.min(1, fy - y0));
      for (let x = 0; x < width; x++) {
        const fx = sxs[x] - sx0;
        const x0 = Math.max(0, Math.min(ww - 1, Math.floor(fx))), x1 = Math.min(ww - 1, x0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        let wSum = 0, r = 0, g = 0, b = 0;
        for (let t = 0; t < 4; t++) {
          const cx = t & 1 ? x1 : x0, cy = t & 2 ? y1 : y0;
          const w = (t & 1 ? tx : 1 - tx) * (t & 2 ? ty : 1 - ty);
          if (w <= 0) continue;
          const i = cy * ww + cx;
          const alpha = A ? A[i] / 255 : (isRgbNoData(R[i], G[i], B[i], ds.nodata) ? 0 : 1);
          if (alpha <= 0) continue;
          const wa = w * alpha;
          r += R[i] * wa; g += G[i] * wa; b += B[i] * wa; wSum += wa;
        }
        const a = wSum;
        const o = (y * width + x) * 4;
        const alpha = Math.min(1, a);
        if (wSum > 1e-9) { r /= wSum; g /= wSum; b /= wSum; }
        if (bg) {
          out[o] = r * alpha + bg[0] * (1 - alpha); out[o + 1] = g * alpha + bg[1] * (1 - alpha); out[o + 2] = b * alpha + bg[2] * (1 - alpha); out[o + 3] = 255;
        } else { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = Math.round(alpha * 255); }
      }
    }
  }
  return { rgba: out, level };
}

function niceLength(target) {
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [5, 2, 1]) if (m * p <= target) return m * p;
  return p;
}

/** One line of plain text; '' when there is nothing readable in it. */
export function cleanAttribution(value) {
  const text = typeof value === 'string' ? value.replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim() : '';
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

export function propertyNoteText(attribution) { return `${PROPERTY_LINES_NOTE} ${cleanAttribution(attribution)}`.trim(); }

/**
 * The property-line note as wrapped lines for a band `width` wide: legend-size
 * text, smaller where it would take more than 40% of the height. An image too small
 * to carry it legibly is refused, so the lines never leave without the note.
 */
export function layoutPropertyNote(ctx, { width, height, scale, attribution = '' }) {
  const words = propertyNoteText(attribution).split(' ');
  const pad = 6 * scale, room = width - pad * 2;
  ctx.save();
  try {
    for (let px = 12 * scale; px >= 9; px -= 1) {
      const font = `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.font = font;
      const fits = text => ctx.measureText(text).width <= room;
      if (!words.every(fits)) continue;
      const lines = [];
      for (const word of words) {
        const longer = lines.length ? `${lines[lines.length - 1]} ${word}` : '';
        if (longer && fits(longer)) lines[lines.length - 1] = longer; else lines.push(word);
      }
      const lineHeight = Math.ceil(px * 1.3), bandHeight = Math.ceil(lines.length * lineHeight + pad * 2);
      if (bandHeight <= height * 0.4) return { lines, font, lineHeight, bandHeight, pad };
    }
  } finally { ctx.restore(); }
  throw Object.assign(new Error('This image is too small to carry the property line note. Choose a larger area, or export without property lines.'), { code: 'print_note' });
}

// Opaque, and drawn last: nothing covers it.
function drawPropertyNote(ctx, { lines, font, lineHeight, bandHeight, pad }, { width, height }) {
  const top = height - bandHeight;
  ctx.save();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, top, width, bandHeight);
  ctx.font = font; ctx.fillStyle = '#1b1b1b'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  lines.forEach((line, i) => ctx.fillText(line, pad, top + pad + lineHeight * (i + 0.5)));
  ctx.restore();
}

// bottom: height of the note band the legend stays above.
function drawLegend(ctx, { width, height, gsdE, units, contours, propertyColor = null, bottom = 0, scale, colors }) {
  const pad = 10 * scale, line = 18 * scale;
  const u = unitMeters(units), suffix = unitSuffix(units);
  const barUnits = niceLength((width * 0.18) * gsdE / u);
  const barPx = barUnits * u / gsdE;
  const rows = [];
  if (contours) rows.push(`Contours ${contours.interval} ${suffix} · index every ${+(contours.interval * CONTOUR_INDEX_EVERY).toFixed(3)} ${suffix}`);
  if (propertyColor) rows.push('Property lines');
  rows.push('Grid north up');
  const swatch = contours || propertyColor ? 34 * scale : 0;
  ctx.save();
  ctx.font = `600 ${12 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textW = Math.max(...rows.map(t => ctx.measureText(t).width), barPx + 70 * scale);
  const boxW = textW + pad * 2 + swatch, boxH = pad * 2 + line * (rows.length + 1) + 6 * scale;
  const x = 14 * scale, y = height - bottom - boxH - 14 * scale;
  ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1 * scale;
  ctx.beginPath(); ctx.rect(x, y, boxW, boxH); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1b1b1b'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let cy = y + pad + line / 2;
  if (contours) {
    ctx.strokeStyle = colors.index; ctx.lineWidth = 2.2 * scale;
    ctx.beginPath(); ctx.moveTo(x + pad, cy - 3 * scale); ctx.lineTo(x + pad + 26 * scale, cy - 3 * scale); ctx.stroke();
    ctx.strokeStyle = colors.minor; ctx.lineWidth = 1 * scale;
    ctx.beginPath(); ctx.moveTo(x + pad, cy + 3 * scale); ctx.lineTo(x + pad + 26 * scale, cy + 3 * scale); ctx.stroke();
  }
  if (propertyColor) {
    const py = cy + (contours ? line : 0);
    ctx.beginPath(); ctx.moveTo(x + pad, py); ctx.lineTo(x + pad + 26 * scale, py);
    ctx.strokeStyle = PROPERTY_LINE.halo; ctx.lineWidth = PROPERTY_LINE.haloWidth * scale; ctx.stroke();
    ctx.strokeStyle = propertyColor; ctx.lineWidth = PROPERTY_LINE.width * scale; ctx.stroke();
  }
  const tx = x + pad + swatch;
  for (const row of rows) { ctx.fillText(row, tx, cy); cy += line; }
  // scale bar
  const by = cy + 2 * scale;
  ctx.fillStyle = '#1b1b1b'; ctx.fillRect(tx, by - 3 * scale, barPx, 6 * scale);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(tx + barPx / 2, by - 2 * scale, barPx / 2 - 1 * scale, 4 * scale);
  ctx.fillStyle = '#1b1b1b'; ctx.fillText(`${barUnits.toLocaleString('en-US')} ${suffix}`, tx + barPx + 8 * scale, by);
  ctx.restore();
}

const tooLarge = () => Object.assign(new Error('This browser cannot make an image that large. Choose a smaller size.'), { code: 'print_too_large' });

/**
 * Who may export what. The print is a report-style rendering, so a viewer
 * allowed to measure may export the current view as PNG. The whole
 * orthophoto and a georeferenced GeoTIFF are effectively the product, so
 * they also need download permission. Expired or unavailable access gets
 * nothing.
 */
export function orthoPrintPolicy({ accessAvailable = false, measure = false, download = false } = {}) {
  const allowed = accessAvailable === true && measure !== false;
  const product = allowed && download === true;
  return { allowed, whole: product, geotiff: product };
}

export function assertOrthoPrintAllowed(policy, { area, format }) {
  const deny = message => { throw Object.assign(new Error(message), { code: 'print_not_permitted' }); };
  if (!policy?.allowed) deny('Image export is not available for this view.');
  if (area !== 'view' && !policy.whole) deny('Exporting the whole orthophoto needs download permission.');
  if (format === 'tif' && !policy.geotiff) deny('GeoTIFF export needs download permission.');
}

// Without download permission a "current view" export is held to what the
// viewer can already see: the screen pixels covering the exported area (the
// view clipped to the orthophoto), and never more than 2048 px.
// Otherwise a zoomed-out view at 6144 px would equal the gated whole-ortho print.
export const VIEW_EXPORT_MAX_EDGE = 2048;
export function printLongEdge({ area, requested, policy, viewPixels }) {
  if (area !== 'view' || policy?.whole === true) return requested;
  const screen = Number.isFinite(viewPixels) && viewPixels > 0 ? Math.round(viewPixels) : VIEW_EXPORT_MAX_EDGE;
  return Math.max(16, Math.min(requested, VIEW_EXPORT_MAX_EDGE, screen));
}

/**
 * The print places overlays and georeferencing in the project's UTM frame
 * using the orthophoto file's extent, so the file must be north-up and in
 * that same CRS (as the measurement report requires). An ortho that does
 * not declare its CRS is refused for GeoTIFF.
 */
export function verifyOrthoCrs(ortho, epsg, { requireDeclared = false } = {}) {
  const refuse = message => { throw Object.assign(new Error(message), { code: 'print_crs' }); };
  const image = ortho?.images?.[0];
  if (!image) refuse('The orthophoto could not be read.');
  const fd = image.getFileDirectory?.() || {};
  let transform;
  try { transform = typeof fd.getValue === 'function' ? fd.getValue('ModelTransformation') : fd.ModelTransformation; } catch { transform = undefined; }
  // A plain north-up affine (no rotation or shear terms) is fine; anything else is rotated.
  if (transform && !(transform[1] === 0 && transform[4] === 0 && transform[0] > 0 && transform[5] < 0)) refuse('The orthophoto is rotated; export is only supported for north-up orthophotos.');
  const resolution = image.getResolution?.();
  if (resolution && !(resolution[0] > 0 && resolution[1] < 0)) refuse('The orthophoto orientation is unsupported for export.');
  const code = Number(image.getGeoKeys?.()?.ProjectedCSTypeGeoKey);
  const declared = Number.isInteger(code) && code > 0 && code < 32767;
  if (declared && code !== epsg) refuse('The orthophoto coordinate reference does not match this model. Export is unavailable.');
  if (!declared && requireDeclared) refuse('The orthophoto does not declare its coordinate reference. Export PNG instead.');
}

// iOS Safari caps a canvas at 16,777,216 pixels (4096 x 4096).
export function isIosLike(navigatorRef = globalThis.navigator) {
  const ua = String(navigatorRef?.userAgent || '');
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(navigatorRef?.maxTouchPoints) > 1);
}

/** Whether a width x height 2D canvas really works here (some browsers fail silently). */
export function canvasWorks(createCanvas, width, height) {
  let canvas = null;
  try {
    canvas = createCanvas(width, height);
    canvas.width = width; canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(width - 1, height - 1, 1, 1);
    const p = ctx.getImageData(width - 1, height - 1, 1, 1).data;
    return p[0] === 255 && p[3] === 255;
  } catch { return false; } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

/** Print sizes this browser can render; sizes above 4096 px are probed at the worst case (square). */
export function supportedPrintSizes({ navigatorRef = globalThis.navigator, createCanvas = null } = {}) {
  return PRINT_SIZES.filter(size => {
    if (size <= 4096) return true;
    if (isIosLike(navigatorRef)) return false;
    return createCanvas ? canvasWorks(createCanvas, size, size) : true;
  });
}

function putPixels(ctx, rgba, width, height) {
  // Wrap the resampled buffer directly; no second full-size copy.
  if (typeof ImageData === 'function') { ctx.putImageData(new ImageData(rgba, width, height), 0, 0); return; }
  const image = ctx.createImageData(width, height);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
}

/**
 * Render the print on a canvas.
 * @param opts {
 *   ortho: GeoTIFF dataset { images, minE, maxE, minN, maxN, nodata },
 *   extent: UTM extent, longEdge, format: 'png'|'tif',
 *   contours: { features: [{coords:[E,N...], isIndex, label}], interval, units } | null,
 *   colors, propertyLines: [[[E,N],...], ...] | null, propertyStyle: { color } | null,
 *   propertyAttribution: the parcel source and its credit, printed after the "not a survey" note,
 *   units, createCanvas, pool, signal
 * }
 */
export async function renderOrthoPrint({ ortho, extent: requested, longEdge = 4096, format = 'png', contours = null,
  colors = CONTOUR_COLORS.brown, propertyLines = null, propertyStyle = null, propertyAttribution = '', units = 'imperial', createCanvas, pool, signal,
  maxStripPixels } = {}) {
  abortIf(signal);
  const extent = clampExtent(requested, ortho);
  if (!extent) throw Object.assign(new Error('The selected area is outside the orthophoto.'), { code: 'print_outside' });
  const { width, height, gsdE, gsdN } = printLayout(extent, longEdge);
  const print = format !== 'tif';
  let canvas, ctx;
  try {
    canvas = createCanvas(width, height);
    canvas.width = width; canvas.height = height;
    ctx = canvas.getContext('2d');
  } catch { throw tooLarge(); }
  const release = () => { canvas.width = 0; canvas.height = 0; };
  if (!ctx || canvas.width !== width || canvas.height !== height) { release(); throw tooLarge(); }
  const scale = Math.max(1, Math.min(4, Math.max(width, height) / 1600));
  let note = null;
  try {
    // Part of the picture on a PNG only. A GeoTIFF's pixels are map data; its
    // note is a tag (exportOrthoPrint).
    if (print && propertyLines?.length) note = layoutPropertyNote(ctx, { width, height, scale, attribution: propertyAttribution });
    const { rgba } = await renderOrthoPixels({ ds: ortho, extent, width, height, signal, pool, maxStripPixels, background: print ? [255, 255, 255] : null });
    putPixels(ctx, rgba, width, height);
  } catch (error) { release(); if (error instanceof RangeError) throw tooLarge(); throw error; }
  const project = (e, n) => [(e - extent.minE) / gsdE, (extent.maxN - n) / gsdN];
  let drawn = null;
  if (contours?.features?.length) drawn = drawContours(ctx, contours.features, project, { colors, scale, width, height });
  let propertyCount = 0;
  const lineColor = propertyStyle?.color || PROPERTY_LINE.color;
  if (propertyLines?.length) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [style, w] of [[PROPERTY_LINE.halo, PROPERTY_LINE.haloWidth], [lineColor, PROPERTY_LINE.width]]) {
      ctx.beginPath();
      for (const line of propertyLines) {
        line.forEach(([e, n], i) => { const [x, y] = project(e, n); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      }
      ctx.strokeStyle = style; ctx.lineWidth = w * scale; ctx.stroke();
    }
    ctx.restore();
    propertyCount = propertyLines.length;
  }
  if (print) {
    drawLegend(ctx, { width, height, gsdE, units: contours?.units || units, contours, propertyColor: propertyCount ? lineColor : null, bottom: note?.bandHeight || 0, scale, colors });
    if (note) drawPropertyNote(ctx, note, { width, height });
    // A canvas the browser could not back reads as blank: the print's
    // corner is always opaque (white or imagery).
    const corner = ctx.getImageData(width - 1, height - 1, 1, 1).data;
    if (corner[3] !== 255) { release(); throw tooLarge(); }
  }
  return { canvas, ctx, width, height, extent, gsdE, gsdN, contours: drawn, propertyLines: propertyCount, note };
}

// TIFF text tags are 7-bit ASCII ending in NUL.
function tiffAscii(text) {
  const plain = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '?');
  return [...plain].map(c => c.charCodeAt(0)).concat(0);
}

/**
 * RGBA GeoTIFF in the orthophoto's projected CRS (PixelIsArea, north-up):
 * little-endian, uncompressed, one strip. Written directly (header, IFD,
 * then one set() of the pixels) so a 6144 px print encodes without a
 * per-byte JavaScript array.
 * `description` (optional) is the ImageDescription tag.
 */
export function encodePrintGeoTiff({ rgba, width, height, extent, epsg, description = '' }) {
  if (!Number.isInteger(epsg) || epsg <= 0 || epsg > 65535) throw Object.assign(new Error('GeoTIFF needs a verified coordinate reference. Export PNG instead.'), { code: 'print_crs' });
  const pixelBytes = width * height * 4;
  if (rgba.length !== pixelBytes) throw new RangeError('RGBA buffer does not match the image size.');
  const gsdE = (extent.maxE - extent.minE) / width, gsdN = (extent.maxN - extent.minN) / height;
  const ASCII = 2, SHORT = 3, LONG = 4, DOUBLE = 12, size = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
  // GeoKeyDirectory: version 1.1.0, 3 keys: projected model, PixelIsArea, EPSG code.
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg];
  const entries = [ // ascending tag order, as TIFF requires
    [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, [8, 8, 8, 8]], [259, SHORT, [1]], [262, SHORT, [2]],
    ...(description ? [[270, ASCII, tiffAscii(description)]] : []),
    [273, LONG, [0]], [277, SHORT, [4]], [278, LONG, [height]], [279, LONG, [pixelBytes]], [284, SHORT, [1]],
    [338, SHORT, [2]], [339, SHORT, [1, 1, 1, 1]],
    [33550, DOUBLE, [gsdE, gsdN, 0]], [33922, DOUBLE, [0, 0, 0, extent.minE, extent.maxN, 0]], [34735, SHORT, geoKeys],
  ];
  const align = n => n + (n % 8 ? 8 - (n % 8) : 0);
  const ifdOffset = 8;
  let cursor = ifdOffset + 2 + entries.length * 12 + 4;
  const layout = entries.map(([tag, type, values]) => {
    const bytes = values.length * size[type];
    if (bytes <= 4) return { tag, type, values, offset: null };
    cursor = align(cursor);
    const offset = cursor; cursor += bytes;
    return { tag, type, values, offset };
  });
  const stripOffset = align(cursor);
  if (stripOffset + pixelBytes > 0xffffffff) throw new RangeError('Image too large for a classic TIFF.');
  const out = new Uint8Array(stripOffset + pixelBytes);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949); view.setUint16(2, 42, true); view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  const put = (type, at, value) => { if (type === ASCII) view.setUint8(at, value); else if (type === SHORT) view.setUint16(at, value, true); else if (type === LONG) view.setUint32(at, value, true); else view.setFloat64(at, value, true); };
  layout.forEach(({ tag, type, values, offset }, i) => {
    const at = ifdOffset + 2 + i * 12;
    if (tag === 273) values = [stripOffset];
    view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, values.length, true);
    if (offset === null) values.forEach((v, j) => put(type, at + 8 + j * size[type], v));
    else { view.setUint32(at + 8, offset, true); values.forEach((v, j) => put(type, offset + j * size[type], v)); }
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true); // no further IFDs
  out.set(rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), stripOffset);
  return out.buffer;
}

/**
 * `checkpoint()` (optional) runs after each await: after the contours are
 * traced, after the pixels are rendered and after the file is encoded. If it
 * throws, the export stops there, the canvas is released and nothing is returned.
 */
export async function exportOrthoPrint({ format = 'png', epsg = null, traceContours = null, checkpoint = null, ...opts }) {
  const extent = clampExtent(opts.extent, opts.ortho);
  if (!extent) throw Object.assign(new Error('The selected area is outside the orthophoto.'), { code: 'print_outside' });
  if (opts.propertyLines?.length && !cleanAttribution(opts.propertyAttribution)) throw Object.assign(new Error('The property line source is not available. Export without property lines.'), { code: 'print_note' });
  if (format === 'tif' && !(Number.isInteger(epsg) && epsg > 0)) throw Object.assign(new Error('GeoTIFF needs a verified coordinate reference. Export PNG instead.'), { code: 'print_crs' });
  if (format === 'tif' || (epsg && (traceContours || opts.propertyLines?.length))) verifyOrthoCrs(opts.ortho, epsg, { requireDeclared: format === 'tif' });
  const { width, gsdE } = printLayout(extent, opts.longEdge ?? 4096);
  // Trace about one DTM cell per 2.5 output pixels: smooth at print size.
  const contours = traceContours ? await traceContours(extent, gsdE * 2.5) : null;
  checkpoint?.();
  const result = await renderOrthoPrint({ ...opts, extent, format, contours });
  let blob;
  const release = () => { result.canvas.width = 0; result.canvas.height = 0; };
  try {
    checkpoint?.();
    if (format === 'tif') {
      let rgba;
      try { rgba = result.ctx.getImageData(0, 0, result.width, result.height).data; } catch { throw tooLarge(); }
      release(); // the pixels are copied out; free the canvas before encoding
      let buffer = encodePrintGeoTiff({ rgba, width: result.width, height: result.height, extent: result.extent, epsg,
        description: result.propertyLines ? propertyNoteText(opts.propertyAttribution) : '' });
      rgba = null; // drop the read-back copy before the Blob takes its own
      blob = new Blob([buffer], { type: 'image/tiff' });
      buffer = null;
    } else {
      blob = await new Promise((resolve, reject) => result.canvas.toBlob(b => b ? resolve(b) : reject(tooLarge()), 'image/png'));
    }
    checkpoint?.();
  } finally { release(); }
  return { blob, width: result.width, height: result.height, extent: result.extent, contours: result.contours, propertyLines: result.propertyLines,
    filename: `orthophoto${contours?.features?.length ? '-contours' : ''}-${result.width}px.${format === 'tif' ? 'tif' : 'png'}`, gsd: width ? gsdE : null };
}

/**
 * Small dialog: area, size, format, layers. `run(options, signal)` returns
 * { blob, filename }; the dialog saves it with a temporary object URL.
 */
export function mountOrthoPrintDialog({ documentRef = document, openButton, defaults = () => ({}), run }) {
  const el = (tag, props = {}, children = []) => { const n = documentRef.createElement(tag); Object.assign(n, props); n.append(...children); return n; };
  const select = (name, options) => el('select', { name }, options.map(([value, text]) => el('option', { value: String(value), textContent: text })));
  const area = select('area', [['view', 'Current view'], ['full', 'Whole orthophoto']]);
  const size = select('size', PRINT_SIZES.map(s => [s, `${s} px`])); size.value = '4096';
  const format = select('format', [['png', 'PNG'], ['tif', 'GeoTIFF']]);
  const contours = el('input', { type: 'checkbox', name: 'contours' });
  const property = el('input', { type: 'checkbox', name: 'property' });
  const status = el('p', { className: 'hint' }); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const exportButton = el('button', { type: 'button', className: 'tool-btn full', textContent: 'Export' });
  const close = el('button', { type: 'button', className: 'ortho-print-close', textContent: 'Close' });
  const row = (label, control) => el('label', { className: 'slider-row' }, [el('span', { textContent: label }), control]);
  const check = (control, label) => el('label', { className: 'ortho-print-check' }, [control, el('span', { textContent: label })]);
  const dialog = el('dialog', { className: 'ortho-print-dialog' }, [
    el('h2', { textContent: 'Export image' }), close,
    row('Area', area), row('Size', size), row('Format', format),
    check(contours, 'Contour lines'), check(property, 'Property lines'),
    exportButton, status,
  ]);
  dialog.setAttribute('aria-label', 'Export orthophoto image');
  documentRef.body.append(dialog);
  let controller = null;
  const stop = () => { controller?.abort(); controller = null; exportButton.disabled = false; };
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stop);
  openButton?.addEventListener('click', () => {
    const d = defaults() || {};
    contours.disabled = !d.contoursAvailable; contours.checked = Boolean(d.contoursAvailable && d.contoursOn);
    property.disabled = !d.propertyAvailable; property.checked = Boolean(d.propertyAvailable && d.propertyOn);
    // Options the viewer may not use are removed from view, not just greyed.
    const gate = (selectEl, value, allowed, fallback) => {
      const option = selectEl.querySelector(`option[value="${value}"]`);
      option.disabled = !allowed; option.hidden = !allowed;
      if (!allowed && selectEl.value === value) selectEl.value = fallback;
    };
    gate(format, 'tif', Boolean(d.geotiffAvailable), 'png');
    gate(area, 'full', Boolean(d.wholeAvailable), 'view');
    const sizes = Array.isArray(d.sizes) && d.sizes.length ? d.sizes : PRINT_SIZES;
    for (const s of PRINT_SIZES) gate(size, String(s), sizes.includes(s), String(Math.max(...sizes.filter(x => x <= 4096), sizes[0])));
    status.textContent = '';
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  });
  exportButton.addEventListener('click', async () => {
    stop();
    controller = new AbortController();
    const signal = controller.signal;
    exportButton.disabled = true;
    status.textContent = 'Rendering…';
    try {
      const result = await run({ area: area.value, size: Number(size.value), format: format.value, contours: contours.checked, property: property.checked }, signal);
      if (signal.aborted) return;
      // The viewer may have switched to another model, version or viewer since `run` resolved.
      if (result.stillCurrent?.() === false) { status.textContent = ''; return; }
      const url = URL.createObjectURL(result.blob);
      const a = el('a', { href: url, download: result.filename });
      documentRef.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = result.note || `Saved ${result.filename}.`;
    } catch (error) {
      // Cancelled: by Close (the dialog is gone) or by a viewer change (no file, no error).
      if (error?.name === 'AbortError') { if (!signal.aborted) status.textContent = ''; return; }
      status.textContent = error?.code ? error.message : 'Could not export the image. Try a smaller size.';
    } finally { if (!signal.aborted) exportButton.disabled = false; }
  });
  return { dialog, controls: { area, size, format, contours, property, exportButton, status } };
}
