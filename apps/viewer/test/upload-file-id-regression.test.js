'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');
const { processOneDatasetOperation } = require('../server/datasetOperationWorker');

test('upload-local IDs do not collide across datasets, including a retained failed upload retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-upload-ids-'));
  for (const name of ['datasets', 'models', 'cache', 'trash', 'imports']) fs.mkdirSync(path.join(root, name));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db);
  const storage = new StorageManager({ datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash'), datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0 });
  storage.initialize();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = processing.createProject({ displayName: 'Upload collision regression' });
  const body = Buffer.from('original image bytes');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const file = { id: 'file-0', relativePath: 'photo.jpg', byteSize: body.length, sha256, processingRole: 'image' };
  const makeUpload = (name) => {
    const dataset = processing.createDataset({ projectId: project.id, displayName: name, storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
    const { upload } = processing.createUpload({ datasetId: dataset.id, files: [file], subject: 'ops:test', chunkSize: body.length, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const written = storage.writeChunk(upload.id, file.id, 0, body, sha256);
    processing.recordChunk({ uploadId: upload.id, fileId: file.id, chunkIndex: 0, relativePath: file.relativePath, ...written });
    const operation = processing.createUploadFinalizeOperation(upload.id, 'ops:test',null,null,upload.tokenHash);
    return { dataset, upload, operation };
  };
  const first = makeUpload('First');
  await processOneDatasetOperation({ processing, storage }, 'worker-first');
  assert.equal(processing.getDatasetOperation(first.operation.id, 'ops:test').status, 'succeeded');
  const original = processing.getDataset(first.dataset.id, true).files[0];
  const second = makeUpload('Second');
  await processOneDatasetOperation({ processing, storage }, 'worker-second');
  assert.equal(processing.getDatasetOperation(second.operation.id, 'ops:test').status, 'succeeded');
  const next = processing.getDataset(second.dataset.id, true).files[0];
  assert.notEqual(original.id, next.id);
  assert.notEqual(original.id, file.id);
  assert.notEqual(next.id, file.id);
  assert.equal(next.sha256, sha256);

  // Model the old production failure after assembly: the old upload-local ID
  // already belongs to another dataset and the transaction must roll back.
  const legacy = processing.createDataset({ projectId: project.id, displayName: 'Legacy', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  processing.finalizeDataset(legacy.id, [file], sha256);
  const retained = makeUpload('Retained');
  const finalize = processing.finalizeDataset.bind(processing);
  processing.finalizeDataset = (id, files, hash) => finalize(id, files.map((item) => ({ ...item, id: file.id })), hash);
  await processOneDatasetOperation({ processing, storage }, 'worker-old');
  processing.finalizeDataset = finalize;
  assert.equal(processing.getDatasetOperation(retained.operation.id, 'ops:test').status, 'failed');
  assert.equal(processing.getUpload(retained.upload.id).status, 'open');
  assert.deepEqual(processing.getDataset(retained.dataset.id, true).files, []);
  const assembled = path.join(root, 'datasets', retained.dataset.relativePath, file.relativePath);
  assert.deepEqual(fs.readFileSync(assembled), body);
  assert.equal(processing.listChunks(retained.upload.id, file.id).length, 1);
  assert.equal(processing.retryDatasetOperation(retained.operation.id, 'ops:test').status, 'queued');
  await processOneDatasetOperation({ processing, storage }, 'worker-retry');
  assert.equal(processing.getDatasetOperation(retained.operation.id, 'ops:test').status, 'succeeded');
  const recovered = processing.getDataset(retained.dataset.id, true).files[0];
  assert.notEqual(recovered.id, file.id);
  assert.equal(recovered.sha256, sha256);
  assert.deepEqual(fs.readFileSync(assembled), body);
  assert.equal(processing.getDataset(legacy.id, true).files[0].id, file.id);
});
