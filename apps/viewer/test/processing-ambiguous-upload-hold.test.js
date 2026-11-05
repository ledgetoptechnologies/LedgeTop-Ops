'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker');
const {PreparedSubmissionOutbox,canonicalizeJcs}=require('../server/preparedSubmissionOutbox');
const {SourceIntakeClientV2}=require('../server/sourceIntakeClientV2');
const ReferenceProtocol=require('../server/referenceProtocol');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function fixture(t,attemptCount=0,referenceOrigin=null){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ambiguous-upload-')),dbPath=path.join(root,'viewer.sqlite');
  let db=openDatabase(dbPath),processing=new ProcessingRepository(db);
  t.after(()=>{try{db.close()}catch{}fs.rmSync(root,{recursive:true,force:true})});
  const project=processing.createProject({displayName:'P'}),dataset=processing.createDataset({projectId:project.id,displayName:'D',rootKey:'datasets',relativePath:'data'});
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','a.jpg'),'jpeg');
  const files=[{relativePath:'a.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:referenceOrigin||'http://127.0.0.1:3000',enabled:true,capabilities:referenceOrigin?{detectionMethod:'pinned-reference-coordinator'}:{}}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'T'});
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
  return{root,dbPath,get db(){return db},get processing(){return processing},dataset,attempt,task,job,providerState,deps,reopen};
}

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
  assert.equal(task.status,'processing');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);
  assert.equal(f.processing.hasUnresolvedSubmission(f.attempt.id),true);
  assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_execution_unresolved'});
  assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.processing.getProvider(f.attempt.providerId).id}),{code:'provider_execution_unresolved'});
});

test('configured coordinator runtime unavailability holds submission without consuming retries or falling back to NodeODM',async t=>{
  const f=fixture(t,4),deps={...f.deps(),config:{referenceSourceIntake:{enabled:true,providerId:f.attempt.providerId}}};
  assert.equal(await processOne(deps,'worker-coordinator-hold'),true);
  const attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(f.providerState.statusCalls,0);assert.equal(f.providerState.initializations,0);assert.equal(f.providerState.uploadCalls,0);
  assert.equal(attempt.errorCode,'reference_coordinator_unavailable');
  assert.equal(job.error_code,'reference_coordinator_unavailable');assert.equal(job.status,'pending');assert.equal(job.attempt_count,4);
  assert.equal(f.processing.hasUnresolvedSubmission(f.attempt.id),true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dataset_files WHERE dataset_id=?').get(f.dataset.id).n,1);

  f.reopen();f.db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  const resumed={...f.deps(),config:{referenceSourceIntake:{enabled:true,providerId:f.attempt.providerId}}};
  assert.equal(await processOne(resumed,'worker-coordinator-after-reopen'),true);
  const resumedAttempt=f.processing.getAttempt(f.attempt.id),resumedJob=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(f.providerState.statusCalls,0);assert.equal(f.providerState.initializations,0);assert.equal(f.providerState.uploadCalls,0);
  assert.equal(resumedAttempt.errorCode,'reference_coordinator_unavailable');
  assert.equal(resumedJob.status,'pending');assert.equal(resumedJob.attempt_count,4);
  assert.equal(f.processing.hasUnresolvedSubmission(f.attempt.id),true);
});

test('V2 submission persists one immutable coordinator request and resumes after restart without V1 fallback',async t=>{
  const f=fixture(t,0,'https://processing.staging.example'),snapshotKeys=crypto.generateKeyPairSync('ed25519'),attestationKeys=crypto.generateKeyPairSync('ed25519');
  let outbox=new PreparedSubmissionOutbox(f.db),client=null,uploadCalls=0,requestBytes=null,adapterCalls=0,createCalls=0,completionCalls=0;
  let sourceRequest=null,sourceReceipts=[],completionResponse=null;
  const source={enabled:true,providerId:f.attempt.providerId,origin:'https://processing.staging.example',authorityId:'11111111-1111-4111-8111-111111111111',
    principalId:'viewer-staging',environment:'staging',snapshotIssuerId:'snapshot-staging',snapshotKeyId:'snapshot-v1',attestationIssuerId:'viewer-staging',attestationKeyId:'attestation-v1'};
  const caps=ReferenceProtocol.createCapabilities('staging');
  const sourceIntake={enabled:true,maxObjects:10000},viewerAcceptance={enabled:true};
  const snapshotSigner={issuerId:source.snapshotIssuerId,keyId:source.snapshotKeyId,sign:message=>crypto.sign(null,message,snapshotKeys.privateKey)};
  const attestationSigner={issuerId:source.attestationIssuerId,keyId:source.attestationKeyId,publicKey:attestationKeys.publicKey,sign:message=>crypto.sign(null,message,attestationKeys.privateKey)};
  const jsonResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const fetchImpl=async(url,init={})=>{
    const parsed=new URL(url),route=parsed.pathname;
    if(route==='/ltds/v2/capabilities')return jsonResponse({...caps,sourceIntake,viewerAcceptance});
    if(route==='/ltds/v2/jobs'&&init.method==='POST'){
      createCalls++;requestBytes=init.body;sourceRequest=JSON.parse(init.body);
      return jsonResponse({jobId:sourceRequest.providerTaskId,attemptId:sourceRequest.submissionId,providerTaskId:sourceRequest.providerTaskId,
        generation:1,environment:'staging',manifestSha256:sourceRequest.manifest.sha256,pipelineManifestSha256:sourceRequest.manifest.sha256,
        sourceManifestSha256:sourceRequest.sourceManifest.sha256,derivedManifestSha256:sourceRequest.derivedManifest.sha256,
        pipelineDigest:sourceRequest.sourceAttestation.proof.pipelineDigest,status:'queued',phase:'source_receiving',sourceState:'receiving',derivedState:'receiving',
        sourceReceipt:null,derivedReceipt:null,sourceReceiptSha256:null,derivedReceiptSha256:null},201);
    }
    if(route===`/ltds/v2/jobs/${f.attempt.providerTaskId}`&&init.method==='GET')return jsonResponse({
      jobId:f.attempt.providerTaskId,attemptId:f.attempt.id,providerTaskId:f.attempt.providerTaskId,generation:1,environment:'staging',
      manifestSha256:sourceRequest.manifest.sha256,sourceManifestSha256:sourceRequest.sourceManifest.sha256,
      derivedManifestSha256:sourceRequest.derivedManifest.sha256,sourceObjectReceipts:sourceReceipts,derivedObjectReceipts:[]});
    if(route.startsWith(`/ltds/v2/jobs/${f.attempt.providerTaskId}/source/`)&&init.method==='PUT'){
      const objectId=decodeURIComponent(route.split('/').at(-1)),object=sourceRequest.sourceManifest.objects.find(item=>item.id===objectId);
      assert.ok(object);assert.equal(init.headers['Content-Length'],String(object.byteSize));
      const chunks=[];for await(const chunk of init.body)chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(),'jpeg');uploadCalls++;
      sourceReceipts=[{objectId,objectKind:'source',byteSize:object.byteSize,sha256:object.sha256,generation:1,manifestSha256:sourceRequest.sourceManifest.sha256}];
      if(uploadCalls===1)throw new Error('synthetic response loss after coordinator accepted bytes');
      return new Response(null,{status:201});
    }
    if(route===`/ltds/v2/jobs/${f.attempt.providerTaskId}/source/complete`&&init.method==='POST'){
      completionCalls++;
      if(!completionResponse){
        const retainedAt=new Date().toISOString(),objects=sourceRequest.sourceManifest.objects.map(object=>Object.fromEntries(
          ['id','byteSize','sha256','sourceType','retentionClass','retentionHoldId'].map(key=>[key,object[key]])));
        const sourceReceipt={schemaVersion:2,receiptType:'source_retention',receiptId:crypto.randomUUID(),storageReceiptId:crypto.randomUUID(),
          jobId:f.attempt.providerTaskId,attemptId:f.attempt.id,generation:1,environment:'staging',pipelineManifestSha256:sourceRequest.manifest.sha256,
          sourceManifestSha256:sourceRequest.sourceManifest.sha256,pipelineDigest:sourceRequest.sourceAttestation.proof.pipelineDigest,objects,
          retainedAt,retentionGuarantee:'until_explicit_source_release_v1'};
        const derivedReceipt={schemaVersion:1,receiptType:'attempt_derived_input',receiptId:crypto.randomUUID(),jobId:f.attempt.providerTaskId,
          attemptId:f.attempt.id,generation:1,environment:'staging',derivedManifestSha256:sourceRequest.derivedManifest.sha256,objects:[],retainedAt};
        const digest=value=>sha(canonicalizeJcs(value));
        completionResponse={jobId:f.attempt.providerTaskId,attemptId:f.attempt.id,providerTaskId:f.attempt.providerTaskId,generation:1,environment:'staging',
          pipelineManifestSha256:sourceRequest.manifest.sha256,sourceManifestSha256:sourceRequest.sourceManifest.sha256,
          derivedManifestSha256:sourceRequest.derivedManifest.sha256,pipelineDigest:sourceRequest.sourceAttestation.proof.pipelineDigest,
          status:'queued',phase:'queued',sourceState:'retained',derivedState:'retained',sourceReceipt,derivedReceipt,
          sourceReceiptSha256:digest(sourceReceipt),derivedReceiptSha256:digest(derivedReceipt),sourceObjectReceipts:sourceReceipts,derivedObjectReceipts:[]};
      }
      return jsonResponse(completionResponse,201);
    }
    throw new Error(`unexpected V2 test request ${init.method||'GET'} ${route}`);
  };
  const createClient=()=>new SourceIntakeClientV2({origin:source.origin,bearerToken:'test-only-coordinator-token',environment:'staging',outbox,fetchImpl});
  client=createClient();
  const deps=()=>({processing:f.processing,storage:f.deps().storage,config:{referenceSourceIntake:source},providerCredentials:{},
    sourceIntake:{client,outbox,snapshotPublicKey:snapshotKeys.publicKey,snapshotSigner,attestationSigner},adapterFactory:()=>{adapterCalls++;throw new Error('V1 adapter must not be constructed');}});
  assert.equal(await processOne(deps(),'worker-v2-first'),true);
  let attempt=f.processing.getAttempt(f.attempt.id),job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(attempt.status,'queued_upstream');assert.equal(job.status,'pending');assert.equal(job.attempt_count,0);
  assert.equal(uploadCalls,1,JSON.stringify(f.processing.listLogs(f.attempt.id)));assert.equal(createCalls,1);assert.equal(adapterCalls,0);assert.equal(outbox.getIntent(f.attempt.id).state,'accepted');

  f.reopen();outbox=new PreparedSubmissionOutbox(f.db);client=createClient();f.db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  assert.equal(await processOne(deps(),'worker-v2-after-reopen'),true);
  attempt=f.processing.getAttempt(f.attempt.id);job=f.db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(f.job.id);
  assert.equal(attempt.status,'queued_upstream');assert.equal(job.status,'complete');assert.equal(job.attempt_count,1);
  assert.equal(uploadCalls,1,'accepted replay skips the already acknowledged source bytes');assert.equal(createCalls,1,'accepted replay does not POST a second job');
  assert.equal(completionCalls,1);assert.equal(adapterCalls,0);assert.equal(outbox.getIntent(f.attempt.id).sourceIntakeCanonical,requestBytes);
  assert.ok(f.db.prepare("SELECT 1 FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").get(f.attempt.id));
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
