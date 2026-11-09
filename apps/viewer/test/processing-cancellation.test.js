'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker');

function fixture(t,{status='running',phase='committed'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-cancel-'));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Cancellation'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  db.prepare("UPDATE processing_attempts SET status=?,submission_phase=? WHERE id=?").run(status,phase,attempt.id);
  db.prepare("UPDATE processing_tasks SET active_attempt_id=?,status='processing' WHERE id=?").run(attempt.id,task.id);
  db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=? AND job_type='submit'").run(attempt.id);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return{db,processing,project,dataset,task,provider,attempt};
}

const fs=require('node:fs');
function cancellationDeps(processing,adapter){return{processing,config:{},providerCredentials:{resolve:()=>''},adapterFactory:()=>adapter};}

test('upstream cancellation remains durable and blocks replacement until node confirms termination',async t=>{
  const f=fixture(t),remote={status:'running',cancelCalls:0},adapter={
    async status(){return{status:remote.status,uuid:f.attempt.providerTaskId};},
    async cancel(){remote.cancelCalls++;remote.status='running';return{uuid:f.attempt.providerTaskId,status:'running'};},
  };
  assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_termination_unconfirmed'});
  const requested=f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');
  assert.equal(requested.attempt.status,'running');assert.equal(requested.attempt.cancelRequestStatus,'pending');
  assert.throws(()=>f.db.prepare('DELETE FROM processing_attempts WHERE id=?').run(f.attempt.id),/unsettled provider cancellation must be retained/);
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{}}),{code:'attempt_in_progress'});
  await processOne(cancellationDeps(f.processing,adapter),'cancel-worker-a');
  assert.equal(remote.cancelCalls,1);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).status,'pending');
  remote.status='cancelled';
  f.db.prepare("UPDATE processing_cancellation_requests SET available_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?").run(f.attempt.id);
  await processOne(cancellationDeps(f.processing,adapter),'cancel-worker-b');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).status,'pending');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).lastErrorCode,'cancel_termination_unverified');
  assert.equal(f.processing.getDataset(f.dataset.id).status,'finalized','cancellation preserves the source dataset');
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{}}),{code:'attempt_in_progress'});
});

test('lost cancellation reply survives worker restart and is safely retried',async t=>{
  const f=fixture(t),remote={status:'running',cancelCalls:0},adapter={
    async status(){return{status:remote.status,uuid:f.attempt.providerTaskId};},
    async cancel(){remote.cancelCalls++;remote.status='cancelled';throw Object.assign(new Error('connection closed after request was sent'),{code:'provider_request_failed'});},
  };
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');
  await processOne(cancellationDeps(f.processing,adapter),'worker-before-restart');
  assert.equal(remote.cancelCalls,1);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  f.db.prepare("UPDATE processing_cancellation_requests SET status='leased',lease_owner='dead-worker',lease_expires_at='2000-01-01T00:00:00.000Z',available_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?").run(f.attempt.id);
  await processOne(cancellationDeps(f.processing,adapter),'worker-after-restart');
  assert.equal(remote.cancelCalls,1,'recovery observes the confirmed terminal state without repeating the side effect');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).status,'pending');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).lastErrorCode,'cancel_termination_unverified');
});

test('cancel-before-provider-start cancels only the queued local submit job',async t=>{
  const f=fixture(t,{status:'pending',phase:'new'});let adapterCalls=0;
  f.db.prepare("UPDATE processing_jobs SET status='pending',available_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');
  await processOne(cancellationDeps(f.processing,{async status(){adapterCalls++;throw new Error('must not call provider');}}),'cancel-before-start');
  assert.equal(adapterCalls,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,'cancelled');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).outcome,'cancelled_before_provider_start');
  assert.equal(f.db.prepare("SELECT status FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id).status,'cancelled');
});

test('provider completed before cancellation is not discarded or marked cancelled',async t=>{
  const f=fixture(t),adapter={async status(){return{status:'completed',uuid:f.attempt.providerTaskId};},async cancel(){assert.fail('completed work must not be cancelled');}};
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');
  await processOne(cancellationDeps(f.processing,adapter),'cancel-completed');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
  assert.equal(f.processing.getAttemptCancellation(f.attempt.id).outcome,'provider_completed_before_cancel');
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{}}),{code:'attempt_in_progress'});
  assert.equal(f.processing.claimJob('reconcile-worker')?.job_type,undefined,'no new work was scheduled by the cancellation request');
});

test('cancellation waits for a leased submit owner, then resumes after that lease stops',async t=>{
  const f=fixture(t,{status:'pending',phase:'new'});f.db.prepare("UPDATE processing_jobs SET status='pending',available_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);const submit=f.processing.claimJob('submit-owner');assert.equal(submit.job_type,'submit');
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');let providerCalls=0;
  const deps=cancellationDeps(f.processing,{async status(){providerCalls++;throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});}});
  await processOne(deps,'cancel-owner-a');
  assert.equal(providerCalls,0,'cancellation does not race an in-flight submit request');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'admitted');
  assert.equal(f.processing.stopProviderJobForCancellation(submit.id,'submit-owner'),true);
  f.db.prepare("UPDATE processing_cancellation_requests SET available_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?").run(f.attempt.id);
  await processOne(deps,'cancel-owner-b');
  assert.equal(providerCalls,1);assert.equal(f.processing.getAttempt(f.attempt.id).status,'cancelled');
});

test('expired pre-start submit lease can be fenced after worker restart',async t=>{
  const f=fixture(t,{status:'admitted',phase:'new'});
  f.db.prepare("UPDATE processing_jobs SET status='leased',lease_owner='dead-submit',lease_expires_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');let providerCalls=0;
  await processOne(cancellationDeps(f.processing,{async status(){providerCalls++;throw new Error('pre-start cancel should not contact provider');}}),'cancel-after-restart');
  assert.equal(providerCalls,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,'cancelled');
  assert.equal(f.processing.getAttemptSubmitJob(f.attempt.id).errorCode,'cancel_requested');
});

test('held provider cancellation stays nonterminal and requires operator confirmation',async t=>{
  const f=fixture(t),adapter={async status(){return{status:'cancelled',statusCode:50,ledgetopHeld:true,uuid:f.attempt.providerTaskId};},async cancel(){assert.fail('held work must not receive repeated cancel commands');}};
  f.processing.requestAttemptCancellation(f.attempt.id,'ops:test');
  await processOne(cancellationDeps(f.processing,adapter),'cancel-held');
  const attempt=f.processing.getAttempt(f.attempt.id),request=f.processing.getAttemptCancellation(f.attempt.id);
  assert.equal(attempt.status,'running');assert.equal(request.status,'pending');assert.equal(request.lastErrorCode,'provider_held_termination_unverified');
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{}}),{code:'attempt_in_progress'});
});
