'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository'),{ViewerRepository}=require('../server/repository');
const {processOne}=require('../server/processingWorker'),{ProviderCredentials}=require('../server/providerCredentials');
const {processingJobCounts}=require('../server/processingOverview');

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 processing.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
 db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(attempt.id);
 db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('poll',?,'reconcile','pending','2000','2000','2000')").run(attempt.id);
 return{db,processing,repository,attempt,task,project};
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


test('provider observation warnings remain distinct from failures, survive interruptions, and clear on recovery',async t=>{
 const f=fixture(t),counts=()=>processingJobCounts(f.db),outage={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw Object.assign(new Error('private detail'),{status:401});}})};
 await processOne(outage,'warning-worker');
 assert.equal(counts().observationWarnings,1);assert.equal(counts().failed,0);
 f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});}})},'interrupted-warning-worker');
 assert.equal(counts().observationWarnings,1);
 assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE id='poll'").get().error_code,'provider_status_auth_failed');
 f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'running',progress:.5}),output:async()=>({lines:[],nextLine:0})})},'recovered-warning-worker');
 assert.equal(counts().observationWarnings,0);assert.equal(counts().failed,0);assert.equal(counts().running,1);
});

test('observation warning counts only current active, nonrecycled work and allowlisted codes',async t=>{
 const f=fixture(t),counts=()=>processingJobCounts(f.db);
 for(const code of ['provider_observation_unavailable','provider_status_unknown','provider_status_not_found','provider_status_auth_failed','provider_adapter_unavailable','provider_observation_persistence_unavailable']){
  f.db.prepare("UPDATE processing_jobs SET error_code=? WHERE id='poll'").run(code);assert.equal(counts().observationWarnings,1,code);
 }
 f.db.prepare("UPDATE processing_jobs SET error_code='unrelated_internal_error' WHERE id='poll'").run();assert.equal(counts().observationWarnings,0);
 f.db.prepare("UPDATE processing_jobs SET error_code='provider_status_not_found' WHERE id='poll'").run();
 f.db.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(f.task.id);assert.equal(counts().observationWarnings,0);
 f.db.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(f.task.id);
 f.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.project.id);assert.equal(counts().observationWarnings,0);
 f.db.prepare("UPDATE projects SET status='active' WHERE id=?").run(f.project.id);assert.equal(counts().observationWarnings,1);
 f.db.prepare("UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?").run(f.task.id);assert.equal(counts().observationWarnings,0);
});


test('database failure while scheduling ingestion rolls back and retries without a false failure',async t=>{
 const f=fixture(t),status={uuid:f.processing.getAttempt(f.attempt.id).providerTaskId,status:'completed',statusCode:40,progress:1},deps={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>status,output:async()=>({lines:[],nextLine:0})})};
 f.db.exec("CREATE TRIGGER fail_ingest BEFORE INSERT ON processing_jobs WHEN NEW.job_type='ingest' BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END");
 f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
 await processOne(deps,'db-failure-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.processing.getAttemptProvenance(f.attempt.id)?.providerResult,null);
 assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE id='poll'").get().error_code,'provider_observation_persistence_unavailable');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='ingest'").get().n,0);
 f.db.exec('DROP TRIGGER fail_ingest');f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne(deps,'db-recovered-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='ingest' AND status='pending'").get().n,1);
});

test('terminal observation write failures retry instead of exhausting the retry budget',async t=>{
 const f=fixture(t),deps={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'failed',progress:0}),output:async()=>({lines:[],nextLine:0})})};
 f.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON processing_attempts WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END");
 f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();await processOne(deps,'terminal-db-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE id='poll'").get().error_code,'provider_observation_persistence_unavailable');
 f.db.exec('DROP TRIGGER fail_terminal');f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne(deps,'terminal-recovered-worker');assert.equal(f.processing.getAttempt(f.attempt.id).status,'failed');
});


test('worker process death inside reconciliation transaction rolls back and a replacement resumes',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{backup}=require('node:sqlite');
 const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reconcile-crash-')),filename=path.join(dir,'fixture.sqlite');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 f.db.prepare("UPDATE processing_jobs SET status='leased',lease_owner='crash-worker',lease_expires_at='2999-01-01T00:00:00.000Z' WHERE id='poll'").run();
 await backup(f.db,filename);
 const script=`const {DatabaseSync}=require('node:sqlite'); const {ProcessingRepository}=require(process.argv[2]); const db=new DatabaseSync(process.argv[1]); db.function('simulate_process_death',()=>process.exit(73)); db.exec("CREATE TRIGGER crash_before_ingest BEFORE INSERT ON processing_jobs WHEN NEW.job_type='ingest' BEGIN SELECT simulate_process_death(); END"); const p=new ProcessingRepository(db); const attempt=p.getAttempt(process.argv[3]); p.advanceReconcileJob('poll','crash-worker',{uuid:attempt.providerTaskId,status:'completed',statusCode:40,progress:1}); process.exit(1);`;
 const child=spawnSync(process.execPath,['-e',script,filename,require.resolve('../server/processingRepository'),f.attempt.id],{encoding:'utf8',timeout:10000});assert.equal(child.status,73,child.stderr);
 const reopened=new DatabaseSync(filename);try{
  const processing=new ProcessingRepository(reopened);assert.equal(processing.getAttempt(f.attempt.id).status,'running');assert.equal(reopened.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');assert.equal(reopened.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='ingest'").get().n,0);
  reopened.exec('DROP TRIGGER crash_before_ingest');reopened.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();
  await processOne({processing,config:{},adapterFactory:()=>({status:async()=>({uuid:processing.getAttempt(f.attempt.id).providerTaskId,status:'completed',statusCode:40,progress:1}),output:async()=>({lines:[],nextLine:0})})},'replacement-worker');
  assert.equal(processing.getAttempt(f.attempt.id).status,'ingesting');assert.equal(reopened.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='ingest' AND status='pending'").get().n,1);
 }finally{reopened.close();}
});


test('historical partial reconciliation safely resumes ingestion without duplicate jobs',async t=>{
 for(const preexisting of [false,true]){
  const f=fixture(t),attempt=f.processing.getAttempt(f.attempt.id);
  f.db.prepare("UPDATE processing_attempts SET status='ingesting',upstream_completed_at='2020-01-01' WHERE id=?").run(attempt.id);
  if(preexisting)f.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('existing-ingest',?,'ingest','pending','2000','2000','2000')").run(attempt.id);
  await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({uuid:attempt.providerTaskId,status:'completed',statusCode:40,progress:1}),output:async()=>({lines:[],nextLine:0})})},'upgrade-worker');
  assert.equal(f.processing.getAttempt(attempt.id).status,'ingesting');assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'complete');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest' AND status IN ('pending','leased')").get(attempt.id).n,1);
 }
});

test('historical committed reconcile can advance to running',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE processing_attempts SET status='committed' WHERE id=?").run(f.attempt.id);
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'running',progress:.5}),output:async()=>({lines:[],nextLine:0})})},'committed-upgrade-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").get(f.attempt.id).n,1);
});


test('mismatched provider result identity raises a recoverable warning',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({uuid:'wrong-identity',status:'completed',statusCode:40,progress:1}),output:async()=>({lines:[],nextLine:0})})},'identity-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE id='poll'").get().error_code,'provider_result_identity_mismatch');assert.equal(processingJobCounts(f.db).observationWarnings,1);
});


test('transient attempt and provider lookup errors remain recoverable after many retries',async t=>{
 for(const method of ['getAttempt','getProvider']){
  const f=fixture(t),original=f.processing[method].bind(f.processing),status={uuid:f.processing.getAttempt(f.attempt.id).providerTaskId,status:'completed',statusCode:40,progress:1};let remaining=1,called=0;
  f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
  f.processing[method]=(...args)=>{if(remaining-- > 0)throw new Error('synthetic secret database read');return original(...args)};
  const deps={processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{called++;return status},output:async()=>({lines:[],nextLine:0})})};
  await processOne(deps,'read-failure-worker');
  const job=f.db.prepare("SELECT status,error_code,error_message FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_observation_persistence_unavailable');assert.doesNotMatch(job.error_message,/secret/);assert.equal(called,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(processingJobCounts(f.db).observationWarnings,1);
  f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id='poll'").run();await processOne(deps,'read-recovered-worker');assert.equal(f.processing.getAttempt(f.attempt.id).status,'ingesting');assert.equal(processingJobCounts(f.db).observationWarnings,0);
 }
});

test('advanced attempts settle their stale reconcile job without contacting the provider',async t=>{
 for(const state of ['cancelled','published','failed','derivatives','ready_for_review']){
  const f=fixture(t);let called=0;f.db.prepare("UPDATE processing_attempts SET status=? WHERE id=?").run(state,f.attempt.id);
  f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();
  await processOne({processing:f.processing,config:{},adapterFactory:()=>{called++;throw Error('must not access provider')}},'stale-read-worker');
  assert.equal(called,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,state);const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'cancelled');assert.equal(job.error_code,'stale_reconcile_attempt');
 }
});

test('missing attempt is diagnosed as unknown without contacting the provider',async t=>{
 const f=fixture(t);let called=0;f.processing.getAttempt=()=>null;
 await processOne({processing:f.processing,config:{},adapterFactory:()=>{called++;throw Error('must not access provider')}},'missing-attempt-worker');
 assert.equal(called,0);const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_attempt_unavailable');
});

test('missing provider is a recoverable warning rather than a failed attempt',async t=>{
 const f=fixture(t);let called=0;f.db.prepare("UPDATE processing_jobs SET attempt_count=8 WHERE id='poll'").run();f.processing.getProvider=()=>null;
 await processOne({processing:f.processing,config:{},adapterFactory:()=>{called++;throw Error('must not access provider')}},'provider-missing-worker');
 assert.equal(called,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE id='poll'").get().error_code,'provider_adapter_unavailable');assert.equal(processingJobCounts(f.db).observationWarnings,1);
});


test('stale-job settlement is fenced by live lease and advanced attempt state',t=>{
 const f=fixture(t);f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(f.attempt.id);const job=f.processing.claimJob('owner');assert.equal(job.id,'poll');
 assert.equal(f.processing.settleStaleReconcileJob('poll','other-owner'),false);
 f.db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(f.attempt.id);assert.equal(f.processing.settleStaleReconcileJob('poll','owner'),false);
 f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(f.attempt.id);f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();assert.equal(f.processing.settleStaleReconcileJob('poll','owner'),false);
 assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
});

test('reconcile heartbeat database failures leave the lease and prevent late poll writes after reclaim',async t=>{
 for(const method of ['getAttempt','heartbeatReconcileJob']){
  const f=fixture(t),originalMethod=f.processing[method].bind(f.processing),originalInterval=global.setInterval,originalClear=global.clearInterval;
  let tick,resolveStatus,enteredResolve,cleared=false,reads=0;
  const entered=new Promise(resolve=>{enteredResolve=resolve});
  global.setInterval=callback=>{tick=callback;return{unref(){}}};global.clearInterval=()=>{cleared=true};
  try{
   const work=processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{enteredResolve();return await new Promise(resolve=>{resolveStatus=resolve})},output:async()=>{reads++;return{lines:[],nextLine:0}}})},'old-worker');
   await entered;f.processing[method]=()=>{throw new Error('synthetic database failure')};
   assert.doesNotThrow(()=>tick());f.processing[method]=originalMethod;
   assert.doesNotThrow(()=>tick());
   assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
   f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();
   const replacement=f.processing.claimJob('replacement-worker');assert.equal(replacement.id,'poll');
   resolveStatus({status:'completed',statusCode:40,progress:1});await work;
   assert.equal(cleared,true);assert.equal(reads,0);
   assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
   assert.equal(f.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id='poll'").get().lease_owner,'replacement-worker');
   assert.equal(f.db.prepare("SELECT count(*) n FROM processing_jobs WHERE job_type='ingest'").get().n,0);
  }finally{f.processing[method]=originalMethod;global.setInterval=originalInterval;global.clearInterval=originalClear;}
 }
});

test('late reconcile output after heartbeat failure cannot advance cursor or persist logs',async t=>{
 const f=fixture(t),originalInterval=global.setInterval,originalClear=global.clearInterval,originalHeartbeat=f.processing.heartbeatReconcileJob.bind(f.processing);
 let tick,resolveOutput,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve});
 global.setInterval=callback=>{tick=callback;return{unref(){}}};global.clearInterval=()=>{};
 try{
  const work=processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'running',progress:.5}),output:async()=>{enteredResolve();return await new Promise(resolve=>{resolveOutput=resolve})}})},'old-worker');
  await entered;f.processing.heartbeatReconcileJob=()=>{throw new Error('synthetic database failure')};tick();f.processing.heartbeatReconcileJob=originalHeartbeat;
  f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();assert.equal(f.processing.claimJob('replacement-worker').id,'poll');
  resolveOutput({lines:['late record'],nextLine:1});await work;
  assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM processing_logs WHERE attempt_id=? AND message='late record'").get(f.attempt.id).n,0);
  assert.equal(f.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id='poll'").get().lease_owner,'replacement-worker');
 }finally{f.processing.heartbeatReconcileJob=originalHeartbeat;global.setInterval=originalInterval;global.clearInterval=originalClear;}
});

test('reclaimed or expired reconciliation cannot persist stale observations before heartbeat',async t=>{
 for(const mode of ['reclaimed','expired','warning']){
  const f=fixture(t);let resolveOutput,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve});
  const work=processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'running',progress:.5}),output:async()=>{enteredResolve();return await new Promise(resolve=>{resolveOutput=resolve})}})},'old-worker');
  await entered;f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();
  if(mode!=='expired')assert.equal(f.processing.claimJob('replacement-worker').id,'poll');
  resolveOutput(mode==='warning'?null:{lines:['stale record'],nextLine:12});await work;
  assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM processing_logs WHERE attempt_id=?").get(f.attempt.id).n,0);
  if(mode!=='expired')assert.equal(f.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id='poll'").get().lease_owner,'replacement-worker');
 }
});

test('observation persistence rolls back logs when cursor storage fails',async t=>{
 const f=fixture(t),original=f.processing.setOutputCursor.bind(f.processing);f.processing.setOutputCursor=()=>{throw Error('synthetic cursor failure')};
 try{await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'running'}),output:async()=>({lines:['rollback record'],nextLine:5})})},'worker');}
 finally{f.processing.setOutputCursor=original;}
 assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM processing_logs WHERE attempt_id=? AND message='rollback record'").get(f.attempt.id).n,0);
});

test('expired reconciliation heartbeat cannot renew its lease',t=>{
 const f=fixture(t);assert.equal(f.processing.claimJob('worker').id,'poll');
 f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();
 assert.equal(f.processing.heartbeatReconcileJob('poll','worker'),false);
 assert.equal(f.db.prepare("SELECT lease_expires_at FROM processing_jobs WHERE id='poll'").get().lease_expires_at,'2000');
});

test('provider error after expiry or reclaim cannot log or settle reconciliation',async t=>{
 for(const reclaimed of [false,true]){
  const f=fixture(t);let rejectStatus,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve});
  const work=processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{enteredResolve();return await new Promise((_resolve,reject)=>{rejectStatus=reject})}})},'old-worker');
  await entered;f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();if(reclaimed)assert.equal(f.processing.claimJob('replacement').id,'poll');
  rejectStatus(new Error('synthetic provider failure'));await work;
  const job=f.db.prepare("SELECT status,lease_owner,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'leased');assert.equal(job.lease_owner,reclaimed?'replacement':'old-worker');assert.equal(job.error_code,null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM processing_logs WHERE attempt_id=?').get(f.attempt.id).n,0);
 }
});

test('lease expiry between observation and terminal result cannot fail a task',async t=>{
 const f=fixture(t),persist=f.processing.persistReconcileObservation.bind(f.processing);
 f.processing.persistReconcileObservation=(...args)=>{const saved=persist(...args);f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();return saved;};
 await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'failed'}),output:async()=>({lines:[],nextLine:0})})},'old-worker');
 assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
 assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
 assert.equal(f.db.prepare("SELECT count(*) n FROM event_outbox WHERE event_type='processing.failed'").get().n,0);
});

test('late provider failure cannot mutate an advanced or superseded attempt',async t=>{
 for(const mode of ['derivatives','ready_for_review','superseded'])for(const response of ['terminal','error']){
  const f=fixture(t);let finish,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve});
  const work=processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>{enteredResolve();return await new Promise((resolve,reject)=>{finish=response==='terminal'?()=>resolve({status:'failed'}):()=>reject(Error('late provider error'))})},output:async()=>({lines:['late observation'],nextLine:7})})},'old-worker');
  await entered;
  if(mode==='superseded')f.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(f.processing.getAttempt(f.attempt.id).taskId);
  else f.db.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(mode,f.attempt.id);
  finish();await work;
  assert.equal(f.processing.getAttempt(f.attempt.id).status,mode==='superseded'?'running':mode);
  assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM processing_logs WHERE attempt_id=?').get(f.attempt.id).n,0);
  const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE id='poll'").get();assert.equal(job.status,'leased');assert.equal(job.error_code,null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM event_outbox WHERE event_type='processing.failed'").get().n,0);
 }
});

test('terminal settlement checks attempt eligibility after observation has committed',async t=>{
 for(const mode of ['derivatives','ready_for_review','superseded']){
  const f=fixture(t),persist=f.processing.persistReconcileObservation.bind(f.processing);
  f.processing.persistReconcileObservation=(...args)=>{const result=persist(...args);if(mode==='superseded')f.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(f.processing.getAttempt(f.attempt.id).taskId);else f.db.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(mode,f.attempt.id);return result;};
  await processOne({processing:f.processing,config:{},adapterFactory:()=>({status:async()=>({status:'failed'}),output:async()=>({lines:[],nextLine:0})})},'worker');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,mode==='superseded'?'running':mode);
  assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
  assert.equal(f.db.prepare("SELECT count(*) n FROM event_outbox WHERE event_type='processing.failed'").get().n,0);
 }
});

test('superseded reconcile is settled without touching attempts or another job',async t=>{
 for(const active of ['null','other']){
  const f=fixture(t),old=f.processing.getAttempt(f.attempt.id),taskId=old.taskId;
  let other=null;if(active==='other'){
   f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(old.id);
   other=f.processing.createAttempt({taskId,providerId:old.providerId,options:{}});
   f.db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(old.id);
  }else f.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(taskId);
  const before=f.db.prepare('SELECT * FROM processing_tasks WHERE id=?').get(taskId),oldBefore=f.db.prepare('SELECT * FROM processing_attempts WHERE id=?').get(old.id);
  const otherJob=other?f.db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(other.id):null;
  let calls=0;await processOne({processing:f.processing,config:{},adapterFactory:()=>{calls++;throw Error('unexpected provider access')}},'worker');
  assert.equal(calls,0);assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'cancelled');
  assert.deepEqual(f.db.prepare('SELECT * FROM processing_tasks WHERE id=?').get(taskId),before);
  assert.deepEqual(f.db.prepare('SELECT * FROM processing_attempts WHERE id=?').get(old.id),oldBefore);
  if(otherJob)assert.deepEqual(f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(otherJob.id),otherJob);
  assert.notEqual(f.processing.claimJob('replacement')?.id,'poll');
 }
});

test('superseded stale settlement requires a live owner and still-superseded task',t=>{
 const f=fixture(t),attempt=f.processing.getAttempt(f.attempt.id);assert.equal(f.processing.claimJob('worker').id,'poll');
 f.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(attempt.taskId);
 assert.equal(f.processing.settleStaleReconcileJob('poll','other'),false);
 f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id='poll'").run();assert.equal(f.processing.settleStaleReconcileJob('poll','worker'),false);
 assert.equal(f.processing.claimJob('replacement').id,'poll');
 f.db.prepare('UPDATE processing_tasks SET active_attempt_id=? WHERE id=?').run(attempt.id,attempt.taskId);
 assert.equal(f.processing.settleStaleReconcileJob('poll','replacement'),false);
 assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE id='poll'").get().status,'leased');
});
