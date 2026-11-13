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
const { DerivativeRecovery } = require('../server/derivativeRecovery');
const { MeasurementCalculationRepository } = require('../server/measurementCalculationRepository');
const { EphemeralMeasurementRepository } = require('../server/ephemeralMeasurementRepository');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-derivative-recovery-'));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db);
  const project = processing.createProject({ displayName: 'Synthetic recovery' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', rootKey: 'datasets', relativePath: 'photos' });
  processing.finalizeDataset(dataset.id, [{ relativePath: 'a.jpg', byteSize: 1, sha256: '1'.repeat(64) }], '2'.repeat(64));
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Retained model' });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  const submit = processing.claimJob('fixture'); processing.completeJob(submit.id, 'fixture');
  const files = ['obj', 'glb'].map((kind, index) => ({ kind, role: `mesh_${kind}`, rootKey: 'models', relativePath: `retained/model.${kind}`, byteSize: 10, sha256: String(index + 3).repeat(64) }));
  const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id,
    providerVersionId: attempt.id, displayName: task.displayName, status: 'importing', assets: files, makeActive: false });
  const version = db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, version);
  processing.registerModelOutput({ versionId: version, modelId: model.id, taskId: task.id, attemptId: attempt.id,
    projectId: project.id, relativePath: `${task.id}/${attempt.id}`, status: 'staged', byteSize: 20, assetCount: 2 });
  processing.transitionAttempt(attempt.id, 'derivatives');
  const jobId = processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: false });
  processing.persistDerivativeInputSnapshot(jobId, 'mesh_tiles', files);
  const job = processing.claimDerivative('fixture');
  assert.equal(job.id, jobId);
  assert.equal(processing.failDerivative(jobId, 'fixture', 'Synthetic out of memory', 'derivative_failed', job.lease_token), true);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO processing_attempt_transfer_provenance(attempt_id,initialization_json,archive_json,created_at,updated_at)
    VALUES (?,'{}',?,?,?)`).run(attempt.id, JSON.stringify({ attemptId: attempt.id, providerTaskId: attempt.providerTaskId, archiveSha256: 'a'.repeat(64) }), at, at);
  const session = processing.createAdminSession({ tokenHash: crypto.randomBytes(32).toString('hex'), subject: 'staff:test', permissions: ['viewer.processing.write'], displayUnits: 'imperial', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const request = { attemptId: attempt.id, jobId, subject: 'staff:test', sessionId: session.id, requestKey: 'recovery_once', supplementSha256: 'b'.repeat(64) };
  return { db, processing, repository, project, dataset, provider, task, attempt, version, jobId, session, request };
}

function failureState(f) {
  return Object.fromEntries(['processing_attempts', 'processing_tasks', 'model_versions', 'model_outputs', 'derivative_jobs', 'derivative_storage_journal', 'processing_attempt_transfer_provenance']
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
}

function claimed(f, options) {
  const service = new DerivativeRecovery(f.processing, options), row = service.request(f.request);
  return { service, row: service.claim(row.id, 'recovery_worker') };
}

test('request and lease keep failure/provenance intact; replay is owned and idempotent', t => {
  const f = fixture(t), before = failureState(f), service = new DerivativeRecovery(f.processing);
  const row = service.request(f.request);
  assert.deepEqual(service.request(f.request), row);
  assert.deepEqual(failureState(f), before);
  const lease = service.claim(row.id, 'worker');
  assert.equal(lease.status, 'leased');
  assert.deepEqual(failureState(f), before);
  assert.throws(() => service.claim(row.id, 'competitor'), { code: 'recovery_not_claimable' });
  assert.throws(() => service.request({ ...f.request, supplementSha256: 'c'.repeat(64) }), { code: 'recovery_idempotency_conflict' });
  assert.throws(() => service.request({ ...f.request, requestKey: 'different_request' }), { code: 'recovery_already_requested' });
  assert.equal(JSON.parse(row.failure_json).derivative.result_json, before.derivative_jobs[0].result_json);
  assert.throws(() => f.db.prepare("UPDATE derivative_recovery_operations SET failure_json='{}' WHERE id=?").run(row.id), /immutable/);
});

test('unqualified verifier and forged ticket cannot restore or complete anything', async t => {
  const f = fixture(t), before = failureState(f), { service, row } = claimed(f);
  await assert.rejects(service.prepare(row.id, row.lease_owner, row.lease_token, { verified: true }), { code: 'recovery_verifier_unavailable' });
  assert.throws(() => service.commit({}), { code: 'recovery_supplement_unverified' });
  assert.deepEqual(failureState(f), before);
});

for (const [label, mutate] of [
  ['new active attempt', f => f.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(f.task.id)],
  ['archived project', f => f.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.project.id)],
  ['trashed dataset', f => f.db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(f.dataset.id)],
  ['ready output', f => f.db.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(f.version)],
  ['published version', f => f.db.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(f.version, f.processing.getAttempt(f.attempt.id).resultModelId)],
  ['disabled provider', f => f.db.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(f.provider.id)],
  ['other required failure', f => { f.processing.enqueueDerivative(f.attempt.id, 'ept', { optional: false }); }],
]) test(`eligibility rejects ${label} without changing failed history`, t => {
  const f = fixture(t); mutate(f); const before = failureState(f);
  assert.throws(() => new DerivativeRecovery(f.processing).request(f.request), { code: 'recovery_not_eligible' });
  assert.deepEqual(failureState(f), before);
});

test('source changes and revoked authorization invalidate a reserved operation', t => {
  const f = fixture(t), service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  f.db.prepare('UPDATE model_assets SET sha256=? WHERE version_id=? AND kind=?').run('f'.repeat(64), f.version, 'obj');
  assert.throws(() => service.claim(row.id, 'worker'), { code: 'recovery_source_unbound' });
  f.db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), f.session.id);
  assert.throws(() => service.request(f.request), { code: 'recovery_forbidden' });
});

test('expired owner is fenced after reclaim; reconstructed service resumes same durable request', t => {
  const f = fixture(t), { service, row } = claimed(f);
  f.db.prepare('UPDATE derivative_recovery_operations SET lease_expires_at=? WHERE id=?').run('2000-01-01', row.id);
  f.db.prepare('UPDATE lod_conversion_lock SET lease_expires_at=? WHERE id=1').run('2000-01-01');
  const resumed = new DerivativeRecovery(f.processing), replacement = resumed.claim(row.id, 'new_worker');
  assert.notEqual(replacement.lease_token, row.lease_token);
  assert.throws(() => service.heartbeat(row.id, row.lease_owner, row.lease_token), { code: 'recovery_lease_lost' });
  assert.equal(resumed.heartbeat(row.id, 'new_worker', replacement.lease_token).id, row.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n, 1);
});

test('failed supplement registration rolls back every restored state and retains lease/failure', async t => {
  const f = fixture(t), before = failureState(f);
  const { service, row } = claimed(f, { qualifySupplement: async () => ({ supplementSha256: f.request.supplementSha256,
    register() { throw Object.assign(new Error('synthetic invalid proof'), { code: 'invalid_proof' }); } }) });
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, {});
  assert.throws(() => service.commit(ticket), { code: 'invalid_proof' });
  assert.deepEqual(failureState(f), before);
  assert.equal(service.get(row.id).status, 'leased');
  assert.equal(service.abandon(row.id, row.lease_owner, row.lease_token).status, 'failed');
  assert.equal(f.db.prepare('SELECT job_id FROM lod_conversion_lock').get().job_id, null);
});

test('atomic restore uses existing all-required finalizer and acceptance ACK boundary', async t => {
  const f = fixture(t), archive = f.processing.getAttemptTransferProvenance(f.attempt.id), before = failureState(f);
  let ackCalls = 0;
  const enqueueAck = f.processing.enqueueViewerAcceptanceAck.bind(f.processing);
  f.processing.enqueueViewerAcceptanceAck = (...args) => { ackCalls++; return enqueueAck(...args); };
  // Synthetic registration adapter tests state machinery ONLY. It is not a
  // converter/texture proof fixture or an installed qualification adapter.
  const { service, row } = claimed(f, { qualifySupplement: async () => ({ supplementSha256: f.request.supplementSha256,
    register() {
      f.db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,created_at,sha256,manifest_sha256)
        VALUES (?,?,'tiles','models','derived/tileset.json','3dtiles',1,?,?,?)`).run(crypto.randomUUID(), f.version, new Date().toISOString(), 'c'.repeat(64), 'd'.repeat(64));
      return { verified: true };
    } }) });
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, {});
  assert.equal(service.commit(ticket).ready, true);
  assert.equal(f.processing.getAttempt(f.attempt.id).status, 'ready_for_review');
  assert.equal(f.processing.getModelOutput(f.version).status, 'ready');
  assert.equal(service.get(row.id).status, 'complete');
  assert.deepEqual(f.processing.getAttemptTransferProvenance(f.attempt.id), archive);
  assert.equal(ackCalls, 1);
  assert.equal(JSON.parse(row.failure_json).derivative.result_json, before.derivative_jobs[0].result_json);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n, 1);
  assert.throws(() => service.commit(ticket), { code: 'recovery_supplement_unverified' });
});

function queuedMeasurements(f) {
  const at = new Date().toISOString(), until = new Date(Date.now() + 3600_000).toISOString();
  f.db.prepare(`INSERT INTO ephemeral_measurement_jobs(id,scope_key,page_hash,measurement_id,geometry_hash,request_json,status,created_at,updated_at,expires_at)
    VALUES ('ephemeral','scope','page','measurement','hash','{}','queued',?,?,?)`).run(at, at, until);
  const modelId = f.processing.getAttempt(f.attempt.id).resultModelId;
  f.db.prepare(`INSERT INTO private_measurements(id,model_id,model_version_id,owner_audience,owner_subject,collection,document_json,revision,creation_hash,created_at,updated_at)
    VALUES ('private',?,?,'ops','staff:test','map','{}',1,'hash',?,?)`).run(modelId, f.version, at, at);
  f.db.prepare(`INSERT INTO measurement_calculation_jobs(id,measurement_id,revision,request_json,status,created_at,updated_at)
    VALUES ('calculation','private',1,'{}','queued',?,?)`).run(at, at);
  return { ephemeral: new EphemeralMeasurementRepository(f.db), saved: new MeasurementCalculationRepository(f.db) };
}

test('live recovery excludes both measurement claim paths; release admits work', t => {
  const f = fixture(t), measurements = queuedMeasurements(f), { service, row } = claimed(f);
  assert.equal(measurements.ephemeral.claim('measurement_worker'), null);
  assert.equal(measurements.saved.claim('measurement_worker'), null);
  service.abandon(row.id, row.lease_owner, row.lease_token);
  assert.ok(measurements.saved.claim('measurement_worker'));
});

for (const kind of ['saved', 'ephemeral']) test(`running ${kind} measurement excludes recovery claim`, t => {
  const f = fixture(t), measurements = queuedMeasurements(f);
  assert.ok(measurements[kind].claim('measurement_worker'));
  const service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  assert.throws(() => service.claim(row.id, 'recovery_worker'), { code: 'recovery_heavy_work_busy' });
  assert.equal(service.get(row.id).status, 'queued');
  assert.equal(f.db.prepare('SELECT job_id FROM lod_conversion_lock').get().job_id, null);
});

test('authorization or source change during async qualification cannot restore state', async t => {
  const f = fixture(t), before = failureState(f);
  const { service, row } = claimed(f, { qualifySupplement: async () => {
    f.db.prepare("UPDATE admin_sessions SET permissions_json='[]' WHERE id=?").run(f.session.id);
    return { supplementSha256: f.request.supplementSha256, register: () => ({ verified: true }) };
  } });
  await assert.rejects(service.prepare(row.id, row.lease_owner, row.lease_token, {}), { code: 'recovery_forbidden' });
  assert.deepEqual(failureState(f), before);
});

test('deadline expiry releases only its own lock and preserves original failure', t => {
  const f = fixture(t), before = failureState(f), { service, row } = claimed(f);
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse(row.deadline_at) + 1;
    assert.equal(service.expire(row.id), true);
    assert.equal(service.expire(row.id), false);
  } finally { Date.now = realNow; }
  assert.equal(service.get(row.id).error_code, 'recovery_expired');
  assert.equal(f.db.prepare('SELECT job_id FROM lod_conversion_lock').get().job_id, null);
  assert.deepEqual(failureState(f), before);
});

test('transaction-only registration and finalization hooks reject standalone calls', t => {
  const f = fixture(t);
  assert.throws(() => f.processing.completeDerivativeAndMaybeReadyInTransaction(f.jobId, 'worker', {}), { code: 'readiness_transaction_required' });
  assert.throws(() => f.processing.registerVerifiedLodAssetInTransaction(f.jobId, 'worker', {}, {}), { code: 'readiness_transaction_required' });
});

test('abort disposal errors are contained and separately audited', async t => {
  const f = fixture(t), controller = new AbortController();
  const { service, row } = claimed(f, { qualifySupplement: async () => ({ supplementSha256: f.request.supplementSha256,
    register: () => ({ verified: true }), dispose() { throw new Error('private cleanup path must not be logged'); } }) });
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, {}, { signal: controller.signal });
  assert.doesNotThrow(() => controller.abort());
  assert.throws(() => service.commit(ticket), { code: 'recovery_supplement_unverified' });
  const audit = f.db.prepare("SELECT details_json FROM audit_events WHERE action='derivative_recovery.cleanup_failed'").all();
  assert.deepEqual(audit.map(item => JSON.parse(item.details_json)), [{ code: 'supplement_release_failed' }]);
});

test('close cancels an in-flight qualification and releases its eventual pins once', async t => {
  const f = fixture(t); let release, disposed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, row } = claimed(f, { qualifySupplement: async () => { await gate; return {
    supplementSha256: f.request.supplementSha256, register: () => ({ verified: true }), dispose() { disposed++; } }; } });
  const pending = service.prepare(row.id, row.lease_owner, row.lease_token, {});
  await assert.rejects(service.prepare(row.id, row.lease_owner, row.lease_token, {}), { code: 'recovery_already_prepared' });
  service.close(); release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(disposed, 1);
});

test('release failure after commit does not misreport durable completion', async t => {
  const f = fixture(t);
  const { service, row } = claimed(f, { qualifySupplement: async () => ({ supplementSha256: f.request.supplementSha256,
    register() {
      f.db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,created_at,sha256,manifest_sha256)
        VALUES (?,?,'tiles','models','derived/tileset.json','3dtiles',1,?,?,?)`).run(crypto.randomUUID(), f.version, new Date().toISOString(), 'c'.repeat(64), 'd'.repeat(64));
      return { verified: true };
    }, dispose() { throw new Error('synthetic release failure'); } }) });
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, {});
  const result = service.commit(ticket);
  assert.equal(result.ready, true); assert.equal(result.cleanupComplete, false);
  assert.equal(service.get(row.id).status, 'complete');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='derivative_recovery.cleanup_failed'").get().n, 1);
});
