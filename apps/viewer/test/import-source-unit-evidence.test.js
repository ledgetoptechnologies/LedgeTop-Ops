'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager, hashFile, hashTree } = require('../server/storageManager');
const { MeasurementSourceUnitEvidence } = require('../server/measurementSourceUnitEvidence');
const { processOneDatasetOperation } = require('../server/datasetOperationWorker');
const { recordImportedSourceUnits } = require('../server/importSourceUnitEvidence');

// LAS 1.2 binary header, projection VLR, and one point (not a JSON stand-in).
function nativeLas(unit, conflict = false) {
  const entries = [[1024, 1], [3072, 32616], [3076, 9001], ...(unit == null ? [] : [[4099, unit]]), ...(conflict ? [[4099, 9002]] : [])];
  const keys = Buffer.alloc(8 + entries.length * 8);
  keys.writeUInt16LE(1, 0); keys.writeUInt16LE(1, 2); keys.writeUInt16LE(entries.length, 6);
  entries.forEach(([key, value], i) => { keys.writeUInt16LE(key, 8 + i * 8); keys.writeUInt16LE(1, 12 + i * 8); keys.writeUInt16LE(value, 14 + i * 8); });
  const header = Buffer.alloc(227), vlr = Buffer.alloc(54), point = Buffer.alloc(20);
  header.write('LASF'); header[24] = 1; header[25] = 2;
  header.writeUInt16LE(227, 94); header.writeUInt32LE(227 + 54 + keys.length, 96);
  header.writeUInt32LE(1, 100); header.writeUInt16LE(20, 105); header.writeUInt32LE(1, 107); header.writeUInt32LE(1, 111);
  for (const at of [131, 139, 147]) header.writeDoubleLE(.01, at);
  vlr.write('LASF_Projection', 2); vlr.writeUInt16LE(34735, 18); vlr.writeUInt16LE(keys.length, 20);
  return Buffer.concat([header, vlr, keys, point]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-unit-'));
  const config = { storageReserveBytes: 0, storageReservePercent: 0, uploadMaxFiles: 1000 };
  for (const key of ['datasetsMount', 'modelsMount', 'cacheMount', 'trashMount', 'terraImportMount', 'datasetImportMount']) {
    config[key] = path.join(root, key); fs.mkdirSync(config[key]);
  }
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db), storage = new StorageManager(config);
  storage.initialize();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, db, processing, repository, storage };
}

async function raster(file, units) {
  const { writeArrayBuffer } = await import('geotiff');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(writeArrayBuffer(new Float64Array([1, 2, 3, 4]), {
    width: 2, height: 2, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 2, 0],
    ProjectedCSTypeGeoKey: 32616, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
    ...(units ? { VerticalUnitsGeoKey: units } : {}),
  })));
}

for (const provider of ['terra', 'webodm']) for (const [units, expected, factor] of [[9001, 'm', 1], [9002, 'ft', .3048], [9003, 'us-ft', 1200 / 3937], [null, null, null]]) {
  test(`${provider} import persists only explicit registered raster units: ${expected || 'unknown'}`, async t => {
    const c = fixture(t), project = c.processing.createProject({ displayName: 'Units' });
    let operation;
    if (provider === 'terra') {
      await raster(path.join(c.config.terraImportMount, 'Project', 'Task', 'dsm.tif'), units);
      c.processing.createCatalogScanOperation({ provider: 'terra', subject: 'staff', sessionId: 's' });
      await processOneDatasetOperation(c, 'worker');
      const candidate = c.processing.listCatalogCandidatesPage({ provider: 'terra' }).items[0];
      operation = c.processing.createCatalogMapOperation({ candidateId: candidate.id, subject: 'staff', sessionId: 's', request: { projectId: project.id, taskDisplayName: 'Units', storageMode: 'adopted' } });
    } else {
      await raster(path.join(c.config.datasetImportMount, 'task', 'dsm.tif'), units);
      operation = c.processing.createWebodmTaskImportOperation({ subject: 'staff', sessionId: 's', request: { sourceRelativePath: 'task', sourceKind: 'folder', projectId: project.id, taskDisplayName: 'Units' } });
    }
    await processOneDatasetOperation(c, 'worker');
    const complete = c.processing.getDatasetOperation(operation.id);
    assert.equal(complete.status, 'succeeded', complete.errorMessage);
    const rows = c.db.prepare('SELECT evidence_json FROM measurement_source_unit_evidence').all();
    assert.equal(rows.length, expected ? 1 : 0);
    if (expected) {
      const evidence = JSON.parse(rows[0].evidence_json), asset = complete.result.model.activeVersion.assets.find(a => a.kind === 'dsm');
      assert.equal(evidence.assetId, asset.id); assert.equal(evidence.verticalUnit, expected);
      assert.equal(evidence.verticalFactor, factor); assert.equal(evidence.basis, 'server-inspected-explicit-metadata');
    }
  });
}

async function registered(t) {
  const c = fixture(t), file = path.join(c.config.datasetsMount, 'dsm.tif');
  await raster(file, 9002);
  c.repository.upsertModelVersion({ modelId: 'model', versionId: 'version', provider: 'test', providerModelId: 'model', providerVersionId: 'version', displayName: 'Units', assets: [{ kind: 'dsm', rootKey: 'datasets', relativePath: 'dsm.tif', byteSize: fs.statSync(file).size, sha256: await hashFile(file) }] });
  const project = c.processing.createProject({ displayName: 'Lease' });
  c.processing.createWebodmTaskImportOperation({ subject: 'staff', request: { projectId: project.id, sourceRelativePath: 'unused', taskDisplayName: 'Lease' } });
  const operation = c.processing.claimDatasetOperation('worker');
  return { ...c, file, operation };
}

for (const provider of ['terra', 'webodm']) for (const [unit, expected, factor, conflict] of [[9001, 'm', 1], [9002, 'ft', .3048], [9003, 'us-ft', 1200 / 3937], [null, null], [9999, null], [9001, null, null, true]]) {
  test(`${provider} binary LAS import preserves explicit units or display-only metadata: ${unit}/${!!conflict}`, async t => {
    const c = fixture(t), project = c.processing.createProject({ displayName: 'Native units' });
    const root = provider === 'terra' ? path.join(c.config.terraImportMount, 'Project', 'Task') : path.join(c.config.datasetImportMount, 'task');
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'odm_georeferenced_model.las'), nativeLas(unit, conflict));
    let operation;
    if (provider === 'terra') {
      c.processing.createCatalogScanOperation({ provider, subject: 'staff', sessionId: 's' });
      await processOneDatasetOperation(c, 'worker');
      const candidate = c.processing.listCatalogCandidatesPage({ provider }).items[0];
      operation = c.processing.createCatalogMapOperation({ candidateId: candidate.id, subject: 'staff', sessionId: 's', request: { projectId: project.id, taskDisplayName: 'Native units', storageMode: 'adopted' } });
    } else operation = c.processing.createWebodmTaskImportOperation({ subject: 'staff', request: { projectId: project.id, sourceRelativePath: 'task', sourceKind: 'folder', taskDisplayName: 'Native units' } });
    await processOneDatasetOperation(c, 'worker');
    const complete = c.processing.getDatasetOperation(operation.id);
    assert.equal(complete.status, 'succeeded', complete.errorMessage);
    const source = complete.result.model.activeVersion.assets.find(a => a.kind === 'pointCloud');
    assert.ok(source, 'native asset remains registered for display');
    const rows = c.db.prepare('SELECT evidence_json FROM measurement_source_unit_evidence').all();
    assert.equal(rows.length, expected ? 1 : 0);
    if (expected) {
      const evidence = JSON.parse(rows[0].evidence_json);
      assert.equal(evidence.assetId, source.id); assert.equal(evidence.sha256, source.sha256); assert.equal(evidence.byteSize, source.byteSize);
      assert.equal(evidence.verticalUnit, expected); assert.equal(evidence.verticalFactor, factor);
      assert.equal(evidence.basis, 'server-inspected-explicit-metadata'); assert.equal(evidence.manifestSha256, '');
    }
  });
}

test('native point import rejects altered bytes without persisting evidence', async t => {
  const c = await registered(t), file = path.join(c.config.datasetsMount, 'cloud.las'); fs.writeFileSync(file, nativeLas(9002));
  c.repository.upsertModelVersion({ modelId: 'point-model', versionId: 'point-version', provider: 'test', providerModelId: 'point-model', providerVersionId: 'point-version', displayName: 'Native', assets: [{ kind: 'pointCloud', rootKey: 'datasets', relativePath: 'cloud.las', byteSize: fs.statSync(file).size, sha256: await hashFile(file) }] });
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  await assert.rejects(recordImportedSourceUnits(c.operation, c, 'point-model', 'point-version'), { code: 'source_changed' });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n, 0);
});

test('explicit import evidence retries preserve the original record', async t => {
  const c = await registered(t);
  const first = await recordImportedSourceUnits(c.operation, c, 'model', 'version');
  assert.equal(first.length, 1);
  assert.deepEqual(await recordImportedSourceUnits(c.operation, c, 'model', 'version'), first);
});

for (const change of ['expired', 'owner', 'cancelled', 'finished']) test(`no import evidence write after ${change} lease`, async t => {
  const c = await registered(t), transaction = c.processing.transaction.bind(c.processing);
  c.processing.transaction = fn => {
    if (change === 'expired') c.db.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01'").run();
    if (change === 'owner') c.db.prepare("UPDATE dataset_operations SET lease_owner='replacement'").run();
    if (change === 'cancelled' || change === 'finished') c.db.prepare('UPDATE dataset_operations SET status=?').run(change === 'cancelled' ? 'cancelled' : 'succeeded');
    return transaction(fn);
  };
  await assert.rejects(recordImportedSourceUnits(c.operation, c, 'model', 'version'), { code: 'operation_lease_lost' });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n, 0);
});

test('changed source bytes and aborted inspections cannot persist evidence', async t => {
  const c = await registered(t), bytes = fs.readFileSync(c.file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(c.file, bytes);
  await assert.rejects(recordImportedSourceUnits(c.operation, c, 'model', 'version'), { code: 'source_changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recordImportedSourceUnits(c.operation, c, 'model', 'version', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n, 0);
});

test('unsupported or conflicting measurement metadata leaves import view delivery available', async t => {
  const { nativeTiffFixture } = await import('./helpers/native-tiff-fixture.mjs');
  for (const gdalMetadata of [
    '<GDALMetadata><Item name="UNITTYPE" sample="0">ft</Item></GDALMetadata>',
    '<GDALMetadata><Item name="SCALE" sample="0">2</Item></GDALMetadata>',
  ]) {
    const c = fixture(t), source = path.join(c.config.datasetImportMount, 'task');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'dsm.tif'), nativeTiffFixture({ verticalUnit: 9001, gdalMetadata }));
    const project = c.processing.createProject({ displayName: 'Conflicting metadata' });
    const operation = c.processing.createWebodmTaskImportOperation({ subject: 'staff', request: { projectId: project.id, sourceRelativePath: 'task', sourceKind: 'folder', taskDisplayName: 'Still viewable' } });
    await processOneDatasetOperation(c, 'worker');
    const complete = c.processing.getDatasetOperation(operation.id);
    assert.equal(complete.status, 'succeeded', complete.errorMessage);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n, 0);
  }
});

test('import metadata does not overwrite an existing staff record', async t => {
  const c = await registered(t), source = c.repository.getModelVersion('model', 'version').activeVersion.assets[0];
  const request = { modelId: 'model', modelVersionId: 'version', source, coordinateReference: { crs: 'EPSG:32616' }, sourceVerticalUnit: 'm' };
  const original = new MeasurementSourceUnitEvidence(c.db).recordStaffReview(request, 'staff');
  assert.deepEqual(await recordImportedSourceUnits(c.operation, c, 'model', 'version'), [original]);
});

test('registered compound-WKT EPT evidence binds to its manifest and rejects changed tree bytes', async t => {
  const c = await registered(t), root = path.join(c.config.datasetsMount, 'ept'); fs.mkdirSync(root);
  const horizontal = 'PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32616"]]';
  const wkt = `COMPD_CS["Survey",${horizontal},VERT_CS["Survey height",VERT_DATUM["Survey datum",2005],UNIT["foot",0.3048],AXIS["Height",UP]]]`;
  const file = path.join(root, 'ept.json'); fs.writeFileSync(file, JSON.stringify({ srs: { wkt } }));
  const points = path.join(root, 'points.bin'); fs.writeFileSync(points, 'points');
  const tree = await hashTree(root);
  c.repository.upsertModelVersion({ modelId: 'ept-model', versionId: 'ept-version', provider: 'test', providerModelId: 'ept-model', providerVersionId: 'ept-version', displayName: 'EPT', assets: [{ kind: 'ept', rootKey: 'datasets', relativePath: 'ept/ept.json', byteSize: fs.statSync(file).size, sha256: await hashFile(file), manifestSha256: tree.manifestSha256, manifestFiles: tree.files }] });
  const result = await recordImportedSourceUnits(c.operation, c, 'ept-model', 'ept-version');
  assert.equal(result[0].verticalUnit, 'ft'); assert.equal(result[0].manifestSha256, tree.manifestSha256);
  fs.writeFileSync(points, 'edited');
  await assert.rejects(recordImportedSourceUnits(c.operation, c, 'ept-model', 'ept-version'), { code: 'source_changed' });
});
