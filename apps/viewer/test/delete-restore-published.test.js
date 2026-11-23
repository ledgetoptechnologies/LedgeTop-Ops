'use strict';

// Deleting and restoring a task with a published output, through the staff
// routes, the real database and real storage (Linux, as the lifecycle tests).

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
const { createProjectShareApi } = require('../server/projectShareApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { purgeExpiredTrash, reconcileStorageMutations } = require('../server/storageLifecycle');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delete-restore-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'), datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0,
  };
  for (const location of Object.values(config).filter((value) => typeof value === 'string')) fs.mkdirSync(location, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database), storage = new StorageManager(config);
  storage.initialize();
  const token = 'delete-restore-admin-token-000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:test', displayUnits: 'imperial',
    permissions: ['viewer.projects.write', 'viewer.datasets.write', 'viewer.processing.read', 'viewer.processing.write', 'viewer.processing.publish', 'viewer.storage.purge'],
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProjectShareApi({ repository, processing }));
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  async function request(method, route, body = {}) {
    const response = await fetch(base + route, { method, body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `delete-restore-${sequence += 1}` } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  function photos(project, name = 'Photos') {
    const relativePath = crypto.randomUUID(), directory = path.join(config.datasetsMount, relativePath), body = Buffer.from(`${name} photo`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'photo.jpg'), body);
    const dataset = processing.createDataset({ projectId: project.id, displayName: name, storageMode: 'managed', rootKey: 'datasets', relativePath });
    processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: body.length, sha256: digest(body), processingRole: 'image' }], digest(body));
    return { ...processing.getDataset(dataset.id), directory };
  }
  // A reviewed output with its own files and records. earlier: an older,
  // unpublished output of the same task.
  function output(task, name, { earlier = false } = {}) {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const relativeRoot = `${task.id}/${attempt.id}`, directory = path.join(config.modelsMount, ...relativeRoot.split('/')), files = { 'model.glb': `${name} mesh`, 'ortho.tif': `${name} ortho`, 'photo.jpg': `${name} camera photo`, 'shots.geojson': '{}' };
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), body);
    const asset = (kind, file) => ({ kind, rootKey: 'models', relativePath: `${relativeRoot}/${file}`, format: file.split('.')[1], byteSize: files[file].length, sha256: digest(files[file]), published: false });
    const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'ready',
      sourceLocator: { taskId: task.id, attemptId: attempt.id }, georef: { utmZone: 16, hemisphere: 'N' }, metadata: { note: name }, makeActive: false,
      assets: [asset('glb', 'model.glb'), asset('ortho', 'ortho.tif'), asset('shots', 'shots.geojson')],
      cameraPhotos: [{ filename: 'photo.jpg', rootKey: 'models', relativePath: `${relativeRoot}/photo.jpg`, contentType: 'image/jpeg', byteSize: files['photo.jpg'].length, sha256: digest(files['photo.jpg']) }] });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, attempt.id).id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.transitionAttempt(attempt.id, earlier ? 'failed' : 'ready_for_review', { progress: 1 });
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: task.projectId, relativePath: relativeRoot, byteSize: 10, assetCount: 3 });
    if (earlier) database.prepare("UPDATE model_outputs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(versionId);
    return { attempt, modelId: model.id, versionId, directory };
  }
  async function publishedTask(project, name = 'Published', { dataset = photos(project, `${name} photos`), earlier = false } = {}) {
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: name });
    const older = earlier ? output(task, `${name} older`, { earlier: true }) : null;
    const current = output(task, name);
    const published = await request('POST', `/api/v1/attempts/${current.attempt.id}/publish`, { selectedAssetKinds: ['glb', 'ortho', 'shots'] });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    return { task, dataset, older, ...current };
  }
  const link = (project) => {
    const { token: raw, tokenHash } = auth.newShareToken();
    repository.createProjectShare({ projectId: project.id, publicIdHash: tokenHash, permissions: { view: true, measure: true } });
    return raw;
  };
  const listed = async (raw) => (await (await fetch(`${base}/api/project-share/${raw}`)).json()).tasks.map((item) => item.id);
  const tree = (directory) => (fs.existsSync(directory) ? Object.fromEntries(fs.readdirSync(directory).sort().map((file) => [file, fs.readFileSync(path.join(directory, file), 'utf8')])) : null);
  const bin = (item) => processing.activeTrashForEntity('task', item.task.id);
  const remove = (item) => request('DELETE', `/api/v1/tasks/${item.task.id}`);
  const restore = (item) => request('POST', `/api/v1/storage/trash/${bin(item).id}/restore`);
  // Everything a delete and restore must not lose: files, and every record of
  // the task, its photos, attempts, outputs, models, versions and assets. What
  // is compared leaves out only timestamps and what "unpublished" means.
  function snapshot(item) {
    const rows = (sql, ...values) => database.prepare(sql).all(...values).map(({ updated_at, created_at, archived_at, trashed_at, completed_at, unregistered_at, ...row }) => row);
    const without = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
    return {
      files: [tree(item.dataset.directory), tree(item.directory), item.older && tree(item.older.directory)],
      task: rows('SELECT * FROM processing_tasks WHERE id=?', item.task.id).map((row) => without(row, 'status', 'published_model_id')),
      dataset: rows('SELECT * FROM datasets WHERE id=?', item.dataset.id),
      datasetFiles: rows('SELECT * FROM dataset_files WHERE dataset_id=?', item.dataset.id),
      attempts: rows('SELECT * FROM processing_attempts WHERE task_id=? ORDER BY id', item.task.id).map((row) => without(row, 'status')),
      outputs: rows('SELECT * FROM model_outputs WHERE task_id=? ORDER BY id', item.task.id).map((row) => without(row, 'status')),
      models: rows('SELECT * FROM models WHERE id=?', item.modelId).map((row) => without(row, 'status', 'active_version_id')),
      versions: rows('SELECT * FROM model_versions WHERE model_id=? ORDER BY id', item.modelId),
      assets: rows('SELECT a.* FROM model_assets a JOIN model_versions v ON v.id=a.version_id WHERE v.model_id=? ORDER BY a.id', item.modelId).map((row) => without(row, 'published')),
      cameras: rows('SELECT c.* FROM model_camera_photos c JOIN model_versions v ON v.id=c.version_id WHERE v.model_id=? ORDER BY c.version_id,c.filename', item.modelId),
    };
  }
  function state(item) {
    const task = processing.getTask(item.task.id), model = database.prepare('SELECT status,active_version_id FROM models WHERE id=?').get(item.modelId);
    return { task: task.status, attempt: processing.getAttempt(item.attempt.id).status, active: task.activeAttemptId === item.attempt.id, publishedModel: task.publishedModelId, output: processing.getModelOutput(item.versionId).status,
      dataset: processing.getDataset(item.dataset.id).status, model: model.status, activeVersion: model.active_version_id, publishedAssets: database.prepare('SELECT COUNT(*) n FROM model_assets WHERE version_id=? AND published=1').get(item.versionId).n, bin: Boolean(bin(item)) };
  }
  const IN_REVIEW = { task: 'ready_for_review', attempt: 'ready_for_review', active: true, publishedModel: null, output: 'ready', dataset: 'finalized', model: 'unregistered', activeVersion: null, publishedAssets: 0, bin: false };
  const DELETED = { task: 'archived', attempt: 'published', active: true, publishedModel: null, output: 'trashed', dataset: 'trashed', model: 'unregistered', activeVersion: null, publishedAssets: 0, bin: true };
  async function publishAgain(item) {
    const published = await request('POST', `/api/v1/attempts/${item.attempt.id}/publish`, { selectedAssetKinds: ['glb', 'ortho', 'shots'] });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.deepEqual(state(item), { task: 'published', attempt: 'published', active: true, publishedModel: item.modelId, output: 'published', dataset: 'finalized', model: 'ready', activeVersion: item.versionId, publishedAssets: 3, bin: false });
  }
  return { root, config, database, repository, processing, storage, base, request, photos, output, publishedTask, link, listed, tree, bin, remove, restore, snapshot, state, IN_REVIEW, DELETED, publishAgain };
}

test('a published task that is the only user of its photos can be deleted, restored without loss, and published again', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), raw = f.link(project), item = await f.publishedTask(project, 'Published', { earlier: true });
  const single = auth.newShareToken(), session = 'delete-restore-client-session-token';
  f.repository.createPublicShare({ modelId: item.modelId, publicIdHash: single.tokenHash, permissions: { view: true } });
  f.repository.createViewerSession({ tokenHash: auth.hashToken(session), modelId: item.modelId, modelVersionId: item.versionId, subject: 'client:one', audience: 'client', permissions: { view: true }, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  assert.deepEqual(await f.listed(raw), [item.task.id]);
  const before = f.snapshot(item);
  for (let round = 0; round < 2; round += 1) {
    const removed = await f.remove(item);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(f.state(item), f.DELETED);
    assert.equal(fs.existsSync(item.dataset.directory) || fs.existsSync(item.directory) || fs.existsSync(item.older.directory), false);
    assert.deepEqual(f.processing.listContainerTrashMembers(f.bin(item).id).map((member) => member.entityType).sort(), ['dataset', 'output', 'output']);
    const restored = await f.restore(item);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.task.status, 'ready_for_review');
    assert.deepEqual(f.state(item), f.IN_REVIEW);
    assert.deepEqual(f.snapshot(item), before);
    assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'ready');
    // Nothing is shared again by restoring.
    assert.deepEqual(await f.listed(raw), []);
    assert.equal(f.repository.publicShareLive(f.repository.getPublicShareByHash(single.tokenHash)), false);
    assert.equal(f.repository.viewerSessionLive(f.repository.getViewerSessionByHash(auth.hashToken(session))), false);
    // Publishing is a separate, deliberate step, and only that shows it again.
    await f.publishAgain(item);
    assert.deepEqual(await f.listed(raw), [item.task.id]);
    assert.equal(f.repository.publicShareLive(f.repository.getPublicShareByHash(single.tokenHash)), false);
  }
});

test('an output deleted and restored on its own can be published again', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project), before = f.snapshot(item);
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${item.versionId}`)).status, 200);
  assert.equal(f.state(item).task, 'draft');
  const trash = f.processing.activeTrashForEntity('output', item.versionId);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`)).status, 200);
  assert.deepEqual(f.state(item), f.IN_REVIEW);
  assert.deepEqual(f.snapshot(item), before);
  await f.publishAgain(item);
});

test('an output restored before its task, and a task that has moved on, keep what they have', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  const item = await f.publishedTask(project, 'In the bin'), before = f.snapshot(item);
  assert.equal((await f.remove(item)).status, 200);
  const trash = f.processing.activeTrashForEntity('output', item.versionId);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`)).status, 200);
  assert.equal(f.state(item).task, 'archived', 'the task stays in the bin');
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual(f.state(item), f.IN_REVIEW);
  assert.deepEqual(f.snapshot(item), before);

  // A newer run started after the output was deleted keeps the task.
  const moved = await f.publishedTask(project, 'Moved on');
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${moved.versionId}`)).status, 200);
  const newer = f.output(f.processing.getTask(moved.task.id), 'Newer'), old = f.processing.activeTrashForEntity('output', moved.versionId);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${old.id}/restore`)).status, 200);
  assert.equal(f.processing.getTask(moved.task.id).activeAttemptId, newer.attempt.id);
  assert.equal(f.processing.getTask(moved.task.id).status, 'ready_for_review');
  assert.equal(f.processing.getAttempt(moved.attempt.id).status, 'published', 'the superseded attempt is untouched');
});

test('a project with published tasks is deleted and restored without loss', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), raw = f.link(project), shared = f.photos(project, 'Shared');
  const items = [await f.publishedTask(project, 'Own photos'), await f.publishedTask(project, 'Shares photos', { dataset: shared }), await f.publishedTask(project, 'Shares them too', { dataset: shared })];
  const before = items.map(f.snapshot);
  const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  for (const item of items) assert.deepEqual(f.state(item), f.DELETED);
  const restored = await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  for (const [index, item] of items.entries()) {
    assert.deepEqual(f.state(item), f.IN_REVIEW);
    assert.deepEqual(f.snapshot(item), before[index]);
  }
  assert.equal((await fetch(`${f.base}/api/project-share/${raw}`)).status, 410, 'project links stay revoked');
  await f.publishAgain(items[0]);
});

// What an earlier version left: the delete took the output down, set the task
// back to draft, and stopped (409) before the photos.
async function leftByEarlierVersion(f, project, name) {
  const item = await f.publishedTask(project, name), before = f.snapshot(item);
  const trash = f.processing.trashTask(item.task.id, 'ops:test');
  f.database.prepare("UPDATE processing_tasks SET status='published' WHERE id=?").run(item.task.id);
  const { trashOutput } = require('../server/containerLifecycle');
  assert.ok(f.processing.addContainerTrashMember(trash.id, trashOutput(f.processing, f.storage, item.versionId, 'ops:test').id));
  assert.deepEqual([f.state(item).task, f.state(item).output, f.state(item).dataset, f.state(item).bin], ['draft', 'trashed', 'finalized', true], 'the case under test');
  return { item, before, trash };
}

test('a task an earlier version left half deleted can be restored, or deleted properly, and is never purged meanwhile', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  for (const deleteAgain of [false, true]) {
    const { item, before, trash } = await leftByEarlierVersion(f, project, `Left ${deleteAgain}`);
    // Neither emptying the bin nor expiry removes its files.
    assert.equal((await f.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: item.task.id })).status, 409);
    f.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), trash.id);
    assert.deepEqual(purgeExpiredTrash(f.processing, f.storage).map((result) => result.status), ['failed']);
    assert.equal(f.processing.getTrash(trash.id).purgeStartedAt ?? null, null);
    if (deleteAgain) {
      const removed = await f.remove(item);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.deepEqual(f.state(item), { ...f.DELETED, active: false });
    }
    const restored = await f.restore(item);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(f.state(item), f.IN_REVIEW);
    assert.deepEqual(f.snapshot(item), before);
    await f.publishAgain(item);
  }
});

test('deleting a half-deleted task again also revokes access issued in between, and waits for running work', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item } = await leftByEarlierVersion(f, project, 'Left');
  const now = new Date().toISOString(), later = new Date(Date.now() + 600_000).toISOString();
  f.database.prepare("INSERT INTO public_shares(id,model_id,version_policy,public_id_hash,permissions_json,created_at,updated_at) VALUES ('late',?,'latest',?,'{}',?,?)").run(item.modelId, 'e'.repeat(64), now, now);
  f.database.prepare("INSERT INTO viewer_sessions(id,token_hash,model_id,model_version_id,subject,audience,permissions_json,display_units,expires_at,created_at,updated_at) VALUES ('late',?,?,?,'client:one','client','{}','imperial',?,?,?)").run('f'.repeat(64), item.modelId, item.versionId, later, now, now);
  const attempt = f.processing.createAttempt({ taskId: item.task.id, providerId: f.database.prepare('SELECT id FROM processing_providers').get().id, options: {}, createdBy: 'ops:test' });
  assert.equal((await f.remove(item)).status, 409, 'running work');
  assert.equal(f.repository.getPublicShare('late').revokedAt, null);
  f.processing.cancelAttempt(attempt.id, 'ops:test');
  assert.equal((await f.remove(item)).status, 200);
  assert.ok(f.repository.getPublicShare('late').revokedAt);
  assert.ok(f.database.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='late'").get().revoked_at);
});

test('a move interrupted by a storage error: nothing is lost whether the task is restored or deleted again', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), moveExact = f.storage.moveExact;
  for (const kind of ['models', 'datasets']) {
    for (const deleteAgain of [false, true]) {
      const note = `${kind} ${deleteAgain}`, item = await f.publishedTask(project, note, { earlier: true }), before = f.snapshot(item);
      let failed = false;
      f.storage.moveExact = function move(source, ...rest) {
        if (!failed && source === kind) { failed = true; throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' }); }
        return moveExact.call(this, source, ...rest);
      };
      assert.equal((await f.remove(item)).status, 409, note);
      f.storage.moveExact = moveExact;
      assert.ok(f.bin(item), note);
      // The move is still pending: restoring waits for it.
      assert.equal((await f.restore(item)).status, 409, note);
      assert.equal(f.processing.getTask(item.task.id).status, 'archived', note);
      assert.deepEqual(reconcileStorageMutations(f.processing, f.storage).map((result) => result.status), ['complete'], note);
      if (deleteAgain) {
        const removed = await f.remove(item);
        assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
        assert.deepEqual(f.processing.listContainerTrashMembers(f.bin(item).id).map((member) => member.entityType).sort(), ['dataset', 'output', 'output'], note);
        assert.deepEqual(f.state(item), f.DELETED, note);
      }
      const restored = await f.restore(item);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      const { task, output, dataset, bin } = f.state(item);
      assert.equal(output === 'published' ? 'published' : 'ready_for_review', task, note);
      assert.deepEqual([dataset, bin], ['finalized', false], note);
      assert.deepEqual(f.snapshot(item), before, note);
      assert.equal(['ready', 'published'].includes(output), true, note);
      if (output === 'ready') await f.publishAgain(item);
    }
  }
});

test('a move that failed for good: the output keeps its status when the task is restored or deleted again, and is never moved later', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), moveExact = f.storage.moveExact;
  for (const deleteAgain of [false, true]) {
    const note = `again ${deleteAgain}`, item = await f.publishedTask(project, note), before = f.snapshot(item);
    let failed = false;
    f.storage.moveExact = function move(source, ...rest) {
      if (!failed && source === 'models') { failed = true; throw Object.assign(new Error('synthetic conflict'), { code: 'lifecycle_conflict' }); }
      return moveExact.call(this, source, ...rest);
    };
    assert.equal((await f.remove(item)).status, 409, note);
    f.storage.moveExact = moveExact;
    assert.equal(f.processing.getModelOutput(item.versionId).status, 'archived', note);
    const mutation = f.database.prepare("SELECT id FROM storage_mutations WHERE entity_id=? AND status='failed'").get(item.versionId);
    if (deleteAgain) {
      assert.equal((await f.remove(item)).status, 200, note);
      assert.deepEqual(f.state(item), f.DELETED, note);
    }
    const restored = await f.restore(item);
    assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
    assert.deepEqual(f.state(item), f.IN_REVIEW, note);
    assert.deepEqual(f.snapshot(item), before, note);
    // The failed move can no longer be retried onto a live task.
    assert.equal((await f.request('POST', `/api/v1/storage/mutations/${mutation.id}/retry`)).status, 409, note);
    assert.deepEqual(f.snapshot(item), before, note);
    await f.publishAgain(item);
  }
});

test('photos whose move failed are not moved later, once the task is restored', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project), before = f.snapshot(item), moveExact = f.storage.moveExact;
  f.storage.moveExact = function move(source, ...rest) {
    if (source === 'datasets') throw Object.assign(new Error('synthetic conflict'), { code: 'lifecycle_conflict' });
    return moveExact.call(this, source, ...rest);
  };
  assert.equal((await f.remove(item)).status, 409);
  f.storage.moveExact = moveExact;
  const mutation = f.database.prepare("SELECT id FROM storage_mutations WHERE entity_id=? AND status='failed'").get(item.dataset.id);
  assert.equal((await f.restore(item)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/storage/mutations/${mutation.id}/retry`)).status, 409);
  assert.deepEqual(f.state(item), f.IN_REVIEW);
  assert.deepEqual(f.snapshot(item), before);
});

test('an output whose move is refused is left exactly as it was', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project), before = [f.state(item), f.snapshot(item)];
  f.database.prepare("UPDATE model_outputs SET root_key='webodm' WHERE id=?").run(item.versionId);
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${item.versionId}`)).status, 409);
  f.database.prepare("UPDATE model_outputs SET root_key='models' WHERE id=?").run(item.versionId);
  assert.deepEqual([f.state(item), f.snapshot(item)], before);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='output.archived'").get().n, 0);
});

test('an output the user deleted before the task stays deleted when the task is restored', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project, 'Task', { earlier: true });
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${item.older.versionId}`)).status, 200);
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal((await f.remove(item)).status, 200);
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual(f.state(item), f.IN_REVIEW);
  assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'trashed');
});

test('a task that was only archived stays archived when its output is archived', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project);
  assert.equal((await f.request('POST', `/api/v1/tasks/${item.task.id}/archive`)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/processing/outputs/${item.versionId}/archive`)).status, 200);
  assert.equal(f.state(item).task, 'archived');
  assert.equal(f.state(item).bin, false);
});

test('a properly deleted published task is purged with its files, once, when its time is up', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project);
  assert.equal((await f.remove(item)).status, 200);
  const trash = f.bin(item), binned = () => fs.readdirSync(f.config.trashMount, { recursive: true }).filter((name) => /photo\.jpg|model\.glb/.test(String(name))).length;
  assert.ok(binned() >= 2);
  f.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), trash.id);
  assert.deepEqual(purgeExpiredTrash(f.processing, f.storage).map((result) => result.status), ['complete']);
  assert.equal(binned(), 0);
  assert.equal(f.processing.getTask(item.task.id), null);
});

test('restoring a task does not undo an output delete that failed before the task was deleted', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project, 'Task', { earlier: true }), moveExact = f.storage.moveExact;
  f.storage.moveExact = () => { throw Object.assign(new Error('synthetic conflict'), { code: 'lifecycle_conflict' }); };
  await f.request('DELETE', `/api/v1/processing/outputs/${item.older.versionId}`).catch(() => {}); // not a JSON error on this route
  f.storage.moveExact = moveExact;
  assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'archived');
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(f.processing.trashTask(item.task.id, 'ops:test'));
  assert.equal((await f.restore(item)).status, 200);
  assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'archived');
});

// Publishes a newer run of the task's model; the older output keeps its
// published status, as publishing does.
async function publishNewer(f, item, name = 'Newer') {
  const newer = f.output(f.processing.getTask(item.task.id), name);
  const published = await f.request('POST', `/api/v1/attempts/${newer.attempt.id}/publish`, { selectedAssetKinds: ['glb', 'ortho', 'shots'] });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(f.processing.getModelOutput(item.versionId).status, 'published', 'the case under test');
  return { ...item, ...newer, older: item };
}
async function assertOnlyCurrentCanBePublished(f, item, note) {
  assert.deepEqual(f.state(item), f.IN_REVIEW, note);
  const old = await f.request('POST', `/api/v1/attempts/${item.older.attempt.id}/publish`, { selectedAssetKinds: ['glb', 'ortho', 'shots'] });
  assert.equal(old.status, 409, `${note}: the superseded model`);
  assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'ready', `${note}: kept`);
  await f.publishAgain(item);
}
// What an earlier version left of a republished task: both outputs in the bin,
// the task a draft that has lost track of its current output.
async function republishedLeftByEarlierVersion(f, project, name) {
  const item = await publishNewer(f, await f.publishedTask(project, name)), before = f.snapshot(item);
  const trash = f.processing.trashTask(item.task.id, 'ops:test'), { trashOutput } = require('../server/containerLifecycle');
  for (const versionId of [item.older.versionId, item.versionId]) assert.ok(f.processing.addContainerTrashMember(trash.id, trashOutput(f.processing, f.storage, versionId, 'ops:test').id));
  f.database.prepare("UPDATE processing_tasks SET status='draft',active_attempt_id=NULL,published_model_id=NULL WHERE id=?").run(item.task.id);
  return { item, before, trash };
}
// Makes a Recycle Bin item, and what is in it, look as old as given.
function age(f, trash, days) {
  const at = (offset) => new Date(Date.now() - (days - offset) * 86400_000).toISOString();
  f.database.prepare('UPDATE storage_trash SET created_at=?,purge_after=? WHERE id=? OR id IN (SELECT member_trash_id FROM container_trash_members WHERE container_trash_id=?)').run(at(0), at(30), trash.id, trash.id);
}
function assertFullWindow(f, trash, note) {
  for (const item of [f.processing.getTrash(trash.id), ...f.processing.listContainerTrashMembers(trash.id).filter((member) => !member.permanentlyDeletedAt)])
    assert.ok(Date.parse(item.purgeAfter) > Date.now() + 29 * 86400_000, `${note} ${item.entityType} ${item.purgeAfter}`);
}
const pause = () => new Promise((resolve) => { setTimeout(resolve, 5); });

test('a republished task comes back with its current output, never the one it replaced', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  for (const way of ['task', 'output first', 'old output first', 'old output only']) {
    const item = await publishNewer(f, await f.publishedTask(project, way)), before = f.snapshot(item);
    assert.equal((await f.remove(item)).status, 200, way);
    const order = { 'output first': [item.versionId], 'old output first': [item.older.versionId, item.versionId], 'old output only': [item.older.versionId] }[way] || [];
    for (const versionId of order) {
      const trash = f.processing.activeTrashForEntity('output', versionId);
      assert.equal((await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`)).status, 200, way);
    }
    const restored = await f.restore(item);
    assert.equal(restored.status, 200, `${way} ${JSON.stringify(restored.body)}`);
    assert.deepEqual(f.snapshot(item), before, way);
    await assertOnlyCurrentCanBePublished(f, item, way);
  }
  const item = await publishNewer(f, await publishNewer(f, await f.publishedTask(project, 'Third')), 'Newest'), before = f.snapshot(item);
  const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`)).status, 200);
  assert.deepEqual(f.snapshot(item), before);
  await assertOnlyCurrentCanBePublished(f, item, 'project');
});

test('a republished task whose delete was interrupted, or that an earlier version half deleted, comes back with its current output', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), moveExact = f.storage.moveExact;
  for (const code of ['EIO', 'lifecycle_conflict']) {
    for (const failAt of [1, 2]) {
      const note = `${code} ${failAt}`, item = await publishNewer(f, await f.publishedTask(project, note)), before = f.snapshot(item);
      let moves = 0;
      f.storage.moveExact = function move(source, ...rest) {
        if (source === 'models' && (moves += 1) === failAt) throw Object.assign(new Error('synthetic'), { code });
        return moveExact.call(this, source, ...rest);
      };
      assert.equal((await f.remove(item)).status, 409, note);
      f.storage.moveExact = moveExact;
      reconcileStorageMutations(f.processing, f.storage);
      const restored = await f.restore(item);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      assert.deepEqual(f.snapshot(item), before, note);
      if (f.state(item).task === 'published') assert.equal(f.state(item).output, 'published', `${note}: never taken down`);
      else await assertOnlyCurrentCanBePublished(f, item, note);
    }
  }
  for (const way of ['restore', 'delete again', 'old output first', 'no record of what was live']) {
    const { item, before } = await republishedLeftByEarlierVersion(f, project, `Left ${way}`);
    if (way === 'no record of what was live') f.database.prepare("DELETE FROM audit_events WHERE action='output.archived'").run();
    if (way === 'delete again') assert.equal((await f.remove(item)).status, 200);
    if (way === 'old output first') assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.processing.activeTrashForEntity('output', item.older.versionId).id}/restore`)).status, 200);
    const restored = await f.restore(item);
    assert.equal(restored.status, 200, `${way} ${JSON.stringify(restored.body)}`);
    assert.deepEqual(f.snapshot(item), before, way);
    await assertOnlyCurrentCanBePublished(f, item, way);
  }
});

test('a published task with a later run keeps what was current', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  // The later run failed: the published model is what comes back to publish.
  const failed = await f.publishedTask(project, 'Later run failed'), run = f.processing.createAttempt({ taskId: failed.task.id, providerId: f.database.prepare('SELECT id FROM processing_providers').get().id, options: {}, createdBy: 'ops:test' });
  f.processing.transitionAttempt(run.id, 'failed', {});
  const before = f.snapshot(failed);
  before.task[0].active_attempt_id = failed.attempt.id;
  assert.equal((await f.remove(failed)).status, 200);
  assert.equal((await f.restore(failed)).status, 200);
  assert.deepEqual(f.snapshot(failed), before);
  assert.equal(f.processing.getAttempt(run.id).status, 'failed');
  assert.deepEqual(f.state(failed), f.IN_REVIEW);
  await f.publishAgain(failed);

  // The later run waits for review: it still does, and can be published.
  const first = await f.publishedTask(project, 'Later run in review'), review = { ...first, ...f.output(f.processing.getTask(first.task.id), 'In review'), older: first }, reviewBefore = f.snapshot(review);
  assert.equal((await f.remove(review)).status, 200);
  assert.equal((await f.restore(review)).status, 200);
  assert.deepEqual(f.snapshot(review), reviewBefore);
  await assertOnlyCurrentCanBePublished(f, review, 'in review');

  // The current output was deleted on its own first: nothing takes its place.
  const none = await publishNewer(f, await f.publishedTask(project, 'No current output'));
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${none.versionId}`)).status, 200);
  await pause();
  assert.equal((await f.remove(none)).status, 200);
  assert.equal((await f.restore(none)).status, 200);
  assert.deepEqual([f.state(none).task, f.processing.getTask(none.task.id).activeAttemptId, f.state(none).output], ['draft', null, 'trashed']);
  assert.equal(f.processing.getModelOutput(none.older.versionId).status, 'ready');
});

test('deleting a long half-deleted task again starts a new full recovery time for everything in it', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  for (const way of ['left as it was', 'reprocessed', 'reprocessed and published']) {
    const { item, trash } = await leftByEarlierVersion(f, project, way);
    age(f, trash, 45);
    let current = item;
    if (way !== 'left as it was') current = { ...item, ...f.output(f.processing.getTask(item.task.id), 'Reprocessed'), older: item };
    if (way === 'reprocessed and published') {
      // Publishing is refused while the bin item is open; an earlier version allowed it.
      f.database.prepare('UPDATE storage_trash SET permanently_deleted_at=? WHERE id=?').run(new Date().toISOString(), trash.id);
      assert.ok(f.processing.publishAttemptAtomic(current.attempt.id, ['glb', 'ortho', 'shots'], { actorId: 'ops:test' }));
      f.database.prepare('UPDATE storage_trash SET permanently_deleted_at=NULL WHERE id=?').run(trash.id);
    }
    const before = f.snapshot(current);
    const removed = await f.remove(current);
    assert.equal(removed.status, 200, `${way} ${JSON.stringify(removed.body)}`);
    assert.ok(Date.parse(removed.body.trash.purgeAfter) > Date.now() + 29 * 86400_000, way);
    assertFullWindow(f, trash, way);
    assert.deepEqual(f.processing.listContainerTrashMembers(trash.id).map((member) => member.entityType).sort(), way === 'left as it was' ? ['dataset', 'output'] : ['dataset', 'output', 'output'], way);
    // Maintenance right after the delete removes nothing.
    assert.deepEqual(purgeExpiredTrash(f.processing, f.storage), [], way);
    const restored = await f.restore(current);
    assert.equal(restored.status, 200, `${way} ${JSON.stringify(restored.body)}`);
    // Left as it was, the restore also gives the task its output back.
    if (way === 'left as it was') { before.task[0].active_attempt_id = item.attempt.id; before.files[1] = f.snapshot(current).files[1]; assert.ok(before.files[1]['model.glb']); before.models = f.snapshot(current).models; }
    else { before.files[2] = f.snapshot(current).files[2]; assert.ok(before.files[2]['model.glb']); }
    assert.deepEqual(f.snapshot(current), before, way);
    // A model that was reprocessed stays listed, with nothing active.
    assert.deepEqual(f.state(current), way === 'left as it was' || way === 'reprocessed and published' ? f.IN_REVIEW : { ...f.IN_REVIEW, model: 'ready' }, way);
    assert.deepEqual(purgeExpiredTrash(f.processing, f.storage), [], way);
    await f.publishAgain(current);
  }
});

test('deleting the project of a long half-deleted task, and a project again, starts a new full recovery time', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item, before, trash } = await leftByEarlierVersion(f, project, 'Left'), other = await f.publishedTask(project, 'Other'), otherBefore = f.snapshot(other);
  age(f, trash, 45);
  const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assertFullWindow(f, removed.body.trash, 'first');
  assert.deepEqual(purgeExpiredTrash(f.processing, f.storage), []);
  // A project delete that has to be repeated later.
  age(f, removed.body.trash, 45);
  const again = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assertFullWindow(f, again.body.trash, 'again');
  assert.deepEqual(purgeExpiredTrash(f.processing, f.storage), []);
  const restored = await f.request('POST', `/api/v1/storage/trash/${again.body.trash.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  for (const [task, snapshot] of [[item, before], [other, otherBefore]]) {
    assert.deepEqual(f.snapshot(task), snapshot);
    assert.deepEqual(f.state(task), f.IN_REVIEW);
  }
});

test('a restore interrupted by a storage error, then deleted and restored again, loses nothing', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), moveExact = f.storage.moveExact;
  for (const kind of ['datasets', 'models']) {
    for (const finishFirst of [true, false]) {
      const note = `${kind} ${finishFirst}`, item = await publishNewer(f, await f.publishedTask(project, note)), before = f.snapshot(item);
      assert.equal((await f.remove(item)).status, 200, note);
      const trash = f.bin(item);
      f.storage.moveExact = function move(source, sourcePath, destination, ...rest) {
        if (destination === kind) throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' });
        return moveExact.call(this, source, sourcePath, destination, ...rest);
      };
      await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`).catch(() => {}); // not a JSON error on this route
      f.storage.moveExact = moveExact;
      // Deleting waits while that restore is unfinished, and changes nothing.
      const half = [f.state(item), f.processing.listContainerTrashMembers(trash.id).map((member) => member.id)];
      assert.equal((await f.remove(item)).status, 409, note);
      assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409, note);
      assert.equal(f.processing.getProject(project.id).status, 'active', note);
      assert.deepEqual([f.state(item), f.processing.listContainerTrashMembers(trash.id).map((member) => member.id)], half, note);
      if (finishFirst) reconcileStorageMutations(f.processing, f.storage);
      else assert.equal((await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`)).status, 200, note);
      const removed = await f.remove(item);
      assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
      const members = f.processing.listContainerTrashMembers(f.bin(item).id).filter((member) => !member.permanentlyDeletedAt);
      assert.deepEqual(members.map((member) => member.entityType).sort(), ['dataset', 'output', 'output'], note);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM storage_trash s WHERE permanently_deleted_at IS NULL AND entity_type<>'task' AND NOT EXISTS(SELECT 1 FROM container_trash_members m WHERE m.member_trash_id=s.id AND m.container_trash_id=?)").get(f.bin(item).id).n, 0, `${note}: nothing outside the item`);
      const restored = await f.restore(item);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0, `${note}: the bin is empty`);
      f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z'").run();
      assert.deepEqual(purgeExpiredTrash(f.processing, f.storage), [], note);
      assert.deepEqual(f.snapshot(item), before, note);
      await assertOnlyCurrentCanBePublished(f, item, note);
    }
  }
});

test('a delete or restore that would leave an item behind is refused, not reported as done', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project), before = f.snapshot(item);
  f.database.exec("CREATE TRIGGER drop_member BEFORE INSERT ON container_trash_members WHEN NEW.entity_type='output' BEGIN SELECT RAISE(IGNORE); END");
  assert.equal((await f.remove(item)).status, 409);
  assert.equal((await f.restore(item)).status, 409);
  assert.equal(f.processing.getTask(item.task.id).status, 'archived');
  f.database.exec('DROP TRIGGER drop_member');
  assert.equal((await f.remove(item)).status, 200);
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual(f.snapshot(item), before);
  await f.publishAgain(item);
});

test('a task deleted on its own and then with its project comes back with the project, outputs included', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await publishNewer(f, await f.publishedTask(project)), before = f.snapshot(item);
  assert.equal((await f.remove(item)).status, 200);
  await pause();
  const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await f.remove(item)).status, 409, 'a task of a deleted project is not deleted on its own');
  const restored = await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(f.snapshot(item), before);
  await assertOnlyCurrentCanBePublished(f, item, 'project');
});

test('photos shared with another task: the same for a new delete and for one an earlier version left', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), dataset = f.photos(project, 'Shared');
  f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Sibling' });
  const item = await f.publishedTask(project, 'New delete', { dataset }), before = f.snapshot(item);
  assert.equal((await f.remove(item)).status, 200);
  assert.deepEqual(f.state(item), { ...f.DELETED, dataset: 'finalized' });
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual(f.snapshot(item), before);
  await f.publishAgain(item);

  // Earlier version: the delete answered 200 and looked complete.
  const left = await f.publishedTask(project, 'Left', { dataset }), leftBefore = f.snapshot(left), trash = f.processing.trashTask(left.task.id, 'ops:test'), { trashOutput } = require('../server/containerLifecycle');
  assert.ok(f.processing.addContainerTrashMember(trash.id, trashOutput(f.processing, f.storage, left.versionId, 'ops:test').id));
  f.database.prepare("UPDATE processing_tasks SET status='draft',active_attempt_id=NULL WHERE id=?").run(left.task.id);
  age(f, trash, 45);
  assert.deepEqual(purgeExpiredTrash(f.processing, f.storage).map((result) => result.status), ['failed']);
  assert.equal((await f.restore(left)).status, 200);
  assert.deepEqual(f.snapshot(left), leftBefore);
  assert.deepEqual(f.state(left), f.IN_REVIEW);
});

test('an item whose permanent deletion an earlier version began: staff are told, and nothing more is removed', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item, trash } = await leftByEarlierVersion(f, project, 'Left');
  const current = { ...item, ...f.output(f.processing.getTask(item.task.id), 'Reprocessed'), older: item };
  f.database.prepare("UPDATE storage_trash SET purge_started_at='2020-01-01T00:00:00.000Z',purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(trash.id);
  const now = () => [f.state(current), f.snapshot(current), f.database.prepare('SELECT * FROM storage_trash ORDER BY id').all(), f.processing.getProject(project.id).status], before = now();
  for (const [method, route, body] of [['POST', `/api/v1/storage/trash/${trash.id}/restore`], ['DELETE', `/api/v1/tasks/${item.task.id}`], ['DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: item.task.id }], ['DELETE', `/api/v1/projects/${project.id}`]]) {
    const response = await f.request(method, route, body);
    assert.equal(response.status, 409, `${method} ${route}`);
    assert.equal(response.body.code, 'purge_started');
    assert.match(response.body.error, /^Permanent deletion of this Recycle Bin item has already started/);
  }
  purgeExpiredTrash(f.processing, f.storage);
  assert.deepEqual(now(), before);
});

test('a task in the Recycle Bin cannot be published', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item } = await leftByEarlierVersion(f, project, 'Left');
  const current = { ...item, ...f.output(f.processing.getTask(item.task.id), 'Reprocessed'), older: item };
  const refused = await f.request('POST', `/api/v1/attempts/${current.attempt.id}/publish`, { selectedAssetKinds: ['glb'] });
  assert.deepEqual([refused.status, refused.body.code], [409, 'attempt_not_reviewable']);
  assert.equal(f.processing.publishAttemptAtomic(current.attempt.id, ['glb'], { actorId: 'ops:test' }), null);
  assert.equal((await f.restore(current)).status, 200);
  await f.publishAgain(current);
  const other = await f.publishedTask(project, 'In a deleted project'), next = { ...other, ...f.output(f.processing.getTask(other.task.id), 'In review'), older: other };
  f.processing.trashProject(project.id, 'ops:test');
  assert.equal(f.processing.publishAttemptAtomic(next.attempt.id, ['glb'], { actorId: 'ops:test' }), null);
});

test('a task whose published model has no recorded output here keeps it through delete and restore', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), dataset = f.photos(project), task = f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Imported' });
  const model = f.repository.upsertModelVersion({ provider: 'terra', providerModelId: 'imported', providerVersionId: 'v1', displayName: 'Imported', status: 'ready', makeActive: true, assets: [] });
  f.database.prepare("UPDATE processing_tasks SET status='published',published_model_id=? WHERE id=?").run(model.id, task.id);
  assert.equal((await f.request('DELETE', `/api/v1/tasks/${task.id}`)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.processing.activeTrashForEntity('task', task.id).id}/restore`)).status, 200);
  assert.deepEqual([f.processing.getTask(task.id).status, f.processing.getTask(task.id).publishedModelId], ['published', model.id]);
});

test('a task whose current output was permanently deleted from the bin comes back as a draft', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await publishNewer(f, await f.publishedTask(project));
  assert.equal((await f.remove(item)).status, 200);
  const output = f.processing.activeTrashForEntity('output', item.versionId);
  assert.equal((await f.request('DELETE', `/api/v1/storage/trash/${output.id}`, { typedId: item.versionId })).status, 204);
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual([f.state(item).task, f.processing.getTask(item.task.id).activeAttemptId], ['draft', null]);
  assert.equal(f.processing.getModelOutput(item.older.versionId).status, 'ready');
});
