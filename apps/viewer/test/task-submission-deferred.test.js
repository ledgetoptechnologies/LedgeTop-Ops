'use strict';
// A task submitted while its photos are still being prepared on the server waits for them: no tab needs to stay open.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deferred-submission-')),db=openDatabase(path.join(root,'test.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Synthetic project'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic photos',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic node',endpoint:'http://127.0.0.1:3000',enabled:true});
  processing.updateProviderCapabilities(provider.id,{capabilities:{engine:'odm',engineVersion:'3.5.6',options:[{name:'dsm',type:'bool',value:false}]},fingerprint:'fp',health:'healthy'});
  const t0=new Date().toISOString(),operationId=crypto.randomUUID();
  const addOperation=(status='queued',type='import_adopt')=>{const id=crypto.randomUUID();db.prepare('INSERT INTO dataset_operations(id,operation_type,subject,session_id,dataset_id,payload_json,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,type,'ops:test',null,dataset.id,JSON.stringify({rawPhotoCopy:true}),status,t0,t0,t0);return id;};
  const submit=(overrides={})=>processing.createTaskSubmission({subject:'ops:test',submissionId:crypto.randomUUID(),requestHash:crypto.randomBytes(32).toString('hex'),projectId:project.id,datasetId:dataset.id,taskDisplayName:'Synthetic task',providerId:provider.id,options:{dsm:true},capabilityFingerprint:'fp',...overrides});
  const finalize=()=>processing.finalizeDataset(dataset.id,[{relativePath:'a.jpg',byteSize:5,sha256:crypto.createHash('sha256').update('photo').digest('hex')}],'b'.repeat(64));
  return{db,processing,dataset,provider,operationId,addOperation,submit,finalize};
}

test('a dataset with no preparation running cannot take a submission',t=>{
  const f=fixture(t);
  assert.throws(()=>f.submit(),{code:'submission_unavailable'});
  f.addOperation('failed');
  assert.throws(()=>f.submit(),{code:'submission_unavailable'});
});

test('a submission made while photos are copied waits, then freezes provenance with the real files at finalize',t=>{
  const f=fixture(t);f.addOperation('leased');
  const result=f.submit();
  assert.equal(result.attempt.status,'pending');
  assert.equal(f.processing.getAttemptProvenance(result.attempt.id),null,'no provenance before the files exist');
  assert.equal(f.processing.claimJob('worker'),null,'the submit job is not claimable while photos are prepared');
  assert.equal(f.processing.attemptDiagnostics(result.attempt.id).processingJobs[0].queueReason,'source_preparing');
  f.finalize();
  const provenance=f.processing.getAttemptProvenance(result.attempt.id)?.submission;
  assert.ok(provenance,'provenance is frozen at finalize');
  assert.equal(provenance.datasetManifestSha256,'b'.repeat(64));
  assert.deepEqual(provenance.inputFiles.map(file=>file.relativePath),['a.jpg']);
  const job=f.processing.claimJob('worker');
  assert.ok(job,'the submit job is claimable once the photos are ready');
  assert.equal(job.attempt_id,result.attempt.id);
});

test('an upload being assembled also takes a submission; a cancelled one is not given provenance',t=>{
  const f=fixture(t);f.addOperation('queued','upload_finalize');
  const kept=f.submit(),cancelled=f.submit();
  f.processing.cancelAttempt(cancelled.attempt.id,'ops:test');
  f.finalize();
  assert.ok(f.processing.getAttemptProvenance(kept.attempt.id));
  assert.equal(f.processing.getAttemptProvenance(cancelled.attempt.id),null);
});

test('a submission on a finalized dataset still freezes provenance at once',t=>{
  const f=fixture(t);f.addOperation('leased');f.finalize();
  const result=f.submit();
  assert.ok(f.processing.getAttemptProvenance(result.attempt.id));
  assert.ok(f.processing.claimJob('worker'));
});
