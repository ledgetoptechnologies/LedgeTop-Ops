'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {processOne}=require('../server/processingWorker');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');
const {makeZip}=require('./helpers/zipFixture');
const linux={skip:process.platform!=='linux'&&'real StorageManager mount identity and archive durability require Linux'};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const socketFailure=()=>Object.assign(new TypeError('fetch failed PRIVATE detail'),{cause:Object.assign(new Error('PRIVATE socket'),{code:'ECONNRESET'})});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'result-transfer-retry-')),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,processingProviderTransferTimeoutMs:5000,opsBaseUrl:'http://operations.test'};
  const storage=new StorageManager(config);storage.initialize();
  const project=processing.createProject({displayName:'Synthetic delivery'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',rootKey:'datasets',relativePath:'input'});
  const files=[{relativePath:'photo.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files)));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://provider.test:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Delivery'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
  const submit=processing.claimJob('submit-owner'),init=processing.beginAttemptInitialization(submit.id,'submit-owner',{freshTaskMissing:true});
  assert.equal(processing.acknowledgeAttemptInitialization(submit.id,'submit-owner',init.generation,attempt.providerTaskId),true);
  assert.equal(processing.setSubmissionStateForJob(submit.id,'submit-owner','committed',1),true);
  assert.equal(processing.recordAttemptProviderResult(submit.id,'submit-owner',{uuid:attempt.providerTaskId,status:'completed'}),true);
  processing.transitionAttemptForJob(submit.id,'submit-owner','ingesting');processing.completeJob(submit.id,'submit-owner');processing.enqueueJob(attempt.id,'ingest');
  const ingest=db.prepare("SELECT id FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(attempt.id).id;
  return{root,db,processing,repository,storage,config,task,attempt,ingest,deps:{processing,repository,storage,config,providerCredentials:{resolve:()=>''}},due(){db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id=?").run(ingest);},job(){return db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(ingest);}};
}
function fetching(t,fn){const original=global.fetch;global.fetch=fn;t.after(()=>{global.fetch=original;});}
function assertWaiting(f){assert.equal(f.job().status,'pending');assert.equal(f.job().error_code,'provider_result_transfer_unavailable');assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');assert.doesNotMatch(f.job().error_message,/PRIVATE/);}
function archive(){return makeZip([
  {path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},
  {path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib materials/model.mtl\nv 0 0 0\n'},
  {path:'odm_texturing/materials/model.mtl',data:'newmtl surface\nmap_Kd ../textures/model.jpg\n'},
  {path:'odm_texturing/textures/model.jpg',data:'texture'},
  {path:'entwine_pointcloud/ept.json',data:'{}'},
  {path:'3d_tiles/model/tileset.json',data:'{}'},
]);}

test('six result preparation transport failures preserve one durable ingest job and upstream identity',linux,async t=>{
  const f=fixture(t),requests=[];fetching(t,async url=>{requests.push(new URL(url).pathname);throw socketFailure();});
  for(let i=0;i<6;i++){f.due();await processOne(f.deps,'delivery-worker');assertWaiting(f);const delay=Date.parse(f.job().available_at)-Date.now();assert.ok(delay>0&&delay<=300000);}
  assert.equal(f.job().attempt_count,6);assert.equal(f.processing.getAttempt(f.attempt.id).providerTaskId,f.attempt.providerTaskId);
  assert.deepEqual(new Set(requests),new Set([`/task/${f.attempt.providerTaskId}/download/all.zip`]));
  assert.equal(f.db.prepare("SELECT count(*) n FROM processing_attempts WHERE task_id=?").get(f.task.id).n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(f.attempt.id).n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_outputs').get().n,0);
});

test('after six preparation failures the same job captures a verified archive and advances normally',linux,async t=>{
  const f=fixture(t);let failures=6;fetching(t,async()=>{if(failures-->0)return new Response('archive still preparing',{status:503});return new Response(archive(),{headers:{'content-type':'application/zip'}});});
  for(let i=0;i<6;i++){f.due();await processOne(f.deps,'delivery-worker');assertWaiting(f);}
  f.due();await processOne(f.deps,'delivery-worker');assert.equal(f.job().status,'complete');assert.equal(f.job().attempt_count,7);
  const attempt=f.processing.getAttempt(f.attempt.id);assert.equal(attempt.providerTaskId,f.attempt.providerTaskId);assert.equal(attempt.status,'derivatives');
  assert.ok(f.processing.getAttemptTransferProvenance(attempt.id).archive.archiveSha256);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_outputs WHERE attempt_id=?').get(attempt.id).n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id).n,1);
});

test('transient response stream reset is retried and its private partial spool is removed',linux,async t=>{
  const f=fixture(t);f.db.prepare('UPDATE processing_jobs SET attempt_count=8 WHERE id=?').run(f.ingest);
  fetching(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(archive().subarray(0,32));},pull(c){c.error(socketFailure());}}),{headers:{'content-type':'application/zip'}}));
  await processOne(f.deps,'stream-worker');assertWaiting(f);
  const parent=path.join(f.config.modelsMount,f.task.id,`${f.attempt.id}.v2`);
  assert.deepEqual(fs.readdirSync(parent),[]);assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id).archive,null);
});

test('403, 404, generic TypeError, TLS errors and malformed archives do not become unlimited delivery retries',linux,async t=>{
  for(const mode of ['403','404','type','tls','zip']){
    const f=fixture(t);f.db.prepare('UPDATE processing_jobs SET attempt_count=5 WHERE id=?').run(f.ingest);
    const prior=global.fetch;
    try{
      global.fetch=async()=>{if(mode==='type')throw new TypeError('unexpected implementation error');if(mode==='tls')throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('trust'),{code:'CERT_HAS_EXPIRED'})});if(mode==='zip')return new Response('invalid zip');return new Response('denied',{status:Number(mode)});};
      await processOne(f.deps,'negative-worker');assert.equal(f.job().status,'failed',mode);assert.equal(f.processing.getAttempt(f.attempt.id).status,'failed',mode);assert.notEqual(f.job().error_code,'provider_result_transfer_unavailable',mode);
    }finally{global.fetch=prior;}
  }
});

test('permanent source identity mismatch is not reclassified as result transport',linux,async t=>{
  const f=fixture(t);f.db.prepare('UPDATE processing_jobs SET attempt_count=5 WHERE id=?').run(f.ingest);
  f.processing.getAttemptTransferProvenance=()=>({archive:{layoutVersion:3}});
  fetching(t,async()=>{assert.fail('identity failure must precede provider download');});
  await processOne(f.deps,'identity-worker');assert.equal(f.job().status,'failed');assert.equal(f.job().error_code,'invalid_storage_location');
});

test('HTTP preparation failures and recognized socket/timeout causes retry only on the download endpoint',async()=>{
  for(const status of [408,429,500,502,503,504]){
    const p=new NodeOdmProvider({endpoint:'http://provider.test',fetchImpl:async()=>new Response('wait',{status})});
    await assert.rejects(p.downloadAll('existing-task'),{code:'provider_result_transfer_unavailable'});
    await assert.rejects(p.commit('existing-task'),{code:'provider_request_failed'});
  }
  for(const code of ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']){
    const p=new NodeOdmProvider({endpoint:'http://provider.test',fetchImpl:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code}});}});
    await assert.rejects(p.downloadAll('existing-task'),{code:'provider_result_transfer_unavailable'});
  }
});

test('caller cancellation and lease errors retain their identity instead of becoming delivery waits',async()=>{
  for(const error of [Object.assign(new Error('lease lost'),{code:'lease_lost'}),Object.assign(new Error('cancelled'),{name:'AbortError'}),Object.assign(new Error('cancelled'),{code:'ABORT_ERR'})]){
    const p=new NodeOdmProvider({endpoint:'http://provider.test',fetchImpl:async()=>{throw error;}});await assert.rejects(p.downloadAll('existing-task'),e=>e===error);
  }
  const controller=new AbortController();controller.abort();const error=socketFailure(),p=new NodeOdmProvider({endpoint:'http://provider.test',fetchImpl:async()=>{throw error;}});
  await assert.rejects(p.downloadAll('existing-task',{signal:controller.signal}),e=>e===error);
});


test('download wait cannot requeue a cancelled task or overwrite a replacement lease',linux,async t=>{
  for(const mode of ['cancel','replacement']){
    const f=fixture(t);f.db.prepare('UPDATE processing_jobs SET attempt_count=8 WHERE id=?').run(f.ingest);
    const original=global.fetch;
    try{
      global.fetch=async()=>{
        if(mode==='cancel')f.processing.cancelAttempt(f.attempt.id);
        else f.db.prepare("UPDATE processing_jobs SET lease_owner='replacement',lease_expires_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),f.ingest);
        throw socketFailure();
      };
      await processOne(f.deps,'old-worker');
      assert.equal(f.job().status,mode==='cancel'?'cancelled':'leased');
      assert.equal(f.processing.getAttempt(f.attempt.id).status,mode==='cancel'?'cancelled':'ingesting');
      if(mode==='replacement')assert.equal(f.job().lease_owner,'replacement');
    }finally{global.fetch=original;}
  }
});

test('the result transfer timer is retryable while an explicit caller abort is not',async()=>{
  const p=new NodeOdmProvider({endpoint:'http://provider.test',transferTimeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>{
    const keepAlive=setTimeout(()=>reject(Error('timer did not fire')),1000);
    signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(signal.reason);},{once:true});
  })});
  await assert.rejects(p.downloadAll('existing-task'),{code:'provider_result_transfer_unavailable'});
  const bodyProvider=new NodeOdmProvider({endpoint:'http://provider.test',transferTimeoutMs:5,fetchImpl:async(_url,{signal})=>new Response(new ReadableStream({start(controller){
    signal.addEventListener('abort',()=>controller.error(Object.assign(new Error('body timed out'),{name:'AbortError'})),{once:true});
  }}))});
  const keepAlive=setTimeout(()=>{},1000);
  try{const response=await bodyProvider.downloadAll('existing-task');await assert.rejects(response.arrayBuffer(),{code:'provider_result_transfer_unavailable'});}finally{clearTimeout(keepAlive);}
});
