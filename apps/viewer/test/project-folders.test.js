'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase,MIGRATIONS}=require('../server/database');
const {DatabaseSync}=require('node:sqlite');
const {Worker}=require('node:worker_threads');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth'),express=require('express');

test('nested project folders organize tasks without changing their project or source',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-folders-')),db=openDatabase(path.join(root,'db.sqlite'));
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic'}),other=p.createProject({displayName:'Other'});
  const source=p.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  p.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  const task=p.createTask({projectId:project.id,datasetId:source.id,displayName:'Task'});
  assert.equal(task.folderId,null);
  const parent=p.createProjectFolder(project.id,{displayName:'Client'},'staff');
  const child=p.createProjectFolder(project.id,{displayName:'Site',parentId:parent.id},'staff');
  const outsider=p.createProjectFolder(other.id,{displayName:'Other'},'staff');
  assert.throws(()=>p.createProjectFolder(project.id,{displayName:'client'},'staff'),{code:'folder_name_conflict'});
  assert.throws(()=>p.createProjectFolder(project.id,{displayName:'Bad',parentId:outsider.id},'staff'),{code:'invalid_parent_folder'});
  assert.throws(()=>p.moveTaskToFolder(task.id,outsider.id,'staff'),{code:'invalid_folder'});
  assert.throws(()=>db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(outsider.id,task.id),/folder_project_mismatch/);
  const moved=p.moveTaskToFolder(task.id,child.id,'staff');
  assert.equal(moved.projectId,project.id);assert.equal(moved.datasetId,source.id);assert.equal(moved.folderId,child.id);
  assert.equal(p.listTasksPage({projectId:project.id}).items.some(row=>row.id===task.id&&row.folderId===child.id),true);
  assert.deepEqual(p.projectFolders(project.id).map(row=>row.id).sort(),[parent.id,child.id].sort());
  assert.equal(p.moveTaskToFolder(task.id,null,'staff').folderId,null);
  assert.throws(()=>p.deleteEmptyProjectFolder(project.id,parent.id,'staff'),{code:'folder_not_empty'});
  p.moveTaskToFolder(task.id,child.id,'staff');
  db.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(task.id);
  assert.throws(()=>p.deleteEmptyProjectFolder(project.id,child.id,'staff'),{code:'folder_not_empty'});
  assert.equal(p.getTask(task.id).datasetId,source.id);
  const unused=p.createProjectFolder(project.id,{displayName:'Unused'},'staff');
  assert.equal(p.renameProjectFolder(project.id,unused.id,'Renamed','staff').displayName,'Renamed');
  assert.throws(()=>p.renameProjectFolder(project.id,unused.id,'CLIENT','staff'),{code:'folder_name_conflict'});
  assert.equal(p.deleteEmptyProjectFolder(project.id,unused.id,'staff'),true);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('folder migration preserves an existing project, dataset and task',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-folders-upgrade-')),dbPath=path.join(root,'db.sqlite');
  let db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.filter(item=>item.version<=42)){db.exec('BEGIN IMMEDIATE');db.exec(migration.sql);migration.after?.(db);db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());db.exec('COMMIT');}
  let processing=new ProcessingRepository(db);
  const project=processing.createProject({displayName:'Existing'}),source=processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  processing.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  const task=processing.createTask({projectId:project.id,datasetId:source.id,displayName:'Existing task'});
  db.close();db=openDatabase(dbPath);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});processing=new ProcessingRepository(db);
  const upgraded=processing.getTask(task.id);assert.equal(upgraded.folderId,null);assert.equal(upgraded.projectId,project.id);assert.equal(upgraded.datasetId,source.id);
  assert.equal(processing.getProject(project.id).displayName,'Existing');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('folder deletion waits for another connection moving a task into it', {timeout:5000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-folders-race-')),dbPath=path.join(root,'db.sqlite'),db=openDatabase(dbPath);
  const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),source=processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  processing.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  const task=processing.createTask({projectId:project.id,datasetId:source.id,displayName:'Task'}),folder=processing.createProjectFolder(project.id,{displayName:'Folder'},'staff');
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const {openDatabase}=require(workerData.databaseModule),{ProcessingRepository}=require(workerData.repositoryModule);
    const db=openDatabase(workerData.dbPath),processing=new ProcessingRepository(db);
    parentPort.postMessage({type:'ready'});
    parentPort.once('message',()=>{parentPort.postMessage({type:'starting'});try{processing.deleteEmptyProjectFolder(workerData.projectId,workerData.folderId,'staff');parentPort.postMessage({type:'result',value:'deleted'});}catch(error){parentPort.postMessage({type:'result',value:error.code||error.message});}finally{db.close();}});
  `,{eval:true,workerData:{databaseModule:require.resolve('../server/database'),repositoryModule:require.resolve('../server/processingRepository'),dbPath,projectId:project.id,folderId:folder.id}});
  t.after(async()=>{await worker.terminate();if(db.isTransaction)db.exec('ROLLBACK');db.close();fs.rmSync(root,{recursive:true,force:true});});
  const messages=[];let wake;worker.on('message',message=>{messages.push(message);wake?.();});worker.on('error',error=>{messages.push({type:'error',value:error.message});wake?.();});
  const next=async()=>{while(!messages.length)await new Promise(resolve=>{wake=resolve;});wake=null;return messages.shift();};
  assert.equal((await next()).type,'ready');
  db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(folder.id,task.id);
  worker.postMessage('delete');assert.equal((await next()).type,'starting');
  await new Promise(resolve=>setTimeout(resolve,25));db.exec('COMMIT');
  assert.deepEqual(await next(),{type:'result',value:'folder_not_empty'});
  assert.equal(processing.getTask(task.id).folderId,folder.id);assert.equal(processing.projectFolders(project.id)[0].id,folder.id);
});

test('folder API requires permissions and moves only within the original project',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-folders-api-')),db=openDatabase(path.join(root,'db.sqlite'));
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),token='folder-test-token-000000000000000',readOnly='folder-read-token-000000000000000';
  for(const [value,permissions] of [[token,['viewer.projects.read','viewer.projects.write','viewer.processing.write']],[readOnly,['viewer.projects.read']]])processing.createAdminSession({tokenHash:auth.hashToken(value),subject:`staff:${value}`,permissions,displayUnits:'metric',expiresAt:new Date(Date.now()+60000).toISOString()});
  const project=processing.createProject({displayName:'Synthetic'}),other=processing.createProject({displayName:'Other'}),source=processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  processing.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  const task=processing.createTask({projectId:project.id,datasetId:source.id,displayName:'Task'}),outside=processing.createProjectFolder(other.id,{displayName:'Other'},'staff');
  const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(route,method='GET',body,credential=token)=>fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{authorization:`Bearer ${credential}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const endpoint=`/api/v1/projects/${project.id}/folders`;
  assert.equal((await call(endpoint,'POST',{displayName:'Client'},readOnly)).status,403);
  const created=await call(endpoint,'POST',{displayName:'Client',parentId:null});assert.equal(created.status,201);const folder=(await created.json()).folder;
  const list=await call(endpoint,'GET',undefined,readOnly);assert.deepEqual((await list.json()).folders,[folder]);
  assert.equal((await call(`/api/v1/tasks/${task.id}/folder`,'PATCH',{folderId:outside.id})).status,400);
  assert.equal((await call(`/api/v1/tasks/${task.id}/folder`,'PATCH',{folderId:folder.id},readOnly)).status,403);
  const moved=await call(`/api/v1/tasks/${task.id}/folder`,'PATCH',{folderId:folder.id});assert.equal(moved.status,200);assert.equal((await moved.json()).task.folderId,folder.id);
  assert.equal(processing.getTask(task.id).projectId,project.id);
  const folderUrl=`${endpoint}/${folder.id}`;
  const wrongProjectUrl=`/api/v1/projects/${other.id}/folders/${folder.id}`;
  assert.equal((await call(wrongProjectUrl,'PATCH',{displayName:'Wrong project'})).status,404);
  assert.equal((await call(wrongProjectUrl,'DELETE')).status,404);
  assert.equal((await call(folderUrl,'DELETE',undefined,readOnly)).status,403);
  assert.equal((await call(folderUrl,'DELETE')).status,409);
  const renamed=await call(folderUrl,'PATCH',{displayName:'Renamed'});assert.equal(renamed.status,200);assert.equal((await renamed.json()).folder.displayName,'Renamed');
  assert.equal((await call(`/api/v1/tasks/${task.id}/folder`,'PATCH',{folderId:null})).status,200);
  assert.equal((await call(folderUrl,'DELETE')).status,200);
  assert.equal(processing.getTask(task.id).datasetId,source.id);
});


test('permanent task purge releases folder membership and preserves its retained tombstone and audit',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic purge'});
  const source=p.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  p.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  const task=p.createTask({projectId:project.id,datasetId:source.id,displayName:'Task'});
  const folder=p.createProjectFolder(project.id,{displayName:'Folder'},'staff');
  p.moveTaskToFolder(task.id,folder.id,'staff');
  const trash=p.trashTask(task.id,'staff');assert.ok(trash);
  assert.throws(()=>p.deleteEmptyProjectFolder(project.id,folder.id,'staff'),{code:'folder_not_empty'});
  assert.ok(p.restoreMetadataEntity(trash.id,'staff'));
  assert.equal(p.getTask(task.id).folderId,folder.id,'recoverable task keeps its original folder');
  const secondTrash=p.trashTask(task.id,'staff');assert.ok(secondTrash);
  assert.ok(p.purgeMetadataEntity(secondTrash.id,'staff').permanentlyDeletedAt);
  const retained=db.prepare('SELECT * FROM processing_tasks WHERE id=?').get(task.id);
  assert.equal(retained.folder_id,null);assert.equal(retained.project_id,project.id);assert.equal(retained.dataset_id,source.id);
  assert.equal(retained.status,'archived');assert.ok(retained.purged_at);
  assert.equal(p.purgeMetadataEntity(secondTrash.id,'staff'),null,'purge remains idempotent');
  const audit=db.prepare("SELECT details_json FROM audit_events WHERE action='task.purged' AND entity_id=?").all(task.id);
  assert.equal(audit.length,1);assert.deepEqual(JSON.parse(audit[0].details_json),{trashId:secondTrash.id,metadataTombstone:true,previousFolderId:folder.id});
  assert.equal(p.deleteEmptyProjectFolder(project.id,folder.id,'staff'),true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processing_tasks WHERE id=?').get(task.id).n,1);
  assert.equal(p.getDataset(source.id).id,source.id);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
