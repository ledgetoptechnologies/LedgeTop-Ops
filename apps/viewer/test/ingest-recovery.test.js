'use strict';
const assert=require('node:assert/strict'),express=require('express'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {StorageManager}=require('../server/storageManager');
const {createProcessingApi}=require('../server/processingApi');
const {ACTION}=require('../server/processingIngestRecovery');

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-recover-')),database=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  const config=Object.fromEntries(['datasets','models','cache','trash'].map(key=>{const p=path.join(root,key);fs.mkdirSync(p);return[`${key}Mount`,p];}));
  Object.assign(config,{storageReserveBytes:0,storageReservePercent:0});
  const storage=new StorageManager(config),project=processing.createProject({displayName:'Synthetic recovery'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Original photos',rootKey:'datasets',relativePath:'source'});
  fs.mkdirSync(path.join(config.datasetsMount,'source'));fs.writeFileSync(path.join(config.datasetsMount,'source','photo.jpg'),'photo');
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:5,sha256:crypto.createHash('sha256').update('photo').digest('hex')}],'a'.repeat(64));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Recover existing result'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{dsm:true},createdBy:'ops:recovery'});
  const submit=processing.claimJob('fixture');
  assert.equal(processing.recordAttemptProviderResult(submit.id,'fixture',{uuid:attempt.providerTaskId,status:'completed',statusCode:40,imagesCount:1}),true);
  processing.completeJob(submit.id,'fixture');processing.transitionAttempt(attempt.id,'ingesting');
  processing.enqueueJob(attempt.id,'ingest');const ingest=processing.claimJob('fixture');
  processing.failJobTerminal(ingest.id,'fixture','processing_failed','Synthetic ZIP64 ingestion failure',{eventId:crypto.randomUUID()});
  const token='recovery-token-000000000000000000000000';
  const session=processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:recovery',permissions:['viewer.processing.write','viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const f={root,database,processing,repository,storage,config,project,dataset,provider,task,attempt,ingest,session,token,calls:[],onStatus:null,statusCode:40,imagesCount:1};
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));
  app.use(createProcessingApi({repository,processing,storage,providerCredentials:{resolve:()=>''},providerFetch:async(url,options)=>{
    f.calls.push({url:String(url),method:options?.method||'GET'});if(f.onStatus)await f.onStatus();
    return new Response(JSON.stringify({uuid:attempt.providerTaskId,status:{code:f.statusCode},imagesCount:f.imagesCount,progress:100}),{status:200,headers:{'content-type':'application/json'}});
  }}));
  app.use((err,_req,res,_next)=>res.status(500).json({error:err.code||err.message}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});
  f.post=async(key='recover-once',body={},bearer=token)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/attempts/${attempt.id}/recover-ingest`,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});
    return{status:response.status,body:await response.json(),replayed:response.headers.get('Idempotency-Replayed')};
  };
  f.pending=()=>database.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND status='pending'").all(attempt.id);
  return f;
}

test('recovery atomically schedules only ingestion on the same attempt, preserving failure history and replay',async t=>{
  const f=await fixture(t),old=f.database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.ingest.id),provenance=f.processing.getAttemptProvenance(f.attempt.id);
  const result=await f.post();assert.equal(result.status,202,JSON.stringify(result.body));
  assert.equal(result.body.attempt.id,f.attempt.id);assert.equal(result.body.attempt.providerTaskId,f.attempt.providerTaskId);assert.deepEqual(result.body.attempt.options,{dsm:true});
  assert.equal(f.pending().length,1);assert.equal(f.pending()[0].job_type,'ingest');
  assert.deepEqual(f.database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.ingest.id),old);
  assert.deepEqual(f.processing.getAttemptProvenance(f.attempt.id),provenance);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM audit_events WHERE action=?').get(ACTION).n,1);
  const replay=await f.post();assert.equal(replay.status,202);assert.equal(replay.replayed,'true');assert.deepEqual(replay.body,result.body);assert.equal(f.calls.length,1);
  assert.match(f.calls[0].url,new RegExp(`/task/${f.attempt.providerTaskId}/info`));assert.equal(f.calls[0].method,'GET');
});

test('competing recovery keys schedule one ingest',async t=>{
  const f=await fixture(t);let release,entered=0;const gate=new Promise(resolve=>{release=resolve;});
  f.onStatus=async()=>{if(++entered===2)release();await gate;};
  const results=await Promise.all([f.post('recovery-a'),f.post('recovery-b')]);assert.deepEqual(results.map(x=>x.status).sort(),[202,409]);assert.equal(f.pending().length,1);
});

for(const [name,change,expected] of [
  ['running upstream',f=>{f.statusCode=20;},409],['photo mismatch',f=>{f.imagesCount=2;},409],
  ['revoked session',f=>f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString()),403],
  ['expired session',f=>f.database.prepare('UPDATE admin_sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z'),403],
  ['removed permission',f=>f.database.prepare("UPDATE admin_sessions SET permissions_json='[]'").run(),403],
  ['cancelled attempt',f=>f.processing.transitionAttempt(f.attempt.id,'cancelled'),409],
  ['archived project',f=>f.database.prepare("UPDATE projects SET status='archived'").run(),409],
  ['recycled source',f=>f.database.prepare("UPDATE datasets SET status='trashed'").run(),409],
  ['changed manifest',f=>f.database.prepare("UPDATE datasets SET manifest_sha256=?").run('b'.repeat(64)),409],
  ['deleted source',f=>fs.unlinkSync(path.join(f.config.datasetsMount,'source','photo.jpg')),409],
  ['changed provider endpoint',f=>f.database.prepare("UPDATE processing_providers SET endpoint='http://127.0.0.1:4000'").run(),409],
  ['changed credentials',f=>f.database.prepare('UPDATE processing_providers SET credential_revision=credential_revision+1').run(),409]
])test(`recovery rejects ${name} during fresh provider validation`,async t=>{
  const f=await fixture(t);f.onStatus=()=>change(f);const result=await f.post();assert.equal(result.status,expected,JSON.stringify(result.body));assert.equal(f.pending().length,0);
});

test('recovery rejects replaced active attempt and disabled provider after observation',async t=>{
  for(const change of [f=>f.database.prepare('UPDATE processing_tasks SET active_attempt_id=NULL').run(),f=>f.database.prepare('UPDATE processing_providers SET enabled=0').run()])await t.test('state changed',async t=>{
    const f=await fixture(t);f.onStatus=()=>change(f);assert.equal((await f.post()).status,409);assert.equal(f.pending().length,0);
  });
});

test('another live Viewer session cannot replay a revoked session receipt',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).status,202);
  f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());
  assert.equal((await f.post()).status,401);
  const other='other-session-token-0000000000000000000';
  f.processing.createAdminSession({tokenHash:auth.hashToken(other),subject:'ops:other',permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal((await f.post('recover-once',{},other)).status,403);assert.equal(f.pending().length,1);assert.equal(f.calls.length,1);
});

test('recovery fails closed for missing provenance, exhausted limits and unreceipted outputs',async t=>{
  for(const kind of ['provenance','limit','output'])await t.test(kind,async t=>{
    const f=await fixture(t);
    if(kind==='provenance')f.database.prepare('DELETE FROM processing_attempt_provenance').run();
    if(kind==='limit')for(let i=0;i<3;i++)f.processing.insertAudit({actorId:'ops:recovery',action:ACTION,entityType:'processing_attempt',entityId:f.attempt.id});
    if(kind==='output')fs.mkdirSync(path.join(f.config.modelsMount,f.task.id,f.attempt.id),{recursive:true});
    const result=await f.post();assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(f.pending().length,0);assert.equal(f.calls.length,0);
  });
});

test('authorization and request contract precede provider access',async t=>{
  const f=await fixture(t);assert.equal((await f.post(null)).status,428);assert.equal((await f.post('bad')).status,400);
  assert.equal((await f.post('invalid-body',{submit:true})).status,400);assert.equal((await f.post('foreign-auth',{},'foreign-token-000000000000000000000')).status,401);
  assert.equal(f.calls.length,0);assert.equal(f.pending().length,0);
});

test('terminal/status/job guards never submit work or schedule duplicate ingestion',async t=>{
  for(const kind of ['cancelled','published','ready_for_review','running','pending-job','missing-dataset','wrong-failed-job'])await t.test(kind,async t=>{
    const f=await fixture(t);
    if(kind==='pending-job')f.processing.enqueueJob(f.attempt.id,'ingest');
    else if(kind==='missing-dataset')f.database.prepare("UPDATE processing_attempts SET dataset_id=NULL").run();
    else if(kind==='wrong-failed-job')f.database.prepare("UPDATE processing_jobs SET job_type='submit' WHERE id=?").run(f.ingest.id);
    else f.database.prepare('UPDATE processing_attempts SET status=?').run(kind);
    const pendingBefore=f.pending().length,result=await f.post();assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(f.pending().length,pendingBefore);assert.equal(f.calls.length,0);
  });
});

test('scheduling failure rolls back audit, attempt and new job together',async t=>{
  const f=await fixture(t),before=f.processing.getAttempt(f.attempt.id);
  f.database.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON processing_jobs WHEN NEW.job_type='ingest' BEGIN SELECT RAISE(ABORT,'synthetic scheduling failure'); END");
  const result=await f.post();assert.equal(result.status,500);assert.deepEqual(f.processing.getAttempt(f.attempt.id),before);assert.equal(f.pending().length,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM audit_events WHERE action=?').get(ACTION).n,0);
});

test('diagnostics expose advisory recovery eligibility without secrets or provider requests',async t=>{
  const f=await fixture(t),{ingestRecoveryCandidate}=require('../server/processingIngestRecovery');
  assert.deepEqual(ingestRecoveryCandidate(f.processing,f.attempt.id,f.storage),{kind:'ingest',available:true,remainingRequests:3});
  f.database.prepare('DELETE FROM processing_attempt_provenance').run();
  assert.deepEqual(ingestRecoveryCandidate(f.processing,f.attempt.id,f.storage),{kind:'ingest',available:false,remainingRequests:3});
  assert.equal(f.calls.length,0);
});

const linux={skip:process.platform!=='linux'&&'descriptor integrity and archive extraction require Linux /proc/self/fd'};
test('recovery rejects a destination appearing during source verification after admission',linux,async t=>{
  const f=await fixture(t),{processIngest}=require('../server/processingWorker');
  assert.equal((await f.post()).status,202);
  const job=f.processing.claimJob('recovery-worker'),destination=path.join(f.config.modelsMount,f.task.id,f.attempt.id);
  const original=f.processing.provenanceJob.bind(f.processing);let appeared=false;
  f.processing.provenanceJob=(...args)=>{if(!appeared){appeared=true;fs.mkdirSync(destination,{recursive:true});fs.writeFileSync(path.join(destination,'unreceipted.bin'),'untrusted');}return original(...args);};
  await assert.rejects(processIngest(job,{...f,providerCredentials:{resolve:()=>{throw new Error('must not reach provider');}},signal:new AbortController().signal}),{code:'ingest_recovery_state_changed'});
  assert.equal(appeared,true);assert.equal(f.calls.length,1);
  assert.equal(fs.readFileSync(path.join(destination,'unreceipted.bin'),'utf8'),'untrusted');
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id)?.archive||null,null);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM derivative_jobs').get().n,0);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='submit'").get().n,1);
});

test('recovery retry rejects a genuinely promoted archive without its database receipt',linux,async t=>{
  const {Readable}=require('node:stream'),{captureProcessingArchive}=require('../server/processingArchiveEvidence'),{makeZip64EndRecord}=require('./helpers/zipFixture'),{processIngest}=require('../server/processingWorker');
  const f=await fixture(t);assert.equal((await f.post()).status,202);
  const job=f.processing.claimJob('recovery-worker'),destination=path.join(f.config.modelsMount,f.task.id,f.attempt.id);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const archive=makeZip64EndRecord([
    {path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},
    {path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib model.mtl\nv 0 0 0\n'},
    {path:'odm_texturing/model.mtl',data:'newmtl surface\nmap_Kd texture.jpg\n'},
    {path:'odm_texturing/texture.jpg',data:'texture'},
    {path:'entwine_pointcloud/ept.json',data:'{}'},
    {path:'3d_tiles/model/tileset.json',data:'{}'}
  ]);
  const receipt=await captureProcessingArchive(Readable.from([archive]),destination);
  assert.equal(receipt.archiveFiles.length,6);assert.equal(fs.existsSync(destination),true);
  // Model the crash boundary: filesystem promotion completed, but the caller
  // never committed recordAttemptArchiveReceipt for this leased recovery job.
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id)?.archive||null,null);
  await assert.rejects(processIngest(job,{...f,providerCredentials:{resolve:()=>{throw new Error('must not reach provider');}},signal:new AbortController().signal}),{code:'ingest_recovery_state_changed'});
  assert.equal(fs.readFileSync(path.join(destination,'odm_texturing','odm_textured_model_geo.glb'),'utf8'),'glb');
  assert.equal(f.calls.length,1);assert.equal(f.database.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM derivative_jobs').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='submit'").get().n,1);
});

test('recovery worker rejects same-size source replacement before any provider download',linux,async t=>{
  const f=await fixture(t),{processIngest}=require('../server/processingWorker');assert.equal((await f.post()).status,202);
  fs.writeFileSync(path.join(f.config.datasetsMount,'source','photo.jpg'),'other');
  const job=f.processing.claimJob('recovery-worker');assert.equal(job.job_type,'ingest');
  await assert.rejects(processIngest(job,{...f,providerCredentials:{resolve:()=>{throw new Error('must not reach provider');}},signal:new AbortController().signal}),{code:'ingest_recovery_source_changed'});
  assert.equal(f.calls.length,1);assert.equal(f.database.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='submit'").get().n,1);
  assert.equal(f.processing.getAttempt(f.attempt.id).providerTaskId,f.attempt.providerTaskId);
});

test('supported recovery consumes existing provider ZIP64 result on the same attempt without submission',linux,async t=>{
  const http=require('node:http'),{processIngest}=require('../server/processingWorker'),{makeZip64EndRecord}=require('./helpers/zipFixture');
  const archive=makeZip64EndRecord([
    {path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},
    {path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib model.mtl\nv 0 0 0\n'},
    {path:'odm_texturing/model.mtl',data:'newmtl surface\nmap_Kd texture.jpg\n'},
    {path:'odm_texturing/texture.jpg',data:'texture'},
    {path:'entwine_pointcloud/ept.json',data:'{}'},
    {path:'3d_tiles/model/tileset.json',data:'{}'},
    {path:'padding.bin',data:Buffer.alloc(96*1024,0x30)}
  ]),requests=[];
  const upstream=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url});res.writeHead(200,{'content-type':'application/zip','content-length':archive.length});res.end(archive);});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const f=await fixture(t);f.database.prepare('UPDATE processing_providers SET endpoint=?').run(`http://127.0.0.1:${upstream.address().port}`);
  Object.assign(f.config,{storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,processingProviderTransferTimeoutMs:5000,opsBaseUrl:'http://operations.test'});
  const originalFailed=f.database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.ingest.id);
  const recovered=await f.post();assert.equal(recovered.status,202,JSON.stringify(recovered.body));
  const job=f.processing.claimJob('recovery-worker');assert.equal(job.id,recovered.body.jobId);
  await processIngest(job,{...f,providerCredentials:{resolve:()=>''},signal:new AbortController().signal});
  const result=f.processing.getAttempt(f.attempt.id);
  assert.equal(result.id,f.attempt.id);assert.equal(result.providerTaskId,f.attempt.providerTaskId);assert.equal(result.status,'derivatives');
  assert.deepEqual(requests,[{method:'GET',path:`/task/${f.attempt.providerTaskId}/download/all.zip`}]);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n,1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='submit'").get().n,1);
  assert.deepEqual(f.database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.ingest.id),originalFailed);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id).archive.archiveByteSize,archive.length);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?").get(f.attempt.id).n>0,true);
});
