// Property (parcel) lines: pure geometry, gating and request logic shared by
// the Viewer's map views, 3D views and tests. No DOM, no network defaults.
//
// Source today: the Wisconsin Statewide Parcel Map, read through this Viewer's
// own server (server/propertyLines.js), which asks the state's public service
// for geometry only. Other boundary sources (for example an uploaded surveyor
// file) can later supply the same `{ id, rings: [[[lon, lat], ...]] }` shape.

export const WEB_MERCATOR_RADIUS = 6378137;
const DEG = Math.PI / 180;

// Browser-side request limits. The server enforces its own, equal or stricter.
export const PROPERTY_LINES_LIMITS = Object.freeze({
  marginMeters: 60,          // around the model's extent
  snapMeters: 50,            // request grid, improves cache reuse
  maxSpanDegrees: 0.06,      // per side; about 4.7 km east-west in Wisconsin
  debounceMs: 350,
  cacheEntries: 24,
  densifyMeters: 2,          // 3D draping sample spacing
  maxDrawVertices: 120000,
});

export function lonLatToWebMercator(lon, lat) {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  return [WEB_MERCATOR_RADIUS * Number(lon) * DEG,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG / 2))];
}

export function webMercatorToLonLat(x, y) {
  return [Number(x) / WEB_MERCATOR_RADIUS / DEG,
    (2 * Math.atan(Math.exp(Number(y) / WEB_MERCATOR_RADIUS)) - Math.PI / 2) / DEG];
}

// A deliberately generous outline of Wisconsin (lon, lat), pushed outward past
// the border rivers and into the Great Lakes. It only decides whether to offer
// the layer: a site just across the border is offered and then simply finds no
// parcels, while a site clearly elsewhere is told the layer is not available.
export const WISCONSIN_OUTLINE = Object.freeze([
  [-91.25, 42.40], [-91.30, 43.05], [-91.40, 43.80], [-92.05, 44.30], [-92.40, 44.50],
  [-92.95, 44.75], [-92.95, 45.45], [-92.45, 46.00], [-92.40, 46.70], [-92.25, 46.80],
  [-91.00, 47.00], [-90.40, 47.15], [-90.20, 46.62], [-89.00, 46.30], [-88.60, 46.10],
  [-87.95, 46.00], [-87.55, 45.45], [-86.70, 45.45], [-86.70, 42.40],
].map(Object.freeze));

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isValidLonLatBounds(b) {
  return Boolean(b) && [b.west, b.south, b.east, b.north].every(Number.isFinite)
    && b.west >= -180 && b.east <= 180 && b.south >= -85 && b.north <= 85
    && b.west < b.east && b.south < b.north;
}

// 'inside' when the extent touches the outline, otherwise 'outside'.
export function wisconsinCoverage(bounds) {
  if (!isValidLonLatBounds(bounds)) return 'unknown';
  const { west, south, east, north } = bounds;
  const probes = [[west, south], [east, south], [east, north], [west, north], [(west + east) / 2, (south + north) / 2]];
  if (probes.some(([lon, lat]) => pointInRing(lon, lat, WISCONSIN_OUTLINE))) return 'inside';
  if (WISCONSIN_OUTLINE.some(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north)) return 'inside';
  return 'outside';
}

// The same rule the measurement export uses: an explicit, consistent UTM zone
// and hemisphere. Anything else is a local frame and must not be guessed.
export function verifiedUtmGeoref(georef, projection) {
  const lon0 = georef?.utmZoneLon0Deg;
  if (!Number.isFinite(lon0) || !['N', 'S'].includes(georef?.hemisphere)) return false;
  const zone = (lon0 + 183) / 6;
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return false;
  if (projection && (projection.zoneLon0Deg !== lon0 || projection.hemisphere !== georef.hemisphere)) return false;
  // The scene frame also needs its origin and model centre (as the server's
  // complete-georeference check does); without them positions are guesses.
  const rtc = georef?.rtc, center = georef?.bboxCenter;
  return Boolean(rtc && center) && ['e', 'n', 'z'].every(key => Number.isFinite(Number(rtc[key])))
    && ['x', 'y', 'z'].every(key => Number.isFinite(Number(center[key])));
}

// UTM rectangle -> enclosing lon/lat bounds (corners and edge midpoints, since
// grid convergence rotates the rectangle slightly).
export function utmExtentToLonLatBounds(extent, utmToLatLon) {
  if (!extent || ![extent.minE, extent.minN, extent.maxE, extent.maxN].every(Number.isFinite)) return null;
  if (extent.minE >= extent.maxE || extent.minN >= extent.maxN) return null;
  const midE = (extent.minE + extent.maxE) / 2, midN = (extent.minN + extent.maxN) / 2;
  const samples = [[extent.minE, extent.minN], [extent.maxE, extent.minN], [extent.maxE, extent.maxN], [extent.minE, extent.maxN],
    [midE, extent.minN], [extent.maxE, midN], [midE, extent.maxN], [extent.minE, midN]];
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const [e, n] of samples) {
    const [lat, lon] = utmToLatLon(e, n);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
  }
  const bounds = { west, south, east, north };
  return isValidLonLatBounds(bounds) ? bounds : null;
}

export function expandLonLatBounds(bounds, meters) {
  if (!isValidLonLatBounds(bounds)) return null;
  const midLat = (bounds.south + bounds.north) / 2;
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.max(0.01, Math.cos(midLat * DEG)));
  return { west: bounds.west - dLon, south: bounds.south - dLat, east: bounds.east + dLon, north: bounds.north + dLat };
}

export function intersectLonLatBounds(a, b) {
  if (!isValidLonLatBounds(a) || !isValidLonLatBounds(b)) return null;
  const result = { west: Math.max(a.west, b.west), south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east), north: Math.min(a.north, b.north) };
  return isValidLonLatBounds(result) ? result : null;
}

// Snap outward to a Web Mercator grid so small pans reuse the same request.
export function snapLonLatBounds(bounds, snapMeters = PROPERTY_LINES_LIMITS.snapMeters) {
  if (!isValidLonLatBounds(bounds)) return null;
  const [x0, y0] = lonLatToWebMercator(bounds.west, bounds.south);
  const [x1, y1] = lonLatToWebMercator(bounds.east, bounds.north);
  const s = snapMeters;
  const [west, south] = webMercatorToLonLat(Math.floor(x0 / s) * s, Math.floor(y0 / s) * s);
  const [east, north] = webMercatorToLonLat(Math.ceil(x1 / s) * s, Math.ceil(y1 / s) * s);
  const round = value => Math.round(value * 1e6) / 1e6;
  const snapped = { west: round(west), south: round(south), east: round(east), north: round(north) };
  return isValidLonLatBounds(snapped) ? snapped : null;
}

export function boundsKey(b) {
  return [b.west, b.south, b.east, b.north].map(value => value.toFixed(6)).join(',');
}

export function boundsTooLarge(b, maxSpan = PROPERTY_LINES_LIMITS.maxSpanDegrees) {
  return b.east - b.west > maxSpan || b.north - b.south > maxSpan;
}

// Area in view, bounded by the model's extent plus a margin. Without a view
// (3D), the whole model extent plus margin is used.
export function propertyLinesRequestBounds({ modelBounds, viewBounds = null, marginMeters = PROPERTY_LINES_LIMITS.marginMeters, snapMeters = PROPERTY_LINES_LIMITS.snapMeters } = {}) {
  const site = expandLonLatBounds(modelBounds, marginMeters);
  if (!site) return { status: 'unknown', bounds: null };
  const area = viewBounds ? intersectLonLatBounds(site, viewBounds) : site;
  if (!area) return { status: 'out_of_view', bounds: null };
  const bounds = snapLonLatBounds(area, snapMeters);
  if (!bounds) return { status: 'unknown', bounds: null };
  if (boundsTooLarge(bounds)) return { status: 'too_many', bounds: null };
  return { status: 'ok', bounds };
}

// Whether this viewer may show the toggle at all, and why not.
export function propertyLinesAvailability({ offered, georefVerified, modelBounds }) {
  if (!offered) return { available: false, reason: 'not_offered' };
  if (!georefVerified) return { available: false, reason: 'unverified' };
  if (!modelBounds) return { available: true, reason: 'pending' };
  if (wisconsinCoverage(modelBounds) === 'outside') return { available: false, reason: 'outside' };
  return { available: true, reason: null };
}

export const PROPERTY_LINES_MESSAGES = Object.freeze({
  unverified: 'Not available: this model has no verified map position.',
  outside: 'Not available for this location (Wisconsin only).',
  pending: 'Waiting for the model to load…',
  off: '',
  loading: 'Loading property lines…',
  none: 'No property lines found here.',
  too_many: 'Too many parcels to show at this zoom. Zoom in.',
  too_many_3d: 'Too many parcels to show for this site.',
  out_of_view: 'Move the map over the site to see property lines.',
  unavailable: 'Property lines service unavailable. Try again later.',
  forbidden: 'Property lines are not available for this link.',
});

export function propertyLinesMessage(status, { count = 0, threeD = false } = {}) {
  if (status === 'ready') return `${count} parcel${count === 1 ? '' : 's'} shown.`;
  if (status === 'too_many' && threeD) return PROPERTY_LINES_MESSAGES.too_many_3d;
  return PROPERTY_LINES_MESSAGES[status] ?? '';
}

// Debounced, cancellable, cached fetch of parcels for one bounding box at a
// time. Only the newest request may resolve into the layer.
export function createParcelFetcher({ fetchImpl, endpoint = '/api/v1/property-lines/parcels', headers = () => ({}), model = () => '',
  debounceMs = PROPERTY_LINES_LIMITS.debounceMs, cacheEntries = PROPERTY_LINES_LIMITS.cacheEntries,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const cache = new Map();
  let timer = null, waiting = null, controller = null, generation = 0, stats = { requests: 0, aborted: 0, cacheHits: 0 };
  const ABORTED = () => ({ status: 'aborted', parcels: [] });
  // A debounced call that never ran is settled as superseded, never left hanging.
  function settleWaiting() {
    if (timer) { clearTimer(timer); timer = null; }
    if (waiting) { const resolve = waiting; waiting = null; resolve(ABORTED()); }
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheEntries) cache.delete(cache.keys().next().value);
  }

  async function load(bounds) {
    const box = boundsKey(bounds), modelId = String(model() || '');
    const key = `${modelId}|${box}`;
    if (cache.has(key)) {
      stats.cacheHits++;
      const value = cache.get(key);
      remember(key, value);
      return value;
    }
    controller?.abort();
    const own = new AbortController();
    controller = own;
    stats.requests++;
    try {
      const url = `${endpoint}?bbox=${encodeURIComponent(box)}&model=${encodeURIComponent(modelId)}`;
      const response = await fetchImpl(url, { headers: headers(), signal: own.signal, credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) return { status: 'forbidden', parcels: [] };
      if (!response.ok) return { status: 'unavailable', parcels: [] };
      const body = await response.json();
      const result = normalizeParcelResponse(body);
      if (result.status !== 'unavailable') remember(key, result);
      return result;
    } catch (error) {
      if (own.signal.aborted || error?.name === 'AbortError') { stats.aborted++; return { status: 'aborted', parcels: [] }; }
      return { status: 'unavailable', parcels: [] };
    } finally {
      if (controller === own) controller = null;
    }
  }

  return {
    // Resolves with the result for the latest call, or { status: 'aborted' }
    // for any call superseded before it finished.
    request(bounds, { immediate = false } = {}) {
      const token = ++generation;
      settleWaiting();
      return new Promise(resolve => {
        const run = async () => {
          timer = null; waiting = null;
          if (token !== generation) return resolve(ABORTED());
          const result = await load(bounds);
          resolve(token === generation ? result : ABORTED());
        };
        if (immediate || debounceMs <= 0) run();
        else { waiting = resolve; timer = setTimer(run, debounceMs); }
      });
    },
    cancel() {
      generation++;
      settleWaiting();
      if (controller) { controller.abort(); controller = null; }
    },
    stats: () => ({ ...stats, cached: cache.size }),
  };
}

// Accept only the documented shape; drop anything else (including any
// attribute the server should never have sent).
export function normalizeParcelResponse(body) {
  const status = ['ok', 'none', 'too_many', 'outside'].includes(body?.status) ? body.status : 'unavailable';
  if (status !== 'ok') return { status, parcels: [] };
  const parcels = [];
  for (const parcel of Array.isArray(body.parcels) ? body.parcels : []) {
    const rings = [];
    for (const ring of Array.isArray(parcel?.rings) ? parcel.rings : []) {
      if (!Array.isArray(ring)) continue;
      const clean = ring.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
        && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85).map(p => [p[0], p[1]]);
      if (clean.length >= 2) rings.push(clean);
    }
    if (rings.length) parcels.push({ id: Number.isSafeInteger(parcel.id) ? parcel.id : null, rings });
  }
  return { status: parcels.length ? 'ok' : 'none', parcels };
}

// Parcels (lon/lat) -> UTM polylines, densified so 3D lines can follow the
// ground between corners. Shared parcel edges are drawn once per parcel; the
// overdraw is harmless and keeps each parcel's ring intact.
export function parcelsToUtmPolylines(parcels, latLonToUtm, { densifyMeters = PROPERTY_LINES_LIMITS.densifyMeters, maxVertices = PROPERTY_LINES_LIMITS.maxDrawVertices } = {}) {
  const lines = [];
  let vertices = 0;
  for (const parcel of parcels) {
    for (const ring of parcel.rings) {
      const line = [];
      for (let i = 0; i < ring.length; i++) {
        const [e, n] = latLonToUtm(ring[i][1], ring[i][0]);
        if (!Number.isFinite(e) || !Number.isFinite(n)) { line.length = 0; break; }
        if (i > 0 && densifyMeters > 0) {
          const [pe, pn] = line[line.length - 1];
          const steps = Math.min(500, Math.floor(Math.hypot(e - pe, n - pn) / densifyMeters));
          for (let s = 1; s < steps; s++) line.push([pe + (e - pe) * s / steps, pn + (n - pn) * s / steps]);
        }
        line.push([e, n]);
      }
      if (line.length < 2) continue;
      vertices += line.length;
      if (vertices > maxVertices) return { lines, truncated: true };
      lines.push(line);
    }
  }
  return { lines, truncated: false };
}

// Bilinear sample of a north-up raster window. Returns NaN for no-data.
export function sampleGrid(grid, e, n) {
  const { values, width, height, minE, maxN, cellE, cellN, nodata } = grid;
  const fx = (e - minE) / cellE - 0.5, fy = (maxN - n) / cellN - 0.5;
  if (!(fx >= -0.5 && fy >= -0.5 && fx <= width - 0.5 && fy <= height - 0.5)) return NaN;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const read = (x, y) => { const v = values[y * width + x]; return Number.isFinite(v) && v !== nodata && v > -1000 && v < 10000 ? v : NaN; };
  const a = read(x0, y0), b = read(x1, y0), c = read(x0, y1), d = read(x1, y1);
  const weights = [[a, (1 - tx) * (1 - ty)], [b, tx * (1 - ty)], [c, (1 - tx) * ty], [d, tx * ty]].filter(([v, w]) => Number.isFinite(v) && w > 0);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return Number.isFinite(a) ? a : NaN;
  return weights.reduce((sum, [v, w]) => sum + v * w, 0) / total;
}

// Use ground heights only when they agree with the scene; a datum or unit
// mismatch must fall back to a flat, stated height rather than float lines.
export function groundHeightsConsistent(samples, { minAlt, maxAlt, toleranceMeters = 15 } = {}) {
  const finite = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length < Math.max(3, samples.length * 0.5)) return false;
  if (!Number.isFinite(minAlt) || !Number.isFinite(maxAlt)) return false;
  const median = finite[Math.floor(finite.length / 2)];
  return median >= minAlt - toleranceMeters && median <= maxAlt + toleranceMeters;
}
