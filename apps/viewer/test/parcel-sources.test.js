'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const auth = require('../server/auth');
const { APPROVED_PARCEL_FIELDS, PARCEL_SOURCES, WISCONSIN, selectParcelSource, validateParcelSource, validateRegistry } = require('../server/parcelSources');
const {
  WISCONSIN_PARCELS, createParcelSource, createPropertyLinesApi, parcelSourceForModel, parseBoundingBox, sourceDescription, upstreamQueryUrl,
} = require('../server/propertyLines');
const { createBoundaryStore, parseBoundaryFile } = require('../server/propertyLinesBoundary');
const { createUtmProjection } = require('../utm-conversion.mjs');

// Captured from main before the registry existed: the exact Wisconsin request
// and the exact source description.
const MADISON = { west: -89.402, south: 43.074, east: -89.400, north: 43.0755 };
const MAIN_MADISON_URL = 'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query?where=1%3D1&geometry=%7B%22xmin%22%3A-9952185.12%2C%22ymin%22%3A5323242.19%2C%22xmax%22%3A-9951962.48%2C%22ymax%22%3A5323470.79%2C%22spatialReference%22%3A%7B%22wkid%22%3A3857%7D%7D&geometryType=esriGeometryEnvelope&inSR=3857&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID&returnGeometry=true&returnZ=false&returnM=false&outSR=3857&geometryPrecision=2&resultRecordCount=800&f=json';
const MAIN_EDGE_URL = 'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query?where=1%3D1&geometry=%7B%22xmin%22%3A-10340467.5%2C%22ymin%22%3A5234664.03%2C%22xmax%22%3A-10336014.72%2C%22ymax%22%3A5239194.01%2C%22spatialReference%22%3A%7B%22wkid%22%3A3857%7D%7D&geometryType=esriGeometryEnvelope&inSR=3857&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID&returnGeometry=true&returnZ=false&returnM=false&outSR=3857&geometryPrecision=2&resultRecordCount=800&f=json';
const MAIN_DESCRIPTION = '{"id":"wi-statewide-parcels","name":"Wisconsin Statewide Parcel Map","release":"V12 (2026)","credit":"Product of the Version 12 Statewide Parcel Map Database Project (V12). Created by the Wisconsin State Cartographer\'s Office; administered by the Wisconsin Land Information Program at the Department of Administration.","disclaimer":"Property lines are approximate and for reference only. They are not a survey and do not show legal ownership boundaries. No warranty of accuracy, completeness or currency is made. Only a licensed land surveyor can determine a boundary.","datumNote":"The state data is NAD83-based and is drawn with no datum shift. Against a model in a WGS84 or ITRF-based frame, expect roughly 1 to 1.5 m of offset in Wisconsin, within the parcel map\u2019s own accuracy.","datum":"NAD83","region":"Wisconsin"}';

// Owner labels added the owner-name field to the request and the data
// vintage to the description; nothing else about either changed.
const withOwner = url => url.replace('outFields=OBJECTID&', 'outFields=OBJECTID%2COWNERNME1&');
const WI_MADISON_URL = withOwner(MAIN_MADISON_URL), WI_EDGE_URL = withOwner(MAIN_EDGE_URL);
const WI_DESCRIPTION = JSON.stringify({ ...JSON.parse(MAIN_DESCRIPTION), shortName: 'WI statewide', vintage: 'V12, 2025 tax roll', dataUpdated: '2026-06-30', owners: 'yes' });

// A test-only second source (not a real state) north of Wisconsin's extent.
const NORTH = Object.freeze({
  ...WISCONSIN, id: 'test-north', region: 'Test North', name: 'Test parcels', release: 'T1', discovery: null,
  layerUrl: 'https://parcels.example.invalid/arcgis/rest/services/Test/FeatureServer/0',
  extent: Object.freeze({ west: -92.0, south: 47.5, east: -89.0, north: 48.5 }),
});
// The test source's own field approval, passed explicitly; never in the real allowlist.
const TEST_APPROVED = Object.freeze({ ...APPROVED_PARCEL_FIELDS, 'test-north': Object.freeze({ idField: 'OBJECTID', ownerField: 'OWNERNME1' }) });

function modelAt(id, lat, lon, zoneLon0) {
  const [e, n] = createUtmProjection({ zoneLon0Deg: zoneLon0, hemisphere: 'N' }).latLonToUtm(lat, lon);
  const bboxCenter = { x: 12, y: -8, z: 3 };
  return { id, status: 'ready', activeVersionId: `${id}-v1`,
    activeVersion: { id: `${id}-v1`, status: 'ready', metadata: { processingMetrics: { surveyedAreaM2: 200_000 } },
      georef: { hemisphere: 'N', utmZoneLon0Deg: zoneLon0, rtc: { e: e - bboxCenter.x, n: n - bboxCenter.y, z: 250 }, bboxCenter } } };
}
const MODELS = {
  madison: modelAt('madison', 43.07475, -89.401, -87),
  minneapolis: modelAt('minneapolis', 44.98, -93.275, -93),
  north: modelAt('north', 48.0, -90.5, -93),
};

const token = 'staff-token-aaaaaaaaaaaaaaaa';
function repository() {
  // One live staff session per model.
  const sessions = Object.keys(MODELS).map(modelId => ({ id: `s-${modelId}`, token: `${token}-${modelId}`, audience: 'ops', permissions: { view: true }, modelId, modelVersionId: `${modelId}-v1` }));
  return {
    resolveModelId: id => (MODELS[id] ? id : null),
    getModel: id => MODELS[id] || null,
    getModelVersion: id => MODELS[id] || null,
    getViewerSessionByHash: hash => sessions.find(s => auth.hashToken(s.token) === hash) || null,
    viewerSessionLive: () => true,
    rateLimited: () => false,
  };
}

async function withApi(options, run) {
  const repo = repository();
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createPropertyLinesApi({ repository: repo, validator: { allows: async () => true }, ...options }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = (route, modelId) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { Authorization: `Bearer ${token}-${modelId}` } });
  try { await run(get); } finally { await new Promise(resolve => server.close(resolve)); }
}

const boxAround = (lat, lon) => `${(lon - 0.001).toFixed(4)},${(lat - 0.001).toFixed(4)},${(lon + 0.001).toFixed(4)},${(lat + 0.001).toFixed(4)}`;
const okResponse = () => new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

test('registry: Wisconsin is the only source and keeps its config', () => {
  assert.deepEqual(PARCEL_SOURCES.map(s => s.id), ['wi-statewide-parcels']);
  assert.equal(WISCONSIN_PARCELS, WISCONSIN, 'the old export is the registry entry');
  assert.equal(Object.isFrozen(PARCEL_SOURCES) && Object.isFrozen(WISCONSIN), true);
  assert.equal(WISCONSIN.query.outFields, 'OBJECTID,OWNERNME1', 'geometry, row id and the first owner name only');
  assert.equal(WISCONSIN.query.ownerField, 'OWNERNME1');
  assert.deepEqual([WISCONSIN.shortName, WISCONSIN.vintage, WISCONSIN.dataUpdated], ['WI statewide', 'V12, 2025 tax roll', '2026-06-30']);
  assert.equal(WISCONSIN.discovery.currentVersion, 12);
  assert.match(WISCONSIN.release, /^V12 /);
});

test('registry: fields are an exact per-source allowlist', () => {
  assert.deepEqual(APPROVED_PARCEL_FIELDS, { 'wi-statewide-parcels': { idField: 'OBJECTID', ownerField: 'OWNERNME1' } }, 'WI: OBJECTID, OWNERNME1 and geometry only');
  assert.equal(Object.isFrozen(APPROVED_PARCEL_FIELDS) && Object.isFrozen(APPROVED_PARCEL_FIELDS['wi-statewide-parcels']), true);
  assert.doesNotThrow(() => validateParcelSource(WISCONSIN));
  // A source with no approved entry is refused, whatever it asks for.
  assert.throws(() => validateParcelSource(NORTH), /approved fields/);
  assert.throws(() => validateParcelSource({ ...WISCONSIN, id: 'wi-copy' }), /approved fields/);
  assert.throws(() => validateRegistry([WISCONSIN, NORTH]), /approved fields/);
  // Anything but the exact approved list is refused, including fields that look harmless.
  const wiQuery = WISCONSIN.query;
  for (const query of [
    { ...wiQuery, outFields: 'OBJECTID,OWNERNME1,OWNERNME2' }, { ...wiQuery, outFields: 'OBJECTID,OWNERNME1,SITEADRESS' },
    { ...wiQuery, ownerField: 'OWNERNME2', outFields: 'OBJECTID,OWNERNME2' }, { ...wiQuery, ownerField: 'TAXROLLYEAR', outFields: 'OBJECTID,TAXROLLYEAR' },
    { ...wiQuery, outFields: '*' }, { ...wiQuery, outFields: 'OWNERNME1,OBJECTID' }, { ...wiQuery, idField: 'PARCELID', outFields: 'PARCELID,OWNERNME1' },
    { ...wiQuery, ownerField: null, outFields: 'OBJECTID' },
  ]) assert.throws(() => validateParcelSource({ ...WISCONSIN, query }), /query\./, JSON.stringify(query));
  // A geometry-only approval allows exactly the id field.
  const plain = { ...TEST_APPROVED, 'test-north': Object.freeze({ idField: 'OBJECTID' }) };
  assert.doesNotThrow(() => validateParcelSource({ ...NORTH, query: { ...NORTH.query, ownerField: undefined, outFields: 'OBJECTID' } }, plain));
  assert.throws(() => validateParcelSource(NORTH, plain), /ownerField/);
});

test('registry: invalid or unsafe configs are refused', () => {
  const check = source => validateParcelSource(source, TEST_APPROVED);
  assert.doesNotThrow(() => check(NORTH));
  assert.throws(() => check({ ...NORTH, dataUpdated: 'June 2026' }), /dataUpdated/);
  assert.throws(() => check({ ...NORTH, query: { ...NORTH.query, wkid: 4269 } }), /wkid/);
  assert.throws(() => check({ ...NORTH, layerUrl: 'http://parcels.example.invalid/x/FeatureServer/0' }), /layerUrl/);
  assert.throws(() => check({ ...NORTH, layerUrl: `${NORTH.layerUrl}?token=x` }), /layerUrl/);
  assert.throws(() => check({ ...NORTH, extent: { west: 1, south: 2, east: 0, north: 3 } }), /extent/);
  assert.throws(() => check({ ...NORTH, datum: 'WGS84' }), /datum/);
  assert.throws(() => validateRegistry([WISCONSIN, WISCONSIN]), /duplicate/);
});

test('selection: first source whose extent touches the location, else none', () => {
  assert.equal(selectParcelSource(MADISON), WISCONSIN);
  assert.equal(selectParcelSource({ west: -93.30, south: 44.97, east: -93.25, north: 44.99 }), null, 'Minneapolis');
  assert.equal(selectParcelSource({ west: -92.95, south: 42.40, east: -92.89, north: 42.49 }), WISCONSIN, 'touching the corner counts');
  assert.equal(selectParcelSource({ west: -90.6, south: 47.9, east: -90.5, north: 48.0 }, [WISCONSIN, NORTH]), NORTH);
  assert.equal(selectParcelSource({ west: -90.6, south: 47.0, east: -90.5, north: 47.6 }, [WISCONSIN, NORTH]), WISCONSIN, 'overlap: first wins');
  assert.equal(selectParcelSource({ west: -90.6, south: 47.0, east: -90.5, north: 47.6 }, [NORTH, WISCONSIN]), NORTH);
  assert.equal(selectParcelSource(null), null);
  assert.equal(parcelSourceForModel(MODELS.madison.activeVersion), WISCONSIN, 'a Wisconsin model picks the WI source');
  assert.equal(parcelSourceForModel(MODELS.minneapolis.activeVersion), null, 'outside every extent: no state source');
  assert.equal(parcelSourceForModel(MODELS.north.activeVersion), null);
  assert.equal(parcelSourceForModel(MODELS.north.activeVersion, [WISCONSIN, NORTH]), NORTH);
  assert.equal(parcelSourceForModel({ georef: {} }), null, 'no verified georeference');
});

test('Wisconsin request and description are byte-for-byte those of main', async () => {
  assert.equal(upstreamQueryUrl(MADISON), WI_MADISON_URL);
  assert.equal(upstreamQueryUrl(MADISON, WISCONSIN), WI_MADISON_URL);
  assert.equal(upstreamQueryUrl(MADISON, WISCONSIN.layerUrl), WI_MADISON_URL);
  assert.equal(upstreamQueryUrl({ west: -92.89, south: 42.49, east: -92.85, north: 42.52 }), WI_EDGE_URL);
  assert.equal(JSON.stringify(sourceDescription()), WI_DESCRIPTION);
  assert.equal(JSON.stringify(sourceDescription(WISCONSIN)), WI_DESCRIPTION);
  assert.deepEqual(parseBoundingBox('-89.402,43.074,-89.4,43.0755'), { bounds: MADISON });
  assert.deepEqual(parseBoundingBox('-93.30,44.97,-93.25,44.99'), { outside: true, bounds: { west: -93.3, south: 44.97, east: -93.25, north: 44.99 } });
  const seen = [];
  const source = createParcelSource({ fetchImpl: async (url, options) => { seen.push({ url, options }); return okResponse(); } });
  await source.parcels(MADISON);
  assert.equal(seen[0].url, WI_MADISON_URL);
  assert.deepEqual(Object.keys(seen[0].options).sort(), ['headers', 'method', 'redirect', 'referrerPolicy', 'signal']);
  assert.deepEqual(seen[0].options.headers, { Accept: 'application/json' });
});

test('API: a Wisconsin model is served from the WI source with the same request and description', async () => {
  const seen = [];
  await withApi({ fetchImpl: async url => { seen.push(url); return okResponse(); } }, async get => {
    const offer = await (await get('/api/v1/property-lines?model=madison', 'madison')).json();
    assert.equal(offer.offered, true);
    assert.equal(JSON.stringify(offer.source), WI_DESCRIPTION);
    const body = await (await get('/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755&model=madison', 'madison')).json();
    assert.deepEqual(body, { status: 'none', parcels: [] });
    await get('/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755&model=madison', 'madison');
  });
  assert.deepEqual(seen, [WI_MADISON_URL], 'one upstream call, the cache answers the repeat');
});

test('API: a model outside every extent gets no state source, as before', async () => {
  let upstream = 0;
  await withApi({ fetchImpl: async () => { upstream++; return okResponse(); } }, async get => {
    const offer = await (await get('/api/v1/property-lines?model=minneapolis', 'minneapolis')).json();
    assert.equal(JSON.stringify(offer.source), WI_DESCRIPTION, 'unchanged response; the browser coverage check says Wisconsin only');
    const response = await get(`/api/v1/property-lines/parcels?bbox=${boxAround(44.98, -93.275)}&model=minneapolis`, 'minneapolis');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'outside', parcels: [] });
  });
  assert.equal(upstream, 0, 'no state service is asked');
});

test('API: each registered source serves its own models with its own fetcher', async () => {
  const seen = [];
  await withApi({ sources: [WISCONSIN, NORTH], approvedFields: TEST_APPROVED, fetchImpl: async url => { seen.push(url); return okResponse(); } }, async get => {
    const offer = await (await get('/api/v1/property-lines?model=north', 'north')).json();
    assert.equal(offer.source.id, 'test-north');
    assert.equal(offer.source.region, 'Test North');
    await get(`/api/v1/property-lines/parcels?bbox=${boxAround(48.0, -90.5)}&model=north`, 'north');
    await get('/api/v1/property-lines/parcels?bbox=-89.402,43.074,-89.4,43.0755&model=madison', 'madison');
    assert.equal(JSON.stringify((await (await get('/api/v1/property-lines?model=madison', 'madison')).json()).source), WI_DESCRIPTION);
  });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].startsWith(`${NORTH.layerUrl}/query?`));
  assert.equal(seen[1], WI_MADISON_URL);
});

test('API: an uploaded boundary still takes precedence over any state source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-registry-'));
  try {
    const boundaries = createBoundaryStore({ baseDir: root, database: { prepare: () => ({ get: modelId => ({ madison: { id: 'p-wi' }, minneapolis: { id: 'p-mn' } })[modelId] }) } });
    const r6 = v => Math.round(v * 1e6) / 1e6;
    const ring = (lat, lon) => [[lon - 0.0004, lat - 0.0002], [lon + 0.0003, lat - 0.0002], [lon + 0.0003, lat + 0.0002], [lon - 0.0004, lat - 0.0002]].map(p => p.map(r6));
    const save = (project, lat, lon) => boundaries.save(project, parseBoundaryFile(Buffer.from(JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(lat, lon)] } }))), { bytes: 1, sha256: 'e'.repeat(64) });
    save('p-wi', 43.07475, -89.401);
    save('p-mn', 44.98, -93.275);
    let upstream = 0;
    await withApi({ boundaries, fetchImpl: async () => { upstream++; return okResponse(); } }, async get => {
      for (const [model, lat, lon, bbox] of [['madison', 43.07475, -89.401, '-89.402,43.074,-89.4,43.0755'], ['minneapolis', 44.98, -93.275, boxAround(44.98, -93.275)]]) {
        const offer = await (await get(`/api/v1/property-lines?model=${model}`, model)).json();
        assert.equal(offer.source.kind, 'upload', model);
        assert.equal(offer.source.disclaimer, WISCONSIN.disclaimer);
        assert.deepEqual(await (await get(`/api/v1/property-lines/parcels?bbox=${bbox}&model=${model}`, model)).json(), { status: 'ok', parcels: [{ id: 1, rings: [ring(lat, lon)] }] }, model);
      }
    });
    assert.equal(upstream, 0, 'the upload replaces the state layer, inside or outside every extent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
