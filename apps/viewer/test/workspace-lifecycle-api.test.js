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

async function fixture(t) {
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
  storage.initialize();
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
  const child=context.processing.listContainerTrashMembers(trash.id).find(item=>item.entityType==='dataset');assert.ok(child);
  assert.equal(context.processing.trashHeldByPlan(child,'unrelated-container'),true);
  assert.equal(context.processing.trashHeldByPlan(child,trash.id,'restore'),true,'a parent ID alone is not an action credential');
  assert.equal((await context.request('POST',`/api/v1/storage/trash/${child.id}/restore`,{})).status,409,'a child cannot be restored outside its active container');
  assert.equal((await context.request('DELETE',`/api/v1/storage/trash/${child.id}`,{typedId:child.entityId})).status,409,'a child cannot be purged outside its active container');
  response = await context.request('POST', `/api/v1/storage/trash/${trash.id}/restore`, {}); assert.equal(response.status, 200); assert.equal((await response.json()).project.status, 'active');
  assert.equal(context.database.prepare('SELECT status FROM container_trash_actions WHERE container_trash_id=?').get(trash.id).status,'complete');
  assert.equal(context.database.prepare("SELECT COUNT(*) n FROM container_trash_action_items i JOIN container_trash_actions a ON a.action_id=i.action_id WHERE a.container_trash_id=? AND i.status<>'complete'").get(trash.id).n,0);
  assert.equal(fs.existsSync(datasetDirectory), true); assert.equal(fs.existsSync(output.directory), true); assert.equal(context.processing.getDataset(dataset.id).status, 'finalized'); assert.equal(context.processing.getModelOutput(output.versionId).status, 'ready'); assert.equal(context.processing.getTask(task.id).status, 'ready_for_review');
  response = await context.request('DELETE', `/api/v1/projects/${project.id}`, {}); assert.equal(response.status, 200); trash = (await response.json()).trash;
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: 'wrong' })).status, 400);
  assert.equal((await context.request('DELETE', `/api/v1/storage/trash/${trash.id}`, { typedId: project.id })).status, 204); assert.equal(fs.existsSync(datasetDirectory), false); assert.equal(fs.existsSync(output.directory), false);
  assert.equal(context.database.prepare('SELECT status FROM container_trash_actions WHERE container_trash_id=?').get(trash.id).status,'complete');
  assert.equal(context.processing.getProject(project.id), null, 'purged projects are no longer retrievable'); assert.equal(context.processing.getTask(task.id), null, 'purged tasks are no longer retrievable');
  assert.match(context.database.prepare('SELECT display_name FROM projects WHERE id=?').get(project.id).display_name, /^deleted-project-/); assert.match(context.database.prepare('SELECT display_name FROM processing_tasks WHERE id=?').get(task.id).display_name, /^deleted-task-/);
  const { purgeContainerTrash } = require('../server/containerLifecycle'); assert.equal(purgeContainerTrash(context.processing, context.storage, trash.id, 'ops:lifecycle').permanentlyDeletedAt !== null, true, 'repeat purge is idempotent');
});

test('project trash retry retains a child moved before membership was recorded', {skip:process.env.LTDS_CONTAINER_RECOVERY_REGRESSION!=='1'}, async t => {
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic recovery'}),dataset=finalizedDataset(context,project,'Synthetic child');
  const add=context.processing.addContainerTrashMember.bind(context.processing);let interrupted=false;
  context.processing.addContainerTrashMember=(containerId,memberId)=>{if(!interrupted){interrupted=true;throw Object.assign(new Error('injected membership failure'),{code:'fault_injected'});}return add(containerId,memberId);};
  const first=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(first.status,409);assert.equal(interrupted,true);assert.equal(context.processing.getDataset(dataset.id).status,'trashed');
  const rootBefore=context.processing.activeTrashForEntity('project',project.id),childBefore=context.processing.activeTrashForEntity('dataset',dataset.id);
  assert.equal((await context.request('POST',`/api/v1/storage/trash/${rootBefore.id}/restore`,{})).status,409);
  assert.equal((await context.request('POST',`/api/v1/storage/trash/${childBefore.id}/restore`,{})).status,409);
  assert.equal((await context.request('DELETE',`/api/v1/storage/trash/${childBefore.id}`,{typedId:dataset.id})).status,409);
  context.processing.addContainerTrashMember=add;
  const retry=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(retry.status,200);const root=(await retry.json()).trash;
  assert.ok(context.processing.listContainerTrashMembers(root.id).some(item=>item.entityType==='dataset'&&item.entityId===dataset.id),'retry must retain the moved child under its original container');
});

test('external-reference child cannot be restored outside its active project trash',async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic external parent'});
  const dataset=context.processing.createDataset({projectId:project.id,displayName:'Synthetic external child',storageMode:'external_reference',rootKey:'dataset_import',relativePath:'synthetic'});
  const deleted=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(deleted.status,200);const root=(await deleted.json()).trash;
  const child=context.processing.listContainerTrashMembers(root.id).find(item=>item.entityType==='dataset');assert.equal(child.entityId,dataset.id);
  assert.equal((await context.request('POST',`/api/v1/storage/trash/${child.id}/restore`,{})).status,409);
  assert.equal(context.processing.getDataset(dataset.id).status,'trashed');
  assert.equal((await context.request('POST',`/api/v1/storage/trash/${root.id}/restore`,{})).status,200);
  assert.equal(context.processing.getDataset(dataset.id).status,'draft');
});

test('output archive and trash intent roll back together on interruption',async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic atomic output'}),dataset=finalizedDataset(context,project,'Synthetic output source');
  const task=context.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic task'}),provider=context.processing.upsertProvider({type:'nodeodm',displayName:'Fixture ODM',endpoint:'http://127.0.0.1:3003',enabled:true});
  const output=readyManagedOutput(context,project,dataset,task,provider,'Synthetic output'),original=context.processing.getModelOutput(output.versionId).status;
  const begin=context.processing.beginOutputTrashMutation.bind(context.processing);context.processing.beginOutputTrashMutation=()=>{throw Error('injected intent failure');};
  assert.throws(()=>context.processing.prepareOutputTrash(output.versionId,'ops:lifecycle'),/injected intent failure/);
  assert.equal(context.processing.getModelOutput(output.versionId).status,original);
  context.processing.beginOutputTrashMutation=begin;
  const prepared=context.processing.prepareOutputTrash(output.versionId,'ops:lifecycle');assert.ok(prepared.mutation);assert.equal(prepared.mutation.originalStatus,original);
});

test('planned output refuses an unjournaled status change',async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic output plan'}),dataset=finalizedDataset(context,project,'Synthetic planned source');
  const task=context.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic task'}),provider=context.processing.upsertProvider({type:'nodeodm',displayName:'Fixture ODM',endpoint:'http://127.0.0.1:3004',enabled:true});
  const output=readyManagedOutput(context,project,dataset,task,provider,'Synthetic output');
  const root=context.processing.trashProject(project.id,'ops:lifecycle');assert.ok(root);
  const prior=context.processing.getModelOutput(output.versionId).status,changed=prior==='failed'?'ready':'failed';
  context.database.prepare('UPDATE model_outputs SET status=? WHERE id=?').run(changed,output.versionId);
  assert.equal(context.processing.prepareOutputTrash(output.versionId,'ops:lifecycle',root.id),null);
  assert.equal(context.processing.getModelOutput(output.versionId).status,changed);
});

test('container purge cannot overlap an in-progress restore',{skip:process.env.LTDS_CONTAINER_RECOVERY_REGRESSION!=='1'},async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic opposing actions'});
  finalizedDataset(context,project,'First synthetic child');finalizedDataset(context,project,'Second synthetic child');
  const deleted=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(deleted.status,200);const root=(await deleted.json()).trash;
  const complete=context.processing.completeStorageMutation.bind(context.processing),{purgeContainerTrash}=require('../server/containerLifecycle');let attempted=false,purgeResult;
  context.processing.completeStorageMutation=id=>{const result=complete(id);if(!attempted&&result?.type==='restore'&&result.entityType==='dataset'){attempted=true;const active=context.database.prepare('SELECT action_id,direction FROM container_trash_actions WHERE container_trash_id=?').get(root.id),remaining=context.processing.listContainerTrashMembers(root.id).find(item=>item.entityType==='dataset'&&!item.permanentlyDeletedAt),claim={containerId:root.id,actionId:active.action_id,direction:active.direction};assert.ok(remaining);assert.equal(context.processing.trashHeldByPlan(remaining,claim,'restore'),false);assert.equal(context.processing.trashHeldByPlan(remaining,{...claim,actionId:'wrong'},'restore'),true);assert.equal(context.processing.trashHeldByPlan(remaining,claim,'purge'),true);assert.equal(context.processing.finishContainerAction(claim),false,'action cannot complete with pending children');assert.throws(()=>context.database.prepare('DELETE FROM container_trash_members WHERE container_trash_id=?').run(root.id),/membership sealed/);assert.throws(()=>context.database.prepare('UPDATE container_trash_members SET entity_id=entity_id WHERE container_trash_id=?').run(root.id),/membership sealed/);purgeResult=purgeContainerTrash(context.processing,context.storage,root.id,'ops:lifecycle');}return result;};
  const restored=await context.request('POST',`/api/v1/storage/trash/${root.id}/restore`,{});
  assert.equal(attempted,true);assert.equal(purgeResult,null,'opposing purge must be refused until restore is safely complete');assert.equal(restored.status,200);
});

test('root completion rolls back if its container action cannot complete',async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic action completion'});
  const deleted=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(deleted.status,200);const root=(await deleted.json()).trash;
  context.processing.finishContainerAction=()=>false;
  const restored=await context.request('POST',`/api/v1/storage/trash/${root.id}/restore`,{});assert.ok(restored.status>=400);
  assert.equal(context.processing.getTrash(root.id).permanentlyDeletedAt,null);
  assert.equal(context.database.prepare('SELECT status FROM container_trash_actions WHERE container_trash_id=?').get(root.id).status,'active');
});

test('an interrupted container filesystem effect remains held across a database reopen',async t=>{
  const context=await fixture(t),project=context.processing.createProject({displayName:'Synthetic interrupted action'}),dataset=finalizedDataset(context,project,'Synthetic retained child');
  const deleted=await context.request('DELETE',`/api/v1/projects/${project.id}`,{});assert.equal(deleted.status,200);const root=(await deleted.json()).trash;
  const move=context.storage.moveExact.bind(context.storage);context.storage.moveExact=()=>{throw Error('injected filesystem interruption');};
  const restored=await context.request('POST',`/api/v1/storage/trash/${root.id}/restore`,{});assert.ok(restored.status>=400);context.storage.moveExact=move;
  const action=context.database.prepare('SELECT action_id,direction,status FROM container_trash_actions WHERE container_trash_id=?').get(root.id);assert.equal(action.status,'active');assert.equal(action.direction,'restore');
  const child=context.processing.listContainerTrashMembers(root.id).find(item=>item.entityType==='dataset');assert.equal(child.entityId,dataset.id);
  assert.equal((await context.request('DELETE',`/api/v1/storage/trash/${root.id}`,{typedId:project.id})).status,409);
  const heldMutation=context.database.prepare('SELECT mutation_id FROM container_trash_action_items WHERE action_id=? AND status=?').get(action.action_id,'pending').mutation_id;
  const otherProject=context.processing.createProject({displayName:'Independent recovery'}),otherDataset=context.processing.createDataset({projectId:otherProject.id,displayName:'Independent draft',rootKey:'datasets',relativePath:'independent',storageMode:'managed'}),otherMutation=context.processing.beginTrashMutation(otherDataset.id,'ops:lifecycle');assert.ok(otherMutation);
  const pending=context.processing.pendingStorageMutations();assert.ok(pending.some(item=>item.id===otherMutation.id));assert.equal(pending.some(item=>item.id===heldMutation),false,'action-owned mutations wait for their dedicated executor');
  const independent=openDatabase(path.join(context.root,'viewer.sqlite'));try{const current=independent.prepare('SELECT action_id,direction,status FROM container_trash_actions WHERE container_trash_id=?').get(root.id);assert.deepEqual({...current},{...action});assert.equal(independent.prepare("SELECT COUNT(*) n FROM container_trash_action_items WHERE action_id=? AND status='pending' AND mutation_id IS NOT NULL").get(action.action_id).n,1);}finally{independent.close();}
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
