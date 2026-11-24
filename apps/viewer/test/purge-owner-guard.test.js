'use strict';

// Permanent deletion from the Recycle Bin, through the staff routes and the
// worker's maintenance, on a file database and real storage (Linux). `other` is
// a second connection to the same database, as the worker process has.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { purgeContainerTrash } = require('../server/containerLifecycle');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { applyStorageMutation, purgeExpiredTrash, reconcileStorageMutations } = require('../server/storageLifecycle');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const DAY = 86400_000, REFUSED = 'trash_owner_not_deleted';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-purge-owner-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'), datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0,
  };
  for (const location of Object.values(config).filter((value) => typeof value === 'string')) fs.mkdirSync(location, { recursive: true });
  const file = path.join(root, 'viewer.sqlite'), database = openDatabase(file), otherDatabase = openDatabase(file);
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database), other = new ProcessingRepository(otherDatabase);
  const storage = new StorageManager(config), otherStorage = new StorageManager(config);
  storage.initialize();
  otherStorage.initialize();
  const token = 'purge-owner-admin-token-00000000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:test', displayUnits: 'imperial',
    permissions: ['viewer.projects.write', 'viewer.datasets.write', 'viewer.processing.read', 'viewer.processing.write', 'viewer.processing.publish', 'viewer.storage.purge'],
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); otherDatabase.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  async function request(method, route, body = {}) {
    const response = await fetch(base + route, { method, body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `purge-owner-${sequence += 1}` } });
    const text = await response.text();
    return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : null };
  }
  const run = (sql, ...values) => otherDatabase.prepare(sql).run(...values);

  function photos(project, name = 'Photos', storageMode = 'managed') {
    const relativePath = crypto.randomUUID(), directory = path.join(config.datasetsMount, relativePath), body = Buffer.from(`${name} photo`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'photo.jpg'), body);
    const dataset = processing.createDataset({ projectId: project.id, displayName: name, storageMode, rootKey: 'datasets', relativePath });
    processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: body.length, sha256: digest(body), processingRole: 'image' }], digest(body));
    return processing.getDataset(dataset.id);
  }
  function output(task, name, status = 'ready_for_review') {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const relativeRoot = `${task.id}/${attempt.id}`, directory = path.join(config.modelsMount, ...relativeRoot.split('/')), files = { 'model.glb': `${name} mesh`, 'ortho.tif': `${name} ortho`, 'photo.jpg': `${name} camera photo` };
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), body);
    const asset = (kind, file) => ({ kind, rootKey: 'models', relativePath: `${relativeRoot}/${file}`, format: file.split('.')[1], byteSize: files[file].length, sha256: digest(files[file]), published: false });
    const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'ready',
      sourceLocator: { taskId: task.id, attemptId: attempt.id }, georef: {}, metadata: { note: name }, makeActive: false, assets: [asset('glb', 'model.glb'), asset('ortho', 'ortho.tif')],
      cameraPhotos: [{ filename: 'photo.jpg', rootKey: 'models', relativePath: `${relativeRoot}/photo.jpg`, contentType: 'image/jpeg', byteSize: files['photo.jpg'].length, sha256: digest(files['photo.jpg']) }] });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, attempt.id).id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.transitionAttempt(attempt.id, status, { progress: 1 });
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: task.projectId, relativePath: relativeRoot, byteSize: 10, assetCount: 2 });
    return { attempt, modelId: model.id, versionId };
  }
  // A task with an output in review, or published; `earlier`: names of older outputs it also has.
  async function model(project, name, { dataset = photos(project, `${name} photos`), publish = true, earlier = [] } = {}) {
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: name }), older = earlier.map((each) => ({ task, dataset, ...output(task, each, 'failed') })), item = { task, dataset, older, ...output(task, name) };
    if (publish) assert.equal((await request('POST', `/api/v1/attempts/${item.attempt.id}/publish`, { selectedAssetKinds: ['glb', 'ortho'] })).status, 200);
    return item;
  }
  const bin = (item) => processing.activeTrashForEntity('task', item.task.id), binOutput = (item) => processing.activeTrashForEntity('output', item.versionId);
  const remove = (item) => request('DELETE', `/api/v1/tasks/${item.task.id}`);
  const empty = (trash) => request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: trash.entityId });
  // Deletes as they leave a published task: half deleted, its output in the bin.
  async function halfDeleted({ shared = false, project = processing.createProject({ displayName: 'Project' }) } = {}) {
    const item = await model(project, 'Published');
    if (shared) item.sharer = processing.createTask({ projectId: project.id, datasetId: item.dataset.id, displayName: 'Sharer' });
    assert.equal((await remove(item)).status, shared ? 200 : 409);
    assert.deepEqual([processing.getTask(item.task.id).status, processing.getModelOutput(item.versionId).status, Boolean(bin(item))], ['draft', 'trashed', true]);
    return item;
  }
  const past = (days = 31) => run('UPDATE storage_trash SET purge_after=? WHERE permanently_deleted_at IS NULL', new Date(Date.now() - (days - 30) * DAY).toISOString());
  const maintenance = () => purgeExpiredTrash(other, otherStorage, { actor: 'worker' });
  const files = (directory = root) => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('viewer.sqlite')).map((entry) => path.join(entry.parentPath, entry.name)).sort()
    .map((name) => [path.relative(directory, name), fs.readFileSync(name).toString('base64')]));
  const rows = () => Object.fromEntries(['projects', 'processing_tasks', 'datasets', 'dataset_files', 'model_outputs', 'models', 'model_versions', 'model_assets', 'model_camera_photos', 'container_trash_members']
    .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const everything = () => ({ files: files(), rows: rows(), purged: database.prepare('SELECT id,purge_started_at,permanently_deleted_at FROM storage_trash ORDER BY id').all(), purges: database.prepare("SELECT id FROM storage_mutations WHERE mutation_type='purge'").all() });
  const gone = (item) => ({ files: Object.keys(files()).filter((name) => name.includes(item.versionId) || name.includes(item.attempt.id)).length,
    assets: database.prepare('SELECT COUNT(*) n FROM model_assets WHERE version_id=?').get(item.versionId).n, cameras: database.prepare('SELECT COUNT(*) n FROM model_camera_photos WHERE version_id=?').get(item.versionId).n,
    purged: Boolean(database.prepare('SELECT purged_at FROM processing_tasks WHERE id=?').get(item.task.id).purged_at) });
  const revive = (item) => run("UPDATE processing_tasks SET status='draft' WHERE id=?", item.task.id);
  // Runs `action` in the other process right before this repository's method.
  function before(target, method, action) {
    const original = target[method];
    target[method] = function hooked(...args) { target[method] = original; action(...args); return original.apply(target, args); };
  }
  return { root, config, database, otherDatabase, run, processing, other, storage, otherStorage, request, photos, output, model, bin, binOutput, remove, empty, halfDeleted, past, maintenance, files, everything, gone, revive, before,
    project: (displayName = 'Project') => processing.createProject({ displayName }) };
}
const PURGED = { files: 0, assets: 0, cameras: 0, purged: true }, KEPT = { files: 3, assets: 2, cameras: 1, purged: false };
const refused = (results) => assert.deepEqual(results.map((item) => [item.status, item.errorCode]), results.map(() => ['skipped', REFUSED]));

for (const shared of [false, true]) {
  test(`a half-deleted task loses nothing, with its photos ${shared ? 'shared' : 'its own'}`, async (t) => {
    const f = await fixture(t), item = await f.halfDeleted({ shared });
    f.past();
    const before = f.everything();
    for (let pass = 0; pass < 2; pass += 1) { const results = f.maintenance(); assert.equal(results.length, 1); refused(results); }
    for (const trash of [f.bin(item), f.binOutput(item)]) {
      const response = await f.empty(trash);
      assert.deepEqual([response.status, response.body.code], [409, REFUSED]);
      assert.match(response.body.error, /not fully in the Recycle Bin/);
    }
    assert.deepEqual(f.everything(), before);
    assert.deepEqual(f.gone(item), KEPT);
  });

  test(`archiving a half-deleted task does not let its purge through, with its photos ${shared ? 'shared' : 'its own'}`, async (t) => {
    const f = await fixture(t), item = await f.halfDeleted({ shared });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.equal((await f.request('POST', `/api/v1/tasks/${item.task.id}/archive`)).status, 200);
    f.past();
    const before = f.everything();
    refused(f.maintenance());
    assert.equal((await f.empty(f.bin(item))).body.code, REFUSED);
    assert.deepEqual(f.everything(), before);
  });
}

test('a half-deleted project loses nothing, also when the delete answered 200', async (t) => {
  for (const shared of [false, true]) {
    const f = await fixture(t), project = f.project(), first = await f.model(project, 'First'), second = await f.model(project, 'Second', shared ? { dataset: first.dataset } : {});
    assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, shared ? 200 : 409);
    f.past();
    const before = f.everything(), trash = f.processing.activeTrashForEntity('project', project.id);
    refused(f.maintenance());
    for (const item of [trash, f.bin(first), f.binOutput(first)]) assert.equal((await f.empty(item)).body.code, REFUSED);
    assert.deepEqual(f.everything(), before);
    assert.deepEqual([f.gone(first), f.gone(second)], [KEPT, KEPT]);
  }
});

test('fully deleted tasks, projects, outputs and photos still purge at their date, and earlier by hand', async (t) => {
  const f = await fixture(t), project = f.project();
  const task = await f.model(project, 'Task', { publish: false }), manual = await f.model(project, 'Manual', { publish: false });
  const dataset = f.photos(project, 'Unused'), external = f.photos(project, 'External', 'external_reference');
  const live = await f.model(project, 'Live', { earlier: ['Old'] }), [old] = live.older;
  const inProject = await f.model(f.project('Other'), 'In project', { publish: false });
  for (const item of [task, manual]) assert.equal((await f.remove(item)).status, 200);
  for (const route of [`datasets/${dataset.id}`, `datasets/${external.id}`, `processing/outputs/${old.versionId}`, `projects/${inProject.task.projectId}`]) assert.equal((await f.request('DELETE', `/api/v1/${route}`)).status, 200, route);
  assert.deepEqual(f.maintenance(), [], 'not past its date');
  assert.equal((await f.empty(f.bin(manual))).status, 204);
  assert.deepEqual(f.gone(manual), PURGED);
  const kept = f.files();
  f.past();
  const results = f.maintenance();
  assert.deepEqual(results.map((item) => item.status), Array(5).fill('complete'));
  for (const item of [task, inProject]) assert.deepEqual(f.gone(item), PURGED);
  assert.deepEqual(f.gone(old), { files: 0, assets: 0, cameras: 0, purged: false });
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM storage_trash WHERE permanently_deleted_at IS NULL').get().n, 0);
  assert.ok(f.database.prepare('SELECT purged_at FROM projects WHERE id=?').get(inProject.task.projectId).purged_at);
  const left = f.files();
  assert.deepEqual(Object.keys(left).filter((name) => name.startsWith('trash')), []);
  for (const [name, bytes] of Object.entries(left)) assert.equal(bytes, kept[name], name);
  assert.deepEqual(f.gone(live), KEPT);
});

test('items that may not be purged never keep the rest from being purged', async (t) => {
  const f = await fixture(t), project = f.project();
  for (let index = 0; index < 3; index += 1) await f.halfDeleted({ project: f.project(`Half ${index}`) });
  const item = await f.model(project, 'Deleted', { publish: false });
  assert.equal((await f.remove(item)).status, 200);
  f.past();
  const trash = f.bin(item), list = f.other.expiredTrash();
  f.other.expiredTrash = () => [...list.filter((each) => each.id !== trash.id), trash];
  const results = purgeExpiredTrash(f.other, f.otherStorage, { limit: 1 });
  assert.deepEqual(results.map((result) => result.status).sort(), ['complete', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(f.gone(item), PURGED);
});

test('a date that moved, or a task that came back, after maintenance read the list is seen when the purge starts', async (t) => {
  const actions = {
    trash_not_expired: (f) => f.past(-30),
    [REFUSED]: (f, item) => f.revive(item),
  };
  for (const [code, action] of Object.entries(actions)) for (const at of ['expiredTrash', 'beginContainerPurge']) {
    const f = await fixture(t), item = await f.model(f.project(), 'Deleted', { publish: false });
    assert.equal((await f.remove(item)).status, 200);
    f.past();
    let before;
    const act = () => { action(f, item); before = f.everything(); };
    if (at === 'expiredTrash') { const list = f.other.expiredTrash(); f.other.expiredTrash = () => { act(); return list; }; } else f.before(f.other, at, act);
    assert.deepEqual(f.maintenance().map((result) => [result.status, result.errorCode]), [['skipped', code]], `${code} ${at}`);
    assert.deepEqual(f.everything(), before);
  }
});

test('a single output or photo set whose date moved after maintenance read the list is not purged', async (t) => {
  const f = await fixture(t), project = f.project(), [old, loose] = (await f.model(project, 'Live', { earlier: ['Old', 'Loose'] })).older;
  const dataset = f.photos(project, 'Unused'), external = f.photos(project, 'External', 'external_reference');
  f.database.prepare("UPDATE model_outputs SET storage_mode='external_reference' WHERE id=?").run(loose.versionId);
  for (const route of [`datasets/${dataset.id}`, `datasets/${external.id}`, `processing/outputs/${old.versionId}`, `processing/outputs/${loose.versionId}`]) assert.equal((await f.request('DELETE', `/api/v1/${route}`)).status, 200);
  f.past();
  const list = f.other.expiredTrash();
  f.past(-30);
  const before = f.everything();
  f.other.expiredTrash = () => list;
  assert.deepEqual(f.maintenance().map((item) => item.errorCode), Array(4).fill('trash_not_expired'));
  assert.deepEqual(f.everything(), before);
});

test('photos that came into use again after the list was read stop the container purge in the transaction that starts it', async (t) => {
  const f = await fixture(t), project = f.project(), item = await f.model(project, 'Deleted', { publish: false });
  const archived = f.processing.createTask({ projectId: project.id, datasetId: item.dataset.id, displayName: 'Archived' });
  assert.equal((await f.request('POST', `/api/v1/tasks/${archived.id}/archive`)).status, 200);
  assert.equal((await f.remove(item)).status, 200);
  f.past();
  let before;
  f.before(f.other, 'beginContainerPurge', () => { f.revive({ task: archived }); before = f.everything(); });
  assert.deepEqual(f.maintenance().map((result) => result.status), ['failed']);
  assert.deepEqual(f.everything(), before);
});

test('a purge that meets a running delete is refused at every step of it', async (t) => {
  // The delete runs on the staff connection; the purge on the other one.
  const attempt = (f, work) => { try { return work() ? 'purged' : 'refused'; } catch (error) { assert.equal(error.code, REFUSED); return 'refused'; } };
  for (const step of ['archiveModelOutput', 'moveExact', 'completeStorageMutation', 'addContainerTrashMember']) {
    const f = await fixture(t), item = await f.model(f.project(), 'Deleting', { publish: false });
    const bytes = Object.values(f.files()).sort();
    let outcome;
    f.before(step === 'moveExact' ? f.storage : f.processing, step, () => {
      f.past();
      const single = f.other.activeTrashForEntity('output', item.versionId), container = f.other.activeTrashForEntity('task', item.task.id);
      outcome = [single ? attempt(f, () => f.other.beginPurgeMutation(single.id, 'ops:other')) : 'refused'];
      if (step !== 'addContainerTrashMember') outcome.push(attempt(f, () => purgeContainerTrash(f.other, f.otherStorage, container.id, 'ops:other')));
      outcome.push(...f.maintenance().map((result) => result.status).filter((status) => step !== 'addContainerTrashMember' && status === 'complete'));
      assert.equal(f.other.getModelOutput(item.versionId).status === 'trashed', step === 'addContainerTrashMember');
      f.run('UPDATE storage_trash SET purge_after=? WHERE permanently_deleted_at IS NULL', new Date(Date.now() + 30 * DAY).toISOString());
    });
    const response = await f.remove(item);
    if (step !== 'addContainerTrashMember') {
      assert.equal(response.status, 200, step);
      assert.deepEqual(outcome, ['refused', 'refused'], step);
      assert.deepEqual(Object.values(f.files()).sort(), bytes, step);
    } else assert.equal(outcome[0], 'refused');
  }
});

test('an output a stopped delete left outside the bin item is kept, also after the task is restored', async (t) => {
  const f = await fixture(t), item = await f.model(f.project(), 'Deleting', { publish: false });
  f.processing.addContainerTrashMember = () => { throw new Error('the process stopped here'); };
  assert.equal((await f.remove(item)).status, 409);
  delete f.processing.addContainerTrashMember;
  f.run('UPDATE storage_trash SET purge_after=? WHERE id=?', new Date(Date.now() - DAY).toISOString(), f.binOutput(item).id);
  const before = f.everything();
  refused(f.maintenance());
  assert.equal((await f.empty(f.binOutput(item))).body.code, REFUSED);
  assert.deepEqual(f.everything(), before);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.bin(item).id}/restore`)).status, 200);
  assert.equal(f.processing.getTask(item.task.id).status, 'ready_for_review');
  const restored = f.everything();
  refused(f.maintenance());
  assert.deepEqual(f.everything(), restored);
  // The way out: restore it, or delete the task for good.
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.binOutput(item).id}/restore`)).status, 200);
  assert.deepEqual(f.gone(item), KEPT);
});

test('an output deleted on its own before its task still purges at its own date', async (t) => {
  const f = await fixture(t), item = await f.model(f.project(), 'Task', { publish: false, earlier: ['Old'] }), [old] = item.older;
  assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${old.versionId}`)).status, 200);
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal((await f.remove(item)).status, 200);
  f.run('UPDATE storage_trash SET purge_after=? WHERE id=?', new Date(Date.now() - DAY).toISOString(), f.binOutput(old).id);
  assert.deepEqual(f.maintenance().map((result) => result.status), ['complete']);
  assert.deepEqual([f.gone(old), f.gone(item)], [{ ...PURGED, purged: false }, KEPT]);
});

test('photos of a project a stopped delete left outside the bin item are kept until the project is purged', async (t) => {
  const f = await fixture(t), project = f.project(), dataset = f.photos(project);
  f.before(f.processing, 'addContainerTrashMember', () => { throw new Error('the process stopped here'); });
  assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 409);
  const trash = f.processing.activeTrashForEntity('dataset', dataset.id), root = f.processing.activeTrashForEntity('project', project.id);
  f.run('UPDATE storage_trash SET purge_after=? WHERE id=?', new Date(Date.now() - DAY).toISOString(), trash.id);
  const before = f.everything();
  refused(f.maintenance());
  assert.deepEqual(f.everything(), before);
  f.past();
  f.maintenance();
  assert.ok(f.processing.getTrash(root.id).permanentlyDeletedAt);
  f.maintenance();
  assert.ok(f.processing.getTrash(trash.id).permanentlyDeletedAt);
  assert.deepEqual(f.files(), {});
});

test('maintenance does not purge what a restore is bringing back', async (t) => {
  for (const withOutput of [true, false]) {
    const f = await fixture(t), project = f.project();
    const item = withOutput ? await f.model(project, 'Restoring', { publish: false }) : { dataset: f.photos(project) };
    item.task ||= f.processing.createTask({ projectId: project.id, datasetId: item.dataset.id, displayName: 'No output' });
    const bytes = f.files();
    assert.equal((await f.remove(item)).status, 200);
    f.past();
    let results;
    f.before(f.processing, 'restoreMetadataEntity', () => { results = f.maintenance(); });
    assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.bin(item).id}/restore`)).status, 200);
    assert.equal(results.length, 1);
    refused(results);
    assert.deepEqual(f.files(), bytes);
    assert.notEqual(f.processing.getTask(item.task.id).status, 'archived');
  }
});

test('photos restored for another deleted task do not keep a fully deleted task from being purged', async (t) => {
  const f = await fixture(t), project = f.project(), dataset = f.photos(project), create = (displayName) => ({ task: f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName }) });
  const first = create('First'), second = create('Second');
  for (const item of [first, second]) assert.equal((await f.remove(item)).status, 200);
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.bin(first).id}/restore`)).status, 200);
  f.past();
  assert.deepEqual(f.maintenance().map((item) => item.status), ['complete']);
  assert.ok(f.database.prepare('SELECT purged_at FROM processing_tasks WHERE id=?').get(second.task.id).purged_at);
  assert.equal(f.processing.getDataset(dataset.id).status, 'finalized');
});

test('a purge that crashed is finished while its task is still deleted', async (t) => {
  for (const point of ['beginPurgeMutation', 'markStorageMutationFsApplied', 'completeStorageMutation', 'purgeMetadataEntity']) {
    const f = await fixture(t), item = await f.model(f.project(), 'Deleted', { publish: false });
    assert.equal((await f.remove(item)).status, 200);
    f.past();
    f.before(f.other, point, () => { throw new Error('crash'); });
    assert.deepEqual(f.maintenance().map((result) => result.status), ['failed'], point);
    assert.ok(f.processing.getTrash(f.bin(item).id).purgeStartedAt, point);
    reconcileStorageMutations(f.other, f.otherStorage);
    f.maintenance();
    assert.deepEqual(f.gone(item), PURGED, point);
    assert.deepEqual(f.files(), {}, point);
  }
});

test('a purge that crashed after an early manual empty is finished before its date', async (t) => {
  const f = await fixture(t), item = await f.model(f.project(), 'Deleted', { publish: false });
  assert.equal((await f.remove(item)).status, 200);
  f.before(f.processing, 'beginPurgeMutation', () => { throw Object.assign(new Error('crash'), { status: 500 }); });
  assert.equal((await f.empty(f.bin(item))).status, 500);
  assert.deepEqual(f.maintenance().map((result) => result.status), ['complete']);
  assert.deepEqual(f.gone(item), PURGED);
});

test('a purge an earlier version began on a half-deleted task stops where it is', async (t) => {
  for (const status of ['intent', 'fs_applied', 'failed']) {
    const f = await fixture(t), item = await f.halfDeleted(), trash = f.binOutput(item), id = crypto.randomUUID(), at = new Date().toISOString();
    f.past();
    f.run('UPDATE storage_trash SET purge_started_at=? WHERE id=?', at, f.bin(item).id);
    f.run("INSERT INTO storage_mutations(id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,status,actor,created_at,updated_at) VALUES (?,'purge','output',?,?,'trash',?,?,'worker',?,?)", id, item.versionId, trash.id, trash.relativePath, status, at, at);
    // Its files are only partly left.
    fs.rmSync(path.join(f.config.trashMount, trash.relativePath, 'ortho.tif'));
    if (status === 'fs_applied') fs.rmSync(path.join(f.config.trashMount, trash.relativePath), { recursive: true });
    const before = f.everything();
    reconcileStorageMutations(f.other, f.otherStorage);
    refused(f.maintenance());
    assert.equal((await f.empty(f.bin(item))).body.code, REFUSED);
    assert.equal(f.processing.getStorageMutation(id).status, 'failed', 'not retried every hour');
    const retried = await f.request('POST', `/api/v1/storage/mutations/${id}/retry`);
    assert.deepEqual([retried.status, retried.body.code], [409, REFUSED]);
    assert.match(retried.body.error, /not fully in the Recycle Bin/);
    assert.deepEqual(f.everything(), before);
  }
});

test('a purge stops when its task comes back partway', async (t) => {
  const points = {
    beginPurgeMutation: { f: (f) => f.other, kept: KEPT },
    removeExact: { f: (f) => f.otherStorage, kept: { ...KEPT, files: 0 } }, // too late for this output's files, not for its records
  };
  for (const [method, { f: target, kept }] of Object.entries(points)) {
    const f = await fixture(t), item = await f.model(f.project(), 'Deleted', { publish: false });
    assert.equal((await f.remove(item)).status, 200);
    f.past();
    f.before(target(f), method, () => f.revive(item));
    assert.deepEqual(f.maintenance().map((result) => result.errorCode), [REFUSED]);
    reconcileStorageMutations(f.other, f.otherStorage);
    refused(f.maintenance());
    assert.deepEqual(f.gone(item), kept);
    assert.equal(f.processing.getDataset(item.dataset.id).status, 'trashed');
    assert.equal(Object.keys(f.files(f.config.trashMount)).filter((name) => name.includes(item.dataset.id)).length, 1);
  }
});

test('a project purge stops before its records when one of its tasks comes back', async (t) => {
  const f = await fixture(t), project = f.project(), first = await f.model(project, 'First', { publish: false }), second = await f.model(project, 'Second', { publish: false });
  assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 200);
  f.past();
  f.before(f.other, 'purgeMetadataEntity', () => f.revive(second));
  refused(f.maintenance());
  for (const item of [first, second]) assert.equal(f.database.prepare('SELECT purged_at FROM processing_tasks WHERE id=?').get(item.task.id).purged_at, null);
});

test('a project is not purged while a task in it, or the project itself, is not deleted', async (t) => {
  const cases = {
    'a task outside the bin item': (f, project, item) => f.run("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) SELECT 'stray',project_id,dataset_id,'Stray','archived',created_at,updated_at FROM processing_tasks WHERE id=?", item.task.id),
    'the project is live': (f, project) => f.run("UPDATE projects SET status='active' WHERE id=?", project.id),
    'the project was archived again': (f, project) => f.run("UPDATE projects SET archived_at=? WHERE id=?", new Date(Date.now() + 1000).toISOString(), project.id),
    'a task has lost its bin item': (f, project, item) => f.run("UPDATE storage_trash SET permanently_deleted_at=? WHERE entity_type='task' AND entity_id=?", new Date().toISOString(), item.task.id),
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = await fixture(t), project = f.project(), item = await f.model(project, 'Deleted', { publish: false });
    assert.equal((await f.request('DELETE', `/api/v1/projects/${project.id}`)).status, 200);
    change(f, project, item);
    f.past();
    const before = f.everything();
    refused(f.maintenance());
    assert.deepEqual(f.everything(), before, name);
  }
});

test('an earlier output of a half-deleted task is kept too, and records without files are treated alike', async (t) => {
  const f = await fixture(t), item = await f.model(f.project(), 'Published', { earlier: ['Old', 'Loose'] }), [old, loose] = item.older;
  f.database.prepare("UPDATE model_outputs SET storage_mode='external_reference' WHERE id=?").run(loose.versionId);
  for (const output of [old, loose]) assert.equal((await f.request('DELETE', `/api/v1/processing/outputs/${output.versionId}`)).status, 200);
  assert.equal((await f.remove(item)).status, 409);
  f.past();
  const before = f.everything(), results = f.maintenance();
  assert.equal(results.length, 3);
  refused(results);
  for (const output of [old, loose]) assert.equal((await f.empty(f.binOutput(output))).body.code, REFUSED);
  assert.deepEqual(f.everything(), before);
});

test('a photo set purge that had begun stops while a live task uses the photos', async (t) => {
  const f = await fixture(t), project = f.project(), dataset = f.photos(project), task = f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Archived' });
  assert.equal((await f.request('POST', `/api/v1/tasks/${task.id}/archive`)).status, 200);
  assert.equal((await f.request('DELETE', `/api/v1/datasets/${dataset.id}`)).status, 200);
  const mutation = f.processing.beginPurgeMutation(f.processing.activeTrashForEntity('dataset', dataset.id).id, 'ops:test');
  f.revive({ task });
  const before = f.files();
  assert.deepEqual(reconcileStorageMutations(f.other, f.otherStorage).map((item) => item.errorCode), [REFUSED]);
  assert.throws(() => { f.run("UPDATE storage_mutations SET status='intent' WHERE id=?", mutation.id); applyStorageMutation(f.processing, f.storage, mutation.id); }, { code: REFUSED });
  assert.deepEqual(f.files(), before);
  assert.equal(f.processing.getStorageMutation(mutation.id).status, 'failed');
});

test('a refused purge moves no photos to another bin item', async (t) => {
  const f = await fixture(t), project = f.project(), dataset = f.photos(project), item = await f.model(project, 'First', { dataset, publish: false });
  const second = { task: f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Second' }) };
  for (const task of [second, item]) assert.equal((await f.remove(task)).status, 200);
  // The output came back on its own.
  assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.binOutput(item).id}/restore`)).status, 200);
  f.past();
  f.run('UPDATE storage_trash SET purge_after=? WHERE id=?', new Date(Date.now() + DAY).toISOString(), f.bin(second).id);
  const before = f.everything();
  refused(f.maintenance());
  assert.equal((await f.empty(f.bin(item))).body.code, REFUSED);
  assert.deepEqual(f.everything(), before);
});
