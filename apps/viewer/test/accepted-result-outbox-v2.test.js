'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {PreparedSubmissionOutbox,PROTOCOL,canonicalizeJcs}=require('../server/preparedSubmissionOutbox');
const {SourceIntakeClientV2}=require('../server/sourceIntakeClientV2');
const {processIngest}=require('../server/processingWorker');
const ReferenceProtocol=require('../server/referenceProtocol');
const {createViewerReceiptV2SignerCandidate}=require('../server/referenceReceiptV2Candidate');

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const id=()=>crypto.randomUUID();

test('lost V2 acceptance response replays exact bytes after restart and only the durable ACK schedules ingest',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-copy-outbox-v2-'));
  const dbPath=path.join(root,'viewer.sqlite');let db=openDatabase(dbPath),processing=new ProcessingRepository(db);
  let outbox=new PreparedSubmissionOutbox(db);
  t.after(()=>{try{db.close();}catch{}fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Accepted copy test'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic source',storageMode:'managed',rootKey:'datasets'});
  const sourceHash=sha(Buffer.from('photo'));
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:5,sha256:sourceHash}],sha(Buffer.from('dataset')));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Processing coordinator',endpoint:'https://processing.example',enabled:true});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Copy task'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,capabilityFingerprint:'capability'});
  const submit=processing.claimJob('submit-owner');
  const authorityId='11111111-1111-4111-8111-111111111111',principal='viewer-staging';
  const envelope={schemaVersion:3,protocol:PROTOCOL,submission:{schemaVersion:1,submissionId:attempt.id,
    manifest:{sha256:'a'.repeat(64)},pipeline:{odm:{requested:true,options:{},optionsFingerprint:'b'.repeat(64)}},capabilityFingerprint:'c'.repeat(64)},
    viewerTaskId:task.id,viewerAttemptId:attempt.id,activationId:id()};
  let intent=outbox.persistIntent({localJobId:submit.id,owner:submit.lease_owner,origin:'https://processing.example',
    authorityId,principalId:principal,environment:'staging',envelope});
  const sourceObject={id:'source-photo',name:'photo.jpg',byteSize:5,sha256:sourceHash,sourceType:'raw_input',
    retentionClass:'release_after_acceptance',retentionHoldId:null};
  const sourceManifest={sha256:'d'.repeat(64),objects:[sourceObject]};
  const derivedManifest={sha256:'e'.repeat(64),objects:[]};
  const pipelineManifest={sha256:'a'.repeat(64),objects:[]};
  const proof={submissionId:attempt.id,viewerAttemptId:attempt.id,viewerTaskId:task.id,providerTaskId:attempt.providerTaskId,
    preparedEnvelopeSha256:intent.envelopeSha256,activationId:envelope.activationId,sourceManifestSha256:sourceManifest.sha256,
    derivedManifestSha256:derivedManifest.sha256,pipelineManifestSha256:pipelineManifest.sha256,pipelineDigest:'f'.repeat(64)};
  const proofBytes=Buffer.concat([Buffer.from('ltds-preclaim-source-attestation-v2\0','ascii'),canonicalizeJcs(proof)]);
  const sourceRequest={schemaVersion:2,submissionId:attempt.id,viewerTaskId:task.id,providerTaskId:attempt.providerTaskId,
    manifest:pipelineManifest,pipeline:envelope.submission.pipeline,capabilityFingerprint:envelope.submission.capabilityFingerprint,
    sourceManifest,derivedManifest,sourceAttestation:{proof,signature:'A'.repeat(86),attestationSha256:sha(proofBytes)}};
  const sourceBytes=canonicalizeJcs(sourceRequest).toString('utf8');
  outbox.persistSourceIntakeRequest(attempt.id,sourceBytes,{localJobId:submit.id,owner:submit.lease_owner});
  const binding={protocol:'ltds-viewer-source-intake-binding-v2',coordinatorAuthorityId:authorityId,jobId:attempt.providerTaskId,
    attemptId:attempt.id,providerTaskId:attempt.providerTaskId,generation:1,environment:'staging',manifestSha256:pipelineManifest.sha256,
    pipelineManifestSha256:pipelineManifest.sha256,sourceManifestSha256:sourceManifest.sha256,
    derivedManifestSha256:derivedManifest.sha256,pipelineDigest:proof.pipelineDigest,requestSha256:'9'.repeat(64)};
  outbox.acceptSourceIntakeBinding(attempt.id,{jobId:binding.jobId,attemptId:binding.attemptId,providerTaskId:binding.providerTaskId,
    generation:1,environment:'staging',manifestSha256:binding.manifestSha256,pipelineManifestSha256:binding.pipelineManifestSha256,
    sourceManifestSha256:binding.sourceManifestSha256,derivedManifestSha256:binding.derivedManifestSha256,pipelineDigest:binding.pipelineDigest,
    status:'queued',phase:'source_receiving',sourceState:'receiving',derivedState:'receiving',sourceReceipt:null,derivedReceipt:null,
    sourceReceiptSha256:null,derivedReceiptSha256:null},{environment:'staging',localJobId:submit.id,owner:submit.lease_owner});
  const sourceReceipt={schemaVersion:2,receiptType:'source_retention',receiptId:id(),storageReceiptId:id(),jobId:binding.jobId,
    attemptId:attempt.id,generation:1,environment:'staging',pipelineManifestSha256:pipelineManifest.sha256,
    sourceManifestSha256:sourceManifest.sha256,pipelineDigest:proof.pipelineDigest,
    objects:[{id:sourceObject.id,byteSize:sourceObject.byteSize,sha256:sourceObject.sha256,sourceType:sourceObject.sourceType,
      retentionClass:sourceObject.retentionClass,retentionHoldId:null}],retainedAt:'2026-11-04T20:00:00.000Z',
    retentionGuarantee:'until_explicit_source_release_v1'};
  const derivedReceipt={schemaVersion:1,receiptType:'attempt_derived_input',receiptId:id(),jobId:binding.jobId,attemptId:attempt.id,
    generation:1,environment:'staging',derivedManifestSha256:derivedManifest.sha256,objects:[],retainedAt:'2026-11-04T20:00:00.000Z'};
  const completion={jobId:binding.jobId,attemptId:attempt.id,providerTaskId:binding.providerTaskId,generation:1,environment:'staging',
    pipelineManifestSha256:pipelineManifest.sha256,sourceManifestSha256:sourceManifest.sha256,derivedManifestSha256:derivedManifest.sha256,
    pipelineDigest:proof.pipelineDigest,status:'queued',phase:'queued',sourceState:'retained',derivedState:'retained',sourceReceipt,derivedReceipt,
    sourceReceiptSha256:sha(canonicalizeJcs(sourceReceipt)),derivedReceiptSha256:sha(canonicalizeJcs(derivedReceipt))};
  outbox.persistSourceIntakeCompletion(attempt.id,completion,{environment:'staging',localJobId:submit.id,owner:submit.lease_owner});
  db.prepare("UPDATE processing_jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),submit.id);
  db.prepare("UPDATE processing_attempts SET status='queued_upstream' WHERE id=?").run(attempt.id);
  db.prepare("UPDATE processing_tasks SET status='queued' WHERE id=?").run(task.id);
  const now=new Date().toISOString(),reconcileId=id(),reconcileOwner='reconcile-owner';
  db.prepare(`INSERT INTO processing_jobs(id,attempt_id,job_type,status,lease_owner,lease_expires_at,heartbeat_at,attempt_count,available_at,created_at,updated_at)
    VALUES (?,?,'reconcile','leased',?,?,NULL,1,?,?,?)`).run(reconcileId,attempt.id,reconcileOwner,new Date(Date.now()+60_000).toISOString(),now,now,now);
  const resultManifest={schemaVersion:1,jobId:binding.jobId,generation:1,environment:'staging',pipelineDigest:proof.pipelineDigest,
    engineVersions:{odm:'synthetic-1'},objects:[{id:'archive-result',role:'odm_archive',byteSize:3,sha256:sha(Buffer.from('zip'))}]};
  resultManifest.resultManifestSha256=ReferenceProtocol.resultManifestSha256(resultManifest);
  const acceptance={schemaVersion:1,receiptId:id(),storageReceiptId:id(),jobId:binding.jobId,generation:1,environment:'staging',
    inputManifestSha256:pipelineManifest.sha256,pipelineDigest:proof.pipelineDigest,resultManifestSha256:resultManifest.resultManifestSha256,
    acceptedObjectIds:['archive-result'],acceptedAt:'2026-11-04T20:01:00.000Z',validationVersion:ReferenceProtocol.PROTOCOL};
  const keys=crypto.generateKeyPairSync('ed25519'),privateKeyPem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  const signer=createViewerReceiptV2SignerCandidate({issuerId:'viewer-copy-test',keyId:'copy-v2-test',privateKeyPem,
    clock:()=>new Date('2026-11-04T20:01:01.000Z'),idFactory:(()=>{const values=[id(),id()];let i=0;return()=>values[i++];})()});
  const expected={coordinatorAuthorityId:authorityId,viewerPrincipalId:principal,submissionId:attempt.id,activationId:envelope.activationId,
    viewerTaskId:task.id,viewerAttemptId:attempt.id,providerTaskId:binding.jobId,preparedEnvelopeSha256:intent.envelopeSha256,
    jobId:binding.jobId,generation:1,environment:'staging',inputManifestSha256:pipelineManifest.sha256,pipelineDigest:proof.pipelineDigest,
    resultManifestSha256:resultManifest.resultManifestSha256,sourceManifestSha256:sourceManifest.sha256,
    derivedManifestSha256:derivedManifest.sha256,sourceReceiptSha256:completion.sourceReceiptSha256,derivedReceiptSha256:completion.derivedReceiptSha256};
  const viewerReceipt=signer({expected,acceptance,resultManifest});
  const copyRequest={acceptance,viewerReceipt};
  const leaseContext={environment:'staging',localJobId:reconcileId,owner:reconcileOwner,issuerId:'viewer-copy-test',keyId:'copy-v2-test',publicKeyPem};
  assert.throws(()=>outbox.persistAcceptedResultRequest(attempt.id,resultManifest,{acceptance,viewerReceipt:{...viewerReceipt,signature:'A'.repeat(86)}},leaseContext),
    {code:'source_intake_copy_signature_invalid'});
  assert.throws(()=>outbox.persistAcceptedResultRequest(attempt.id,resultManifest,{acceptance,viewerReceipt:{...viewerReceipt,issuerId:'wrong-issuer'}},leaseContext),
    {code:'source_intake_copy_binding_invalid'});
  intent=outbox.persistAcceptedResultRequest(attempt.id,resultManifest,copyRequest,leaseContext);
  assert.equal(intent.resultManifestCanonical,canonicalizeJcs(resultManifest).toString('utf8'));
  const response={job:{jobId:binding.jobId,generation:1,environment:'staging',phase:'completed',status:'succeeded'},created:true,
    fullyAccepted:true,acceptedObjectIds:['archive-result'],viewerReceipt};
  const postedBodies=[];let persistedRemoteResponse=null;
  const fetchImpl=async(_url,init)=>{
    postedBodies.push(init.body);
    if(postedBodies.length===1){persistedRemoteResponse=response;throw new Error('server committed acceptance but response was lost');}
    assert.equal(init.body,postedBodies[0]);
    return new Response(JSON.stringify(persistedRemoteResponse),{status:200,headers:{'content-type':'application/json'}});
  };
  const firstClient=new SourceIntakeClientV2({origin:'https://processing.example',bearerToken:'test-token',environment:'staging',outbox,fetchImpl});
  await assert.rejects(firstClient.postAcceptedResultCopy(binding,intent.copyRequestCanonical),{code:'source_intake_transport_uncertain'});
  assert.equal(outbox.getIntent(attempt.id).copyAckCanonical,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(attempt.id).n,0);
  await assert.rejects(processIngest({attempt_id:attempt.id},{processing,config:{referenceSourceIntake:{enabled:true,providerId:provider.id,origin:provider.endpoint}},
    storage:{space(){assert.fail('ingest must not inspect storage before an accepted ACK');}},sourceIntake:{outbox}}),
  {code:'source_intake_copy_ack_unavailable'});

  db.close();db=openDatabase(dbPath);processing=new ProcessingRepository(db);outbox=new PreparedSubmissionOutbox(db);
  const recovered=outbox.getIntent(attempt.id);
  assert.equal(recovered.copyRequestCanonical,canonicalizeJcs(copyRequest).toString('utf8'));
  assert.deepEqual(JSON.parse(recovered.copyRequestCanonical),copyRequest);
  const restartedClient=new SourceIntakeClientV2({origin:'https://processing.example',bearerToken:'test-token',environment:'staging',outbox,fetchImpl});
  const replayedResponse=await restartedClient.postAcceptedResultCopy(binding,recovered.copyRequestCanonical);
  assert.equal(postedBodies.length,2);
  assert.equal(postedBodies[0],postedBodies[1]);
  outbox.persistAcceptedResultAck(attempt.id,replayedResponse,leaseContext);
  assert.equal(outbox.getIntent(attempt.id).copyAckCanonical,canonicalizeJcs(response).toString('utf8'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(attempt.id).n,0,
    'a restart after durable ACK but before enqueue must remain recoverable without premature ingest');

  db.close();db=openDatabase(dbPath);processing=new ProcessingRepository(db);outbox=new PreparedSubmissionOutbox(db);
  const afterAckRestart=outbox.getIntent(attempt.id);
  assert.ok(afterAckRestart.copyAckCanonical);
  assert.equal(processing.advanceReconcileJob(reconcileId,reconcileOwner,{status:'completed',uuid:attempt.providerTaskId},new Date().toISOString()),true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(attempt.id).n,1);
  assert.equal(processing.getAttempt(attempt.id).status,'ingesting');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM model_outputs WHERE attempt_id=? AND status IN ('ready','published')").get(attempt.id).n,0,
    'scheduling ingest does not make a model ready');
});
