'use strict';

// Property lines proxy. The browser asks this Viewer for parcel outlines in a
// small bounding box; this server asks the State of Wisconsin's public parcel
// service with fixed parameters and returns geometry only. The third party
// sees this server, never the viewer's session, link, browser or address.
//
// Accepts only `bbox=west,south,east,north` (WGS84 degrees). Never forwards a
// URL, field list, where clause or any other caller text.

const auth = require('./auth');
const { trackedRouter } = require('./httpRequestLifecycle');
const { isAdminRequest } = require('./adminAuth');
const { revisionMatches } = require('./publicSharePolicy');
const { createUtmProjection } = require('../utm-conversion.mjs');

const WEB_MERCATOR_RADIUS = 6378137;
const DEG = Math.PI / 180;

// Release V12 (2026). The service name changes between releases; update the
// URL and release together when the state publishes the next version.
const WISCONSIN_PARCELS = Object.freeze({
  layerUrl: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0',
  name: 'Wisconsin Statewide Parcel Map',
  release: 'V12 (2026)',
  credit: "Product of the Version 12 Statewide Parcel Map Database Project (V12). Created by the Wisconsin State Cartographer's Office; administered by the Wisconsin Land Information Program at the Department of Administration.",
  datumNote: 'The state data is NAD83-based. Against a model in a WGS84 or ITRF-based frame, expect roughly 1 to 1.5 m of offset in Wisconsin, within the parcel map\u2019s own accuracy.',
  disclaimer: 'Property lines are approximate and for reference only. They are not a survey and do not show legal ownership boundaries. No warranty of accuracy, completeness or currency is made. Only a licensed land surveyor can determine a boundary.',
  // Layer extent published by the service (Web Mercator xmin -10340314.53,
  // ymin 5234954.18, xmax -9658524.28, ymax 5955260.21), as lon/lat rounded
  // outward.
  extent: Object.freeze({ west: -92.89, south: 42.49, east: -86.76, north: 47.09 }),
});

const LIMITS = Object.freeze({
  maxSpanDegrees: 0.06,
  maxParcels: 800,
  maxResponseBytes: 8 * 1024 * 1024,
  timeoutMs: 10_000,
  cacheEntries: 64,
  cacheTtlMs: 10 * 60 * 1000,
  maxInFlight: 4,
  perCallerInFlight: 2,
  ratePerMinute: 90,
  callerRatePerMinute: 60,
});

function webMercatorToLonLat(x, y) {
  return [Number(x) / WEB_MERCATOR_RADIUS / DEG,
    (2 * Math.atan(Math.exp(Number(y) / WEB_MERCATOR_RADIUS)) - Math.PI / 2) / DEG];
}

function lonLatToWebMercator(lon, lat) {
  return [WEB_MERCATOR_RADIUS * Number(lon) * DEG,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + Number(lat) * DEG / 2))];
}

// Strict: exactly four plain decimal numbers, a small box, inside or touching
// the state's published extent.
function parseBoundingBox(value) {
  if (typeof value !== 'string' || value.length > 120) return { error: 'invalid_bbox' };
  const parts = value.split(',');
  if (parts.length !== 4 || !parts.every(part => /^-?\d{1,3}(\.\d{1,9})?$/.test(part))) return { error: 'invalid_bbox' };
  const [west, south, east, north] = parts.map(Number);
  if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north)
    return { error: 'invalid_bbox' };
  if (east - west > LIMITS.maxSpanDegrees || north - south > LIMITS.maxSpanDegrees) return { error: 'bbox_too_large' };
  const e = WISCONSIN_PARCELS.extent;
  if (east < e.west || west > e.east || north < e.south || south > e.north) return { outside: true, bounds: { west, south, east, north } };
  return { bounds: { west, south, east, north } };
}

// Fixed query: geometry only (plus the service's own row id), Web Mercator in
// and out, bounded record count. No attribute such as owner, address or value
// is ever requested.
function upstreamQueryUrl(bounds, layerUrl = WISCONSIN_PARCELS.layerUrl) {
  const [xmin, ymin] = lonLatToWebMercator(bounds.west, bounds.south);
  const [xmax, ymax] = lonLatToWebMercator(bounds.east, bounds.north);
  const round = v => Math.round(v * 100) / 100;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: JSON.stringify({ xmin: round(xmin), ymin: round(ymin), xmax: round(xmax), ymax: round(ymax), spatialReference: { wkid: 3857 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '3857',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID',
    returnGeometry: 'true',
    returnZ: 'false',
    returnM: 'false',
    outSR: '3857',
    geometryPrecision: '2',
    resultRecordCount: String(LIMITS.maxParcels),
    f: 'json',
  });
  return `${layerUrl}/query?${params}`;
}

// Esri JSON (Web Mercator rings) -> { status, parcels: [{ id, rings: lon/lat }] }.
function normalizeUpstream(body) {
  if (!body || typeof body !== 'object' || body.error) return { status: 'unavailable', parcels: [] };
  if (!Array.isArray(body.features)) return { status: 'unavailable', parcels: [] };
  if (body.exceededTransferLimit === true || body.features.length > LIMITS.maxParcels) return { status: 'too_many', parcels: [] };
  const parcels = [];
  for (const feature of body.features) {
    const rings = [];
    for (const ring of Array.isArray(feature?.geometry?.rings) ? feature.geometry.rings : []) {
      if (!Array.isArray(ring)) continue;
      const out = [];
      for (const point of ring) {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
        const [lon, lat] = webMercatorToLonLat(point[0], point[1]);
        out.push([Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]);
      }
      if (out.length >= 2) rings.push(out);
    }
    const id = Number(feature?.attributes?.OBJECTID);
    if (rings.length) parcels.push({ id: Number.isSafeInteger(id) ? id : null, rings });
  }
  return { status: parcels.length ? 'ok' : 'none', parcels };
}

// Who is asking, for which model. Every path re-checks liveness on each
// request, as asset delivery does: a live viewer session for this exact model
// version, an emergency-admin login, or a live, same-revision public share of
// this model. Returns { audience, model, version, caller } or null.
// audience: 'staff' (Ops session or emergency admin), 'client' or 'public'.
async function resolvePropertyLinesCaller(req, repository, modelId, { validator = defaultSourceValidator() } = {}) {
  if (!repository || typeof modelId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(modelId)) return null;
  const resolvedId = repository.resolveModelId ? repository.resolveModelId(modelId) : modelId;
  if (!resolvedId) return null;
  const bearer = String(req.get?.('authorization') || req.headers?.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{16,256})$/i)?.[1];
  const token = bearer || req.cookies?.ltds_viewer;
  if (token) {
    const session = repository.getViewerSessionByHash(auth.hashToken(token));
    if (session && repository.viewerSessionLive(session) && session.permissions?.view !== false
      && ['ops', 'client'].includes(session.audience) && session.modelId === resolvedId) {
      const review = session.sessionMode === 'review';
      const model = review ? repository.getModelVersion(session.modelId, session.modelVersionId) : repository.getModel(session.modelId);
      const version = model?.activeVersion;
      if (version && version.id === session.modelVersionId && version.status === 'ready' && (review || model.status === 'ready'))
        return { audience: session.audience === 'ops' ? 'staff' : 'client', model, version, caller: `session:${session.id}` };
    }
  }
  if (isAdminRequest(req)) {
    const model = repository.getModel(resolvedId);
    if (model?.status === 'ready' && model.activeVersion) return { audience: 'staff', model, version: model.activeVersion, caller: 'admin' };
  }
  const payload = req.cookies?.ltds_share ? auth.verify(req.cookies.ltds_share) : null;
  if (payload && typeof payload.shareId === 'string' && payload.modelId === resolvedId && repository.getPublicShare) {
    const share = repository.getPublicShare(payload.shareId);
    const model = repository.getModel(resolvedId);
    if (share && repository.publicShareLive(share) && revisionMatches(share, payload) && share.modelId === resolvedId
      && share.permissions?.view !== false && model?.status === 'ready' && model.activeVersion
      && (share.versionPolicy !== 'pinned' || share.modelVersionId === model.activeVersionId)
      && await validator.allows(share))
      return { audience: 'public', model, version: model.activeVersion, caller: `share:${share.id}` };
  }
  return null;
}

function defaultSourceValidator() { return require('./sourceAuthorization').sourceAuthorizationValidator; }

// The model's site window in its own UTM zone: the verified centre (RTC
// origin plus model centre) and a half-size from the surveyed area, plus the
// browser's margin and snapping. Without a complete georeference: null.
const SITE = Object.freeze({ marginMeters: 60, snapToleranceMeters: 100, defaultHalfMeters: 1500, minHalfMeters: 150, maxHalfMeters: 2000 });
function modelSiteWindow(version) {
  const g = version?.georef || {};
  const lon0 = g.utmZoneLon0Deg, zone = (lon0 + 183) / 6;
  if (!Number.isFinite(lon0) || !Number.isInteger(zone) || zone < 1 || zone > 60 || !['N', 'S'].includes(g.hemisphere)) return null;
  if (!g.rtc || !g.bboxCenter) return null;
  const e = Number(g.rtc.e) + Number(g.bboxCenter.x), n = Number(g.rtc.n) + Number(g.bboxCenter.y);
  if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(Number(g.rtc.z)) || !Number.isFinite(Number(g.bboxCenter.z))) return null;
  const area = Number(version?.metadata?.processingMetrics?.surveyedAreaM2);
  // 0.75 * sqrt(area) is 1.5 times the half side of a square of that area,
  // leaving room for long or rotated sites.
  const core = Number.isFinite(area) && area > 0
    ? Math.min(SITE.maxHalfMeters, Math.max(SITE.minHalfMeters, 0.75 * Math.sqrt(area)))
    : SITE.defaultHalfMeters;
  const half = core + SITE.marginMeters + SITE.snapToleranceMeters;
  return { projection: createUtmProjection({ zoneLon0Deg: lon0, hemisphere: g.hemisphere }), minE: e - half, maxE: e + half, minN: n - half, maxN: n + half };
}

function boundsInsideSite(bounds, site) {
  if (!site) return false;
  const corners = [[bounds.south, bounds.west], [bounds.south, bounds.east], [bounds.north, bounds.east], [bounds.north, bounds.west]];
  return corners.every(([lat, lon]) => {
    const [e, n] = site.projection.latLonToUtm(lat, lon);
    return Number.isFinite(e) && Number.isFinite(n) && e >= site.minE && e <= site.maxE && n >= site.minN && n <= site.maxN;
  });
}

// Snap outward to a coarse grid so near-identical requests share one cache
// entry and one upstream call.
const CACHE_GRID_DEGREES = 0.0005;
function cacheBounds(bounds, grid = CACHE_GRID_DEGREES) {
  const snap = (value, fn) => Math.round(fn(Math.round(value / grid * 1e6) / 1e6) * grid * 1e6) / 1e6;
  return { west: snap(bounds.west, Math.floor), south: snap(bounds.south, Math.floor), east: snap(bounds.east, Math.ceil), north: snap(bounds.north, Math.ceil) };
}

function propertyLinesOffered(audience, { clientTermsConfirmed = false } = {}) {
  if (audience === 'staff') return true;
  if (audience === 'client' || audience === 'public') return clientTermsConfirmed === true;
  return false;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('response too large'), { code: 'too_large' });
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw Object.assign(new Error('response too large'), { code: 'too_large' }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function createParcelSource({ fetchImpl = globalThis.fetch, now = Date.now, layerUrl = WISCONSIN_PARCELS.layerUrl, limits = LIMITS } = {}) {
  const cache = new Map();
  const pending = new Map();
  const perCaller = new Map();
  let inFlight = 0;

  function cached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > limits.cacheTtlMs) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, hit);
    return hit.value;
  }

  async function fetchUpstream(bounds) {
    const response = await fetchImpl(upstreamQueryUrl(bounds, layerUrl), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    if (!response.ok) return { status: 'unavailable', parcels: [] };
    const text = await readLimited(response, limits.maxResponseBytes);
    let body;
    try { body = JSON.parse(text); } catch { return { status: 'unavailable', parcels: [] }; }
    return normalizeUpstream(body);
  }

  return {
    // caller: one viewer session, share or admin. Each caller may hold at
    // most `perCallerInFlight` upstream calls, so one caller cannot take all
    // of the shared slots.
    async parcels(requested, { caller = 'anonymous' } = {}) {
      const bounds = cacheBounds(requested);
      const key = [bounds.west, bounds.south, bounds.east, bounds.north].map(v => v.toFixed(6)).join(',');
      const hit = cached(key);
      if (hit) return hit;
      if (pending.has(key)) return pending.get(key);
      const mine = perCaller.get(caller) || 0;
      if (mine >= (limits.perCallerInFlight || 1)) return { status: 'busy', parcels: [] };
      if (inFlight >= limits.maxInFlight) return { status: 'busy', parcels: [] };
      inFlight++;
      perCaller.set(caller, mine + 1);
      const work = fetchUpstream(bounds).catch(() => ({ status: 'unavailable', parcels: [] })).then(value => {
        if (value.status !== 'unavailable') {
          cache.set(key, { at: now(), value });
          while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
        }
        return value;
      }).finally(() => {
        inFlight--; pending.delete(key);
        const left = (perCaller.get(caller) || 1) - 1;
        if (left > 0) perCaller.set(caller, left); else perCaller.delete(caller);
      });
      pending.set(key, work);
      return work;
    },
    stats: () => ({ cached: cache.size, inFlight }),
  };
}

function sourceDescription() {
  const { name, release, credit, disclaimer, datumNote } = WISCONSIN_PARCELS;
  return { id: 'wi-statewide-parcels', name, release, credit, disclaimer, datumNote, region: 'Wisconsin' };
}

function createPropertyLinesApi({ repository, config, source = createParcelSource(), validator } = {}) {
  const router = trackedRouter();
  const clientTermsConfirmed = config.propertyLinesClientTermsConfirmed === true;
  // 401 when nothing was presented; 403 when a session, admin login or share
  // was presented but is revoked, stale, expired or for another model.
  const denied = (req, res) => {
    const presented = Boolean(req.get?.('authorization') || req.cookies?.ltds_viewer || req.cookies?.ltds_share || req.cookies?.ltds_admin);
    return res.status(presented ? 403 : 401).json({ error: 'viewer access to this model is required', code: presented ? 'viewer_access_denied' : 'viewer_required' });
  };
  const resolve = (req, modelId) => resolvePropertyLinesCaller(req, repository, modelId, validator ? { validator } : undefined);

  router.get('/api/v1/property-lines', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const keys = Object.keys(req.query || {});
    if (keys.length !== 1 || keys[0] !== 'model' || typeof req.query.model !== 'string') return res.status(400).json({ error: 'model is required', code: 'invalid_request' });
    const caller = await resolve(req, req.query.model);
    if (!caller) return denied(req, res);
    const offered = propertyLinesOffered(caller.audience, { clientTermsConfirmed }) && Boolean(modelSiteWindow(caller.version));
    return res.json({ offered, source: sourceDescription() });
  });

  router.get('/api/v1/property-lines/parcels', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const keys = Object.keys(req.query || {}).sort();
    if (keys.length !== 2 || keys[0] !== 'bbox' || keys[1] !== 'model' || typeof req.query.model !== 'string')
      return res.status(400).json({ error: 'only bbox and model are accepted', code: 'invalid_request' });
    const parsed = parseBoundingBox(req.query.bbox);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: parsed.error });
    const caller = await resolve(req, req.query.model);
    if (!caller) return denied(req, res);
    if (!propertyLinesOffered(caller.audience, { clientTermsConfirmed }))
      return res.status(403).json({ error: 'property lines are not offered for this viewer', code: 'property_lines_not_offered' });
    if (!boundsInsideSite(parsed.bounds, modelSiteWindow(caller.version)))
      return res.status(403).json({ error: 'area is outside this model', code: 'outside_model' });
    if (repository?.rateLimited?.(`property-lines:${req.ip}`, LIMITS.ratePerMinute, 60_000)
      || repository?.rateLimited?.(`property-lines:${caller.caller}`, LIMITS.callerRatePerMinute, 60_000))
      return res.status(429).json({ error: 'too many requests', code: 'rate_limited' });
    if (parsed.outside) return res.json({ status: 'outside', parcels: [] });
    const result = await source.parcels(parsed.bounds, { caller: caller.caller });
    if (result.status === 'busy') return res.status(429).json({ status: 'unavailable', parcels: [], code: 'busy' });
    if (result.status === 'unavailable') return res.status(502).json({ status: 'unavailable', parcels: [] });
    return res.json({ status: result.status, parcels: result.parcels });
  });

  return router;
}

module.exports = {
  WISCONSIN_PARCELS,
  LIMITS,
  createPropertyLinesApi,
  createParcelSource,
  normalizeUpstream,
  parseBoundingBox,
  resolvePropertyLinesCaller,
  modelSiteWindow,
  boundsInsideSite,
  cacheBounds,
  propertyLinesOffered,
  upstreamQueryUrl,
  webMercatorToLonLat,
  lonLatToWebMercator,
};
