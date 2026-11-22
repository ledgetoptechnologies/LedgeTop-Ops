'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth'),express=require('express');

function fixture(t){
  const database=openDatabase(':memory:');t.after(()=>database.close());
  const processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  const source=processing.createProject({displayName:'Source'}),target=processing.createProject({displayName:'Target'});
  return {database,processing,repository,source,target};
}
function draftTask({processing},project,label='Task'){
  const dataset=processing.createDataset({projectId:project.id,displayName:`${label} photos`,storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  processing.finalizeDataset(dataset.id,[],'a'.repeat(64));
  return processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:label});
}
// A finished, published run: attempt done, no queued jobs, output published and active.
function publishedTask(f,project,label='Published'){
  const {database,processing,repository}=f,task=draftTask(f,project,label);
  const provider=processing.upsertProvider({type:'nodeodm',displayName:`Provider ${label}`,endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'ops:test'});
  const model=repository.upsertModelVersion({provider:'terra',providerModelId:task.id,providerVersionId:'v1',displayName:label,sourceLocator:{},status:'ready',makeActive:true,assets:[]});
  processing.setAttemptResult(attempt.id,model.id,model.activeVersion.id);
  processing.registerModelOutput({versionId:model.activeVersion.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:'models',relativePath:task.id,byteSize:1,assetCount:0});
  database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(model.activeVersion.id);
  database.prepare("UPDATE processing_attempts SET status='published' WHERE id=?").run(attempt.id);
  database.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
  database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=? WHERE id=?").run(attempt.id,model.id,task.id);
  return {task:processing.getTask(task.id),attempt,model,output:model.activeVersion.id};
}
const guardFor=(task,extra={})=>({expectedProjectId:task.projectId,expectedFolderId:task.folderId,expectedFolderRevision:task.folderRevision,...extra});

test('a task moves to another project with its dataset, outputs and folder, audited and guarded',t=>{
  const f=fixture(t),{processing,database,source,target}=f;
  const {task,output}=publishedTask(f,source);
  const sourceFolder=processing.createProjectFolder(source.id,{displayName:'Runs'},'staff');
  const placed=processing.moveTaskToFolder(task.id,sourceFolder.id,'staff');
  const destination=processing.createProjectFolder(target.id,{displayName:'Reprocess'},'staff');
  const foreign=processing.createProjectFolder(source.id,{displayName:'Other'},'staff');
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,foreign.id,'staff',guardFor(placed,{confirmSharingChange:true,canChangePublished:true})),{code:'invalid_folder'});
  assert.throws(()=>processing.moveTaskToProject(task.id,source.id,null,'staff',guardFor(placed)),{code:'same_project'});
  assert.throws(()=>processing.moveTaskToProject(task.id,'missing',null,'staff',guardFor(placed)),{code:'target_project_unavailable'});
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,null,'staff',{...guardFor(placed),expectedFolderRevision:placed.folderRevision-1}),{code:'task_move_conflict'});
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,null,'staff',{...guardFor(placed),expectedProjectId:target.id}),{code:'task_move_conflict'});
  // Published work needs publish permission and an explicit sharing confirmation.
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,destination.id,'staff',guardFor(placed,{confirmSharingChange:true})),{code:'publish_permission_required'});
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,destination.id,'staff',guardFor(placed,{canChangePublished:true})),
    error=>error.code==='sharing_change_unconfirmed'&&error.details.published===true&&error.details.publishedOutputs===1);
  assert.equal(processing.getTask(task.id).projectId,source.id,'refused moves change nothing');
  const moved=processing.moveTaskToProject(task.id,target.id,destination.id,'staff',guardFor(placed,{confirmSharingChange:true,canChangePublished:true}));
  assert.equal(moved.projectId,target.id);assert.equal(moved.folderId,destination.id);assert.equal(moved.folderRevision,placed.folderRevision+1);
  assert.ok(Date.parse(moved.undoExpiresAt)>Date.now());
  assert.equal(processing.getDataset(task.datasetId).projectId,target.id);
  assert.equal(processing.getModelOutput(output).projectId,target.id);
  assert.equal(processing.listTasksPage({projectId:source.id}).items.length,0);
  assert.deepEqual(processing.listTasksPage({projectId:target.id}).items.map(row=>row.id),[task.id]);
  const audit=database.prepare("SELECT actor_id,details_json FROM audit_events WHERE action='processing_task.project_changed' AND entity_id=?").all(task.id);
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,'staff');
  const details=JSON.parse(audit[0].details_json);
  assert.deepEqual({projectId:details.projectId,previousProjectId:details.previousProjectId,folderId:details.folderId,previousFolderId:details.previousFolderId,datasetId:details.datasetId,movedOutputs:details.movedOutputs,sharingChangeConfirmed:details.sharingChangeConfirmed,undo:details.undo},
    {projectId:target.id,previousProjectId:source.id,folderId:destination.id,previousFolderId:sourceFolder.id,datasetId:task.datasetId,movedOutputs:1,sharingChangeConfirmed:true,undo:false});
  // A folder Undo cannot reach across a project move.
  assert.throws(()=>processing.moveTaskToFolder(task.id,null,'staff',{expectedFolderId:destination.id,expectedFolderRevision:moved.folderRevision,undo:true}),{code:'folder_undo_conflict'});
  // Undo is actor-scoped, needs no new confirmation and restores the original project and folder.
  assert.throws(()=>processing.moveTaskToProject(task.id,source.id,sourceFolder.id,'someone-else',guardFor(moved,{undo:true})),{code:'task_move_undo_conflict'});
  assert.throws(()=>processing.moveTaskToProject(task.id,source.id,null,'staff',guardFor(moved,{undo:true})),{code:'task_move_undo_conflict'});
  const restored=processing.moveTaskToProject(task.id,source.id,sourceFolder.id,'staff',guardFor(moved,{undo:true,canChangePublished:true}));
  assert.equal(restored.projectId,source.id);assert.equal(restored.folderId,sourceFolder.id);assert.equal(restored.undoExpiresAt,undefined);
  assert.equal(processing.getDataset(task.datasetId).projectId,source.id);assert.equal(processing.getModelOutput(output).projectId,source.id);
  assert.throws(()=>processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(restored,{undo:true})),{code:'task_move_undo_conflict'},'an Undo cannot be undone');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('a task cannot change project while it or its files are busy, or while its photos are shared',t=>{
  const f=fixture(t),{processing,database,source,target}=f;
  const {task,attempt}=publishedTask(f,source,'Busy');
  const tryMove=()=>processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(processing.getTask(task.id),{confirmSharingChange:true,canChangePublished:true}));
  for(const status of ['running','ingesting','derivatives','queued_upstream']){
    database.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(status,attempt.id);
    assert.throws(tryMove,{code:'task_busy'},`attempt ${status}`);
  }
  database.prepare("UPDATE processing_attempts SET status='published' WHERE id=?").run(attempt.id);
  database.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(task.id);
  assert.throws(tryMove,{code:'task_busy'},'task processing');
  database.prepare("UPDATE processing_tasks SET status='published' WHERE id=?").run(task.id);
  const now=new Date().toISOString();
  database.prepare("INSERT INTO derivative_jobs(id,attempt_id,derivative_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run('derivative-busy',attempt.id,'ept','leased',now,now);
  assert.throws(tryMove,{code:'task_busy'},'derivative job leased');
  database.prepare("UPDATE derivative_jobs SET status='complete' WHERE id='derivative-busy'").run();
  database.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run('ingest-busy',attempt.id,'ingest','pending',now,now,now);
  assert.throws(tryMove,{code:'task_busy'},'ingest job pending');
  database.prepare("UPDATE processing_jobs SET status='complete' WHERE id='ingest-busy'").run();
  // A second task on the same photos keeps the dataset in its project.
  const sibling=processing.createTask({projectId:source.id,datasetId:task.datasetId,displayName:'Reprocess on same photos'});
  assert.throws(tryMove,{code:'dataset_shared'});
  database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(sibling.id);
  assert.throws(tryMove,{code:'dataset_shared'},'an archived sibling still holds the dataset');
  const own=processing.createDataset({projectId:source.id,displayName:'Sibling photos',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  database.prepare('UPDATE processing_tasks SET dataset_id=? WHERE id=?').run(own.id,sibling.id);
  // The destination already has a dataset with the same name.
  const clash=processing.createDataset({projectId:target.id,displayName:'Busy photos',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  assert.throws(tryMove,{code:'dataset_name_conflict'});
  database.prepare("UPDATE datasets SET display_name='Other photos' WHERE id=?").run(clash.id);
  assert.equal(tryMove().projectId,target.id);
  database.prepare("UPDATE projects SET status='archived' WHERE id=?").run(source.id);
  assert.throws(()=>processing.moveTaskToProject(task.id,source.id,null,'staff',guardFor(processing.getTask(task.id),{confirmSharingChange:true,canChangePublished:true})),{code:'target_project_unavailable'});
});

test('a moved task leaves the old project shares and appears through the new project shares',t=>{
  const f=fixture(t),{processing,repository,source,target}=f;
  const {task,model}=publishedTask(f,source,'Shared');
  const oldShare=repository.createProjectShare({projectId:source.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true}});
  const newShare=repository.createProjectShare({projectId:target.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true}});
  const modelLink=repository.createPublicShare?.({modelId:model.id,versionPolicy:'latest',publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true}});
  assert.equal(processing.getActivePublishedProjectTask(oldShare.projectId,task.id,{strictPublished:true})?.taskId,task.id);
  assert.ok(!processing.getActivePublishedProjectTask(newShare.projectId,task.id,{strictPublished:true}));
  let refused;try{processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(task,{canChangePublished:true}));}catch(error){refused=error;}
  assert.deepEqual(refused.details,{published:true,publishedOutputs:1,sourceLiveProjectShares:1,targetLiveProjectShares:1});
  const moved=processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(task,{confirmSharingChange:true,canChangePublished:true}));
  assert.deepEqual(moved.sharing,refused.details);
  assert.ok(!processing.getActivePublishedProjectTask(oldShare.projectId,task.id,{strictPublished:true}),'old project shares lose the task');
  assert.equal(processing.getActivePublishedProjectTask(newShare.projectId,task.id,{strictPublished:true})?.taskId,task.id,'new project shares gain the task');
  assert.deepEqual(processing.listActivePublishedProjectTasksPage(source.id,{strictPublished:true}).items,[]);
  assert.deepEqual(processing.listActivePublishedProjectTasksPage(target.id,{strictPublished:true}).items.map(row=>row.taskId),[task.id]);
  // Grants themselves are untouched: both project shares stay live and model-level links are not revoked.
  assert.equal(repository.projectShareLive(repository.getProjectShare(oldShare.id)),true);
  assert.equal(repository.projectShareLive(repository.getProjectShare(newShare.id)),true);
  if(modelLink)assert.equal(repository.getPublicShare(modelLink.id).revokedAt,null);
});

test('Undo of a project move rechecks publish permission and reuses confirmation only for the same exposure',t=>{
  const f=fixture(t),{processing,repository,database,source,target}=f;
  const snapshot=taskId=>({task:(({projectId,folderId,folderRevision})=>({projectId,folderId,folderRevision}))(processing.getTask(taskId)),
    audits:database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id=? AND action='processing_task.project_changed'").get(taskId).n});
  const refusedUnchanged=(taskId,move,code)=>{const before=snapshot(taskId);assert.throws(move,{code});assert.deepEqual(snapshot(taskId),before,`${code} leaves placement and audit unchanged`);};

  // (a) Moved while unpublished by someone without publish scope; published before the Undo.
  const late=publishedTask(f,source,'Published later');
  database.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(late.output);
  const lateMoved=processing.moveTaskToProject(late.task.id,target.id,null,'writer',guardFor(late.task));
  assert.equal(lateMoved.sharing.published,false,'an unpublished move needs no publish scope');
  database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(late.output);
  const lateUndo=extra=>()=>processing.moveTaskToProject(late.task.id,source.id,null,'writer',guardFor(lateMoved,{undo:true,...extra}));
  refusedUnchanged(late.task.id,lateUndo({}),'publish_permission_required');
  refusedUnchanged(late.task.id,lateUndo({confirmSharingChange:true}),'publish_permission_required');
  refusedUnchanged(late.task.id,lateUndo({canChangePublished:true}),'sharing_change_unconfirmed');
  const lateRestored=lateUndo({canChangePublished:true,confirmSharingChange:true})();
  assert.equal(lateRestored.projectId,source.id);

  // (b) Published and confirmed forward move; publish permission is gone before the Undo.
  const {task}=publishedTask(f,source,'Revoked');
  const moved=processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(task,{confirmSharingChange:true,canChangePublished:true}));
  const undo=extra=>()=>processing.moveTaskToProject(task.id,source.id,null,'staff',guardFor(moved,{undo:true,...extra}));
  refusedUnchanged(task.id,undo({}),'publish_permission_required');
  // The same actor with current publish scope reverses the identical exposure without confirming again.
  const restored=undo({canChangePublished:true})();
  assert.equal(restored.projectId,source.id);
  const audit=JSON.parse(database.prepare("SELECT details_json FROM audit_events WHERE entity_id=? AND action='processing_task.project_changed' ORDER BY rowid DESC LIMIT 1").get(task.id).details_json);
  assert.equal(audit.undo,true);assert.equal(audit.sharingChangeConfirmed,true);

  // (c) The exposure changed after the forward move: a new live share on the destination needs a fresh confirmation.
  const second=processing.getTask(task.id);
  const again=processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(second,{confirmSharingChange:true,canChangePublished:true}));
  repository.createProjectShare({projectId:target.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true}});
  const changedUndo=extra=>()=>processing.moveTaskToProject(task.id,source.id,null,'staff',guardFor(again,{undo:true,canChangePublished:true,...extra}));
  refusedUnchanged(task.id,changedUndo({}),'sharing_change_unconfirmed');
  assert.equal(changedUndo({confirmSharingChange:true})().projectId,source.id);
});

test('a task whose runs used other datasets, or whose dataset another task runs on, does not change project',t=>{
  const f=fixture(t),{processing,database,source,target}=f;
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Provider history',endpoint:'http://127.0.0.1:3000',enabled:true});
  const finishedAttempt=(taskId,datasetId,status='failed')=>{const attempt=processing.createAttempt({taskId,datasetId,providerId:provider.id,options:{},createdBy:'ops:test'});
    database.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(status,attempt.id);database.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
    database.prepare("UPDATE processing_tasks SET status='failed' WHERE id=?").run(taskId);return attempt;};
  const photos=label=>{const dataset=processing.createDataset({projectId:source.id,displayName:label,storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});processing.finalizeDataset(dataset.id,[],'b'.repeat(64));return dataset;};
  const state=task=>({task:(({projectId,folderId,folderRevision,datasetId})=>({projectId,folderId,folderRevision,datasetId}))(processing.getTask(task.id)),
    datasets:database.prepare('SELECT id,project_id FROM datasets ORDER BY id').all().map(row=>`${row.id}:${row.project_id}`),
    outputs:database.prepare('SELECT id,project_id FROM model_outputs ORDER BY id').all().map(row=>`${row.id}:${row.project_id}`),
    audits:database.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='processing_task.project_changed'").get().n});
  const refused=(task,code)=>{const before=state(task);assert.throws(()=>processing.moveTaskToProject(task.id,target.id,null,'staff',guardFor(processing.getTask(task.id),{confirmSharingChange:true,canChangePublished:true})),{code});assert.deepEqual(state(task),before,`${code} leaves placement, data and audit unchanged`);};

  // Shape 1: an earlier run of this task used other photos than its current primary dataset.
  const historical=draftTask(f,source,'Historical'),earlier=photos('Earlier photos');
  finishedAttempt(historical.id,earlier.id);
  refused(historical,'task_has_historical_datasets');

  // Shape 2: another task's run uses this task's primary dataset while its own primary differs.
  const owner=draftTask(f,source,'Owner'),borrower=draftTask(f,source,'Borrower');
  finishedAttempt(borrower.id,owner.datasetId);
  refused(owner,'dataset_referenced_by_other_task');
  assert.equal(processing.getDataset(owner.datasetId).projectId,source.id);

  // Allowed move: every run used the primary dataset, so a failed historical run can still be retried afterwards.
  const single=draftTask(f,source,'Single'),failed=finishedAttempt(single.id,single.datasetId);
  const moved=processing.moveTaskToProject(single.id,target.id,null,'staff',guardFor(processing.getTask(single.id)));
  assert.equal(moved.projectId,target.id);assert.equal(processing.getDataset(single.datasetId).projectId,target.id);
  const retried=processing.retryAttempt(failed.id,'ops:test');
  assert.ok(retried,'historical retry works after an allowed move');assert.equal(retried.datasetId,single.datasetId);assert.equal(retried.taskId,single.id);
});

test('project move API checks permissions, idempotency, concurrency and reports sharing',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-task-move-api-')),db=openDatabase(path.join(root,'db.sqlite'));
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const tokens={full:'move-full-token-0000000000000000000',noPublish:'move-nopublish-token-00000000000000',folderOnly:'move-folder-only-token-00000000000',read:'move-read-token-0000000000000000000'};
  const base=['viewer.projects.read','viewer.processing.read','viewer.processing.write'];
  for(const [name,permissions] of [['full',[...base,'viewer.projects.write','viewer.datasets.write','viewer.processing.publish']],['noPublish',[...base,'viewer.projects.write','viewer.datasets.write']],['folderOnly',[...base,'viewer.projects.write']],['read',['viewer.projects.read','viewer.processing.read']]])
    processing.createAdminSession({tokenHash:auth.hashToken(tokens[name]),subject:`staff:${name}`,permissions,displayUnits:'metric',expiresAt:new Date(Date.now()+60000).toISOString()});
  const f={database:db,processing,repository},source=processing.createProject({displayName:'Source'}),target=processing.createProject({displayName:'Target'});
  const draft=draftTask(f,source,'Draft'),{task:published}=publishedTask(f,source,'Published');
  // Same parser as server/index.js: idempotency hashes the exact request octets kept in req.rawBody.
  const app=express();app.use(express.json({verify(req,_res,buffer){req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(task,body,credential=tokens.full,key=crypto.randomUUID())=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/tasks/${task.id}/project`,{method:'PATCH',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
  const body=(task,extra={})=>({projectId:target.id,folderId:null,expectedProjectId:task.projectId,expectedFolderId:task.folderId,expectedFolderRevision:task.folderRevision,...extra});
  assert.equal((await call(draft,body(draft),tokens.read)).status,403);
  assert.equal((await call(draft,body(draft),tokens.folderOnly)).status,403,'dataset write permission is required');
  assert.equal((await call(draft,{...body(draft),extra:true})).status,400);
  assert.equal((await call(draft,{...body(draft),confirmSharingChange:'yes'})).status,400);
  assert.equal((await call(draft,{...body(draft),expectedFolderRevision:-1})).status,400);
  assert.equal((await call({id:crypto.randomUUID()},body(draft))).status,404);
  const stale=await call(draft,{...body(draft),expectedFolderRevision:draft.folderRevision+1});
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,'task_move_conflict');
  // Unpublished work moves with processing, project and dataset write permission alone.
  const key=crypto.randomUUID(),moved=await call(draft,body(draft),tokens.noPublish,key);
  assert.equal(moved.status,200);const result=await moved.json();
  assert.equal(result.task.projectId,target.id);assert.equal(result.sharing.published,false);assert.ok(result.undoExpiresAt);assert.ok(result.serverTime);
  const replay=await call(draft,body(draft),tokens.noPublish,key);
  assert.equal(replay.status,200);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='processing_task.project_changed' AND entity_id=?").get(draft.id).n,1,'a replay is not a second move');
  // Reusing the key for a different destination or confirmation is a conflict, never a replay or a second move.
  const third=processing.createProject({displayName:'Third'});
  for(const changed of [{...body(draft),projectId:third.id},{...body(draft),confirmSharingChange:true}]){
    const reused=await call(draft,changed,tokens.noPublish,key);
    assert.equal(reused.status,409);assert.equal((await reused.json()).code,'idempotency_conflict');
  }
  assert.equal(processing.getTask(draft.id).projectId,target.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='processing_task.project_changed' AND entity_id=?").get(draft.id).n,1,'a conflicting key makes no second move');
  const undo=await call(draft,{projectId:source.id,folderId:null,expectedProjectId:target.id,expectedFolderId:null,expectedFolderRevision:result.task.folderRevision,undo:true},tokens.noPublish);
  assert.equal(undo.status,200);assert.equal((await undo.json()).task.projectId,source.id);
  // Published work needs publish permission and an explicit confirmation; the refusal explains the sharing change.
  const forbidden=await call(published,body(published),tokens.noPublish);
  assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).code,'publish_permission_required');
  const unconfirmed=await call(published,body(published));
  assert.equal(unconfirmed.status,409);
  const refusal=await unconfirmed.json();assert.equal(refusal.code,'sharing_change_unconfirmed');assert.equal(refusal.details.published,true);
  const confirmed=await call(published,body(published,{confirmSharingChange:true}));
  assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).task.projectId,target.id);
  // Undo is re-authorized at Undo time: a task published after the forward move cannot be moved back without publish scope.
  const {output:lateOutput,task:lateTask}=(()=>{const value=publishedTask(f,source,'Late publish');db.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(value.output);return value;})();
  const lateMove=await call(lateTask,body(lateTask),tokens.noPublish);assert.equal(lateMove.status,200);const lateMoved=(await lateMove.json()).task;
  db.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(lateOutput);
  const lateUndo=await call(lateTask,{projectId:source.id,folderId:null,expectedProjectId:target.id,expectedFolderId:null,expectedFolderRevision:lateMoved.folderRevision,undo:true},tokens.noPublish);
  assert.equal(lateUndo.status,403);assert.equal((await lateUndo.json()).code,'publish_permission_required');
  assert.equal(processing.getTask(lateTask.id).projectId,target.id);
  const busy=draftTask(f,source,'Busy');db.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(busy.id);
  const busyResponse=await call(busy,body(busy));assert.equal(busyResponse.status,409);assert.equal((await busyResponse.json()).code,'task_busy');
});
