'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {inputInventory}=require('../server/processingProvenance');
const {processSubmit,processOne}=require('../server/processingWorker');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
test('snapshot retention fails closed on direct deletion and parent deletion or replacement',()=>{
 const {DatabaseSync}=require('node:sqlite'),{MIGRATIONS}=require('../server/database'),db=new DatabaseSync(':memory:');
 try{db.exec("PRAGMA foreign_keys=ON; CREATE TABLE processing_attempts(id TEXT PRIMARY KEY,task_id TEXT,attempt_number INTEGER,dataset_id TEXT,provider_id TEXT,provider_task_id TEXT,options_json TEXT,capability_fingerprint TEXT,reservation_required INTEGER,UNIQUE(task_id,attempt_number),UNIQUE(provider_id,provider_task_id)); INSERT INTO processing_attempts(id,task_id,attempt_number,provider_id,provider_task_id) VALUES('a','t',1,'p','uuid'),('b','t',2,'p','other')");db.exec(MIGRATIONS.find(m=>m.version===54).sql);db.exec("INSERT INTO processing_initialization_snapshots VALUES('a','{}','hash','t')");assert.throws(()=>db.exec("DELETE FROM processing_initialization_snapshots WHERE attempt_id='a'"),/retained/);assert.throws(()=>db.exec("DELETE FROM processing_attempts WHERE id='a'"),/parent retained/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO processing_attempts(id) VALUES('a')"),/parent replacement/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO processing_attempts(id,task_id,attempt_number) VALUES('c','t',1)"),/parent replacement/);assert.throws(()=>db.exec("INSERT OR REPLACE INTO processing_attempts(id,provider_id,provider_task_id) VALUES('c','p','uuid')"),/parent replacement/);assert.throws(()=>db.exec("UPDATE OR REPLACE processing_attempts SET attempt_number=1 WHERE id='b'"),/parent replacement/);assert.equal(db.prepare('SELECT COUNT(*) n FROM processing_initialization_snapshots').get().n,1)}finally{db.close()}
});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'transfer-proof-')),db=openDatabase(path.join(root,'db.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'P'}),dataset=processing.createDataset({projectId:project.id,displayName:'D',rootKey:'datasets',relativePath:'data'});
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','a.jpg'),'jpeg');
  const files=[{relativePath:'a.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'T'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id}),job=processing.claimJob('owner');
  const storage={resolve:(_key,relative)=>path.join(root,relative),requireProcessingHeadroom:()=>{}};
  return{db,processing,dataset,attempt,job,storage,root};
}
function archive(f){
  f.processing.recordAttemptProviderResult(f.job.id,'owner',{uuid:f.attempt.providerTaskId,status:'completed'});
  f.processing.setSubmissionStateForJob(f.job.id,'owner','committed',1);
  f.db.prepare("UPDATE processing_jobs SET job_type='ingest' WHERE id=?").run(f.job.id);
  const archiveFiles=[{relativePath:'odm_dem/dsm.tif',byteSize:4,sha256:sha('tiff')}];
  return{archiveSha256:sha('zip'),archiveFiles,archiveManifestSha256:sha(JSON.stringify(archiveFiles))};
}
test('pre-send initialization snapshot survives reopen and keeps the original name after rename',t=>{
 const f=fixture(t),first=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});
 assert.equal(first.requestSnapshot.request.name,'T');assert.equal(first.requestSnapshot.request.uuid,f.attempt.providerTaskId);
 assert.equal(f.processing.beginAttemptInitialization(f.job.id,'wrong',{freshTaskMissing:true,captureRequest:true}),null);
 f.processing.updateTaskMetadata(f.attempt.taskId,{displayName:'Renamed'});
 const reopened=openDatabase(path.join(f.root,'db.sqlite'));try{const again=new ProcessingRepository(reopened).getInitializationSnapshot(f.attempt.id);assert.deepEqual(again,first.requestSnapshot)}finally{reopened.close()}
 const replay=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});assert.equal(replay.requestSnapshot.request.name,'T');assert.equal(replay.ambiguous,true);
 assert.throws(()=>f.db.prepare('UPDATE processing_initialization_snapshots SET snapshot_json=? WHERE attempt_id=?').run('{}',f.attempt.id),/immutable/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO processing_initialization_snapshots SELECT * FROM processing_initialization_snapshots WHERE attempt_id=?').run(f.attempt.id),/replacement/);
 assert.throws(()=>f.db.prepare('DELETE FROM processing_initialization_snapshots WHERE attempt_id=?').run(f.attempt.id),/retained/);
 assert.throws(()=>f.db.prepare('UPDATE processing_attempts SET capability_fingerprint=? WHERE id=?').run('changed',f.attempt.id),/parent identity/);
 assert.throws(()=>f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id),/parent identity/);
});
test('pre-send initialization snapshot refuses a changed provider origin or attempt options',t=>{
 for(const kind of ['origin','options']){const f=fixture(t);f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});
  if(kind==='origin')f.db.prepare('UPDATE processing_providers SET endpoint=? WHERE id=?').run('https://other.example',f.attempt.providerId);
  else {assert.throws(()=>f.db.prepare("UPDATE processing_attempts SET options_json='{\"changed\":true}' WHERE id=?").run(f.attempt.id),/parent identity/);continue;}
  assert.throws(()=>f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true}),{code:'initialization_snapshot_invalid'});
 }
});
test('pre-send snapshot binds sealed reservation without storing its capability',t=>{
 const f=fixture(t),secret='opaque-capability-not-for-persistence';
 f.processing.ensureAttemptReservation(f.job.id,'owner',()=>({keyId:'key-a',ciphertext:secret}));
 const value=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true}).requestSnapshot;
 assert.equal(value.reservationBinding.keyId,'key-a');assert.equal(value.reservationBinding.ciphertextSha256,sha(secret));assert.ok(!JSON.stringify(value).includes(secret));
 f.db.prepare('UPDATE processing_attempt_reservations SET capability_ciphertext=? WHERE attempt_id=?').run('different',f.attempt.id);
 assert.throws(()=>f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true}),{code:'initialization_snapshot_invalid'});
});
test('actual attempt unique keys cannot replace a snapshotted parent without recursive triggers',t=>{
 const f=fixture(t);f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});f.db.exec('PRAGMA recursive_triggers=OFF');
 const insert=f.db.prepare("INSERT OR REPLACE INTO processing_attempts(id,task_id,dataset_id,attempt_number,provider_id,provider_task_id,options_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','failed','t','t')");
 assert.throws(()=>insert.run('other-a',f.attempt.taskId,f.attempt.datasetId,f.attempt.attemptNumber,null,null),/parent replacement/);
 assert.throws(()=>insert.run('other-b',f.attempt.taskId,f.attempt.datasetId,99,f.attempt.providerId,f.attempt.providerTaskId),/parent replacement/);
 insert.run('other-c',f.attempt.taskId,f.attempt.datasetId,99,f.attempt.providerId,'distinct');
 assert.throws(()=>f.db.prepare("UPDATE OR REPLACE processing_attempts SET attempt_number=? WHERE id='other-c'").run(f.attempt.attemptNumber),/parent replacement/);
 assert.throws(()=>f.db.prepare("UPDATE OR REPLACE processing_attempts SET provider_task_id=? WHERE id='other-c'").run(f.attempt.providerTaskId),/parent replacement/);
 assert.ok(f.processing.getInitializationSnapshot(f.attempt.id));
});
test('audited terminal purge removes snapshot atomically and survives a process crash',t=>{
 const f=fixture(t);f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});
 f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(f.attempt.id);
 f.db.prepare("UPDATE processing_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(f.job.id);
 const trash=f.processing.trashTask(f.attempt.taskId,'ops:test');assert.ok(trash);
 assert.throws(()=>f.db.prepare('INSERT INTO processing_initialization_purge_authorizations VALUES(?,?,?)').run(f.attempt.id,trash.id,'forged'),/unauthorized/);
 const {spawnSync}=require('node:child_process'),script="const {openDatabase}=require(process.argv[1]),{ProcessingRepository}=require(process.argv[2]);const db=openDatabase(process.argv[3]),p=new ProcessingRepository(db),audit=p.insertAudit.bind(p);p.insertAudit=x=>{audit(x);process.exit(0)};p.purgeMetadataEntity(process.argv[4],'ops:test');process.exit(2)";
 const child=spawnSync(process.execPath,['-e',script,require.resolve('../server/database'),require.resolve('../server/processingRepository'),path.join(f.root,'db.sqlite'),trash.id],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);
 assert.ok(f.processing.getInitializationSnapshot(f.attempt.id));assert.equal(f.processing.getTrash(trash.id).permanentlyDeletedAt,null);assert.equal(f.processing.getTask(f.attempt.taskId).purgedAt,null);
 assert.ok(f.processing.purgeMetadataEntity(trash.id,'ops:test'));assert.equal(f.processing.getInitializationSnapshot(f.attempt.id),null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_initialization_purge_authorizations').get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.purged' AND entity_id=?").get(f.attempt.taskId).n,1);
});
test('pre-send initialization snapshot survives abrupt process exit without enabling replay',t=>{
 const f=fixture(t),{spawnSync}=require('node:child_process');
 const script="const {openDatabase}=require(process.argv[1]),{ProcessingRepository}=require(process.argv[2]);const db=openDatabase(process.argv[3]),p=new ProcessingRepository(db);if(!p.beginAttemptInitialization(process.argv[4],'owner',{freshTaskMissing:true,captureRequest:true})?.requestSnapshot)process.exit(2);process.exit(0)";
 const child=spawnSync(process.execPath,['-e',script,require.resolve('../server/database'),require.resolve('../server/processingRepository'),path.join(f.root,'db.sqlite'),f.job.id],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr);assert.equal(f.processing.getInitializationSnapshot(f.attempt.id).request.name,'T');
 assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'new');
});
test('first initialization sends frozen name if task is renamed after capture',async t=>{
 const f=fixture(t),capture=f.processing.beginAttemptInitialization.bind(f.processing);let sent;
 f.processing.beginAttemptInitialization=(...args)=>{const result=capture(...args);f.processing.updateTaskMetadata(f.attempt.taskId,{displayName:'After capture'});return result};
 const adapter={status:async()=>{throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},initialize:async request=>{sent=request;return{uuid:request.uuid}},upload:async()=>{},commit:async()=>{}};
 await processSubmit(f.job,{processing:f.processing,storage:f.storage,config:{},signal:new AbortController().signal,adapterFactory:()=>adapter});
 assert.equal(sent.name,'T');assert.equal(f.processing.getTask(f.attempt.taskId).displayName,'After capture');
});
test('historical attempt without a frozen request holds instead of sending mutable metadata',async t=>{
 const f=fixture(t),old=f.processing.getAttemptProvenance(f.attempt.id).submission;delete old.inputFiles;
 f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(old),f.attempt.id);
 let sent=0;const adapter={status:async()=>{throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},initialize:async()=>{sent++}};
 await processSubmit(f.job,{processing:f.processing,storage:f.storage,config:{},signal:new AbortController().signal,adapterFactory:()=>adapter});
 assert.equal(sent,0);assert.equal(f.processing.getInitializationSnapshot(f.attempt.id),null);
 assert.equal(f.db.prepare('SELECT status,error_code FROM processing_jobs WHERE id=?').get(f.job.id).status,'pending');
 assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,'provider_submission_observation_unavailable');
});
test('prior initialization intent without a snapshot never sends or reconstructs a request',async t=>{
 const f=fixture(t),prior=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true});assert.ok(prior);assert.equal(f.processing.getInitializationSnapshot(f.attempt.id),null);
 f.processing.updateTaskMetadata(f.attempt.taskId,{displayName:'Changed after intent'});let sent=0;
 const adapter={status:async()=>{throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},initialize:async()=>{sent++}};
 await processSubmit(f.job,{processing:f.processing,storage:f.storage,config:{},signal:new AbortController().signal,adapterFactory:()=>adapter});
 assert.equal(sent,0);assert.equal(f.processing.getInitializationSnapshot(f.attempt.id),null);
 assert.equal(f.db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(f.job.id).status,'pending');
 assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,'provider_submission_observation_unavailable');
});
test('changed snapshot binding stays pending across retries without sending or failing the attempt',async t=>{
 const f=fixture(t);f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});
 f.db.prepare('UPDATE processing_providers SET endpoint=? WHERE id=?').run('https://other.example',f.attempt.providerId);
 f.db.prepare("UPDATE processing_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,available_at='2000' WHERE id=?").run(f.job.id);
 let sent=0;const adapter={status:async()=>{sent++;throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},initialize:async()=>{sent++}};
 for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE id=? AND status='pending'").run(f.job.id);await processOne({processing:f.processing,storage:f.storage,config:{},adapterFactory:()=>adapter},'retry-owner')}
 const job=f.db.prepare('SELECT status,error_code FROM processing_jobs WHERE id=?').get(f.job.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_observation_unavailable');assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');assert.equal(sent,0);
});
test('changed reservation binding prevents adapter creation and credential use',async t=>{
 for(const kind of ['origin','key','ciphertext']){
  const f=fixture(t);f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
  f.processing.ensureAttemptReservation(f.job.id,'owner',()=>({keyId:'key-a',ciphertext:'sealed-a'}));
  f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true,captureRequest:true});
  if(kind==='origin')f.db.prepare('UPDATE processing_providers SET endpoint=? WHERE id=?').run('https://other.example',f.attempt.providerId);
  else if(kind==='key')f.db.prepare('UPDATE processing_attempt_reservations SET capability_key_id=? WHERE attempt_id=?').run('key-b',f.attempt.id);
  else f.db.prepare('UPDATE processing_attempt_reservations SET capability_ciphertext=? WHERE attempt_id=?').run('sealed-b',f.attempt.id);
  f.db.prepare("UPDATE processing_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,available_at='2000' WHERE id=?").run(f.job.id);
  let adapters=0,credentials=0;const providerCredentials={sealAttemptCapability(){credentials++;throw new Error('unexpected seal')},unsealAttemptCapability(){credentials++;throw new Error('unexpected unseal')}};
  await processOne({processing:f.processing,storage:f.storage,config:{},providerCredentials,adapterFactory:()=>{adapters++;throw new Error('unexpected adapter')}},'retry-owner');
  assert.equal(adapters,0,kind);assert.equal(credentials,0,kind);assert.equal(f.db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(f.job.id).status,'pending',kind);
 }
});
test('inventory freezes source roles and exact ordered upload including generated GCP replacement',()=>{
  const make=(relativePath,processingRole='auto')=>({relativePath,processingRole,byteSize:4,sha256:sha(relativePath)});
  const files=[make('geo.txt','provider_input'),make('b.jpg','image'),make('notes.txt','administrative'),make('gcp_list.txt','provider_input'),make('a.jpg'),make('marks.csv','gcp_source')];
  const content='generated gcp',snapshot={content,sha256:sha(content)},value=inputInventory(files,snapshot);
  assert.deepEqual(value.inputFiles.map(file=>file.relativePath),['b.jpg','a.jpg','geo.txt','gcp_list.txt']);
  assert.equal(value.inputFiles.at(-1).byteSize,Buffer.byteLength(content));assert.equal(value.inputFiles.at(-1).sha256,snapshot.sha256);
  assert.equal(value.inputManifestSha256,sha(JSON.stringify(value.inputFiles)));
  const changed=structuredClone(files);changed[2].processingRole='provider_input';assert.notEqual(inputInventory(changed,snapshot).sourceFilesSha256,value.sourceFilesSha256);
});
test('new attempts validate immutable roles and upload order; historical attempts do not gain proof',t=>{
  const f=fixture(t),snapshot=f.processing.getAttemptProvenance(f.attempt.id).submission,files=f.processing.getDataset(f.dataset.id,true).files;
  assert.ok(snapshot.inputFiles);assert.equal(f.processing.validateAttemptInputInventory(f.job.id,'owner',files,snapshot.inputFiles),true);
  assert.equal(f.processing.validateAttemptInputInventory(f.job.id,'wrong',files,snapshot.inputFiles),false);
  assert.throws(()=>f.processing.validateAttemptInputInventory(f.job.id,'owner',files.map(file=>({...file,processingRole:'administrative'})),snapshot.inputFiles),{code:'dataset_source_changed'});
  assert.throws(()=>f.processing.validateAttemptInputInventory(f.job.id,'owner',files,[]),{code:'dataset_source_changed'});
  delete snapshot.inputFiles;f.db.prepare('UPDATE processing_attempt_provenance SET submission_json=? WHERE attempt_id=?').run(JSON.stringify(snapshot),f.attempt.id);
  assert.equal(f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true}).historical,true);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id),null);
});
test('fresh initialization acknowledgement and completed UUID bind immutable archive receipt',t=>{
  const f=fixture(t),init=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true});assert.equal(init.ambiguous,false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'wrong',init.generation,f.attempt.providerTaskId),false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,'other'),false);
  assert.equal(f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,f.attempt.providerTaskId),true);
  const input=archive(f);assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'wrong',input),null);
  const receipt=f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input);assert.equal(receipt.providerTaskId,f.attempt.providerTaskId);
  const producer=f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id);assert.equal(producer.receipt.operation,'create');assert.equal(producer.receipt.completedTaskId,f.attempt.providerTaskId);assert.equal(producer.inputFiles.length,1);
  assert.deepEqual(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),receipt);
  assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',{...input,archiveSha256:sha('different')}),null);
  assert.deepEqual(f.processing.getAttemptTransferProvenance(f.attempt.id).archive,receipt);
});
test('ack loss, repeated initialization, observed existing task, mismatched completion and cancelled lease stay unknown',t=>{
  for(const mode of ['ack-loss','repeat','existing','wrong-completion','cancelled']){
    const f=fixture(t),init=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:mode!=='existing'});
    if(mode!=='ack-loss')f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',init.generation,f.attempt.providerTaskId);
    if(mode==='repeat'){const next=f.processing.beginAttemptInitialization(f.job.id,'owner',{freshTaskMissing:true});assert.equal(next.ambiguous,true);f.processing.acknowledgeAttemptInitialization(f.job.id,'owner',next.generation,f.attempt.providerTaskId);}
    const input=archive(f);
    if(mode==='wrong-completion')f.db.prepare("UPDATE processing_attempt_provenance SET provider_result_json='{}' WHERE attempt_id=?").run(f.attempt.id);
    if(mode==='cancelled')f.db.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(f.attempt.id);
    if(mode==='cancelled')assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),null,mode);
    else assert.ok(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),mode);
    assert.equal(f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id),null,mode);
  }
});
test('worker records fresh create receipt but recovery of lost acknowledgement is ambiguous',async t=>{
  for(const lost of [false,true]){
    const f=fixture(t);let exists=false;
    const adapter={status:async()=>{if(!exists)throw Object.assign(new Error('missing'),{code:'provider_task_not_found'});return{status:'queued',imagesCount:0};},
      initialize:async()=>{exists=true;if(lost)throw new Error('ack lost');return{uuid:f.attempt.providerTaskId};},upload:async()=>{},commit:async()=>{}};
    const deps={processing:f.processing,storage:f.storage,config:{},providerCredentials:{},adapterFactory:()=>adapter};
    if(lost){await assert.rejects(processSubmit(f.job,deps),/ack lost/);await processSubmit(f.job,deps);}
    else await processSubmit(f.job,deps);
    const proof=f.processing.getAttemptTransferProvenance(f.attempt.id).initialization;
    assert.equal(proof.ambiguous,lost);assert.equal(proof.state,lost?'intent':'acknowledged');
  }
});

test('historical archive receipts support integrity retry without inventing producer evidence',t=>{
  const f=fixture(t);f.db.prepare('DELETE FROM processing_attempt_provenance WHERE attempt_id=?').run(f.attempt.id);
  const input=archive(f),receipt=f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input);
  assert.ok(receipt);assert.deepEqual(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),receipt);
  assert.equal(f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id),null);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id).initialization.state,'unknown');
});

test('archive receipts reject malformed inventory, duplicate paths, unbound digest and expired lease',t=>{
  const f=fixture(t),input=archive(f);
  for(const change of [{archiveSha256:'bad'},{archiveByteSize:-1},{archiveManifestSha256:sha('wrong')},
    {archiveFiles:[...input.archiveFiles,{...input.archiveFiles[0],relativePath:'ODM_DEM/DSM.TIF'}]},
    {archiveFiles:[{...input.archiveFiles[0],relativePath:'../escape'}]}])assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',{...input,...change}),null);
  assert.equal(f.processing.getAttemptTransferProvenance(f.attempt.id),null);
  f.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.job.id);
  assert.equal(f.processing.recordAttemptArchiveReceipt(f.job.id,'owner',input),null);
});
