'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-required-mesh-retry-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const repository = new ViewerRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, processing, repository };
}

function failedRequiredMesh(context) {
  const { processing, repository, database } = context;
  const project = processing.createProject({ displayName: 'Retry project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Retry source', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: digest('p') }], digest('dataset'));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Retry task' });
  const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: `source:${task.id}`, createdBy: 'ops:test', staged: false });
  const obj = Buffer.from('obj-source'), glb = Buffer.from('glb-source'), relativePath = `${task.id}/${attempt.id}`;
  const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'ready', metadata: {}, makeActive: false, assets: [
    { kind: 'obj', rootKey: 'models', relativePath: `${relativePath}/model.obj`, byteSize: obj.length, sha256: digest(obj), published: false },
    { kind: 'glb', rootKey: 'models', relativePath: `${relativePath}/model.glb`, byteSize: glb.length, sha256: digest(glb), published: false },
  ] });
  const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, rootKey: 'models', relativePath, storageMode: 'managed', status: 'ready', byteSize: obj.length + glb.length, assetCount: 2 });
  const jobId = processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: false });
  processing.persistDerivativeInputSnapshot(jobId, 'mesh_tiles', [
    { role: 'mesh_obj', rootKey: 'models', relativePath: `${relativePath}/model.obj`, byteSize: obj.length, sha256: digest(obj) },
    { role: 'mesh_glb', rootKey: 'models', relativePath: `${relativePath}/model.glb`, byteSize: glb.length, sha256: digest(glb) },
  ]);
  database.prepare("UPDATE derivative_jobs SET status='failed',result_json=?,completed_at=?,updated_at=? WHERE id=?").run(JSON.stringify({ error: 'converter ran out of memory at C:\\private\\model.obj?secret=must-not-leak', code: 'derivative_failed' }), new Date().toISOString(), new Date().toISOString(), jobId);
  database.prepare("UPDATE model_outputs SET status='failed' WHERE id=?").run(versionId);
  database.prepare("UPDATE model_versions SET status='failed' WHERE id=?").run(versionId);
  database.prepare("UPDATE models SET status='failed' WHERE id=?").run(model.id);
  database.prepare("UPDATE processing_attempts SET status='failed',error_code='derivative_failed',error_message='converter failed',completed_at=? WHERE id=?").run(new Date().toISOString(), attempt.id);
  database.prepare("UPDATE processing_tasks SET status='failed' WHERE id=?").run(task.id);
  processing.recordProcessingEvent({ attemptId: attempt.id, derivativeJobId: jobId, eventType: 'processing.failed', phase: 'failed', severity: 'error', errorCode: 'derivative_failed', message: 'converter failed', createdAt: new Date().toISOString() });
  return { jobId, attemptId: attempt.id, taskId: task.id, versionId };
}

test('required mesh retry is an atomic derivative-only retry that preserves the original failure', async (t) => {
  const context = fixture(t), ids = failedRequiredMesh(context);
  const staleIncomplete = `${ids.taskId}/${ids.attemptId}/tiles-ktx2-etc1s-${ids.jobId}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.incomplete`;
  const staleComplete = `${ids.taskId}/${ids.attemptId}/tiles-ktx2-etc1s-${ids.jobId}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.complete`;
  context.database.prepare("UPDATE derivative_storage_journal SET state='terminal',lease_token=?,incomplete_relative_path=?,complete_relative_path=?,final_relative_path=?,accounted_byte_size=0 WHERE job_id=?").run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', staleIncomplete, staleComplete, `${ids.taskId}/${ids.attemptId}/tiles-ktx2-etc1s-${ids.jobId}`, ids.jobId);
  const before = context.database.prepare('SELECT COUNT(*) AS count FROM processing_jobs').get().count;
  const listed = context.processing.listDerivativeJobsPage({ meshDerivativesEnabled: true }).items.find((item) => item.id === ids.jobId);
  assert.equal(listed.requiredRetryAvailable, true);
  const derivative = context.processing.retryRequiredMeshDerivative(ids.jobId, 'ops:required-retry', { meshDerivativesEnabled: true });
  assert.ok(derivative);
  assert.equal(derivative.id, ids.jobId);
  assert.equal(derivative.status, 'pending');
  assert.equal(derivative.manualRetryCount, 1);
  assert.match(derivative.retryHistory[0].errorMessage, /converter ran out of memory/);
  assert.equal(derivative.retryHistory[0].errorMessage.includes('must-not-leak'), false);
  assert.equal(Object.hasOwn(derivative, 'retryCleanup'), false, 'internal storage cleanup paths are not returned to the API');
  const storedRequest = JSON.parse(context.database.prepare('SELECT request_json FROM derivative_jobs WHERE id=?').get(ids.jobId).request_json);
  assert.deepEqual(storedRequest.retryCleanup, [staleIncomplete, staleComplete]);
  assert.equal(context.processing.derivativeStorageReservation(ids.jobId).state, 'reserved');
  assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM processing_jobs').get().count, before, 'no provider job was submitted');
  assert.equal(context.processing.getAttempt(ids.attemptId).status, 'derivatives');
  assert.equal(context.processing.getTask(ids.taskId).status, 'processing');
  assert.equal(context.processing.getModelOutput(ids.versionId).status, 'staged');
  assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM processing_events WHERE attempt_id=? AND event_type='processing.failed'").get(ids.attemptId).count, 1, 'the original failure diagnostic remains append-only');
  assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='derivative.required_retry_requested'").get().count, 1);

  assert.equal(context.processing.retryRequiredMeshDerivative(ids.jobId, 'ops:required-retry', { meshDerivativesEnabled: true }), null, 'the manual retry allowance is one-shot');
});

test('required mesh retry HTTP route enforces permissions and queues only one retry', async (t) => {
  const express = require('express');
  const auth = require('../server/auth');
  const { createProcessingApi } = require('../server/processingApi');
  const { StorageManager } = require('../server/storageManager');
  const c = fixture(t), ids = failedRequiredMesh(c);
  for (const name of ['datasets', 'models', 'cache', 'trash', 'imports']) fs.mkdirSync(path.join(c.root, name));
  const storage = new StorageManager({ datasetsMount: path.join(c.root, 'datasets'), modelsMount: path.join(c.root, 'models'), cacheMount: path.join(c.root, 'cache'), trashMount: path.join(c.root, 'trash'), datasetImportMount: path.join(c.root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0 });
  storage.initialize();
  const read = 'read-token-000000000000000000000', write = 'write-token-00000000000000000000';
  for (const [token, permissions] of [[read, ['viewer.processing.read']], [write, ['viewer.processing.read', 'viewer.processing.write']]]) {
    c.processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:test', permissions, displayUnits: 'imperial', expiresAt: new Date(Date.now() + 60000).toISOString() });
  }
  const app = express(); app.use(express.json()); app.use(createProcessingApi({ repository: c.repository, processing: c.processing, storage }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() });
  const listed = await fetch(`${base}/api/v1/processing/derivatives`, { headers: headers(read) });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).derivatives.find((job) => job.id === ids.jobId).requiredRetryAvailable, true);
  const route = `${base}/api/v1/processing/derivatives/${ids.jobId}/retry`;
  assert.equal((await fetch(route, { method: 'POST', headers: headers(read), body: '{}' })).status, 403);
  const response = await fetch(route, { method: 'POST', headers: headers(write), body: '{}' });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.derivative.id, ids.jobId);
  assert.equal(result.derivative.status, 'pending');
  assert.equal(Object.hasOwn(result.derivative, 'retryCleanup'), false);
  assert.equal((await fetch(route, { method: 'POST', headers: headers(write), body: '{}' })).status, 409);
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get().n, 0);
});
