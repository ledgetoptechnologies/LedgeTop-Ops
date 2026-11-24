// Printing one property: finding the parcels, the clip around them, and what
// part of them was captured. Pure geometry plus injected loaders; no DOM.
//
// The clip changes which pixels show, never where they are. It is a choice of
// what to print, not access control: the Viewer still shows the surroundings.
import { expandLonLatBounds, tilesCoverBounds } from './property-lines.mjs';
import { dissolveParcelsByOwner, outlineAreaM2, parcelSoundness } from './property-lines-owners.mjs';
import { printLayout, renderOrthoPixels } from './ortho-print-export.mjs';

export const METERS_PER_FOOT = 0.3048;
// Feet around the property, and trimmed off the edge of the capture.
export const PRINT_DISTANCES_FT = Object.freeze([0, 25, 50, 100]);
export const PRINT_DISTANCE_DEFAULT_FT = 25;
export const PRINT_DISTANCE_MAX_FT = 100;

// Clip mask values.
export const CLIP_HIDE = 0, CLIP_SHOW = 1, CLIP_UNCAPTURED = 2;

export const PRINT_PROPERTY_MESSAGES = Object.freeze({
  none: 'No property here.',
  clipped: 'This property runs past the area property lines cover here.',
  incomplete: 'Property lines could not be fully loaded here. Try again.',
  too_many: 'Too many parcels to load here.',
  unclosed: 'This parcel’s shape is not complete.',
  unsound: 'This parcel’s shape crosses or overlaps itself.',
  unverified: 'This parcel’s shape is too detailed to check.',
  zoom_out: 'Zoom out so the whole property fits in the view.',
  upload: 'An uploaded boundary file cannot be used to choose a property.',
  unavailable: 'Property lines are not available.',
  uncaptured: 'None of this property was captured.',
  choose: 'Choose a property first.',
  stale: 'Choose the property again.',
  georef: 'This model has no verified map position.',
});

export function printPropertyError(reason) {
  return Object.assign(new Error(PRINT_PROPERTY_MESSAGES[reason] || PRINT_PROPERTY_MESSAGES.unavailable), { code: 'print_property', reason });
}

// ── Choosing ─────────────────────────────────────────────────────────────

const ringContains = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export function parcelContains(parcel, [x, y]) {
  return parcel.rings.reduce((inside, ring) => inside !== ringContains(ring, x, y), false);
}

export function boundsOfRings(rings) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
  return { west, south, east, north };
}

const boundsOfOutline = outline => boundsOfRings(outline.parcels.flatMap(parcel => parcel.rings));
const union = (a, b) => ({ west: Math.min(a.west, b.west), south: Math.min(a.south, b.south), east: Math.max(a.east, b.east), north: Math.max(a.north, b.north) });
const within = (a, b) => a.west >= b.west && a.south >= b.south && a.east <= b.east && a.north <= b.north;

// The outline under a point; where several lie over each other, the smallest.
export function outlineAt(outlines, point) {
  let best = null, size = Infinity;
  for (const outline of outlines) {
    if (!outline.parcels.some(parcel => parcelContains(parcel, point))) continue;
    const b = boundsOfOutline(outline), area = (b.east - b.west) * (b.north - b.south);
    if (area < size) { best = outline; size = area; }
  }
  return best;
}

// Why an outline cannot be printed as a property, or null. Its whole shape
// must be known and sound: not clipped by the server, every ring closed, no
// parcel crossing or overlapping itself. Sound parcels whose land cannot be
// added up (outlineAreaM2 null) may be printed, without an acreage.
export function outlineRefusal(outline) {
  if (outline.parcels.some(parcel => Array.isArray(parcel.lines))) return 'clipped';
  const closed = ring => ring.length >= 4 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  if (!outline.parcels.every(parcel => parcel.rings.every(closed))) return 'unclosed';
  const states = outline.parcels.map(parcelSoundness);
  if (states.includes('unsound')) return 'unsound';
  if (states.includes('unverified')) return 'unverified';
  return null;
}

// The property at a point: the owner's touching parcels with `merge`, else
// the single parcel. Loads outward until everything touching it, and the
// widest margin around it, has answered. Refuses (throws) rather than print a
// partial shape.
// load(bounds) -> { status, parcels, loaded: Set, failed, partial }.
export async function resolvePrintProperty({ point, merge, load, marginMeters = PRINT_DISTANCE_MAX_FT * METERS_PER_FOOT, rounds = 8 }) {
  const [lon, lat] = point;
  let bounds = { west: lon - 5e-5, south: lat - 5e-5, east: lon + 5e-5, north: lat + 5e-5 };
  for (let round = 0; round < rounds; round++) {
    const data = await load(bounds);
    if (data.status === 'none') throw printPropertyError('none');
    if (data.status !== 'ok') throw printPropertyError(data.status === 'upload' || data.status === 'too_many' || data.status === 'georef' ? data.status : data.status === 'unavailable' && data.failed ? 'incomplete' : 'unavailable');
    const outlines = dissolveParcelsByOwner(data.parcels, { merge });
    const outline = outlineAt(outlines, point);
    if (!outline) throw printPropertyError(data.failed ? 'incomplete' : data.partial ? 'too_many' : 'none');
    const refusal = outlineRefusal(outline);
    if (refusal) throw printPropertyError(refusal);
    // Everything touching the land, and the neighbours in the margin.
    const need = expandLonLatBounds(boundsOfOutline(outline), marginMeters);
    const covered = box => tilesCoverBounds(data.loaded, box);
    if (covered(need)) {
      return { outline, outlines, bounds: need, areaM2: outlineAreaM2(outline, { merged: merge, covered }) };
    }
    if (within(need, bounds)) throw printPropertyError(data.partial && !data.failed ? 'too_many' : 'incomplete');
    bounds = union(bounds, need);
  }
  throw printPropertyError('incomplete');
}

// Every parcel of an outline in the model's metres.
export function outlineToUtm(outline, latLonToUtm) {
  return outline.parcels.map(parcel => ({ rings: parcel.rings.map(ring => ring.map(([lon, lat]) => latLonToUtm(lat, lon))) }));
}

export function linesToUtm(outlines, latLonToUtm) {
  return outlines.flatMap(outline => outline.lines.map(line => line.map(([lon, lat]) => latLonToUtm(lat, lon))));
}

// The frame around the parcels: their extent, the margin, and a little room
// for the line itself.
export function propertyFrame(parcels, marginMeters) {
  const b = boundsOfRings(parcels.flatMap(parcel => parcel.rings));
  const pad = marginMeters + Math.max(1, Math.max(b.east - b.west, b.north - b.south) * 0.01);
  return { minE: b.west - pad, maxE: b.east + pad, minN: b.south - pad, maxN: b.north + pad };
}

// ── Masks ────────────────────────────────────────────────────────────────

// Output pixels within `radius` px of the parcels (0: inside them), by pixel
// centre: 1 inside, 0 outside. Holes are outside; the margin runs into them.
export function shapeMask(parcels, { width, height, project, radius = 0 }) {
  const mask = new Uint8Array(width * height);
  const fill = (y, from, to) => {
    const x0 = Math.max(0, Math.ceil(from - 0.5)), x1 = Math.min(width, Math.floor(to - 0.5) + 1);
    if (x1 > x0) mask.fill(1, y * width + x0, y * width + x1);
  };
  for (const parcel of parcels) {
    const rings = parcel.rings.map(ring => ring.map(([e, n]) => project(e, n)));
    // Scan lines: crossings of this parcel's own edges, filled between pairs.
    const rows = new Map();
    for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const [a, b] = ring[i - 1][1] <= ring[i][1] ? [ring[i - 1], ring[i]] : [ring[i], ring[i - 1]];
      for (let y = Math.max(0, Math.ceil(a[1] - 0.5)); y < height && y + 0.5 < b[1]; y++) {
        if (y + 0.5 < a[1]) continue;
        const x = a[0] + (b[0] - a[0]) * (y + 0.5 - a[1]) / (b[1] - a[1]);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push(x);
      }
    }
    for (const [y, xs] of rows) { xs.sort((p, q) => p - q); for (let i = 1; i < xs.length; i += 2) fill(y, xs[i - 1], xs[i]); }
    if (!(radius > 0)) continue;
    // The band within `radius` of each edge: one run of pixels per row.
    for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i], length = Math.hypot(bx - ax, by - ay);
      const nx = length ? -(by - ay) / length * radius : 0, ny = length ? (bx - ax) / length * radius : 0;
      const sides = [[ax + nx, ay + ny, bx + nx, by + ny], [ax - nx, ay - ny, bx - nx, by - ny]];
      for (let y = Math.max(0, Math.ceil(Math.min(ay, by) - radius - 0.5)); y < height && y + 0.5 <= Math.max(ay, by) + radius; y++) {
        const yc = y + 0.5;
        let lo = Infinity, hi = -Infinity;
        const add = x => { lo = Math.min(lo, x); hi = Math.max(hi, x); };
        for (const [cx, cy] of [[ax, ay], [bx, by]]) { const d = radius * radius - (yc - cy) ** 2; if (d >= 0) { add(cx - Math.sqrt(d)); add(cx + Math.sqrt(d)); } }
        for (const [x0, y0, x1, y1] of sides) if (y0 !== y1 && yc >= Math.min(y0, y1) && yc <= Math.max(y0, y1)) add(x0 + (x1 - x0) * (yc - y0) / (y1 - y0));
        if (hi >= lo) fill(y, lo, hi);
      }
    }
  }
  return mask;
}

// Squared distances to the nearest zero, one line (Felzenszwalb, Huttenlocher).
function distanceLine(f, n, step, out, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + (q * step) ** 2) - (f[p] + (p * step) ** 2)) / (2 * step * step * (q - p));
      if (s > z[k] || k === 0) break;
      k--;
    }
    if (s > z[k]) k++;
    v[k] = q; z[k] = k ? s : -Infinity; z[k + 1] = Infinity;
  }
  for (let q = 0, j = 0; q < n; q++) { while (z[j + 1] < q) j++; out[q] = ((q - v[j]) * step) ** 2 + f[v[j]]; }
}

// Uncaptured specks smaller than this inside the capture are not an edge.
export const CAPTURE_SPECK_M2 = 25;

/**
 * Which ground was captured, and how far inside the edge of the capture each
 * place is. `alpha` covers `extent` (the whole orthophoto): below 128 is no
 * imagery. Everything past the raster is uncaptured.
 */
export function captureMask({ alpha, width, height, extent }) {
  const cellE = (extent.maxE - extent.minE) / width, cellN = (extent.maxN - extent.minN) / height;
  const captured = new Uint8Array(width * height);
  for (let i = 0; i < captured.length; i++) captured[i] = alpha[i] >= 128 ? 1 : 0;
  // Fill specks: uncaptured patches that do not reach the raster edge and are tiny.
  const seen = new Uint8Array(captured.length), limit = CAPTURE_SPECK_M2 / (cellE * cellN);
  for (let start = 0; start < captured.length; start++) {
    if (captured[start] || seen[start]) continue;
    const patch = [start];
    let edge = false;
    seen[start] = 1;
    for (let k = 0; k < patch.length; k++) {
      const i = patch[k], x = i % width, y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1])
        if (j >= 0 && !captured[j] && !seen[j]) { seen[j] = 1; patch.push(j); }
    }
    if (!edge && patch.length < limit) for (const i of patch) captured[i] = 1;
  }
  // Exact distances on a grid with an uncaptured border all round.
  const w = width + 2, h = height + 2, far = 1e12;
  const grid = new Float64Array(w * h);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (captured[y * width + x]) grid[(y + 1) * w + x + 1] = far;
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    distanceLine(f, h, cellN, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    distanceLine(f, w, cellE, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  // From cell centres: the edge itself is up to half a cell nearer.
  const half = Math.max(cellE, cellN) / 2, inside = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) inside[y * width + x] = Math.max(0, Math.sqrt(grid[(y + 1) * w + x + 1]) - half);
  const index = (e, northing) => {
    const x = Math.floor((e - extent.minE) / cellE), y = Math.floor((extent.maxN - northing) / cellN);
    return x >= 0 && y >= 0 && x < width && y < height ? y * width + x : -1;
  };
  return {
    extent, width, height, cellE, cellN,
    captured: (e, northing) => { const i = index(e, northing); return i >= 0 && captured[i] === 1; },
    // Metres inside the edge of the capture; 0 where nothing was captured.
    inside: (e, northing) => { const i = index(e, northing); return i >= 0 && captured[i] ? inside[i] : 0; },
  };
}

/** Read the capture mask from a coarse overview of the whole orthophoto. */
export async function readCaptureMask(ortho, { signal, pool, maxEdge = 2048 } = {}) {
  const extent = { minE: ortho.minE, maxE: ortho.maxE, minN: ortho.minN, maxN: ortho.maxN };
  const longest = Math.max(ortho.images[0].getWidth(), ortho.images[0].getHeight());
  const { width, height } = printLayout(extent, Math.min(maxEdge, longest));
  const { rgba } = await renderOrthoPixels({ ds: ortho, extent, width, height, signal, pool });
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return captureMask({ alpha, width, height, extent });
}

// What a print shows, pixel by pixel. With parcels: all captured ground inside
// them, uncaptured ground inside them marked as such, and the margin ring less
// the trimmed edge of the capture. Without: the whole capture less that edge.
// The trim never takes anything inside the property.
export function printClip({ width, height, extent, parcels = null, marginMeters = 0, trimMeters = 0, capture }) {
  const gsdE = (extent.maxE - extent.minE) / width, gsdN = (extent.maxN - extent.minN) / height;
  const project = (e, n) => [(e - extent.minE) / gsdE, (extent.maxN - n) / gsdN];
  const own = parcels ? shapeMask(parcels, { width, height, project }) : null;
  const ring = parcels ? shapeMask(parcels, { width, height, project, radius: marginMeters / Math.min(gsdE, gsdN) }) : null;
  const mask = new Uint8Array(width * height);
  let uncaptured = 0;
  for (let y = 0; y < height; y++) {
    const n = extent.maxN - (y + 0.5) * gsdN;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (ring && !ring[i]) continue;
      const e = extent.minE + (x + 0.5) * gsdE;
      if (own?.[i]) {
        if (capture.captured(e, n)) mask[i] = CLIP_SHOW; else { mask[i] = CLIP_UNCAPTURED; uncaptured++; }
      } else if (capture.captured(e, n) && capture.inside(e, n) >= trimMeters) mask[i] = CLIP_SHOW;
    }
  }
  return { mask, uncaptured };
}

// How much of the property was captured: `fraction`, a whole `percent` that
// says 100 only when nothing visible is missing, and whether captured ground
// inside it lies within the trimmed edge.
export function propertyCoverage({ parcels, capture, trimMeters = 0, edge = 1024 }) {
  const b = boundsOfRings(parcels.flatMap(parcel => parcel.rings));
  const extent = { minE: b.west, maxE: b.east, minN: b.south, maxN: b.north };
  const { width, height, gsdE, gsdN } = printLayout(extent, edge);
  const mask = shapeMask(parcels, { width, height, project: (e, n) => [(e - extent.minE) / gsdE, (extent.maxN - n) / gsdN] });
  let total = 0, captured = 0, near = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    total++;
    const e = extent.minE + (x + 0.5) * gsdE, n = extent.maxN - (y + 0.5) * gsdN;
    if (!capture.captured(e, n)) continue;
    captured++;
    if (capture.inside(e, n) < trimMeters) near++;
  }
  const fraction = total ? captured / total : 0;
  const percent = captured === 0 ? 0 : captured === total ? 100 : Math.max(1, Math.min(99, Math.round(fraction * 100)));
  return { fraction, percent, nearEdge: near > 0 };
}

// The status line after a property print: only what the viewer should know.
export function coverageNote({ percent, nearEdge }) {
  return [percent < 100 ? `${percent}% of this property was captured.` : '',
    nearEdge ? 'Part of this property is near the edge of the capture and may be distorted.' : ''].filter(Boolean).join(' ');
}

