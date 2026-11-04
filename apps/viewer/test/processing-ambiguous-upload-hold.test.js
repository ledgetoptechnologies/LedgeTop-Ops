'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function fixture(t,attemptCount=0){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ambiguous-upload-')),dbPath=path.join(root,'viewer.sqlite');
  let db=openDatabase(dbPath),processing=new ProcessingRepository(db);
  t.after(()=>{try{db.close()}catch{}fs.rmSync(root,{recursive:true,force:true})});
  const project=processing.createProject({displayName:'P'}),dataset=processing.createDataset({projectId:project.id,displayName:'D',rootKey:'datasets',relativePath:'data'});
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','a.jpg'),'jpeg');
  const files=[{relativePath:'a.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'T'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
  db.prepare('UPDATE processing_jobs SET attempt_count=? WHERE attempt_id=?').run(attemptCount,attempt.id);
  const job=db.prepare('SELECT * FROM processing_jobs WHERE attempt_id=?').get(attempt.id),storage={resolve:(_key,relative)=>path.join(root,relative),requireProcessingHeadroom:()=>{}};
  const providerState={exists:false,initializations:0,statusCalls:0,uploadCalls:0,removals:0,commits:0,accepted:[]};
  const adapter={
    status:async()=>{providerState.statusCalls++;if(!providerState.exists)throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});return{uuid:attempt.providerTaskId,status:'queued',imagesCount:1};},
    initialize:async()=>{providerState.initializations++;providerState.exists=true;return{uuid:attempt.providerTaskId};},
    upload:async(_id,batch)=>{providerState.uploadCalls++;providerState.accepted.push(...batch.map(file=>file.relativePath));throw Object.assign(new Error('connection reset after provider accepted bytes'),{code:'ECONNRESET'});},
    remove:async()=>{providerState.removals++;},commit:async()=>{providerState.commits++;},
  };
  const deps=()=>({processing,storage,config:{},providerCredentials:{},adapterFactory:()=>adapter});
  const reopen=()=>{db.close();db=openDatabase(dbPath);processing=new ProcessingRepository(db);};
  return{root,dbPath,get db(){return db},get processing(){return processing},dataset,attempt,task,job,providerState,adapter,deps,reopen};
}

test('actual submit remains queued through upload and only becomes processing on a running observation',async t=>{
  const f=fixture(t),seen=[];
  f.adapter.initialize=async()=>{seen.push(['initialize',f.processing.getTask(f.task.id).status]);return{uuid:f.attempt.providerTaskId};};
  f.adapter.upload=async()=>{seen.push(['upload',f.processing.getTask(f.task.id).status]);};
  f.adapter.commit=async()=>{seen.push(['commit',f.processing.getTask(f.task.id).status]);};
  await processOne(f.deps(),'submit-worker');
  assert.deepEqual(seen,[['initialize','queued'],['upload','queued'],['commit','queued']]);
  assert.equal(f.processing.getTask(f.task.id).status,'queued');
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'queued_upstream');
  f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile'").run(f.attempt.id);
  let code=10;
  const pollAdapter=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async url=>{
    const value=url.pathname.endsWith('/info')
      ? {uuid:f.attempt.providerTaskId,status:{code},progress:0,...(code===10?{ledgetopQueueState:'waiting_for_dispatch'}:{ledgetopNodeId:'node-cluster'})}
      : url.searchParams.get('line')==='0'?['Waiting for node']:[];
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }});
  const pollDeps={...f.deps(),adapterFactory:()=>pollAdapter};
  await processOne(pollDeps,'queued-poll-worker');
  assert.equal(f.processing.getTask(f.task.id).status,'queued');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerStatus.queueState,'waiting_for_dispatch');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerOutputCursor,1);
  assert.ok(f.processing.listLogs(f.attempt.id).some(line=>line.message==='Waiting for node'));
  f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile'").run(f.attempt.id);
  code=20;
  await processOne(pollDeps,'poll-worker');
  assert.equal(f.processing.getTask(f.task.id).status,'processing');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerStatus.nodeId,'node-cluster');
});

test('lost upload response is held across processOne retry and SQLite reopen without contacting or deleting provider task',async t=>{
  const f=fixture(t);assert.equal(await processOne(f.deps(),'worker-first'),true);
  let attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.deepEqual(f.providerState.accepted,['a.jpg']);assert.equal(f.providerState.uploadCalls,1);
  assert.equal(attempt.submissionPhase,'uploading');assert.equal(attempt.errorCode,'provider_upload_acceptance_unknown');
  assert.equal(job.status,'pending');assert.equal(job.attempt_count,0);assert.equal(job.error_code,'provider_upload_acceptance_unknown');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);
  assert.equal(fs.readFileSync(path.join(f.root,'data','a.jpg'),'utf8'),'jpeg');

  f.reopen();f.db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  const before={...f.providerState};assert.equal(await processOne(f.deps(),'worker-after-reopen'),true);
  attempt=f.processing.getAttempt(f.attempt.id);job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.deepEqual(f.providerState,before,'held retries make no provider status, upload, remove, or commit requests');
  assert.equal(attempt.status,'uploading');assert.equal(attempt.errorCode,'provider_upload_acceptance_unknown');
  assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_upload_acceptance_unknown');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);
});

test('first upload failure at retry threshold becomes a durable hold instead of terminal failure',async t=>{
  const f=fixture(t,4);assert.equal(await processOne(f.deps(),'worker-at-threshold'),true);
  const attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id),task=f.processing.getTask(f.task.id);
  assert.equal(f.providerState.uploadCalls,1);assert.equal(f.providerState.removals,0);assert.equal(f.providerState.commits,0);
  assert.equal(attempt.status,'uploading');assert.equal(attempt.submissionPhase,'uploading');assert.equal(attempt.errorCode,'provider_upload_acceptance_unknown');
  assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_upload_acceptance_unknown');assert.equal(job.attempt_count,4);
  assert.equal(task.status,'queued');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);
  assert.equal(f.processing.hasUnresolvedSubmission(f.attempt.id),true);
  assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_execution_unresolved'});
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.processing.getProvider(f.attempt.providerId).id}),{code:'provider_execution_unresolved'});
});

test('an existing provider task in a new local phase is held instead of removed',async t=>{
  const f=fixture(t);f.providerState.exists=true;assert.equal(await processOne(f.deps(),'worker-existing-task'),true);
  const attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(f.providerState.statusCalls,1);assert.equal(f.providerState.initializations,0);assert.equal(f.providerState.removals,0);assert.equal(f.providerState.uploadCalls,0);assert.equal(f.providerState.commits,0);
  assert.equal(attempt.submissionPhase,'new');assert.equal(attempt.errorCode,'provider_submission_observation_unavailable');
  assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_observation_unavailable');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);
});

test('a held submission is not reinitialized after a transient provider not-found response',async t=>{
  const f=fixture(t);f.providerState.exists=true;assert.equal(await processOne(f.deps(),'worker-existing-task'),true);
  f.providerState.exists=false;
  f.db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  const before={...f.providerState};assert.equal(await processOne(f.deps(),'worker-after-not-found'),true);
  const attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(f.providerState.statusCalls,before.statusCalls);
  assert.equal(f.providerState.initializations,before.initializations);
  assert.equal(f.providerState.uploadCalls,before.uploadCalls);
  assert.equal(attempt.submissionPhase,'new');assert.equal(attempt.errorCode,'provider_submission_observation_unavailable');
  assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_observation_unavailable');
});
