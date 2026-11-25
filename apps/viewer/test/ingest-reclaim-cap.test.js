'use strict';
// A worker killed during ingest never reaches the catch-path attempt cap.
// These cases pin the repository-level cap for repeated expired-lease reclaims.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {inspectIngestRecovery}=require('../server/processingIngestRecovery');

const PAST='2000-01-01T00:00:00.000Z';

function fixture(t,{name='Synthetic reclaim'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reclaim-cap-')),database=openDatabase(path.join(root,'viewer.sqlite'));
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const processing=new ProcessingRepository(database);
  const f={root,database,processing};
  f.attempt=()=>{
    const project=processing.createProject({displayName:`${name} ${crypto.randomUUID()}`});
    const dataset=processing.createDataset({projectId:project.id,displayName:'Original photos',rootKey:'datasets',relativePath:`source-${crypto.randomUUID()}`});
    processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:5,sha256:crypto.createHash('sha256').update('photo').digest('hex')}],'a'.repeat(64));
    const provider=processing.upsertProvider({type:'nodeodm',displayName:`Synthetic ODM ${crypto.randomUUID()}`,endpoint:'http://127.0.0.1:3000',enabled:true});
    const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Reclaim cap'});
    const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{dsm:true},createdBy:'ops:reclaim'});
    const submit=processing.claimJob('fixture');
    assert.equal(submit.attempt_id,attempt.id);
    assert.equal(processing.recordAttemptProviderResult(submit.id,'fixture',{uuid:attempt.providerTaskId,status:'completed',statusCode:40,imagesCount:1}),true);
    processing.completeJob(submit.id,'fixture');processing.transitionAttempt(attempt.id,'ingesting');
    processing.enqueueJob(attempt.id,'ingest');
    return{project,dataset,provider,task,attempt:processing.getAttempt(attempt.id)};
  };
  f.job=id=>database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(id);
  f.expire=id=>database.prepare('UPDATE processing_jobs SET lease_expires_at=? WHERE id=?').run(PAST,id);
  f.jobs=attemptId=>database.prepare('SELECT * FROM processing_jobs WHERE attempt_id=? ORDER BY created_at,id').all(attemptId);
  return f;
}

// Simulate a worker that is killed after every claim: the lease simply expires.
function crashLoop(f,attemptId,claims){
  let job=null;
  for(let i=0;i<claims;i+=1){
    const next=f.processing.claimJob(`killed-worker-${i}`);
    if(!next)return{job,stopped:i};
    assert.equal(next.attempt_id,attemptId);assert.equal(next.job_type,'ingest');
    job=next;f.expire(job.id);
  }
  return{job,stopped:null};
}

test('expired-lease ingest reclaims stop at the existing 5-attempt cap without download or resubmission',t=>{
  const f=fixture(t),{attempt,task}=f.attempt();
  const {job,stopped}=crashLoop(f,attempt.id,20);
  assert.equal(stopped,5,'the sixth claim must not hand the job to another worker');
  const row=f.job(job.id);
  assert.equal(row.status,'failed');assert.equal(row.error_code,'ingest_lease_retry_exhausted');
  assert.equal(row.lease_owner,null);assert.equal(row.attempt_count,5);
  const failed=f.processing.getAttempt(attempt.id);
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'ingest_lease_retry_exhausted');
  assert.equal(failed.providerTaskId,attempt.providerTaskId,'original provider task identity is retained');
  assert.equal(f.processing.getTask(task.id).status,'failed');
  assert.equal(f.jobs(attempt.id).filter(j=>j.job_type==='submit').length,1,'no resubmission');
  assert.equal(f.jobs(attempt.id).filter(j=>['pending','leased'].includes(j.status)).length,0);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='processing_job.lease_retry_exhausted' AND entity_id=?").get(job.id).n,1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM event_outbox WHERE event_type='processing.failed'").get().n,1);
  assert.equal(f.processing.claimJob('later-worker'),null);
});

test('a single expired lease after ordinary retries is reclaimed, not terminalized',t=>{
  const f=fixture(t),{attempt}=f.attempt();
  for(let i=0;i<6;i+=1){
    const job=f.processing.claimJob(`retry-worker-${i}`);
    assert.equal(f.processing.failJob(job.id,job.lease_owner,'provider_result_transfer_unavailable','waiting',PAST),true);
  }
  const job=f.processing.claimJob('restarted-worker');assert.ok(job.attempt_count>=7);f.expire(job.id);
  const reclaimed=f.processing.claimJob('replacement-worker');
  assert.equal(reclaimed.id,job.id,'one restart must not fail the attempt');
  assert.equal(reclaimed.lease_owner,'replacement-worker');
  assert.equal(reclaimed.error_code,'processing_lease_expired');
  assert.equal(f.processing.getAttempt(attempt.id).status,'ingesting');
});

test('a live lease is never reclaimed or terminalized, even past the cap',t=>{
  const f=fixture(t),{attempt}=f.attempt();
  const {job}=crashLoop(f,attempt.id,4);
  const live=f.processing.claimJob('live-worker');assert.equal(live.id,job.id);assert.equal(live.attempt_count,5);
  assert.equal(f.processing.claimJob('other-worker'),null);
  const row=f.job(job.id);
  assert.equal(row.status,'leased');assert.equal(row.lease_owner,'live-worker');
  assert.equal(f.processing.getAttempt(attempt.id).status,'ingesting');
});

test('an exhausted job does not starve other queued work',t=>{
  const f=fixture(t),first=f.attempt();
  const {job}=crashLoop(f,first.attempt.id,4);
  f.processing.claimJob('last-killed-worker');f.expire(job.id);
  f.database.prepare('UPDATE processing_jobs SET created_at=? WHERE id=?').run(PAST,job.id);
  f.processing.terminalizeExhaustedIngestReclaims=()=>0; // the claim query alone must skip it
  const second=f.attempt();
  const next=f.processing.claimJob('healthy-worker');
  assert.ok(next,'other work is still claimable');
  assert.equal(next.attempt_id,second.attempt.id);
  assert.equal(f.job(job.id).status,'leased','the exhausted job is left for terminalization, not handed out');
});

test('attempts no longer ingesting are never terminalized by the cap',t=>{
  const f=fixture(t),{attempt}=f.attempt();
  const {job}=crashLoop(f,attempt.id,4);
  f.processing.claimJob('last-killed-worker');f.expire(job.id);
  f.database.prepare("UPDATE processing_attempts SET status='ready_for_review' WHERE id=?").run(attempt.id);
  f.processing.claimJob('any-worker');
  assert.equal(f.processing.getAttempt(attempt.id).status,'ready_for_review');
  assert.notEqual(f.job(job.id).status,'failed');
});

test('upgrade: a legacy expired ingest with NULL error_code past the cap is reclaimed, not stalled',t=>{
  const f=fixture(t),{attempt}=f.attempt();
  // Pre-upgrade workers crashed without writing any marker.
  for(let i=0;i<5;i+=1){const job=f.processing.claimJob(`legacy-worker-${i}`);f.expire(job.id);f.database.prepare('UPDATE processing_jobs SET error_code=NULL,error_message=NULL WHERE id=?').run(job.id);}
  const legacy=f.jobs(attempt.id).find(j=>j.job_type==='ingest');
  assert.equal(legacy.error_code,null);assert.equal(legacy.attempt_count,5);assert.equal(legacy.status,'leased');
  const reclaimed=f.processing.claimJob('upgraded-worker');
  assert.ok(reclaimed,'a NULL marker must not make the row unclaimable');
  assert.equal(reclaimed.id,legacy.id);assert.equal(reclaimed.error_code,'processing_lease_expired');
  f.expire(reclaimed.id);
  assert.equal(f.processing.claimJob('next-worker'),null,'a further consecutive crash now hits the cap');
  assert.equal(f.job(legacy.id).status,'failed');
  assert.equal(f.processing.getAttempt(attempt.id).status,'failed');
});

function stagePartialModel(f,{attempt,task,project},job){
  const repository=new ViewerRepository(f.database);
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:'Partial',status:'importing',makeActive:false,assets:[],sourceLocator:{taskId:task.id,attemptId:attempt.id}});
  const version=f.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,attempt.id);
  assert.ok(f.processing.setAttemptResultForJob(job.id,job.lease_owner,model.id,version.id));
  return{model,version,ids:{versionId:version.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:`${task.id}/${attempt.id}`,status:'staged',byteSize:10,assetCount:1}};
}

test('a capped attempt with a staged partial model keeps its rows and gets a distinct held diagnostic',t=>{
  const f=fixture(t),setup=f.attempt();
  const first=f.processing.claimJob('partial-worker-0');
  const {version,ids}=stagePartialModel(f,setup,first);
  f.processing.registerModelOutput({...ids,jobId:first.id,owner:first.lease_owner,claimAttemptCount:first.attempt_count});
  f.expire(first.id);
  crashLoop(f,setup.attempt.id,20);
  const failed=f.processing.getAttempt(setup.attempt.id);
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'ingest_lease_retry_exhausted_partial_result');
  assert.equal(failed.resultModelVersionId,version.id,'partial result identity retained for the owner hold classification');
  const output=f.database.prepare('SELECT * FROM model_outputs WHERE id=?').get(version.id);
  assert.ok(output,'staged output row is retained, not deleted');assert.equal(output.status,'failed');
  assert.ok(f.database.prepare('SELECT 1 FROM model_versions WHERE id=?').get(version.id),'version row retained');
  const audit=JSON.parse(f.database.prepare("SELECT details_json FROM audit_events WHERE action='processing_job.lease_retry_exhausted'").get().details_json);
  assert.equal(audit.partialResult,true);assert.equal(audit.modelVersionId,version.id);
});

test('registerModelOutput rejects a late worker whose ingest lease expired or was re-claimed',t=>{
  const f=fixture(t),setup=f.attempt();
  const first=f.processing.claimJob('same-owner');
  const {ids}=stagePartialModel(f,setup,first);
  const fence={jobId:first.id,owner:first.lease_owner,claimAttemptCount:first.attempt_count};
  f.expire(first.id);
  assert.throws(()=>f.processing.registerModelOutput({...ids,...fence}),{code:'lease_lost'},'expired lease (slow scanAbsolute) cannot register');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
  const second=f.processing.claimJob('same-owner');assert.equal(second.id,first.id);assert.equal(second.lease_owner,first.lease_owner);
  assert.throws(()=>f.processing.registerModelOutput({...ids,...fence}),{code:'lease_lost'},'same owner name but an older claim generation is rejected');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM model_outputs').get().n,0);
  const output=f.processing.registerModelOutput({...ids,jobId:second.id,owner:second.lease_owner,claimAttemptCount:second.attempt_count});
  assert.equal(output.status,'staged','the live current claim registers');
});

test('registerModelOutput without a job fence keeps its existing behavior for other callers',t=>{
  const f=fixture(t),setup=f.attempt();
  const first=f.processing.claimJob('import-like');
  const {ids}=stagePartialModel(f,setup,first);
  f.expire(first.id);
  assert.equal(f.processing.registerModelOutput(ids).status,'staged');
  assert.throws(()=>f.processing.registerModelOutput({...ids,jobId:first.id}),{code:'invalid_output_fence'},'a partial fence is refused, not ignored');
});

test('a cap-exhausted ingest with no partial model stays eligible for supported same-attempt recovery',t=>{
  const f=fixture(t),{attempt}=f.attempt();
  const {job}=crashLoop(f,attempt.id,20);
  const context=inspectIngestRecovery(f.processing,attempt.id);
  assert.equal(context.failedJob.id,job.id);
  assert.equal(context.attempt.id,attempt.id);
});

test('legacy exact unlinked model/version is retained and held after cap exhaustion',t=>{
 const f=fixture(t),{attempt,task}=f.attempt(),repository=new ViewerRepository(f.database);
 const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:'Legacy orphan',status:'importing',makeActive:false,assets:[]});
 const {job}=crashLoop(f,attempt.id,20),failed=f.processing.getAttempt(attempt.id);
 assert.equal(failed.errorCode,'ingest_lease_retry_exhausted_partial_result');
 assert.equal(failed.resultModelId,null);assert.equal(failed.resultModelVersionId,null);
 assert.ok(f.database.prepare('SELECT 1 FROM models WHERE id=?').get(model.id));
 assert.ok(f.database.prepare('SELECT 1 FROM model_versions WHERE model_id=?').get(model.id));
 assert.throws(()=>inspectIngestRecovery(f.processing,attempt.id),{code:'ingest_recovery_unlinked_partial_result'});
 assert.equal(f.job(job.id).status,'failed');
});
test('unrelated task, attempt or provider model/version never creates a false orphan hold',t=>{
 for(const kind of ['task','attempt','provider']){
  const f=fixture(t),{attempt,task}=f.attempt(),repository=new ViewerRepository(f.database);
  repository.upsertModelVersion({provider:kind==='provider'?'other':'ltds-processing',providerModelId:kind==='task'?'other-task':task.id,providerVersionId:kind==='attempt'?'other-attempt':attempt.id,displayName:'Unrelated',status:'importing',makeActive:false,assets:[]});
  crashLoop(f,attempt.id,20);
  assert.equal(f.processing.getAttempt(attempt.id).errorCode,'ingest_lease_retry_exhausted');
  assert.equal(inspectIngestRecovery(f.processing,attempt.id).attempt.id,attempt.id);
 }
});
