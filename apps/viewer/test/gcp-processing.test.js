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

test('submit uploads an immutable geographic GCP snapshot and its matching coordinate evidence',async(t)=>{
  const c=fixture(t),project=c.processing.createProject({displayName:'Survey'}),relativePath=crypto.randomUUID();
  const draft=c.processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath});
  const body=Buffer.from('jpeg bytes'),directory=path.join(c.directories.datasets,relativePath);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'photo.jpg'),body);
  const sha256=crypto.createHash('sha256').update(body).digest('hex');
  c.processing.finalizeDataset(draft.id,[{id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256,contentType:'image/jpeg',metadata:{width:100,height:100,gps:{latitude:44.5,longitude:-88.1}}}],sha256);
  const source='point_id,label,latitude,longitude,elevation_m,description\nA,Hub,44.5,-88.1,253.9476,target\n';
  const parsed=parseGcpInterchange({format:'generic-csv-v1',content:source});
  const set=c.gcp.importSet({datasetId:draft.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),sourceContent:source,
    crs:parsed.crs,elevationUnits:parsed.elevationUnits,provenance:parsed.provenance,points:parsed.points});
  const task=c.processing.createTask({projectId:project.id,datasetId:draft.id,displayName:'Model'});
  c.gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'photo',pixelX:25,pixelY:75,createdBy:'ops:1'});
  const provider=c.processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=c.processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),job=c.processing.claimJob('worker-gcp');
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
  assert.equal(uploads[1][0].buffer.toString('utf8'),'EPSG:4326\n-88.1 44.5 253.9476 25 75 photo.jpg\n');
  const snapshot=JSON.parse(c.database.prepare('SELECT evidence_json FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(attempt.id).evidence_json);
  assert.equal(snapshot.schemaVersion,2);
  assert.equal(snapshot.coordinateContract.horizontalCrs,'EPSG:4326');
  assert.equal(snapshot.coordinateContract.zSource,'elevation_m');
  assert.equal(snapshot.coordinateContract.sourceUnits,'m');
  assert.equal(snapshot.coordinateContract.outputZUnit,'m');
  assert.equal(c.processing.getAttemptSubmission(attempt.id).submissionPhase,'committed');
});
