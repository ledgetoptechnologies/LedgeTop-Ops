'use strict';
// Disposable integration: synthetic photo and provider, retained read-only archive.
// It does not exercise the coordinator, supervisor, or release image.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{StorageManager}=require('../server/storageManager'),{processSubmit,processReconcile,processIngest}=require('../server/processingWorker');
const {runWithPilotLease}=require('./helpers/pilot-lease.cjs'),{verifyPilotCompletion}=require('./helpers/pilot-completion.cjs');
const archive=process.env.VIEWER_FIXTURE_ODM_ARCHIVE;
test('one attempt submits, reconciles and ingests with independent archive evidence',{skip:process.platform!=='linux'||!archive},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-chain-')),db=openDatabase(path.join(root,'viewer.sqlite'));
 const config=Object.fromEntries(['datasets','models','cache','trash'].map(k=>{const dir=path.join(root,k);fs.mkdirSync(dir);return [`${k}Mount`,dir]}));Object.assign(config,{storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,processingProviderTransferTimeoutMs:60000,opsBaseUrl:'https://ops.invalid'});
 const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),storage=new StorageManager(config);storage.initialize();
 const photo=Buffer.from('synthetic photo'),photoHash=crypto.createHash('sha256').update(photo).digest('hex'),source=path.join(config.datasetsMount,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'photo.jpg'),photo);
 const archiveHash=await new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),s=fs.createReadStream(archive);s.on('data',x=>h.update(x));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')))}),archiveSize=fs.statSync(archive).size;
 let downloads=0;const server=http.createServer((req,res)=>{downloads++;res.writeHead(200,{'content-type':'application/zip','content-length':archiveSize,'x-ledgetop-archive-sha256':archiveHash});fs.createReadStream(archive).pipe(res)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true})});
 const project=processing.createProject({displayName:'Fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Fixture',storageMode:'managed',rootKey:'datasets',relativePath:'source'});processing.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:photo.length,sha256:photoHash,contentType:'image/jpeg'}],photoHash);
 const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:`http://127.0.0.1:${server.address().port}`,enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Fixture'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'fixture'}),identity={attemptId:attempt.id,taskId:task.id,providerId:provider.id,providerTaskId:attempt.providerTaskId,expectedArchive:{sha256:archiveHash,byteSize:archiveSize}};
 const calls=[],adapter={async status(){if(!calls.includes('commit'))throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});return {uuid:attempt.providerTaskId,status:'completed',statusCode:40,imagesCount:1}},async initialize(input){calls.push('initialize');return {uuid:input.uuid}},async upload(uuid,files){calls.push('upload');assert.equal(uuid,attempt.providerTaskId);assert.equal(files.length,1)},async commit(){calls.push('commit')},async output(){return null}};
 const deps={processing,repository,storage,config,providerCredentials:{resolve:()=>''},adapterFactory:()=>adapter};
 const run=async(type,worker)=>{const owner=`fixture-${type}`,job=processing.claimJob(owner,300);assert.equal(job?.attempt_id,attempt.id);assert.equal(job.job_type,type);await runWithPilotLease({processing,job,owner,work:signal=>worker(job,{...deps,signal}),verifyCompletion:()=>verifyPilotCompletion({processing,job,identity})});};
 await run('submit',processSubmit);
 // Accelerate only the disposable test's scheduled poll; no production queue is touched.
 db.prepare("UPDATE processing_jobs SET available_at=? WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").run(new Date(0).toISOString(),attempt.id);
 await run('reconcile',processReconcile);await run('ingest',processIngest);
 assert.deepEqual(calls,['initialize','upload','commit']);assert.equal(downloads,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);assert.equal(processing.getAttempt(attempt.id).status,'derivatives');assert.equal(fs.statSync(archive).size,archiveSize);
});
