'use strict';

// Property lines proxy. The browser asks this Viewer for parcel outlines in a
// small bounding box; this server asks the registered public parcel service
// for that location (parcelSources.js; today the State of Wisconsin's) with
// fixed parameters and returns geometry only. The third party
// sees this server, never the viewer's session, link, browser or address.
//
// Accepts only `bbox=west,south,east,north` (WGS84 degrees). Never forwards a
// URL, field list, where clause or any other caller text.

const auth = require('./auth');
const { trackedRouter } = require('./httpRequestLifecycle');
const { isAdminRequest } = require('./adminAuth');
const { revisionMatches } = require('./publicSharePolicy');
const { createUtmProjection } = require('../utm-conversion.mjs');
const { parcelsInBounds, uploadSourceDescription } = require('./propertyLinesBoundary');
const { PARCEL_SOURCES, PARCEL_DISCLAIMER, WISCONSIN, extentTouches, selectParcelSource } = require('./parcelSources');

// Datum convention, end to end (one rule, no exceptions):
//   NAD83 geographic lon/lat, and NO datum transformation anywhere.
// - The state layer's native spatial reference is Web Mercator (wkid
//   102100 / latest 3857, per the layer's own metadata). We query in that
//   native reference (inSR = outSR = 3857, no datumTransformation), so the
//   service never reprojects and cannot apply a datum shift of its own.
//   Asking for 4269 instead would make it reproject across datums.
// - We invert the spherical Mercator formula in pure maths and label the
//   result NAD83 lon/lat: the parcel source data is NAD83-based, and Web
//   Mercator is used here only as a container for those numbers.
// - The browser projects those lon/lat numbers into the model's UTM zone with
//   the same ellipsoid maths used for the model (GRS80 and WGS84 differ by
//   well under 1 mm in UTM), again with no shift. A model on a NAD83 frame
//   lines up as the data does; a model whose metadata says WGS84 is told
//   about the expected 1 to 1.5 m datum offset instead of being silently
//   shifted (property-lines.mjs, modelHorizontalDatum).
const WEB_MERCATOR_RADIUS = 6378137;
const DEG = Math.PI / 180;

// The Wisconsin source now lives in the parcel-source registry
// (parcelSources.js), with the release and the monthly release check.
const WISCONSIN_PARCELS = WISCONSIN;

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

// Strict: exactly four plain decimal numbers, a small box. `outside` when it
// touches no registered source's published extent.
function parseBoundingBox(value, sources = PARCEL_SOURCES) {
  if (typeof value !== 'string' || value.length > 120) return { error: 'invalid_bbox' };
  const parts = value.split(',');
  if (parts.length !== 4 || !parts.every(part => /^-?\d{1,3}(\.\d{1,9})?$/.test(part))) return { error: 'invalid_bbox' };
  const [west, south, east, north] = parts.map(Number);
  if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north)
    return { error: 'invalid_bbox' };
  if (east - west > LIMITS.maxSpanDegrees || north - south > LIMITS.maxSpanDegrees) return { error: 'bbox_too_large' };
  const bounds = { west, south, east, north };
  if (!selectParcelSource(bounds, sources)) return { outside: true, bounds };
  return { bounds };
}

// Fixed query: geometry only (plus the service's own row id), the layer's
// native Web Mercator in and out (no reprojection and no datum
// transformation; see the datum convention above), bounded record count. No attribute such as owner, address or value
// is ever requested.
// source: a registry entry, or a bare layer URL for the Wisconsin query.
function upstreamQueryUrl(bounds, source = WISCONSIN) {
  const { layerUrl, query } = typeof source === 'string' ? { ...WISCONSIN, layerUrl: source } : source;
  const [xmin, ymin] = lonLatToWebMercator(bounds.west, bounds.south);
  const [xmax, ymax] = lonLatToWebMercator(bounds.east, bounds.north);
  const round = v => Math.round(v * 100) / 100;
  const params = new URLSearchParams({
    where: query.where,
    geometry: JSON.stringify({ xmin: round(xmin), ymin: round(ymin), xmax: round(xmax), ymax: round(ymax), spatialReference: { wkid: query.wkid } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: String(query.wkid),
    spatialRel: 'esriSpatialRelIntersects',
    outFields: query.outFields,
    returnGeometry: 'true',
    returnZ: 'false',
    returnM: 'false',
    outSR: String(query.wkid),
    geometryPrecision: String(query.geometryPrecision),
    resultRecordCount: String(LIMITS.maxParcels),
    f: 'json',
  });
  return `${layerUrl}/query?${params}`;
}

// Esri JSON (Web Mercator rings) -> { status, parcels: [{ id, rings: lon/lat }] }.
function normalizeUpstream(body, idField = WISCONSIN.query.idField) {
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
    const id = Number(feature?.attributes?.[idField]);
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

// The site window as lon/lat bounds (corners and edge midpoints), used to
// pick the model's parcel source.
function siteLonLatBounds(site) {
  if (!site) return null;
  const midE = (site.minE + site.maxE) / 2, midN = (site.minN + site.maxN) / 2;
  const points = [[site.minE, site.minN], [midE, site.minN], [site.maxE, site.minN], [site.maxE, midN],
    [site.maxE, site.maxN], [midE, site.maxN], [site.minE, site.maxN], [site.minE, midN]].map(([e, n]) => site.projection.utmToLatLon(e, n));
  if (!points.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))) return null;
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

// The model's state parcel source: the first registered source whose extent
// touches the model's site window, or null (no state source here).
function parcelSourceForModel(version, sources = PARCEL_SOURCES) {
  const bounds = siteLonLatBounds(modelSiteWindow(version));
  return bounds ? selectParcelSource(bounds, sources) : null;
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

// The state confirmed in writing on 2026-11-18 that the statewide parcel data
// is public domain, so every viewer with live access to the model is offered
// the layer: staff, client sessions and public links alike.
function propertyLinesOffered(audience) {
  return audience === 'staff' || audience === 'client' || audience === 'public';
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

// One fetcher (cache, slots) per registry source.
function createParcelSource({ fetchImpl = globalThis.fetch, now = Date.now, config = WISCONSIN, layerUrl = config.layerUrl, limits = LIMITS } = {}) {
  const target = layerUrl === config.layerUrl ? config : { ...config, layerUrl };
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
    const response = await fetchImpl(upstreamQueryUrl(bounds, target), {
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
    return normalizeUpstream(body, target.query.idField);
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

function sourceDescription(config = WISCONSIN) {
  const { id, name, release, credit, disclaimer, datumNote, datum, region } = config;
  return { id, name, release, credit, disclaimer, datumNote, datum, region };
}

// boundaries: optional uploaded-boundary store (propertyLinesBoundary.js).
// When the model's project has chosen its uploaded file, that file replaces
// the state layer for this model, behind exactly the same access checks.
// An uploaded boundary is project-supplied data, not public-domain data: it
// is shown to staff and to signed-in clients with live access to the model,
// and to anonymous public links only when staff ticked "Show on public
// links" (manifest publicVisible). A public link on a project whose source is
// the upload otherwise gets no layer at all (not the state parcels, which may
// be the wrong data for that site).
function uploadVisible(upload, audience) {
  if (!upload?.parcels) return false;
  return audience === 'staff' || audience === 'client' || (audience === 'public' && upload.manifest.publicVisible === true);
}

// sources: the parcel-source registry. source: optional single fetcher used
// for every registered source (tests); otherwise each source gets its own
// fetcher, created on first use (fetchImpl: tests only).
function createPropertyLinesApi({ repository, sources = PARCEL_SOURCES, source = null, fetchImpl, validator, boundaries = null } = {}) {
  const router = trackedRouter();
  const fetchers = new Map();
  const fetcherFor = config => {
    if (source) return source;
    if (!fetchers.has(config.id)) fetchers.set(config.id, createParcelSource(fetchImpl ? { config, fetchImpl } : { config }));
    return fetchers.get(config.id);
  };
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
    const offered = propertyLinesOffered(caller.audience) && Boolean(modelSiteWindow(caller.version));
    const upload = boundaries?.activeForModel(caller.model?.id);
    if (upload && !uploadVisible(upload, caller.audience)) return res.json({ offered: false, source: null });
    if (upload) return res.json({ offered, source: uploadSourceDescription(upload.manifest, PARCEL_DISCLAIMER) });
    // A model outside every registered extent is described by the first
    // source, as before the registry: the browser's own coverage check says
    // "not available here" and its tiles come back 'outside'.
    const state = parcelSourceForModel(caller.version, sources) || sources[0];
    return res.json({ offered, source: state ? sourceDescription(state) : null });
  });

  router.get('/api/v1/property-lines/parcels', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const keys = Object.keys(req.query || {}).sort();
    if (keys.length !== 2 || keys[0] !== 'bbox' || keys[1] !== 'model' || typeof req.query.model !== 'string')
      return res.status(400).json({ error: 'only bbox and model are accepted', code: 'invalid_request' });
    const parsed = parseBoundingBox(req.query.bbox, sources);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: parsed.error });
    const caller = await resolve(req, req.query.model);
    if (!caller) return denied(req, res);
    if (!propertyLinesOffered(caller.audience))
      return res.status(403).json({ error: 'property lines are not offered for this viewer', code: 'property_lines_not_offered' });
    if (!boundsInsideSite(parsed.bounds, modelSiteWindow(caller.version)))
      return res.status(403).json({ error: 'area is outside this model', code: 'outside_model' });
    if (repository?.rateLimited?.(`property-lines:${req.ip}`, LIMITS.ratePerMinute, 60_000)
      || repository?.rateLimited?.(`property-lines:${caller.caller}`, LIMITS.callerRatePerMinute, 60_000))
      return res.status(429).json({ error: 'too many requests', code: 'rate_limited' });
    const upload = boundaries?.activeForModel(caller.model?.id);
    if (upload && !uploadVisible(upload, caller.audience))
      return res.status(403).json({ error: 'property lines are not offered for this viewer', code: 'property_lines_not_offered' });
    if (upload) return res.json(parcelsInBounds(upload.parcels, parsed.bounds));
    if (parsed.outside) return res.json({ status: 'outside', parcels: [] });
    // The model's source wherever its extent reaches this tile; otherwise the
    // first source that does (the tile is inside the model's site window,
    // checked above, and touches at least one source).
    const modelSource = parcelSourceForModel(caller.version, sources);
    const config = modelSource && extentTouches(modelSource.extent, parsed.bounds) ? modelSource : selectParcelSource(parsed.bounds, sources);
    const result = await fetcherFor(config).parcels(parsed.bounds, { caller: caller.caller });
    if (result.status === 'busy') return res.status(429).json({ status: 'unavailable', parcels: [], code: 'busy' });
    if (result.status === 'unavailable') return res.status(502).json({ status: 'unavailable', parcels: [] });
    return res.json({ status: result.status, parcels: result.parcels });
  });

  return router;
}

module.exports = {
  WISCONSIN_PARCELS,
  PARCEL_SOURCES,
  sourceDescription,
  parcelSourceForModel,
  siteLonLatBounds,
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
