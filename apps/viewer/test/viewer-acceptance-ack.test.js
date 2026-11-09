'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {deliverOneViewerAcceptanceAck}=require('../server/viewerAcceptanceAckDelivery');

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const marker={version:1,transport:'https',pathTemplate:'/task/{taskId}/viewer-acceptance'};
function fixture(t,{ready=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-ack-')),db=openDatabase(path.join(root,'db.sqlite'));
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),project=processing.createProject({displayName:'Ack test'}),dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',rootKey:'datasets',relativePath:'source'});
  const files=[{relativePath:'image.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'TLS test provider',endpoint:'https://192.168.50.89:18444',enabled:true,capabilities:{viewerAcceptanceAck:marker}}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id}),job=processing.claimJob('submit-owner');
  const inputFiles=[{relativePath:'odm_dem/dsm.tif',byteSize:4,sha256:sha('tiff')}],archiveReceipt={archiveSha256:sha('zip'),archiveFiles:inputFiles,archiveManifestSha256:sha(JSON.stringify(inputFiles))};
  db.prepare("UPDATE processing_jobs SET job_type='ingest' WHERE id=?").run(job.id);
  const receipt=processing.recordAttemptArchiveReceipt(job.id,'submit-owner',archiveReceipt);assert.ok(receipt);
  const model=repository.upsertModelVersion({provider:'nodeodm',providerModelId:attempt.providerTaskId,providerVersionId:attempt.id,displayName:'Task output',status:ready?'ready':'importing',assets:[],makeActive:false});
  const versionId=db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id,model.id,versionId);
  processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:`${task.id}/${attempt.id}`,status:ready?'ready':'staged',byteSize:4,assetCount:0});
  const now=new Date().toISOString();
  db.prepare('UPDATE processing_attempts SET status=?,result_model_id=?,result_model_version_id=?,ingested_at=?,updated_at=? WHERE id=?').run(ready?'ready_for_review':'ingesting',model.id,versionId,ready?now:null,now,attempt.id);
  db.prepare('UPDATE processing_tasks SET status=?,updated_at=? WHERE id=?').run(ready?'ready_for_review':'processing',now,task.id);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return{db,processing,provider,task,attempt,model,versionId,receipt};
}

test('ready transition and ACK enqueue commit together for a supported HTTPS provider',t=>{
  const f=fixture(t,{ready:false}),row=f.processing.getAttemptProvenance(f.attempt.id).submission;
  const ready=f.processing.completeOutputForReview(f.attempt.id,{event:{eventId:`processing-ready-${f.attempt.id}`}});
  assert.equal(ready.status,'ready_for_review');
  const ack=f.db.prepare('SELECT status,payload_json FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(f.attempt.id);
  assert.equal(ack.status,'pending');assert.equal(JSON.parse(ack.payload_json).archiveSha256,f.receipt.archiveSha256);
});

test('ACK enqueue is identity-stable, pins HTTPS endpoint and fails closed without marker or receipt',t=>{
  const f=fixture(t),row=f.processing.getAttemptProvenance(f.attempt.id).submission;
  delete row.capabilities.viewerAcceptanceAck;
  f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(row),f.attempt.id);
  assert.equal(f.processing.enqueueViewerAcceptanceAck(f.attempt),false,'historical capability snapshot has no opt-in marker');
  row.capabilities.viewerAcceptanceAck=marker;
  f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(row),f.attempt.id);
  f.db.prepare('UPDATE processing_attempt_transfer_provenance SET archive_json=NULL WHERE attempt_id=?').run(f.attempt.id);
  assert.equal(f.processing.enqueueViewerAcceptanceAck(f.attempt),false,'archive receipt is required');
  f.db.prepare('UPDATE processing_attempt_transfer_provenance SET archive_json=? WHERE attempt_id=?').run(JSON.stringify(f.receipt),f.attempt.id);
  const originalEndpoint=row.providerEndpoint;row.providerEndpoint='http://192.168.50.89:3005';
  f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(row),f.attempt.id);
  assert.equal(f.processing.enqueueViewerAcceptanceAck(f.attempt),false,'original provider transport must be HTTPS');
  row.providerEndpoint=originalEndpoint;f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(row),f.attempt.id);
  f.db.prepare('UPDATE processing_providers SET endpoint=? WHERE id=?').run('https://replacement.example.test',f.provider.id);
  assert.equal(f.processing.enqueueViewerAcceptanceAck(f.attempt),true);
  const queued=f.db.prepare('SELECT * FROM viewer_acceptance_ack_outbox WHERE attempt_id=?').get(f.attempt.id);
  const payload=JSON.parse(queued.payload_json);
  assert.equal(queued.provider_endpoint,'https://192.168.50.89:18444');
  assert.deepEqual(payload,{eventId:queued.event_id,providerTaskId:f.attempt.providerTaskId,attemptId:f.attempt.id,archiveSha256:f.receipt.archiveSha256,resultModelId:f.model.id,resultModelVersionId:f.versionId,ingestedAt:f.processing.getAttempt(f.attempt.id).ingestedAt});
  assert.equal(f.processing.enqueueViewerAcceptanceAck(f.attempt),true,'exact duplicate enqueue is idempotent');
  assert.throws(()=>f.db.prepare('UPDATE viewer_acceptance_ack_outbox SET payload_json=? WHERE attempt_id=?').run('{}',f.attempt.id),/immutable/i);
});

test('ACK delivery retries offline across worker ownership with the same id and body',async t=>{
  const f=fixture(t);
  f.processing.enqueueViewerAcceptanceAck(f.attempt);
  const bodies=[],keys=[];let calls=0;
  const fetchImpl=async(url,init)=>{assert.equal(url.protocol,'https:');assert.equal(url.origin,'https://192.168.50.89:18444');assert.equal(url.pathname,`/task/${f.attempt.providerTaskId}/viewer-acceptance`);assert.equal(url.searchParams.get('token'),'test-token');calls++;bodies.push(init.body);keys.push(init.headers['Idempotency-Key']);if(calls===1)throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});return new Response(null,{status:202});};
  const credentials={resolve:id=>{assert.equal(id,f.provider.id);return'test-token';}};
  assert.equal(await deliverOneViewerAcceptanceAck(f.processing,credentials,'worker-before-restart',fetchImpl),true);
  let state=f.db.prepare('SELECT status,attempt_count,last_error_code FROM viewer_acceptance_ack_outbox').get();
  assert.equal(state.status,'pending');assert.equal(state.attempt_count,1);assert.equal(state.last_error_code,'ECONNREFUSED');
  f.db.prepare("UPDATE viewer_acceptance_ack_outbox SET available_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal(await deliverOneViewerAcceptanceAck(f.processing,credentials,'worker-after-restart',fetchImpl),true);
  state=f.db.prepare('SELECT status,attempt_count,delivered_at FROM viewer_acceptance_ack_outbox').get();
  assert.equal(state.status,'delivered');assert.equal(state.attempt_count,2);assert.ok(state.delivered_at);
  assert.equal(bodies[0],bodies[1]);assert.equal(keys[0],keys[1]);assert.equal(keys[0],JSON.parse(bodies[0]).eventId);
});

test('server commit with lost response retries the exact event and accepts duplicate 200',async t=>{
  const f=fixture(t);
  f.processing.enqueueViewerAcceptanceAck(f.attempt);
  const committed=new Map(),seen=[];let calls=0;
  const fetchImpl=async(url,init)=>{assert.equal(url.protocol,'https:');assert.equal(url.searchParams.get('token'),'test-token');const payload=JSON.parse(init.body),id=init.headers['Idempotency-Key'];seen.push([id,init.body]);if(committed.has(id)){assert.equal(committed.get(id),init.body);return new Response(null,{status:200});}committed.set(id,init.body);calls++;throw Object.assign(new Error('response lost'),{code:'ECONNRESET'});};
  const credentials={resolve:()=> 'test-token'};
  await deliverOneViewerAcceptanceAck(f.processing,credentials,'first-worker',fetchImpl);
  f.db.prepare("UPDATE viewer_acceptance_ack_outbox SET available_at='2000-01-01T00:00:00.000Z'").run();
  await deliverOneViewerAcceptanceAck(f.processing,credentials,'restarted-worker',fetchImpl);
  assert.equal(calls,1);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);
  assert.equal(f.db.prepare('SELECT status FROM viewer_acceptance_ack_outbox').get().status,'delivered');
});

test('sender fails closed on a corrupted ACK payload',async t=>{
  const f=fixture(t),fetchImpl=async()=>{throw new Error('must not send a corrupt payload');};
  f.processing.enqueueViewerAcceptanceAck(f.attempt);
  f.db.exec('DROP TRIGGER viewer_acceptance_ack_identity_immutable');
  const row=f.db.prepare('SELECT payload_json FROM viewer_acceptance_ack_outbox').get(),payload=JSON.parse(row.payload_json);
  payload.archiveSha256=sha('tampered');f.db.prepare('UPDATE viewer_acceptance_ack_outbox SET payload_json=?').run(JSON.stringify(payload));
  await deliverOneViewerAcceptanceAck(f.processing,{resolve:()=> 'test-token'},'corrupt-worker',fetchImpl);
  const state=f.db.prepare('SELECT status,last_error_code FROM viewer_acceptance_ack_outbox').get();
  assert.equal(state.status,'pending');assert.equal(state.last_error_code,'payload_identity_mismatch');
});
