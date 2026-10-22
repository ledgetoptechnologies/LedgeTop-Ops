'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageManager } = require('../server/storageManager');
const { browsePhotos, selectPhotos, previewPhotos, copyTaskPhotos } = require('../server/taskPhotoImports');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { createProcessingApi } = require('../server/processingApi');
const { processOneDatasetOperation } = require('../server/datasetOperationWorker');
const auth = require('../server/auth');
const express = require('express');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-copy-'));
  const config = { datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash'), datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0 };
  Object.values(config).filter(value => typeof value === 'string').forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  const storage = new StorageManager(config);
  const photo = (relative, bytes = 'photo bytes') => { const file = path.join(config.datasetImportMount, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage, config, photo };
}

test('browse same import mount and recursive selection preserve folders, ignore sidecars and map duplicate filenames deterministically', t => {
  const { storage, photo } = fixture(t);
  photo('raw/day1/DJI.jpg'); photo('raw/day2/DJI.jpg'); photo('raw/day1/notes.txt'); photo('finished/task.zip');
  assert.deepEqual(browsePhotos(storage).entries.map(entry => entry.name), ['finished', 'raw']);
  assert.equal(browsePhotos(storage, { relativePath: 'raw/day1' }).entries[0].kind, 'image');
  const a = selectPhotos(storage, ['raw', 'raw/day1/DJI.jpg']), b = selectPhotos(storage, ['raw/day2', 'raw/day1']);
  assert.equal(a.files.length, 2);
  assert.deepEqual(a.files, b.files);
  assert.deepEqual(a.files.map(file => file.relativePath), ['raw/day1/DJI--photo-1.jpg', 'raw/day2/DJI--photo-2.jpg']);
  assert.throws(() => selectPhotos(storage, ['../escape']), /invalid_import_path/);
  assert.throws(() => selectPhotos(storage, ['raw/day1/notes.txt']), /invalid_raw_image/);
  assert.throws(() => selectPhotos(storage, ['raw'], 1), /import_selection_too_large/);
});

test('photo location preview reports absent GPS without guessing and performs no dataset writes', async t => {
  const { storage, photo } = fixture(t); photo('raw/a.jpg'); photo('raw/b.png');
  const result = await previewPhotos(storage, ['raw']);
  assert.deepEqual(result, { photoCount: 2, scannedCount: 2, locatedCount: 0, missingGpsCount: 2, unscannedCount: 0, points: [], truncated: false });
  assert.deepEqual(fs.readdirSync(storage.roots.datasets), []);
});

test('photo location preview reads bounded JPEG GPS coordinates', async t => {
  const { storage, photo } = fixture(t), tiff = Buffer.alloc(130);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(4, 26);
  for (const [at, tag, type, count, value] of [[28,1,2,2,78],[40,2,5,3,82],[52,3,2,2,87],[64,4,5,3,106]]) {
    tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(count, at + 4); tiff.writeUInt32LE(value, at + 8);
  }
  for (const [start, degree] of [[82,44],[106,89]]) for (let index = 0; index < 3; index++) { tiff.writeUInt32LE(index === 0 ? degree : 0, start + index * 8); tiff.writeUInt32LE(1, start + index * 8 + 4); }
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]), header = Buffer.from([255,216,255,225,0,0]); header.writeUInt16BE(payload.length + 2, 4);
  photo('raw/gps.jpg', Buffer.concat([header, payload, Buffer.from([255,217])]));
  assert.deepEqual((await previewPhotos(storage, ['raw'])).points, [{ latitude: 44, longitude: -89, trueHeading: null, name: 'gps.jpg' }]);
  // Never infer a northern/eastern hemisphere when GPS references are missing
  // or malformed, even if the unsigned coordinate rationals look plausible.
  for (const [name,at,value] of [['missing-lat',28,99],['missing-lon',52,99],['bad-lat-ref',36,88],['bad-lon-ref',60,88]]) {
    const malformed=Buffer.from(tiff);malformed.writeUInt16LE(value,at);
    photo(`invalid/${name}.jpg`,Buffer.concat([header,Buffer.from('Exif\0\0'),malformed,Buffer.from([255,217])]));
  }
  const invalid=await previewPhotos(storage,['invalid']);assert.equal(invalid.locatedCount,0);assert.equal(invalid.missingGpsCount,4);assert.deepEqual(invalid.points,[]);
  const directed=Buffer.alloc(162);tiff.copy(directed,0,0,82);tiff.copy(directed,106,82,130);directed.writeUInt16LE(6,26);directed.writeUInt32LE(106,48);directed.writeUInt32LE(130,72);
  for(const [at,tag,type,count,value]of [[76,16,2,2,84],[88,17,5,1,154]]){directed.writeUInt16LE(tag,at);directed.writeUInt16LE(type,at+2);directed.writeUInt32LE(count,at+4);directed.writeUInt32LE(value,at+8);}
  directed.writeUInt32LE(270,154);directed.writeUInt32LE(1,158);const directedHeader=Buffer.from(header);directedHeader.writeUInt16BE(directed.length+8,4);
  photo('heading/gps.jpg',Buffer.concat([directedHeader,Buffer.from('Exif\0\0'),directed,Buffer.from([255,217])]));
  assert.equal((await previewPhotos(storage,['heading'])).points[0].trueHeading,270,'server preview retains encoded true orientation');
});

test('copy streams into managed dataset without deleting originals and detects source mutation', { skip: process.platform !== 'linux' && 'durable directory fsync requires Linux' }, async t => {
  const { storage, photo } = fixture(t), source = photo('raw/a.jpg');
  const selected = selectPhotos(storage, ['raw']);
  const dataset = { id: 'dataset-one', relativePath: 'dataset-one', status: 'finalizing', storageMode: 'managed' };
  let saved;
  const processing = { getDataset: () => dataset, finalizeDataset: (id, files, hash) => (saved = { ...dataset, status: 'finalized', files, hash }) };
  const operation = { dataset_id: dataset.id, payload_json: JSON.stringify(selected) };
  await copyTaskPhotos(operation, { storage, processing }, async () => {}, new AbortController().signal);
  assert.equal(fs.readFileSync(source, 'utf8'), 'photo bytes');
  assert.equal(fs.readFileSync(storage.resolve('datasets', 'dataset-one/raw/a.jpg'), 'utf8'), 'photo bytes');
  assert.equal(saved.files[0].metadata.sourcePath, 'raw/a.jpg');
  assert.equal(saved.files[0].processingRole, 'image');
  fs.writeFileSync(source, 'changed data');
  await assert.rejects(copyTaskPhotos(operation, { storage, processing }, async () => {}, new AbortController().signal), /import_source_changed/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'changed data');
});

test('symlinks and pre-cancelled copies are rejected', async t => {
  const { storage, photo, config } = fixture(t); photo('raw/a.jpg');
  try { fs.symlinkSync(path.join(config.datasetImportMount, 'raw'), path.join(config.datasetImportMount, 'link'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink permission unavailable'); return; } throw error; }
  assert.throws(() => selectPhotos(storage, ['link']), /invalid_import_path/);
  const selected = selectPhotos(storage, ['raw']), controller = new AbortController(); controller.abort();
  await assert.rejects(copyTaskPhotos({ dataset_id: 'one', payload_json: JSON.stringify(selected) }, { storage, processing: { getDataset: () => ({ status: 'finalizing', storageMode: 'managed' }) } }, async () => {}, controller.signal), /operation_lease_lost/);
});

test('partial copy retry safely replaces managed copies and finalized replay needs no originals', { skip: process.platform !== 'linux' && 'durable directory fsync requires Linux' }, async t => {
  const { storage, photo } = fixture(t); photo('raw/a.jpg', 'first'); const second = photo('raw/b.jpg', 'second');
  const selected = selectPhotos(storage, ['raw']);
  let dataset = { id: 'retry-one', relativePath: 'retry-one', status: 'finalizing', storageMode: 'managed' };
  const processing = { getDataset: () => dataset, finalizeDataset: (id, files) => (dataset = { ...dataset, status: 'finalized', files }) };
  const operation = { dataset_id: dataset.id, payload_json: JSON.stringify(selected) };
  await assert.rejects(copyTaskPhotos(operation, { storage, processing }, async progress => { if (progress > 0.4) throw new Error('simulated lease loss'); }, new AbortController().signal), /simulated lease loss/);
  assert.equal(fs.readFileSync(storage.resolve('datasets', 'retry-one/raw/a.jpg'), 'utf8'), 'first');
  const result = await copyTaskPhotos(operation, { storage, processing }, async () => {}, new AbortController().signal);
  assert.equal(result.dataset.files.length, 2);
  assert.equal(fs.readFileSync(second, 'utf8'), 'second');
  fs.unlinkSync(second); // Only the test simulates external removal after successful import.
  assert.equal((await copyTaskPhotos(operation, { storage, processing }, async () => {}, new AbortController().signal)).dataset.status, 'finalized');
});

test('authenticated copy endpoint is durable/idempotent and worker finalizes a fresh managed dataset without source removal', { skip: process.platform !== 'linux' && 'durable directory fsync requires Linux' }, async t => {
  const context = fixture(t), database = openDatabase(path.join(context.root, 'test.sqlite'));
  const processing = new ProcessingRepository(database), repository = new ViewerRepository(database), token = 'test-raw-import-token-000000000000000000';
  const project = processing.createProject({ displayName: 'Photo project' });
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:raw', permissions: ['viewer.datasets.import', 'viewer.datasets.read'], expiresAt: new Date(Date.now() + 600000).toISOString() });
  const app = express(); app.use(express.json({ verify: (req, res, bytes) => { req.rawBody = bytes; } })); app.use(createProcessingApi({ repository, processing, storage: context.storage }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); database.close(); });
  context.photo('raw/day/a.jpg');
  const url = `http://127.0.0.1:${server.address().port}/api/v1/dataset-imports/copy`;
  const request = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': 'raw-copy-test-key-00000001' }, body: JSON.stringify({ projectId: project.id, displayName: 'Flight photos', paths: ['raw'] }) };
  const first = await fetch(url, request), body = await first.json(); assert.equal(first.status, 202, JSON.stringify(body));
  assert.equal(body.dataset.storageMode, 'managed');
  assert.equal(body.operation.type, 'raw_photo_copy');
  assert.equal(body.operation.source.originalsPreserved, true);
  assert.equal(body.operation.projectId, project.id);
  const replay = await fetch(url, request), replayBody = await replay.json(); assert.equal(replay.status, 202); assert.equal(replayBody.operation.id, body.operation.id);
  await processOneDatasetOperation({ processing, repository, storage: context.storage, config: context.config }, 'test-worker');
  const complete = processing.getDatasetOperation(body.operation.id); assert.equal(complete.status, 'succeeded', JSON.stringify(complete));
  assert.equal(processing.getDataset(body.dataset.id, true).files.length, 1);
  assert.equal(fs.existsSync(path.join(context.config.datasetImportMount, 'raw/day/a.jpg')), true);
  assert.equal((await fetch(url, { ...request, headers: { 'content-type': 'application/json' } })).status, 401);
});
