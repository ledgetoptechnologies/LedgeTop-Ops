'use strict';
const assert=require('node:assert/strict');const crypto=require('node:crypto');const express=require('express');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const test=require('node:test');const auth=require('../server/auth');const {openDatabase}=require('../server/database');const {ViewerRepository}=require('../server/repository');const {ProcessingRepository}=require('../server/processingRepository');const {createProcessingApi}=require('../server/processingApi');

test('compound task submission is subject-idempotent across renewed sessions and validates viewer outputs',async(t)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-task-submit-')),database=openDatabase(path.join(root,'viewer.sqlite')),repository=new ViewerRepository(database),processing=new ProcessingRepository(database),subject='ops:submitter',tokens=['task-submit-token-one-000000000000000','task-submit-token-two-000000000000000'];for(const token of tokens)processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});const project=processing.createProject({displayName:'Project'}),dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()}),empty=crypto.createHash('sha256').digest('hex');processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:0,sha256:empty}],empty);const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'},{name:'dsm',type:'bool'}]},fingerprint:'a'.repeat(64),health:'healthy'});const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository,processing,storage:{}}));const server=await new Promise((resolve)=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});t.after(async()=>{await new Promise((resolve)=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}`,submissionId=crypto.randomUUID(),body={submissionId,projectId:project.id,datasetId:dataset.id,taskDisplayName:'Flight model',providerId:provider.id,options:{dsm:false}},post=(token,value=body)=>fetch(`${base}/api/v1/task-submissions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':`submit-${submissionId}`},body:JSON.stringify(value)});const first=await post(tokens[0]);assert.equal(first.status,201);const created=await first.json();assert.equal(created.replayed,false);assert.equal(created.attempt.options.dsm,false);for(const name of['pc-ept','gltf','3d-tiles'])assert.equal(created.attempt.options[name],true);const sameSession=await post(tokens[0]);assert.equal(sameSession.status,200);assert.equal((await sameSession.json()).attempt.id,created.attempt.id);const replay=await post(tokens[1]);assert.equal(replay.status,200);const repeated=await replay.json();assert.equal(repeated.replayed,true);assert.equal(repeated.task.id,created.task.id);assert.equal(repeated.attempt.id,created.attempt.id);const conflict=await post(tokens[1],{...body,taskDisplayName:'Different'});assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'submission_conflict');assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_tasks').get().n,1);assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);});

// Duplicate reuses the original task's source photos and folder through the normal submission, so nothing starts until
// the user submits the pre-filled dialog. It needs only the task-creation permission and is audited.
test('duplicate submission reuses the source set and folder, refuses archived or deleted tasks, and is audited',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-task-duplicate-')),database=openDatabase(path.join(root,'viewer.sqlite')),repository=new ViewerRepository(database),processing=new ProcessingRepository(database),subject='ops:duplicator',token='task-duplicate-token-0000000000000000',readToken='task-duplicate-read-00000000000000000';
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  processing.createAdminSession({tokenHash:auth.hashToken(readToken),subject:'ops:reader',permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const project=processing.createProject({displayName:'Project'}),other=processing.createProject({displayName:'Other'}),empty=crypto.createHash('sha256').digest('hex');
  const dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:0,sha256:empty}],empty);
  const second=processing.createDataset({projectId:project.id,displayName:'Second',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});processing.finalizeDataset(second.id,[{relativePath:'photo.jpg',byteSize:0,sha256:empty}],empty);
  const folder=processing.createProjectFolder(project.id,{displayName:'Flights'},subject),otherFolder=processing.createProjectFolder(other.id,{displayName:'Elsewhere'},subject);
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'},{name:'dsm',type:'bool'}]},fingerprint:'b'.repeat(64),health:'healthy'});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise((resolve)=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(async()=>{await new Promise((resolve)=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const submit=async(extra,as=token)=>{const submissionId=crypto.randomUUID(),response=await fetch(`${base}/api/v1/task-submissions`,{method:'POST',headers:{authorization:`Bearer ${as}`,'content-type':'application/json','idempotency-key':`submit-${submissionId}`},body:JSON.stringify({submissionId,projectId:project.id,datasetId:dataset.id,taskDisplayName:'Flight model',providerId:provider.id,options:{dsm:true},...extra})});return{status:response.status,body:await response.json()};};
  const original=await submit({folderId:folder.id});assert.equal(original.status,201);assert.equal(original.body.task.folderId,folder.id);
  const published=database.prepare("UPDATE processing_tasks SET status='published',description='Original notes',metadata_json='{\"client\":\"visible\"}' WHERE id=?");published.run(original.body.task.id);

  // Permission is the same as creating a task.
  assert.equal((await submit({duplicateOfTaskId:original.body.task.id,folderId:folder.id},readToken)).status,403);

  const copy=await submit({taskDisplayName:'Flight model (copy)',duplicateOfTaskId:original.body.task.id,folderId:folder.id});
  assert.equal(copy.status,201);
  assert.notEqual(copy.body.task.id,original.body.task.id);
  assert.equal(copy.body.task.displayName,'Flight model (copy)');
  assert.equal(copy.body.task.datasetId,dataset.id,'the copy reuses the same source set');
  assert.equal(copy.body.task.folderId,folder.id);
  assert.equal(copy.body.task.status,'queued');
  assert.equal(copy.body.task.publishedModelId,null);
  assert.equal(copy.body.task.description,null);
  assert.deepEqual(copy.body.task.metadata,{});
  assert.equal(copy.body.attempt.options.dsm,true);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM datasets').get().n,2,'no source set is copied');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM model_outputs WHERE task_id=?').get(copy.body.task.id).n,0);
  const audit=database.prepare("SELECT * FROM audit_events WHERE action='processing_task.duplicated'").all();
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,subject);assert.equal(audit[0].entity_id,copy.body.task.id);
  assert.deepEqual(JSON.parse(audit[0].details_json),{sourceTaskId:original.body.task.id,attemptId:copy.body.attempt.id,submissionId:JSON.parse(audit[0].details_json).submissionId,projectId:project.id,datasetId:dataset.id,folderId:folder.id});

  // The copy must use the original's source set, in its project, and a folder of that project.
  assert.equal((await submit({datasetId:second.id,duplicateOfTaskId:original.body.task.id})).body.code,'task_not_duplicable');
  assert.equal((await submit({duplicateOfTaskId:crypto.randomUUID()})).body.code,'task_not_duplicable');
  const wrongFolder=await submit({duplicateOfTaskId:original.body.task.id,folderId:otherFolder.id});assert.equal(wrongFolder.status,400);assert.equal(wrongFolder.body.code,'invalid_folder');
  assert.equal((await submit({folderId:42})).status,400);
  assert.equal((await submit({duplicateOfTaskId:7})).status,400);

  // Archived or deleted (Recycle Bin) tasks cannot be duplicated.
  database.prepare("UPDATE processing_tasks SET status='archived',archived_at=? WHERE id=?").run(new Date().toISOString(),original.body.task.id);
  const archived=await submit({duplicateOfTaskId:original.body.task.id});assert.equal(archived.status,409);assert.equal(archived.body.code,'task_not_duplicable');
  database.prepare("UPDATE processing_tasks SET status='published',archived_at=NULL,purged_at=? WHERE id=?").run(new Date().toISOString(),original.body.task.id);
  assert.equal((await submit({duplicateOfTaskId:original.body.task.id})).body.code,'task_not_duplicable');
  assert.equal(database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='processing_task.duplicated'").get().n,1);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_tasks WHERE dataset_id=?').get(dataset.id).n,2);
});
