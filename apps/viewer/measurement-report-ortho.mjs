import { isRgbNoData } from './orthophoto-mask.mjs';

const abort = signal => { if (signal?.aborted) throw new DOMException('Report capture cancelled.', 'AbortError'); };
const unavailable = warning => ({ dataUrl: null, width: 0, height: 0, caption: '', warnings: [warning] });

// GeoTIFF resampling may allocate the source window before resizing it. Bound
// both the decoded source and the output; width/height alone is not a budget.
function overview(dataset, maxDimension) {
  return (dataset.images || []).filter(image => {
    const w = image.getWidth(), h = image.getHeight(), fd = image.getFileDirectory();
    const samples = Number(fd.SamplesPerPixel || 1);
    const bits = Array.from(fd.BitsPerSample || [8]);
    return Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 &&
      w * h <= 16_000_000 && w * h * samples <= 64_000_000 &&
      samples >= 1 && samples <= 4 && bits.every(bit => bit === 8) &&
      (fd.PhotometricInterpretation === 2 && samples >= 3 || fd.PhotometricInterpretation === 1 && samples === 1);
  }).sort((a, b) => {
    const aw = Math.max(a.getWidth(), a.getHeight()), bw = Math.max(b.getWidth(), b.getHeight());
    // Prefer the closest overview at or above the desired resolution.
    return (aw >= maxDimension ? aw - maxDimension : (maxDimension - aw) + 1e9) -
      (bw >= maxDimension ? bw - maxDimension : (maxDimension - bw) + 1e9);
  })[0];
}

/** Capture only supplied dataset imagery, without changing a map or camera.
 * Callers supply a permission-checked, same-model snapshot of report records.
 */
export async function captureMeasurementReportOrtho({ dataset, records = [], expectedCrs, signal, pool,
  maxDimension = 2400, createCanvas = () => document.createElement('canvas') } = {}) {
  abort(signal);
  if (!dataset?.images?.length) return unavailable('Orthophoto overview unavailable: this model has no orthophoto.');
  try {
    const base = dataset.images[0], fd = base.getFileDirectory();
    const epsg = Number(base.getGeoKeys()?.ProjectedCSTypeGeoKey);
    const crs = Number.isInteger(epsg) && epsg > 0 && epsg < 32767 ? `EPSG:${epsg}` : null;
    if (!crs || crs !== expectedCrs) return unavailable('Orthophoto overview omitted: its coordinate reference could not be verified against this model.');
    const resolution = base.getResolution();
    if (fd.ModelTransformation || !(resolution[0] > 0 && resolution[1] < 0)) {
      return unavailable('Orthophoto overview omitted: the raster orientation is unsupported.');
    }
    const bounds = base.getBoundingBox();
    const [minE, minN, maxE, maxN] = bounds;
    if (!bounds.every(Number.isFinite) || maxE <= minE || maxN <= minN) return unavailable('Orthophoto overview omitted: raster bounds are invalid.');
    const limit = Math.max(1, Math.min(2400, Math.floor(Number(maxDimension) || 2400)));
    const source = overview(dataset, limit);
    if (!source) return unavailable('Orthophoto overview unavailable: no supported overview fits the report memory limit.');
    // Preserve physical aspect ratio, including non-square source pixels.
    const scale = limit / Math.max(maxE - minE, maxN - minN);
    const width = Math.max(1, Math.round((maxE - minE) * scale));
    const height = Math.max(1, Math.round((maxN - minN) * scale));
    const sourceFd = source.getFileDirectory();
    const rgb = sourceFd.PhotometricInterpretation === 2;
    const samples = rgb ? [0, 1, 2] : [0];
    const hasAlpha = rgb && Number(sourceFd.SamplesPerPixel) === 4 && [1, 2].includes(Number(sourceFd.ExtraSamples?.[0]));
    if (hasAlpha) samples.push(3);
    const raster = await source.readRasters({ samples, width, height, interleave: false, resampleMethod: 'nearest', pool, signal });
    abort(signal);
    const canvas = createCanvas(); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return unavailable('Orthophoto overview unavailable: image rendering is unsupported.');
    const image = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const r = raster[0][i], g = rgb ? raster[1][i] : r, b = rgb ? raster[2][i] : r;
      const missing = !Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || isRgbNoData(r, g, b, dataset.nodata);
      const offset = i * 4;
      image.data[offset] = r || 0; image.data[offset + 1] = g || 0; image.data[offset + 2] = b || 0;
      image.data[offset + 3] = missing ? 0 : hasAlpha ? raster[3][i] : 255;
    }
    ctx.putImageData(image, 0, 0);
    const warnings = [];
    let omitted = 0;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const record of records) {
      const vertices = record.vertices;
      if (record.coordinateReference?.crs !== crs || !Array.isArray(vertices) || !vertices.length ||
        vertices.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { omitted++; continue; }
      const points = vertices.map(p => [(p[0] - minE) / (maxE - minE) * width, (maxN - p[1]) / (maxN - minN) * height]);
      if (points.some(p => p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height)) warnings.push('Some measurement geometry extends beyond the orthophoto footprint and is clipped.');
      ctx.beginPath();
      if (points.length === 1) ctx.arc(points[0][0], points[0][1], Math.max(4, limit / 300), 0, Math.PI * 2);
      else { ctx.moveTo(...points[0]); for (const point of points.slice(1)) ctx.lineTo(...point); if (record.kind === 'polygon') ctx.closePath(); }
      ctx.lineWidth = Math.max(4, limit / 300); ctx.strokeStyle = '#172033'; ctx.stroke();
      ctx.lineWidth = Math.max(2, limit / 600); ctx.strokeStyle = '#ffd84d'; ctx.stroke();
    }
    if (omitted) warnings.push(`${omitted} measurement outline(s) omitted because their coordinates could not be verified.`);
    abort(signal);
    const dataUrl = canvas.toDataURL('image/png');
    abort(signal);
    return { dataUrl, width, height, caption: `Orthophoto overview with measurement outlines (${crs}; grid north up).`, warnings: [...new Set(warnings)] };
  } catch (error) {
    abort(signal);
    if (error?.name === 'AbortError') throw error;
    return unavailable('Orthophoto overview unavailable: the image could not be read or rendered.');
  }
}
