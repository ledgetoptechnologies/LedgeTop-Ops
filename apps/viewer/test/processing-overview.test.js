'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const auth = require('../server/auth');
const { processingJobCounts } = require('../server/processingOverview');
const express = require('express');
const { ViewerRepository } = require('../server/repository');
const { createProcessingApi } = require('../server/processingApi');
const { signServiceRequest } = require('../server/serviceAuth');
const { config } = require('../server/config');

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const processing = new ProcessingRepository(db);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Test provider', endpoint: 'http://127.0.0.1:3000', enabled: true });
  function task(status = 'failed') {
    const project = processing.createProject({ displayName: crypto.randomUUID() });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Input', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
    processing.finalizeDataset(dataset.id, [], crypto.createHash('sha256').digest('hex'));
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Test task' });
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id });
    processing.transitionAttempt(attempt.id, status);
    return { project, task, attempt };
  }
  return { db, processing, provider, task, counts: () => ({ ...processingJobCounts(db) }) };
}

test('overview counts only current attempts and drops resolved failures after retry', t => {
  const f = fixture(t), original = f.task();
  assert.equal(f.counts().failed, 1);
  const retry = f.processing.retryAttempt(original.attempt.id, 'ops:test');
  assert.deepEqual(f.counts(), { queued: 1, running: 0, reviewReady: 0, failed: 0, observationWarnings: 0 });
  f.processing.transitionAttempt(retry.id, 'running');
  assert.equal(f.counts().running, 1);
  f.processing.transitionAttempt(retry.id, 'ready_for_review');
  assert.equal(f.counts().reviewReady, 1);
  f.processing.transitionAttempt(retry.id, 'published');
  assert.deepEqual(f.counts(), { queued: 0, running: 0, reviewReady: 0, failed: 0, observationWarnings: 0 });
  assert.equal(f.processing.getAttempt(original.attempt.id).status, 'failed');
});

test('retry rejects legacy ortho-only attempts without changing immutable snapshots or queue counts', async t => {
  const f = fixture(t);
  const token = 'retry-legacy-output-token-000000000000';
  f.processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:retry',
    permissions: ['viewer.processing.write'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(createProcessingApi({ repository: new ViewerRepository(f.db), processing: f.processing, storage: {} }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });

  const cases = [
    { status: 'failed', invalidOption: 'fast-orthophoto', key: 'retry-legacy-fast-ortho-1' },
    { status: 'cancelled', invalidOption: 'skip-3dmodel', key: 'retry-legacy-skip-3d-1' },
  ];
  for (const scenario of cases) {
    const original = f.task();
    const options = { [scenario.invalidOption]: true, 'pc-ept': true, gltf: true, '3d-tiles': true };
    const legacy = f.processing.createAttempt({ taskId: original.task.id, providerId: f.provider.id, options });
    f.processing.transitionAttempt(legacy.id, scenario.status, { errorCode: 'missing_required_output' });
    f.db.prepare("UPDATE processing_jobs SET status='failed' WHERE attempt_id=?").run(legacy.id);
    const attemptsBefore = f.db.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(original.task.id).n;
    const jobsBefore = f.db.prepare('SELECT COUNT(*) n FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id WHERE a.task_id=?').get(original.task.id).n;

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/attempts/${legacy.id}/retry`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': scenario.key }, body: '{}',
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.code, 'viewer_3d_outputs_required');
    assert.match(payload.error, new RegExp(`turn off ${scenario.invalidOption}`));
    assert.equal(f.processing.getAttempt(legacy.id).status, scenario.status);
    assert.deepEqual(f.processing.getAttempt(legacy.id).options, options);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(original.task.id).n, attemptsBefore);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id WHERE a.task_id=?').get(original.task.id).n, jobsBefore);
  }
});

test('recycled projects and tasks stop alerting and restored work becomes visible again', t => {
  const f = fixture(t), project = f.task(), task = f.task(), current = f.task();
  assert.equal(f.counts().failed, 3);
  const projectTrash = f.processing.trashProject(project.project.id, 'ops:test');
  assert.ok(projectTrash);
  const taskTrash = f.processing.trashTask(task.task.id, 'ops:test');
  assert.ok(taskTrash);
  assert.equal(f.counts().failed, 1);
  assert.ok(f.processing.restoreMetadataEntity(projectTrash.id, 'ops:test'));
  assert.equal(f.counts().failed, 2);
  f.db.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(), current.task.id);
  assert.equal(f.counts().failed, 1);
  assert.ok(f.processing.restoreMetadataEntity(taskTrash.id, 'ops:test'));
  assert.equal(f.counts().failed, 2);
});

test('authenticated overview route serializes observation warnings separately from failures', async t => {
  const f = fixture(t), keyId = 'overview-test', secret = 'synthetic-overview-service-secret-32-characters';
  const oldKeys = config.serviceAuthKeys, oldKeyId = config.serviceAuthKeyId, oldSecret = config.serviceAuthSecret;
  config.serviceAuthKeys = { [keyId]: secret };
  config.serviceAuthKeyId = keyId;
  config.serviceAuthSecret = secret;
  t.after(() => { config.serviceAuthKeys = oldKeys; config.serviceAuthKeyId = oldKeyId; config.serviceAuthSecret = oldSecret; });
  function addWarning(code, archived = false) {
    const work = f.task('running');
    f.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at,error_code) VALUES (?,?,'reconcile','pending','2000','2000','2000',?)").run(crypto.randomUUID(), work.attempt.id, code);
    if (archived) f.db.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(work.task.id);
  }
  addWarning('provider_status_auth_failed');
  addWarning('unrelated_internal_error');
  addWarning('provider_status_not_found', true);
  const app = express();
  app.use(createProcessingApi({ repository: new ViewerRepository(f.db), processing: f.processing,
    storage: { space: () => ({ available: 1024 }) }, providerCredentials: {} }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/overview`;
  assert.equal((await fetch(url)).status, 401);
  const headers = signServiceRequest({ secret, keyId, method: 'GET', path: '/api/v1/overview' });
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs, { queued: 0, running: 2, reviewReady: 0, failed: 0, observationWarnings: 1 });
});
