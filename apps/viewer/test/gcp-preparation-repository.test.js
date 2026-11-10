'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {parseGcpInterchange}=require('../server/gcpImport');

test('GCP preparation is idempotent, waits for photo marks, then binds the selected GCP file to one attempt',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-preparation-repo-')),database=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(database),gcp=new GcpRepository(database),subject='ops:gcp-review';
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Survey'}),dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const photo=Buffer.from('photo'),csv=Buffer.from('Name,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nA,903241.652,549596.746,833.164,Hub,-88.1,44.5,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n');
  const manifest=[
    {id:'photo-one',relativePath:'photo.jpg',byteSize:photo.length,sha256:crypto.createHash('sha256').update(photo).digest('hex'),contentType:'image/jpeg',processingRole:'image',metadata:{width:100,height:100}},
    {id:'gcp-source-one',relativePath:'raw/control.csv',byteSize:csv.length,sha256:crypto.createHash('sha256').update(csv).digest('hex'),contentType:'text/csv',processingRole:'gcp_source'},
  ];
  const canonical=manifest.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}));
  processing.finalizeDataset(dataset.id,manifest,crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  const parsed=parseGcpInterchange({format:'emlid-all-columns-v1',content:csv.toString('utf8')}),set=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'emlid-all-columns-v1',sourceFileId:'gcp-source-one',sourceFilename:'control.csv',sourceSha256:parsed.sourceSha256,sourceContent:csv.toString('utf8'),crs:parsed.crs,elevationUnits:parsed.elevationUnits,provenance:parsed.provenance,points:parsed.points});
  // Direct repository fixtures must establish the same scan evidence as the
  // public import workflow before creating a processing attempt.
  processing.transaction(()=>require('../server/gcpScanLedger').recordScan(database,{datasetId:dataset.id,fileId:'gcp-source-one',sha256:parsed.sourceSha256,outcome:'imported',setId:set.id,pointCount:set.pointCount}));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'}]},fingerprint:'c'.repeat(64),health:'healthy'});
  const submissionId=crypto.randomUUID(),requestHash=crypto.createHash('sha256').update(submissionId).digest('hex'),preparation={kind:'gcp_review',providerId:provider.id,presetId:null,options:{'pc-ept':true,gltf:true,'3d-tiles':true},capabilityFingerprint:'c'.repeat(64)},validatedInput={providerId:provider.id,presetId:null,options:preparation.options,capabilityFingerprint:preparation.capabilityFingerprint};
  const created=processing.createTaskDraft({subject,submissionId,requestHash,projectId:project.id,datasetId:dataset.id,displayName:'Flight model',preparation});
  const replay=processing.createTaskDraft({subject,submissionId,requestHash,projectId:project.id,datasetId:dataset.id,displayName:'Flight model',preparation});
  assert.equal(created.replayed,false);assert.equal(replay.replayed,true);assert.equal(replay.task.id,created.task.id);assert.deepEqual(created.task.metadata.gcpPreparation,preparation);
  const metadataEdit=processing.updateTaskMetadata(created.task.id,{metadata:{note:'operator note'}});assert.deepEqual(metadataEdit.metadata,{note:'operator note',gcpPreparation:preparation},'ordinary task metadata edits cannot erase the pending GCP plan');
  const ordinaryDraft=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Ordinary draft'});
  assert.throws(()=>processing.updateTaskMetadata(ordinaryDraft.id,{metadata:{gcpPreparation:preparation}}),(error)=>error.code==='reserved_task_metadata','repository metadata writes cannot forge GCP preparation');
  assert.equal(processing.hasGcpSets(dataset.id),true);assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(created.task.id).n,0);
  gcp.createCorrespondence({taskId:created.task.id,pointId:set.points[0].id,imageFileId:'photo-one',pixelX:25,pixelY:75,createdBy:subject});
  assert.throws(()=>processing.createPreparedGcpAttempt(created.task.id,{createdBy:subject}),(error)=>error.code==='gcp_preparation_validation_required');
  assert.throws(()=>processing.createPreparedGcpAttempt(created.task.id,{validatedInput,createdBy:subject}),(error)=>error.code==='gcp_height_source_required');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(created.task.id).n,0,'height choice failure leaves no partial attempt');
  const started=processing.createPreparedGcpAttempt(created.task.id,{gcpHeightSource:'ellipsoidal',createdBy:subject,validatedInput});
  assert.equal(started.replayed,false);assert.equal(started.attempt.status,'pending');assert.equal(processing.getTask(created.task.id).metadata.gcpPreparation,undefined);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=?').get(started.attempt.id).n,1);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM retained_dataset_files WHERE dataset_file_id=?').get('gcp-source-one').n,1,'raw survey CSV is held against deletion');
  const snapshot=processing.getAttemptGcpSnapshot(started.attempt.id);assert.ok(snapshot);assert.match(snapshot.content,/^EPSG:6319\n-88\.1 44\.5 /);assert.equal(snapshot.correspondenceCount,1);
  const replayStart=processing.createPreparedGcpAttempt(created.task.id,{gcpHeightSource:'ellipsoidal',createdBy:subject,validatedInput});assert.equal(replayStart.replayed,true);assert.equal(replayStart.attempt.id,started.attempt.id);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(created.task.id).n,1);
});
