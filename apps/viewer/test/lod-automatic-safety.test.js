'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { lodDerivativeSpecs } = require('../server/lodDerivativePolicy');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { generateMeshTiles, processOneDerivative, run: runDerivativeCommand } = require('../server/derivativeWorker');
const { StorageManager } = require('../server/storageManager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-ktx2-safety-'));
  for (const name of ['datasets', 'models', 'cache', 'trash', 'imports']) fs.mkdirSync(path.join(root, name));
  const databasePath = path.join(root, 'viewer.sqlite');
  const db = openDatabase(databasePath);
  const processing = new ProcessingRepository(db);
  const repository = new ViewerRepository(db);
  const storage = new StorageManager({
    datasetsMount: path.join(root, 'datasets'),
    modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'),
    datasetImportMount: path.join(root, 'imports'),
    storageReserveBytes: 0,
    storageReservePercent: 0,
  });
  storage.initialize();
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, databasePath, db, processing, repository, storage };
}

function readyAttempt(processing, label) {
  const project = processing.createProject({ displayName: `${label} ${crypto.randomUUID()}` });
  const dataset = processing.createDataset({
    projectId: project.id,
    displayName: `${label} source`,
    storageMode: 'managed',
    rootKey: 'datasets',
    relativePath: crypto.randomUUID(),
  });
  processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: label });
  return processing.createImportedAttempt({
    id: crypto.randomUUID(),
    taskId: task.id,
    datasetId: dataset.id,
    providerTaskId: `fixture:${label}`,
    createdBy: 'ops:test',
    staged: false,
  });
}

function readyOutputAttempt(c, label) {
  const attempt = readyAttempt(c.processing, label);
  const task = c.processing.getTask(attempt.taskId);
  const model = c.repository.upsertModelVersion({
    provider: 'ltds-processing',
    providerModelId: task.id,
    providerVersionId: attempt.id,
    displayName: task.displayName,
    status: 'ready',
    assets: [],
    makeActive: false,
  });
  const versionId = c.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  c.processing.setAttemptResult(attempt.id, model.id, versionId);
  c.processing.registerModelOutput({
    versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: task.projectId,
    relativePath: `${task.id}/${attempt.id}`, status: 'ready', byteSize: 0, assetCount: 0,
  });
  return c.processing.getAttempt(attempt.id);
}

test('required new ingest generates KTX2 instead of accepting bundled JPEG tiles', () => {
  const assets = [
    { kind: 'tiles', rootKey: 'datasets', relativePath: 'import/tiles/tileset.json' },
    { kind: 'obj', rootKey: 'datasets', relativePath: 'import/model.obj' },
    { kind: 'glb', rootKey: 'datasets', relativePath: 'import/model.glb' },
  ];
  assert.deepEqual(lodDerivativeSpecs(assets, { meshDerivativesEnabled: true, required: true }), [
    { type: 'mesh_tiles', request: { optional: false } },
  ]);
});

test('migration and BEGIN IMMEDIATE singleton fence concurrent heavy derivative claims with unique tokens', (t) => {
  const c = fixture(t);
  const firstAttempt = readyAttempt(c.processing, 'First');
  const secondAttempt = readyAttempt(c.processing, 'Second');
  c.processing.enqueueDerivative(firstAttempt.id, 'ept', { optional: true });
  c.processing.enqueueDerivative(secondAttempt.id, 'mesh_tiles', { optional: true });
  c.db.prepare("UPDATE derivative_jobs SET created_at=CASE derivative_type WHEN 'ept' THEN '2026-01-01T00:00:00.000Z' ELSE '2026-01-01T00:00:01.000Z' END").run();

  const secondDb = openDatabase(c.databasePath);
  const second = new ProcessingRepository(secondDb);
  t.after(() => secondDb.close());

  const claimed = c.processing.claimDerivative('worker-one');
  const attemptIds = new Set([firstAttempt.id, secondAttempt.id]);
  assert.equal(attemptIds.has(claimed.attempt_id), true);
  const remainingAttemptId = claimed.attempt_id === firstAttempt.id ? secondAttempt.id : firstAttempt.id;
  assert.match(claimed.lease_token, /^[a-f0-9]{32}$/);
  assert.equal(claimed.attempt_count, 1);
  assert.equal(second.claimDerivative('worker-two'), null, 'the singleton prevents a second conversion claim');
  const lock = c.db.prepare('SELECT * FROM lod_conversion_lock WHERE id=1').get();
  assert.equal(lock.job_id, claimed.id);
  assert.equal(lock.lease_token, claimed.lease_token);
  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'worker-one', '0'.repeat(32)), false);
  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'worker-one', claimed.lease_token), true);
  assert.equal(c.processing.failOptionalDerivative(claimed.id, 'worker-one', 'fixture failure', 'derivative_failed', claimed.lease_token), true);

  const next = second.claimDerivative('worker-two');
  assert.equal(next.attempt_id, remainingAttemptId);
  assert.notEqual(next.lease_token, claimed.lease_token);
});

test('database uniqueness blocks a pre-v28 worker from claiming a second live heavy job', (t) => {
  const c = fixture(t);
  const firstAttempt = readyAttempt(c.processing, 'DB singleton first');
  const secondAttempt = readyAttempt(c.processing, 'DB singleton second');
  c.processing.enqueueDerivative(firstAttempt.id, 'mesh_tiles', { optional: true });
  c.processing.enqueueDerivative(secondAttempt.id, 'mesh_tiles', { optional: true });
  c.processing.claimDerivative('new-worker');
  const pending = c.db.prepare("SELECT id FROM derivative_jobs WHERE status='pending'").get();
  assert.throws(
    () => c.db.prepare("UPDATE derivative_jobs SET status='leased',lease_owner='old-worker',lease_expires_at=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), pending.id),
    /UNIQUE constraint failed/,
  );
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE derivative_type IN ('ept','mesh_tiles','lod_audit') AND status='leased'").get().n, 1);
});

test('an active legacy LOD lease without a singleton row fences new conversion claims', (t) => {
  const c = fixture(t);
  const firstAttempt = readyAttempt(c.processing, 'Legacy active');
  const secondAttempt = readyAttempt(c.processing, 'Pending after upgrade');
  c.processing.enqueueDerivative(firstAttempt.id, 'mesh_tiles', { optional: true });
  c.processing.enqueueDerivative(secondAttempt.id, 'mesh_tiles', { optional: true });
  const active = c.processing.claimDerivative('legacy-worker');
  c.db.prepare('UPDATE derivative_jobs SET lease_token=NULL WHERE id=?').run(active.id);
  c.db.prepare(`UPDATE lod_conversion_lock SET
    job_id=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
    WHERE id=1`).run();

  assert.equal(c.processing.claimDerivative('new-worker'), null);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE status='leased'").get().n, 1);
});

test('mesh conversion consumes its durable reservation and all concurrent admission reserves',()=>{const source=fs.readFileSync(path.join(__dirname,'..','server','derivativeWorker.js'),'utf8'),start=source.indexOf('async function generateMeshTiles'),end=source.indexOf('async function processOneDerivative',start),block=source.slice(start,end);assert.match(block,/derivativeStorageReservation/);assert.match(block,/activeDerivativeReservationBytes/);assert.match(block,/activeProcessingReservationBytes/);const admission=block.indexOf('requireDerivativeSpace'),spawn=block.indexOf('await runObj2TilesWithResourceRetry');assert.ok(admission>=0&&spawn>admission);});

test('EPT worker uses token-specific staging and fenced promotion without deleting a shared final',()=>{const source=fs.readFileSync(path.join(__dirname,'..','server','derivativeWorker.js'),'utf8'),start=source.indexOf("job.derivative_type === 'ept'"),end=source.indexOf("job.derivative_type === 'mesh_tiles'",start),block=source.slice(start,end);assert.match(block,/ept-\$\{job\.id\}/);assert.match(block,/\$\{output\}\.\$\{job\.lease_token\}\.incomplete/);assert.match(block,/registerVerifiedEptAsset/);const admission=block.indexOf('requireDerivativeSpace'),spawn=block.indexOf('await run(converter?.executablePath||config.entwineBin');assert.ok(admission>=0&&spawn>admission);assert.match(block,/activeDerivativeReservationBytes/);assert.match(block,/if\(!durableReceipt\)fs\.rmSync\(complete/);assert.doesNotMatch(block,/rmSync\(output/);assert.doesNotMatch(block,/addModelAsset/);});

test('EPT retries share the three-claim heavy derivative budget', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'EPT retries');
  c.processing.enqueueDerivative(attempt.id, 'ept', { optional: true });
  let claimed;
  for (let index = 0; index < 3; index += 1) {
    claimed = c.processing.claimDerivative(`ept-worker-${index}`);
    assert.equal(claimed.derivative_type, 'ept');
    c.db.prepare("UPDATE derivative_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
    c.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?").run(claimed.id);
  }
  assert.equal(claimed.attempt_count, 3);
  assert.equal(c.processing.claimDerivative('ept-worker-exhausted'),null);
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(claimed.id).status,'failed');
});

test('manual retry starts a fresh heavy lease budget and deadline', (t) => {
  const c = fixture(t);
  const attempt = readyOutputAttempt(c, 'EPT manual retry');
  c.processing.enqueueDerivative(attempt.id, 'ept', { optional: true });
  const claimed = c.processing.claimDerivative('ept-retry-worker');
  assert.equal(c.processing.failOptionalDerivative(claimed.id, 'ept-retry-worker', 'fixture failure', 'derivative_failed', claimed.lease_token), true);
  c.db.prepare("UPDATE derivative_jobs SET attempt_count=7,first_started_at='2000-01-01T00:00:00.000Z',deadline_at='2000-01-02T00:00:00.000Z' WHERE id=?").run(claimed.id);

  assert.ok(c.processing.retryOptionalDerivative(claimed.id, 'ops:test'));
  const row = c.db.prepare('SELECT status,attempt_count,first_started_at,deadline_at FROM derivative_jobs WHERE id=?').get(claimed.id);
  assert.deepEqual({ ...row }, { status: 'pending', attempt_count: 0, first_started_at: null, deadline_at: null });
});

test('expired EPT deadlines become terminal and release the heavy lock', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'EPT deadline');
  c.processing.enqueueDerivative(attempt.id, 'ept', { optional: true });
  const claimed = c.processing.claimDerivative('ept-deadline-worker');
  c.db.prepare("UPDATE derivative_jobs SET deadline_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
  assert.equal(c.processing.terminalizeExhaustedDerivatives(20), 1);
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(claimed.id).status, 'failed');
  assert.equal(c.db.prepare('SELECT job_id FROM lod_conversion_lock WHERE id=1').get().job_id, null);
});

test('a past wall-clock deadline terminalizes even if a legacy lease extends beyond it', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Legacy deadline overrun');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('legacy-deadline-worker');
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  c.db.prepare("UPDATE derivative_jobs SET deadline_at='2000-01-01T00:00:00.000Z',lease_expires_at=? WHERE id=?").run(future, claimed.id);
  c.db.prepare('UPDATE lod_conversion_lock SET lease_expires_at=? WHERE id=1').run(future);

  assert.equal(c.processing.terminalizeExhaustedDerivatives(20), 1);
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(claimed.id).status, 'failed');
  assert.equal(c.db.prepare('SELECT job_id FROM lod_conversion_lock WHERE id=1').get().job_id, null);
});

test('reclaimed LOD lease is capped at the persisted derivative deadline', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Deadline reclaim cap');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const first = c.processing.claimDerivative('first-deadline-worker');
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  c.db.prepare("UPDATE derivative_jobs SET deadline_at=?,lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(deadline, first.id);
  c.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=1").run();

  const reclaimed = c.processing.claimDerivative('second-deadline-worker', 600);
  assert.equal(reclaimed.id, first.id);
  assert.ok(Date.parse(reclaimed.lease_expires_at) <= Date.parse(deadline));
  assert.equal(c.db.prepare('SELECT lease_expires_at FROM lod_conversion_lock WHERE id=1').get().lease_expires_at, reclaimed.lease_expires_at);
});

test('expired derivative lease cannot be resurrected by heartbeat', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Expired heartbeat');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('expired-heartbeat-worker');
  const expired = '2000-01-01T00:00:00.000Z';
  c.db.prepare('UPDATE derivative_jobs SET lease_expires_at=? WHERE id=?').run(expired, claimed.id);
  c.db.prepare('UPDATE lod_conversion_lock SET lease_expires_at=? WHERE id=1').run(expired);

  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'expired-heartbeat-worker', claimed.lease_token), false);
  assert.equal(c.db.prepare('SELECT lease_expires_at FROM derivative_jobs WHERE id=?').get(claimed.id).lease_expires_at, expired);
});

test('legacy numeric heartbeat argument retains its lease-duration meaning', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Legacy heartbeat API');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('legacy-heartbeat-worker');
  const before = Date.now();
  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'legacy-heartbeat-worker', 75), true);
  const expires = Date.parse(c.db.prepare('SELECT lease_expires_at FROM derivative_jobs WHERE id=?').get(claimed.id).lease_expires_at);
  assert.ok(expires >= before + 70_000 && expires <= before + 80_000, `unexpected lease duration: ${expires - before}`);
});

test('failed LOD-lock heartbeat rolls back the derivative-row extension', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Heartbeat lock rollback');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('rollback-heartbeat-worker');
  const original = claimed.lease_expires_at;
  c.db.prepare("UPDATE lod_conversion_lock SET lease_token=(CASE substr(lease_token,1,1) WHEN '0' THEN '1' ELSE '0' END) || substr(lease_token,2) WHERE id=1").run();

  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'rollback-heartbeat-worker', claimed.lease_token, 900), false);
  assert.equal(c.db.prepare('SELECT lease_expires_at FROM derivative_jobs WHERE id=?').get(claimed.id).lease_expires_at, original);
});

test('heartbeat renewal is capped at the persisted derivative deadline', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Deadline cap');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('deadline-cap-worker');
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  c.db.prepare('UPDATE derivative_jobs SET deadline_at=? WHERE id=?').run(deadline, claimed.id);

  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'deadline-cap-worker', claimed.lease_token, 600), true);
  const row = c.db.prepare('SELECT lease_expires_at FROM derivative_jobs WHERE id=?').get(claimed.id);
  const lock = c.db.prepare('SELECT lease_expires_at FROM lod_conversion_lock WHERE id=1').get();
  assert.ok(Date.parse(row.lease_expires_at) <= Date.parse(deadline));
  assert.equal(lock.lease_expires_at, row.lease_expires_at);
});

test('a persisted derivative deadline fences heartbeat renewal', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Deadline');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('deadline-worker');
  c.db.prepare("UPDATE derivative_jobs SET deadline_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
  assert.equal(c.processing.heartbeatDerivative(claimed.id, 'deadline-worker', claimed.lease_token), false);
});

test('exhausted derivative leases become terminal and release the singleton', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Exhausted');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('dead-worker');
  c.db.prepare("UPDATE derivative_jobs SET attempt_count=3,lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
  c.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=1").run();
  assert.equal(c.processing.terminalizeExhaustedDerivatives(20), 1);
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(claimed.id).status, 'failed');
  assert.equal(c.db.prepare('SELECT job_id FROM lod_conversion_lock WHERE id=1').get().job_id, null);
  assert.equal(c.processing.getAttempt(attempt.id).status, 'ready_for_review', 'optional work cannot take the ready model offline');
});

test('terminalizing a required derivative emits the durable processing failure event', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Required timeout event');
  c.db.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);
  c.db.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(attempt.taskId);
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: false });
  const claimed = c.processing.claimDerivative('required-timeout-worker');
  c.db.prepare("UPDATE derivative_jobs SET deadline_at='2000-01-01T00:00:00.000Z',lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
  c.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=1").run();

  assert.equal(c.processing.terminalizeExhaustedDerivatives(20), 1);
  const event = c.db.prepare("SELECT event_type,payload_json FROM event_outbox WHERE id=?").get(`processing-failed-${attempt.id}`);
  assert.equal(event.event_type, 'processing.failed');
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.attemptId, attempt.id);
  assert.equal(payload.error.code, 'derivative_timeout');
});

test('a required derivative cannot complete readiness with an unverified result', (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Required audit');
  c.db.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);
  c.processing.enqueueDerivative(attempt.id, 'lod_audit', { optional: false });
  const claimed = c.processing.claimDerivative('required-audit-worker');
  assert.throws(
    () => c.processing.completeDerivativeAndMaybeReady(
      claimed.id,
      'required-audit-worker',
      { verified: false },
      { event: { eventId: crypto.randomUUID() }, leaseToken: claimed.lease_token },
    ),
    (error) => error.code === 'derivative_not_verified',
  );
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(claimed.id).status, 'leased');
});

test('production worker no longer invokes legacy ready/published LOD maintenance', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'worker.js'), 'utf8');
  assert.doesNotMatch(source, /reconcileLodMaintenance/);
  assert.match(source, /reconcileLodDerivativeStorage/);
});

test('a stray optional LOD job fails without mutating a ready version', async (t) => {
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Immutable');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  let generated = false;
  await processOneDerivative({
    processing: c.processing,
    storage: c.storage,
    config: { meshDerivativesEnabled: true, opsBaseUrl: 'https://ops.example.test' },
    generateMeshTilesImpl: async () => { generated = true; return {}; },
  }, 'immutable-worker');
  assert.equal(generated, false);
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE attempt_id=?').get(attempt.id).status, 'failed');
  assert.equal(c.processing.getAttempt(attempt.id).status, 'ready_for_review');
});

test('derivative timeout hard-kills an uncooperative process tree before returning', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-derivative-kill-'));
  const pidFile = path.join(root, 'pid');
  let pid = null;
  t.after(() => {
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;

  await assert.rejects(
    runDerivativeCommand(process.execPath, ['-e', script], { timeoutMs: 250, killGraceMs: 50 }),
    (error) => error.code === 'derivative_timeout',
  );
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
});

test('TrueNAS worker resource ceilings are fixed and not upward-overridable', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /viewer-worker:[\s\S]*cpus:\s*"16\.0"/);
  assert.match(compose, /viewer-worker:[\s\S]*mem_limit:\s*24g/);
  assert.doesNotMatch(compose, /VIEWER_WORKER_CPUS|VIEWER_WORKER_MEMORY/);
});

test('the Viewer and Basis transcoder come from one exact Three.js release', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies.three, '0.185.1');
});

test('worker supervisor fences stale or foreign heartbeat state', () => {
  const { heartbeatIsFresh } = require('../server/workerSupervisor');
  const nowMs = Date.now();
  assert.equal(heartbeatIsFresh({ owner: 'worker-instance-a', at: new Date(nowMs - 1000).toISOString() }, 'instance-a', nowMs, 60_000), true);
  assert.equal(heartbeatIsFresh({ owner: 'worker-instance-b', at: new Date(nowMs - 1000).toISOString() }, 'instance-a', nowMs, 60_000), false);
  assert.equal(heartbeatIsFresh({ owner: 'worker-instance-a', at: new Date(nowMs - 61_000).toISOString() }, 'instance-a', nowMs, 60_000), false);
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /viewer-worker:[\s\S]*command:\s*\["node",\s*"server\/workerSupervisor\.js"\]/);
  const supervisor = fs.readFileSync(path.join(__dirname, '..', 'server', 'workerSupervisor.js'), 'utf8');
  assert.match(supervisor, /verifySqliteLocking\(config\.databasePath\)/);
});

test('worker supervisor never signals an already signal-terminated child', () => {
  const { stopChild } = require('../server/workerSupervisor');
  let fallbackKills = 0;
  stopChild({ pid: 2_147_483_647, exitCode: null, signalCode: 'SIGTERM', kill: () => { fallbackKills += 1; } }, 'SIGKILL');
  assert.equal(fallbackKills, 0);
});

test('SQLite lock preflight proves BEGIN IMMEDIATE fencing on the configured filesystem', (t) => {
  const { verifySqliteLocking } = require('../server/sqliteLockPreflight');
  const c = fixture(t);
  assert.deepEqual(verifySqliteLocking(c.databasePath), { ok: true, busyObserved: true, writeAfterRollback: true });
});

test('terminal derivative token directories are removed only after the grace period', (t) => {
  const { reconcileLodDerivativeStorage } = require('../server/lodDerivativeStorage');
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Cleanup');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('cleanup-worker');
  assert.equal(c.processing.failOptionalDerivative(claimed.id, 'cleanup-worker', 'fixture', 'derivative_failed', claimed.lease_token), true);
  const base = path.join(c.storage.roots.models, attempt.taskId, attempt.id);
  const stale = path.join(base, `tiles-ktx2-etc1s-${claimed.id}.${claimed.lease_token}.incomplete`);
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(stale, old, old);
  const result = reconcileLodDerivativeStorage(c.processing, c.storage, { graceMs: 24 * 3600_000 });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(stale), false);
});

test('derivative storage reconciliation advances past terminal jobs without token directories', (t) => {
  const { reconcileLodDerivativeStorage } = require('../server/lodDerivativeStorage');
  const c = fixture(t);
  const firstAttempt = readyAttempt(c.processing, 'Cleanup cursor first');
  const secondAttempt = readyAttempt(c.processing, 'Cleanup cursor second');
  c.processing.enqueueDerivative(firstAttempt.id, 'mesh_tiles', { optional: true });
  c.processing.enqueueDerivative(secondAttempt.id, 'mesh_tiles', { optional: true });
  const first = c.processing.claimDerivative('cleanup-cursor-first');
  assert.equal(c.processing.failOptionalDerivative(first.id, 'cleanup-cursor-first', 'fixture', 'derivative_failed', first.lease_token), true);
  const second = c.processing.claimDerivative('cleanup-cursor-second');
  assert.equal(c.processing.failOptionalDerivative(second.id, 'cleanup-cursor-second', 'fixture', 'derivative_failed', second.lease_token), true);
  c.db.prepare("UPDATE derivative_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(first.id);
  c.db.prepare("UPDATE derivative_jobs SET updated_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(second.id);
  const secondClaimAttempt = c.processing.getAttempt(second.attempt_id);
  const base = path.join(c.storage.roots.models, secondClaimAttempt.taskId, second.attempt_id);
  const stale = path.join(base, `tiles-ktx2-etc1s-${second.id}.${second.lease_token}.incomplete`);
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(stale, old, old);

  assert.deepEqual(reconcileLodDerivativeStorage(c.processing, c.storage, { graceMs: 24 * 3600_000, limit: 1 }), { scanned: 0, removed: 0 });
  assert.equal(reconcileLodDerivativeStorage(c.processing, c.storage, { graceMs: 24 * 3600_000, limit: 1 }).removed, 1);
  assert.equal(fs.existsSync(stale), false);
});

test('LOD cleanup never follows a model-attempt symlink outside managed storage', (t) => {
  const { reconcileLodDerivativeStorage } = require('../server/lodDerivativeStorage');
  const c = fixture(t);
  const attempt = readyAttempt(c.processing, 'Cleanup symlink fence');
  c.processing.enqueueDerivative(attempt.id, 'mesh_tiles', { optional: true });
  const claimed = c.processing.claimDerivative('cleanup-symlink-worker');
  assert.equal(c.processing.failOptionalDerivative(claimed.id, 'cleanup-symlink-worker', 'fixture', 'derivative_failed', claimed.lease_token), true);
  const base = path.join(c.storage.roots.models, attempt.taskId, attempt.id);
  const outside = path.join(c.root, 'outside-cleanup-target');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, base, 'dir');
  const stale = path.join(outside, `tiles-ktx2-etc1s-${claimed.id}.${claimed.lease_token}.incomplete`);
  fs.mkdirSync(stale);
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(stale, old, old);

  assert.deepEqual(reconcileLodDerivativeStorage(c.processing, c.storage, { graceMs: 24 * 3600_000 }), { scanned: 0, removed: 0 });
  assert.equal(fs.existsSync(stale), true);
});

test('LOD generation rejects an existing model-attempt symlink before touching sources', async (t) => {
  const c = fixture(t);
  const taskId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const base = path.join(c.storage.roots.models, taskId, attemptId);
  const other = path.join(c.storage.roots.models, crypto.randomUUID());
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.mkdirSync(other);
  fs.symlinkSync(other, base, 'dir');

  await assert.rejects(generateMeshTiles({
    processing: {}, storage: c.storage,
    config: { meshDerivativesEnabled: true },
    attempt: { id: attemptId, resultModelVersionId: crypto.randomUUID() },
    job: { id: crypto.randomUUID(), lease_token: 'a'.repeat(32), deadline_at: new Date(Date.now() + 60_000).toISOString() },
    owner: 'symlink-test-worker', task: { id: taskId },
    obj: { root_key: 'datasets', relative_path: 'missing.obj' },
    glb: { root_key: 'datasets', relative_path: 'missing.glb' },
    audit: 'unused', signal: new AbortController().signal,
  }), (error) => error.code === 'invalid_storage_location');
});

test('derivative storage admission fails closed without inode evidence', (t) => {
  const c = fixture(t);
  c.storage.space = (_root, required) => ({
    available: 100 * 1024 ** 3,
    total: 200 * 1024 ** 3,
    reserve: 0,
    required,
    ok: true,
    files: null,
    ffree: null,
  });
  assert.throws(
    () => c.storage.requireDerivativeSpace('models', { sourceBytes: 1024, expectedFiles: 100 }),
    (error) => error.code === 'insufficient_storage' && /inode/i.test(error.message),
  );
});

test('derivative storage admission includes source expansion and inode reserve', (t) => {
  const c = fixture(t);
  c.storage.space = (_root, required) => ({
    available: 100 * 1024 ** 3,
    total: 200 * 1024 ** 3,
    reserve: 20 * 1024 ** 3,
    required,
    ok: true,
    files: 1_000_000,
    ffree: 500_000,
  });
  const admitted = c.storage.requireDerivativeSpace('models', { sourceBytes: 1024 ** 3, expectedFiles: 10_000 });
  assert.equal(admitted.required, 5 * 1024 ** 3);
  assert.equal(admitted.expectedFiles, 10_000);
  assert.ok(admitted.inodeReserve >= 10_000);
  const reserved=c.storage.requireDerivativeSpace('models',{sourceBytes:1024**3,expectedFiles:10_000,reservedBytes:8*1024**3,otherReservedBytes:2*1024**3,reservedDatasetBytes:[1024**3]});
  assert.equal(reserved.required,14*1024**3);
});
