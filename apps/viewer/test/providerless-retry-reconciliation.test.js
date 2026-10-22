'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { reconcileProviderlessRetries } = require('../server/providerlessRetryReconciliation');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-providerless-retry-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const project = processing.createProject({ displayName: 'Imported project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Imported data', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id, [], empty);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Church' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, processing, project, dataset: processing.getDataset(dataset.id), task, provider };
}

function markImported(database, attemptId) {
  database.prepare('UPDATE processing_attempts SET provider_id=NULL WHERE id=?').run(attemptId);
}

function addRetryAudit(processing, attemptId, previousAttemptId) {
  processing.insertAudit({ actorId: 'ops:test', action: 'processing_attempt.retried', entityType: 'processing_attempt', entityId: attemptId, details: { previousAttemptId } });
}

test('providerless retry reconciliation invalidates the unclaimable run and restores its failed import lineage', (t) => {
  const { database, processing, task, provider, dataset } = fixture(t);
  const run1 = processing.createAttempt({ taskId: task.id, providerId: provider.id, createdBy: 'ops:test' });
  database.prepare("UPDATE processing_jobs SET status='failed',error_code='derivative_source_too_large' WHERE attempt_id=?").run(run1.id);
  database.prepare("UPDATE processing_attempts SET status='failed',error_code='derivative_source_too_large',error_message='Derivative input exceeds 16 GiB' WHERE id=?").run(run1.id);
  database.prepare("UPDATE processing_tasks SET status='failed' WHERE id=?").run(task.id);
  markImported(database, run1.id);
  const operationId = crypto.randomUUID(), t0 = new Date().toISOString();
  database.prepare(`
    INSERT INTO dataset_operations(
      id,operation_type,subject,dataset_id,payload_json,status,progress,error_code,error_message,
      attempt_count,available_at,created_at,updated_at,completed_at,processing_attempt_id
    ) VALUES (?,'catalog_map','ops:test',?,'{}','failed',1,'derivative_source_too_large',?,1,?,?,?, ?,?)
  `).run(operationId, dataset.id, 'Derivative input exceeds 16 GiB', t0, t0, t0, t0, run1.id);

  const run2 = processing.createAttempt({ taskId: task.id, providerId: provider.id, createdBy: 'ops:test' });
  addRetryAudit(processing, run2.id, run1.id);
  processing.cancelAttempt(run2.id, 'ops:test');
  markImported(database, run2.id);
  const run3 = processing.createAttempt({ taskId: task.id, providerId: provider.id, createdBy: 'ops:test' });
  addRetryAudit(processing, run3.id, run2.id);
  markImported(database, run3.id);

  const result = reconcileProviderlessRetries(processing);
  assert.deepEqual(result, { scanned: 1, invalidated: 1, restored: 1 });
  assert.equal(processing.getAttempt(run1.id).status, 'failed');
  assert.equal(processing.getAttempt(run2.id).status, 'cancelled');
  assert.equal(processing.getAttempt(run3.id).errorCode, 'invalid_providerless_retry');
  assert.equal(database.prepare('SELECT status,error_code FROM processing_jobs WHERE attempt_id=?').get(run3.id).status, 'failed');
  assert.equal(processing.getTask(task.id).activeAttemptId, run1.id);
  assert.equal(processing.getTask(task.id).status, 'failed');
  assert.equal(database.prepare('SELECT status FROM dataset_operations WHERE id=?').get(operationId).status, 'failed');
  assert.deepEqual(reconcileProviderlessRetries(processing), { scanned: 0, invalidated: 0, restored: 0 });
});

test('migration rejects new submit jobs for providerless attempts', (t) => {
  const { database, processing, task, provider } = fixture(t);
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id });
  database.prepare("UPDATE processing_jobs SET status='failed' WHERE attempt_id=?").run(attempt.id);
  markImported(database, attempt.id);
  assert.throws(() => database.prepare(`
    INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at)
    VALUES (?,?,'submit','pending',?,?,?)
  `).run(crypto.randomUUID(), attempt.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()), /require a provider-backed attempt/);
});

test('attempt creation requires an enabled provider and imported retries cannot create provider work', (t) => {
  const { database, processing, task, provider } = fixture(t);
  assert.throws(() => processing.createAttempt({ taskId: task.id }), (error) => error.code === 'provider_unavailable');
  database.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(provider.id);
  assert.throws(() => processing.createAttempt({ taskId: task.id, providerId: provider.id }), (error) => error.code === 'provider_unavailable');
  database.prepare('UPDATE processing_providers SET enabled=1 WHERE id=?').run(provider.id);
  const imported = processing.createAttempt({ taskId: task.id, providerId: provider.id });
  processing.cancelAttempt(imported.id);
  markImported(database, imported.id);
  assert.equal(processing.retryAttempt(imported.id, 'ops:test'), null);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(task.id).n, 1);
});

test('provider-backed retries remain claimable', (t) => {
  const { processing, task, provider } = fixture(t);
  const first = processing.createAttempt({ taskId: task.id, providerId: provider.id });
  processing.cancelAttempt(first.id);
  const retry = processing.retryAttempt(first.id, 'ops:test');
  assert.ok(retry);
  assert.equal(retry.providerId, provider.id);
  const claimed = processing.claimJob('test-worker');
  assert.equal(claimed.attempt_id, retry.id);
  assert.equal(claimed.job_type, 'submit');
  const diagnostics = processing.attemptDiagnostics(retry.id);
  assert.equal(diagnostics.processingJobs[0].queueReason, 'running');
  assert.equal(diagnostics.currentAttemptId, retry.id);
});
