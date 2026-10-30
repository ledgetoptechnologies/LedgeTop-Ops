'use strict';
// Opt-in, disposable single real photo and a mock adapter. This does not run an engine.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository'),{StorageManager}=require('../server/storageManager'),{processSubmit}=require('../server/processingWorker');
const input=process.env.VIEWER_REAL_PHOTO_FIXTURE;
test('real photo remains intact through Viewer submission to a mock provider',{skip:process.platform!=='linux'||!input},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-photo-fixture-')),db=openDatabase(path.join(root,'db.sqlite'));
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const config=Object.fromEntries(['datasets','models','cache','trash'].map(k=>{const dir=path.join(root,k);fs.mkdirSync(dir);return [`${k}Mount`,dir]}));Object.assign(config,{storageReserveBytes:0,storageReservePercent:0});
 const storage=new StorageManager(config);storage.initialize();const processing=new ProcessingRepository(db);
 const sourceHash=crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');const dir=path.join(config.datasetsMount,'source');fs.mkdirSync(dir);const photo=path.join(dir,'photo.jpg');fs.copyFileSync(input,photo);const byteSize=fs.statSync(photo).size;
 const project=processing.createProject({displayName:'Photo fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Photo fixture',storageMode:'managed',rootKey:'datasets',relativePath:'source'});processing.finalizeDataset(dataset.id,[{id:'photo-fixture',relativePath:'photo.jpg',byteSize,sha256:sourceHash,contentType:'image/jpeg'}],sourceHash);
 const provider=processing.upsertProvider({type:'nodeodm',displayName:'Mock provider',endpoint:'https://mock.invalid',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Fixture'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'fixture'}),job=processing.claimJob('fixture');
 const calls=[];const adapter={async status(){throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},async initialize(input){calls.push('initialize');return {uuid:input.uuid}},async upload(uuid,files){calls.push('upload');assert.equal(uuid,attempt.providerTaskId);assert.equal(files.length,1);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(files[0].absolutePath)).digest('hex'),sourceHash)},async commit(uuid){calls.push('commit');assert.equal(uuid,attempt.providerTaskId)}};
 await processSubmit(job,{processing,storage,config,providerCredentials:{resolve:()=>''},adapterFactory:()=>adapter,signal:new AbortController().signal});
 const {verifyPilotCompletion}=require('./helpers/pilot-completion.cjs');assert.equal(verifyPilotCompletion({processing,job,identity:{attemptId:attempt.id,taskId:task.id,providerId:provider.id,providerTaskId:attempt.providerTaskId}}),true);
 assert.deepEqual(calls,['initialize','upload','commit']);assert.equal(processing.getAttempt(attempt.id).status,'queued_upstream');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),sourceHash);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(photo)).digest('hex'),sourceHash);assert.equal(db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);
});
