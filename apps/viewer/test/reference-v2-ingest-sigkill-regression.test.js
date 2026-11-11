'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {processIngest}=require('../server/processingWorker');
const {makeZip}=require('./helpers/zipFixture');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('reference ingest SIGKILL after promotion leaves no receipt and reclaims the same verified output',
 {timeout:30000,skip:process.platform!=='linux'&&'requires Linux SIGKILL and descriptor extraction'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reference-sigkill-'));let db,child,childExit;
  t.after(async()=>{
    if(child&&child.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childExit.catch(()=>{});}
    try{db?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,processingProviderTransferTimeoutMs:1000,opsBaseUrl:'https://ops.example'};
  for(const dir of [config.datasetsMount,config.modelsMount,config.cacheMount,config.trashMount])fs.mkdirSync(dir,{recursive:true});
  db=openDatabase(path.join(root,'viewer.sqlite'));const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),storage=new StorageManager(config);storage.initialize();
  const project=processing.createProject({displayName:'Reference crash fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Photos',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Reference crash'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Reference fixture',endpoint:'https://processing.example',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'ops:test'}),submit=processing.claimJob('submit-owner');
  assert.ok(submit);assert.ok(processing.transitionAttemptForJob(submit.id,'submit-owner','ingesting'));processing.completeJob(submit.id,'submit-owner');processing.enqueueJob(attempt.id,'ingest');
  const job=processing.claimJob('killed-owner');assert.equal(job.job_type,'ingest');config.referenceSourceIntake={enabled:true,providerId:provider.id,origin:provider.endpoint};
  const archive=makeZip([{path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},{path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib model.mtl\nv 0 0 0\n'},{path:'odm_texturing/model.mtl',data:'newmtl surface\nmap_Kd texture.jpg\n'},{path:'odm_texturing/texture.jpg',data:'texture'},{path:'entwine_pointcloud/ept.json',data:'{}'},{path:'3d_tiles/model/tileset.json',data:'{}'}]);
  const expectedRoot=`${task.id}/${attempt.id}/reference-v2-results`,accepted=path.join(config.modelsMount,...expectedRoot.split('/'),'accepted_objects'),destination=path.join(config.modelsMount,...expectedRoot.split('/'),'output');
  fs.mkdirSync(accepted,{recursive:true});fs.writeFileSync(path.join(accepted,'odm-archive.bin'),archive);
  const intent={copyAckCanonical:'{}',remoteBinding:{},resultManifestCanonical:JSON.stringify({objects:[{id:'odm-archive',role:'odm_archive',byteSize:archive.length,sha256:sha(archive)}]})};
  child=spawn(process.execPath,[path.join(__dirname,'helpers','reference-ingest-rename-kill-child.cjs'),JSON.stringify({root,config,job,destination,intent})],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',data=>{errors+=data.toString();});
  childExit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},15000);let exit;try{exit=await childExit;}finally{clearTimeout(timer);}
  assert.equal(timedOut,false,'owned child timed out');assert.equal(exit.signal,'SIGKILL',errors);
  assert.ok(fs.existsSync(destination));const before=fs.statSync(destination,{bigint:true});
  assert.equal(fs.readFileSync(path.join(destination,'odm_texturing','odm_textured_model_geo.glb'),'utf8'),'glb');
  const reopened=new DatabaseSync(path.join(root,'viewer.sqlite'),{readOnly:true});
  try{assert.equal(reopened.prepare('SELECT archive_json FROM processing_attempt_transfer_provenance WHERE attempt_id=?').get(attempt.id)?.archive_json??null,null);}finally{reopened.close();}
  db.prepare('UPDATE processing_jobs SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',job.id);
  const retry=processing.claimJob('replacement-owner');assert.equal(retry.id,job.id);
  const sourceIntake={outbox:{getIntent:()=>intent}};
  await processIngest(retry,{processing,repository,storage,config,sourceIntake,providerCredentials:{resolve:()=>assert.fail('unexpected legacy provider')},signal:new AbortController().signal});
  assert.equal(fs.statSync(destination,{bigint:true}).ino,before.ino,'recovery must verify, not replace, the promoted directory');
  assert.deepEqual(fs.readFileSync(path.join(accepted,'odm-archive.bin')),archive);
  assert.equal(processing.getAttemptTransferProvenance(attempt.id).archive.archiveSha256,sha(archive));
  assert.equal(db.prepare('SELECT relative_path FROM model_outputs WHERE attempt_id=?').get(attempt.id).relative_path,expectedRoot);
});
