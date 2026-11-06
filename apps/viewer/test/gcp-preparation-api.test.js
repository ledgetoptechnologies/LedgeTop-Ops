'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {parseGcpInterchange}=require('../server/gcpImport');
const {createProcessingApi}=require('../server/processingApi');

test('valid imported GCP points hold task submission for review, then create one retained-input attempt',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-preparation-'));
  const database=openDatabase(path.join(root,'viewer.sqlite')),repository=new ViewerRepository(database),processing=new ProcessingRepository(database),gcp=new GcpRepository(database),subject='ops:gcp-preparation',token='gcp-preparation-token-0000000000000000';
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.processing.read','viewer.processing.write','viewer.datasets.read','viewer.datasets.write','viewer.gcp.read','viewer.gcp.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const project=processing.createProject({displayName:'Survey'}),dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const image=Buffer.from('image'),csv=Buffer.from('point_id,label,latitude,longitude,elevation_m\nA,North target,44.5,-88.1,250\n'),manifest=[
    {id:'photo-one',relativePath:'photos/nearby.jpg',byteSize:image.length,sha256:crypto.createHash('sha256').update(image).digest('hex'),contentType:'image/jpeg',processingRole:'image',metadata:{width:100,height:100}},
    {id:'gcp-source-one',relativePath:'raw/control.csv',byteSize:csv.length,sha256:crypto.createHash('sha256').update(csv).digest('hex'),contentType:'text/csv',processingRole:'gcp_source'},
  ];
  const canonical=manifest.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}));
  processing.finalizeDataset(dataset.id,manifest,crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  const parsed=parseGcpInterchange({format:'generic-csv-v1',content:csv.toString('utf8')}),set=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-source-one',sourceFilename:'control.csv',sourceSha256:parsed.sourceSha256,sourceContent:csv.toString('utf8'),crs:parsed.crs,elevationUnits:parsed.elevationUnits,provenance:parsed.provenance,points:parsed.points});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'}]},fingerprint:'c'.repeat(64),health:'healthy'});
  processing.workerStatus=()=>({live:true});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers={'authorization':`Bearer ${token}`,'content-type':'application/json'},datasetView=await fetch(`${base}/api/v1/datasets/${dataset.id}`,{headers});
  assert.equal(datasetView.status,200);
  const datasetBody=await datasetView.json();
  assert.equal(datasetBody.dataset.hasGcpPoints,true);
  assert.equal(datasetBody.dataset.hasGcpSourceFiles,true);
  const submissionId=crypto.randomUUID(),body={submissionId,projectId:project.id,datasetId:dataset.id,displayName:'Flight model',preparation:{kind:'gcp_review',providerId:provider.id,options:{}}};
  const create=()=>fetch(`${base}/api/v1/tasks`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});
  const first=await create();assert.equal(first.status,201);const result=await first.json();assert.equal(result.gcpReviewRequired,true);assert.equal(result.task.status,'draft');assert.equal(result.task.metadata.gcpPreparation.providerId,provider.id);
  const replay=await create();assert.equal(replay.status,200);assert.equal((await replay.json()).task.id,result.task.id);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,0);assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_jobs').get().n,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM retained_dataset_files WHERE dataset_file_id=?').get('gcp-source-one').n,1,'the raw CSV is retained permanently even after import');
  const ordinaryResponse=await fetch(`${base}/api/v1/tasks`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({submissionId:crypto.randomUUID(),projectId:project.id,datasetId:dataset.id,displayName:'Ordinary draft'})});
  assert.equal(ordinaryResponse.status,201);const ordinaryTask=(await ordinaryResponse.json()).task;
  const forgedPatch=await fetch(`${base}/api/v1/tasks/${ordinaryTask.id}`,{method:'PATCH',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({metadata:{gcpPreparation:result.task.metadata.gcpPreparation}})});
  assert.equal(forgedPatch.status,400,'the generic task PATCH cannot forge a GCP-preparation marker');
  const directAttempt=()=>fetch(`${base}/api/v1/tasks/${ordinaryTask.id}/attempts`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({providerId:provider.id,options:{}})});
  const directAttemptResponse=await directAttempt();assert.equal(directAttemptResponse.status,409,'the ordinary attempt route cannot bypass required GCP review');
  const directSubmit=await fetch(`${base}/api/v1/task-submissions`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({submissionId:crypto.randomUUID(),projectId:project.id,datasetId:dataset.id,taskDisplayName:'Bypass draft',providerId:provider.id,options:{}})});
  assert.equal(directSubmit.status,409,'the legacy submission route cannot bypass required GCP review');
  gcp.createCorrespondence({taskId:result.task.id,pointId:set.points[0].id,imageFileId:'photo-one',pixelX:22,pixelY:31,createdBy:subject});
  const start=()=>fetch(`${base}/api/v1/tasks/${result.task.id}/start-gcp-review`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({gcpHeightSource:'source'})});
  const savedMetadata=processing.getTask(result.task.id).metadata,invalidPreparation={...savedMetadata,gcpPreparation:{...savedMetadata.gcpPreparation,options:{...savedMetadata.gcpPreparation.options,gltf:false}}};
  database.prepare('UPDATE processing_tasks SET metadata_json=? WHERE id=?').run(JSON.stringify(invalidPreparation),result.task.id);
  assert.equal((await start()).status,400,'saved preparation options are revalidated against required outputs before queueing');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(result.task.id).n,0);
  database.prepare('UPDATE processing_tasks SET metadata_json=? WHERE id=?').run(JSON.stringify(savedMetadata),result.task.id);
  processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'}]},fingerprint:'d'.repeat(64),health:'healthy'});
  assert.equal((await start()).status,409,'a preparation created against stale provider capabilities cannot queue');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(result.task.id).n,0);
  processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'}]},fingerprint:'c'.repeat(64),health:'healthy'});
  const started=await start();assert.equal(started.status,202);const attemptId=(await started.json()).attempt.id;
  const startReplay=await start();assert.equal(startReplay.status,200);assert.equal((await startReplay.json()).attempt.id,attemptId);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(result.task.id).n,1);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=?').get(attemptId).n,1);
  assert.equal(processing.getTask(result.task.id).metadata.gcpPreparation,undefined);
  assert.ok(processing.getAttemptGcpSnapshot(attemptId),'the GCP file and correspondence evidence are bound to this processing attempt');

  const invalidCsv=Buffer.from('date,temperature\n2026-01-01,12\n'),noGcpDataset=processing.createDataset({projectId:project.id,displayName:'Unrecognized CSV',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()}),invalidManifest=[
    {id:'unrecognized-source',relativePath:'raw/notes.csv',byteSize:invalidCsv.length,sha256:crypto.createHash('sha256').update(invalidCsv).digest('hex'),contentType:'text/csv',processingRole:'gcp_source'},
  ],invalidCanonical=invalidManifest.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}));
  processing.finalizeDataset(noGcpDataset.id,invalidManifest,crypto.createHash('sha256').update(JSON.stringify(invalidCanonical)).digest('hex'));
  const noGcpRequest={submissionId:crypto.randomUUID(),projectId:project.id,datasetId:noGcpDataset.id,taskDisplayName:'No-GCP acknowledgement',providerId:provider.id,options:{}};
  const submitNoGcp=(allowNoGcp=false)=>fetch(`${base}/api/v1/task-submissions`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({...noGcpRequest,...(allowNoGcp?{allowNoGcp:true}:{})})});
  assert.equal((await submitNoGcp()).status,409,'an attached but invalid raw GCP CSV cannot silently downgrade to an ordinary task');
  assert.equal((await submitNoGcp(true)).status,201,'the explicit no-GCP choice permits processing');
  database.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(provider.id);
  assert.equal((await submitNoGcp(true)).status,200,'an exact idempotent replay succeeds even when mutable provider eligibility later changes');
  database.prepare('UPDATE processing_providers SET enabled=1 WHERE id=?').run(provider.id);
  const invalidDraftResponse=await fetch(`${base}/api/v1/tasks`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({submissionId:crypto.randomUUID(),projectId:project.id,datasetId:noGcpDataset.id,displayName:'Invalid GCP draft'})});
  assert.equal(invalidDraftResponse.status,201);const invalidDraft=(await invalidDraftResponse.json()).task;
  const directNoGcp=(allowNoGcp=false)=>fetch(`${base}/api/v1/tasks/${invalidDraft.id}/attempts`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({providerId:provider.id,options:{},...(allowNoGcp?{allowNoGcp:true}:{})})});
  assert.equal((await directNoGcp()).status,409,'direct attempt creation also requires explicit no-GCP acknowledgement');
  assert.equal((await directNoGcp(true)).status,202,'the direct attempt route honors the explicit no-GCP acknowledgement');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM retained_dataset_files WHERE dataset_file_id=?').get('unrecognized-source').n,1,'the invalid raw CSV remains retained');
});
