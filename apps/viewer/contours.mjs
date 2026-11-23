// Contour (topographic) lines from a DTM grid, for the map overlay and the
// orthophoto print. Pure functions only: no DOM, no Leaflet, no GeoTIFF.
//
// Pipeline: invalid cells -> NaN, light NaN-aware smoothing, marching squares
// per level with saddle disambiguation, segment stitching into polylines,
// Douglas-Peucker simplification, Chaikin corner cutting. Cells next to
// nodata produce no segments, so lines stop at the DTM's data extent.
//
// DTM values are metres (as the Viewer's DSM/DTM views already read them).
// Levels are chosen in display units (ft or m) so labels are exact multiples
// of the interval, then converted to metres for tracing.

export const METERS_PER_FOOT = 0.3048;
export const CONTOUR_INDEX_EVERY = 5;
export const CONTOUR_MAX_LEVELS = 400;
export const CONTOUR_INTERVALS = Object.freeze({
  imperial: Object.freeze([1, 2, 5, 10, 20, 50]),
  metric: Object.freeze([0.5, 1, 2, 5, 10, 20]),
});

// onX-style: dark brown lines on imagery, light halo behind labels.
export const CONTOUR_COLORS = Object.freeze({
  brown: Object.freeze({ minor: 'rgba(92,58,28,0.82)', index: '#4a2c10', label: '#3d240c', halo: 'rgba(255,248,232,0.92)', casing: 'rgba(255,248,232,0.28)' }),
  tan: Object.freeze({ minor: 'rgba(214,180,126,0.85)', index: '#e2c48f', label: '#f3dfb5', halo: 'rgba(40,26,12,0.85)', casing: 'rgba(40,26,12,0.30)' }),
  white: Object.freeze({ minor: 'rgba(255,255,255,0.72)', index: '#ffffff', label: '#ffffff', halo: 'rgba(0,0,0,0.75)', casing: 'rgba(0,0,0,0.30)' }),
});

export const CONTOUR_STYLE = Object.freeze({
  minorWidth: 1,
  indexWidth: 2.2,
  casingExtra: 1.6,
  fontPx: 12,
  fontWeight: 600,
  haloWidth: 3.5,
  labelSpacingPx: 340,
  labelMinLinePx: 90,
  labelMaxBendDeg: 28,
});

export function contourUnits(displayUnits) { return displayUnits === 'metric' ? 'metric' : 'imperial'; }
export function unitMeters(units) { return contourUnits(units) === 'metric' ? 1 : METERS_PER_FOOT; }
export function unitSuffix(units) { return contourUnits(units) === 'metric' ? 'm' : 'ft'; }

export function intervalOptions(units) { return CONTOUR_INTERVALS[contourUnits(units)]; }

// Smallest standard interval that keeps the full relief to about `target`
// lines; the largest one when even that is too dense.
export function autoContourInterval(minM, maxM, units = 'imperial', target = 40) {
  const list = intervalOptions(units);
  if (!Number.isFinite(minM) || !Number.isFinite(maxM) || maxM <= minM) return list[1];
  const span = (maxM - minM) / unitMeters(units);
  return list.find(step => span / step <= target) ?? list[list.length - 1];
}

function decimalsOf(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

export function formatContourLabel(value, units = 'imperial', interval = 1) {
  const digits = Math.min(3, decimalsOf(interval));
  const n = Number(value.toFixed(digits));
  return `${Object.is(n, -0) ? 0 : n}${unitSuffix(units)}`;
}

// Every multiple of `interval` (display units) inside [minM, maxM] metres.
// Index lines are the multiples of 5 * interval.
export function contourLevels(minM, maxM, interval, units = 'imperial', { maxLevels = CONTOUR_MAX_LEVELS } = {}) {
  const step = Number(interval);
  if (!(step > 0) || !Number.isFinite(minM) || !Number.isFinite(maxM) || maxM < minM) return { levels: [], tooMany: false };
  const u = unitMeters(units);
  const kStart = Math.ceil(minM / u / step - 1e-9), kEnd = Math.floor(maxM / u / step + 1e-9);
  const count = kEnd - kStart + 1;
  if (count > maxLevels) return { levels: [], tooMany: true, count };
  const digits = decimalsOf(step);
  const levels = [];
  for (let k = kStart; k <= kEnd; k++) {
    const value = Number((k * step).toFixed(digits + 2));
    levels.push({
      k,
      value,
      meters: value * u,
      isIndex: ((k % CONTOUR_INDEX_EVERY) + CONTOUR_INDEX_EVERY) % CONTOUR_INDEX_EVERY === 0,
      label: formatContourLabel(value, units, step),
    });
  }
  return { levels, tooMany: false, count: levels.length };
}

// Elevation guard matches the DEM views' statistics (-1000 m .. 10000 m).
export function prepareGrid(values, width, height, nodata = NaN) {
  const n = width * height, out = new Float32Array(n);
  const hasNodata = Number.isFinite(nodata);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    out[i] = (Number.isFinite(v) && v > -1000 && v < 10000 && !(hasNodata && v === nodata)) ? v : NaN;
  }
  return out;
}

// Separable [1,2,1] filter that ignores NaN neighbours; NaN cells stay NaN.
export function smoothGrid(grid, width, height, passes = 1) {
  let src = grid;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x, c = src[i];
        if (c !== c) { tmp[i] = NaN; continue; }
        let sum = 2 * c, w = 2;
        if (x > 0) { const v = src[i - 1]; if (v === v) { sum += v; w += 1; } }
        if (x < width - 1) { const v = src[i + 1]; if (v === v) { sum += v; w += 1; } }
        tmp[i] = sum / w;
      }
    }
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x, c = tmp[i];
        if (c !== c) { out[i] = NaN; continue; }
        let sum = 2 * c, w = 2;
        if (y > 0) { const v = tmp[i - width]; if (v === v) { sum += v; w += 1; } }
        if (y < height - 1) { const v = tmp[i + width]; if (v === v) { sum += v; w += 1; } }
        out[i] = sum / w;
      }
    }
    src = out;
  }
  return src;
}

// Edge codes: 0 top, 1 right, 2 bottom, 3 left. Corner bits: tl 8, tr 4, br 2, bl 1.
const CASES = [
  null, [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], 'saddle5', [[0, 2]], [[3, 0]],
  [[3, 0]], [[0, 2]], 'saddle10', [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], null,
];
const SADDLE_A = [[3, 0], [2, 1]]; // cuts off tl and br
const SADDLE_B = [[0, 1], [3, 2]]; // cuts off tr and bl

function firstAbove(levels, value) {
  let lo = 0, hi = levels.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (levels[mid] > value) hi = mid; else lo = mid + 1; }
  return lo;
}

// Marching squares over all levels at once. Returns, per level, polylines in
// grid coordinates (x = column, y = row of sample centres) as flat arrays.
// `levelMeters` must be sorted ascending (contourLevels() returns them so).
export function traceContours(grid, width, height, levelMeters) {
  const L = levelMeters.length;
  const segs = Array.from({ length: L }, () => ({ keys: [], pts: [] }));
  if (!L || width < 2 || height < 2) return segs.map(() => []);
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      const tl = grid[i], tr = grid[i + 1], bl = grid[i + width], br = grid[i + width + 1];
      if (tl !== tl || tr !== tr || bl !== bl || br !== br) continue;
      const mn = Math.min(tl, tr, bl, br), mx = Math.max(tl, tr, bl, br);
      if (mn === mx) continue;
      for (let li = firstAbove(levelMeters, mn); li < L && levelMeters[li] <= mx; li++) {
        const lv = levelMeters[li];
        const c = (tl >= lv ? 8 : 0) | (tr >= lv ? 4 : 0) | (br >= lv ? 2 : 0) | (bl >= lv ? 1 : 0);
        let pairs = CASES[c];
        if (!pairs) continue;
        if (typeof pairs === 'string') {
          const centreAbove = (tl + tr + bl + br) / 4 >= lv;
          pairs = c === 5 ? (centreAbove ? SADDLE_A : SADDLE_B) : (centreAbove ? SADDLE_B : SADDLE_A);
        }
        const seg = segs[li];
        for (const pair of pairs) {
          for (const edge of pair) {
            let key, px, py;
            if (edge === 0) { key = 2 * i; px = x + (lv - tl) / (tr - tl); py = y; }
            else if (edge === 2) { key = 2 * (i + width); px = x + (lv - bl) / (br - bl); py = y + 1; }
            else if (edge === 3) { key = 2 * i + 1; px = x; py = y + (lv - tl) / (bl - tl); }
            else { key = 2 * (i + 1) + 1; px = x + 1; py = y + (lv - tr) / (br - tr); }
            seg.keys.push(key); seg.pts.push(px, py);
          }
        }
      }
    }
  }
  return segs.map(stitch);
}

function stitch({ keys, pts }) {
  const n = keys.length >> 1;
  if (!n) return [];
  const first = new Map(), second = new Map();
  for (let s = 0; s < n; s++) {
    for (let e = 0; e < 2; e++) {
      const k = keys[2 * s + e];
      if (first.has(k)) second.set(k, s); else first.set(k, s);
    }
  }
  const used = new Uint8Array(n), lines = [];
  const other = (k, s) => { const a = first.get(k); if (a !== undefined && a !== s && !used[a]) return a; const b = second.get(k); return b !== undefined && b !== s && !used[b] ? b : -1; };
  // Follow the chain from segment s leaving through endpoint `end` (0/1).
  const walk = (s, end, out) => {
    let key = keys[2 * s + end], cur = s;
    for (;;) {
      const t = other(key, cur);
      if (t < 0) return key;
      used[t] = 1;
      const e = keys[2 * t] === key ? 1 : 0;
      out.push(pts[4 * t + 2 * e], pts[4 * t + 2 * e + 1]);
      key = keys[2 * t + e]; cur = t;
    }
  };
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = [pts[4 * s], pts[4 * s + 1], pts[4 * s + 2], pts[4 * s + 3]];
    const endKey = walk(s, 1, fwd);
    const back = [];
    const startKey = walk(s, 0, back);
    const flat = new Float64Array(back.length + fwd.length);
    for (let j = back.length - 2, o = 0; j >= 0; j -= 2, o += 2) { flat[o] = back[j]; flat[o + 1] = back[j + 1]; }
    flat.set(fwd, back.length);
    lines.push({ points: flat, closed: endKey === startKey && flat.length > 6 });
  }
  return lines;
}

export function polylineLength(points) {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return length;
}

// Iterative Douglas-Peucker on a flat [x,y,...] array.
export function simplifyLine(points, tolerance) {
  const n = points.length >> 1;
  if (n <= 2 || !(tolerance > 0)) return points;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]], tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[2 * a], ay = points[2 * a + 1], dx = points[2 * b] - ax, dy = points[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[2 * i] - ax, py = points[2 * i + 1] - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else { const cross = px * dy - py * dx; d2 = cross * cross / len2; }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  let count = 0; for (let i = 0; i < n; i++) count += keep[i];
  const out = new Float64Array(count * 2);
  for (let i = 0, o = 0; i < n; i++) if (keep[i]) { out[o++] = points[2 * i]; out[o++] = points[2 * i + 1]; }
  return out;
}

// Chaikin corner cutting. Open lines keep their end points; closed rings
// (first point == last point) stay closed.
export function chaikin(points, iterations = 2, closed = false) {
  let p = points;
  for (let it = 0; it < iterations; it++) {
    const n = p.length >> 1;
    if (n < 3) return p;
    const out = [];
    if (closed) {
      const m = n - 1; // last repeats first
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * j], y1 = p[2 * j + 1];
        out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
      }
      out.push(out[0], out[1]);
    } else {
      out.push(p[0], p[1]);
      for (let i = 0; i < n - 1; i++) {
        const x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * i + 2], y1 = p[2 * i + 3];
        if (i > 0) out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1);
        if (i < n - 2) out.push(0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
      }
      out.push(p[2 * n - 2], p[2 * n - 1]);
    }
    p = Float64Array.from(out);
  }
  return p;
}

/**
 * Contours for one DTM window.
 * @param {object} input
 *   values/width/height/nodata: the raster window (row-major, metres);
 *   levels: from contourLevels(); grid: { minE, maxN, cellE, cellN } outer
 *   edges of the window and cell size in metres (UTM).
 * @returns {Array<{value:number,label:string,isIndex:boolean,closed:boolean,coords:Float64Array}>}
 *   coords are [E,N,E,N,...] in the raster CRS.
 */
export function buildContours({ values, width, height, nodata = NaN, levels, grid,
  smoothPasses = 2, simplifyCells = 0.2, chaikinIterations = 2, minLengthCells = 4 }) {
  if (!levels?.length || width < 2 || height < 2) return [];
  let surface = prepareGrid(values, width, height, nodata);
  if (smoothPasses > 0) surface = smoothGrid(surface, width, height, smoothPasses);
  const meters = levels.map(l => l.meters);
  const traced = traceContours(surface, width, height, meters);
  const features = [];
  const { minE, maxN, cellE, cellN } = grid;
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    for (const line of traced[li]) {
      if (polylineLength(line.points) < minLengthCells) continue;
      let pts = simplifyLine(line.points, simplifyCells);
      if (line.closed) { pts = Float64Array.from([...pts.subarray(0, pts.length - 2), pts[0], pts[1]]); }
      pts = chaikin(pts, chaikinIterations, line.closed);
      const coords = new Float64Array(pts.length);
      for (let i = 0; i < pts.length; i += 2) {
        coords[i] = minE + (pts[i] + 0.5) * cellE;
        coords[i + 1] = maxN - (pts[i + 1] + 0.5) * cellN;
      }
      features.push({ value: level.value, label: level.label, isIndex: level.isIndex, closed: line.closed, coords });
    }
  }
  return features;
}

/**
 * Pick the DTM overview level and read window for an extent: the coarsest
 * level whose cells are no larger than `targetCell` metres, then a resample
 * down to `maxCells` if the window is still too big.
 * @param ds { minE, maxE, minN, maxN, levels: [{ width, height }] } finest first
 */
export function chooseDemWindow(ds, extent, { targetCell, maxCells = 1_200_000 } = {}) {
  const minE = Math.max(ds.minE, extent.minE), maxE = Math.min(ds.maxE, extent.maxE);
  const minN = Math.max(ds.minN, extent.minN), maxN = Math.min(ds.maxN, extent.maxN);
  if (!(maxE > minE && maxN > minN) || !ds.levels?.length) return null;
  const spanE = ds.maxE - ds.minE, spanN = ds.maxN - ds.minN;
  const cells = ds.levels.map(l => ({ cellE: spanE / l.width, cellN: spanN / l.height, width: l.width, height: l.height }));
  let level = 0;
  for (let i = 0; i < cells.length; i++) if (Math.max(cells[i].cellE, cells[i].cellN) <= targetCell * 1.0001) level = i;
  const c = cells[level];
  const x0 = Math.max(0, Math.floor((minE - ds.minE) / c.cellE)), x1 = Math.min(c.width, Math.ceil((maxE - ds.minE) / c.cellE));
  const y0 = Math.max(0, Math.floor((ds.maxN - maxN) / c.cellN)), y1 = Math.min(c.height, Math.ceil((ds.maxN - minN) / c.cellN));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return null;
  let outW = w, outH = h;
  if (w * h > maxCells) {
    const f = Math.sqrt(maxCells / (w * h));
    outW = Math.max(2, Math.floor(w * f)); outH = Math.max(2, Math.floor(h * f));
  }
  return {
    level, window: [x0, y0, x1, y1], outW, outH,
    resampled: outW !== w || outH !== h,
    grid: { minE: ds.minE + x0 * c.cellE, maxN: ds.maxN - y0 * c.cellN, cellE: w * c.cellE / outW, cellN: h * c.cellN / outH },
    extent: { minE: ds.minE + x0 * c.cellE, maxE: ds.minE + x1 * c.cellE, minN: ds.maxN - y1 * c.cellN, maxN: ds.maxN - y0 * c.cellN },
  };
}

/**
 * Label anchors along one projected (pixel) polyline: every `spacing` px,
 * where the line is long and straight enough. Angles keep text upright.
 */
export function placeLabels(points, { spacing = CONTOUR_STYLE.labelSpacingPx, minLength = CONTOUR_STYLE.labelMinLinePx,
  textWidth = 40, maxBendDeg = CONTOUR_STYLE.labelMaxBendDeg } = {}) {
  const n = points.length >> 1;
  if (n < 2) return [];
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(points[2 * i] - points[2 * i - 2], points[2 * i + 1] - points[2 * i - 1]);
  const total = cum[n - 1];
  if (total < Math.max(minLength, textWidth * 1.6)) return [];
  const at = (d) => {
    let lo = 1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    const seg = cum[lo] - cum[lo - 1], t = seg > 0 ? (d - cum[lo - 1]) / seg : 0;
    return [points[2 * lo - 2] + t * (points[2 * lo] - points[2 * lo - 2]), points[2 * lo - 1] + t * (points[2 * lo + 1] - points[2 * lo - 1])];
  };
  const half = textWidth / 2 + 4;
  const anchors = [];
  const count = Math.max(1, Math.floor(total / spacing));
  const step = total / count;
  for (let j = 0; j < count; j++) {
    const d = step * (j + 0.5);
    if (d - half < 0 || d + half > total) continue;
    const a = at(d - half), m = at(d), b = at(d + half);
    const a1 = Math.atan2(m[1] - a[1], m[0] - a[0]), a2 = Math.atan2(b[1] - m[1], b[0] - m[0]);
    let bend = Math.abs(a2 - a1); if (bend > Math.PI) bend = 2 * Math.PI - bend;
    if (bend * 180 / Math.PI > maxBendDeg) continue;
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (angle > Math.PI / 2) angle -= Math.PI; else if (angle < -Math.PI / 2) angle += Math.PI;
    anchors.push({ x: m[0], y: m[1], angle });
  }
  return anchors;
}

/**
 * Draw contour features on a 2D canvas context.
 * @param project (a, b) -> [x, y] pixel position for a feature coordinate pair
 * @param options { colors, scale, width, height, labels }
 * @returns { minor, index, labels } counts drawn
 */
export function drawContours(ctx, features, project, { colors = CONTOUR_COLORS.brown, scale = 1, width = Infinity, height = Infinity,
  labels = true, pad = 32 } = {}) {
  const style = CONTOUR_STYLE;
  const projected = [];
  for (const f of features) {
    const c = f.coords, out = new Float64Array(c.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < c.length; i += 2) {
      const p = project(c[i], c[i + 1]);
      out[i] = p[0]; out[i + 1] = p[1];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < -pad || maxY < -pad || minX > width + pad || minY > height + pad) continue;
    projected.push({ f, pts: out });
  }
  const strokeAll = (list, color, lineWidth) => {
    if (!list.length) return;
    ctx.beginPath();
    for (const { pts } of list) {
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.stroke();
  };
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const minor = projected.filter(p => !p.f.isIndex), index = projected.filter(p => p.f.isIndex);
  strokeAll(minor, colors.minor, style.minorWidth * scale);
  strokeAll(index, colors.casing, (style.indexWidth + style.casingExtra) * scale);
  strokeAll(index, colors.index, style.indexWidth * scale);
  let labelCount = 0;
  if (labels && index.length) {
    const fontPx = style.fontPx * scale;
    ctx.font = `${style.fontWeight} ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const placed = [];
    for (const { f, pts } of index) {
      const textWidth = ctx.measureText(f.label).width;
      const anchors = placeLabels(pts, { spacing: style.labelSpacingPx * scale, minLength: style.labelMinLinePx * scale, textWidth });
      for (const a of anchors) {
        if (a.x < 0 || a.y < 0 || a.x > width || a.y > height) continue;
        const r = textWidth / 2 + fontPx * 0.6;
        if (placed.some(p => Math.hypot(p.x - a.x, p.y - a.y) < p.r + r)) continue;
        placed.push({ x: a.x, y: a.y, r });
        ctx.save();
        ctx.translate(a.x, a.y); ctx.rotate(a.angle);
        ctx.lineWidth = style.haloWidth * scale; ctx.strokeStyle = colors.halo; ctx.strokeText(f.label, 0, 0);
        ctx.fillStyle = colors.label; ctx.fillText(f.label, 0, 0);
        ctx.restore();
        labelCount++;
      }
    }
  }
  ctx.restore();
  return { minor: minor.length, index: index.length, labels: labelCount };
}
