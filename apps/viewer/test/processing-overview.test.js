'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { processingJobCounts } = require('../server/processingOverview');

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
  assert.deepEqual(f.counts(), { queued: 1, running: 0, reviewReady: 0, failed: 0 });
  f.processing.transitionAttempt(retry.id, 'running');
  assert.equal(f.counts().running, 1);
  f.processing.transitionAttempt(retry.id, 'ready_for_review');
  assert.equal(f.counts().reviewReady, 1);
  f.processing.transitionAttempt(retry.id, 'published');
  assert.deepEqual(f.counts(), { queued: 0, running: 0, reviewReady: 0, failed: 0 });
  assert.equal(f.processing.getAttempt(original.attempt.id).status, 'failed');
});

test('recycled projects and tasks stop alerting and restored work becomes visible again', t => {
  const f = fixture(t), project = f.task(), task = f.task(), current = f.task();
  assert.equal(f.counts().failed, 3);
  const projectTrash = f.processing.trashProject(project.project.id, 'ops:test');
  assert.ok(projectTrash);
  assert.ok(f.processing.archiveTask(task.task.id));
  assert.equal(f.counts().failed, 1);
  assert.ok(f.processing.restoreMetadataEntity(projectTrash.id, 'ops:test'));
  assert.equal(f.counts().failed, 2);
  f.db.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(), current.task.id);
  assert.equal(f.counts().failed, 1);
});
