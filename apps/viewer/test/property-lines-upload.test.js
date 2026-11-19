'use strict';

// Uploaded boundary files (GeoJSON, KML) as a property-lines source: parsing
// and sniffing, limits, storage, staff-only routes and project purge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { PERMISSIONS } = require('../server/processingApi');
const {
  BOUNDARY_LIMITS, parseBoundaryFile, createBoundaryStore, mountBoundaryRoutes, parcelsInBounds, purgeProjectBoundary, cleanName,
} = require('../server/propertyLinesBoundary');

const square = (lon = -89.401, lat = 43.075, d = 0.0005) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
const fc = (features) => Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }));
const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

test('GeoJSON: only Polygon, MultiPolygon and LineString kept; only a short plain-text name survives', () => {
  const parsed = parseBoundaryFile(fc([
    feature({ type: 'Polygon', coordinates: [square()] }, { name: '<img src=x onerror=alert(1)>Lot <b>7</b>', owner: 'Private Person', apn: '123', description: '<script>x()</script>' }),
    feature({ type: 'MultiPolygon', coordinates: [[square(-89.402)], [square(-89.403)]] }, { Name: 'x'.repeat(500) }),
    feature({ type: 'LineString', coordinates: [[-89.401, 43.075, 250], [-89.400, 43.076, 251]] }),
    feature({ type: 'Point', coordinates: [-89.401, 43.075] }, { name: 'dropped' }),
    feature({ type: 'MultiLineString', coordinates: [[[-89.401, 43.075], [-89.400, 43.076]]] }),
  ]));
  assert.equal(parsed.format, 'geojson');
  assert.equal(parsed.featureCount, 3);
  assert.equal(parsed.droppedCount, 2);
  assert.deepEqual(parsed.geojson.features[0].properties, { name: 'Lot 7' });
  assert.equal(parsed.geojson.features[1].properties.name.length, BOUNDARY_LIMITS.maxNameLength);
  assert.deepEqual(parsed.geojson.features[2].properties, {});
  assert.deepEqual(parsed.geojson.features[2].geometry.coordinates[0], [-89.401, 43.075], 'height dropped, numbers unchanged');
  const text = JSON.stringify(parsed.geojson);
  for (const leaked of ['owner', 'Private Person', 'apn', 'script', 'onerror', '<', '>']) assert.equal(text.includes(leaked), false, leaked);
  // An unclosed ring is closed; a bare geometry and a single feature work.
  const open = parseBoundaryFile(Buffer.from(JSON.stringify({ type: 'Polygon', coordinates: [square().slice(0, 4)] })));
  assert.deepEqual(open.geojson.features[0].geometry.coordinates[0].at(-1), [-89.401, 43.075]);
  assert.equal(parseBoundaryFile(Buffer.from(JSON.stringify(feature({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })))).featureCount, 1);
  assert.equal(cleanName('&lt;b&gt;A&lt;/b&gt;\u202eB'), 'A B');
});

test('coordinates are range-checked and projected or foreign CRS input is refused', () => {
  assert.equal(code(() => parseBoundaryFile(fc([feature({ type: 'Polygon', coordinates: [[[305000, 4771000], [305100, 4771000], [305100, 4771100], [305000, 4771000]]] })]))), 'coordinates_out_of_range');
  assert.equal(code(() => parseBoundaryFile(fc([feature({ type: 'LineString', coordinates: [[-89, 91], [-89, 43]] })]))), 'coordinates_out_of_range');
  assert.equal(code(() => parseBoundaryFile(fc([feature({ type: 'LineString', coordinates: [['-89', 43], [-89, 43]] })]))), 'invalid_coordinates');
  assert.equal(code(() => parseBoundaryFile(Buffer.from(JSON.stringify({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::26916' } }, features: [] })))), 'unsupported_crs');
  assert.equal(code(() => parseBoundaryFile(fc([feature({ type: 'Point', coordinates: [0, 0] })]))), 'no_supported_geometry');
});

test('feature and vertex caps', () => {
  const many = Array.from({ length: BOUNDARY_LIMITS.maxFeatures + 1 }, () => feature({ type: 'LineString', coordinates: [[0, 0], [0.001, 0.001]] }));
  assert.equal(code(() => parseBoundaryFile(fc(many))), 'too_many_features');
  const long = Array.from({ length: BOUNDARY_LIMITS.maxVertices + 1 }, (_, i) => [-89 + i * 1e-7, 43]);
  assert.equal(code(() => parseBoundaryFile(fc([feature({ type: 'LineString', coordinates: long })]))), 'too_many_vertices');
  const kml = `<kml><Document>${'<Placemark><LineString><coordinates>0,0 0.001,0.001</coordinates></LineString></Placemark>'.repeat(BOUNDARY_LIMITS.maxFeatures + 1)}</Document></kml>`;
  assert.equal(code(() => parseBoundaryFile(Buffer.from(kml))), 'too_many_features');
  assert.equal(code(() => parseBoundaryFile(Buffer.alloc(BOUNDARY_LIMITS.maxBytes + 1, 0x20))), 'file_too_large');
});

test('content sniffing ignores the name and type and refuses everything that is not GeoJSON or KML', () => {
  const kml = Buffer.from('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>A</name><LineString><coordinates>-89.4,43.07 -89.39,43.08</coordinates></LineString></Placemark></kml>');
  assert.equal(parseBoundaryFile(kml).format, 'kml', 'KML recognised by content');
  assert.equal(parseBoundaryFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fc([feature({ type: 'Polygon', coordinates: [square()] })])])).format, 'geojson', 'UTF-8 BOM');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('PK\u0003\u0004zipdata'))), 'unsupported_format', 'zip (KMZ, shapefile) is a later PR');
  assert.equal(code(() => parseBoundaryFile(Buffer.from([0xff, 0xfe, 0x00, 0x41]))), 'unsupported_format', 'not UTF-8');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('<html><body><script>alert(1)</script></body></html>'))), 'unsupported_format');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('<svg onload="alert(1)"></svg>'))), 'unsupported_format');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('[1,2,3]'))), 'unsupported_format');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('0\n'))), 'unsupported_format');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('{"type":'))), 'invalid_geojson');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('{"a":1}\u0000'))), 'unsupported_format');
  assert.equal(code(() => parseBoundaryFile(Buffer.alloc(0))), 'empty_file');
});

test('KML: no DTD or entities, nothing external is followed, names are plain text', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&x;</name></Placemark></kml>';
  assert.equal(code(() => parseBoundaryFile(Buffer.from(xxe))), 'kml_dtd_not_allowed');
  const bomb = '<kml><!ENTITY a "aaaa"><Placemark/></kml>';
  assert.equal(code(() => parseBoundaryFile(Buffer.from(bomb))), 'kml_dtd_not_allowed');
  const originalFetch = globalThis.fetch, originalRequest = http.request;
  let network = 0;
  globalThis.fetch = () => { network++; throw new Error('no network'); };
  http.request = () => { network++; throw new Error('no network'); };
  try {
    const parsed = parseBoundaryFile(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
      <kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Document>
        <kml:NetworkLink><kml:Link><kml:href>http://203.0.113.9/x.kml</kml:href></kml:Link></kml:NetworkLink>
        <kml:Style><kml:IconStyle><kml:Icon><kml:href>http://203.0.113.9/i.png</kml:href></kml:Icon></kml:IconStyle></kml:Style>
        <!-- a comment with <Placemark> inside -->
        <kml:Placemark><kml:name><![CDATA[<script>alert(1)</script>Parcel &amp; yard]]></kml:name>
          <kml:description>Owner: Private Person</kml:description>
          <kml:ExtendedData><kml:Data name="owner"><kml:value>Private Person</kml:value></kml:Data></kml:ExtendedData>
          <kml:MultiGeometry>
            <kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>
              -89.401,43.075,0 -89.400,43.075,0 -89.400,43.076,0 -89.401,43.076,0 -89.401,43.075,0
            </kml:coordinates></kml:LinearRing></kml:outerBoundaryIs>
            <kml:innerBoundaryIs><kml:LinearRing><kml:coordinates>-89.4008,43.0752 -89.4004,43.0752 -89.4004,43.0756 -89.4008,43.0752</kml:coordinates></kml:LinearRing></kml:innerBoundaryIs></kml:Polygon>
            <kml:Point><kml:coordinates>-89.4,43.07</kml:coordinates></kml:Point>
          </kml:MultiGeometry></kml:Placemark>
      </kml:Document></kml:kml>`));
    assert.equal(parsed.featureCount, 1);
    assert.equal(parsed.droppedCount, 1, 'point skipped');
    assert.equal(parsed.geojson.features[0].geometry.type, 'Polygon');
    assert.equal(parsed.geojson.features[0].geometry.coordinates.length, 2, 'outer and inner ring');
    assert.deepEqual(parsed.geojson.features[0].properties, { name: 'alert(1) Parcel & yard' });
    const text = JSON.stringify(parsed.geojson);
    assert.equal(/Private Person|owner|href|203\.0\.113|<|>/.test(text), false);
  } finally { globalThis.fetch = originalFetch; http.request = originalRequest; }
  assert.equal(network, 0);
  assert.equal(code(() => parseBoundaryFile(Buffer.from('<kml><Placemark><LineString><coordinates>0,0 1,1</coordinates></Placemark></kml>'))), 'invalid_kml');
  assert.equal(code(() => parseBoundaryFile(Buffer.from('<kml><Placemark><LineString><coordinates>x,y 1,1</coordinates></LineString></Placemark></kml>'))), 'invalid_coordinates');
  // Deep nesting and a huge unclosed input stay linear and are refused.
  assert.equal(code(() => parseBoundaryFile(Buffer.from(`<kml>${'<a>'.repeat(100)}</kml>`))), 'invalid_kml');
  const started = Date.now();
  assert.equal(code(() => parseBoundaryFile(Buffer.from(`<kml>${'<Placemark><name>'.repeat(200_000)}`))), 'invalid_kml');
  assert.ok(Date.now() - started < 5000);
});

function storeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel3-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createBoundaryStore({ baseDir: path.join(root, 'property-lines'), database: { prepare: () => ({ get: (modelId) => (modelId === 'model-a' ? { id: 'project-1' } : undefined) }) } }) };
}

test('storage path comes from the project id only; replace is atomic and leaves one file', (t) => {
  const { root, store } = storeFixture(t);
  for (const bad of ['../x', '..', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(101), 'C:', null]) assert.equal(code(() => store.dirFor(bad)), 'invalid_project', String(bad));
  assert.equal(store.dirFor('project-1'), path.resolve(root, 'property-lines', 'project-1'));
  const first = store.save('project-1', parseBoundaryFile(fc([feature({ type: 'Polygon', coordinates: [square()] })])), { bytes: 10, sha256: 'a'.repeat(64) });
  const second = store.save('project-1', parseBoundaryFile(fc([feature({ type: 'LineString', coordinates: [[-89.401, 43.075], [-89.4, 43.076]] })])), { bytes: 10, sha256: 'b'.repeat(64) });
  assert.notEqual(first.file, second.file);
  const files = fs.readdirSync(store.dirFor('project-1')).sort();
  assert.deepEqual(files, [second.file, 'manifest.json'].sort(), 'old file and temporaries removed');
  assert.equal(store.readManifest('project-1').file, second.file);
  const active = store.activeForModel('model-a');
  assert.equal(active.parcels.length, 1);
  assert.equal(store.activeForModel('model-b'), null, 'a model outside the project gets state parcels');
  // A tampered file is not served.
  fs.writeFileSync(path.join(store.dirFor('project-1'), second.file), '{"type":"FeatureCollection","features":[]}');
  const fresh = createBoundaryStore({ baseDir: path.join(root, 'property-lines'), database: { prepare: () => ({ get: () => ({ id: 'project-1' }) }) } });
  assert.equal(fresh.activeForModel('model-a'), null);
  // Source choice and removal.
  store.setSource('project-1', 'state');
  assert.equal(store.activeForModel('model-a'), null);
  store.remove('project-1');
  assert.equal(fs.existsSync(store.dirFor('project-1')), false);
  assert.equal(code(() => store.setSource('project-1', 'upload')), 'no_upload');
  // Purge removes the folder from the models root.
  const again = createBoundaryStore({ baseDir: path.join(root, 'property-lines'), database: null });
  again.save('project-1', parseBoundaryFile(fc([feature({ type: 'Polygon', coordinates: [square()] })])), { bytes: 1, sha256: 'c'.repeat(64) });
  purgeProjectBoundary({ roots: { models: root } }, '../property-lines');
  assert.equal(fs.existsSync(again.dirFor('project-1')), true, 'no path segments from callers');
  purgeProjectBoundary({ roots: { models: root } }, 'project-1');
  assert.equal(fs.existsSync(again.dirFor('project-1')), false);
});

test('served parcels are filtered to the requested box and capped', () => {
  const parcels = [{ id: 1, rings: [square()], bbox: [-89.401, 43.075, -89.4005, 43.0755] }, { id: 2, rings: [square(-80)], bbox: [-80, 43.075, -79.9995, 43.0755] }];
  assert.deepEqual(parcelsInBounds(parcels, { west: -89.402, south: 43.074, east: -89.4, north: 43.076 }), { status: 'ok', parcels: [{ id: 1, rings: [square()] }] });
  assert.equal(parcelsInBounds(parcels, { west: 10, south: 10, east: 10.1, north: 10.1 }).status, 'none');
  const many = Array.from({ length: BOUNDARY_LIMITS.maxServedParcels + 1 }, (_, i) => ({ id: i, rings: [square()], bbox: [-89.401, 43.075, -89.4, 43.076] }));
  assert.equal(parcelsInBounds(many, { west: -89.402, south: 43.074, east: -89.4, north: 43.076 }).status, 'too_many');
});

async function routeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel3-routes-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database), project = processing.createProject({ displayName: 'Site' });
  const boundaries = createBoundaryStore({ baseDir: path.join(root, 'models', 'property-lines'), database });
  const audits = [];
  // Same shape as processingApi: Bearer admin session with a permission list,
  // Idempotency-Key required on writes.
  const principals = { 'Bearer staff-writer': ['viewer.projects.read', 'viewer.projects.write'], 'Bearer staff-reader': ['viewer.projects.read'] };
  const respond = (res, status, errorCode, message = errorCode) => res.status(status).json({ code: errorCode, error: message, message });
  const authorize = (permission) => (req, res, next) => {
    const permissions = principals[req.get('authorization')];
    if (!permissions) return respond(res, 401, 'authentication_required');
    if (!permissions.includes(permission)) return respond(res, 403, 'permission_denied');
    req.actorId = 'ops:1'; return next();
  };
  const mutate = (req, res, next) => (req.get('idempotency-key') ? next() : respond(res, 428, 'idempotency_key_required'));
  const app = express();
  app.use(express.json({ verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); } }));
  const router = express.Router();
  mountBoundaryRoutes(router, { processing, repository: { audit: (entry) => audits.push(entry) }, boundaries, authorize, mutate, error: respond });
  app.use(router);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.address().port}`, project, processing, boundaries, audits, root };
}

test('routes: staff-only writes with the workspace permission and idempotency rules', async (t) => {
  const { base, project, boundaries, audits } = await routeFixture(t);
  const url = `${base}/api/v1/projects/${project.id}/property-lines`;
  const writer = { authorization: 'Bearer staff-writer' }, reader = { authorization: 'Bearer staff-reader' };
  const body = fc([feature({ type: 'Polygon', coordinates: [square()] }, { name: 'Lot 7', owner: 'x' })]);
  const put = (headers, payload = body) => fetch(`${url}/boundary`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...headers }, body: payload });
  assert.equal((await put({})).status, 401, 'no session');
  assert.equal((await put({ ...reader, 'idempotency-key': 'k-read-0001' })).status, 403, 'read-only staff cannot upload');
  assert.equal((await put({ authorization: 'Bearer client-viewer', 'idempotency-key': 'k-client-01' })).status, 401, 'viewer (client) sessions are not workspace sessions');
  assert.equal((await put(writer)).status, 428, 'Idempotency-Key required');
  assert.equal((await fetch(`${url}/boundary`, { method: 'PUT', headers: { ...writer, 'idempotency-key': 'k-json-0001', 'content-type': 'application/json' }, body })).status, 415);
  assert.equal((await fetch(`${base}/api/v1/projects/..%2F..%2Fetc/property-lines/boundary`, { method: 'PUT', headers: { ...writer, 'idempotency-key': 'k-path-0001', 'content-type': 'application/octet-stream' }, body })).status, 404);
  const bad = await put({ ...writer, 'idempotency-key': 'k-bad-00001' }, Buffer.from('<html></html>'));
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'unsupported_format');
  const ok = await put({ ...writer, 'idempotency-key': 'k-good-0001' });
  assert.equal(ok.status, 201);
  const state = await ok.json();
  assert.equal(state.source, 'upload');
  assert.equal(state.upload.featureCount, 1);
  assert.equal('uploadedBy' in state.upload, false);
  assert.deepEqual(fs.readdirSync(boundaries.dirFor(project.id)).length, 2);
  assert.equal((await (await fetch(url, { headers: reader })).json()).source, 'upload', 'read permission can view the setting');
  assert.equal((await fetch(url, { method: 'PATCH', headers: { ...reader, 'content-type': 'application/json', 'idempotency-key': 'k-patch-001' }, body: '{"source":"state"}' })).status, 403);
  const patched = await fetch(url, { method: 'PATCH', headers: { ...writer, 'content-type': 'application/json', 'idempotency-key': 'k-patch-002' }, body: '{"source":"state"}' });
  assert.equal((await patched.json()).source, 'state');
  assert.equal((await fetch(url, { method: 'PATCH', headers: { ...writer, 'content-type': 'application/json', 'idempotency-key': 'k-patch-003' }, body: '{"source":"elsewhere"}' })).status, 400);
  assert.equal((await fetch(`${url}/boundary`, { method: 'DELETE', headers: { ...reader, 'content-type': 'application/json', 'idempotency-key': 'k-del-00001' }, body: '{}' })).status, 403);
  const removed = await fetch(`${url}/boundary`, { method: 'DELETE', headers: { ...writer, 'content-type': 'application/json', 'idempotency-key': 'k-del-00002' }, body: '{}' });
  assert.deepEqual(await removed.json(), { source: 'state', upload: null });
  assert.equal(fs.existsSync(boundaries.dirFor(project.id)), false);
  assert.deepEqual(audits.map(a => a.action), ['project.property_lines_boundary_uploaded', 'project.property_lines_source_changed', 'project.property_lines_boundary_removed']);
  assert.ok(PERMISSIONS.has('viewer.projects.write'));
});

test('routes: the 20 MB cap is enforced while the body streams in', async (t) => {
  const { base, project, boundaries } = await routeFixture(t);
  const target = new URL(`${base}/api/v1/projects/${project.id}/property-lines/boundary`);
  const send = (declaredLength) => new Promise((resolve, reject) => {
    const headers = { authorization: 'Bearer staff-writer', 'idempotency-key': `k-big-${declaredLength ? 'len' : 'chunk'}`, 'content-type': 'application/octet-stream' };
    if (declaredLength) headers['content-length'] = String(declaredLength); else headers['transfer-encoding'] = 'chunked';
    const req = http.request(target, { method: 'PUT', headers }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, text, written }); }); });
    let written = 0;
    req.on('error', (error) => (['ECONNRESET', 'EPIPE'].includes(error.code) ? resolve({ status: 'reset', written }) : reject(error)));
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const pump = () => { while (written < 22 * 1024 * 1024) { written += chunk.length; if (!req.write(chunk)) { req.once('drain', pump); return; } } req.end(); };
    if (declaredLength) { req.write('{'); written = 1; req.end(); } else pump();
  });
  const declared = await send(BOUNDARY_LIMITS.maxBytes + 1);
  assert.equal(declared.status, 413, 'declared length over the cap is refused before reading');
  const streamed = await send(0);
  assert.ok(streamed.status === 413 || streamed.status === 'reset', `streamed over the cap: ${streamed.status}`);
  if (streamed.status === 413) assert.match(streamed.text, /file_too_large/);
  assert.equal(fs.existsSync(boundaries.dirFor(project.id)), false, 'nothing stored');
});

test('project purge removes the boundary folder; trash alone keeps it for restore', async (t) => {
  const { project, processing, boundaries, root } = await routeFixture(t);
  boundaries.save(project.id, parseBoundaryFile(fc([feature({ type: 'Polygon', coordinates: [square()] })])), { bytes: 1, sha256: 'd'.repeat(64) });
  const { trashProjectTree, purgeContainerTrash } = require('../server/containerLifecycle');
  const storage = { roots: { models: path.join(root, 'models') } };
  const trash = trashProjectTree(processing, storage, project.id, 'ops:1');
  assert.ok(trash?.id);
  assert.equal(fs.existsSync(boundaries.dirFor(project.id)), true, 'restorable while in the trash');
  assert.ok(purgeContainerTrash(processing, storage, trash.id, 'ops:1'));
  assert.equal(fs.existsSync(boundaries.dirFor(project.id)), false);
});
