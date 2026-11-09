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
  const fetchImpl=async(url,init)=>{assert.equal(url.protocol,'https:');assert.equal(url.origin,'https://192.168.50.89:18444');assert.equal(url.pathname,`/task/${f.attempt.providerTaskId}/viewer-acceptance`);assert.equal(url.searchParams.get('token'),'test-token');calls++;bodies.push(init.body);keys.push(init.headers['Idempotency-Key']);if(calls===1)throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});return new Response(JSON.stringify({accepted:true,replayed:false,eventId:JSON.parse(init.body).eventId}),{status:202,headers:{'content-type':'application/json'}});};
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
  const fetchImpl=async(url,init)=>{assert.equal(url.protocol,'https:');assert.equal(url.searchParams.get('token'),'test-token');const payload=JSON.parse(init.body),id=init.headers['Idempotency-Key'];seen.push([id,init.body]);if(committed.has(id)){assert.equal(committed.get(id),init.body);return new Response(JSON.stringify({accepted:true,replayed:true,eventId:id}),{status:200,headers:{'content-type':'application/json'}});}committed.set(id,init.body);calls++;throw Object.assign(new Error('response lost'),{code:'ECONNRESET'});};
  const credentials={resolve:()=> 'test-token'};
  await deliverOneViewerAcceptanceAck(f.processing,credentials,'first-worker',fetchImpl);
  f.db.prepare("UPDATE viewer_acceptance_ack_outbox SET available_at='2000-01-01T00:00:00.000Z'").run();
  await deliverOneViewerAcceptanceAck(f.processing,credentials,'restarted-worker',fetchImpl);
  assert.equal(calls,1);assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);
  assert.equal(f.db.prepare('SELECT status FROM viewer_acceptance_ack_outbox').get().status,'delivered');
});

test('empty or mismatched 2xx ACK responses remain retryable',async t=>{
  const f=fixture(t);
  f.processing.enqueueViewerAcceptanceAck(f.attempt);
  const fetchImpl=async()=>new Response(JSON.stringify({accepted:true,replayed:false,eventId:'wrong-event'}),{status:202,headers:{'content-type':'application/json'}});
  await deliverOneViewerAcceptanceAck(f.processing,{resolve:()=> 'test-token'},'invalid-response-worker',fetchImpl);
  let state=f.db.prepare('SELECT status,attempt_count,last_error_code FROM viewer_acceptance_ack_outbox').get();
  assert.equal(state.status,'pending');assert.equal(state.last_error_code,'invalid_ack_response');
  f.db.prepare("UPDATE viewer_acceptance_ack_outbox SET available_at='2000-01-01T00:00:00.000Z'").run();
  await deliverOneViewerAcceptanceAck(f.processing,{resolve:()=> 'test-token'},'empty-response-worker',async()=>new Response(null,{status:202}));
  state=f.db.prepare('SELECT status,attempt_count,last_error_code FROM viewer_acceptance_ack_outbox').get();
  assert.equal(state.status,'pending');assert.equal(state.attempt_count,2);assert.equal(state.last_error_code,'invalid_ack_response');
});

test('v42 preserves canonical v41 ACK rows and adds a retained-row delete guard',t=>{
  const f=fixture(t),now='2026-11-09T21:00:00.000Z';
  f.db.exec(`DROP TRIGGER IF EXISTS viewer_acceptance_ack_identity_immutable;
    DROP TRIGGER IF EXISTS viewer_acceptance_ack_identity_immutable_v42;
    DROP TRIGGER IF EXISTS viewer_acceptance_ack_no_delete_v42;
    DROP INDEX IF EXISTS viewer_acceptance_ack_claim_idx;
    DROP INDEX IF EXISTS viewer_acceptance_ack_claim_v42_idx;
    DROP TABLE viewer_acceptance_ack_outbox;
    DELETE FROM schema_migrations WHERE version=42;
    CREATE TABLE viewer_acceptance_ack_outbox (
      event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
      task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
      provider_id TEXT NOT NULL REFERENCES processing_providers(id) ON DELETE RESTRICT,
      provider_endpoint TEXT NOT NULL, provider_task_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered')), attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, last_error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT);
    CREATE INDEX viewer_acceptance_ack_claim_idx ON viewer_acceptance_ack_outbox(status,available_at,lease_expires_at);
    CREATE TRIGGER viewer_acceptance_ack_identity_immutable
      BEFORE UPDATE OF event_id,attempt_id,task_id,provider_id,provider_endpoint,provider_task_id,payload_json
      ON viewer_acceptance_ack_outbox
      BEGIN SELECT RAISE(ABORT,'Viewer acceptance acknowledgement identity is immutable'); END;`);
  const payload={eventId:'ack-canonical-v41',attemptId:f.attempt.id,archiveSha256:sha('archive')};
  const expected={event_id:payload.eventId,attempt_id:f.attempt.id,task_id:f.task.id,provider_id:f.provider.id,
    provider_endpoint:'https://provider.example.test',provider_task_id:f.attempt.providerTaskId,
    payload_json:JSON.stringify(payload),status:'delivered',attempt_count:3,available_at:now,lease_owner:null,
    lease_expires_at:null,last_error_code:null,created_at:now,updated_at:now,delivered_at:now};
  f.db.prepare(`INSERT INTO viewer_acceptance_ack_outbox
    (event_id,attempt_id,task_id,provider_id,provider_endpoint,provider_task_id,payload_json,status,attempt_count,
      available_at,lease_owner,lease_expires_at,last_error_code,created_at,updated_at,delivered_at)
    VALUES (@event_id,@attempt_id,@task_id,@provider_id,@provider_endpoint,@provider_task_id,@payload_json,@status,
      @attempt_count,@available_at,@lease_owner,@lease_expires_at,@last_error_code,@created_at,@updated_at,@delivered_at)`)
    .run(expected);
  f.db.prepare("UPDATE schema_migrations SET name='viewer_acceptance_ack_outbox' WHERE version=41").run();
  const {applyMigrations}=require('../server/database');
  applyMigrations(f.db);
  assert.deepEqual({...f.db.prepare('SELECT * FROM viewer_acceptance_ack_outbox WHERE event_id=?').get(expected.event_id)},expected);
  assert.throws(()=>f.db.prepare('DELETE FROM viewer_acceptance_ack_outbox WHERE event_id=?').run(expected.event_id),/retained/i);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM viewer_acceptance_ack_outbox').get().count,1);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('v42 migrates retained v41 outbox rows without dropping the legacy record',t=>{
  const f=fixture(t),secondTask=f.processing.createTask({projectId:f.task.projectId,datasetId:f.task.datasetId,displayName:'Second task'});
  const secondAttempt=f.processing.createAttempt({taskId:secondTask.id,providerId:f.provider.id});
  const attempts=[f.attempt,secondAttempt],now='2026-11-09T20:00:00.000Z';
  f.db.exec(`DROP TRIGGER IF EXISTS viewer_acceptance_ack_identity_immutable;
    DROP TRIGGER IF EXISTS viewer_acceptance_ack_identity_immutable_v42;
    DROP TRIGGER IF EXISTS viewer_acceptance_ack_no_delete_v42;
    DROP INDEX IF EXISTS viewer_acceptance_ack_claim_idx;
    DROP INDEX IF EXISTS viewer_acceptance_ack_claim_v42_idx;
    DROP TABLE viewer_acceptance_ack_outbox;
    DELETE FROM schema_migrations WHERE version=42;
    CREATE TABLE viewer_acceptance_ack_outbox (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
      provider_id TEXT NOT NULL REFERENCES processing_providers(id) ON DELETE RESTRICT, endpoint TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
      status TEXT NOT NULL CHECK(status IN ('pending','leased','accepted')), attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
      available_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, last_error_code TEXT, accepted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX viewer_acceptance_ack_due_idx ON viewer_acceptance_ack_outbox(status,available_at,created_at,id);
    CREATE TRIGGER viewer_acceptance_ack_identity_immutable BEFORE UPDATE OF attempt_id,provider_id,endpoint,payload_json,payload_sha256 ON viewer_acceptance_ack_outbox
      BEGIN SELECT RAISE(ABORT,'viewer_acceptance_ack_identity_immutable'); END;
    CREATE TRIGGER viewer_acceptance_ack_no_delete BEFORE DELETE ON viewer_acceptance_ack_outbox
      BEGIN SELECT RAISE(ABORT,'viewer_acceptance_ack_retained'); END;`);
  const insert=f.db.prepare(`INSERT INTO viewer_acceptance_ack_outbox
    (id,attempt_id,provider_id,endpoint,payload_json,payload_sha256,status,attempt_count,available_at,lease_owner,lease_expires_at,last_error_code,accepted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(let i=0;i<attempts.length;i++){
    const attempt=attempts[i],payload={eventId:`viewer-acceptance-${attempt.id}`,providerTaskId:attempt.providerTaskId,attemptId:attempt.id,archiveSha256:sha('archive'),resultModelId:'legacy-model',resultModelVersionId:'legacy-version',ingestedAt:now};
    const payloadJson=JSON.stringify(payload),accepted=i===0;
    insert.run(payload.eventId,attempt.id,f.provider.id,'https://provider.example.test',payloadJson,sha(payloadJson),accepted?'accepted':'pending',2,now,null,null,null,accepted?now:null,now,now);
  }
  f.db.prepare("UPDATE schema_migrations SET name='durable_viewer_acceptance_ack_outbox' WHERE version=41").run();
  const {applyMigrations}=require('../server/database');
  applyMigrations(f.db);
  const rows=f.db.prepare('SELECT event_id,attempt_id,task_id,provider_id,provider_endpoint,provider_task_id,payload_json,status,delivered_at FROM viewer_acceptance_ack_outbox ORDER BY event_id').all();
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.status).sort(),['delivered','pending']);
  assert.equal(rows.find(row=>row.status==='delivered').delivered_at,now);
  assert.ok(rows.every(row=>row.task_id&&row.provider_task_id&&row.provider_endpoint==='https://provider.example.test'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM viewer_acceptance_ack_outbox_v41_legacy').get().count,2);
  assert.throws(()=>f.db.prepare('DELETE FROM viewer_acceptance_ack_outbox_v41_legacy').run(),/retained/i);
  assert.throws(()=>f.db.prepare('DELETE FROM viewer_acceptance_ack_outbox').run(),/retained/i);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
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
