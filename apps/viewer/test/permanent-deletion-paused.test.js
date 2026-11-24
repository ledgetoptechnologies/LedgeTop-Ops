'use strict';

// Permanent deletion is paused: no path removes files or records of anything
// in the Recycle Bin, or changes its item or journal. Staff routes, the real
// worker, a file database and real storage (Linux).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
const { purgeProjectBoundary } = require('../server/propertyLinesBoundary');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { applyStorageMutation, purgeExpiredTrash, reconcileStorageMutations } = require('../server/storageLifecycle');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const DAY = 86400_000, CODE = 'permanent_deletion_paused', MESSAGE = 'Permanent deletion is paused while a fix is finished. Items stay in the Recycle Bin.';
const paused = { code: CODE, message: MESSAGE };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-purge-pause-'));
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
  const token = 'purge-pause-admin-token-00000000000000000';
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
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `purge-pause-${sequence += 1}` } });
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
  const past = () => run('UPDATE storage_trash SET purge_after=? WHERE permanently_deleted_at IS NULL', new Date(Date.now() - DAY).toISOString());
  const files = () => Object.fromEntries(fs.readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('viewer.sqlite')).map((entry) => path.join(entry.parentPath, entry.name)).sort()
    .map((name) => [path.relative(root, name), fs.readFileSync(name).toString('base64')]));
  // Every file, and every record a purge touches, including bin items with their dates and journals with their state.
  const everything = () => ({ files: files(), ...Object.fromEntries(['projects', 'project_folders', 'processing_tasks', 'datasets', 'dataset_files', 'model_outputs', 'models', 'model_versions', 'model_assets', 'model_camera_photos', 'storage_trash', 'container_trash_members', 'storage_mutations']
    .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) });
  const trash = (type, id) => processing.activeTrashForEntity(type, id);
  const empty = (item) => request('DELETE', `/api/v1/storage/trash/${item.id}`, { typedId: item.entityId });
  const del = async (route) => { const response = await request('DELETE', `/api/v1/${route}`); assert.equal(response.status, 200, route); };
  // One deleted item of every kind, all past their date.
  async function fullBin() {
    const project = processing.createProject({ displayName: 'Project' });
    const task = await model(project, 'Task', { publish: false }), live = await model(project, 'Live', { earlier: ['Old', 'Loose'] }), [old, loose] = live.older;
    database.prepare("UPDATE model_outputs SET storage_mode='external_reference' WHERE id=?").run(loose.versionId);
    const dataset = photos(project, 'Unused'), external = photos(project, 'External', 'external_reference');
    const gone = await model(processing.createProject({ displayName: 'Deleted project' }), 'In project', { publish: false });
    const boundary = path.join(config.modelsMount, 'property-lines', gone.task.projectId);
    fs.mkdirSync(boundary, { recursive: true });
    fs.writeFileSync(path.join(boundary, 'manifest.json'), '{}');
    await del(`tasks/${task.task.id}`);
    for (const route of [`datasets/${dataset.id}`, `datasets/${external.id}`, `processing/outputs/${old.versionId}`, `processing/outputs/${loose.versionId}`, `projects/${gone.task.projectId}`]) await del(route);
    past();
    return { task: trash('task', task.task.id), project: trash('project', gone.task.projectId), dataset: trash('dataset', dataset.id), external: trash('dataset', external.id), output: trash('output', old.versionId), loose: trash('output', loose.versionId),
      memberOutput: trash('output', task.versionId), memberDataset: trash('dataset', task.dataset.id), memberTask: trash('task', gone.task.id) };
  }
  // A purge journal as an earlier version left it.
  function journal(item, status, at = new Date().toISOString()) {
    const id = crypto.randomUUID();
    run("INSERT INTO storage_mutations(id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,status,actor,created_at,updated_at) VALUES (?,'purge',?,?,?,'trash',?,?,'worker',?,?)", id, item.entityType, item.entityId, item.id, item.relativePath, status, at, at);
    return id;
  }
  return { root, config, database, processing, other, storage, otherStorage, request, run, photos, model, past, files, everything, trash, empty, del, fullBin, journal, project: (displayName = 'Project') => processing.createProject({ displayName }) };
}

test('emptying an item of any kind by hand answers 409 and changes nothing', async (t) => {
  const f = await fixture(t), bin = await f.fullBin(), before = f.everything();
  for (const [kind, item] of Object.entries(bin)) {
    const response = await f.empty(item);
    assert.deepEqual([response.status, response.body?.code, response.body?.error], [409, CODE, MESSAGE], kind);
    assert.deepEqual(f.everything(), before, kind);
  }
  assert.equal((await f.request('DELETE', `/api/v1/storage/trash/${bin.task.id}`, { typedId: 'wrong' })).body.code, 'typed_confirmation_required');
});

test('maintenance purges nothing past its date, and leaves every date', async (t) => {
  const f = await fixture(t), bin = await f.fullBin(), before = f.everything();
  for (let pass = 0; pass < 2; pass += 1) {
    const results = purgeExpiredTrash(f.other, f.otherStorage, { actor: 'worker', onPurged: () => assert.fail('purged') });
    assert.deepEqual(results.map((item) => [item.status, item.errorCode]), Array(6).fill(['skipped', CODE]));
    assert.deepEqual(new Set(results.map((item) => item.trashId)), new Set(['task', 'project', 'dataset', 'external', 'output', 'loose'].map((kind) => bin[kind].id)));
    assert.deepEqual(f.everything(), before);
  }
});

test('photos shared with another deleted task stay in the item they are in', async (t) => {
  const f = await fixture(t), project = f.project(), create = (dataset, displayName) => f.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName });
  const shared = f.photos(project, 'Shared'), alone = f.photos(project, 'Alone'), tasks = [create(shared, 'First'), create(shared, 'Second'), create(alone, 'Third')];
  for (const task of tasks) await f.del(`tasks/${task.id}`);
  f.run('DELETE FROM container_trash_members WHERE member_trash_id=?', f.trash('dataset', alone.id).id);
  f.past();
  const before = f.everything();
  purgeExpiredTrash(f.other, f.otherStorage);
  assert.throws(() => purgeContainerTrash(f.other, f.otherStorage, f.trash('task', tasks[1].id).id, 'ops:test'), paused);
  assert.deepEqual(f.everything(), before);
});

test('a half-deleted published task keeps its output', async (t) => {
  const f = await fixture(t), item = await f.model(f.project(), 'Published');
  assert.equal((await f.request('DELETE', `/api/v1/tasks/${item.task.id}`)).status, 409);
  f.past();
  const before = f.everything();
  purgeExpiredTrash(f.other, f.otherStorage);
  assert.equal((await f.empty(f.trash('task', item.task.id))).body.code, CODE);
  assert.deepEqual(f.everything(), before);
});

test('a purge an earlier version had started is not resumed, whatever its journals say', async (t) => {
  const f = await fixture(t), bin = await f.fullBin();
  f.run('UPDATE storage_trash SET purge_started_at=? WHERE id IN (?,?)', new Date().toISOString(), bin.task.id, bin.project.id);
  const journals = { intent: f.journal(bin.memberOutput, 'intent'), fs_applied: f.journal(bin.output, 'fs_applied'), failed: f.journal(bin.dataset, 'failed'), dataset: f.journal(bin.memberDataset, 'intent') };
  // Files already gone, recorded or not.
  for (const item of [bin.output, bin.memberDataset]) fs.rmSync(path.join(f.config.trashMount, item.relativePath), { recursive: true });
  const before = f.everything();
  assert.deepEqual(reconcileStorageMutations(f.other, f.otherStorage), []);
  purgeExpiredTrash(f.other, f.otherStorage);
  for (const item of [bin.task, bin.project, bin.output, bin.memberOutput]) assert.equal((await f.empty(item)).body.code, CODE);
  for (const id of [journals.intent, journals.fs_applied, journals.dataset]) assert.throws(() => applyStorageMutation(f.other, f.otherStorage, id), paused);
  const retried = await f.request('POST', `/api/v1/storage/mutations/${journals.failed}/retry`);
  assert.deepEqual([retried.status, retried.body?.code, retried.body?.error], [409, CODE, MESSAGE]);
  assert.deepEqual(f.everything(), before);
});

test('paused purge journals do not hold up the moves behind them', async (t) => {
  const f = await fixture(t), bin = await f.fullBin(), dataset = f.photos(f.project('Other'), 'Moving');
  for (let index = 0; index < 25; index += 1) {
    const item = { ...bin.output, entityId: `other-${index}` };
    f.journal(item, 'intent', '2020-01-01T00:00:00.000Z');
  }
  const mutation = f.processing.beginTrashMutation(dataset.id, 'ops:test');
  assert.deepEqual(reconcileStorageMutations(f.other, f.otherStorage).map((item) => [item.id, item.status]), [[mutation.id, 'complete']]);
  assert.equal(f.processing.getDataset(dataset.id).status, 'trashed');
});

test('every function that removes something for a purge refuses on its own, before any effect', async (t) => {
  const f = await fixture(t), bin = await f.fullBin(), p = f.processing;
  f.run('UPDATE storage_trash SET purge_started_at=? WHERE id=?', new Date().toISOString(), bin.task.id);
  const applied = f.journal(bin.output, 'fs_applied'), failed = f.journal(bin.dataset, 'failed'), before = f.everything();
  const calls = {
    beginContainerPurge: () => p.beginContainerPurge(bin.project.id, 'ops:test'),
    beginPurgeMutation: () => p.beginPurgeMutation(bin.memberDataset.id, 'ops:test', { containerId: bin.task.id }),
    markTrashPurged: () => p.markTrashPurged(bin.external.id, 'ops:test'),
    purgeMetadataOutput: () => p.purgeMetadataOutput(bin.loose.id, 'ops:test'),
    purgeMetadataEntity: () => p.purgeMetadataEntity(bin.memberTask.id, 'ops:test'),
    completeStorageMutation: () => p.completeStorageMutation(applied),
    retryStorageMutation: () => p.retryStorageMutation(failed, 'ops:test'),
    removeExact: () => f.storage.removeExact('trash', bin.dataset.relativePath),
    purgeTrash: () => f.storage.purgeTrash(bin.dataset.relativePath),
    purgeProjectBoundary: () => purgeProjectBoundary(f.storage, bin.project.entityId),
    purgeContainerTrash: () => purgeContainerTrash(p, f.storage, bin.task.id, 'ops:test'),
  };
  for (const [name, call] of Object.entries(calls)) {
    assert.throws(call, paused, name);
    assert.deepEqual(f.everything(), before, name);
  }
});

test('everything in the bin can still be restored without loss, also past its date', async (t) => {
  const f = await fixture(t), project = f.project(), item = await f.model(project, 'Task', { publish: false }), inProject = await f.model(f.project('Other'), 'In project', { publish: false }), dataset = f.photos(project, 'Unused'), live = await f.model(project, 'Live', { earlier: ['Old'] });
  const bytes = f.files();
  const targets = [['task', item.task.id, `tasks/${item.task.id}`], ['project', inProject.task.projectId, `projects/${inProject.task.projectId}`], ['dataset', dataset.id, `datasets/${dataset.id}`], ['output', live.older[0].versionId, `processing/outputs/${live.older[0].versionId}`]];
  for (const [, , route] of targets) await f.del(route);
  f.past();
  purgeExpiredTrash(f.other, f.otherStorage);
  for (const [type, id] of targets) assert.equal((await f.request('POST', `/api/v1/storage/trash/${f.trash(type, id).id}/restore`)).status, 200, type);
  assert.deepEqual(f.files(), bytes);
  assert.deepEqual([f.processing.getTask(item.task.id).status, f.processing.getTask(inProject.task.id).status, f.processing.getDataset(dataset.id).status], ['ready_for_review', 'ready_for_review', 'finalized']);
});

test('the worker starts, purges nothing, and logs only a count and a code', async (t) => {
  const f = await fixture(t), bin = await f.fullBin();
  f.journal(bin.output, 'intent');
  const before = f.everything();
  const child = spawn(process.execPath, ['server/worker.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1', NODE_ENV: 'development', DATA_DIR: f.root, DATABASE_PATH: path.join(f.root, 'viewer.sqlite'),
    DATASETS_MOUNT: f.config.datasetsMount, MODELS_MOUNT: f.config.modelsMount, CACHE_MOUNT: f.config.cacheMount, TRASH_MOUNT: f.config.trashMount, DATASET_IMPORT_MOUNT: f.config.datasetImportMount,
    PROCESSING_PLATFORM_ENABLED: 'true', LOCAL_DERIVATIVES_ENABLED: 'false', MESH_DERIVATIVES_ENABLED: 'false', SESSION_SECRET: 'session-secret-at-least-thirty-two-characters', EMERGENCY_ADMIN_ENABLED: 'false', SERVICE_AUTH_KEYS_JSON: '',
    SERVICE_AUTH_SECRET: 'service-auth-secret-at-least-thirty-two-characters', PROVIDER_CREDENTIALS_KEY: '0'.repeat(64) } });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null && !log.includes('Recycle Bin purge')) await new Promise((resolve) => { setTimeout(resolve, 50); });
  if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); }); }
  assert.deepEqual(log.split('\n').filter((line) => line.includes('Recycle Bin')), [`Recycle Bin purge skipped: items=6 journals=1 code=${CODE}`], log);
  assert.deepEqual(f.everything(), before);
});
