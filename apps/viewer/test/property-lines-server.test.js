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
  propertyLinesAudience,
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

function fakeRepository(sessions) {
  return {
    getViewerSessionByHash(hash) { return sessions.find(s => auth.hashToken(s.token) === hash) || null; },
    viewerSessionLive(session) { return session.live !== false; },
    rateLimited() { return false; },
  };
}

const staffToken = 'staff-token-aaaaaaaaaaaaaaaa';
const clientToken = 'client-token-bbbbbbbbbbbbbbbb';
const expiredToken = 'expired-token-cccccccccccccccc';
const sessions = [
  { token: staffToken, audience: 'ops', permissions: { view: true } },
  { token: clientToken, audience: 'client', permissions: { view: true } },
  { token: expiredToken, audience: 'ops', permissions: { view: true }, live: false },
];

test('audience: staff sessions, client sessions and public links are told apart', () => {
  const repository = fakeRepository(sessions);
  const req = (headers = {}, cookies = {}) => ({ headers, cookies, get: name => headers[name.toLowerCase()] });
  assert.equal(propertyLinesAudience(req({ authorization: `Bearer ${staffToken}` }), repository), 'staff');
  assert.equal(propertyLinesAudience(req({ authorization: `Bearer ${clientToken}` }), repository), 'client');
  assert.equal(propertyLinesAudience(req({}, { ltds_viewer: staffToken }), repository), 'staff');
  assert.equal(propertyLinesAudience(req({ authorization: `Bearer ${expiredToken}` }), repository), null);
  const share = auth.sign({ shareId: 'share-1', modelId: 'm' }, 60_000);
  assert.equal(propertyLinesAudience(req({}, { ltds_share: share }), repository), 'public');
  assert.equal(propertyLinesAudience(req({}, { ltds_share: `${share}x` }), repository), null, 'forged share cookie');
  assert.equal(propertyLinesAudience(req(), repository), null);
});

test('gating: staff always, client and public only when terms are confirmed', () => {
  assert.equal(propertyLinesOffered('staff'), true);
  assert.equal(propertyLinesOffered('staff', { clientTermsConfirmed: false }), true);
  assert.equal(propertyLinesOffered('client'), false);
  assert.equal(propertyLinesOffered('public'), false);
  assert.equal(propertyLinesOffered('client', { clientTermsConfirmed: true }), true);
  assert.equal(propertyLinesOffered('public', { clientTermsConfirmed: true }), true);
  assert.equal(propertyLinesOffered(null, { clientTermsConfirmed: true }), false);
  assert.equal(require('../server/config').config.propertyLinesClientTermsConfirmed, false, 'default off');
});

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('parcel source limits size, time and concurrency and caches briefly', async () => {
  let calls = 0, now = 0;
  const feature = { attributes: { OBJECTID: 1 }, geometry: { rings: [[[-9952258.43, 5322446.65], [-9952000, 5322446.65]]] } };
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
  now += 11 * 60 * 1000;
  await source.parcels(MADISON);
  assert.equal(calls, 2, 'cache expires');

  const big = createParcelSource({ fetchImpl: async () => response('x'.repeat(100), { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  assert.equal((await big.parcels(MADISON)).status, 'unavailable');
  const streamed = createParcelSource({ limits: { maxResponseBytes: 50, timeoutMs: 1000, cacheEntries: 4, cacheTtlMs: 1000, maxInFlight: 4 }, fetchImpl: async () => response({ features: [feature, feature, feature] }) });
  assert.equal((await streamed.parcels(MADISON)).status, 'unavailable', 'body over the limit is refused');
  const failing = createParcelSource({ fetchImpl: async () => response({ error: 'x' }, { status: 500 }) });
  assert.equal((await failing.parcels(MADISON)).status, 'unavailable');
  const timedOut = createParcelSource({ limits: { maxResponseBytes: 1000, timeoutMs: 20, cacheEntries: 4, cacheTtlMs: 1000, maxInFlight: 4 },
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  assert.equal((await timedOut.parcels(MADISON)).status, 'unavailable');

  let release;
  const slow = createParcelSource({ limits: { maxResponseBytes: 1e6, timeoutMs: 1000, cacheEntries: 4, cacheTtlMs: 1000, maxInFlight: 1 },
    fetchImpl: () => new Promise(resolve => { release = () => resolve(response({ features: [] })); }) });
  const first = slow.parcels(MADISON);
  const same = slow.parcels(MADISON);
  assert.equal((await slow.parcels({ ...MADISON, west: -89.403 })).status, 'busy');
  release();
  assert.equal((await first).status, 'none');
  assert.equal((await same).status, 'none', 'identical requests share one upstream call');
});

async function withServer({ clientTermsConfirmed, source }, run) {
  const app = express();
  app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(p => p.trim().split('='))); next(); });
  app.use(createPropertyLinesApi({ repository: fakeRepository(sessions), config: { propertyLinesClientTermsConfirmed: clientTermsConfirmed }, source }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('API refuses clients until terms are confirmed and accepts only a bbox', async () => {
  const seen = [];
  const source = { parcels: async bounds => { seen.push(bounds); return { status: 'ok', parcels: [{ id: 1, rings: [[[-89.401, 43.075], [-89.4015, 43.075]]] }] }; } };
  const staff = { Authorization: `Bearer ${staffToken}` }, client = { Authorization: `Bearer ${clientToken}` };
  await withServer({ clientTermsConfirmed: false, source }, async base => {
    assert.equal((await fetch(`${base}/api/v1/property-lines`)).status, 401);
    const offerStaff = await (await fetch(`${base}/api/v1/property-lines`, { headers: staff })).json();
    assert.equal(offerStaff.offered, true);
    assert.equal(offerStaff.source.release, 'V12 (2026)');
    assert.match(offerStaff.source.disclaimer, /not a survey/);
    assert.equal((await (await fetch(`${base}/api/v1/property-lines`, { headers: client })).json()).offered, false);
    const share = auth.sign({ shareId: 'share-1', modelId: 'm' }, 60_000);
    assert.equal((await (await fetch(`${base}/api/v1/property-lines`, { headers: { Cookie: `ltds_share=${share}` } })).json()).offered, false);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755`, { headers: client })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755`, { headers: { Cookie: `ltds_share=${share}` } })).status, 403);
    const ok = await fetch(`${base}/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755`, { headers: staff });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await ok.json()).sort(), ['parcels', 'status']);
    for (const query of ['bbox=-89.402,43.074,-89.4,43.0755&url=https://example.invalid', 'bbox=-89.402,43.074,-89.4,43.0755&outFields=*',
      'where=1%3D1', 'bbox=1,2,3', 'bbox=-89.5,43.0,-89.4,43.05', 'bbox[]=1'])
      assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?${query}`, { headers: staff })).status, 400, query);
    const outside = await (await fetch(`${base}/api/v1/property-lines/parcels?bbox=-93.30,44.97,-93.25,44.99`, { headers: staff })).json();
    assert.equal(outside.status, 'outside');
    assert.equal(seen.length, 1, 'invalid and out-of-state requests never reach the state service');
  });
  await withServer({ clientTermsConfirmed: true, source }, async base => {
    assert.equal((await (await fetch(`${base}/api/v1/property-lines`, { headers: client })).json()).offered, true);
    assert.equal((await fetch(`${base}/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755`, { headers: client })).status, 200);
  });
  await withServer({ clientTermsConfirmed: false, source: { parcels: async () => ({ status: 'unavailable', parcels: [] }) } }, async base => {
    const failed = await fetch(`${base}/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755`, { headers: staff });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).status, 'unavailable');
  });
});
