'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository'),{ViewerRepository}=require('../server/repository');
const {processOne}=require('../server/processingWorker'),{ProviderCredentials}=require('../server/providerCredentials');

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 processing.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
 db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(attempt.id);
 db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('poll',?,'reconcile','pending','2000','2000','2000')").run(attempt.id);
 return{db,processing,repository,attempt};
}

test('transient poll failures must not mark a still-running provider task failed',async t=>{
 const f=fixture(t),deps={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw Object.assign(new Error('temporary provider outage'),{code:'provider_request_failed'});}})};
 for(let i=0;i<5;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne(deps,'poll-worker');}
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running','transport errors do not establish upstream failure');
 assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'pending','poll remains eligible for recovery');
 f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({uuid:f.processing.getAttempt(f.attempt.id).providerTaskId,status:'completed',statusCode:40,progress:1}),output:async()=>({lines:[],nextLine:0})})},'recovered-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');
 assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest' AND status='pending'").get(f.attempt.id).n,1);
});

test('unknown upstream status must not become a storage constraint error',async t=>{
 const f=fixture(t),deps={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'unknown',progress:0}),output:async()=>({lines:[],nextLine:0})})};
 await processOne(deps,'unknown-worker');
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_status_unknown','unknown provider status should be handled explicitly rather than failing SQL CHECK');
});

test('interrupted status read after repeated retries never terminal-fails the attempt',async t=>{
 for(const error of [Object.assign(new Error('aborted'),{name:'AbortError'}),Object.assign(new Error('lease changed'),{code:'lease_lost'})]){
  const f=fixture(t);f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
  await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw error;}})},'interrupted-worker');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,'processing_interrupted');
 }
});

test('persistent provider not found or unauthorized stays pending with actionable code',async t=>{
 for(const [error,code] of [[Object.assign(new Error('not found'),{code:'provider_task_not_found'}),'provider_status_not_found'],[Object.assign(new Error('secret denied'),{code:'provider_request_failed',status:401}),'provider_status_auth_failed']]){
  const f=fixture(t);f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
  await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw error;}})},'diagnostic-worker');
  const job=f.db.prepare("SELECT status,error_code,error_message FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,code);assert.doesNotMatch(job.error_message,/secret/);
 }
});

test('actual unavailable credential resolver stays pending and recovers when restored',async t=>{
 const f=fixture(t),attempt=f.processing.getAttempt(f.attempt.id),credentials=new ProviderCredentials({processing:f.processing}),originalFetch=global.fetch;
 try{
  for(let i=0;i<6;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne({processing:f.processing,config:{},providerCredentials:credentials},'credential-worker');}
  let job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_adapter_unavailable');assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  credentials.legacyTokens[attempt.providerId]='synthetic-token';
  global.fetch=async url=>{const pathname=new URL(url).pathname;const body=pathname.endsWith('/info')?{uuid:attempt.providerTaskId,status:{code:40},progress:100}:[];return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})};
  f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne({processing:f.processing,config:{},providerCredentials:credentials},'recovered-worker');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest' AND status='pending'").get(f.attempt.id).n,1);
 }finally{global.fetch=originalFetch;}
});

test('repeated output persistence failures preserve cursor and do not falsely fail upstream work',async t=>{
 for(const mode of ['log','cursor','warning']){
  const f=fixture(t),append=f.processing.appendLog.bind(f.processing),setCursor=f.processing.setOutputCursor.bind(f.processing);
  f.processing.appendLog=(id,level,message)=>{if((mode==='log'&&level==='provider')||(mode==='warning'&&level==='warn'))throw new Error('secret-local-storage-error');return append(id,level,message)};
  if(mode==='cursor')f.processing.setOutputCursor=()=>{throw new Error('secret-local-storage-error')};
  const factory=()=>({status:async()=>({status:'running',progress:.5}),output:async()=>{if(mode==='warning')throw Error('unavailable');return{lines:['provider record'],nextLine:1}}});
  for(let i=0;i<6;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne({processing:f.processing,config:{},adapterFactory:factory},'storage-worker');}
  const job=f.db.prepare("SELECT status,error_code,error_message FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_observation_persistence_unavailable');assert.doesNotMatch(job.error_message,/secret/);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,0);
  f.processing.appendLog=append;f.processing.setOutputCursor=setCursor;f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne({processing:f.processing,config:{},adapterFactory:factory},'recovered-storage-worker');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,mode==='warning'?0:1);
 }
});

test('error-log outage leaves lease for expiry and later status recovery without terminal failure',async t=>{
 const f=fixture(t),append=f.processing.appendLog.bind(f.processing),attempt=f.processing.getAttempt(f.attempt.id);
 f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
 f.processing.appendLog=()=>{throw new Error('synthetic database logging outage')};
 await assert.rejects(processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw new Error('provider unavailable')}})},'first-worker'),/synthetic database logging outage/);
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
 f.processing.appendLog=append;f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();
 await processOne({processing:new ProcessingRepository(f.db),config:{},adapterFactory:()=>({status:async()=>({uuid:attempt.providerTaskId,status:'completed',statusCode:40,progress:1}),output:async()=>({lines:[],nextLine:0})})},'replacement-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest' AND status='pending'").get(f.attempt.id).n,1);
});
