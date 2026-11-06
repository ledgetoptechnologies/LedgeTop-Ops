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
const {StorageManager}=require('../server/storageManager');
const {processSubmit}=require('../server/processingWorker');
const {parseGcpInterchange}=require('../server/gcpImport');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-submit-'));
  const directories=Object.fromEntries(['datasets','models','cache','trash'].map((name)=>[name,path.join(root,name)]));
  for(const directory of Object.values(directories))fs.mkdirSync(directory,{recursive:true});
  const database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database),gcp=new GcpRepository(database);
  const storage=new StorageManager({datasetsMount:directories.datasets,modelsMount:directories.models,cacheMount:directories.cache,
    trashMount:directories.trash,storageReserveBytes:0,storageReservePercent:0});
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,directories,database,processing,gcp,storage};
}

test('submit requires an explicit qualified height source and snapshots Emlid ellipsoidal GCP height',async(t)=>{
  const c=fixture(t),project=c.processing.createProject({displayName:'Survey'}),relativePath=crypto.randomUUID();
  const draft=c.processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath});
  const body=Buffer.from('jpeg bytes'),directory=path.join(c.directories.datasets,relativePath);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'photo.jpg'),body);
  const source='Name,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nA,903241.652,549596.746,833.164,Hub,-88.1,44.5,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n';
  const sourceBytes=Buffer.from(source,'utf8');fs.writeFileSync(path.join(directory,'control.csv'),sourceBytes);
  const sha256=crypto.createHash('sha256').update(body).digest('hex'),sourceSha256=crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const manifest=[
    {id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256,contentType:'image/jpeg',processingRole:'image',metadata:{width:100,height:100,gps:{latitude:44.5,longitude:-88.1}}},
    {id:'gcp-source',relativePath:'control.csv',byteSize:sourceBytes.length,sha256:sourceSha256,contentType:'text/csv',processingRole:'gcp_source'},
  ];
  const canonical=manifest.map(({relativePath:itemPath,byteSize,sha256:hash})=>({relativePath:itemPath,byteSize,sha256:hash}));
  c.processing.finalizeDataset(draft.id,manifest,crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  const parsed=parseGcpInterchange({format:'emlid-all-columns-v1',content:source});
  const set=c.gcp.importSet({datasetId:draft.id,displayName:'Control',sourceFormat:'emlid-all-columns-v1',sourceFileId:'gcp-source',sourceFilename:'control.csv',sourceSha256,sourceContent:source,
    crs:parsed.crs,elevationUnits:parsed.elevationUnits,provenance:parsed.provenance,points:parsed.points});
  const task=c.processing.createTask({projectId:project.id,datasetId:draft.id,displayName:'Model'});
  c.gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'photo',pixelX:25,pixelY:75,createdBy:'ops:1'});
  const provider=c.processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const preparation={kind:'gcp_review',providerId:provider.id,presetId:null,options:{},capabilityFingerprint:provider.capabilityFingerprint||null};
  c.database.prepare('UPDATE processing_tasks SET metadata_json=? WHERE id=?').run(JSON.stringify({gcpPreparation:preparation}),task.id);
  const validatedInput={providerId:provider.id,presetId:null,options:{},capabilityFingerprint:preparation.capabilityFingerprint};
  assert.throws(()=>c.processing.createPreparedGcpAttempt(task.id,{validatedInput}),(error)=>error.code==='gcp_height_source_required');
  assert.equal(c.database.prepare('SELECT COUNT(*) count FROM processing_attempts WHERE task_id=?').get(task.id).count,0,'rejected selection leaves no partial attempt');
  const attempt=c.processing.createPreparedGcpAttempt(task.id,{validatedInput,gcpHeightSource:'ellipsoidal'}).attempt,job=c.processing.claimJob('worker-gcp');
  const uploads=[];c.storage.requireProcessingHeadroom=()=>({});
  const adapter={
    async status(){throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});},async initialize(){},
    async upload(_uuid,files){uploads.push(files);},async commit(){},async remove(){},
  };
  await processSubmit(job,{processing:c.processing,storage:c.storage,config:{},signal:new AbortController().signal,adapterFactory:()=>adapter});
  assert.equal(uploads.length,2);
  assert.equal(uploads[0][0].relativePath,'photo.jpg');
  assert.equal(uploads[1][0].relativePath,'gcp_list.txt');
  assert.ok(Buffer.isBuffer(uploads[1][0].buffer));
  const height=(720.437*1200/3937).toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
  assert.equal(uploads[1][0].buffer.toString('utf8'),`EPSG:6319\n-88.1 44.5 ${height} 25 75 photo.jpg\n`);
  const snapshot=JSON.parse(c.database.prepare('SELECT evidence_json FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(attempt.id).evidence_json);
  assert.equal(snapshot.schemaVersion,3);
  assert.equal(snapshot.coordinateContract.horizontalCrs,'EPSG:6318');
  assert.match(snapshot.coordinateContract.verticalSystem,/NAVD88\(GEOID18\)/);
  assert.equal(snapshot.coordinateContract.zSource,'Elevation');
  assert.equal(snapshot.coordinateContract.heightSource,'ellipsoidal');
  assert.equal(snapshot.coordinateContract.outputVerticalSystem,'ellipsoidal height');
  assert.equal(snapshot.coordinateContract.sourceUnits,'ftUS');
  assert.equal(snapshot.coordinateContract.outputZUnit,'m');
  assert.ok(c.processing.getAttemptGcpEvidence(attempt.id), 'retained snapshot evidence revalidates against the selected ellipsoidal height and exact generated ODM CRS header');
  assert.equal(c.processing.getAttemptSubmission(attempt.id).submissionPhase,'committed');
});
