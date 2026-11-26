'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const auth = require('../server/auth');
const {
  WISCONSIN_PARCELS,
  createParcelSource,
  createPropertyLinesApi,
  normalizeUpstream,
  parseBoundingBox,
  resolvePropertyLinesCaller,
  modelSiteWindow,
  modelCoverageWindow,
  COVERAGE_METERS,
  TILE_EDGE_ALLOWANCE_METERS,
  authorizedEnvelope,
  clipRing,
  clipSegment,
  clipBoundary,
  clipParcels,
  clipFeatures,
  siteLonLatBounds,
  LIMITS,
  boundsInsideSite,
  boundsTouchSite,
  cacheBounds,
  propertyLinesOffered,
  upstreamQueryUrl,
} = require('../server/propertyLines');
const { webMercatorToLonLat } = require('../server/propertyLines');

const MADISON = { west: -89.402, south: 43.074, east: -89.400, north: 43.0755 };

test('bounding box accepts only four plain numbers in a small box', () => {
  assert.deepEqual(parseBoundingBox('-89.402,43.074,-89.4,43.0755'), { bounds: MADISON });
  for (const bad of [undefined, '', '1,2,3', '1,2,3,4,5', '-89.4,43.07,-89.41,43.08', '-89.402,43.08,-89.4,43.07', 'a,b,c,d',
    '-89.4e1,43,-89.3,43.1', '-89.402, 43.074,-89.4,43.0755', '-189,43,-188.99,43.01', '0x1,2,3,4', ['-89.4', '43'], '-89.402,43.074,-89.4,43.0755&f=html'])
    assert.equal(parseBoundingBox(bad).error, 'invalid_bbox', String(bad));
  assert.equal(parseBoundingBox('-89.5,43.0,-89.4,43.05').error, 'bbox_too_large');
  assert.equal(parseBoundingBox('-89.4,43.0,-89.3,43.07').error, 'bbox_too_large');
  assert.equal(parseBoundingBox('-93.30,44.97,-93.25,44.99').outside, true, 'Minneapolis is outside the layer extent');
  assert.equal(parseBoundingBox('-87.66,41.86,-87.62,41.89').outside, true, 'Chicago');
});

test('upstream query is fixed: geometry and owner name only, Web Mercator, bounded count, fixed host', () => {
  const url = new URL(upstreamQueryUrl(MADISON));
  assert.equal(url.origin + url.pathname, `${WISCONSIN_PARCELS.layerUrl}/query`);
  assert.equal(url.hostname, 'services3.arcgis.com');
  const p = url.searchParams;
  assert.equal(p.get('outFields'), 'OBJECTID,OWNERNME1,ASSDACRES', 'row id, first owner name and stated acres; no address or value fields');
  assert.doesNotMatch(url.search, /OWNERNME2|ADRESS|ADDRESS|VALUE|PSTL|SITE|\*/i);
  assert.equal(p.get('returnGeometry'), 'true');
  assert.equal(p.get('inSR'), '3857');
  assert.equal(p.get('outSR'), '3857');
  assert.equal(p.get('geometryType'), 'esriGeometryEnvelope');
  assert.equal(p.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(p.get('resultRecordCount'), '800');
  assert.equal(p.get('f'), 'json');
  assert.equal(p.get('where'), '1=1');
  const envelope = JSON.parse(p.get('geometry'));
  // -89.402 E / 43.074 N in Web Mercator.
  assert.ok(Math.abs(envelope.xmin - -9952185.12) < 0.006, String(envelope.xmin));
  assert.ok(Math.abs(envelope.ymin - 5323242.19) < 0.006, String(envelope.ymin));
  assert.deepEqual(envelope.spatialReference, { wkid: 3857 });
  assert.deepEqual([...p.keys()].sort(), ['f', 'geometry', 'geometryPrecision', 'geometryType', 'inSR', 'outFields', 'outSR', 'resultRecordCount', 'returnGeometry', 'returnM', 'returnZ', 'spatialRel', 'where']);
});

test('upstream features become lon/lat rings without attributes', () => {
  const result = normalizeUpstream({ features: [
    { attributes: { OBJECTID: 578488, OWNERNME1: 'not forwarded' }, geometry: { rings: [[[-9952185.1159, 5323242.1929], [-9952000, 5323242.19], [-9952000, 5323500], [-9952185.1159, 5323242.1929]]] } },
    { attributes: { OBJECTID: 2 }, geometry: { rings: [[[1, 2]]] } },
  ] });
  assert.equal(result.status, 'ok');
  assert.equal(result.parcels.length, 1);
  assert.deepEqual(Object.keys(result.parcels[0]).sort(), ['id', 'rings']);
  assert.equal(result.parcels[0].id, 578488);
  const [lon, lat] = result.parcels[0].rings[0][0];
  assert.ok(Math.abs(lon - -89.402) < 1e-6 && Math.abs(lat - 43.074) < 1e-5, `${lon},${lat}`);
  // With the source's owner field: the cleaned first owner name and nothing else.
  const owned = normalizeUpstream({ features: [
    { attributes: { OBJECTID: 7, OWNERNME1: '  SAMPLE   FARMS\tLLC ', OWNERNME2: 'second owner', SITEADRESS: '1 Main St' }, geometry: { rings: [[[-9952185, 5323242], [-9952000, 5323242], [-9952000, 5323500]]] } },
    { attributes: { OBJECTID: 8, OWNERNME1: '   ' }, geometry: { rings: [[[-9952185, 5323242], [-9952000, 5323242]]] } },
  ] }, 'OBJECTID', 'OWNERNME1');
  assert.deepEqual(owned.parcels.map(parcel => Object.keys(parcel).sort()), [['id', 'owner', 'rings'], ['id', 'rings']]);
  assert.equal(owned.parcels[0].owner, 'SAMPLE FARMS LLC');
  assert.equal(normalizeUpstream({ features: [], exceededTransferLimit: false }).status, 'none');
  assert.equal(normalizeUpstream({ features: [{}], exceededTransferLimit: true }).status, 'too_many');
  assert.equal(normalizeUpstream({ error: { code: 400 } }).status, 'unavailable');
  assert.equal(normalizeUpstream(null).status, 'unavailable');
  const [x0, y0] = webMercatorToLonLat(0, 0);
  assert.equal(x0, 0); assert.ok(Math.abs(y0) < 1e-12);
});

const { createUtmProjection } = require('../utm-conversion.mjs');

// A model centred on the Madison test box, verified UTM zone 16N.
function madisonModel(id, extra = {}) {
  const [e, n] = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' }).latLonToUtm(43.07475, -89.401);
  const bboxCenter = { x: 12, y: -8, z: 3 };
  return {
    id, status: 'ready', activeVersionId: `${id}-v1`,
    activeVersion: { id: `${id}-v1`, status: 'ready', metadata: { processingMetrics: { surveyedAreaM2: 200_000 } },
      georef: { utmZone: 16, hemisphere: 'N', utmZoneLon0Deg: -87, rtc: { e: e - bboxCenter.x, n: n - bboxCenter.y, z: 250 }, bboxCenter } },
    ...extra,
  };
}

function fakeRepository(sessions, { models = { 'model-a': madisonModel('model-a'), 'model-b': madisonModel('model-b') }, shares = {} } = {}) {
  return {
    resolveModelId(id) { return models[id] ? id : null; },
    getModel(id) { return models[id] || null; },
    getModelVersion(id) { return models[id] || null; },
    getViewerSessionByHash(hash) { return sessions.find(s => auth.hashToken(s.token) === hash) || null; },
    viewerSessionLive(session) { return session.live !== false; },
    getPublicShare(id) { return shares[id] || null; },
    publicShareLive(share) { return Boolean(share) && share.active !== false; },
    rateLimited() { return false; },
  };
}

const allow = { allows: async () => true };
const staffToken = 'staff-token-aaaaaaaaaaaaaaaa';
const clientToken = 'client-token-bbbbbbbbbbbbbbbb';
const expiredToken = 'expired-token-cccccccccccccccc';
const session = (token, audience, extra = {}) => ({ id: `s-${audience}-${token.slice(0, 4)}`, token, audience, modelId: 'model-a', modelVersionId: 'model-a-v1', permissions: { view: true }, ...extra });
const sessions = [session(staffToken, 'ops'), session(clientToken, 'client'), session(expiredToken, 'ops', { live: false })];
const liveShare = { id: 'share-1', modelId: 'model-a', authorizationRevision: 2, permissions: { view: true } };
const shareCookie = (revision = 2, shareId = 'share-1', modelId = 'model-a') => auth.sign({ shareId, modelId, shareRevision: revision }, 60_000);

test('caller: live session, admin or live share of this exact model', async () => {
  const repository = fakeRepository(sessions, { shares: { 'share-1': liveShare, 'share-revoked': { ...liveShare, id: 'share-revoked', active: false } } });
  const req = (headers = {}, cookies = {}) => ({ headers, cookies, get: name => headers[name.toLowerCase()] });
  const audience = async (r, model = 'model-a') => (await resolvePropertyLinesCaller(r, repository, model, { validator: allow }))?.audience ?? null;
  assert.equal(await audience(req({ authorization: `Bearer ${staffToken}` })), 'staff');
  assert.equal(await audience(req({ authorization: `Bearer ${clientToken}` })), 'client');
  assert.equal(await audience(req({}, { ltds_viewer: staffToken })), 'staff');
  assert.equal(await audience(req({ authorization: `Bearer ${expiredToken}` })), null);
  assert.equal(await audience(req({ authorization: `Bearer ${staffToken}` }), 'model-b'), null, 'a session is bound to its own model');
  assert.equal(await audience(req({}, { ltds_share: shareCookie() })), 'public');
  assert.equal(await audience(req({}, { ltds_share: shareCookie() }), 'model-b'), null);
  assert.equal(await audience(req({}, { ltds_share: `${shareCookie()}x` })), null, 'forged share cookie');
  assert.equal(await audience(req({}, { ltds_share: shareCookie(1) })), null, 'older share revision');
  assert.equal(await audience(req({}, { ltds_share: shareCookie(2, 'share-revoked') })), null, 'revoked share');
  assert.equal(await resolvePropertyLinesCaller(req({}, { ltds_share: shareCookie() }), repository, 'model-a', { validator: { allows: async () => false } }), null, 'source authorization withdrawn');
  const unavailable = fakeRepository(sessions, { models: { 'model-a': madisonModel('model-a', { status: 'archived' }) }, shares: { 'share-1': liveShare } });
  assert.equal(await resolvePropertyLinesCaller(req({}, { ltds_share: shareCookie() }), unavailable, 'model-a', { validator: allow }), null, 'model no longer available');
  assert.equal(await audience(req()), null);
});

test('model site window comes from the verified centre and surveyed area', () => {
  const site = modelSiteWindow(madisonModel('m').activeVersion);
  assert.ok(site.maxE - site.minE > 2 * (0.75 * Math.sqrt(200_000)) && site.maxE - site.minE < 2 * (0.75 * Math.sqrt(200_000) + 200));
  assert.equal(boundsInsideSite(MADISON, site), true);
  assert.equal(boundsInsideSite({ west: -87.915, south: 43.035, east: -87.905, north: 43.045 }, site), false, 'Milwaukee is not this model');
  const unverified = madisonModel('m').activeVersion;
  assert.equal(modelSiteWindow({ ...unverified, georef: { ...unverified.georef, utmZoneLon0Deg: undefined } }), null);
  assert.equal(modelSiteWindow({ ...unverified, georef: { ...unverified.georef, bboxCenter: undefined } }), null);
  const noArea = modelSiteWindow({ ...unverified, metadata: {} });
  assert.ok(noArea.maxE - noArea.minE > 3000 && noArea.maxE - noArea.minE < 3400, 'default half-size 1.5 km plus margin');
  // Coverage for map tiles: the site window widened by COVERAGE_METERS; a
  // tile overlapping it is served, a tile wholly beyond it is not.
  const coverage = modelCoverageWindow(madisonModel('m').activeVersion);
  assert.equal(coverage.maxE - coverage.minE, site.maxE - site.minE + 2 * COVERAGE_METERS);
  const [cLat, cLon] = site.projection.utmToLatLon((site.minE + site.maxE) / 2, (site.minN + site.maxN) / 2);
  const tileAt = (dEast, half = 800) => {
    const [, west] = site.projection.utmToLatLon((site.minE + site.maxE) / 2 + dEast - half, (site.minN + site.maxN) / 2);
    const [, east] = site.projection.utmToLatLon((site.minE + site.maxE) / 2 + dEast + half, (site.minN + site.maxN) / 2);
    return { west, east, south: cLat - 0.007, north: cLat + 0.007 };
  };
  assert.ok(cLon < -89 && cLon > -90);
  assert.equal(boundsTouchSite(tileAt(3000), coverage), true, '3 km east of the model: inside the coverage');
  assert.equal(boundsTouchSite(tileAt((coverage.maxE - coverage.minE) / 2 + 500), coverage), true, 'overlapping the edge');
  assert.equal(boundsTouchSite(tileAt((coverage.maxE - coverage.minE) / 2 + 1200), coverage), false, 'wholly beyond the coverage');
  assert.equal(boundsTouchSite({ west: -87.915, south: 43.035, east: -87.905, north: 43.045 }, coverage), false, 'Milwaukee is still not this model');
});

test('every viewer with live access to the model is offered the layer', () => {
  assert.equal(propertyLinesOffered('staff'), true);
  assert.equal(propertyLinesOffered('client'), true);
  assert.equal(propertyLinesOffered('public'), true);
  assert.equal(propertyLinesOffered(null), false);
  assert.equal(propertyLinesOffered('anyone'), false);
  assert.equal('propertyLinesClientTermsConfirmed' in require('../server/config').config, false, 'no client gate setting remains');
});

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('parcel source limits size, time and concurrency and caches briefly', async () => {
  let calls = 0, now = 0;
  const feature = { attributes: { OBJECTID: 1 }, geometry: { rings: [[[-9952185.1159, 5323242.1929], [-9952000, 5323242.19]]] } };
  const source = createParcelSource({ now: () => now, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined, 'no credentials to the third party');
    assert.equal(options.headers.Cookie, undefined);
    return response({ features: [feature] });
  } });
  assert.equal((await source.parcels(MADISON)).status, 'ok');
  assert.equal((await source.parcels(MADISON)).status, 'ok');
  assert.equal(calls, 1, 'cached');
  assert.equal((await source.parcels({ west: -89.40199, south: 43.07402, east: -89.40003, north: 43.07548 })).status, 'ok');
  assert.equal(calls, 1, 'a near-identical box shares the coarse cache entry');
  now += 11 * 60 * 1000;
  await source.parcels(MADISON);
  assert.equal(calls, 2, 'cache expires');
  assert.deepEqual(cacheBounds({ west: -89.40199, south: 43.07402, east: -89.40003, north: 43.07548 }), { west: -89.402, south: 43.074, east: -89.4, north: 43.0755 });

  const big = createParcelSource({ fetchImpl: async () => response('x'.repeat(100), { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  assert.equal((await big.parcels(MADISON)).status, 'unavailable');
  const limits = { maxResponseBytes: 50, timeoutMs: 1000, cacheEntries: 4, cacheTtlMs: 1000, maxInFlight: 4, perCallerInFlight: 1 };
  const streamed = createParcelSource({ limits, fetchImpl: async () => response({ features: [feature, feature, feature] }) });
  assert.equal((await streamed.parcels(MADISON)).status, 'unavailable', 'body over the limit is refused');
  const failing = createParcelSource({ fetchImpl: async () => response({ error: 'x' }, { status: 500 }) });
  assert.equal((await failing.parcels(MADISON)).status, 'unavailable');
  const timedOut = createParcelSource({ limits: { ...limits, maxResponseBytes: 1000, timeoutMs: 20 },
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  assert.equal((await timedOut.parcels(MADISON)).status, 'unavailable');
});

test('upstream slots are shared fairly between callers', async () => {
  const releases = [];
  const slow = createParcelSource({ limits: { maxResponseBytes: 1e6, timeoutMs: 1000, cacheEntries: 8, cacheTtlMs: 1000, maxInFlight: 3, perCallerInFlight: 1 },
    fetchImpl: () => new Promise(resolve => { releases.push(() => resolve(response({ features: [] }))); }) });
  const box = west => ({ ...MADISON, west, east: west + 0.002 });
  const first = slow.parcels(box(-89.402), { caller: 'session:a' });
  const same = slow.parcels(box(-89.402), { caller: 'session:b' });
  assert.equal((await slow.parcels(box(-89.395), { caller: 'session:a' })).status, 'busy', 'one caller cannot take a second slot');
  const other = slow.parcels(box(-89.390), { caller: 'session:b' });
  const third = slow.parcels(box(-89.385), { caller: 'session:c' });
  assert.equal((await slow.parcels(box(-89.380), { caller: 'session:d' })).status, 'busy', 'global cap still holds');
  assert.equal(releases.length, 3);
  releases.forEach(release => release());
  assert.equal((await first).status, 'none');
  assert.equal((await same).status, 'none', 'identical requests share one upstream call');
  assert.equal((await other).status, 'none');
  assert.equal((await third).status, 'none');
  assert.equal(slow.stats().inFlight, 0);
  // A fresh call from the first caller gets a slot again (released here so
  // the test never waits on an unresolved upstream call).
  const after = slow.parcels(box(-89.375), { caller: 'session:a' });
  assert.equal(slow.stats().inFlight, 1, 'slot released after completion');
  releases.at(-1)();
  assert.equal((await after).status, 'none');
});

async function withServer({ source, boundaries = null, repository = fakeRepository(sessions, { shares: { 'share-1': liveShare, 'share-revoked': { ...liveShare, id: 'share-revoked', active: false } } }) }, run) {
  const app = express();
  // As behind the production proxy: req.ip comes from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(p => p.trim().split('='))); next(); });
  app.use(createPropertyLinesApi({ repository, source, validator: allow, boundaries }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('API: clients and live shares allowed, live share checks, model binding and strict parameters', async () => {
  const seen = [];
  const source = { parcels: async (bounds, options) => { seen.push({ bounds, options }); return { status: 'ok', parcels: [{ id: 1, rings: [[[-89.401, 43.075], [-89.4015, 43.075]]] }] }; } };
  const staff = { Authorization: `Bearer ${staffToken}` }, client = { Authorization: `Bearer ${clientToken}` };
  const box = 'bbox=-89.402,43.074,-89.4,43.0755';
  const cookie = value => ({ Cookie: `ltds_share=${value}` });
  await withServer({ source }, async base => {
    assert.equal((await fetch(`${base}/api/v1/property-lines?model=model-a`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/property-lines`, { headers: staff })).status, 400, 'model is required');
    const offerStaff = await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: staff })).json();
    assert.equal(offerStaff.offered, true);
    assert.equal(offerStaff.source.release, 'V12 (2026)');
    assert.match(offerStaff.source.disclaimer, /not a survey/);
    assert.match(offerStaff.source.datumNote, /NAD83.*no datum shift.*1 to 1\.5 m/);
    assert.equal(offerStaff.source.datum, 'NAD83');
    // Clients and public links are offered the layer with no setting.
    assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: client })).json()).offered, true);
    assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: cookie(shareCookie()) })).json()).offered, true);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: client })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie()) })).status, 200, 'live share at its current revision');
    const ok = await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: staff });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await ok.json()).sort(), ['parcels', 'status']);
    assert.equal(seen.at(-1).options.caller, 'session:s-ops-staf', 'upstream slots are counted per session');
    // Model binding: another model's id, or a box away from this model.
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-b`, { headers: staff })).status, 403);
    const away = await fetch(`${base}/api/v1/property-lines/parcels?bbox=-87.915,43.035,-87.905,43.045&model=model-a`, { headers: staff });
    assert.equal(away.status, 403);
    assert.equal((await away.json()).code, 'outside_model');
    for (const query of [`${box}&model=model-a&url=https://example.invalid`, `${box}&model=model-a&outFields=*`, `${box}`, 'model=model-a',
      'where=1%3D1&model=model-a', 'bbox=1,2,3&model=model-a', 'bbox=-89.5,43.0,-89.4,43.05&model=model-a', 'bbox[]=1&model=model-a', `${box}&model[]=model-a`])
      assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${query}`, { headers: staff })).status, 400, query);
    assert.equal(seen.length, 3, 'refused requests never reach the state service');
    // Revoked or out-of-date public links are still refused.
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie(2, 'share-revoked')) })).status, 403, 'revoked share');
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie(1)) })).status, 403, 'older share revision');
    assert.equal((await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: cookie(shareCookie(1)) })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: { Authorization: `Bearer ${expiredToken}` } })).status, 403, 'expired session');
  });
  await withServer({ source: { parcels: async () => ({ status: 'unavailable', parcels: [] }) } }, async base => {
    const failed = await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: staff });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).status, 'unavailable');
  });
});

// Web Mercator tile helpers for the synthetic public-link tests.
const tileXY = (lon, lat, z) => {
  const n = 2 ** z;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)];
};
const tileWest = (x, z) => x / 2 ** z * 360 - 180;

test('API: public link map tiles: only on-grid tiles inside the coverage, queried and answered clipped to it', async () => {
  const seen = [];
  // The state answers every tile with one parcel reaching 30 km east of the model.
  const source = { parcels: async (bounds, options) => {
    seen.push({ bounds, options });
    return { status: 'ok', parcels: [{ id: 9, owner: 'SAMPLE FARMS LLC', rings: [[[bounds.west, bounds.south], [bounds.west, bounds.north], [-89.0, bounds.north], [-89.0, bounds.south], [bounds.west, bounds.south]]] }] };
  } };
  const share = { Cookie: `ltds_share=${shareCookie()}` };
  const version = madisonModel('model-a').activeVersion;
  const coverage = modelCoverageWindow(version);
  const [cx, cy] = tileXY(-89.401, 43.07475, 14);
  await withServer({ source }, async base => {
    const get = query => fetch(`${base}/api/v1/property-lines/parcels?${query}&model=model-a`, { headers: share });
    // The model's own tile: served exactly as the grid defines it.
    const own = await get(`tile=14/${cx}/${cy}`);
    assert.equal(own.status, 200);
    assert.equal(seen.at(-1).options.snap, false, 'tiles are queried exactly, not snapped outward');
    assert.equal(seen.at(-1).bounds.west, tileWest(cx, 14));
    assert.match(seen.at(-1).options.caller, /^share:share-1:[0-9a-f]{16}$/, 'a public link caller is the share plus a hash of the client address');
    // Off-grid or malformed tiles never reach the state service.
    const before = seen.length;
    for (const tile of ['13/2061/2985', '17/1/1', '14/4123.5/5940', '14/-1/5940', '14/16384/5940', `14/${cx}/${cy}/1`, `14,${cx},${cy}`, '014/1/1', '', `14/${cx}/${cy}&bbox=-89.402,43.074,-89.4,43.0755`])
      assert.equal((await get(`tile=${encodeURIComponent(tile).replace('%26', '&').replace('%3D', '=')}`)).status, 400, tile);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?tile=14/${cx}/${cy}&bbox=-89.402,43.074,-89.4,43.0755&model=model-a`, { headers: share })).status, 400, 'one request type at a time');
    assert.equal(seen.length, before, 'refused tiles are never fetched');
    // Walk east along the model's row: tiles stop at the coverage plus the
    // one-tile edge allowance; overhanging tiles past that are refused.
    const accepted = [], refused = [];
    for (let x = cx; x <= cx + 8; x++) {
      const res = await get(`tile=14/${x}/${cy}`);
      if (res.status === 200) accepted.push({ x, body: await res.json(), query: seen.at(-1).bounds });
      else { assert.equal(res.status, 403); assert.equal((await res.json()).code, 'outside_model'); refused.push(x); }
    }
    assert.ok(accepted.length >= 2 && refused.length >= 2, `accepted ${accepted.map(a => a.x)} refused ${refused}`);
    assert.ok(Math.max(...accepted.map(a => a.x)) < Math.min(...refused), 'one contiguous run from the model outward');
    const projection = coverage.projection;
    const eastOf = lon => projection.latLonToUtm(43.07475, lon)[0];
    for (const { x, body, query } of accepted) {
      // The tile itself lies within the coverage plus the allowance.
      assert.ok(eastOf(tileWest(x + 1, 14)) <= coverage.maxE + TILE_EDGE_ALLOWANCE_METERS + 1, `tile ${x} within the allowance`);
      // The query and every returned point stop at the coverage envelope.
      // The query uses the window's lon/lat bounds (a little larger: grid
      // convergence); the answer is clipped to the UTM window itself.
      const env = authorizedEnvelope('tile', query, version);
      assert.ok(eastOf(env.east) > coverage.maxE && eastOf(env.east) <= coverage.maxE + 600, 'lon/lat query bounds: bounded slack past the window');
      assert.ok(query.east <= env.east && query.west >= env.west, `tile ${x} query clipped`);
      for (const line of body.parcels.flatMap(p => [...p.rings, ...(p.lines || [])])) for (const [lon, lat] of line) {
        const [e, n] = projection.latLonToUtm(lat, lon);
        assert.ok(e <= coverage.maxE + 0.05 && e >= coverage.minE - 0.05 && n <= coverage.maxN + 0.05 && n >= coverage.minN - 0.05, `tile ${x} response clipped to the UTM window`);
      }
      assert.equal(body.parcels[0].owner, 'SAMPLE FARMS LLC');
    }
    const edge = accepted.at(-1);
    assert.ok(eastOf(tileWest(edge.x + 1, 14)) > coverage.maxE, 'the last accepted tile overhangs the coverage');
    assert.ok(edge.query.east < tileWest(edge.x + 1, 14), 'and only its covered part is queried');
    // A dense tile's zoom-16 children are accepted on the same terms.
    const [x16, y16] = tileXY(-89.401, 43.07475, 16);
    assert.equal((await get(`tile=16/${x16}/${y16}`)).status, 200);
    // 3D scene boxes stay limited to the model's site window, not the coverage.
    const site = modelSiteWindow(version);
    const [, outsideSiteLon] = site.projection.utmToLatLon(site.maxE + 500, (site.minN + site.maxN) / 2);
    const sceneBox = `bbox=${(outsideSiteLon - 0.002).toFixed(4)},43.074,${outsideSiteLon.toFixed(4)},43.0755`;
    assert.equal((await get(sceneBox)).status, 403, 'a scene box past the site window is refused even inside the coverage');
  });
});

test('clipping: rings are closed shapes only; lines are the real boundary, each original edge clipped on its own', () => {
  const envelope = { west: -89.41, south: 43.07, east: -89.40, north: 43.08 };
  const segmentsOf = lines => lines.flatMap(line => line.slice(1).map((p, k) => [line[k], p]));
  const onCut = ([p, q]) => p[0] === envelope.east && q[0] === envelope.east;
  // Crosses the east side: the ring closes along the envelope; the lines do not.
  const crossing = [[-89.405, 43.072], [-89.405, 43.075], [-89.395, 43.075], [-89.395, 43.072], [-89.405, 43.072]];
  const ring = clipRing(crossing, envelope);
  assert.ok(ring.every(([lon]) => lon <= envelope.east));
  assert.equal(segmentsOf([ring]).filter(onCut).length, 1, 'the closed shape runs along the envelope');
  const lines = clipBoundary(crossing, envelope);
  assert.deepEqual(lines, [[[-89.4, 43.072], [-89.405, 43.072], [-89.405, 43.075], [-89.4, 43.075]]], 'one open run, ends on the envelope');
  assert.equal(segmentsOf(lines).filter(onCut).length, 0);
  // Stepped parcel: a genuine edge lies exactly on the cutoff while another part crosses it.
  const stepped = [[-89.405, 43.072], [-89.405, 43.078], [-89.395, 43.078], [-89.395, 43.075], [-89.40, 43.075], [-89.40, 43.072], [-89.405, 43.072]];
  const steppedLines = clipBoundary(stepped, envelope);
  const steppedOnCut = segmentsOf(steppedLines).filter(onCut);
  assert.deepEqual(steppedOnCut, [[[-89.40, 43.075], [-89.40, 43.072]]], 'the genuine edge on the cutoff stays; the closure does not appear');
  assert.equal(segmentsOf([clipRing(stepped, envelope)]).filter(onCut).filter(([p, q]) => p[1] !== q[1]).length, 2, 'the shape has both (genuine and closing)');
  // Liang-Barsky per segment: outside, inside, crossing and along a side.
  assert.equal(clipSegment([-89.39, 43.071], [-89.39, 43.079], envelope), null);
  assert.deepEqual(clipSegment([-89.405, 43.071], [-89.402, 43.079], envelope), [[-89.405, 43.071], [-89.402, 43.079]]);
  assert.deepEqual(clipSegment([-89.405, 43.075], [-89.395, 43.075], envelope).map(p => p.map(v => Math.round(v * 1e7) / 1e7)), [[-89.405, 43.075], [-89.4, 43.075]]);
  // Wholly inside: unchanged and no lines field. Clipped: { id, rings, lines, owner? }.
  const inside = [[-89.405, 43.072], [-89.405, 43.075], [-89.402, 43.075], [-89.405, 43.072]];
  assert.equal(clipRing(inside, envelope), inside);
  const out = clipParcels({ status: 'ok', parcels: [{ id: 1, rings: [crossing] }, { id: 2, owner: 'SAMPLE FARMS LLC', rings: [inside] }] }, envelope);
  assert.deepEqual(out.parcels.map(p => Object.keys(p).sort()), [['id', 'lines', 'rings'], ['id', 'owner', 'rings']]);
  assert.deepEqual(out.parcels[0].lines, lines);
});;

test('origin budget: unrelated cache misses from many callers stay within the per-minute origin budget', async () => {
  let calls = 0, now = 0;
  const source = createParcelSource({ now: () => now, limits: { ...LIMITS, originPerMinute: 5 }, fetchImpl: async () => { calls++; return response({ features: [] }); } });
  const box = i => ({ west: -89.5 + i * 0.003, south: 43.07, east: -89.5 + i * 0.003 + 0.002, north: 43.072 });
  const statuses = [];
  for (let i = 0; i < 20; i++) statuses.push((await source.parcels(box(i), { caller: `share:${i}`, snap: false })).status);
  assert.equal(calls, 5, 'at most the budget reaches the parcel service');
  assert.deepEqual(statuses.filter(s => s === 'busy').length, 15);
  assert.equal(source.stats().originRefused, 15);
  assert.equal((await source.parcels(box(0), { caller: 'share:other', snap: false })).status, 'none', 'cached answers are still served');
  assert.equal(calls, 5);
  now += 61_000;
  assert.equal((await source.parcels(box(19), { caller: 'share:19', snap: false })).status, 'none', 'the budget refills after a minute');
  assert.equal(calls, 6);
  assert.equal(LIMITS.originPerMinute, 240, 'production budget');

  // Through the API: a public link asking for many distinct tiles gets 429 once the origin budget is spent.
  let upstream = 0;
  const limited = createParcelSource({ limits: { ...LIMITS, originPerMinute: 3 }, fetchImpl: async () => { upstream++; return response({ features: [] }); } });
  const [cx, cy] = tileXY(-89.401, 43.07475, 16);
  await withServer({ source: limited }, async base => {
    const codes = [];
    for (let dx = 0; dx < 8; dx++) codes.push((await fetch(`${base}/api/v1/property-lines/parcels?tile=16/${cx + dx}/${cy}&model=model-a`, { headers: { Cookie: `ltds_share=${shareCookie()}` } })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429, 429, 429]);
  });
  assert.equal(upstream, 3);
});

test('public links: each client address is its own caller, with its own cap on calls to the parcel service', async () => {
  // One caller cycling uncached tiles spends only its own allowance.
  let calls = 0;
  const source = createParcelSource({ limits: { ...LIMITS, callerOriginPerMinute: 3, originPerMinute: 100 }, fetchImpl: async () => { calls++; return response({ features: [] }); } });
  const box = i => ({ west: -89.5 + i * 0.003, south: 43.07, east: -89.5 + i * 0.003 + 0.002, north: 43.072 });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await source.parcels(box(i), { caller: 'share:s:aaaa', snap: false })).status);
  assert.deepEqual(statuses, ['none', 'none', 'none', 'busy', 'busy', 'busy']);
  assert.equal(source.stats().callerRefused, 3);
  assert.equal((await source.parcels(box(0), { caller: 'share:s:aaaa', snap: false })).status, 'none', 'cache hits never count against the cap');
  assert.equal((await source.parcels(box(10), { caller: 'share:s:bbbb', snap: false })).status, 'none', 'another viewer of the same link still gets through');
  assert.equal(calls, 4);
  assert.equal(LIMITS.callerOriginPerMinute, 60, 'production cap per caller');

  // Through the API: two viewers of one public link are two callers.
  const seen = [];
  const recording = { parcels: async (bounds, options) => { seen.push(options.caller); return { status: 'none', parcels: [] }; } };
  const [cx, cy] = tileXY(-89.401, 43.07475, 14);
  await withServer({ source: recording }, async base => {
    for (const address of ['198.51.100.7', '203.0.113.9', '198.51.100.7'])
      assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?tile=14/${cx}/${cy}&model=model-a`, { headers: { Cookie: `ltds_share=${shareCookie()}`, 'X-Forwarded-For': address } })).status, 200);
  });
  assert.equal(seen.length, 3);
  assert.notEqual(seen[0], seen[1], 'different client addresses: different callers');
  assert.equal(seen[0], seen[2], 'the same address: the same caller');
  assert.ok(seen.every(caller => /^share:share-1:[0-9a-f]{16}$/.test(caller) && !caller.includes('198.51') && !caller.includes('203.0')), 'the address itself is not kept');
});

test('clipping to a model window is exact in its UTM zone, with no lon/lat slack', () => {
  const version = madisonModel('model-a').activeVersion;
  const window = modelCoverageWindow(version);
  const { projection } = window;
  const envelope = authorizedEnvelope('tile', siteLonLatBounds(window), version) || siteLonLatBounds(window);
  // A parcel reaching from inside the window to the far corner of the
  // lon/lat bounds (which lie past the UTM window by grid convergence).
  const [insideLat, insideLon] = projection.utmToLatLon(window.maxE - 300, window.maxN - 300);
  const ring = [[insideLon, insideLat], [insideLon, envelope.north], [envelope.east, envelope.north], [envelope.east, insideLat], [insideLon, insideLat]];
  const [cornerE] = projection.latLonToUtm(envelope.north, envelope.east);
  assert.ok(cornerE > window.maxE + 50, `the lon/lat corner lies ${Math.round(cornerE - window.maxE)} m past the window`);
  const out = clipParcels({ status: 'ok', parcels: [{ id: 1, rings: [ring] }] }, window);
  const points = out.parcels.flatMap(p => [...p.rings, ...p.lines]).flat();
  assert.ok(points.length > 0);
  for (const [lon, lat] of points) {
    const [e, n] = projection.latLonToUtm(lat, lon);
    assert.ok(e <= window.maxE + 0.05 && n <= window.maxN + 0.05, `${e - window.maxE}, ${n - window.maxN}`);
  }
  // A parcel wholly inside comes back exactly as sent.
  const [aLat, aLon] = projection.utmToLatLon(window.maxE - 500, window.maxN - 500);
  const small = [[aLon, aLat], [aLon, aLat + 0.001], [aLon + 0.001, aLat + 0.001], [aLon, aLat]];
  assert.deepEqual(clipParcels({ status: 'ok', parcels: [{ id: 2, rings: [small] }] }, window).parcels, [{ id: 2, rings: [small] }]);
});

test('uploaded features are cut to the window as lines, open or closed', () => {
  const version = madisonModel('model-a').activeVersion;
  const window = modelSiteWindow(version);
  const { projection } = window;
  const at = (dE, dN) => { const [lat, lon] = projection.utmToLatLon(window.maxE + dE, (window.minN + window.maxN) / 2 + dN); return [lon, lat]; };
  const open = [at(-200, 0), at(+300, 0)];                                      // a line running out of the window
  const closed = [at(-100, -50), at(-100, 50), at(+100, 50), at(+100, -50), at(-100, -50)]; // a polygon straddling it
  const inside = [at(-300, -20), at(-300, 20), at(-250, 20), at(-300, -20)];
  const out = clipFeatures({ status: 'ok', simplified: true, parcels: [{ id: 1, rings: [open] }, { id: 2, rings: [closed] }, { id: 3, rings: [inside] }, { id: 4, rings: [[at(+200, 0), at(+400, 0)]] }] }, window);
  assert.equal(out.simplified, true);
  assert.deepEqual(out.parcels.map(p => p.id), [1, 2, 3], 'a feature wholly outside is dropped');
  for (const [lon, lat] of out.parcels.flatMap(p => p.rings).flat()) assert.ok(projection.latLonToUtm(lat, lon)[0] <= window.maxE + 0.05);
  const [e1] = projection.latLonToUtm(out.parcels[0].rings[0][1][1], out.parcels[0].rings[0][1][0]);
  assert.ok(Math.abs(e1 - window.maxE) < 0.05, 'the open line stops at the window edge');
  // The polygon's part inside, as open lines: nothing drawn along the window edge.
  const along = out.parcels[1].rings.flatMap(line => line.slice(1).map((p, k) => [line[k], p]))
    .filter(([a, b]) => [a, b].every(([lon, lat]) => Math.abs(projection.latLonToUtm(lat, lon)[0] - window.maxE) < 0.05));
  assert.equal(along.length, 0);
  assert.deepEqual(out.parcels[2].rings, [inside], 'wholly inside: unchanged');
});

test('API: an uploaded boundary replaces the state layer behind the same access checks', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createBoundaryStore, parseBoundaryFile } = require('../server/propertyLinesBoundary');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel3-serve-'));
  try {
    const boundaries = createBoundaryStore({ baseDir: root, database: { prepare: () => ({ get: (modelId) => (modelId === 'model-a' ? { id: 'project-1' } : undefined) }) } });
    const ring = [[-89.4012, 43.0748], [-89.4005, 43.0748], [-89.4005, 43.0752], [-89.4012, 43.0748]];
    boundaries.save('project-1', parseBoundaryFile(Buffer.from(JSON.stringify({ type: 'Feature', properties: { name: 'Lot', owner: 'x' }, geometry: { type: 'Polygon', coordinates: [ring] } }))), { bytes: 1, sha256: 'e'.repeat(64) });
    let upstream = 0;
    const source = { parcels: async () => { upstream++; return { status: 'ok', parcels: [] }; } };
    const staff = { Authorization: `Bearer ${staffToken}` }, client = { Authorization: `Bearer ${clientToken}` };
    const box = 'bbox=-89.402,43.074,-89.4,43.0755';
    await withServer({ source, boundaries }, async base => {
      const parcels = (headers) => fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, headers ? { headers } : undefined);
      const offer = await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: client })).json();
      assert.equal(offer.source.kind, 'upload');
      assert.equal(offer.source.region, null, 'not tied to Wisconsin coverage');
      assert.match(offer.source.datumNote, /no datum shift/);
      const publicLink = { Cookie: `ltds_share=${shareCookie()}` };
      for (const headers of [staff, client]) {
        assert.deepEqual(await (await parcels(headers)).json(), { status: 'ok', parcels: [{ id: 1, rings: [ring] }] }, 'geometry only, same numbers in and out');
      }
      // Anonymous public link: no layer at all (not the state parcels) until
      // staff choose "Show on public links".
      assert.deepEqual(await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: publicLink })).json(), { offered: false, source: null });
      const hidden = await parcels(publicLink);
      assert.equal(hidden.status, 403);
      assert.equal((await hidden.json()).code, 'property_lines_not_offered');
      boundaries.update('project-1', { publicVisible: true });
      assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: publicLink })).json()).source.kind, 'upload');
      assert.deepEqual(await (await parcels(publicLink)).json(), { status: 'ok', parcels: [{ id: 1, rings: [ring] }] });
      assert.equal(offer.source.datum, 'WGS84');
      assert.match(offer.source.datumNote, /WGS84.*NAD83-based model expect roughly 1 to 1\.5 m/);
      assert.equal((await parcels()).status, 401);
      assert.equal((await parcels({ Authorization: `Bearer ${expiredToken}` })).status, 403);
      assert.equal((await parcels({ Cookie: `ltds_share=${shareCookie(1)}` })).status, 403, 'stale share revision');
      assert.equal(upstream, 0, 'the state service is not asked');
      boundaries.setSource('project-1', 'state');
      assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: staff })).json()).source.id, 'wi-statewide-parcels');
      await parcels(staff);
      assert.equal(upstream, 1);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stated acres are passed on as a plain number, never the field name; missing or bad values are left out', () => {
  const ring = [[[-9952185, 5323242], [-9952000, 5323242], [-9952000, 5323400], [-9952185, 5323242]]];
  const { parcels } = normalizeUpstream({ features: [
    { attributes: { OBJECTID: 1, OWNERNME1: 'SAMPLE', ASSDACRES: 40.123456 }, geometry: { rings: ring } },
    ...[null, 0, -3, 'x', 2e6, undefined].map((ASSDACRES, i) => ({ attributes: { OBJECTID: i + 2, OWNERNME1: 'SAMPLE', ASSDACRES }, geometry: { rings: ring } })),
  ] }, 'OBJECTID', 'OWNERNME1', 'ASSDACRES');
  assert.equal(parcels[0].acres, 40.1235);
  assert.ok(parcels.slice(1).every(parcel => !('acres' in parcel)));
  assert.doesNotMatch(JSON.stringify(parcels), /ASSDACRES/);
  assert.ok(!('acres' in normalizeUpstream({ features: [{ attributes: { OBJECTID: 1, ASSDACRES: 5 }, geometry: { rings: ring } }] }, 'OBJECTID', null, null).parcels[0]), 'only when the source names the field');
});
