'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { toViewerConfig } = require('../server/apiV1');
const { MAX_CAMERA_FEATURES, discoverCameraPhotoLinks, reconcileImportedCameraPhotoLinks, validCameraFilename } = require('../server/cameraPhotos');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { extractZipFile } = require('../server/safeZip');
const { StorageManager } = require('../server/storageManager');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

test('file ZIP extraction reports bounded monotonic byte and entry progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-zip-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'task.zip'), destination = path.join(root, 'task');
  // Three stored WebODM-shaped artifacts; the fixture is tiny, but exercises
  // the same central-directory declared-byte accounting as a multi-GB backup.
  fs.writeFileSync(archive, Buffer.from('UEsDBBQAAAAAAG5SEV1oIC3YAwAAAAMAAAAoAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYmdsYlBLAwQUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAGVudHdpbmVfcG9pbnRjbG91ZC9lcHQuanNvbnt9UEsDBBQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29ue31QSwECFAAUAAAAAABuUhFdaCAt2AMAAAADAAAAKAAAAAAAAAAAAAAAAAAAAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYlBLAQIUABQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAAAAAAAAAAAAAAEkAAABlbnR3aW5lX3BvaW50Y2xvdWQvZXB0Lmpzb25QSwECFAAUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAAAAAAAAAAAAAACEAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29uUEsFBgAAAAADAAMA6AAAAL8AAAAAAA==', 'base64'));
  const updates = [];
  const result = await extractZipFile(archive, destination, { onProgress: (fraction, details) => updates.push({ fraction, ...details }) });
  assert.deepEqual(result, { entries: 3, bytes: 7 });
  assert.ok(updates.length >= 3);
  assert.equal(updates[0].fraction, 0);
  assert.equal(updates.at(-1).fraction, 1);
  assert.equal(updates.at(-1).extractedBytes, updates.at(-1).declaredBytes);
  assert.equal(updates.at(-1).extractedEntries, updates.at(-1).totalEntries);
  assert.ok(updates.every((item, index) => index === 0 || item.fraction >= updates[index - 1].fraction));
  assert.ok(updates.every((item) => item.fraction >= 0 && item.fraction <= 1));
});

test('shots filenames link only to exact safe root JPEGs while missing photos preserve camera data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets', 'odm_report'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DJI_0001.JPG'), 'photo-one');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'nested.jpg'), 'nested-photo');
  const document = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } },
      { type: 'Feature', properties: { filename: 'missing.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 201] } },
      { type: 'Feature', properties: { filename: '../escape.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 202] } },
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 203] } },
      { type: 'Feature', properties: { filename: 'images/nested.jpg' }, geometry: { type: 'Point', coordinates: [-87, 44, 204] } },
    ],
  };
  const shotsBody = JSON.stringify(document);
  fs.writeFileSync(path.join(root, 'assets', 'odm_report', 'shots.geojson'), shotsBody);
  const discovered = {
    assets: [{ kind: 'shots', relativePath: 'assets/odm_report/shots.geojson', byteSize: Buffer.byteLength(shotsBody) }],
    files: [
      { relativePath: 'DJI_0001.JPG', byteSize: 9, sha256: digest('photo-one') },
      { relativePath: 'images/nested.jpg', byteSize: 12, sha256: digest('nested-photo') },
    ],
  };
  assert.deepEqual(discoverCameraPhotoLinks(root, discovered), [{
    filename: 'DJI_0001.JPG', relativePath: 'DJI_0001.JPG', byteSize: 9,
    sha256: digest('photo-one'), contentType: 'image/jpeg',
  }, {
    filename: 'images/nested.jpg', relativePath: 'images/nested.jpg', byteSize: 12,
    sha256: digest('nested-photo'), contentType: 'image/jpeg',
  }]);
  assert.equal(document.features.length, 5, 'link discovery never removes camera positions when a photo is absent');
  assert.equal(validCameraFilename('../escape.JPG'), null);
  assert.equal(validCameraFilename('folder/photo.jpg'), 'folder/photo.jpg');
  assert.equal(validCameraFilename('folder/../photo.jpg'), null);
  assert.equal(validCameraFilename('photo.png'), null);
  assert.equal(validCameraFilename('photo.jpeg'), 'photo.jpeg');

  const oversizedDocument = { type: 'FeatureCollection', features: Array.from({ length: MAX_CAMERA_FEATURES + 1 }, () => ({ properties: { filename: 'DJI_0001.JPG' } })) };
  const oversizedBody = JSON.stringify(oversizedDocument);
  fs.writeFileSync(path.join(root, 'assets', 'odm_report', 'shots.geojson'), oversizedBody);
  discovered.assets[0].byteSize = Buffer.byteLength(oversizedBody);
  assert.deepEqual(discoverCameraPhotoLinks(root, discovered), [], 'camera indexing fails closed before materializing an unbounded feature set');

  fs.writeFileSync(path.join(root, 'assets', 'odm_report', 'shots.geojson'), '{');
  assert.deepEqual(discoverCameraPhotoLinks(root, discovered), [], 'malformed optional photo metadata fails closed');
});

test('startup reconciliation restores exact camera-photo links for imports created before photo support', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-backfill-'));
  const mounts = Object.fromEntries(['datasets', 'models', 'cache', 'trash'].map((name) => [name, path.join(root, name)]));
  const storage = new StorageManager({
    datasetsMount: mounts.datasets,
    modelsMount: mounts.models,
    cacheMount: mounts.cache,
    trashMount: mounts.trash,
    storageReserveBytes: 0,
    storageReservePercent: 0,
  });
  storage.initialize();
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const datasetId = 'legacy-camera-dataset';
  const datasetRoot = path.join(mounts.datasets, datasetId);
  fs.mkdirSync(path.join(datasetRoot, 'assets', 'odm_report'), { recursive: true });
  fs.mkdirSync(path.join(datasetRoot, 'images'), { recursive: true });
  const rootPhoto = Buffer.from('legacy-root-photo');
  const nestedPhoto = Buffer.from('legacy-nested-photo');
  const unreferencedPhoto = Buffer.from('private-unreferenced-photo');
  const shots = Buffer.from(JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } },
      { type: 'Feature', properties: { filename: 'images/DJI_0002.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 201] } },
      { type: 'Feature', properties: { filename: 'missing.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 202] } },
      { type: 'Feature', properties: { filename: '../escape.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 203] } },
    ],
  }));
  const fixtures = [
    ['DJI_0001.JPG', rootPhoto, 'image/jpeg'],
    ['images/DJI_0002.JPG', nestedPhoto, 'image/jpeg'],
    ['unreferenced.JPG', unreferencedPhoto, 'image/jpeg'],
    ['assets/odm_report/shots.geojson', shots, 'application/geo+json'],
  ];
  for (const [relativePath, body] of fixtures) {
    const target = path.join(datasetRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  const project = processing.createProject({ displayName: 'Legacy camera project' });
  processing.createDataset({
    id: datasetId,
    projectId: project.id,
    displayName: 'Legacy camera source',
    sourceType: 'webodm',
    storageMode: 'adopted',
    rootKey: 'datasets',
    relativePath: datasetId,
    status: 'finalizing',
  });
  processing.finalizeDataset(datasetId, fixtures.map(([relativePath, body, contentType]) => ({
    relativePath,
    byteSize: body.length,
    sha256: digest(body),
    contentType,
  })), digest('legacy-camera-manifest'));
  const task = processing.createTask({ projectId: project.id, datasetId, displayName: 'Legacy camera task' });
  const attempt = processing.createImportedAttempt({
    id: 'legacy-camera-attempt',
    taskId: task.id,
    datasetId,
    providerTaskId: 'webodm-import:legacy-camera',
    displayName: task.displayName,
    staged: false,
  });
  const versionId = 'legacy-camera-version';
  const model = repository.upsertModelVersion({
    modelId: 'legacy-camera-model',
    versionId,
    provider: 'webodm',
    providerModelId: 'task-import:legacy-camera',
    providerVersionId: 'legacy-camera-source',
    displayName: 'Legacy camera model',
    status: 'ready',
    sourceLocator: { webodmTaskImport: true },
    assets: [{
      kind: 'shots',
      rootKey: 'datasets',
      relativePath: `${datasetId}/assets/odm_report/shots.geojson`,
      contentType: 'application/geo+json',
      byteSize: shots.length,
      sha256: digest(shots),
      published: false,
      sourceAttemptId: attempt.id,
    }],
    makeActive: true,
  });
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({
    versionId,
    modelId: model.id,
    taskId: task.id,
    attemptId: attempt.id,
    projectId: project.id,
    rootKey: 'datasets',
    relativePath: datasetId,
    storageMode: 'adopted',
    byteSize: fixtures.reduce((sum, [, body]) => sum + body.length, 0),
    assetCount: 1,
  });

  assert.equal(repository.listCameraPhotos(versionId).length, 0, 'fixture reproduces the pre-support import');
  assert.deepEqual(reconcileImportedCameraPhotoLinks({ repository, processing, storage }), {
    versionsScanned: 1,
    versionsReconciled: 1,
    photosLinked: 2,
    versionsFailed: 0,
  });
  assert.equal(repository.getCameraPhoto(versionId, 'DJI_0001.JPG').sha256, digest(rootPhoto));
  assert.equal(repository.getCameraPhoto(versionId, 'images/DJI_0002.JPG').sha256, digest(nestedPhoto));
  assert.equal(repository.getCameraPhoto(versionId, 'unreferenced.JPG'), null, 'unreferenced private JPEGs stay unavailable');
  assert.equal(repository.getCameraPhoto(versionId, '../escape.JPG'), null);
  assert.deepEqual(reconcileImportedCameraPhotoLinks({ repository, processing, storage }), {
    versionsScanned: 0,
    versionsReconciled: 0,
    photosLinked: 0,
    versionsFailed: 0,
  }, 'reconciliation is idempotent after links exist');

  database.prepare('DELETE FROM model_camera_photos WHERE version_id=?').run(versionId);
  fs.writeFileSync(path.join(datasetRoot, 'assets', 'odm_report', 'shots.geojson'), '{"corrupt":true}');
  assert.deepEqual(reconcileImportedCameraPhotoLinks({ repository, processing, storage }), {
    versionsScanned: 1, versionsReconciled: 0, photosLinked: 0, versionsFailed: 0,
  });
  assert.equal(database.prepare('SELECT status FROM camera_photo_reconciliation_state WHERE version_id=?').get(versionId)?.status, 'terminal');
  fs.writeFileSync(path.join(datasetRoot, 'assets', 'odm_report', 'shots.geojson'), shots);
  assert.equal(reconcileImportedCameraPhotoLinks({ repository, processing, storage }).versionsScanned, 0, 'terminal candidates no longer starve later versions on every startup');
});

test('a scoped camera capability serves an integrity-checked linked photo without exposing storage paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-route-'));
  const oldDatasetsMount = config.datasetsMount;
  config.datasetsMount = path.join(root, 'datasets');
  const datasetId = 'imported-task';
  const directory = path.join(config.datasetsMount, datasetId);
  fs.mkdirSync(path.join(directory, 'assets', 'odm_report'), { recursive: true });
  const photo = Buffer.from('authenticated-camera-photo');
  const nestedPhoto = Buffer.from('nested-authenticated-camera-photo');
  const shots = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } }] }));
  fs.writeFileSync(path.join(directory, 'DJI_0001.JPG'), photo);
  fs.mkdirSync(path.join(directory, 'images'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'images', 'DJI_0002.JPG'), nestedPhoto);
  fs.writeFileSync(path.join(directory, 'assets', 'odm_report', 'shots.geojson'), shots);
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const model = repository.upsertModelVersion({
    modelId: 'model-camera', versionId: 'version-camera', provider: 'webodm',
    providerModelId: 'task-import:camera', providerVersionId: 'camera', displayName: 'Camera model', status: 'ready',
    sourceLocator: { webodmTaskImport: true },
    assets: [{ kind: 'shots', rootKey: 'datasets', relativePath: `${datasetId}/assets/odm_report/shots.geojson`, contentType: 'application/geo+json', byteSize: shots.length, sha256: digest(shots), published: true }],
    cameraPhotos: [
      { filename: 'DJI_0001.JPG', rootKey: 'datasets', relativePath: `${datasetId}/DJI_0001.JPG`, contentType: 'image/jpeg', byteSize: photo.length, sha256: digest(photo) },
      { filename: 'images/DJI_0002.JPG', rootKey: 'datasets', relativePath: `${datasetId}/images/DJI_0002.JPG`, contentType: 'image/jpeg', byteSize: nestedPhoto.length, sha256: digest(nestedPhoto) },
    ],
  });
  const token = 'camera-session-token-000000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId: model.id, modelVersionId: model.activeVersionId, subject: 'ops:camera', audience: 'ops', permissions: { view: true, cameras: true, download: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const deniedToken = 'camera-session-denied-0000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(deniedToken), modelId: model.id, modelVersionId: model.activeVersionId, subject: 'ops:no-camera', audience: 'ops', permissions: { view: true, cameras: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assets.setRepository(repository);
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    config.datasetsMount = oldDatasetsMount;
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const photoPath = `/session-camera-photos/${encodeURIComponent(token)}/${model.id}/DJI_0001.JPG`;
  const response = await fetch(`${base}${photoPath}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo);
  const nestedResponse = await fetch(`${base}/session-camera-photos/${encodeURIComponent(token)}/${model.id}/${encodeURIComponent('images/DJI_0002.JPG')}`);
  assert.equal(nestedResponse.status, 200);
  assert.deepEqual(Buffer.from(await nestedResponse.arrayBuffer()), nestedPhoto);
  assert.equal((await fetch(`${base}/session-camera-photos/${encodeURIComponent(token)}/${model.id}/missing.JPG`)).status, 404);
  assert.equal((await fetch(`${base}/session-camera-photos/${encodeURIComponent(deniedToken)}/${model.id}/DJI_0001.JPG`)).status, 403);

  const viewer = toViewerConfig(repository.getModel(model.id), { assetToken: token });
  assert.equal(viewer.assets.cameraPhotos, `/session-camera-photos/${encodeURIComponent(token)}/${model.id}`);
  assert.equal(viewer.assets.cameraPhotos.includes(root), false);

  fs.writeFileSync(path.join(directory, 'DJI_0001.JPG'), Buffer.alloc(photo.length, 88));
  assert.equal((await fetch(`${base}${photoPath}`)).status, 404, 'same-size content tampering fails the stored digest check');
});

test('camera photo persistence rejects path escapes and the viewer has an explicit missing-photo state', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /PHOTO_BASE = p\.assets\.cameraPhotos \|\| null/);
  assert.match(main, /dom\.photoEmpty\.textContent = 'No photo available'/);
  assert.match(html, /id="photo-empty"[^>]*>No photo available</);
  assert.doesNotMatch(main, /if \(!PHOTO_BASE \|\| !feat\) return/);
});

test('camera photos default to a nonblocking dock and clamp expanded transforms', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /import \{ clampPhotoView, fitPhotoBox, panPhotoView, zoomPhotoView \} from '\.\/camera-photo-view\.mjs'/);
  assert.match(main, /presentation: 'docked'/);
  assert.match(main, /setPhotoPresentation\('docked'\)/);
  assert.match(main, /photoView\.presentation !== 'expanded'\) return/);
  assert.match(main, /photoView\.scale <= 1\) return/);
  assert.match(main, /naturalWidth = dom\.photoImg\.naturalWidth/);
  assert.match(main, /layoutPhotoViewer\(\);/);
  assert.match(html, /#photo-modal\.docked #photo-frame/);
  assert.match(html, /#photo-modal\.expanded/);
  assert.match(html, /#photo-modal \{[\s\S]*pointer-events: none/);
  assert.match(html, /id="photo-imgwrap" tabindex="0" aria-label="Expand camera photo"/);
});

test('server starts accepting requests before bounded legacy camera-photo maintenance runs', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /const \{ reconcileImportedCameraPhotoLinks \} = require\('\.\/cameraPhotos'\)/);
  const listen = server.indexOf('const server = app.listen');
  const deferred = server.indexOf('setImmediate(() =>', listen);
  const reconcile = server.indexOf('reconcileImportedCameraPhotoLinks({ repository, processing: processingRepository, storage: storageManager })', deferred);
  assert.ok(listen > 0 && deferred > listen && reconcile > deferred);
});

test('camera layer renders and highlights the shared four-component WebODM-inspired glyph', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /import \{ CAMERA_MARKER_COLORS, CAMERA_MARKER_OPACITY, CAMERA_MARKER_STYLE, DEFAULT_CAMERA_MARKER_SCALE, cameraMarkerGeometryData, cameraMarkerScaleForView, selectCameraMarkerRepresentatives \} from '\.\/camera-markers\.mjs'/);
  assert.match(main, /const CAMERA_MARKER_COMPONENTS = Object\.freeze\(\['body', 'face', 'cue', 'tab'\]\)/);
  assert.match(main, /camMarkerMeshes = CAMERA_MARKER_COMPONENTS\.map\(\(component, index\) => \{/);
  assert.match(main, /new THREE\.InstancedMesh\(geometries\[component\], material\(\), camFeatures\.length\)/);
  assert.match(main, /new THREE\.MeshBasicMaterial\(\{[\s\S]*opacity: CAMERA_MARKER_OPACITY\.normal[\s\S]*side: THREE\.FrontSide/);
  assert.match(main, /let cameraMarkerUserScale = DEFAULT_CAMERA_MARKER_SCALE/);
  assert.match(main, /let camDrawToSource = \[\], camSourceToDraw = null/);
  assert.match(main, /const visibleSources = selectCameraMarkerRepresentatives\(candidates/);
  assert.match(main, /for \(const mesh of camMarkerMeshes\) \{\s*mesh\.count = visibleSources\.length/);
  assert.match(main, /if \(mesh\.instanceColor\) mesh\.instanceColor\.needsUpdate = true/);
  assert.match(main, /hoverRaycaster\.intersectObjects\(camMarkerMeshes, false\)/);
  assert.match(main, /return camDrawToSource\[hits\[0\]\.instanceId\]/);
  assert.match(main, /CAMERA_MARKER_STYLE\.pickRadius/);
});
