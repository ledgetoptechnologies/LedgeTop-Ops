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
    assert.match(response.body.error, /^Permanent deletion of this Recycle Bin item started before it was complete/);
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

// ---- Maintenance (a separate process) and crashes ----

const lifecycle = require('../server/containerLifecycle');
// What the worker has: its own connection to the same database and storage.
function worker(t, f) {
  const database = openDatabase(path.join(f.root, 'viewer.sqlite')), storage = new StorageManager(f.config);
  storage.initialize();
  t.after(() => database.close());
  const processing = new ProcessingRepository(database);
  return { database, processing, storage, maintain: () => [reconcileStorageMutations(processing, storage), purgeExpiredTrash(processing, storage)] };
}
// Every file an item has, wherever it is now: in place or in the bin.
function contents(f) {
  const found = new Set();
  for (const root of [f.config.datasetsMount, f.config.modelsMount, f.config.trashMount])
    for (const name of fs.readdirSync(root, { recursive: true })) { const file = path.join(root, String(name)); if (fs.statSync(file).isFile()) found.add(`${path.basename(file)}:${fs.readFileSync(file, 'utf8')}`); }
  return found;
}
const filesOf = (f, item, before) => before.files.filter(Boolean).flatMap((tree) => Object.entries(tree).map(([name, body]) => `${name}:${body}`));
function assertNothingLost(f, item, files, note) {
  const now = contents(f);
  for (const file of files) assert.ok(now.has(file), `${note}: ${file}`);
  assert.equal(f.database.prepare('SELECT purged_at FROM processing_tasks WHERE id=?').get(item.task.id).purged_at, null, `${note}: task record`);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM model_assets a JOIN model_versions v ON v.id=a.version_id WHERE v.model_id=?').get(item.modelId).n % 3, 0, `${note}: asset records`);
  assert.ok(f.database.prepare('SELECT COUNT(*) n FROM model_assets a JOIN model_versions v ON v.id=a.version_id WHERE v.model_id=?').get(item.modelId).n >= 3, `${note}: asset records`);
}
// Runs fn as a process that dies at one step: just before or just after its
// n-th step that can change the database or the files. Nothing runs after that.
const CHANGES = /^(trash|retrash|renew|archive|restore|begin|complete|mark|move|add|refresh|claim|finish|fail|purge|remove|setAside)/;
class Crash extends Error {}
function crashAt(f, at, fn) {
  let calls = 0, dead = false;
  const wrap = (target) => new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key);
    if (typeof value !== 'function') return value;
    return (...args) => {
      if (dead) throw new Crash();
      if (!CHANGES.test(key)) return value.apply(object, args);
      calls += 1;
      if (at === calls * 2 - 1) { dead = true; throw new Crash(); }
      const result = value.apply(object, args);
      if (at === calls * 2) { dead = true; throw new Crash(); }
      return result;
    };
  } });
  try { fn(wrap(f.processing), wrap(f.storage)); } catch (error) { if (!dead) throw error; }
  if (f.database.isTransaction) f.database.exec('ROLLBACK');
  return dead;
}

test('maintenance that read an item as expired does not purge it once it was deleted again', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f);
  const deleteNow = (item) => lifecycle.trashTaskTree(f.processing, f.storage, item.task.id, 'ops:test');
  for (const kind of ['half deleted', 'half deleted and reprocessed', 'deleted long ago', 'project deleted long ago']) {
    for (const when of ['expiredTrash', 'getTrash', 'beginContainerPurge']) {
      const note = `${kind}, ${when}`, half = kind.startsWith('half') ? await leftByEarlierVersion(f, project, note) : null;
      const item = half ? half.item : await f.publishedTask(project, note), current = kind.endsWith('reprocessed') ? { ...item, ...f.output(f.processing.getTask(item.task.id), 'Reprocessed'), older: item } : item;
      const owner = kind.startsWith('project') ? f.processing.createProject({ displayName: note }) : null;
      let target = current;
      if (owner) target = await f.publishedTask(owner, note);
      const before = half ? half.before : f.snapshot(target), files = [...filesOf(f, target, before), ...(target === item ? [] : filesOf(f, target, f.snapshot(target)))];
      if (kind === 'deleted long ago') assert.equal((await f.remove(target)).status, 200);
      if (owner) lifecycle.trashProjectTree(f.processing, f.storage, owner.id, 'ops:test');
      const trash = owner ? f.processing.activeTrashForEntity('project', owner.id) : f.bin(target);
      age(f, trash, 45);
      // The delete arrives in the middle of the worker's pass.
      const original = w.processing[when].bind(w.processing);
      let done = false;
      w.processing[when] = (...args) => {
        const listed = when === 'expiredTrash' ? original(...args) : null;
        if (!done && (when !== 'getTrash' || args[0] === trash.id)) { done = true; if (owner) lifecycle.trashProjectTree(f.processing, f.storage, owner.id, 'ops:test'); else deleteNow(target); }
        return listed || original(...args);
      };
      w.maintain();
      delete w.processing[when];
      if (!done) { assert.equal(when, 'beginContainerPurge', note); if (owner) lifecycle.trashProjectTree(f.processing, f.storage, owner.id, 'ops:test'); else deleteNow(target); }
      assert.equal(f.processing.getTrash(trash.id).purgeStartedAt ?? null, null, note);
      assertFullWindow(f, trash, note);
      w.maintain();
      assertNothingLost(f, target, files, note);
      const restored = await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      assert.equal(f.state(target).task, 'ready_for_review', note);
      await f.publishAgain(target);
    }
  }
});

test('a delete, or a delete again, that dies at any step loses nothing to the next maintenance, and can be finished', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f);
  for (const kind of ['republished', 'half deleted', 'half deleted and reprocessed']) {
    let at = 0, died = true;
    while (died) {
      at += 1;
      const note = `${kind} step ${at}`;
      let item, before;
      if (kind === 'republished') { item = await publishNewer(f, await f.publishedTask(project, note)); before = f.snapshot(item); } else {
        const left = await republishedLeftByEarlierVersion(f, project, note);
        ({ item, before } = left);
        if (kind.endsWith('reprocessed')) {
          const newest = { ...item, ...f.output(f.processing.getTask(item.task.id), 'Reprocessed'), older: item };
          before = { ...before, files: [...before.files, f.snapshot(newest).files[1]] };
          item = newest;
        }
        age(f, left.trash, 45);
      }
      const files = filesOf(f, item, before);
      died = crashAt(f, at, (processing, storage) => lifecycle.trashTaskTree(processing, storage, item.task.id, 'ops:test'));
      w.maintain();
      w.maintain();
      assertNothingLost(f, item, files, note);
      const removed = await f.remove(item);
      assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
      assertFullWindow(f, f.bin(item), note);
      w.maintain();
      const restored = await f.restore(item);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      assertNothingLost(f, item, files, note);
      assert.deepEqual(f.state(item), kind.endsWith('reprocessed') ? { ...f.IN_REVIEW, model: 'ready' } : f.IN_REVIEW, note);
    }
    assert.ok(at > 10, `${kind}: ${at} steps`);
  }
});

test('a project delete that dies at any step loses nothing to the next maintenance, and can be finished', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  for (const halfDeleted of [false, true]) {
    let at = 0, died = true;
    while (died) {
      at += 1;
      const note = `${halfDeleted} step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` });
      const left = halfDeleted ? await leftByEarlierVersion(f, project, note) : null, item = left ? left.item : await f.publishedTask(project, note), before = left ? left.before : f.snapshot(item), files = filesOf(f, item, before);
      if (left) age(f, left.trash, 45);
      died = crashAt(f, at, (processing, storage) => lifecycle.trashProjectTree(processing, storage, project.id, 'ops:test'));
      w.maintain();
      w.maintain();
      assertNothingLost(f, item, files, note);
      const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
      assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
      w.maintain();
      assert.equal((await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`)).status, 200, note);
      assert.deepEqual(f.snapshot(item), before, note);
      assert.deepEqual(f.state(item), f.IN_REVIEW, note);
    }
    assert.ok(at > 10, `${at} steps`);
  }
});

test('a restore of an expired item that dies at any step loses nothing to the next maintenance, and can be finished', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  for (const whole of [false, true]) {
    let at = 0, died = true, started = 0;
    while (died) {
      at += 1;
      const note = `${whole} step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` }), item = await publishNewer(f, await f.publishedTask(project, note)), before = f.snapshot(item), files = filesOf(f, item, before);
      const trash = whole ? (await f.request('DELETE', `/api/v1/projects/${project.id}`)).body.trash : (await f.remove(item)).body.trash;
      age(f, trash, 45);
      died = crashAt(f, at, (processing, storage) => lifecycle.restoreContainerTrash(processing, storage, trash.id, 'ops:test'));
      // Until the restore has begun, the item is simply past its date.
      if (Date.parse(f.processing.getTrash(trash.id).purgeAfter) < Date.now()) { assert.equal(started, 0, note); continue; }
      started += 1;
      w.maintain();
      // A month later nobody has looked at it: what was restored still stays.
      const live = f.processing.getTrash(trash.id);
      if (!live.permanentlyDeletedAt && f.processing.listContainerTrashMembers(trash.id).some((member) => member.permanentlyDeletedAt)) age(f, trash, 45);
      w.maintain();
      assertNothingLost(f, item, files, note);
      if (!live.permanentlyDeletedAt) {
        const restored = await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`);
        assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      }
      assert.deepEqual(f.snapshot(item), before, note);
      assert.deepEqual(f.state(item), f.IN_REVIEW, note);
    }
    assert.ok(started > 10, `${started} steps`);
  }
});

test('an expired purge that dies at any step is finished by later maintenance, and nothing is restorable in between', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  for (const whole of [false, true]) {
    let at = 0, died = true;
    while (died) {
      at += 1;
      const note = `${whole} step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` }), item = await publishNewer(f, await f.publishedTask(project, note)), files = filesOf(f, item, f.snapshot(item));
      const trash = whole ? (await f.request('DELETE', `/api/v1/projects/${project.id}`)).body.trash : (await f.remove(item)).body.trash;
      age(f, trash, 45);
      died = crashAt(f, at, (processing, storage) => lifecycle.purgeContainerTrash(processing, storage, trash.id, 'storage-maintenance', { expired: true }));
      if (f.processing.getTrash(trash.id).purgeStartedAt && !f.processing.getTrash(trash.id).permanentlyDeletedAt) {
        assert.equal((await f.request('POST', `/api/v1/storage/trash/${trash.id}/restore`)).body.code, 'purge_started', note);
        assert.equal((await f.request('DELETE', whole ? `/api/v1/projects/${project.id}` : `/api/v1/tasks/${item.task.id}`)).status, 409, note);
      }
      w.maintain();
      w.maintain();
      assert.ok(f.processing.getTrash(trash.id).permanentlyDeletedAt, note);
      const now = contents(f);
      for (const file of files) assert.equal(now.has(file), false, `${note}: ${file}`);
    }
    assert.ok(at > 10, `${at} steps`);
  }
});

test('a real second process that keeps purging never removes a task that is being deleted and restored', { timeout: 120_000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' });
  const script = `const {openDatabase}=require('./server/database'),{ProcessingRepository}=require('./server/processingRepository'),{StorageManager}=require('./server/storageManager'),{purgeExpiredTrash,reconcileStorageMutations}=require('./server/storageLifecycle');
    const [databasePath,config]=JSON.parse(process.argv[1]),processing=new ProcessingRepository(openDatabase(databasePath)),storage=new StorageManager(config);storage.initialize();
    process.stdout.write('ready\\n');let passes=0;process.on('SIGTERM',()=>{process.stdout.write('passes '+passes+'\\n',()=>process.exit(0));});
    (function pass(){try{reconcileStorageMutations(processing,storage);purgeExpiredTrash(processing,storage);passes+=1;}catch(error){if(!/locked|busy/i.test(error.message))process.stdout.write('error '+error.stack+'\\n');}setImmediate(pass);})();`;
  const child = spawn(process.execPath, ['-e', script, JSON.stringify([path.join(f.root, 'viewer.sqlite'), f.config])], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve) => { child.stdout.once('data', resolve); });
  for (let round = 0; round < 25; round += 1) {
    const note = `round ${round}`, { item, before, trash } = await republishedLeftByEarlierVersion(f, project, note), files = filesOf(f, item, before);
    age(f, trash, 45);
    const removed = await f.remove(item);
    assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
    await new Promise((resolve) => { setTimeout(resolve, round % 5); });
    assertNothingLost(f, item, files, note);
    assert.equal((await f.restore(item)).status, 200, note);
    assert.deepEqual(f.snapshot(item), before, note);
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => { child.once('close', resolve); });
  assert.doesNotMatch(output, /error/);
  assert.ok(Number(/passes (\d+)/.exec(output)?.[1]) > 25, output);
});

test('an output whose move finished after its delete had stopped is kept with its task, not removed on its own date', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), moveExact = f.storage.moveExact;
  for (const inProject of [false, true]) {
    const owner = inProject ? f.processing.createProject({ displayName: 'Deleted project' }) : project, item = await publishNewer(f, await f.publishedTask(owner, `Orphan ${inProject}`)), before = f.snapshot(item);
    let failed = false;
    f.storage.moveExact = function move(source, ...rest) {
      if (!failed && source === 'models') { failed = true; throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' }); }
      return moveExact.call(this, source, ...rest);
    };
    const remove = () => f.request('DELETE', inProject ? `/api/v1/projects/${owner.id}` : `/api/v1/tasks/${item.task.id}`);
    assert.equal((await remove()).status, 409);
    f.storage.moveExact = moveExact;
    reconcileStorageMutations(f.processing, f.storage);
    const orphan = f.processing.activeTrashForEntity('output', item.older.versionId), root = f.processing.activeTrashForEntity(inProject ? 'project' : 'task', inProject ? owner.id : item.task.id);
    assert.ok(orphan);
    // Its own date comes first; its task can still be restored.
    f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(orphan.id);
    assert.deepEqual(purgeExpiredTrash(w.processing, w.storage), [{ trashId: orphan.id, status: 'transferred', containerTrashId: root.id }]);
    assert.equal(f.processing.getTrash(orphan.id).purgeAfter, f.processing.getTrash(root.id).purgeAfter);
    assert.deepEqual(purgeExpiredTrash(w.processing, w.storage), []);
    if (inProject) assert.equal((await remove()).status, 200);
    assert.equal((await f.request('POST', `/api/v1/storage/trash/${root.id}/restore`)).status, 200);
    assert.deepEqual(f.snapshot(item), before);
  }
});

test('maintenance that read an output as expired on its own does not remove it once its task was deleted', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), item = await publishNewer(f, await f.publishedTask(project)), before = f.snapshot(item);
  // Deleted on its own, past its date, when the project is deleted.
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${item.older.versionId}`)).status, 200);
  const own = f.processing.activeTrashForEntity('output', item.older.versionId);
  assert.equal((await f.remove(item)).status, 200);
  f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(own.id);
  for (const step of ['expiredTrash', 'beginPurgeMutation']) {
    const original = w.processing[step].bind(w.processing);
    let done = false;
    w.processing[step] = (...args) => {
      const listed = step === 'expiredTrash' ? original(...args) : null;
      if (!done) { done = true; assert.ok(f.processing.addContainerTrashMember(f.bin(item).id, own.id)); }
      return listed || original(...args);
    };
    w.maintain();
    delete w.processing[step];
    assert.ok(done, step);
    assert.equal(f.processing.getTrash(own.id).permanentlyDeletedAt, null, step);
    f.database.prepare('DELETE FROM container_trash_members WHERE member_trash_id=?').run(own.id);
    f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(own.id);
  }
  // An item already being removed does not join, and nothing joins a purging one.
  const mutation = f.processing.beginPurgeMutation(own.id, 'ops:test');
  assert.ok(mutation);
  assert.equal(f.processing.addContainerTrashMember(f.bin(item).id, own.id), null);
  f.database.prepare("UPDATE storage_mutations SET status='failed' WHERE id=?").run(mutation.id);
  f.database.prepare("UPDATE storage_trash SET purge_started_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(f.bin(item).id);
  assert.equal(f.processing.addContainerTrashMember(f.bin(item).id, own.id), null);
  f.database.prepare('UPDATE storage_trash SET purge_started_at=NULL WHERE id=?').run(f.bin(item).id);
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual([f.snapshot(item).files[1], f.snapshot(item).files[0]], [before.files[1], before.files[0]]);
});

test('archiving, moving and other changes are not a way round the Recycle Bin', async (t) => {
  const f = await fixture(t), w = worker(t, f), other = f.processing.createProject({ displayName: 'Other' });
  const changes = {
    'archive task': (item) => f.request('POST', `/api/v1/tasks/${item.task.id}/archive`),
    'archive project': (item) => f.request('POST', `/api/v1/projects/${item.task.projectId}/archive`),
    'move task': (item) => { const task = f.processing.getTask(item.task.id); return f.request('PATCH', `/api/v1/tasks/${item.task.id}/project`, { projectId: other.id, folderId: null, expectedProjectId: task.projectId, expectedFolderId: null, expectedFolderRevision: task.folderRevision || 0, confirmSharingChange: true }); },
    'delete dataset': (item) => f.request('DELETE', `/api/v1/datasets/${item.dataset.id}`),
    'archive dataset': (item) => f.request('POST', `/api/v1/datasets/${item.dataset.id}/archive`),
    'move dataset': (item) => f.request('PATCH', `/api/v1/datasets/${item.dataset.id}`, { projectId: other.id }),
    'archive new output': (item) => f.request('POST', `/api/v1/processing/outputs/${item.versionId}/archive`),
    'delete new output': (item) => f.request('DELETE', `/api/v1/processing/outputs/${item.versionId}`),
    'cancel new attempt': (item) => f.request('POST', `/api/v1/attempts/${item.attempt.id}/cancel`),
    'empty bin item': (item) => f.request('DELETE', `/api/v1/storage/trash/${f.bin(item).id}`, { typedId: item.task.id }),
    'delete project': (item) => f.request('DELETE', `/api/v1/projects/${item.task.projectId}`),
    'delete task': (item) => f.remove(item),
  };
  const refused = ['archive task', 'move task', 'delete dataset', 'empty bin item'];
  for (const [started, reprocessed] of [[false, true], [true, true], [false, false], [true, false]]) {
    for (const [name, change] of Object.entries(changes)) {
      const note = `${name} ${started ? 'purge started' : 'half deleted'} ${reprocessed ? 'reprocessed' : ''}`, project = f.processing.createProject({ displayName: note }), { item: left, before, trash } = await leftByEarlierVersion(f, project, note);
      const item = reprocessed ? { ...left, ...f.output(f.processing.getTask(left.task.id), 'Reprocessed'), older: left } : left, files = [...filesOf(f, left, before), ...(reprocessed ? filesOf(f, item, f.snapshot(item)) : [])];
      age(f, trash, 45);
      if (started) f.database.prepare('UPDATE storage_trash SET purge_started_at=? WHERE id=?').run(new Date().toISOString(), trash.id);
      const response = await change(item);
      if (refused.includes(name) || (started && ['delete project', 'delete task'].includes(name))) assert.equal(response.status, 409, `${note} ${JSON.stringify(response.body)}`);
      if (name === 'move task') assert.equal(response.body.code, 'task_in_recycle_bin', note);
      w.maintain();
      w.maintain();
      assertNothingLost(f, item, files, note);
    }
  }
  const { item } = await leftByEarlierVersion(f, f.processing.createProject({ displayName: 'Message' }), 'Message');
  const archived = await f.request('POST', `/api/v1/tasks/${item.task.id}/archive`);
  assert.deepEqual([archived.body.code, archived.body.error], ['task_not_archivable', 'This task is in the Recycle Bin. Restore it, or delete it again.']);
  // Ordinary tasks and projects can be archived as before.
  const plain = f.processing.createProject({ displayName: 'Plain' }), task = await f.publishedTask(plain, 'Plain');
  assert.equal((await f.request('POST', `/api/v1/tasks/${task.task.id}/archive`)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/projects/${plain.id}/archive`)).status, 200);
});

test('a project whose delete or restore stopped partway is never purged, whatever its tasks say', async (t) => {
  const f = await fixture(t), w = worker(t, f), moveExact = f.storage.moveExact;
  // Delete stopped before its second task.
  const stopped = f.processing.createProject({ displayName: 'Delete stopped' }), first = await f.publishedTask(stopped, 'First');
  await pause();
  const second = await f.publishedTask(stopped, 'Second'), before = [f.snapshot(first), f.snapshot(second)];
  let models = 0;
  f.storage.moveExact = function move(source, ...rest) {
    if (source === 'models' && (models += 1) === 2) throw Object.assign(new Error('synthetic conflict'), { code: 'lifecycle_conflict' });
    return moveExact.call(this, source, ...rest);
  };
  const removed = await f.request('DELETE', `/api/v1/projects/${stopped.id}`);
  f.storage.moveExact = moveExact;
  assert.equal(removed.status, 409);
  f.database.prepare("UPDATE processing_tasks SET status='draft' WHERE id=?").run(second.task.id);
  f.database.prepare("UPDATE storage_trash SET permanently_deleted_at=created_at WHERE entity_type='task' AND entity_id=?").run(second.task.id);
  const trash = f.processing.activeTrashForEntity('project', stopped.id);
  f.database.prepare('DELETE FROM container_trash_members WHERE container_trash_id=? AND entity_id=?').run(trash.id, second.task.id);
  age(f, trash, 45);
  w.maintain();
  assert.equal(f.processing.getTrash(trash.id).purgeStartedAt ?? null, null);
  assertNothingLost(f, first, filesOf(f, first, before[0]), 'first');
  assertNothingLost(f, second, filesOf(f, second, before[1]), 'second');

  // Restore stopped after the project, before its task.
  const half = f.processing.createProject({ displayName: 'Restore stopped' }), item = await f.publishedTask(half, 'Task'), itemBefore = f.snapshot(item);
  const root = (await f.request('DELETE', `/api/v1/projects/${half.id}`)).body.trash;
  assert.ok(f.processing.restoreMetadataEntity(root.id, 'ops:test', { finalizeTrash: false }));
  assert.equal(f.processing.getProject(half.id).status, 'active');
  age(f, root, 45);
  assert.equal((await f.request('POST', `/api/v1/projects/${half.id}/archive`)).status, 409, 'archiving would let it be purged');
  w.maintain();
  assertNothingLost(f, item, filesOf(f, item, itemBefore), 'half restored');
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${root.id}/restore`)).status, 200);
  assert.deepEqual(f.snapshot(item), itemBefore);
});

test('a permanent deletion left unfinished or failed by an earlier version removes nothing from a task that is not archived', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f);
  for (const status of ['intent', 'failed']) {
    const { item, before, trash } = await leftByEarlierVersion(f, project, status), files = filesOf(f, item, before), output = f.processing.activeTrashForEntity('output', item.versionId), at = new Date().toISOString(), id = crypto.randomUUID();
    f.database.prepare('UPDATE storage_trash SET purge_started_at=? WHERE id=?').run(at, trash.id);
    f.database.prepare("INSERT INTO storage_mutations(id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,status,actor,created_at,updated_at) VALUES (?,'purge','output',?,?,'trash',?,?,'storage-maintenance',?,?)").run(id, item.versionId, output.id, output.relativePath, status, at, at);
    w.maintain();
    if (status === 'failed') assert.equal((await f.request('POST', `/api/v1/storage/mutations/${id}/retry`)).status, 409);
    assertNothingLost(f, item, files, status);
    assert.equal(f.processing.getStorageMutation(id).status, 'failed');
  }
  // A failed purge of something that was restored since cannot be retried onto it.
  const item = await f.publishedTask(project, 'Restored since'), before = f.snapshot(item);
  assert.equal((await f.remove(item)).status, 200);
  const output = f.processing.activeTrashForEntity('output', item.versionId), id = crypto.randomUUID(), at = new Date().toISOString();
  f.database.prepare("INSERT INTO storage_mutations(id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,status,actor,created_at,updated_at) VALUES (?,'purge','output',?,?,'trash',?,'failed','ops:test',?,?)").run(id, item.versionId, output.id, output.relativePath, at, at);
  assert.equal((await f.restore(item)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/storage/mutations/${id}/retry`)).status, 409);
  assert.deepEqual(f.snapshot(item), before);
});

test('the worker finishing a move the request is making changes nothing for either', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), exists = f.storage.pathExistsStrict;
  // While the request moves files the worker waits; here it gives up at once, as after its five seconds.
  w.database.exec('PRAGMA busy_timeout=0');
  for (const step of ['delete', 'restore']) {
    for (let at = 1; at <= 9; at += 1) {
      const note = `${step} ${at}`, item = await f.publishedTask(project, note), before = f.snapshot(item);
      if (step === 'restore') assert.equal((await f.remove(item)).status, 200, note);
      let calls = 0;
      f.storage.pathExistsStrict = function check(...args) {
        const result = exists.apply(this, args);
        if ((calls += 1) === at) reconcileStorageMutations(w.processing, w.storage);
        return result;
      };
      const response = step === 'delete' ? await f.remove(item) : await f.restore(item);
      f.storage.pathExistsStrict = exists;
      assert.equal(response.status, 200, `${note} ${JSON.stringify(response.body)}`);
      if (step === 'delete') { assert.deepEqual(f.state(item), f.DELETED, note); assert.equal((await f.restore(item)).status, 200, note); }
      assert.deepEqual(f.state(item), f.IN_REVIEW, note);
      assert.deepEqual(f.snapshot(item), before, note);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM storage_mutations WHERE status<>'complete'").get().n, 0, note);
    }
  }
  // The same between the check and the move itself.
  const item = await f.publishedTask(project, 'move'), before = f.snapshot(item), moveExact = f.storage.moveExact;
  f.storage.moveExact = function move(...args) { reconcileStorageMutations(w.processing, w.storage); return moveExact.apply(this, args); };
  assert.equal((await f.remove(item)).status, 200);
  assert.equal((await f.restore(item)).status, 200);
  f.storage.moveExact = moveExact;
  assert.deepEqual(f.snapshot(item), before);
  // A real failure is still one.
  f.storage.moveExact = () => { throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' }); };
  assert.equal((await f.remove(item)).status, 409);
  f.storage.moveExact = moveExact;
});

// ---- Between a move and its membership ----

// Anything in the bin on its own is past its date, as it would be two weeks on.
const expireLoose = (f) => f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE permanently_deleted_at IS NULL AND entity_type IN ('output','dataset') AND NOT EXISTS(SELECT 1 FROM container_trash_members m JOIN storage_trash c ON c.id=m.container_trash_id WHERE m.member_trash_id=storage_trash.id AND c.permanently_deleted_at IS NULL)").run();
function assertOneOwner(f, note) {
  assert.deepEqual(f.database.prepare('SELECT m.member_trash_id,COUNT(*) n FROM container_trash_members m JOIN storage_trash c ON c.id=m.container_trash_id JOIN storage_trash s ON s.id=m.member_trash_id WHERE c.permanently_deleted_at IS NULL AND s.permanently_deleted_at IS NULL GROUP BY m.member_trash_id HAVING n>1').all(), [], `${note}: two owners`);
}
// What a delete that answered OK promises: everything is in the one item.
function assertComplete(f, root, projectId, note) {
  const members = f.processing.listContainerTrashMembers(root.id).filter((member) => !member.permanentlyDeletedAt), ids = new Set(members.map((member) => member.entityId));
  const tasks = f.database.prepare('SELECT id,status FROM processing_tasks WHERE project_id=? AND purged_at IS NULL').all(projectId), outputs = f.database.prepare('SELECT id,status FROM model_outputs WHERE project_id=?').all(projectId), datasets = f.database.prepare('SELECT id,status FROM datasets WHERE project_id=?').all(projectId);
  for (const row of tasks) assert.deepEqual([row.status, ids.has(row.id)], ['archived', true], `${note} task`);
  for (const row of [...outputs, ...datasets]) assert.deepEqual([row.status, ids.has(row.id)], ['trashed', true], `${note} output or photos`);
  assertFullWindow(f, root, note);
}

test('a project delete that dies at any step, with photos no task uses and a task deleted before, keeps everything together', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  for (const resume of ['delete again', 'restore']) {
    let at = 0, died = true;
    while (died) {
      at += 1;
      const note = `${resume} step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` });
      const first = await f.publishedTask(project, `${note} first`), second = await publishNewer(f, await f.publishedTask(project, `${note} second`)), loose = f.photos(project, `${note} loose`);
      const before = [f.snapshot(first), f.snapshot(second)], files = [...filesOf(f, first, before[0]), ...filesOf(f, second, before[1]), `photo.jpg:${note} loose photo`];
      assert.equal((await f.remove(first)).status, 200, note);
      await pause();
      died = crashAt(f, at, (processing, storage) => lifecycle.trashProjectTree(processing, storage, project.id, 'ops:test'));
      for (let pass = 0; pass < 3; pass += 1) { w.maintain(); expireLoose(f); }
      assertNothingLost(f, first, files, note);
      assertNothingLost(f, second, files, note);
      assertOneOwner(f, note);
      let root = f.processing.activeTrashForEntity('project', project.id);
      if (!died) assertComplete(f, root, project.id, note);
      if (resume === 'delete again' || !root) {
        const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
        assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
        root = removed.body.trash;
        assertComplete(f, root, project.id, note);
        assertOneOwner(f, note);
        w.maintain();
      }
      // The first task was deleted before its project: it is still on its own if the project's delete had not reached it.
      const apart = f.processing.listContainerTrashMembers(root.id).every((member) => member.entityId !== first.task.id);
      const restored = await f.request('POST', `/api/v1/storage/trash/${root.id}/restore`);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
      // Whatever the project's delete took is back with the project.
      assert.equal(f.bin(second), null, note);
      assert.equal(Boolean(f.bin(first)), apart, note);
      if (apart) assert.equal((await f.restore(first)).status, 200, note);
      for (const [index, item] of [first, second].entries()) {
        // A task the delete had not reached is as it was; a restored one is in review.
        assert.deepEqual(f.snapshot(item), before[index], note);
        assert.ok(['published', 'ready_for_review'].includes(f.state(item).task), note);
      }
      assert.deepEqual(f.tree(loose.directory), { 'photo.jpg': `${note} loose photo` }, note);
      assert.equal(f.processing.getDataset(loose.id).status, 'finalized', note);
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM storage_trash s WHERE permanently_deleted_at IS NULL AND (entity_id IN (SELECT id FROM datasets WHERE project_id=?) OR entity_id IN (SELECT id FROM model_outputs WHERE project_id=?))").get(project.id, project.id).n, 0, `${note}: the bin is empty`);
    }
    assert.ok(at > 20, `${at} steps`);
  }
});

test('a task delete that dies at any step leaves nothing that maintenance removes on its own date', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f);
  let at = 0, died = true;
  while (died) {
    at += 1;
    const note = `step ${at}`, item = await publishNewer(f, await f.publishedTask(project, note)), before = f.snapshot(item), files = filesOf(f, item, before);
    died = crashAt(f, at, (processing, storage) => lifecycle.trashTaskTree(processing, storage, item.task.id, 'ops:test'));
    for (let pass = 0; pass < 3; pass += 1) { w.maintain(); expireLoose(f); }
    assertNothingLost(f, item, files, note);
    assertOneOwner(f, note);
    if (f.bin(item)) {
      const restored = await f.restore(item);
      assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
    }
    assert.deepEqual(f.snapshot(item), before, note);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0, note);
  }
  assert.ok(at > 10, `${at} steps`);
});

test('photos of a deleted project whose move has failed keep the delete from being reported as done', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), loose = f.photos(project, 'Loose'), moveExact = f.storage.moveExact;
  f.storage.moveExact = () => { throw Object.assign(new Error('synthetic conflict'), { code: 'lifecycle_conflict' }); };
  assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409);
  f.storage.moveExact = moveExact;
  assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409, 'its failed move is still open');
  const mutation = f.database.prepare("SELECT id FROM storage_mutations WHERE status='failed'").get();
  assert.equal((await f.request('POST', `/api/v1/storage/mutations/${mutation.id}/retry`)).status, 200);
  const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assertComplete(f, removed.body.trash, project.id, 'retried');
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`)).status, 200);
  assert.deepEqual(f.tree(loose.directory), { 'photo.jpg': 'Loose photo' });
});

test('each check of a permanent deletion is made again in the transaction that starts it', async (t) => {
  const f = await fixture(t), w = worker(t, f), project = f.processing.createProject({ displayName: 'Project' });
  // While the pass is between its own check and starting, something changes.
  const between = {
    'its task is no longer archived': (item) => f.database.prepare("UPDATE processing_tasks SET status='draft' WHERE id=?").run(item.task.id),
    'its photos are in use': (item) => { f.database.prepare("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,metadata_json,created_at,updated_at) VALUES (?,?,?,'Uses them','draft','{}','x','x')").run(crypto.randomUUID(), project.id, item.dataset.id); },
    'a move has begun': (item) => f.database.prepare("INSERT INTO storage_mutations(id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,destination_root_key,destination_relative_path,status,actor,created_at,updated_at) VALUES (?,'trash','output',?,?,'models','none','trash','none','intent','x','x','x')").run(crypto.randomUUID(), item.versionId, crypto.randomUUID()),
    'its output was restored': (item) => { const trash = f.processing.activeTrashForEntity('output', item.versionId), mutation = f.processing.beginRestoreMutation(trash.id, 'ops:test'); require('../server/storageLifecycle').applyStorageMutation(f.processing, f.storage, mutation); },
  };
  for (const [note, change] of Object.entries(between)) {
    const item = await f.publishedTask(project, note), files = filesOf(f, item, f.snapshot(item));
    assert.equal((await f.remove(item)).status, 200, note);
    const trash = f.bin(item), original = w.processing.beginContainerPurge.bind(w.processing);
    age(f, trash, 45);
    let done = false;
    w.processing.beginContainerPurge = (...args) => { done = true; change(item); return original(...args); };
    purgeExpiredTrash(w.processing, w.storage);
    delete w.processing.beginContainerPurge;
    assert.ok(done, note);
    assert.equal(f.processing.getTrash(trash.id).purgeStartedAt ?? null, null, note);
    assertNothingLost(f, item, files, note);
    f.database.prepare("DELETE FROM storage_mutations WHERE source_relative_path='none'").run();
  }
  // Photos restored on their own from a task that has nothing else.
  const dataset = f.photos(project, 'Only photos'), task = f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Only photos' });
  assert.equal((await f.request('DELETE', `/api/v1/tasks/${task.id}`)).status, 200);
  const trash = f.processing.activeTrashForEntity('task', task.id);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.processing.activeTrashForEntity('dataset', dataset.id).id}/restore`)).status, 200);
  age(f, trash, 45);
  purgeExpiredTrash(w.processing, w.storage);
  assert.ok(f.processing.getTask(task.id), 'kept, with its photos');
  // One output at a time: a newer date, membership, or a deleted owner.
  const item = await publishNewer(f, await f.publishedTask(project, 'Single output'));
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${item.older.versionId}`)).status, 200);
  const own = f.processing.activeTrashForEntity('output', item.older.versionId), expire = () => f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(own.id);
  await pause();
  assert.equal((await f.remove(item)).status, 200);
  const single = {
    'a newer date': () => f.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() + 86400_000).toISOString(), own.id),
    'membership': () => { assert.ok(f.processing.addContainerTrashMember(f.bin(item).id, own.id)); expire(); },
    'a deleted owner': () => f.database.prepare('UPDATE storage_trash SET created_at=? WHERE id=?').run(new Date().toISOString(), own.id),
  };
  for (const [note, change] of Object.entries(single)) {
    f.database.prepare('DELETE FROM container_trash_members WHERE member_trash_id=?').run(own.id);
    f.database.prepare("UPDATE storage_trash SET created_at='2025-01-01T00:00:00.000Z' WHERE id=?").run(own.id);
    expire();
    const original = w.processing.beginPurgeMutation.bind(w.processing);
    let done = false;
    w.processing.beginPurgeMutation = (...args) => { done = true; change(); return original(...args); };
    purgeExpiredTrash(w.processing, w.storage);
    delete w.processing.beginPurgeMutation;
    assert.ok(done, note);
    assert.equal(f.processing.getTrash(own.id).permanentlyDeletedAt, null, note);
  }
});

test('photos of a deleted project whose move is still running keep it from being restored or purged, and then come back with it', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), loose = f.photos(project, 'Loose'), w = worker(t, f), moveExact = f.storage.moveExact;
  f.storage.moveExact = () => { throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' }); };
  assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409);
  f.storage.moveExact = moveExact;
  const root = f.processing.activeTrashForEntity('project', project.id), restore = () => f.request('POST', `/api/v1/storage/trash/${root.id}/restore`);
  assert.equal((await restore()).status, 409);
  assert.equal(f.processing.getProject(project.id).status, 'archived');
  age(f, root, 45);
  purgeExpiredTrash(w.processing, w.storage);
  assert.equal(f.processing.getTrash(root.id).purgeStartedAt ?? null, null);
  reconcileStorageMutations(w.processing, w.storage);
  assert.equal(f.processing.listContainerTrashMembers(root.id).length, 0, 'the case under test');
  assert.equal((await restore()).status, 200);
  assert.deepEqual(f.tree(loose.directory), { 'photo.jpg': 'Loose photo' });
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0);
});

// ---- A project's delete and restore, interrupted ----

test('restoring a project whose delete died at any step brings back every task that delete took, without staff help', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  let at = 0, died = true;
  while (died) {
    at += 1;
    const note = `step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` }), items = [];
    for (const name of ['one', 'two', 'three']) items.push(await f.publishedTask(project, `${note} ${name}`));
    const before = items.map(f.snapshot);
    died = crashAt(f, at, (processing, storage) => lifecycle.trashProjectTree(processing, storage, project.id, 'ops:test'));
    const root = f.processing.activeTrashForEntity('project', project.id);
    // Never archived without being in the project's item.
    const members = root ? f.processing.listContainerTrashMembers(root.id).map((member) => member.entityId) : [];
    for (const item of items) assert.equal(f.processing.getTask(item.task.id).status === 'archived', members.includes(item.task.id), note);
    if (!root) continue;
    w.maintain();
    const restored = await f.request('POST', `/api/v1/storage/trash/${root.id}/restore`);
    assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
    for (const [index, item] of items.entries()) {
      assert.equal(f.bin(item), null, note);
      assert.ok(['published', 'ready_for_review'].includes(f.state(item).task), note);
      assert.deepEqual(f.snapshot(item), before[index], note);
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0, note);
  }
  assert.ok(at > 20, `${at} steps`);
});

test('a project whose restore died at any step can be deleted again: it is in the bin, and comes back without loss', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  let at = 0, died = true, halfRestored = 0;
  while (died) {
    at += 1;
    const note = `step ${at}`, project = f.processing.createProject({ displayName: `Project ${note}` }), raw = f.link(project), items = [];
    for (const name of ['one', 'two', 'three']) items.push(await f.publishedTask(project, `${note} ${name}`));
    const before = items.map(f.snapshot), trash = (await f.request('DELETE', `/api/v1/projects/${project.id}`)).body.trash;
    age(f, trash, 10);
    died = crashAt(f, at, (processing, storage) => lifecycle.restoreContainerTrash(processing, storage, trash.id, 'ops:test'));
    let late = null;
    if (f.processing.getProject(project.id).status === 'active' && !f.processing.getTrash(trash.id).permanentlyDeletedAt) {
      halfRestored += 1;
      late = f.link(project);
      const live = items.find((item) => f.processing.getTask(item.task.id).status !== 'archived');
      if (live) assert.equal((await f.remove(live)).status, 409, `${note}: a task is not deleted on its own while its project is in the bin`);
    }
    w.maintain();
    const removed = await f.request('DELETE', `/api/v1/projects/${project.id}`);
    assert.equal(removed.status, 200, `${note} ${JSON.stringify(removed.body)}`);
    assert.equal(f.processing.getProject(project.id).status, 'archived', note);
    for (const link of [raw, late].filter(Boolean)) assert.equal((await fetch(`${f.base}/api/project-share/${link}`)).status, 410, note);
    assertComplete(f, removed.body.trash, project.id, note);
    assertOneOwner(f, note);
    w.maintain();
    const restored = await f.request('POST', `/api/v1/storage/trash/${removed.body.trash.id}/restore`);
    assert.equal(restored.status, 200, `${note} ${JSON.stringify(restored.body)}`);
    for (const [index, item] of items.entries()) {
      assert.deepEqual(f.state(item), f.IN_REVIEW, note);
      assert.deepEqual(f.snapshot(item), before[index], note);
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0, note);
  }
  assert.ok(at > 20 && halfRestored > 3, `${at} steps, ${halfRestored} half restored`);
});

test('a half-restored project with running work, or whose item is being purged, is not deleted again', async (t) => {
  const f = await fixture(t);
  for (const reason of ['running', 'purging']) {
    const project = f.processing.createProject({ displayName: reason }), item = await f.publishedTask(project, reason), trash = (await f.request('DELETE', `/api/v1/projects/${project.id}`)).body.trash;
    assert.ok(f.processing.restoreMetadataEntity(trash.id, 'ops:test', { finalizeTrash: false }));
    if (reason === 'running') f.database.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(item.task.id);
    else f.database.prepare('UPDATE storage_trash SET purge_started_at=? WHERE id=?').run(new Date().toISOString(), trash.id);
    age(f, trash, 10);
    const purgeAfter = f.processing.getTrash(trash.id).purgeAfter;
    assert.equal(f.processing.trashProject(project.id, 'ops:test'), null, reason);
    assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409, reason);
    assert.equal(f.processing.getProject(project.id).status, 'active', reason);
    assert.equal(f.processing.getTrash(trash.id).purgeAfter, purgeAfter, reason);
  }
});

test('a task an earlier version archived but did not put in its project\'s item comes back, or goes, with the project', async (t) => {
  const f = await fixture(t), w = worker(t, f);
  for (const way of ['restore', 'restore from half restored', 'expire', 'empty the task alone']) {
    const project = f.processing.createProject({ displayName: way }), item = await f.publishedTask(project, way), other = await f.publishedTask(project, `${way} other`), before = [f.snapshot(item), f.snapshot(other)], files = filesOf(f, item, before[0]);
    const root = (await f.request('DELETE', `/api/v1/projects/${project.id}`)).body.trash;
    f.database.prepare('DELETE FROM container_trash_members WHERE container_trash_id=? AND entity_id=?').run(root.id, item.task.id);
    if (way === 'expire') {
      age(f, f.bin(item), 45);
      f.database.prepare('UPDATE storage_trash SET created_at=(SELECT created_at FROM storage_trash r WHERE r.id=?) WHERE id=?').run(root.id, f.bin(item).id);
      // Its own date is past, but the project's is not.
      w.maintain();
      assertNothingLost(f, item, files, way);
      assert.ok(f.processing.listContainerTrashMembers(root.id).some((member) => member.entityId === item.task.id), way);
    }
    if (way === 'restore from half restored') assert.ok(f.processing.restoreMetadataEntity(root.id, 'ops:test', { finalizeTrash: false }));
    if (way === 'empty the task alone') {
      // What maintenance decides again in the transaction that would start it.
      f.database.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id=?").run(f.bin(item).id);
      assert.equal(f.processing.beginContainerPurge(f.bin(item).id, 'storage-maintenance', { expired: true }), null, way);
      // Nor does the project's restore count as finished while a task it took is still in the bin.
      f.database.prepare("UPDATE projects SET status='active' WHERE id=?").run(project.id);
      assert.equal(f.processing.finishMetadataRestore(root.id), null, way);
      const otherTrash = f.bin(other), closed = (value) => f.database.prepare('UPDATE storage_trash SET permanently_deleted_at=? WHERE id=?').run(value, otherTrash.id);
      closed(new Date().toISOString());
      assert.equal(f.processing.finishMetadataRestore(root.id), null, `${way}: the task outside the item`);
      assert.ok(f.processing.addContainerTrashMember(root.id, f.bin(item).id));
      assert.equal(f.processing.finishMetadataRestore(root.id), null, `${way}: the task in the item`);
      closed(null);
    }
    const restored = await f.request('POST', `/api/v1/storage/trash/${root.id}/restore`);
    assert.equal(restored.status, 200, `${way} ${JSON.stringify(restored.body)}`);
    for (const [index, value] of [item, other].entries()) {
      assert.deepEqual(f.state(value), f.IN_REVIEW, way);
      assert.deepEqual(f.snapshot(value), before[index], way);
    }
  }
});

test('an output of a half-deleted task restored on its own, then deleted and restored with the task, can be published', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item, before } = await leftByEarlierVersion(f, project, 'Left');
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.processing.activeTrashForEntity('output', item.versionId).id}/restore`)).status, 200);
  assert.equal((await f.remove(item)).status, 200);
  assert.equal(f.processing.activeTrashForEntity('output', item.versionId).originalStatus, 'ready', 'the case under test');
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual(f.state(item), f.IN_REVIEW);
  assert.deepEqual(f.snapshot(item), before);
  await f.publishAgain(item);
});

test('an output restored on its own and then archived stays archived when its task is deleted and restored', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), { item } = await leftByEarlierVersion(f, project, 'Left');
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.processing.activeTrashForEntity('output', item.versionId).id}/restore`)).status, 200);
  assert.ok(f.processing.archiveModelOutput(item.versionId, 'ops:test'));
  assert.equal((await f.remove(item)).status, 200);
  assert.equal((await f.restore(item)).status, 200);
  assert.deepEqual([f.state(item).task, f.state(item).active, f.state(item).output], ['draft', false, 'archived']);
});

test('a project\'s delete archives a task only together with putting it in that project\'s item', async (t) => {
  const f = await fixture(t), [project, elsewhere] = ['One', 'Two'].map((displayName) => f.processing.createProject({ displayName })), item = await f.publishedTask(project, 'Task');
  const other = f.processing.trashProject(elsewhere.id, 'ops:test'), within = (containerId) => f.processing.trashTask(item.task.id, 'ops:test', { withinProjectTrash: true, containerId });
  assert.equal(within(other.id), null, 'its own project is not deleted');
  const root = f.processing.trashProject(project.id, 'ops:test');
  for (const containerId of [other.id, 'missing']) assert.throws(() => within(containerId), { code: 'lifecycle_conflict' }, containerId);
  assert.deepEqual([f.state(item).task, f.state(item).bin], ['published', false], 'nothing of it was done');
  assert.ok(within(root.id));
  assert.deepEqual(f.processing.listContainerTrashMembers(root.id).map((member) => member.entityId), [item.task.id]);
  // Again, once that project is half restored: not through the old item, and not on its own.
  assert.ok(f.processing.restoreMetadataEntity(root.id, 'ops:test', { finalizeTrash: false }));
  assert.equal(within(root.id), null);
  assert.equal(f.processing.trashTask(item.task.id, 'ops:test'), null);
});

// ---- Two processes, one journal ----

// The files of one photo set or output, and the record that says where they are.
function storedEntity(f, item, entityType) {
  const entityId = entityType === 'dataset' ? item.dataset.id : item.versionId, directory = entityType === 'dataset' ? item.dataset.directory : item.directory, read = () => f.tree(directory), kept = read();
  return {
    entityType, entityId,
    status: () => (entityType === 'dataset' ? f.processing.getDataset(entityId) : f.processing.getModelOutput(entityId)).status,
    assertLive: (note) => { assert.deepEqual(read(), kept, `${note}: files in place`); assert.notEqual(entityType === 'dataset' ? f.processing.getDataset(entityId).status : f.processing.getModelOutput(entityId).status, 'trashed', note); },
    assertBinned: (note) => {
      const trash = f.processing.activeTrashForEntity(entityType, entityId);
      assert.ok(trash, `${note}: in the bin`);
      assert.equal(read(), null, `${note}: moved`);
      assert.deepEqual(f.tree(path.join(f.config.trashMount, ...trash.relativePath.split('/'))), kept, `${note}: files in the bin`);
    },
    begin: (type) => (type === 'trash' ? (entityType === 'dataset' ? f.processing.beginTrashMutation(entityId, 'ops:test') : f.processing.moveOutputToTrash(entityId, 'ops:test')) : type === 'restore' ? f.processing.beginRestoreMutation(f.processing.activeTrashForEntity(entityType, entityId).id, 'ops:test') : f.processing.beginPurgeMutation(f.processing.activeTrashForEntity(entityType, entityId).id, 'ops:test')),
  };
}

test('a process that comes late with an old copy of a journal never moves files the other process has moved back', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), { applyStorageMutation } = require('../server/storageLifecycle');
  for (const entityType of ['dataset', 'output']) {
    // Photos with a failed purge are not restored until staff retry it.
    for (const late of entityType === 'dataset' ? ['trash', 'restore'] : ['trash', 'restore', 'purge']) {
      const note = `${entityType} ${late}`, item = await f.publishedTask(project, note);
      if (entityType === 'dataset') f.database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(item.task.id);
      const stored = storedEntity(f, item, entityType), run = (type) => applyStorageMutation(f.processing, f.storage, stored.begin(type));
      // What the worker read when it started its pass.
      const readByWorker = (type) => { stored.begin(type); const [copy] = w.processing.pendingStorageMutations(); assert.deepEqual([copy.type, copy.status, copy.entityId], [type, 'intent', stored.entityId], note); return copy; };
      let copy;
      if (late === 'trash') {
        copy = readByWorker('trash');
        reconcileStorageMutations(f.processing, f.storage);
        run('restore');
        stored.assertLive(note);
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'complete', note);
        stored.assertLive(note);
        run('trash');
        stored.assertBinned(note);
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'complete', note);
        stored.assertBinned(note);
      } else if (late === 'restore') {
        run('trash');
        copy = readByWorker('restore');
        reconcileStorageMutations(f.processing, f.storage);
        run('trash');
        stored.assertBinned(note);
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'complete', note);
        stored.assertBinned(note);
        run('restore');
        stored.assertLive(note);
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'complete', note);
        stored.assertLive(note);
      } else {
        // A purge the other process refused and recorded as failed: it was restored since.
        run('trash');
        copy = readByWorker('purge');
        f.processing.failStorageMutation(copy.id, 'lifecycle_conflict', 'synthetic');
        run('restore');
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'failed', note);
        stored.assertLive(note);
        run('trash');
        assert.equal(applyStorageMutation(w.processing, w.storage, copy).status, 'failed', note);
        stored.assertBinned(note);
      }
      assert.equal(f.database.prepare("SELECT COUNT(*) n FROM storage_mutations WHERE entity_id=? AND status NOT IN ('complete','failed')").get(stored.entityId).n, 0, note);
    }
  }
});

test('while one process checks and moves files, the other can neither finish that journal nor start the opposite one', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), { applyStorageMutation } = require('../server/storageLifecycle');
  // Here the other process gives up at once instead of after its five seconds.
  f.database.exec('PRAGMA busy_timeout=0');
  for (const entityType of ['dataset', 'output']) {
    for (const type of ['trash', 'restore']) {
      for (const point of ['first check', 'second check', 'before the move', 'after the move']) {
        const note = `${entityType} ${type} ${point}`, item = await f.publishedTask(project, note);
        if (entityType === 'dataset') f.database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(item.task.id);
        const stored = storedEntity(f, item, entityType), opposite = type === 'trash' ? 'restore' : 'trash';
        if (type === 'restore') applyStorageMutation(f.processing, f.storage, stored.begin('trash'));
        const mutation = stored.begin(type), outcomes = [];
        // The other process: finish the journal, then undo it.
        const attempt = () => { try { applyStorageMutation(f.processing, f.storage, mutation.id); applyStorageMutation(f.processing, f.storage, stored.begin(opposite)); outcomes.push('undone'); } catch (error) { outcomes.push(error.code); } };
        const exists = w.storage.pathExistsStrict, move = w.storage.moveExact;
        let checks = 0;
        w.storage.pathExistsStrict = function check(...args) { const result = exists.apply(this, args); checks += 1; if (checks === { 'first check': 1, 'second check': 2 }[point]) attempt(); return result; };
        w.storage.moveExact = function moving(...args) { if (point === 'before the move') attempt(); const result = move.apply(this, args); if (point === 'after the move') attempt(); return result; };
        assert.equal(applyStorageMutation(w.processing, w.storage, mutation).status, 'complete', note);
        w.storage.pathExistsStrict = exists;
        w.storage.moveExact = move;
        assert.deepEqual(outcomes, ['ERR_SQLITE_ERROR'], note);
        if (type === 'trash') stored.assertBinned(note); else stored.assertLive(note);
        applyStorageMutation(f.processing, f.storage, stored.begin(opposite));
        if (type === 'trash') stored.assertLive(note); else stored.assertBinned(note);
      }
    }
  }
});

test('a move or removal whose process dies is finished from the files, by whichever process comes next', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), { applyStorageMutation } = require('../server/storageLifecycle');
  const died = () => Object.assign(new Error('synthetic crash'), { code: 'EIO' });
  for (const type of ['trash', 'restore', 'purge']) {
    const item = await f.publishedTask(project, type), stored = storedEntity(f, item, 'output');
    if (type !== 'trash') applyStorageMutation(f.processing, f.storage, stored.begin('trash'));
    const trash = f.processing.activeTrashForEntity('output', item.versionId), mutation = stored.begin(type), method = type === 'purge' ? 'setAsideForPurge' : 'moveExact', original = f.storage[method];
    f.storage[method] = function dying(...args) { original.apply(this, args); throw died(); };
    assert.throws(() => applyStorageMutation(f.processing, f.storage, mutation), { code: 'EIO' }, type);
    f.storage[method] = original;
    assert.equal(f.processing.getStorageMutation(mutation.id).status, 'intent', type);
    assert.equal(f.database.isTransaction, false, type);
    if (type === 'purge') {
      // The files are out of the way, so no restore can find half of them.
      assert.equal(f.processing.beginRestoreMutation(trash.id, 'ops:test'), null);
      assert.deepEqual(fs.readdirSync(path.join(f.config.trashMount, 'model-output')).map((name) => name.endsWith('.purging')), [true]);
      // While files are removed, the other process can still write; and it may remove the same files.
      const removeExact = f.storage.removeExact, admissible = f.processing.purgeStillAdmissible;
      let wrote = 0;
      // What is already out of the way is removed whatever is decided later: part of it may be gone.
      f.processing.purgeStillAdmissible = () => false;
      f.storage.removeExact = () => { throw Object.assign(new Error('synthetic I/O error'), { code: 'EIO' }); };
      reconcileStorageMutations(f.processing, f.storage);
      assert.equal(f.processing.getStorageMutation(mutation.id).status, 'intent', 'not removed yet, so not done');
      f.storage.removeExact = function removing(...args) { w.database.prepare("UPDATE storage_trash SET byte_size=byte_size WHERE id='none'").run(); w.storage.removeExact(...args); wrote += 1; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
      reconcileStorageMutations(f.processing, f.storage);
      f.storage.removeExact = removeExact;
      f.processing.purgeStillAdmissible = admissible;
      assert.equal(wrote, 1);
      assert.ok(f.processing.getTrash(trash.id).permanentlyDeletedAt);
      assert.deepEqual(fs.readdirSync(path.join(f.config.trashMount, 'model-output')), []);
    } else {
      reconcileStorageMutations(w.processing, w.storage);
      if (type === 'trash') stored.assertBinned(type); else stored.assertLive(type);
      if (type === 'trash') applyStorageMutation(f.processing, f.storage, stored.begin('restore'));
    }
    assert.equal(f.processing.getStorageMutation(mutation.id).status, 'complete', type);
  }
});

test('a journal that another process finishes just before this one gets the lock is left alone', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), w = worker(t, f), { applyStorageMutation } = require('../server/storageLifecycle');
  for (const type of ['trash', 'restore', 'purge']) {
    for (const step of [1, 2, 3]) {
      const note = `${type} ${step}`, item = await f.publishedTask(project, note), stored = storedEntity(f, item, 'output');
      if (type !== 'trash') applyStorageMutation(f.processing, f.storage, stored.begin('trash'));
      const mutation = stored.begin(type), transaction = w.processing.transaction;
      let steps = 0;
      w.processing.transaction = function locked(...args) {
        steps += 1;
        if (steps === step) {
          applyStorageMutation(f.processing, f.storage, mutation.id);
          if (type !== 'purge') applyStorageMutation(f.processing, f.storage, stored.begin(type === 'trash' ? 'restore' : 'trash'));
        }
        return transaction.apply(this, args);
      };
      assert.equal(applyStorageMutation(w.processing, w.storage, mutation).status, 'complete', note);
      w.processing.transaction = transaction;
      if (type !== 'purge') { if ((type === 'trash') === (steps >= step)) stored.assertLive(note); else stored.assertBinned(note); }
      else assert.deepEqual(f.database.prepare("SELECT COUNT(*) n FROM storage_trash WHERE entity_id=? AND permanently_deleted_at IS NULL").get(item.versionId).n, 0, note);
    }
  }
});

test('a purge whose path and set-aside path both exist removes neither', async (t) => {
  const f = await fixture(t), project = f.processing.createProject({ displayName: 'Project' }), item = await f.publishedTask(project), stored = storedEntity(f, item, 'output'), { applyStorageMutation } = require('../server/storageLifecycle');
  applyStorageMutation(f.processing, f.storage, stored.begin('trash'));
  const trash = f.processing.activeTrashForEntity('output', item.versionId), aside = path.join(f.config.trashMount, ...`${trash.relativePath}.purging`.split('/'));
  fs.mkdirSync(aside);
  fs.writeFileSync(path.join(aside, 'other.txt'), 'other');
  const mutation = stored.begin('purge');
  assert.throws(() => applyStorageMutation(f.processing, f.storage, mutation), { code: 'lifecycle_conflict' });
  assert.equal(f.processing.getStorageMutation(mutation.id).status, 'failed');
  stored.assertBinned('both');
  assert.deepEqual(f.tree(aside), { 'other.txt': 'other' });
  assert.throws(() => f.storage.setAsideForPurge('trash', trash.relativePath, `${trash.relativePath}.purging`), { code: 'lifecycle_conflict' });
  assert.throws(() => f.storage.setAsideForPurge('models', trash.relativePath, 'x'), { code: 'external_reference' });
});
