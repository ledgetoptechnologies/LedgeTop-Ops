// Orthophoto print: a high-resolution, grid-north-up image of the published
// orthophoto with contour lines (and optionally property lines) burned in.
// PNG for printing (white background, small legend and scale bar) or a
// georeferenced RGBA GeoTIFF in the orthophoto's own projected CRS.
import { CONTOUR_COLORS, CONTOUR_INDEX_EVERY, drawContours, unitMeters, unitSuffix } from './contours.mjs';
import { isRgbNoData } from './orthophoto-mask.mjs';

export const PRINT_SIZES = Object.freeze([2048, 4096, 6144]);
export const PRINT_STRIP_SOURCE_PIXELS = 12_000_000;
const PROPERTY_LINE = Object.freeze({ color: '#FFD60A', halo: 'rgba(17,17,17,0.55)', width: 2.5, haloWidth: 5 });

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

function drawLegend(ctx, { width, height, gsdE, units, contours, scale, colors }) {
  const pad = 10 * scale, line = 18 * scale;
  const u = unitMeters(units), suffix = unitSuffix(units);
  const barUnits = niceLength((width * 0.18) * gsdE / u);
  const barPx = barUnits * u / gsdE;
  const rows = [];
  if (contours) rows.push(`Contours ${contours.interval} ${suffix} · index every ${+(contours.interval * CONTOUR_INDEX_EVERY).toFixed(3)} ${suffix}`);
  rows.push('Grid north up');
  ctx.save();
  ctx.font = `600 ${12 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textW = Math.max(...rows.map(t => ctx.measureText(t).width), barPx + 70 * scale);
  const boxW = textW + pad * 2 + (contours ? 34 * scale : 0), boxH = pad * 2 + line * (rows.length + 1) + 6 * scale;
  const x = 14 * scale, y = height - boxH - 14 * scale;
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
  const tx = x + pad + (contours ? 34 * scale : 0);
  for (const row of rows) { ctx.fillText(row, tx, cy); cy += line; }
  // scale bar
  const by = cy + 2 * scale;
  ctx.fillStyle = '#1b1b1b'; ctx.fillRect(tx, by - 3 * scale, barPx, 6 * scale);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(tx + barPx / 2, by - 2 * scale, barPx / 2 - 1 * scale, 4 * scale);
  ctx.fillStyle = '#1b1b1b'; ctx.fillText(`${barUnits.toLocaleString('en-US')} ${suffix}`, tx + barPx + 8 * scale, by);
  ctx.restore();
}

/**
 * Render the print on a canvas.
 * @param opts {
 *   ortho: GeoTIFF dataset { images, minE, maxE, minN, maxN, nodata },
 *   extent: UTM extent, longEdge, format: 'png'|'tif',
 *   contours: { features: [{coords:[E,N...], isIndex, label}], interval, units } | null,
 *   colors, propertyLines: [[[E,N],...], ...] | null, units, createCanvas, pool, signal
 * }
 */
export async function renderOrthoPrint({ ortho, extent: requested, longEdge = 4096, format = 'png', contours = null,
  colors = CONTOUR_COLORS.brown, propertyLines = null, units = 'imperial', createCanvas, pool, signal,
  maxStripPixels } = {}) {
  abortIf(signal);
  const extent = clampExtent(requested, ortho);
  if (!extent) throw Object.assign(new Error('The selected area is outside the orthophoto.'), { code: 'print_outside' });
  const { width, height, gsdE, gsdN } = printLayout(extent, longEdge);
  const print = format !== 'tif';
  const { rgba, level } = await renderOrthoPixels({ ds: ortho, extent, width, height, signal, pool, maxStripPixels, background: print ? [255, 255, 255] : null });
  const canvas = createCanvas(width, height);
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);
  const scale = Math.max(1, Math.min(4, Math.max(width, height) / 1600));
  const project = (e, n) => [(e - extent.minE) / gsdE, (extent.maxN - n) / gsdN];
  let drawn = null;
  if (contours?.features?.length) drawn = drawContours(ctx, contours.features, project, { colors, scale, width, height });
  let propertyCount = 0;
  if (propertyLines?.length) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [style, w] of [[PROPERTY_LINE.halo, PROPERTY_LINE.haloWidth], [PROPERTY_LINE.color, PROPERTY_LINE.width]]) {
      ctx.beginPath();
      for (const line of propertyLines) {
        line.forEach(([e, n], i) => { const [x, y] = project(e, n); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      }
      ctx.strokeStyle = style; ctx.lineWidth = w * scale; ctx.stroke();
    }
    ctx.restore();
    propertyCount = propertyLines.length;
  }
  if (print) drawLegend(ctx, { width, height, gsdE, units: contours?.units || units, contours, scale, colors });
  return { canvas, ctx, width, height, extent, gsdE, gsdN, level, contours: drawn, propertyLines: propertyCount };
}

/** RGBA GeoTIFF in the orthophoto's projected CRS (PixelIsArea, north-up). */
export function encodePrintGeoTiff({ rgba, width, height, extent, epsg, writeArrayBuffer }) {
  if (!Number.isInteger(epsg) || epsg <= 0) throw Object.assign(new Error('GeoTIFF needs a verified coordinate reference. Export PNG instead.'), { code: 'print_crs' });
  const gsdE = (extent.maxE - extent.minE) / width, gsdN = (extent.maxN - extent.minN) / height;
  return writeArrayBuffer(rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    width, height,
    BitsPerSample: [8, 8, 8, 8], SamplesPerPixel: 4, PhotometricInterpretation: 2, ExtraSamples: 2, SampleFormat: [1, 1, 1, 1],
    ModelPixelScale: [gsdE, gsdN, 0], ModelTiepoint: [0, 0, 0, extent.minE, extent.maxN, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: epsg,
  });
}

export async function exportOrthoPrint({ format = 'png', epsg = null, writeArrayBuffer, traceContours = null, ...opts }) {
  const extent = clampExtent(opts.extent, opts.ortho);
  if (!extent) throw Object.assign(new Error('The selected area is outside the orthophoto.'), { code: 'print_outside' });
  if (format === 'tif' && !(Number.isInteger(epsg) && epsg > 0)) throw Object.assign(new Error('GeoTIFF needs a verified coordinate reference. Export PNG instead.'), { code: 'print_crs' });
  const { width, gsdE } = printLayout(extent, opts.longEdge ?? 4096);
  // Trace about one DTM cell per 2.5 output pixels: smooth at print size.
  const contours = traceContours ? await traceContours(extent, gsdE * 2.5) : null;
  const result = await renderOrthoPrint({ ...opts, extent, format, contours });
  let blob;
  if (format === 'tif') {
    const rgba = result.ctx.getImageData(0, 0, result.width, result.height).data;
    const buffer = encodePrintGeoTiff({ rgba, width: result.width, height: result.height, extent: result.extent, epsg, writeArrayBuffer });
    blob = new Blob([buffer], { type: 'image/tiff' });
  } else {
    blob = await new Promise((resolve, reject) => result.canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed.')), 'image/png'));
  }
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
    format.querySelector('option[value="tif"]').disabled = !d.geotiffAvailable;
    if (!d.geotiffAvailable) format.value = 'png';
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
      const url = URL.createObjectURL(result.blob);
      const a = el('a', { href: url, download: result.filename });
      documentRef.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = `Saved ${result.filename}.`;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      status.textContent = error?.code ? error.message : 'Could not export the image. Try a smaller size.';
    } finally { if (!signal.aborted) exportButton.disabled = false; }
  });
  return { dialog, controls: { area, size, format, contours, property, exportButton, status } };
}
