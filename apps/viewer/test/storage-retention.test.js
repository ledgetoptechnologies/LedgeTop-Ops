'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { storageTrashRetentionMs } = require('../server/storageRetention');
const DAY = 86400_000;

test('seven-day retention is scoped to automatic obsolete-output retirement', () => {
  assert.equal(storageTrashRetentionMs('viewer-output-maintenance'), 7 * DAY);
  for (const actor of [null, undefined, 'owner', 'storage-maintenance']) {
    assert.equal(storageTrashRetentionMs(actor), 14 * DAY);
  }
});

for (const [actor, days] of [['viewer-output-maintenance', 7], ['owner', 14]]) {
  test(`new output trash records preserve the ${days}-day contract for ${actor}`, t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-retention-'));
    const db = openDatabase(path.join(temp, 'test.sqlite'));
    t.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
    const processing = new ProcessingRepository(db), repository = new ViewerRepository(db);
    const project = processing.createProject({ displayName: 'Retention test' });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Originals', storageMode: 'managed', rootKey: 'datasets', relativePath: 'originals' });
    processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Test task' });
    const outputs = [];
    for (let index = 0; index < 2; index++) {
      const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: `fixture-${index}`, createdBy: 'test', staged: false });
      const versionId = crypto.randomUUID();
      const model = repository.upsertModelVersion({ versionId, provider: 'webodm', providerModelId: task.id, providerVersionId: `fixture-${index}`, displayName: 'Fixture', status: 'ready', makeActive: index === 1, assets: [] });
      processing.setAttemptResult(attempt.id, model.id, versionId);
      processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: `fixture-${index}`, byteSize: 0, assetCount: 0 });
      outputs.push(versionId);
    }
    const started = Date.now();
    const mutation = processing.beginOutputTrashMutation(outputs[0], actor, 'ready', { archiveInactiveReady: true });
    assert.ok(mutation, 'inactive output can receive a trash intent');
    // Repository-only test: filesystem proof and moves have separate integration
    // coverage. Here we exercise the persisted deadline and replay semantics.
    processing.markStorageMutationFsApplied(mutation.id);
    assert.equal(processing.completeStorageMutation(mutation.id).status, 'complete');
    const trash = processing.getTrash(mutation.trashId);
    assert.ok(Date.parse(trash.purgeAfter) >= started + days * DAY);
    assert.ok(Date.parse(trash.purgeAfter) <= Date.now() + days * DAY);
    const preservedDeadline = new Date(Date.now() + 21 * DAY).toISOString();
    db.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(preservedDeadline, trash.id);
    processing.completeStorageMutation(mutation.id);
    assert.equal(processing.getTrash(trash.id).purgeAfter, preservedDeadline, 'replay never shortens a stored deadline');
    assert.ok(processing.getModelOutput(outputs[1]), 'replacement metadata remains');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processing_attempts WHERE task_id=?').get(task.id).n, 2, 'run history is retained');
  });
}
