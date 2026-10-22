'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-background-import-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash'),
    datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0,
  };
  for (const location of Object.values(config).filter(value => typeof value === 'string')) fs.mkdirSync(location, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const storage = new StorageManager(config);
  storage.initialize();
  const subject = 'ops:background-import';
  const oldToken = 'background-import-old-token-0000000000000';
  const newToken = 'background-import-new-token-0000000000000';
  const session = token => processing.createAdminSession({
    tokenHash: auth.hashToken(token), subject, displayUnits: 'imperial',
    permissions: ['viewer.datasets.read', 'viewer.datasets.import'],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  const oldSession = session(oldToken);
  const newSession = session(newToken);
  const app = express();
  app.use(express.json());
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, database, processing, subject, oldSession, newSession, newToken, base: `http://127.0.0.1:${server.address().port}` };
}

test('queued imports remain discoverable after navigation/session replacement and expose source semantics', async t => {
  const context = await fixture(t);
  const project = context.processing.createProject({ displayName: 'Background project' });
  const folderOperation = context.processing.createWebodmTaskImportOperation({
    request: { sourceRelativePath: 'task-folder', projectId: project.id, taskDisplayName: 'Folder import' },
    subject: context.subject, sessionId: context.oldSession.id,
  });
  const zipOperation = context.processing.createWebodmTaskImportOperation({
    request: { sourceRelativePath: 'task-backup.ZIP', projectId: project.id, taskDisplayName: 'ZIP import' },
    subject: context.subject, sessionId: context.oldSession.id,
  });
  context.processing.createWebodmTaskImportOperation({
    request: { sourceRelativePath: 'private-folder', projectId: project.id, taskDisplayName: 'Other staff' },
    subject: 'ops:other', sessionId: null,
  });
  context.database.prepare('DELETE FROM admin_sessions WHERE id=?').run(context.oldSession.id);

  const response = await fetch(`${context.base}/api/v1/operations?projectId=${encodeURIComponent(project.id)}&limit=100`, {
    headers: { authorization: `Bearer ${context.newToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const operations = (await response.json()).operations;
  assert.deepEqual(new Set(operations.map(item => item.id)), new Set([folderOperation.id, zipOperation.id]));
  assert.equal(operations.find(item => item.id === folderOperation.id).source.kind, 'server_folder');
  assert.equal(operations.find(item => item.id === zipOperation.id).source.kind, 'server_zip');
  for (const operation of operations) {
    assert.equal(operation.source.browserTransferRequired, false);
    assert.equal(operation.source.transferComplete, true);
    assert.equal(operation.projectId, project.id);
  }
  assert.equal((await fetch(`${context.base}/api/v1/operations?status=invalid`, { headers: { authorization: `Bearer ${context.newToken}` } })).status, 400);
});

test('browser finalization is classified after transfer and duplicate finalize requests share one operation', async t => {
  const context = await fixture(t);
  const project = context.processing.createProject({ displayName: 'Browser project' });
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'Browser upload', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const created = context.processing.createUpload({
    datasetId: dataset.id,
    files: [{ id: 'source', relativePath: 'source.jpg', byteSize: 0, sha256: crypto.createHash('sha256').digest('hex') }],
    subject: context.subject, chunkSize: 8, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const first = context.processing.createUploadFinalizeOperation(created.upload.id, context.subject);
  const replay = context.processing.createUploadFinalizeOperation(created.upload.id, context.subject);
  assert.equal(replay.id, first.id);
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM dataset_operations WHERE upload_id=?').get(created.upload.id).n, 1);
  assert.deepEqual(first.source, { kind: 'browser_upload', browserTransferRequired: true, transferComplete: true });
  assert.equal(first.projectId, null);

  const response = await fetch(`${context.base}/api/v1/operations?limit=100`, { headers: { authorization: `Bearer ${context.newToken}` } });
  assert.equal(response.status, 200);
  const listed = (await response.json()).operations.find(item => item.id === first.id);
  assert.equal(listed.source.kind, 'browser_upload');
  assert.equal(listed.source.transferComplete, true);
});

test('expired leases are fenced and reclaimed once while retry resets persisted progress', async t => {
  const context = await fixture(t);
  const project = context.processing.createProject({ displayName: 'Lease recovery' });
  const operation = context.processing.createWebodmTaskImportOperation({
    request: { sourceRelativePath: 'recoverable-folder', projectId: project.id, taskDisplayName: 'Recoverable import' },
    subject: context.subject, sessionId: context.oldSession.id,
  });
  const firstClaim = context.processing.claimDatasetOperation('worker-before-restart');
  assert.equal(firstClaim.id, operation.id);
  assert.equal(context.processing.heartbeatDatasetOperation(operation.id, 'worker-before-restart', 0.62), true);
  context.database.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(operation.id);
  const reclaimed = context.processing.claimDatasetOperation('worker-after-restart');
  assert.equal(reclaimed.id, operation.id);
  assert.equal(Number(reclaimed.progress), 0);
  assert.equal(Number(reclaimed.attempt_count), 2);
  assert.equal(context.processing.heartbeatDatasetOperation(operation.id, 'worker-before-restart', 0.8), false);
  assert.equal(context.processing.heartbeatDatasetOperation(operation.id, 'worker-after-restart', 0.2), true);
  assert.equal(context.processing.failDatasetOperation(operation.id, 'worker-after-restart', 'fixture_failure', 'retry me'), true);
  const failed = context.processing.getDatasetOperation(operation.id, context.subject);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.progress, 0.2);
  const retried = context.processing.retryDatasetOperation(operation.id, context.subject);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.progress, 0);
  assert.equal(retried.heartbeatAt, null);
  const finalClaim = context.processing.claimDatasetOperation('worker-retry');
  assert.equal(finalClaim.id, operation.id);
  assert.equal(Number(finalClaim.attempt_count), 3);
});
