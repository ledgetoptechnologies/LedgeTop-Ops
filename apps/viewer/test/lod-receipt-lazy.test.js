'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { toViewerConfig } = require('../server/apiV1');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lazy-receipt-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, repository: new ViewerRepository(database), processing: new ProcessingRepository(database) };
}

// Records every statement the repositories compile from here on.
function statementSpy(database) {
  const original = database.prepare, seen = [];
  database.prepare = function (sql, ...rest) { seen.push(String(sql)); return original.call(this, sql, ...rest); };
  return { seen, receiptQueries: () => seen.filter((sql) => /audit_events/.test(sql)).length, restore: () => { database.prepare = original; } };
}

// The eager query this change replaces, kept verbatim as the reference.
const PREVIOUS_QUERY = `SELECT e.id,e.entity_id,e.details_json,e.created_at
      FROM audit_events e
      JOIN derivative_jobs j ON j.id=e.entity_id
      JOIN processing_attempts a ON a.id=j.attempt_id
      WHERE e.action='derivative.tiles_verified'
        AND e.entity_type='derivative_job'
        AND e.actor_type='system'
        AND e.actor_id IS NULL
        AND j.derivative_type IN ('lod_audit','mesh_tiles')
        AND j.status='complete'
        AND j.completed_at IS NOT NULL
        AND json_valid(j.result_json)
        AND json_extract(j.result_json,'$.verified')=1
        AND a.result_model_version_id=?
        AND json_valid(e.details_json)
        AND json_extract(e.details_json,'$.versionId')=?
        AND json_extract(e.details_json,'$.attemptId')=j.attempt_id
        AND (json_type(e.details_json,'$.receiptVersion') IS NULL
          OR json_extract(e.details_json,'$.leaseToken')=j.lease_token)
        AND e.created_at>=j.created_at
        AND e.created_at<=j.completed_at
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1`;
function previousReceipt(database, versionId) {
  const row = database.prepare(PREVIOUS_QUERY).get(versionId, versionId);
  return row ? { eventId: row.id, derivativeJobId: row.entity_id, details: JSON.parse(row.details_json), verifiedAt: row.created_at } : null;
}

const stamp = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function insertAttempt(database, id, versionId, number) {
  database.prepare(`INSERT INTO processing_attempts(id,task_id,attempt_number,options_json,status,created_at,updated_at,result_model_version_id)
    VALUES (?,?,?,'{}','published',?,?,?)`).run(id, 'task', number, stamp(0), stamp(0), versionId);
}
function insertJob(database, { id, attemptId, type = 'lod_audit', status = 'complete', result = '{"verified":true}', lease = 'lease', createdAt = stamp(10), completedAt = stamp(20) }) {
  database.prepare(`INSERT INTO derivative_jobs(id,attempt_id,derivative_type,status,result_json,lease_token,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, attemptId, type, status, result, lease, createdAt, createdAt, completedAt);
}
function insertEvent(database, { id, jobId, action = 'derivative.tiles_verified', entityType = 'derivative_job', actorType = 'system', actorId = null, details, createdAt = stamp(15) }) {
  database.prepare(`INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, actorType, actorId, action, entityType, jobId, typeof details === 'string' ? details : JSON.stringify(details), createdAt);
}
const clear = (database) => database.exec('DELETE FROM audit_events; DELETE FROM derivative_jobs; DELETE FROM processing_attempts');

test('the rewritten receipt query returns exactly the previous row for each individual condition', (t) => {
  const { database, repository } = fixture(t);
  database.exec('PRAGMA foreign_keys=OFF');
  const good = { receiptVersion: 1, leaseToken: 'lease', versionId: 'version', attemptId: 'attempt' };
  const cases = [
    ['exact receipt', {}, {}, 'present'],
    ['legacy receipt without a lease', {}, { details: { versionId: 'version', attemptId: 'attempt' } }, 'present'],
    ['mesh tiles job', { type: 'mesh_tiles' }, {}, 'present'],
    ['window start', {}, { createdAt: stamp(10) }, 'present'],
    ['window end', {}, { createdAt: stamp(20) }, 'present'],
    ['before the job', {}, { createdAt: stamp(9) }],
    ['after completion', {}, { createdAt: stamp(21) }],
    ['other job type', { type: 'ept' }, {}],
    ['job not complete', { status: 'failed' }, {}],
    ['job without completion time', { completedAt: null }, {}],
    ['job not verified', { result: '{"verified":false}' }, {}],
    ['job result is not JSON', { result: 'not json' }, {}],
    ['other lease', { lease: 'other' }, {}],
    ['other action', {}, { action: 'derivative.completed' }],
    ['other entity type', {}, { entityType: 'model' }],
    ['not a system event', {}, { actorType: 'service' }],
    ['named actor', {}, { actorId: 'someone' }],
    ['other version in details', {}, { details: { ...good, versionId: 'other' } }],
    ['other attempt in details', {}, { details: { ...good, attemptId: 'other' } }],
    ['details are not JSON', {}, { details: 'not json' }],
    ['event for a job that does not exist', {}, { jobId: 'missing' }],
  ];
  for (const [label, job, event, expected] of cases) {
    clear(database);
    insertAttempt(database, 'attempt', 'version', 1);
    insertJob(database, { id: 'job', attemptId: 'attempt', ...job });
    insertEvent(database, { id: 'event', jobId: 'job', details: good, ...event });
    const before = previousReceipt(database, 'version'), after = repository.lodVerifierReceipt('version');
    assert.deepEqual(after, before, label);
    assert.equal(Boolean(after), expected === 'present', label);
    assert.equal(repository.lodVerifierReceipt('other-version'), null, label);
  }
  // Several qualifying events: newest wins, and the identifier breaks a tie.
  clear(database);
  insertAttempt(database, 'attempt', 'version', 1);
  insertAttempt(database, 'attempt-two', 'version', 2);
  insertJob(database, { id: 'job', attemptId: 'attempt' });
  insertJob(database, { id: 'job-two', attemptId: 'attempt-two' });
  insertEvent(database, { id: 'a', jobId: 'job', details: good, createdAt: stamp(12) });
  insertEvent(database, { id: 'b', jobId: 'job', details: good, createdAt: stamp(18) });
  insertEvent(database, { id: 'c', jobId: 'job-two', details: { ...good, attemptId: 'attempt-two' }, createdAt: stamp(18) });
  insertEvent(database, { id: 'd', jobId: 'job', details: good, createdAt: stamp(17) });
  assert.equal(repository.lodVerifierReceipt('version').eventId, 'c');
  assert.deepEqual(repository.lodVerifierReceipt('version'), previousReceipt(database, 'version'));
});

test('the rewritten receipt query matches the previous one over randomized histories', (t) => {
  const { database, repository } = fixture(t);
  database.exec('PRAGMA foreign_keys=OFF');
  let state = 20261123;
  const random = (n) => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return Math.floor(state / 65536) % n; };
  const pick = (values) => values[random(values.length)];
  let present = 0;
  for (let round = 0; round < 60; round += 1) {
    database.exec('BEGIN');
    clear(database);
    for (let a = 0; a < 6; a += 1) {
      insertAttempt(database, `attempt-${a}`, pick(['v0', 'v1', 'v2', null]), a + 1);
      for (const type of ['lod_audit', 'mesh_tiles', 'ept']) insertJob(database, {
        id: `job-${a}-${type}`, attemptId: `attempt-${a}`, type,
        status: pick(['complete', 'complete', 'complete', 'complete', 'failed']),
        result: pick(['{"verified":true}', '{"verified":true}', '{"verified":1}', '{"verified":false}', '{}', '[', '']),
        lease: pick(['l1', 'l2', null]), completedAt: pick([stamp(20), stamp(20), null]),
      });
    }
    for (let e = 0; e < 400; e += 1) {
      const attempt = random(6), details = { versionId: pick(['v0', 'v1', 'v2']), attemptId: `attempt-${pick([attempt, attempt, attempt, random(6)])}` };
      if (random(2)) Object.assign(details, { receiptVersion: 1, leaseToken: pick(['l1', 'l2']) });
      insertEvent(database, {
        id: `event-${String(random(1e6)).padStart(6, '0')}-${e}`, jobId: `job-${attempt}-${pick(['lod_audit', 'mesh_tiles', 'ept'])}`,
        details: random(12) ? details : '{"versionId"', action: pick(['derivative.tiles_verified', 'derivative.tiles_verified', 'derivative.completed']),
        entityType: pick(['derivative_job', 'derivative_job', 'derivative_job', 'model']), actorType: pick(['system', 'system', 'service']), actorId: pick([null, null, 'x']),
        createdAt: stamp(8 + random(14)),
      });
    }
    database.exec('COMMIT');
    for (const version of ['v0', 'v1', 'v2', 'absent']) {
      const before = previousReceipt(database, version);
      assert.deepEqual(repository.lodVerifierReceipt(version), before, `round ${round} ${version}`);
      if (before) present += 1;
    }
  }
  assert.ok(present > 40, `randomized histories must include real receipts (${present})`);
});

test('a model reads its receipt once, on first use, with the same data and the same visibility', (t) => {
  const { database, repository } = fixture(t);
  const model = repository.upsertModelVersion({ modelId: 'model', versionId: 'version', provider: 'webodm', providerModelId: 'p', providerVersionId: 'version', displayName: 'Model', status: 'ready', assets: [] });
  database.exec('PRAGMA foreign_keys=OFF');
  insertAttempt(database, 'attempt', 'version', 1);
  insertJob(database, { id: 'job', attemptId: 'attempt' });
  insertEvent(database, { id: 'event', jobId: 'job', details: { receiptVersion: 1, leaseToken: 'lease', versionId: 'version', attemptId: 'attempt' } });
  const expected = previousReceipt(database, 'version');
  assert.equal(expected.eventId, 'event');

  const spy = statementSpy(database);
  t.after(spy.restore);
  for (const load of [() => repository.getModel(model.id), () => repository.getModelVersion(model.id, 'version'), () => repository.listModels()[0]]) {
    const before = spy.receiptQueries(), loaded = load();
    assert.equal(spy.receiptQueries(), before, 'resolving a model does not read the receipt');
    assert.deepEqual(loaded.activeVersion.lodVerifierReceipt, expected);
    assert.equal(loaded.activeVersion.lodVerifierReceipt, loaded.activeVersion.lodVerifierReceipt, 'one receipt object per model');
    assert.equal(spy.receiptQueries(), before + 1);
    assert.equal(Object.keys(loaded.activeVersion).includes('lodVerifierReceipt'), false);
    assert.equal(JSON.stringify(loaded).includes('lodVerifierReceipt'), false);
    assert.throws(() => { loaded.activeVersion.lodVerifierReceipt = { forged: true }; }, TypeError);
    assert.throws(() => Object.defineProperty(loaded.activeVersion, 'lodVerifierReceipt', { value: null }), TypeError);
  }
  const before = spy.receiptQueries();
  toViewerConfig(repository.getModel(model.id));
  assert.equal(spy.receiptQueries(), before + 1, 'the Viewer configuration still reads the receipt');
  database.exec('DELETE FROM audit_events');
  const without = repository.getModel(model.id).activeVersion, queried = spy.receiptQueries();
  assert.equal(without.lodVerifierReceipt, null);
  assert.equal(without.lodVerifierReceipt, null);
  assert.equal(spy.receiptQueries(), queried + 1, 'an absent receipt is remembered too');
});

test('no asset delivery route runs the receipt query', async (t) => {
  const c = fixture(t), { database, repository, processing } = c;
  const root = path.join(c.root, 'assets');
  fs.mkdirSync(path.join(root, 'tiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'model.glb'), 'mesh');
  fs.writeFileSync(path.join(root, 'tiles', 'tileset.json'), '{}');
  fs.writeFileSync(path.join(root, 'tiles', 'leaf.b3dm'), 'leaf');
  const project = processing.createProject({ displayName: 'Project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets', relativePath: 'source' });
  processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Task' });
  const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: 'lazy', createdBy: 'ops:test', staged: false });
  const model = repository.upsertModelVersion({
    modelId: 'model', versionId: 'version', provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: 'Model', status: 'ready',
    sourceLocator: { legacyAssetRoots: { fixture: root } },
    assets: [
      { kind: 'glb', rootKey: 'fixture', relativePath: 'model.glb', byteSize: 4, sha256: sha('mesh'), published: true },
      { kind: 'tiles', rootKey: 'fixture', relativePath: 'tiles/tileset.json', byteSize: 2, sha256: sha('{}'), manifestSha256: 'd'.repeat(64), manifestFiles: [
        { relativePath: 'leaf.b3dm', byteSize: 4, sha256: sha('leaf') }, { relativePath: 'tileset.json', byteSize: 2, sha256: sha('{}') }], published: true },
    ],
  });
  processing.setAttemptResult(attempt.id, model.id, 'version');
  processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
  processing.registerModelOutput({ versionId: 'version', modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: 'output', byteSize: 10, assetCount: 2 });

  const session = (token, extra = {}) => repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId: model.id, modelVersionId: 'version', subject: 's', audience: 'ops',
    permissions: { view: true, download: true, cameras: true }, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra });
  session('published-session');
  session('review-session', { sessionMode: 'review', reviewAttemptId: attempt.id });
  const publicShare = repository.createPublicShare({ modelId: model.id, publicIdHash: 'f'.repeat(64), permissions: { view: true, download: true } });
  const shareToken = auth.sign({ kind: 'share-asset', shareId: publicShare.id, shareRevision: publicShare.authorizationRevision || 0, modelId: model.id }, 60_000);
  const projectShare = repository.createProjectShare({ projectId: project.id, publicIdHash: 'e'.repeat(64), permissions: { view: true, download: true } });
  const projectToken = auth.sign({ kind: 'project-share-asset', shareId: projectShare.id, projectId: project.id, taskId: task.id, modelId: model.id, modelVersionId: 'version' }, 60_000);
  // The project share only needs the published selection, not a publication run.
  const selection = { projectId: project.id, taskId: task.id, modelId: model.id, modelVersionId: 'version' };
  assets.setRepository(repository);
  assets.setProcessingRepository({ getActivePublishedProjectTask: (projectId, taskId) => (projectId === project.id && taskId === task.id ? selection : null) });
  const app = express();
  app.use((req, _res, next) => { req.cookies = req.get('x-viewer') ? { ltds_viewer: req.get('x-viewer') } : {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); assets.setRepository(null); assets.setProcessingRepository(null); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const spy = statementSpy(database);
  t.after(spy.restore);
  const get = async (url, headers) => { const response = await fetch(base + url, { headers }); return { status: response.status, body: await response.text() }; };
  for (const token of ['published-session', 'review-session', shareToken, projectToken]) {
    assert.deepEqual(await get(`/session-assets/${token}/model/fixture/tiles/leaf.b3dm`), { status: 200, body: 'leaf' }, token);
    assert.deepEqual(await get(`/session-assets/${token}/model/fixture/tiles/leaf.b3dm`, { range: 'bytes=1-2' }), { status: 206, body: 'ea' }, token);
    assert.equal((await get(`/session-assets/${token}/model/fixture/missing.bin`)).status, 404);
    await get(`/session-camera-photos/${token}/model/photo.jpg`);
    assert.equal((await get(`/session-products/${token}/model`)).status, 200, token);
  }
  assert.deepEqual(await get('/assets/model/fixture/model.glb', { 'x-viewer': 'published-session' }), { status: 200, body: 'mesh' });
  assert.equal((await get('/session-assets/unknown/model/fixture/model.glb')).status, 403);
  assert.ok(spy.seen.some((sql) => /model_versions/.test(sql)), 'the spy observes delivery statements');
  assert.equal(spy.receiptQueries(), 0, 'asset delivery must not read the audit log');
});
