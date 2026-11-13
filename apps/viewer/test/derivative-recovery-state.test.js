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

function fixture(t, { physicalSource = false } = {}) {
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
  const files = ['obj', 'glb'].map((kind, index) => {
    const data = Buffer.from(`synthetic-source-${kind}`), relativePath = physicalSource ? `${task.id}/${attempt.id}/source/model.${kind}` : `retained/model.${kind}`;
    if (physicalSource) { const absolute = path.join(root, 'models', relativePath); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, data); }
    return { kind, role: `mesh_${kind}`, rootKey: 'models', relativePath,
      byteSize: physicalSource ? data.length : 10, sha256: physicalSource ? crypto.createHash('sha256').update(data).digest('hex') : String(index + 3).repeat(64) };
  });
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
  return { root, db, processing, repository, project, dataset, provider, task, attempt, version, jobId, session, request };
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

function lifecycleIntent(f, entityType = 'output', status = 'intent') {
  const id = crypto.randomUUID(), at = new Date().toISOString();
  f.db.prepare(`INSERT INTO storage_mutations
    (id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,
     destination_root_key,destination_relative_path,status,actor,created_at,updated_at,original_status)
    VALUES (?,'trash',?,?,?,'models','retained','trash','held-source',?,'test',?,?,'failed')`)
    .run(id, entityType, entityType === 'output' ? f.version : f.dataset.id, crypto.randomUUID(), status, at, at);
  return f.processing.getStorageMutation(id);
}

test('recovery holds block output and enclosing task/project trash, including failed/expired operations', t => {
  const f = fixture(t), service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  for (const type of ['output', 'dataset', 'task', 'project']) {
    const id = { output: f.version, dataset: f.dataset.id, task: f.task.id, project: f.project.id }[type];
    assert.equal(f.processing.derivativeRecoveryUsesEntity(type, id), true);
    assert.equal(f.processing.derivativeRecoveryUsesEntity(type, crypto.randomUUID()), false);
  }
  assert.equal(f.processing.archiveModelOutput(f.version), null);
  assert.equal(f.processing.trashTask(f.task.id), null);
  assert.equal(f.processing.trashProject(f.project.id), null);
  assert.equal(f.processing.beginTrashMutation(f.dataset.id, 'test'), null);
  assert.equal(f.processing.beginOutputTrashMutation(f.version, 'test'), null);
  const realNow = Date.now;
  try { Date.now = () => Date.parse(row.deadline_at) + 1; assert.equal(service.expire(row.id), true); }
  finally { Date.now = realNow; }
  // Expiry revokes adoption, but is not evidence that an old physical reader exited.
  assert.equal(f.processing.derivativeRecoveryUsesEntity('output', f.version), true);
  assert.equal(f.processing.archiveModelOutput(f.version), null);
  assert.equal(f.processing.getTask(f.task.id).status, 'failed');
});

for (const status of ['intent', 'fs_applied', 'failed']) {
  test(`recovery admission rejects an output lifecycle journal in ${status}`, t => {
    const f = fixture(t); lifecycleIntent(f, 'output', status);
    assert.throws(() => new DerivativeRecovery(f.processing).request(f.request), { code: 'recovery_not_eligible' });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM derivative_recovery_operations').get().n, 0);
  });
}

for (const entityType of ['output', 'dataset']) {
  test(`apply-time hold stops a pre-existing ${entityType} intent without filesystem access or journal failure`, t => {
    const f = fixture(t), service = new DerivativeRecovery(f.processing);
    service.request(f.request);
    // Represent a previously queued/injected intent: application must independently recheck.
    const mutation = lifecycleIntent(f, entityType);
    let calls = 0;
    const storage = { pathExistsStrict() { calls++; return true; }, moveExact() { calls++; }, removeExact() { calls++; } };
    const { applyStorageMutation } = require('../server/storageLifecycle');
    assert.throws(() => applyStorageMutation(f.processing, storage, mutation), { code: 'recovery_storage_busy' });
    assert.equal(calls, 0);
    assert.equal(f.processing.getStorageMutation(mutation.id).status, 'intent');
    assert.equal(f.db.isTransaction, false);
  });
}

test('lifecycle fence reads authoritative journal and holds the write transaction through the filesystem callback', t => {
  const f = fixture(t), mutation = lifecycleIntent(f);
  const { DatabaseSync } = require('node:sqlite');
  const other = new DatabaseSync(path.join(f.root, 'viewer.sqlite'));
  try {
  other.exec('PRAGMA busy_timeout=0');
  let calls = 0;
  f.processing.withRecoveryStorageMutationFence(mutation.id, current => {
    calls++;
    assert.equal(current.sourceRelativePath, 'retained');
    assert.equal(f.db.isTransaction, true);
    assert.throws(() => other.exec('BEGIN IMMEDIATE'), /locked|busy/);
    assert.equal(f.processing.markStorageMutationFsApplied(current.id).status, 'fs_applied');
  });
  assert.equal(calls, 1);
  assert.equal(f.db.isTransaction, false);
  other.exec('BEGIN IMMEDIATE; ROLLBACK');
  assert.equal(f.processing.getStorageMutation(mutation.id).status, 'fs_applied');
  } finally { other.close(); }
});

test('storage application ignores caller paths and follows only its persisted intent', t => {
  const f = fixture(t), mutation = lifecycleIntent(f);
  let moved = false, applied = false;
  const storage = {
    pathExistsStrict(root, relative) {
      assert.ok(['retained', 'held-source'].includes(relative));
      return root === 'models' ? !moved : moved;
    },
    moveExact(...paths) {
      assert.deepEqual(paths, ['models', 'retained', 'trash', 'held-source']);
      assert.equal(f.db.isTransaction, true);
      moved = true;
    },
  };
  // Isolate the filesystem fence contract from unrelated model-status finalization.
  f.processing.completeStorageMutation = id => { applied = true; return f.processing.getStorageMutation(id); };
  const { applyStorageMutation } = require('../server/storageLifecycle');
  const result = applyStorageMutation(f.processing, storage, { ...mutation, sourceRelativePath: 'forged-source', destinationRelativePath: 'forged-target' });
  assert.equal(moved, true); assert.equal(applied, true); assert.equal(result.status, 'fs_applied');
});


test('same-connection overlapping lifecycle application joins once and leaves no reentry guard', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE model_outputs SET status='archived' WHERE id=?").run(f.version);
  const mutation = lifecycleIntent(f), second = new ProcessingRepository(f.db);
  const { applyStorageMutation } = require('../server/storageLifecycle');
  let moved = false, effects = 0, joined;
  const storage = {
    pathExistsStrict(root) { return root === 'models' ? !moved : moved; },
    moveExact() {
      moved = true; effects++;
      joined = applyStorageMutation(second, storage, mutation.id);
    },
  };
  assert.equal(applyStorageMutation(f.processing, storage, mutation.id).status, 'complete');
  assert.equal(joined.status, 'intent', 'nested caller joins the in-flight owner rather than claiming completion');
  assert.equal(effects, 1);
  assert.equal(f.processing.getModelOutput(f.version).status, 'trashed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storage_trash WHERE entity_id=?').get(f.version).n, 1);
  assert.equal(applyStorageMutation(second, storage, mutation.id).status, 'complete');
  assert.equal(f.db.isTransaction, false);
});


function supplementCandidate(f) {
  const { canonicalSupplement, inventory } = require('../server/derivativeSupplement');
  const contents = { 'tileset.json': '{}', 'mesh.b3dm': 'synthetic-tile', 'private-proof/uv.jsonl': 'private-source-uv', 'private-proof/atlas.png': 'synthetic-private-raster-bytes', 'diagnostic/log.txt': 'private-log' };
  const files = Object.entries(contents).map(([relativePath, data]) => ({ relativePath,
    role: relativePath.startsWith('private-proof/') ? 'private-proof' : relativePath.startsWith('diagnostic/') ? 'diagnostic' : 'render',
    byteSize: Buffer.byteLength(data), sha256: crypto.createHash('sha256').update(data).digest('hex') }));
  const output = inventory(files), input = f.processing.derivativeInputSnapshot(f.jobId);
  const manifest = { schemaVersion: 1, identity: { attemptId: f.attempt.id, versionId: f.version,
    providerId: f.provider.id, providerTaskId: f.attempt.providerTaskId, initializationGeneration: 1,
    producerGeneration: 1, nativeTaskId: 'synthetic-native', environment: 'STAGING', archiveSha256: 'a'.repeat(64), sourceManifestSha256: input.manifestSha256 },
    converter: { binarySha256: 'b'.repeat(64), buildInfoSha256: 'c'.repeat(64), commandSha256: 'd'.repeat(64), policyRevision: 'synthetic-fixture-only' },
    coordinateFrame: { kind: 'local', unit: 'unknown', georeferenced: false }, files: output.files, outputManifestSha256: output.manifestSha256 };
  const tileset = files.find(file => file.relativePath === 'tileset.json');
  // Synthetic V2 provenance exercises real SQL registration, not geometric or
  // current converter qualification. Production still requires the qualifier.
  const verified = { asset: { sha256: tileset.sha256, byteSize: tileset.byteSize,
    manifestFiles: files.map(({ role, ...file }) => file) }, provenance: {
    schemaVersion: 2, sourceAsset: 'model.glb', sourceSha256: input.files.find(file => file.role === 'mesh_glb').sha256, geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence', leafGeometricError: 0,
    audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 } },
    renderArtifacts: files.filter(file => file.role === 'render').map(file => ({ uri: file.relativePath, sha256: file.sha256, byteLength: file.byteSize })) };
  return { manifest, verified, contents, totalBytes: output.byteSize, supplementSha256: canonicalSupplement(manifest).supplementSha256 };
}

test('immutable-slot adoption uses real registration/finalization, accounts private proofs and excludes them from serving', async t => {
  const f = fixture(t), candidate = supplementCandidate(f);
  f.request.supplementSha256 = candidate.supplementSha256;
  const { registerImmutableSupplement } = require('../server/derivativeSupplementRegistration');
  let registered;
  const service = new DerivativeRecovery(f.processing, { qualifySupplement: async ({ operation }) => ({
    supplementSha256: candidate.supplementSha256,
    register(args) { registered = registerImmutableSupplement({ ...args, operation, manifest: candidate.manifest, verified: candidate.verified }); return registered; },
  }) });
  const requested = service.request(f.request), row = service.claim(requested.id, 'worker');
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, candidate.manifest);
  const result = service.commit(ticket);
  assert.equal(result.ready, true);
  const output = f.processing.getModelOutput(f.version);
  assert.equal(output.status, 'ready'); assert.equal(output.attemptId, f.attempt.id);
  assert.equal(output.byteSize, 20 + candidate.totalBytes);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n, 1);
  const asset = f.repository.getModelVersion(output.modelId, f.version).activeVersion.assets.find(asset => asset.kind === 'tiles');
  assert.equal(asset.relativePath, `${f.task.id}/${f.attempt.id}/derived/recovery/${row.id}/${row.lease_token}/tileset.json`);
  assert.deepEqual(f.db.prepare('SELECT relative_path FROM model_asset_files WHERE asset_id=? ORDER BY relative_path').all(asset.id).map(row => row.relative_path), ['mesh.b3dm', 'tileset.json']);
  const proof = f.db.prepare("SELECT * FROM model_output_storage_components WHERE component_key=?").get(`recovery-private:${row.id}`);
  assert.equal(proof.byte_size, registered.privateProofBytes);
  const retained = JSON.parse(f.db.prepare("SELECT details_json FROM audit_events WHERE action='derivative_recovery.retained_inventory'").get().details_json);
  assert.equal(retained.totalBytes, candidate.totalBytes); assert.equal(retained.files.length, 5);
  const { publishedAssetIntegrityAllows } = require('../server/assets');
  const root = path.posix.dirname(asset.relativePath);
  for (const [relative, data] of Object.entries(candidate.contents)) {
    const file = path.join(f.root, 'models', root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  }
  const privatePng = path.join(f.root, 'models', root, 'private-proof/atlas.png');
  assert.equal(fs.existsSync(privatePng), true);
  assert.equal(await publishedAssetIntegrityAllows(f.repository, { provider: 'ltds-processing' }, asset, `${root}/private-proof/atlas.png`, privatePng), false);
  const neighbor = path.join(f.root, 'models', root, 'neighbor.secret'); fs.writeFileSync(neighbor, 'not in the render closure');
  assert.equal(await publishedAssetIntegrityAllows(f.repository, { provider: 'ltds-processing' }, asset, `${root}/neighbor.secret`, neighbor), false);
  assert.equal(await publishedAssetIntegrityAllows(f.repository, { provider: 'ltds-processing' }, asset, `${root}/private-proof/uv.jsonl`, '/must-not-open-private-file'), false);
  assert.equal(await publishedAssetIntegrityAllows(f.repository, { provider: 'ltds-processing' }, asset, `${root}/diagnostic/log.txt`, '/must-not-open-private-file'), false);
});

for (const [label, change, code] of [
  ['private file mislabeled as render', c => { c.verified.renderArtifacts.push({ uri: 'private-proof/uv.jsonl', sha256: 'f'.repeat(64), byteLength: 17 }); }, 'supplement_render_closure_invalid'],
  ['missing rendered leaf', c => { c.verified.renderArtifacts.pop(); }, 'supplement_render_closure_invalid'],
  ['different verified bytes', c => { c.verified.asset.manifestFiles[0].sha256 = 'f'.repeat(64); }, 'supplement_render_closure_invalid'],
]) test(`immutable registration rejects ${label}`, t => {
  const f = fixture(t), candidate = supplementCandidate(f), service = new DerivativeRecovery(f.processing);
  f.request.supplementSha256 = candidate.supplementSha256;
  const row = service.claim(service.request(f.request).id, 'worker');
  const context = service.unchanged(row);
  change(candidate);
  const { supplementRenderRegistration } = require('../server/derivativeSupplementRegistration');
  assert.throws(() => supplementRenderRegistration(row, context, candidate.manifest, candidate.verified), { code });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM model_assets WHERE kind='tiles'").get().n, 0);
});


test('composed staging qualifier pins the actual immutable slot and runs the same-attempt registration path on Linux', async t => {
  const f = fixture(t, { physicalSource: true }), candidate = supplementCandidate(f);
  const input = f.processing.derivativeInputSnapshot(f.jobId);
  f.db.prepare('UPDATE processing_attempt_transfer_provenance SET initialization_json=?,archive_json=? WHERE attempt_id=?').run(
    JSON.stringify({ state: 'acknowledged', ambiguous: false, attemptId: f.attempt.id, providerTaskId: f.attempt.providerTaskId, generation: 1 }),
    JSON.stringify({ attemptId: f.attempt.id, providerTaskId: f.attempt.providerTaskId, archiveSha256: 'a'.repeat(64), layoutVersion: 2,
      archiveFiles: input.files.map(file => ({ relativePath: path.posix.basename(file.relativePath), byteSize: file.byteSize, sha256: file.sha256 })) }), f.attempt.id);
  // Synthetic producer admission/proof, not a real producer request or geometry check.
  f.processing.getVerifiedAttemptProducerReceipt = () => ({ synthetic: true });
  const modelsRoot = path.join(f.root, 'models'); let releases = 0;
  const { createStagingImmutableSupplementQualifier, immutableSupplementSlot } = require('../server/derivativeSupplementRegistration');
  const qualifier = createStagingImmutableSupplementQualifier({ processing: f.processing, modelsRoot,
    resolveBinding: async () => ({ environment: 'STAGING', providerId: f.provider.id, providerEndpoint: f.provider.endpoint,
      coordinateFrame: candidate.manifest.coordinateFrame }),
    resolveProducerBinding: async () => ({ schemaVersion: 1, providerEndpoint: f.provider.endpoint, providerTaskId: f.attempt.providerTaskId,
      environment: 'STAGING', producerGeneration: 1, nativeTaskId: 'synthetic-native', archiveSha256: 'a'.repeat(64) }),
    confirmProducerIncarnation: async () => true, acceptConverter: async () => true,
    acquireFence: async () => ({ assertActive: () => true, release() { releases++; } }),
    verifyCandidate: async args => ({ verified: candidate.verified, receipt: { schemaVersion: 1,
      policyRevision: candidate.manifest.converter.policyRevision, identity: args.identity,
      outputManifestSha256: candidate.manifest.outputManifestSha256,
      checks: { geometry: true, sourceUvCoverage: true, atlasPixels: true, finalTextureRelation: true } } }),
  });
  f.request.supplementSha256 = candidate.supplementSha256;
  const service = new DerivativeRecovery(f.processing, { qualifySupplement: qualifier });
  const row = service.claim(service.request(f.request).id, 'worker'), context = service.unchanged(row);
  const slot = path.join(modelsRoot, immutableSupplementSlot(row, context));
  for (const [relative, data] of Object.entries(candidate.contents)) { const file = path.join(slot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
  if (process.platform !== 'linux') {
    await assert.rejects(service.prepare(row.id, row.lease_owner, row.lease_token, candidate.manifest), { code: 'supplement_platform_unsupported' });
    assert.equal(releases, 1); return;
  }
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, candidate.manifest);
  assert.equal(service.commit(ticket).ready, true);
  assert.equal(releases, 1);
  assert.equal(f.processing.getAttempt(f.attempt.id).status, 'ready_for_review');
  assert.equal(fs.readFileSync(path.join(slot, 'private-proof/uv.jsonl'), 'utf8'), candidate.contents['private-proof/uv.jsonl']);
  assert.equal(f.processing.getModelOutput(f.version).byteSize, 20 + candidate.totalBytes);
});


test('immutable-slot registration rejection rolls back restored states and private byte accounting', async t => {
  const f = fixture(t), candidate = supplementCandidate(f), before = failureState(f);
  f.request.supplementSha256 = candidate.supplementSha256;
  candidate.verified.provenance.sourceSha256 = 'f'.repeat(64);
  const { registerImmutableSupplement } = require('../server/derivativeSupplementRegistration');
  const service = new DerivativeRecovery(f.processing, { qualifySupplement: async ({ operation }) => ({
    supplementSha256: candidate.supplementSha256,
    register: args => registerImmutableSupplement({ ...args, operation, manifest: candidate.manifest, verified: candidate.verified }),
  }) });
  const row = service.claim(service.request(f.request).id, 'worker');
  const ticket = await service.prepare(row.id, row.lease_owner, row.lease_token, candidate.manifest);
  assert.throws(() => service.commit(ticket), { code: 'supplement_registration_rejected' });
  assert.deepEqual(failureState(f), before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM model_output_storage_components WHERE component_key LIKE 'recovery-private:%'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='derivative_recovery.retained_inventory'").get().n, 0);
  assert.equal(service.get(row.id).status, 'leased');
});

test('composed immutable-slot qualifier rejects production before acquiring physical custody', async t => {
  const f = fixture(t), candidate = supplementCandidate(f); let fenced = 0;
  const { createStagingImmutableSupplementQualifier } = require('../server/derivativeSupplementRegistration');
  const qualifier = createStagingImmutableSupplementQualifier({ processing: f.processing, modelsRoot: f.root,
    resolveBinding: async () => ({ environment: 'PRODUCTION' }), resolveProducerBinding: async () => ({}),
    confirmProducerIncarnation: async () => true, acceptConverter: async () => true,
    acquireFence: async () => { fenced++; return {}; }, verifyCandidate: async () => ({}),
  });
  f.request.supplementSha256 = candidate.supplementSha256;
  const service = new DerivativeRecovery(f.processing, { qualifySupplement: qualifier });
  const row = service.claim(service.request(f.request).id, 'worker');
  await assert.rejects(service.prepare(row.id, row.lease_owner, row.lease_token, candidate.manifest), { code: 'supplement_staging_only' });
  assert.equal(fenced, 0);
});


test('staging runner loads the bound supplement, commits the same attempt and does not repeat terminal work', async t => {
  const f = fixture(t), candidate = supplementCandidate(f); let loads = 0;
  f.request.supplementSha256 = candidate.supplementSha256;
  const { registerImmutableSupplement } = require('../server/derivativeSupplementRegistration');
  const service = new DerivativeRecovery(f.processing, { qualifySupplement: async ({ operation }) => ({
    supplementSha256: candidate.supplementSha256,
    register: args => registerImmutableSupplement({ ...args, operation, manifest: candidate.manifest, verified: candidate.verified }),
  }) });
  const row = service.request(f.request);
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const options = { service, operationId: row.id, owner: 'worker', environment: 'STAGING',
    loadSupplement: async ({ operation, signal }) => { assert.equal(signal.aborted, false); assert.equal(operation.id, row.id); loads++; return candidate.manifest; } };
  const result = await runDerivativeRecovery(options);
  assert.deepEqual(result, { id: row.id, status: 'complete', ready: true, cleanupComplete: true });
  assert.equal(f.processing.getAttempt(f.attempt.id).status, 'ready_for_review');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n, 1);
  assert.deepEqual(await runDerivativeRecovery(options), { id: row.id, status: 'complete' });
  assert.equal(loads, 1);
});

test('staging runner defers heavy-work conflict without loading or mutating original failure', async t => {
  const f = fixture(t), before = failureState(f), service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  f.processing.measurementCalculationActive = () => true;
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const result = await runDerivativeRecovery({ service, operationId: row.id, owner: 'worker', environment: 'STAGING',
    loadSupplement: async () => { assert.fail('busy recovery must not load private source'); } });
  assert.equal(result.status, 'deferred'); assert.equal(result.errorCode, 'recovery_heavy_work_busy');
  assert.equal(service.get(row.id).status, 'queued');
  assert.deepEqual(failureState(f), before);
});

test('runner cancellation awaits signal-aware loading before abandoning its own lease', async t => {
  const f = fixture(t), before = failureState(f), service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  const controller = new AbortController(); let start, readerStopped = false;
  const started = new Promise(resolve => { start = resolve; });
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const run = runDerivativeRecovery({ service, operationId: row.id, owner: 'worker', environment: 'STAGING', signal: controller.signal,
    loadSupplement: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { readerStopped = true; reject(signal.reason); }, { once: true }); start();
    }) });
  await started; controller.abort();
  const result = await run;
  assert.equal(readerStopped, true); assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'recovery_cancelled');
  assert.equal(service.get(row.id).error_code, 'recovery_cancelled');
  assert.equal(f.db.prepare('SELECT job_id FROM lod_conversion_lock').get().job_id, null);
  assert.equal(f.processing.derivativeRecoveryUsesEntity('output', f.version), true);
  assert.deepEqual(failureState(f), before);
});

test('runner heartbeat detects reclaimed lease and cannot abandon replacement ownership', async t => {
  const f = fixture(t), service = new DerivativeRecovery(f.processing), row = service.request(f.request); let start;
  const started = new Promise(resolve => { start = resolve; });
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const run = runDerivativeRecovery({ service, operationId: row.id, owner: 'old_worker', environment: 'STAGING', heartbeatMs: 250,
    loadSupplement: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); start();
    }) });
  await started;
  f.db.prepare("UPDATE derivative_recovery_operations SET lease_expires_at='2000-01-01' WHERE id=?").run(row.id);
  f.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01' WHERE id=1").run();
  const replacement = new DerivativeRecovery(f.processing).claim(row.id, 'new_worker');
  const result = await run;
  assert.equal(result.status, 'lost'); assert.equal(result.errorCode, 'recovery_lease_lost');
  assert.equal(service.get(row.id).lease_token, replacement.lease_token);
  assert.equal(f.db.prepare('SELECT lease_owner FROM lod_conversion_lock').get().lease_owner, 'new_worker');
});

test('runner records static failure codes and keeps private loader errors out of its receipt', async t => {
  const f = fixture(t), before = failureState(f), service = new DerivativeRecovery(f.processing), row = service.request(f.request);
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const result = await runDerivativeRecovery({ service, operationId: row.id, owner: 'worker', environment: 'STAGING',
    loadSupplement: async () => { throw new Error('/private/client/model/source path'); } });
  assert.deepEqual(result, { id: row.id, status: 'failed', errorCode: 'recovery_failed' });
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.deepEqual(failureState(f), before);
});

test('runner refuses production before reading any operation', async () => {
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  await assert.rejects(runDerivativeRecovery({ service: { get() { assert.fail('must not access production'); } },
    operationId: 'anything', owner: 'worker', environment: 'PRODUCTION', loadSupplement: async () => ({}) }), { code: 'recovery_runner_staging_only' });
});


test('read-only fence distinguishes bind-mount flags from backing-filesystem flags and rejects ambiguity', () => {
  const { readOnlyMount, unprivileged } = require('../server/derivativeRecoveryFence');
  const ro = '42 1 0:9 /source /models ro,nosuid,nodev - ext4 /dev/volume rw';
  const rw = '43 1 0:9 /tmp /work rw,nosuid - ext4 /dev/volume ro';
  assert.equal(readOnlyMount(`${ro}\n${rw}`, '42'), true);
  assert.equal(readOnlyMount(`${ro}\n${rw}`, '43'), false);
  assert.equal(readOnlyMount(`${ro}\n${ro}`, '42'), false);
  assert.equal(readOnlyMount('42 1 broken', '42'), false);
  assert.equal(readOnlyMount(ro, '99'), false);
  assert.equal(unprivileged('CapEff:\t0000000000000000', 568), true);
  assert.equal(unprivileged('CapEff:\t0000000000200000', 568), false);
  assert.equal(unprivileged('CapEff:\t0000000000000000', 0), false);
  assert.equal(unprivileged('not a capability record', 568), false);
});

test('actual Linux controller RO mount fence requires continued external admission and releases descriptors', async () => {
  const { createReadOnlyRecoveryFence } = require('../server/derivativeRecoveryFence');
  let admitted = true;
  const acquire = createReadOnlyRecoveryFence({ modelsRoot: '/', assertExclusiveMaintenance: () => admitted });
  if (process.platform !== 'linux') {
    await assert.rejects(acquire({ operation: {}, assertCurrent() {} }), { code: 'supplement_platform_unsupported' }); return;
  }
  // Admitted Linux source runner is UID568 with RO root. This tests real kernel
  // RO flags, not actual exclusion of host writers (the admission here is fake).
  let preparing = true, guardCalls = 0;
  const fence = await acquire({ operation: {}, assertCurrent() { guardCalls++; assert.equal(preparing, true); } });
  assert.equal(guardCalls, 2);
  // Atomic commit has restored nonfailed states. Custody now supplies its
  // fresh lease guard; the OS fence must not invoke stale failed-state checks.
  preparing = false;
  assert.equal(fence.assertActive(), true);
  assert.equal(guardCalls, 2);
  admitted = false;
  assert.throws(() => fence.assertActive(), { code: 'supplement_external_fence_lost' });
  fence.release(); fence.release();
  assert.throws(() => fence.assertActive(), { code: 'supplement_fence_lost' });
});

test('actual controller fence refuses writable temporary source mount even with maintenance admission', async t => {
  const f = fixture(t);
  const { createReadOnlyRecoveryFence } = require('../server/derivativeRecoveryFence');
  const acquire = createReadOnlyRecoveryFence({ modelsRoot: f.root, assertExclusiveMaintenance: () => true });
  await assert.rejects(acquire({ operation: {}, assertCurrent() {} }), {
    code: process.platform === 'linux' ? 'supplement_fence_not_readonly' : 'supplement_platform_unsupported',
  });
});


test('runner resumes only its exact intake lease and still rejects changed authorization', async t => {
  const f = fixture(t), service = new DerivativeRecovery(f.processing), row = service.claim(service.request(f.request).id, 'intake_owner');
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const options = { service, operationId: row.id, owner: 'intake_owner', environment: 'STAGING', leaseToken: row.lease_token,
    loadSupplement: async () => { assert.fail('invalid resume must not load'); } };
  await assert.rejects(runDerivativeRecovery({ ...options, leaseToken: '0'.repeat(48) }), { code: 'recovery_lease_lost' });
  assert.equal(service.get(row.id).lease_token, row.lease_token);
  f.db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), f.session.id);
  await assert.rejects(runDerivativeRecovery(options), { code: 'recovery_forbidden' });
  assert.equal(service.get(row.id).status, 'leased');
});

test('runner accepts valid same-owner intake resume without changing its lease token', async t => {
  const f = fixture(t), service = new DerivativeRecovery(f.processing), row = service.claim(service.request(f.request).id, 'intake_owner');
  const { runDerivativeRecovery } = require('../server/derivativeRecoveryRunner');
  const result = await runDerivativeRecovery({ service, operationId: row.id, owner: 'intake_owner', environment: 'STAGING', leaseToken: row.lease_token,
    loadSupplement: async ({ operation }) => { assert.equal(operation.lease_token, row.lease_token); throw Object.assign(new Error('synthetic unavailable verifier input'), { code: 'supplement_source_unavailable' }); } });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'supplement_source_unavailable');
  assert.equal(service.get(row.id).error_code, 'supplement_source_unavailable');
});
