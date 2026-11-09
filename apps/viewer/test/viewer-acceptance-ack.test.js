'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');
const {processOneViewerAcceptanceAck}=require('../server/viewerAcceptanceAckWorker');

const ACK={version:1,transport:'https',pathTemplate:'/task/{taskId}/viewer-acceptance'};
const uuid=()=>crypto.randomUUID();
function fixture(t,{ack=true,endpoint='https://node.example.test',ready=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-acceptance-ack-')),file=path.join(root,'viewer.sqlite');
  let db=openDatabase(file),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  t.after(()=>{try{db.close();}catch{}fs.rmSync(root,{recursive:true,force:true});});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'NodeODM',endpoint,enabled:true,capabilities:{viewerAcceptanceAck:ack?ACK:null,options:[]},capabilityFingerprint:crypto.createHash('sha256').update(String(ack)).digest('hex')});
  const project=processing.createProject({displayName:'ACK test'}),dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',rootKey:'datasets',relativePath:'ack-test'});
  const files=[{relativePath:'photo.jpg',byteSize:4,sha256:crypto.createHash('sha256').update('jpeg').digest('hex')}];
  processing.finalizeDataset(dataset.id,files,crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,createdBy:'test'});
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:'Task',status:'importing',assets:[{kind:'glb',rootKey:'models',relativePath:`${task.id}/${attempt.id}/model.glb`,sha256:'b'.repeat(64),published:false}],makeActive:false});
  const versionId=db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id,model.id,versionId);processing.transitionAttempt(attempt.id,'ingesting');
  processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:`${task.id}/${attempt.id}`,status:'staged',byteSize:1,assetCount:1});
  const archiveFiles=[{relativePath:'odm/dsm.tif',byteSize:1,sha256:'d'.repeat(64)}],archive={schemaVersion:1,attemptId:attempt.id,providerTaskId:attempt.providerTaskId,archiveSha256:'a'.repeat(64),archiveByteSize:1,archiveManifestSha256:crypto.createHash('sha256').update(JSON.stringify(archiveFiles)).digest('hex'),archiveFiles};
  db.prepare('INSERT INTO processing_attempt_transfer_provenance(attempt_id,initialization_json,archive_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(attempt.id,'{"state":"acknowledged"}',JSON.stringify(archive),new Date().toISOString(),new Date().toISOString());
  if(ready){const completed=processing.completeOutputForReview(attempt.id,{event:{eventId:`processing-ready-${attempt.id}`}});assert.equal(completed.status,'ready_for_review');}
  return{root,file,get db(){return db;},get processing(){return processing;},attempt,provider,archive,
    reopen(){db.close();db=openDatabase(file);processing=new ProcessingRepository(db);repository=new ViewerRepository(db);}};
}

test('provider advertises ACK only for the exact HTTPS contract and fingerprints the capability',async()=>{
  const info={version:'2.2.3',engine:'odm',engineVersion:'3.5',taskQueueCount:0,maxImages:500,viewerAcceptanceAck:ACK};
  const fetchImpl=async url=>new Response(JSON.stringify(String(url).endsWith('/info')?info:[]),{headers:{'content-type':'application/json'}});
  const tls=await new NodeOdmProvider({endpoint:'https://node.example.test',fetchImpl}).capabilities();
  assert.deepEqual(tls.capabilities.viewerAcceptanceAck,ACK);
  const plain=await new NodeOdmProvider({endpoint:'http://node.example.test',fetchImpl}).capabilities();
  assert.equal(plain.capabilities.viewerAcceptanceAck,null);
  assert.notEqual(tls.fingerprint,plain.fingerprint);
  info.viewerAcceptanceAck={...ACK,pathTemplate:'/task/{taskId}/delete'};
  assert.equal((await new NodeOdmProvider({endpoint:'https://node.example.test',fetchImpl}).capabilities()).capabilities.viewerAcceptanceAck,null);
});

test('ACK POST uses the pinned HTTPS route and rejects plaintext downgrade',async()=>{
  const taskId=uuid(),attemptId=uuid(),payload={eventId:`viewer-acceptance-${attemptId}`,providerTaskId:taskId,attemptId,archiveSha256:'a'.repeat(64),resultModelId:uuid(),resultModelVersionId:uuid(),ingestedAt:new Date().toISOString()};
  let observed;
  const provider=new NodeOdmProvider({endpoint:'https://node.example.test',token:'secret',fetchImpl:async(url,init)=>{observed={url:new URL(url),init};return new Response(JSON.stringify({accepted:true,eventId:payload.eventId}),{headers:{'content-type':'application/json'}});}});
  assert.equal((await provider.postViewerAcceptance(payload)).eventId,payload.eventId);
  assert.equal(observed.url.pathname,`/task/${taskId}/viewer-acceptance`);assert.equal(observed.url.searchParams.get('token'),'secret');assert.equal(observed.init.method,'POST');assert.deepEqual(JSON.parse(observed.init.body),payload);
  const plain=new NodeOdmProvider({endpoint:'http://node.example.test',fetchImpl:async()=>{throw new Error('must not fetch');}});
  await assert.rejects(plain.postViewerAcceptance(payload),{code:'viewer_acceptance_tls_required'});
});

test('final readiness atomically enqueues an immutable archive-bound ACK, while non-capable tasks do not',t=>{
  const c=fixture(t),rows=()=>c.db.prepare('SELECT * FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').all(c.attempt.id);
  assert.equal(rows().length,1);
  const item=c.processing.claimViewerAcceptanceAck('sender');
  assert.equal(item.status,'leased');assert.equal(item.payload.archiveSha256,c.archive.archiveSha256);assert.equal(item.payload.providerTaskId,c.attempt.providerTaskId);
  c.processing.updateProviderMetadata(c.provider.id,{endpoint:'https://replacement.example.test'});
  assert.equal(c.processing.claimViewerAcceptanceAck('second-sender'),null,'the existing lease stays owned');
  assert.equal(c.db.prepare('SELECT endpoint FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).endpoint,'https://node.example.test','the ACK route is pinned at final readiness');
  assert.equal(c.processing.workerWorkCounts().viewerAcceptanceAcks,1,'unaccepted receipts hold storage cleanup until delivery succeeds');
  assert.throws(()=>c.db.prepare('DELETE FROM viewer_acceptance_ack_outbox WHERE id=?').run(item.id),/viewer_acceptance_ack_retained/);
  const noAck=fixture(t,{ack:false});
  assert.equal(noAck.db.prepare('SELECT COUNT(*) n FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(noAck.attempt.id).n,0);
});

test('required derivative acceptance is queued only in the final-ready transaction',t=>{
  const c=fixture(t,{ready:false});
  c.processing.transitionAttempt(c.attempt.id,'derivatives');
  c.processing.enqueueDerivative(c.attempt.id,'ept');
  const job=c.processing.claimDerivative('derivative-worker');
  assert.ok(job);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).n,0);
  const ready=c.processing.completeDerivativeAndMaybeReady(job.id,'derivative-worker',{verified:true},{event:{eventId:`processing-ready-${c.attempt.id}`},leaseToken:job.lease_token});
  assert.equal(ready.ready,true);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).n,1);
});

test('lost ACK response retries the exact payload after database reopen and records acceptance',async t=>{
  const c=fixture(t),sent=[],credentials={resolve:id=>{assert.equal(id,c.provider.id);return'secret';}},deps={processing:c.processing,providerCredentials:credentials};
  const first=await processOneViewerAcceptanceAck(deps,'sender-one',{adapterFactory:()=>({postViewerAcceptance:async payload=>{sent.push(structuredClone(payload));throw Object.assign(new Error('response lost'),{code:'network_error'});}})});
  assert.equal(first,true);assert.equal(c.db.prepare('SELECT status FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).status,'pending');
  c.db.prepare('UPDATE viewer_acceptance_ack_outbox SET available_at=? WHERE attempt_id=?').run('2000-01-01T00:00:00.000Z',c.attempt.id);
  c.reopen();
  await processOneViewerAcceptanceAck({processing:c.processing,providerCredentials:credentials},'sender-two',{adapterFactory:()=>({postViewerAcceptance:async payload=>{sent.push(structuredClone(payload));return{accepted:true,eventId:payload.eventId};}})});
  assert.deepEqual(sent[1],sent[0]);
  assert.equal(c.db.prepare('SELECT status FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).status,'accepted');
  assert.equal(c.processing.workerWorkCounts().viewerAcceptanceAcks,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).n,1);
});

test('expired sender lease replays the retained payload after a simulated process restart',async t=>{
  const c=fixture(t),first=c.processing.claimViewerAcceptanceAck('crashed-worker',{leaseMs:5000}),sent=[];
  assert.ok(first);sent.push(structuredClone(first.payload));
  c.reopen();
  c.db.prepare("UPDATE viewer_acceptance_ack_outbox SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?").run(c.attempt.id);
  await processOneViewerAcceptanceAck({processing:c.processing,providerCredentials:{resolve:()=>''}},'restarted-worker',{adapterFactory:()=>({postViewerAcceptance:async payload=>{sent.push(structuredClone(payload));return{accepted:true,eventId:payload.eventId};}})});
  assert.deepEqual(sent[1],sent[0]);
  assert.equal(c.db.prepare('SELECT status FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(c.attempt.id).status,'accepted');
});
