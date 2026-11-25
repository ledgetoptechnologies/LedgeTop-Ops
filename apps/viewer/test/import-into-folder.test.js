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
const { processOneDatasetOperation } = require('../server/datasetOperationWorker');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

const SUBJECT = 'ops:importer';
const FOLDER_PATH = '/api/v1/processing/server-task-imports';
const ZIP_PATH = '/api/v1/processing/webodm-task-imports';

async function fixture(t, permissions = ['viewer.datasets.import']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-import-folder-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'), datasetImportMount: path.join(root, 'imports'),
    storageReserveBytes: 0, storageReservePercent: 0, uploadMaxFiles: 1000,
  };
  for (const location of Object.values(config).filter(value => typeof value === 'string')) fs.mkdirSync(location, { recursive: true });
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db), storage = new StorageManager(config);
  storage.initialize();
  const token = 'import-into-folder-token-000000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: SUBJECT, displayUnits: 'imperial', permissions, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const app = express();
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.use(createProcessingApi({ repository, processing, storage }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (method, url, body, key = crypto.randomUUID()) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, replayed: response.headers.get('idempotency-replayed') === 'true', body: await response.json().catch(() => null) };
  };
  const c = { root, config, db, processing, repository, storage, request };
  c.source = (name, files = ['model.glb']) => {
    fs.mkdirSync(path.join(config.datasetImportMount, name), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(config.datasetImportMount, name, file), `${name} mesh`);
    return name;
  };
  c.post = (body, { key, url = FOLDER_PATH } = {}) => request('POST', url, { sourceRelativePath: 'map', taskDisplayName: 'Map', ...body }, key);
  c.payload = id => JSON.parse(db.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(id).payload_json);
  c.audits = action => db.prepare('SELECT actor_id,entity_type,entity_id,details_json FROM audit_events WHERE action=? ORDER BY rowid').all(action).map(row => ({ ...row, details: JSON.parse(row.details_json) }));
  c.count = table => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  c.project = name => processing.createProject({ displayName: name });
  c.folder = (project, name, parentId = null) => processing.createProjectFolder(project.id, { displayName: name, parentId }, SUBJECT);
  c.run = async (operation, worker = 'import-worker') => { await processOneDatasetOperation(c, worker); return processing.getDatasetOperation(operation.id, SUBJECT); };
  return c;
}

test('an import names its folder and a root import is queued exactly as before', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps');
  c.source('map');
  const inFolder = await c.post({ projectId: project.id, folderId: folder.id });
  assert.equal(inFolder.status, 202, JSON.stringify(inFolder.body));
  assert.equal(c.payload(inFolder.body.operation.id).request.folderId, folder.id);
  assert.deepEqual(c.audits('webodm_task_import.queued').at(-1).details, { operationType: 'webodm_task_import', projectId: project.id, folderId: folder.id, sourceKind: 'server_folder' });
  for (const extra of [{}, { folderId: null }]) {
    const atRoot = await c.post({ projectId: project.id, ...extra });
    assert.equal(atRoot.status, 202);
    assert.deepEqual(c.payload(atRoot.body.operation.id).request, { sourceRelativePath: 'map', sourceKind: 'folder', projectId: project.id, taskDisplayName: 'Map' });
    assert.deepEqual(c.audits('webodm_task_import.queued').at(-1).details, { operationType: 'webodm_task_import', projectId: project.id, sourceKind: 'server_folder' });
  }
});

test('importing into a folder needs the import permission; folder write permission does not grant it', async t => {
  const c = await fixture(t, ['viewer.projects.read', 'viewer.projects.write', 'viewer.processing.write', 'viewer.datasets.write']);
  const project = c.project('Project'), folder = c.folder(project, 'Maps');
  c.source('map');
  fs.writeFileSync(path.join(c.config.datasetImportMount, 'map.zip'), 'zip');
  for (const [url, sourceRelativePath] of [[FOLDER_PATH, 'map'], [ZIP_PATH, 'map.zip']]) {
    const denied = await c.post({ projectId: project.id, folderId: folder.id, sourceRelativePath }, { url });
    assert.equal(denied.status, 403);
  }
  assert.equal(c.count('dataset_operations'), 0);
  assert.equal(c.count('subject_operation_receipts'), 0);
});

test('foreign, unknown and malformed folders are rejected, queue nothing and give the key back', async t => {
  const c = await fixture(t), project = c.project('Project'), other = c.project('Other');
  const folder = c.folder(project, 'Maps'), foreign = c.folder(other, 'Maps');
  c.source('map');
  fs.writeFileSync(path.join(c.config.datasetImportMount, 'map.zip'), 'zip');
  for (const folderId of [foreign.id, crypto.randomUUID()]) {
    for (const [url, sourceRelativePath] of [[FOLDER_PATH, 'map'], [ZIP_PATH, 'map.zip']]) {
      const rejected = await c.post({ projectId: project.id, folderId, sourceRelativePath }, { url, key: 'reusable-key-1' });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, 'invalid_folder');
      assert.equal(rejected.body.error, 'The folder is no longer in this project.');
    }
  }
  for (const folderId of ['', 7, true, [folder.id], { id: folder.id }, 'x'.repeat(201)]) {
    const malformed = await c.post({ projectId: project.id, folderId }, { key: 'reusable-key-1' });
    assert.equal(malformed.status, 400, JSON.stringify(folderId));
    assert.equal(malformed.body.code, 'invalid_server_task_import');
  }
  assert.equal(c.count('dataset_operations'), 0);
  assert.equal(c.count('subject_operation_receipts'), 0);
  assert.equal(c.audits('webodm_task_import.queued').length, 0);
  assert.equal((await c.post({ projectId: project.id, folderId: folder.id }, { key: 'reusable-key-1' })).status, 202);
});

test('archived, trashed, purging and purged projects take no import, with or without a folder', async t => {
  const c = await fixture(t);
  c.source('map');
  const make = name => { const project = c.project(name); return { project, folder: c.folder(project, 'Maps') }; };
  const archived = make('Archived'), trashed = make('Trashed'), purging = make('Purging'), purged = make('Purged');
  c.processing.archiveProject(archived.project.id);
  c.processing.trashProject(trashed.project.id, SUBJECT);
  const trash = c.processing.trashProject(purging.project.id, SUBJECT);
  c.db.prepare('UPDATE storage_trash SET purge_started_at=? WHERE id=?').run(new Date().toISOString(), trash.id);
  c.processing.trashProject(purged.project.id, SUBJECT);
  c.db.prepare('UPDATE projects SET purged_at=? WHERE id=?').run(new Date().toISOString(), purged.project.id);
  for (const { project, folder } of [archived, trashed, purging, purged]) {
    for (const folderId of [folder.id, null]) {
      const rejected = await c.post({ projectId: project.id, folderId });
      assert.equal(rejected.status, 400, project.displayName);
      assert.equal(rejected.body.code, 'invalid_project');
    }
    assert.equal(c.processing.createWebodmTaskImportOperation({ request: { projectId: project.id, folderId: folder.id, sourceRelativePath: 'map', taskDisplayName: 'Map' }, subject: SUBJECT }), null);
  }
  assert.equal(c.count('dataset_operations'), 0);
  assert.equal(c.count('subject_operation_receipts'), 0);
});

test('a repeated request replays its import even after the folder is gone; another folder under the same key conflicts', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps'), second = c.folder(project, 'Other');
  c.source('map');
  const first = await c.post({ projectId: project.id, folderId: folder.id }, { key: 'same-import-key' });
  assert.equal(first.status, 202);
  c.db.prepare("UPDATE dataset_operations SET status='failed'").run();
  assert.equal(c.processing.deleteEmptyProjectFolder(project.id, folder.id, SUBJECT), true);
  const replay = await c.post({ projectId: project.id, folderId: folder.id }, { key: 'same-import-key' });
  assert.equal(replay.status, 202);
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.operation.id, first.body.operation.id);
  const conflict = await c.post({ projectId: project.id, folderId: second.id }, { key: 'same-import-key' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(c.count('dataset_operations'), 1);
});

test('the imported task is created in exactly the chosen folder, with one audit row and no move', async t => {
  const c = await fixture(t), project = c.project('Project'), other = c.project('Other');
  const parent = c.folder(project, 'Site'), child = c.folder(project, 'Maps', parent.id);
  c.source('map');
  const queued = await c.post({ projectId: project.id, folderId: child.id });
  const { ids } = c.payload(queued.body.operation.id);
  const done = await c.run(queued.body.operation);
  assert.equal(done.status, 'succeeded', done.errorMessage);
  assert.deepEqual(c.processing.listTasks(project.id).map(task => [task.id, task.folderId]), [[ids.taskId, child.id]]);
  assert.equal(c.processing.listTasks(other.id).length, 0);
  const task = c.processing.getTask(ids.taskId);
  assert.equal(task.projectId, project.id);
  assert.equal(task.folderRevision, 0);
  assert.equal(c.processing.getDataset(ids.datasetId).projectId, project.id);
  assert.deepEqual(c.audits('processing_task.imported').map(row => [row.actor_id, row.entity_type, row.entity_id, row.details]),
    [[SUBJECT, 'processing_task', ids.taskId, { operationId: queued.body.operation.id, projectId: project.id, datasetId: ids.datasetId, folderId: child.id }]]);
  assert.equal(c.audits('processing_task.folder_changed').length, 0);
  // Staff can move it afterwards like any other task.
  assert.equal(c.processing.moveTaskToFolder(task.id, parent.id, SUBJECT, { expectedFolderId: child.id, expectedFolderRevision: 0 }).folderId, parent.id);
});

test('a root import still lands at the project root and records no placement', async t => {
  const c = await fixture(t), project = c.project('Project');
  c.folder(project, 'Maps');
  c.source('map');
  const queued = await c.post({ projectId: project.id }), done = await c.run(queued.body.operation);
  assert.equal(done.status, 'succeeded', done.errorMessage);
  assert.deepEqual(c.processing.listTasks(project.id).map(task => task.folderId), [null]);
  assert.equal(c.audits('processing_task.imported').length, 0);
});

test('a folder waiting for an import cannot be deleted, then is a normal folder again', async t => {
  const c = await fixture(t, ['viewer.datasets.import', 'viewer.projects.read', 'viewer.projects.write']);
  const project = c.project('Project'), parent = c.folder(project, 'Site'), child = c.folder(project, 'Maps', parent.id), free = c.folder(project, 'Free');
  c.source('map');
  const url = folder => `/api/v1/projects/${project.id}/folders/${folder.id}`;
  const queued = await c.post({ projectId: project.id, folderId: child.id }), { ids } = c.payload(queued.body.operation.id);
  const waiting = async () => {
    const blocked = await c.request('DELETE', url(child));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'folder_import_pending');
    assert.match(blocked.body.error, /import into this folder is still running/);
  };
  await waiting();
  c.db.prepare("UPDATE dataset_operations SET status='leased',lease_owner='w',lease_expires_at='2000-01-01T00:00:00.000Z'").run();
  await waiting();
  assert.equal((await c.request('DELETE', url(parent))).body.code, 'folder_not_empty');
  assert.equal((await c.request('DELETE', url(free))).status, 200, 'another empty folder is unaffected');
  // Renaming it meanwhile is fine: the import follows the folder, not its name.
  assert.equal((await c.request('PATCH', url(child), { displayName: 'Finished maps' })).status, 200);
  const done = await c.run(queued.body.operation);
  assert.equal(done.status, 'succeeded', done.errorMessage);
  assert.equal(c.processing.getTask(ids.taskId).folderId, child.id);
  assert.equal((await c.request('DELETE', url(child))).body.code, 'folder_not_empty');
  c.processing.moveTaskToFolder(ids.taskId, null, SUBJECT);
  assert.equal((await c.request('DELETE', url(child))).status, 200);
});

test('a failed import does not hold its folder, and its retry fails plainly instead of falling back to the root', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps');
  c.source('map', ['notes.txt']);
  const queued = await c.post({ projectId: project.id, folderId: folder.id }), failed = await c.run(queued.body.operation);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'no_supported_assets');
  assert.equal(c.processing.deleteEmptyProjectFolder(project.id, folder.id, SUBJECT), true);
  c.source('map');
  c.processing.retryDatasetOperation(queued.body.operation.id, SUBJECT, SUBJECT);
  const retried = await c.run(queued.body.operation);
  assert.equal(retried.status, 'failed');
  assert.equal(retried.errorCode, 'import_folder_unavailable');
  assert.match(retried.errorMessage, /folder chosen for this import is no longer in the project/);
  assert.equal(c.processing.listTasks(project.id).length, 0);
  assert.equal(fs.existsSync(path.join(c.config.datasetImportMount, 'map', 'model.glb')), true);
});

test('a folder lost while files are copied rolls the import back completely', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps');
  c.source('map');
  const queued = await c.post({ projectId: project.id, folderId: folder.id }), { ids } = c.payload(queued.body.operation.id);
  const finalize = c.processing.finalizeDataset.bind(c.processing);
  c.processing.finalizeDataset = (...args) => { const result = finalize(...args); c.db.prepare('DELETE FROM project_folders WHERE id=?').run(folder.id); return result; };
  const failed = await c.run(queued.body.operation);
  c.processing.finalizeDataset = finalize;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'import_folder_unavailable');
  assert.equal(c.processing.listTasks(project.id).length, 0);
  assert.equal(c.processing.getDataset(ids.datasetId, true), null);
  assert.equal(c.processing.getAttempt(ids.attemptId), null);
  assert.equal(c.audits('processing_task.imported').length, 0);
});

test('placement and its audit row are one transaction', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps');
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  c.processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const input = { projectId: project.id, datasetId: dataset.id, displayName: 'Map', createdBy: SUBJECT };
  const insertAudit = c.processing.insertAudit;
  c.processing.insertAudit = () => { throw new Error('audit unavailable'); };
  assert.throws(() => c.processing.createImportedTaskInFolder(input, folder.id, 'operation'), /audit unavailable/);
  c.processing.insertAudit = insertAudit;
  assert.equal(c.processing.listTasks(project.id).length, 0);
  const other = c.project('Other'), foreign = c.folder(other, 'Maps');
  for (const folderId of [foreign.id, null, undefined, 7]) assert.throws(() => c.processing.createImportedTaskInFolder(input, folderId, 'operation'), { code: 'import_folder_unavailable' });
  c.processing.archiveProject(project.id);
  assert.throws(() => c.processing.createImportedTaskInFolder(input, folder.id, 'operation'), { code: 'invalid_project_or_dataset' });
  assert.equal(c.count('processing_tasks'), 0);
});

test('a project archived after queueing takes no imported task', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps');
  c.source('map');
  const queued = await c.post({ projectId: project.id, folderId: folder.id });
  c.processing.archiveProject(project.id);
  const failed = await c.run(queued.body.operation);
  assert.equal(failed.status, 'failed');
  assert.equal(c.count('processing_tasks'), 0);
  assert.equal(c.audits('processing_task.imported').length, 0);
});

test('an import resumed by another worker keeps a move staff made meanwhile', async t => {
  const c = await fixture(t), project = c.project('Project'), folder = c.folder(project, 'Maps'), elsewhere = c.folder(project, 'Elsewhere');
  c.source('map');
  const queued = await c.post({ projectId: project.id, folderId: folder.id }), { ids } = c.payload(queued.body.operation.id);
  const complete = c.processing.completeDatasetOperationWithImportReadiness;
  c.processing.completeDatasetOperationWithImportReadiness = () => {
    c.processing.moveTaskToFolder(ids.taskId, elsewhere.id, SUBJECT, { expectedFolderId: folder.id, expectedFolderRevision: 0 });
    c.db.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(queued.body.operation.id);
    return false;
  };
  await processOneDatasetOperation(c, 'stale-worker');
  c.processing.completeDatasetOperationWithImportReadiness = complete;
  assert.equal(c.processing.getTask(ids.taskId).folderId, elsewhere.id);
  // The task has left the folder, so the still-running import no longer holds it.
  assert.equal(c.processing.deleteEmptyProjectFolder(project.id, folder.id, SUBJECT), true);
  const done = await c.run(queued.body.operation, 'successor-worker');
  assert.equal(done.status, 'succeeded', done.errorMessage);
  assert.equal(c.processing.getTask(ids.taskId).folderId, elsewhere.id);
  assert.equal(c.processing.getTask(ids.taskId).folderRevision, 1);
  assert.equal(c.audits('processing_task.imported').length, 1);
});

test('a folder import shows clients nothing until it is published, and then only through its own project', async t => {
  const c = await fixture(t), shared = c.project('Shared'), other = c.project('Other shared');
  const folder = c.folder(shared, 'Maps');
  c.folder(shared, 'Internal');
  c.source('map');
  const visible = project => c.processing.listActivePublishedProjectTasksPage(project.id, { strictPublished: true }).items.map(task => task.taskId);
  const shares = () => JSON.stringify([c.db.prepare('SELECT * FROM public_project_shares').all(), c.db.prepare('SELECT * FROM public_shares').all()]);
  const before = shares();
  const queued = await c.post({ projectId: shared.id, folderId: folder.id }), done = await c.run(queued.body.operation);
  assert.equal(done.status, 'succeeded', done.errorMessage);
  const task = c.processing.getTask(done.result.task.id), attempt = c.processing.getAttempt(done.result.attempt.id);
  assert.equal(attempt.status, 'ready_for_review');
  assert.equal(task.publishedModelId, null);
  assert.deepEqual([visible(shared), visible(other)], [[], []]);
  assert.equal(shares(), before);
  // Published, it follows its project like every other task, and only its own folder is named.
  c.db.prepare('UPDATE processing_tasks SET published_model_id=? WHERE id=?').run(attempt.resultModelId, task.id);
  c.db.prepare("UPDATE model_outputs SET status='published' WHERE task_id=?").run(task.id);
  c.db.prepare("UPDATE models SET status='ready',active_version_id=? WHERE id=?").run(attempt.resultModelVersionId, attempt.resultModelId);
  assert.deepEqual([visible(shared), visible(other)], [[task.id], []]);
  assert.deepEqual([...c.processing.clientTaskFolderPaths(shared.id, [task.id])], [[task.id, [{ id: folder.id, name: 'Maps' }]]]);
  assert.equal(shares(), before);
});
