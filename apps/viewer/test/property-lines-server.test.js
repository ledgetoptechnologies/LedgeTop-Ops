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
  boundsInsideSite,
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

test('upstream query is fixed: geometry only, Web Mercator, bounded count, fixed host', () => {
  const url = new URL(upstreamQueryUrl(MADISON));
  assert.equal(url.origin + url.pathname, `${WISCONSIN_PARCELS.layerUrl}/query`);
  assert.equal(url.hostname, 'services3.arcgis.com');
  const p = url.searchParams;
  assert.equal(p.get('outFields'), 'OBJECTID', 'no owner, address or value fields');
  assert.doesNotMatch(url.search, /OWNER|ADRESS|ADDRESS|VALUE|PSTL|SITE|\*/i);
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
});

test('gating: staff always, client and public only when terms are confirmed', () => {
  assert.equal(propertyLinesOffered('staff'), true);
  assert.equal(propertyLinesOffered('staff', { clientTermsConfirmed: false }), true);
  assert.equal(propertyLinesOffered('client'), false);
  assert.equal(propertyLinesOffered('public'), false);
  assert.equal(propertyLinesOffered('client', { clientTermsConfirmed: true }), true);
  assert.equal(propertyLinesOffered('public', { clientTermsConfirmed: true }), true);
  assert.equal(propertyLinesOffered(null, { clientTermsConfirmed: true }), false);
});

test('the client terms setting defaults to off and only an explicit true turns it on', () => {
  const key = 'PROPERTY_LINES_CLIENT_TERMS_CONFIRMED', saved = process.env[key], path = require.resolve('../server/config');
  const load = value => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete require.cache[path];
    return require('../server/config').config.propertyLinesClientTermsConfirmed;
  };
  try {
    assert.equal(load(undefined), false, 'unset is off');
    assert.equal(load(''), false);
    assert.equal(load('false'), false);
    assert.equal(load('true'), true);
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    delete require.cache[path];
    require('../server/config');
  }
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
  assert.equal((await slow.parcels(box(-89.375), { caller: 'session:a' })).status !== 'busy', true, 'slot released after completion');
});

async function withServer({ clientTermsConfirmed, source, repository = fakeRepository(sessions, { shares: { 'share-1': liveShare, 'share-revoked': { ...liveShare, id: 'share-revoked', active: false } } }) }, run) {
  const app = express();
  app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(p => p.trim().split('='))); next(); });
  app.use(createPropertyLinesApi({ repository, config: { propertyLinesClientTermsConfirmed: clientTermsConfirmed }, source, validator: allow }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('API: gating, live share checks, model binding and strict parameters', async () => {
  const seen = [];
  const source = { parcels: async (bounds, options) => { seen.push({ bounds, options }); return { status: 'ok', parcels: [{ id: 1, rings: [[[-89.401, 43.075], [-89.4015, 43.075]]] }] }; } };
  const staff = { Authorization: `Bearer ${staffToken}` }, client = { Authorization: `Bearer ${clientToken}` };
  const box = 'bbox=-89.402,43.074,-89.4,43.0755';
  const cookie = value => ({ Cookie: `ltds_share=${value}` });
  await withServer({ clientTermsConfirmed: false, source }, async base => {
    assert.equal((await fetch(`${base}/api/v1/property-lines?model=model-a`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/property-lines`, { headers: staff })).status, 400, 'model is required');
    const offerStaff = await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: staff })).json();
    assert.equal(offerStaff.offered, true);
    assert.equal(offerStaff.source.release, 'V12 (2026)');
    assert.match(offerStaff.source.disclaimer, /not a survey/);
    assert.match(offerStaff.source.datumNote, /NAD83.*1 to 1\.5 m/);
    assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: client })).json()).offered, false);
    assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: cookie(shareCookie()) })).json()).offered, false);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: client })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie()) })).status, 403);
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
    assert.equal(seen.length, 1, 'refused requests never reach the state service');
  });
  await withServer({ clientTermsConfirmed: true, source }, async base => {
    assert.equal((await (await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: client })).json()).offered, true);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: client })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie()) })).status, 200, 'live share at its current revision');
    // Revoked or out-of-date public links are refused even with the setting on.
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie(2, 'share-revoked')) })).status, 403, 'revoked share');
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: cookie(shareCookie(1)) })).status, 403, 'older share revision');
    assert.equal((await fetch(`${base}/api/v1/property-lines?model=model-a`, { headers: cookie(shareCookie(1)) })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: { Authorization: `Bearer ${expiredToken}` } })).status, 403, 'expired session');
  });
  await withServer({ clientTermsConfirmed: false, source: { parcels: async () => ({ status: 'unavailable', parcels: [] }) } }, async base => {
    const failed = await fetch(`${base}/api/v1/property-lines/parcels?${box}&model=model-a`, { headers: staff });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).status, 'unavailable');
  });
});
