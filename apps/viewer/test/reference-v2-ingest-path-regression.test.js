'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {processIngest}=require('../server/processingWorker');
const {makeZip}=require('./helpers/zipFixture');

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Real repositories, archive extraction and fixture files; only the already
// accepted coordinator outbox is synthetic. No network or derivative worker.
test('reference ingestion registers the reference root and output asset paths',
  {skip:process.platform!=='linux'&&'archive descriptor extraction requires Linux /proc/self/fd'},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reference-ingest-path-'));
    let database;
    t.after(()=>{try{database?.close();}finally{fs.rmSync(root,{recursive:true,force:true});}});
    const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,processingProviderTransferTimeoutMs:1000,opsBaseUrl:'https://ops.example'};
    for(const dir of [config.datasetsMount,config.modelsMount,config.cacheMount,config.trashMount])fs.mkdirSync(dir,{recursive:true});
    database=openDatabase(path.join(root,'viewer.sqlite'));
    const processing=new ProcessingRepository(database),repository=new ViewerRepository(database),storage=new StorageManager(config);storage.initialize();
    const project=processing.createProject({displayName:'Reference path fixture'});
    const dataset=processing.createDataset({projectId:project.id,displayName:'Photos',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
    processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Reference path'});
    const provider=processing.upsertProvider({type:'nodeodm',displayName:'Reference fixture',endpoint:'https://processing.example',enabled:true});
    const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'ops:test'}),owner='reference-path-test',submit=processing.claimJob(owner);
    assert.ok(submit);assert.ok(processing.transitionAttemptForJob(submit.id,owner,'ingesting'));
    processing.completeJob(submit.id,owner);processing.enqueueJob(attempt.id,'ingest');const job=processing.claimJob(owner);assert.equal(job.job_type,'ingest');
    config.referenceSourceIntake={enabled:true,providerId:provider.id,origin:provider.endpoint};
    const archiveEntries=[
      {path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},
      {path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib model.mtl\nv 0 0 0\n'},
      {path:'odm_texturing/model.mtl',data:'newmtl surface\nmap_Kd texture.jpg\n'},
      {path:'odm_texturing/texture.jpg',data:'texture'},
      {path:'entwine_pointcloud/ept.json',data:'{}'},
      {path:'3d_tiles/model/tileset.json',data:'{}'},
    ];
    const archive=makeZip(archiveEntries);
    const expectedRoot=`${task.id}/${attempt.id}/reference-v2-results`,accepted=path.join(config.modelsMount,...expectedRoot.split('/'),'accepted_objects');
    fs.mkdirSync(accepted,{recursive:true});fs.writeFileSync(path.join(accepted,'odm-archive.bin'),archive);
    const sourceIntake={outbox:{getIntent:id=>{assert.equal(id,attempt.id);return {copyAckCanonical:'{}',remoteBinding:{},resultManifestCanonical:JSON.stringify({objects:[{id:'odm-archive',role:'odm_archive',byteSize:archive.length,sha256:sha(archive)}]})};}}};
    const deps={processing,repository,storage,config,sourceIntake,providerCredentials:{resolve:()=>assert.fail('reference ingestion must not contact legacy provider')},signal:new AbortController().signal};
    const acceptedPath=path.join(accepted,'odm-archive.bin'),originalRead=fs.createReadStream;
    const altered=makeZip(archiveEntries.map((entry,index)=>index===0?{...entry,data:'bad'}:entry));
    let substituted=false;
    try {
      fs.createReadStream=function(file,...args){if(String(file)===acceptedPath&&!substituted){substituted=true;fs.writeFileSync(acceptedPath,altered);}return originalRead.call(this,file,...args);};
      await assert.rejects(processIngest(job,deps),{code:'source_intake_result_object_conflict'});
      assert.equal(substituted,true);
      assert.equal(fs.existsSync(path.join(config.modelsMount,...expectedRoot.split('/'),'output')),false);
      assert.equal(processing.getAttemptTransferProvenance(attempt.id)?.archive||null,null);
    } finally { fs.createReadStream=originalRead;fs.writeFileSync(acceptedPath,archive); }
    const record=processing.recordAttemptArchiveReceipt.bind(processing);
    processing.recordAttemptArchiveReceipt=(jobId,claim,receipt,options)=>record(jobId,claim,receipt,{...options,promote:()=>{options.promote();throw Object.assign(new Error('simulated interruption after rename'),{code:'simulated_crash'});}});
    await assert.rejects(processIngest(job,deps),{code:'simulated_crash'});
    assert.ok(fs.existsSync(path.join(config.modelsMount,...expectedRoot.split('/'),'output')));
    assert.equal(processing.getAttemptTransferProvenance(attempt.id)?.archive||null,null);
    processing.recordAttemptArchiveReceipt=record;
    await processIngest(job,deps);
    const output=database.prepare('SELECT * FROM model_outputs WHERE attempt_id=?').get(attempt.id);assert.ok(output);
    assert.equal(output.root_key,'models');assert.equal(output.relative_path,expectedRoot);
    const assets=database.prepare('SELECT kind,relative_path FROM model_assets WHERE version_id=?').all(output.id);assert.ok(assets.length>0);
    for(const asset of assets)assert.ok(asset.relative_path.startsWith(`${expectedRoot}/output/`),`${asset.kind}: ${asset.relative_path}`);
    assert.equal(output.byte_size,storage.scanAbsolute(path.join(config.modelsMount,...expectedRoot.split('/'))).byteSize);
    assert.deepEqual(fs.readFileSync(path.join(accepted,'odm-archive.bin')),archive);
    const receipt=processing.getAttemptTransferProvenance(attempt.id).archive;assert.equal(receipt.archiveSha256,sha(archive));assert.equal(receipt.archiveByteSize,archive.length);
    const getProvenance=processing.getAttemptTransferProvenance.bind(processing);
    try {
      processing.getAttemptTransferProvenance=id=>({...getProvenance(id),archive:{...receipt,archiveSha256:'0'.repeat(64)}});
      await assert.rejects(processIngest(job,deps),{code:'source_intake_result_object_conflict'});
      assert.deepEqual(fs.readFileSync(acceptedPath),archive);
      assert.ok(fs.existsSync(path.join(config.modelsMount,...expectedRoot.split('/'),'output')));
    } finally { processing.getAttemptTransferProvenance=getProvenance; }
    const derivative=database.prepare("SELECT id,status FROM derivative_jobs WHERE attempt_id=? AND derivative_type='mesh_tiles'").get(attempt.id);assert.equal(derivative.status,'pending');
    for(const file of processing.derivativeInputSnapshot(derivative.id).files)assert.ok(file.relativePath.startsWith(`${expectedRoot}/output/`));
  });
