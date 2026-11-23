'use strict';

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
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { purgeExpiredTrash } = require('../server/storageLifecycle');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

test('duplicate upload dataset names return a recoverable conflict without creating another dataset', async t => {
  // Dataset creation changes metadata only; Linux mount qualification belongs
  // to the filesystem lifecycle cases below, not this HTTP conflict contract.
  const context = await fixture(t, { initializeStorage: false });
  const project = context.processing.createProject({ displayName: 'Upload retry conflict' });
  const body = { projectId: project.id, displayName: 'Flight photos' };
  const first = await context.request('POST', '/api/v1/datasets', body);
  assert.equal(first.status, 201);
  const original = (await first.json()).dataset;
  const duplicate = await context.request('POST', '/api/v1/datasets', body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'dataset_name_conflict');
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM datasets WHERE project_id=?').get(project.id).n, 1);
  assert.equal(context.processing.getDataset(original.id).status, 'draft');
  const renamed = await context.request('POST', '/api/v1/datasets', { ...body, displayName: 'Flight photos retry' });
  assert.equal(renamed.status, 201);
  assert.notEqual((await renamed.json()).dataset.id, original.id);
});

async function fixture(t, { initializeStorage = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lifecycle-api-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash'),
    datasetImportMount: path.join(root, 'imports'), storageReserveBytes: 0, storageReservePercent: 0,
  };
  for (const location of Object.values(config).filter(value => typeof value === 'string')) fs.mkdirSync(location, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const storage = new StorageManager(config);
  if (initializeStorage) storage.initialize();
  const token = 'workspace-lifecycle-admin-token-000000000000';
  const readToken = 'workspace-lifecycle-read-token-0000000000000';
  processing.createAdminSession({
    tokenHash: auth.hashToken(token), subject: 'ops:lifecycle', displayUnits: 'imperial',
    permissions: ['viewer.projects.write','viewer.datasets.read','viewer.datasets.write','viewer.processing.read','viewer.processing.write','viewer.processing.publish','viewer.storage.purge'],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  processing.createAdminSession({ tokenHash: auth.hashToken(readToken), subject: 'ops:reader', displayUnits: 'imperial', permissions: ['viewer.datasets.read'], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  async function request(method, route, body = undefined, accessToken = token) {
    const headers = { authorization: `Bearer ${accessToken}` };
    if (method !== 'GET') headers['idempotency-key'] = `lifecycle-${++sequence}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { root, config, database, repository, processing, storage, token, readToken, request };
}

function finalizedDataset(context, project, displayName) {
  const relativePath = crypto.randomUUID();
  const directory = path.join(context.config.datasetsMount, relativePath);
  const body = Buffer.from(`${displayName}-photo`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'photo.jpg'), body);
  const dataset = context.processing.createDataset({ projectId: project.id, displayName, storageMode: 'managed', rootKey: 'datasets', relativePath });
  context.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: body.length, sha256: digest(body), processingRole: 'image' }], digest(body));
  return context.processing.getDataset(dataset.id);
}

function readyManagedOutput(context, project, dataset, task, provider, displayName) {
  const attempt = context.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:lifecycle' });
  const relativeRoot = `${task.id}/${attempt.id}`, directory = path.join(context.config.modelsMount, ...relativeRoot.split('/')), body = Buffer.from(`${displayName}-model`);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'model.glb'), body);
  const model = context.repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName, status: 'ready', sourceLocator: { taskId: task.id, attemptId: attempt.id }, makeActive: false, assets: [{ kind: 'glb', rootKey: 'models', relativePath: `${relativeRoot}/model.glb`, format: 'glb', byteSize: body.length, sha256: digest(body), published: false }] });
  const versionId = context.database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  context.processing.setAttemptResult(attempt.id, model.id, versionId); context.processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
  context.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: relativeRoot, byteSize: body.length, assetCount: 1 });
  return { attempt, model, versionId, directory };
}

test('workspace lifecycle routes enforce guarded archive, recoverable trash, restore, typed purge and failed retry', async t => {
  const context = await fixture(t);
  const project = context.processing.createProject({ displayName: 'Output lifecycle' });
  const dataset = finalizedDataset(context, project, 'Output source');
  const task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Output task' });
  const provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = context.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:lifecycle' });
  const relativeRoot = `${task.id}/${attempt.id}`;
  const outputDirectory = path.join(context.config.modelsMount, ...relativeRoot.split('/'));
  const glb = Buffer.from('lifecycle-model');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'model.glb'), glb);
  const model = context.repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName,
    status: 'ready', sourceLocator: { taskId: task.id, attemptId: attempt.id }, makeActive: false,
    assets: [{ kind: 'glb', rootKey: 'models', relativePath: `${relativeRoot}/model.glb`, format: 'glb', byteSize: glb.length, sha256: digest(glb), published: false }],
  });
  const versionId = context.database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  context.processing.setAttemptResult(attempt.id, model.id, versionId);
  context.processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
  context.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: relativeRoot, byteSize: glb.length, assetCount: 1 });
  context.repository.createViewerSession({ tokenHash: digest('active-viewer'), modelId: model.id, modelVersionId: versionId, subject: 'ops:viewer', audience: 'ops', permissions: { view: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() });

  assert.equal((await context.request('POST', `/api/v1/processing/outputs/${versionId}/archive`, {})).status, 409, 'a live viewer session blocks archive');
  context.database.prepare("UPDATE viewer_sessions SET revoked_at=? WHERE model_id=? AND revoked_at IS NULL").run(new Date().toISOString(), model.id);
  let response = await context.request('DELETE', `/api/v1/processing/outputs/${versionId}`, {});
  assert.equal(response.status, 200);
  let trash = (await response.json()).trash;
  assert.equal(context.processing.getModelOutput(versionId).status, 'trashed');
  assert.equal(fs.existsSync(outputDirectory), false);
  response = await context.request('POST', `/api/v1/storage/trash/${trash.id}/restore`, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output.status, 'ready');
  assert.equal(fs.existsSync(outputDirectory), true);

  response = await context.request('DELETE', `/api/v1/processing/outputs/${versionId}`, {});
  trash = (await response.json()).trash;
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: 'wrong-id' })).status, 400);
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: versionId })).status, 204);
  assert.equal(context.processing.getModelOutput(versionId).byteSize, 0);

  const blockedProject = context.processing.createProject({ displayName: 'Archive guards' });
  const blockedDataset = finalizedDataset(context, blockedProject, 'Guarded dataset');
  const blockedTask = context.processing.createTask({ projectId: blockedProject.id, datasetId: blockedDataset.id, displayName: 'Guarded task' });
  const blockedAttempt = context.processing.createAttempt({ taskId: blockedTask.id, providerId: provider.id, options: {} });
  assert.equal((await context.request('POST', `/api/v1/projects/${blockedProject.id}/archive`, {})).status, 409);
  assert.equal((await context.request('POST', `/api/v1/tasks/${blockedTask.id}/archive`, {})).status, 409);
  context.processing.cancelAttempt(blockedAttempt.id, 'ops:lifecycle');
  assert.equal((await context.request('POST', `/api/v1/tasks/${blockedTask.id}/archive`, {})).status, 200);
  assert.equal((await context.request('POST', `/api/v1/projects/${blockedProject.id}/archive`, {})).status, 200);

  const repairProject = context.processing.createProject({ displayName: 'Repair journal' });
  const repairDataset = finalizedDataset(context, repairProject, 'Repair dataset');
  const mutation = context.processing.beginTrashMutation(repairDataset.id, 'ops:lifecycle');
  context.processing.failStorageMutation(mutation.id, 'storage_conflict', 'destination conflicts with the recorded item');
  response = await context.request('GET', '/api/v1/storage/mutations?status=failed&limit=100');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).mutations.map(item => item.id), [mutation.id]);
  assert.equal((await context.request('GET', '/api/v1/storage/mutations?status=failed&limit=100', undefined, context.readToken)).status, 403);
  response = await context.request('POST', `/api/v1/storage/mutations/${mutation.id}/retry`, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mutation.status, 'complete');
  assert.equal((await context.request('POST', `/api/v1/storage/mutations/${mutation.id}/retry`, {})).status, 409);
});

test('project Delete cascades owned storage into 30-day trash and restore/purge are durable', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Cascade project' }), dataset = finalizedDataset(context, project, 'Cascade dataset'), task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Cascade task' }), provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'Cascade ODM', endpoint: 'http://127.0.0.1:3001', enabled: true }), output = readyManagedOutput(context, project, dataset, task, provider, 'Cascade output'), datasetDirectory = path.join(context.config.datasetsMount, dataset.relativePath);
  let response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200);
  let trash = (await response.json()).trash; assert.equal(trash.entityType, 'project'); assert.ok(Date.parse(trash.purgeAfter) - Date.now() > 29 * 86400_000);
  assert.equal(context.processing.getProject(project.id).status, 'archived'); assert.equal(context.processing.getTask(task.id).status, 'archived'); assert.equal(context.processing.getDataset(dataset.id).status, 'trashed'); assert.equal(context.processing.getModelOutput(output.versionId).status, 'trashed');
  assert.equal(fs.existsSync(datasetDirectory), false); assert.equal(fs.existsSync(output.directory), false);
  response = await context.request('GET', '/api/v1/storage?limit=100'); const visibleTrash = (await response.json()).trash.items; assert.deepEqual(visibleTrash.map(item => item.id), [trash.id], 'owned member trash is grouped beneath the project');
  response = await context.request('POST', `/api/v1/storage/trash/${trash.id}/restore`, {}); assert.equal(response.status, 200); assert.equal((await response.json()).project.status, 'active');
  assert.equal(fs.existsSync(datasetDirectory), true); assert.equal(fs.existsSync(output.directory), true); assert.equal(context.processing.getDataset(dataset.id).status, 'finalized'); assert.equal(context.processing.getModelOutput(output.versionId).status, 'ready'); assert.equal(context.processing.getTask(task.id).status, 'ready_for_review');
  response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200); trash = (await response.json()).trash;
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: 'wrong' })).status, 400);
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: project.id })).status, 204); assert.equal(fs.existsSync(datasetDirectory), false); assert.equal(fs.existsSync(output.directory), false);
  assert.equal(context.processing.getProject(project.id), null, 'purged projects are no longer retrievable'); assert.equal(context.processing.getTask(task.id), null, 'purged tasks are no longer retrievable');
  assert.match(context.database.prepare('SELECT display_name FROM projects WHERE id=?').get(project.id).display_name, /^deleted-project-/); assert.match(context.database.prepare('SELECT display_name FROM processing_tasks WHERE id=?').get(task.id).display_name, /^deleted-task-/);
  const { purgeContainerTrash } = require('../server/containerLifecycle'); assert.equal(purgeContainerTrash(context.processing, context.storage, trash.id, 'ops:lifecycle').permanentlyDeletedAt !== null, true, 'repeat purge is idempotent');
});

test('container restore preflights every member before changing files or metadata', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Preflight project' }), dataset = finalizedDataset(context, project, 'Preflight dataset'), task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Preflight task' }), provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'Preflight ODM', endpoint: 'http://127.0.0.1:3002', enabled: true }), output = readyManagedOutput(context, project, dataset, task, provider, 'Preflight output'), datasetDirectory = path.join(context.config.datasetsMount, dataset.relativePath);
  let response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200); const trash = (await response.json()).trash;
  assert.equal(trash.displayName, 'Preflight project'); assert.equal(fs.existsSync(output.directory), false); assert.equal(fs.existsSync(datasetDirectory), false);
  fs.mkdirSync(datasetDirectory, { recursive: true }); fs.writeFileSync(path.join(datasetDirectory, 'conflict.txt'), 'do not overwrite');
  response = await context.request('POST', `/api/v1/storage/trash/${trash.id}/restore`, {}); assert.equal(response.status, 409);
  assert.equal(context.processing.getProject(project.id).status, 'archived'); assert.equal(context.processing.getTask(task.id).status, 'archived');
  assert.equal(context.processing.getDataset(dataset.id).status, 'trashed'); assert.equal(context.processing.getModelOutput(output.versionId).status, 'trashed');
  assert.equal(fs.existsSync(output.directory), false, 'an earlier member was not partially restored before the later conflict');
  assert.equal(context.processing.getTrash(trash.id).permanentlyDeletedAt, null);
});

test('restoring a formerly published output requires explicit republish', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Published restore' }), dataset = finalizedDataset(context, project, 'Published dataset'), task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Published task' }), provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'Published ODM', endpoint: 'http://127.0.0.1:3003', enabled: true }), output = readyManagedOutput(context, project, dataset, task, provider, 'Published output');
  assert.ok(context.processing.publishAttemptAtomic(output.attempt.id, ['glb'], { actorId: 'ops:lifecycle' }));
  let response = await context.request('DELETE', `/api/v1/processing/outputs/${output.versionId}`, {}); assert.equal(response.status, 200); const trash = (await response.json()).trash;
  response = await context.request('POST', `/api/v1/storage/trash/${trash.id}/restore`, {}); assert.equal(response.status, 200); const restored = (await response.json()).output;
  assert.equal(restored.status, 'ready'); assert.equal(context.processing.getTask(task.id).status, 'ready_for_review'); assert.equal(context.processing.getTask(task.id).publishedModelId, null);
  assert.equal(context.database.prepare('SELECT active_version_id FROM models WHERE id=?').get(output.model.id).active_version_id, null);
  assert.equal(context.database.prepare('SELECT published FROM model_assets WHERE version_id=?').get(output.versionId).published, 0);
});

test('expired task container trash automatically purges owned files once and preserves shared datasets', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Task retention' }), shared = finalizedDataset(context, project, 'Shared dataset'), task = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Deleted task' }), sibling = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Sibling task' }), directory = path.join(context.config.datasetsMount, shared.relativePath);
  let response = await context.request('DELETE', `/api/v1/tasks/${task.id}`, {}); assert.equal(response.status, 200); const trash = (await response.json()).trash;
  assert.equal(context.processing.getTask(task.id).status, 'archived'); assert.equal(context.processing.getTask(sibling.id).status, 'draft'); assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(directory), true, 'dataset shared by another live task is outside the deleted task ownership boundary');
  context.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(), trash.id);
  const first = purgeExpiredTrash(context.processing, context.storage); assert.equal(first.length, 1); assert.equal(first[0].status, 'complete'); assert.ok(context.processing.getTrash(trash.id).permanentlyDeletedAt);
  assert.deepEqual(purgeExpiredTrash(context.processing, context.storage), [], 'automatic purge is idempotent'); assert.equal(fs.existsSync(directory), true);
});

// Duplicate (and Use saved source) let two tasks share one source set. Deleting both puts the set in the second task's
// trash; restoring the first must bring the set back with it, and no purge may delete a set an active task still uses.
test('a source set shared by two tasks is restored with either task and never purged while a task uses it', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Shared source' }), shared = finalizedDataset(context, project, 'Shared photos');
  const original = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original' }), copy = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original (copy)' });
  const directory = path.join(context.config.datasetsMount, shared.relativePath);
  // 1-2. Delete the original: the copy still uses the set, so it stays.
  let response = await context.request('DELETE', `/api/v1/tasks/${original.id}`, {}); assert.equal(response.status, 200); const originalTrash = (await response.json()).trash;
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(directory), true);
  // 3. Delete the copy: it is now the last user, so the set goes into the copy's trash.
  response = await context.request('DELETE', `/api/v1/tasks/${copy.id}`, {}); assert.equal(response.status, 200); const copyTrash = (await response.json()).trash;
  assert.equal(context.processing.getDataset(shared.id).status, 'trashed'); assert.equal(fs.existsSync(directory), false);
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id); assert.ok(datasetTrash);
  // Guards: while a task uses the set (forced here), neither a purge of the copy nor expiry deletes the photos.
  context.database.prepare("UPDATE processing_tasks SET status='draft',archived_at=NULL WHERE id=?").run(original.id);
  assert.equal(context.processing.beginPurgeMutation(datasetTrash.id, 'ops:lifecycle'), null);
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${copyTrash.id}`, { typedId: copy.id })).status, 409);
  context.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id IN (?,?)').run(new Date(Date.now() - 1000).toISOString(), copyTrash.id, datasetTrash.id);
  assert.ok(purgeExpiredTrash(context.processing, context.storage).every(result => result.status === 'failed'));
  assert.equal(context.processing.getDataset(shared.id).status, 'trashed'); assert.equal(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, null);
  assert.ok(fs.readdirSync(context.config.trashMount, { recursive: true }).some(name => String(name).endsWith('photo.jpg')), 'the photos are still in the Recycle Bin');
  context.database.prepare("UPDATE processing_tasks SET status='archived',archived_at=? WHERE id=?").run(new Date().toISOString(), original.id);
  // 4. Restore the original: the set comes back from the copy's trash with it.
  response = await context.request('POST', `/api/v1/storage/trash/${originalTrash.id}/restore`, {}); assert.equal(response.status, 200);
  assert.notEqual(context.processing.getTask(original.id).status, 'archived');
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(path.join(directory, 'photo.jpg')), true);
  assert.ok(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, 'the set left the Recycle Bin');
  assert.equal(context.processing.getTask(copy.id).status, 'archived', 'the copy stays deleted');
  // 5. Purging the copy (or its expiry) leaves the original's photos alone.
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${copyTrash.id}`, { typedId: copy.id })).status, 204);
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(path.join(directory, 'photo.jpg')), true);
  assert.deepEqual(purgeExpiredTrash(context.processing, context.storage), []);
  assert.equal(fs.existsSync(path.join(directory, 'photo.jpg')), true);
});

test('a task whose source set is trashed without a restorable trash item is refused rather than restored onto missing photos', async t => {
  const context = await fixture(t, { initializeStorage: false }), project = context.processing.createProject({ displayName: 'Refused restore' });
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'External photos', storageMode: 'external_reference', rootKey: 'imports', relativePath: 'flight' });
  context.processing.finalizeDataset(dataset.id, [], 'c'.repeat(64));
  const task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Uses external photos' });
  const taskTrash = context.processing.trashTask(task.id, 'ops:lifecycle');
  const datasetTrash = context.processing.trashDataset(dataset.id, { trashRelative: null, actor: 'ops:lifecycle' }); assert.ok(datasetTrash);
  // The external set cannot be marked purged while a task uses it.
  context.database.prepare("UPDATE processing_tasks SET status='draft',archived_at=NULL WHERE id=?").run(task.id);
  assert.equal(context.processing.markTrashPurged(datasetTrash.id, 'ops:lifecycle'), null);
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${datasetTrash.id}`, { typedId: dataset.id })).status, 409);
  context.database.prepare("UPDATE processing_tasks SET status='archived',archived_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  // Nor while the deleted task can still be restored with it.
  assert.equal(context.processing.markTrashPurged(datasetTrash.id, 'ops:lifecycle'), null);
  // If the set's trash item is finished anyway (as before these guards), the task cannot come back onto it.
  context.database.prepare('UPDATE storage_trash SET permanently_deleted_at=? WHERE id=?').run(new Date().toISOString(), datasetTrash.id);
  assert.equal(context.processing.canRestoreMetadataEntity(taskTrash.id), false);
  assert.equal(context.processing.restoreMetadataEntity(taskTrash.id, 'ops:lifecycle'), null);
  assert.equal((await context.request('POST', `/api/v1/storage/trash/${taskTrash.id}/restore`, {})).status, 409);
  assert.equal(context.processing.getTask(task.id).status, 'archived');
});

const photosInTrash = context => fs.readdirSync(context.config.trashMount, { recursive: true }).some(name => String(name).endsWith('photo.jpg'));

test('purging one deleted task hands a shared source set to the other deleted task instead of deleting its photos', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Hand-off' }), shared = finalizedDataset(context, project, 'Shared photos');
  const original = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original' }), copy = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original (copy)' });
  const directory = path.join(context.config.datasetsMount, shared.relativePath);
  let response = await context.request('DELETE', `/api/v1/tasks/${original.id}`, {}); const originalTrash = (await response.json()).trash;
  response = await context.request('DELETE', `/api/v1/tasks/${copy.id}`, {}); const copyTrash = (await response.json()).trash;
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id);
  assert.deepEqual(context.processing.listContainerTrashMembers(copyTrash.id).map(item => item.id), [datasetTrash.id]);
  // Purge only the copy: the set moves into the original's Recycle Bin item; no photo is deleted.
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${copyTrash.id}`, { typedId: copy.id })).status, 204);
  assert.ok(context.processing.getTrash(copyTrash.id).permanentlyDeletedAt);
  assert.equal(context.processing.getDataset(shared.id).status, 'trashed'); assert.equal(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, null); assert.ok(photosInTrash(context));
  assert.deepEqual(context.processing.listContainerTrashMembers(originalTrash.id).map(item => item.id), [datasetTrash.id]);
  assert.equal(context.processing.getTrash(datasetTrash.id).purgeAfter, context.processing.getTrash(originalTrash.id).purgeAfter);
  const moved = context.database.prepare("SELECT details_json FROM audit_events WHERE action='dataset.trash_moved'").all().map(row => JSON.parse(row.details_json));
  assert.deepEqual(moved, [{ trashId: datasetTrash.id, fromContainerTrashId: copyTrash.id, toContainerTrashId: originalTrash.id }]);
  // The original still restores with its photos.
  response = await context.request('POST', `/api/v1/storage/trash/${originalTrash.id}/restore`, {}); assert.equal(response.status, 200);
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(path.join(directory, 'photo.jpg')), true);
});

test('with three deleted tasks on one source set, the photos are deleted only with the last of them', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Three tasks' }), shared = finalizedDataset(context, project, 'Shared photos');
  const tasks = ['First', 'Second', 'Third'].map(displayName => context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName }));
  const trash = [];
  for (const task of tasks) { const response = await context.request('DELETE', `/api/v1/tasks/${task.id}`, {}); assert.equal(response.status, 200); trash.push((await response.json()).trash); }
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id), holder = () => context.database.prepare('SELECT container_trash_id FROM container_trash_members WHERE member_trash_id=?').all(datasetTrash.id).map(row => row.container_trash_id);
  assert.deepEqual(holder(), [trash[2].id]);
  // The third task's purge hands the set to the newest other deleted task (the second), and expiry of the second to the first.
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash[2].id}`, { typedId: tasks[2].id })).status, 204);
  assert.deepEqual(holder(), [trash[1].id]); assert.ok(photosInTrash(context));
  context.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), trash[1].id);
  const expired = purgeExpiredTrash(context.processing, context.storage); assert.deepEqual(expired.map(item => [item.trashId, item.status]), [[trash[1].id, 'complete']]);
  assert.deepEqual(holder(), [trash[0].id]); assert.ok(photosInTrash(context)); assert.equal(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, null);
  // The last deleted task takes the photos with it.
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash[0].id}`, { typedId: tasks[0].id })).status, 204);
  assert.ok(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt); assert.equal(photosInTrash(context), false);
});

test('restoring one task of a deleted project is refused before any shared source set leaves the Recycle Bin', async t => {
  const context = await fixture(t), project = context.processing.createProject({ displayName: 'Deleted project' }), shared = finalizedDataset(context, project, 'Shared photos');
  const original = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original' }), copy = context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName: 'Original (copy)' });
  let response = await context.request('DELETE', `/api/v1/tasks/${original.id}`, {}); const originalTrash = (await response.json()).trash;
  response = await context.request('DELETE', `/api/v1/tasks/${copy.id}`, {}); const copyTrash = (await response.json()).trash;
  response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200); const projectTrash = (await response.json()).trash;
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id);
  assert.equal((await context.request('POST', `/api/v1/storage/trash/${originalTrash.id}/restore`, {})).status, 409);
  assert.equal(context.processing.getDataset(shared.id).status, 'trashed', 'the set was not taken out of the Recycle Bin');
  assert.equal(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, null); assert.ok(photosInTrash(context));
  assert.equal(context.processing.getTask(original.id).status, 'archived');
  // The project took both deleted tasks and the set into its Recycle Bin item; restoring it brings all of them back.
  assert.deepEqual(context.processing.listContainerTrashMembers(projectTrash.id).map(item => item.id).sort(), [originalTrash.id, copyTrash.id, datasetTrash.id].sort());
  assert.equal((await context.request('POST', `/api/v1/storage/trash/${projectTrash.id}/restore`, {})).status, 200);
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized'); assert.equal(fs.existsSync(path.join(context.config.datasetsMount, shared.relativePath, 'photo.jpg')), true);
  assert.notEqual(context.processing.getTask(original.id).status, 'archived'); assert.notEqual(context.processing.getTask(copy.id).status, 'archived');
});

// Invented fixtures: two or three tasks on one synthetic source set. Every purge path must keep photos that a deleted,
// still-restorable task needs, and must still delete them once nothing can use them.
async function sharedTasks(context, names) {
  const project = context.processing.createProject({ displayName: `Shared ${crypto.randomUUID().slice(0, 8)}` }), shared = finalizedDataset(context, project, 'Synthetic photos');
  const tasks = names.map(displayName => context.processing.createTask({ projectId: project.id, datasetId: shared.id, displayName }));
  return { project, shared, tasks };
}
async function deleteTask(context, task) { const response = await context.request('DELETE', `/api/v1/tasks/${task.id}`, {}); assert.equal(response.status, 200); return (await response.json()).trash; }
const purge = (context, trash, typedId) => context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId });

test('a direct purge of a shared source set is refused while a deleted task can still be restored with it', async t => {
  const context = await fixture(t), { shared, tasks: [first, second] } = await sharedTasks(context, ['First', 'Second']);
  const firstTrash = await deleteTask(context, first), secondTrash = await deleteTask(context, second), datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id);
  // The set sits in the second task's item. Both deleted tasks can still be restored, so its own purge is refused.
  let response = await purge(context, datasetTrash, shared.id); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'dataset_in_use');
  assert.equal(context.processing.beginPurgeMutation(datasetTrash.id, 'ops:lifecycle'), null);
  assert.ok(photosInTrash(context)); assert.equal(context.processing.getTrash(datasetTrash.id).permanentlyDeletedAt, null);
  // Scoped to the second task's own purge, the first (still restorable) task keeps blocking; once it is gone, nothing does.
  assert.equal(context.processing.datasetPurgeBlocked(shared.id, secondTrash.id), true);
  assert.equal((await purge(context, firstTrash, first.id)).status, 204);
  assert.equal(context.processing.datasetPurgeBlocked(shared.id, secondTrash.id), false);
  assert.equal(context.processing.datasetPurgeBlocked(shared.id), true, 'unscoped, the second deleted task still needs it');
  assert.equal((await purge(context, secondTrash, second.id)).status, 204); assert.equal(photosInTrash(context), false);
});

test('standalone expiry of a source set hands it to the deleted task that still needs it', async t => {
  const context = await fixture(t), { shared, tasks: [deleted, archived] } = await sharedTasks(context, ['Deleted', 'Archived']);
  const deletedTrash = await deleteTask(context, deleted);
  assert.equal((await context.request('POST', `/api/v1/tasks/${archived.id}/archive`, {})).status, 200);
  // With no active task left, the set itself can be deleted; it lands in the Recycle Bin on its own.
  let response = await context.request('DELETE', `/api/v1/datasets/${shared.id}`, {}); assert.equal(response.status, 200);
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id);
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM container_trash_members WHERE member_trash_id=?').get(datasetTrash.id).n, 0);
  context.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), datasetTrash.id);
  assert.deepEqual(purgeExpiredTrash(context.processing, context.storage), [{ trashId: datasetTrash.id, status: 'transferred', containerTrashId: deletedTrash.id }]);
  assert.ok(photosInTrash(context)); assert.deepEqual(context.processing.listContainerTrashMembers(deletedTrash.id).map(item => item.id), [datasetTrash.id]);
  assert.equal(context.processing.getTrash(datasetTrash.id).purgeAfter, deletedTrash.purgeAfter);
  // It now goes with that task: restoring brings the photos back.
  response = await context.request('POST', `/api/v1/storage/trash/${deletedTrash.id}/restore`, {}); assert.equal(response.status, 200);
  assert.equal(context.processing.getDataset(shared.id).status, 'finalized');
});

test('standalone expiry deletes a source set once no deleted task can be restored with it', async t => {
  const context = await fixture(t), { shared, tasks: [deleted, archived] } = await sharedTasks(context, ['Deleted', 'Archived']);
  const deletedTrash = await deleteTask(context, deleted);
  assert.equal((await context.request('POST', `/api/v1/tasks/${archived.id}/archive`, {})).status, 200);
  assert.equal((await context.request('DELETE', `/api/v1/datasets/${shared.id}`, {})).status, 200);
  const datasetTrash = context.processing.activeTrashForEntity('dataset', shared.id);
  assert.equal((await purge(context, deletedTrash, deleted.id)).status, 204);
  context.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), datasetTrash.id);
  assert.deepEqual(purgeExpiredTrash(context.processing, context.storage).map(item => [item.trashId, item.status]), [[datasetTrash.id, 'complete']]);
  assert.equal(photosInTrash(context), false);
});

for (const order of [[0, 1], [1, 0]]) {
  test(`container purges ${order.map(index => ['first', 'second'][index]).join(' then ')} keep a shared set until the last deleted task goes`, async t => {
    const context = await fixture(t), { tasks } = await sharedTasks(context, ['First', 'Second']), trash = [];
    for (const task of tasks) trash.push(await deleteTask(context, task));
    assert.equal((await purge(context, trash[order[0]], tasks[order[0]].id)).status, 204);
    assert.ok(photosInTrash(context), 'the remaining deleted task still has its photos');
    const remaining = tasks[order[1]];
    assert.equal((await context.request('POST', `/api/v1/storage/trash/${trash[order[1]].id}/restore`, {})).status, 200);
    assert.equal(context.processing.getDataset(remaining.datasetId).status, 'finalized');
    // Delete it again and purge: the photos go with the last user.
    const again = await deleteTask(context, remaining);
    assert.equal((await purge(context, again, remaining.id)).status, 204); assert.equal(photosInTrash(context), false);
  });
}

test('three deleted tasks purged first, third, second keep the set until the last one', async t => {
  const context = await fixture(t), { tasks } = await sharedTasks(context, ['First', 'Second', 'Third']), trash = [];
  for (const task of tasks) trash.push(await deleteTask(context, task));
  for (const index of [0, 2]) { assert.equal((await purge(context, trash[index], tasks[index].id)).status, 204); assert.ok(photosInTrash(context)); }
  assert.equal((await purge(context, trash[1], tasks[1].id)).status, 204); assert.equal(photosInTrash(context), false);
});

test('a project purge that holds every user of a shared set deletes it in the same purge', async t => {
  const context = await fixture(t), { project, tasks } = await sharedTasks(context, ['First', 'Second']);
  for (const task of tasks) await deleteTask(context, task);
  const response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200); const projectTrash = (await response.json()).trash;
  assert.equal((await purge(context, projectTrash, project.id)).status, 204); assert.equal(photosInTrash(context), false);
});
