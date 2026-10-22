'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'processing-provenance-')),db=openDatabase(path.join(root,'test.sqlite')),processing=new ProcessingRepository(db);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Project'}),dataset=processing.createDataset({projectId:project.id,displayName:'Data',storageMode:'managed',rootKey:'datasets',relativePath:'test'}),hash=crypto.createHash('sha256').digest('hex');processing.finalizeDataset(dataset.id,[{relativePath:'a.jpg',byteSize:0,sha256:hash}],hash);
  const capabilities={engine:'odm',engineVersion:'3.5.6',apiVersion:'2.2.4',providerType:'clusterodm',secret:'DO-NOT-SAVE',options:[{name:'min-num-features',type:'int',value:10000,domain:'positive integer',help:'Features'},{name:'auto-boundary',type:'bool',value:false},{name:'sm-cluster',type:'string',value:'https://user:DO-NOT-SAVE@node.example'}]},provider=processing.upsertProvider({type:'clusterodm',displayName:'Cluster',endpoint:'http://127.0.0.1:3000',enabled:true,capabilities,capabilityFingerprint:'fp-a'}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'});
  return{root,db,processing,project,dataset,provider,task};
}
test('new attempts freeze provider schema versions defaults and exact submitted-option digest without credentials',t=>{
  const f=fixture(t),options={'min-num-features':20000,'api-token':'DO-NOT-SAVE'},attempt=f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options,capabilityFingerprint:'fp-a'}),before=f.processing.getAttemptProvenance(attempt.id);
  assert.equal(before.submission.capabilities.engineVersion,'3.5.6');assert.equal(before.submission.capabilityFingerprintMatches,true);assert.equal(before.submission.producingEngineVerified,false);
  assert.equal(before.submission.defaultsAuthority,'cluster-reference-worker-advertisement');assert.equal(before.submission.resolvedOptionsFromAdvertisedDefaults['min-num-features'],20000);assert.equal(before.submission.resolvedOptionsFromAdvertisedDefaults['auto-boundary'],false);
  assert.equal(before.submission.schema[0].name,'min-num-features');assert.equal(before.submission.schema[0].domain,'positive integer');assert.equal(before.submission.schema[2].value.redacted,true);
  assert.equal(before.submission.datasetManifestSha256,f.processing.getDataset(f.dataset.id).manifestSha256);assert.equal(before.submission.gcpSnapshotSha256,null);
  assert.equal(before.submission.submittedOptions['api-token'].redacted,true);assert.ok(!JSON.stringify(before).includes('DO-NOT-SAVE'));assert.ok(!JSON.stringify(before).includes('127.0.0.1'));
  options['min-num-features']=5;
  f.processing.updateProviderCapabilities(f.provider.id,{capabilities:{engine:'different',engineVersion:'9',options:[]},fingerprint:'fp-new',health:'healthy'});
  assert.deepEqual(f.processing.getAttemptProvenance(attempt.id),before);
  assert.equal(f.processing.getAttempt(attempt.id).options['min-num-features'],20000);
});
test('atomic task submissions snapshot once and replay cannot replace history with current provider values',t=>{
  const f=fixture(t),input={subject:'ops:test',submissionId:'request1',requestHash:'a'.repeat(64),projectId:f.project.id,datasetId:f.dataset.id,taskDisplayName:'Submitted',providerId:f.provider.id,options:{'auto-boundary':true},capabilityFingerprint:'fp-a'};
  const first=f.processing.createTaskSubmission(input),before=f.processing.getAttemptProvenance(first.attempt.id);assert.ok(before);
  f.processing.updateProviderCapabilities(f.provider.id,{capabilities:{engine:'changed'},fingerprint:'new',health:'healthy'});
  assert.equal(f.processing.createTaskSubmission(input).replayed,true);assert.deepEqual(f.processing.getAttemptProvenance(first.attempt.id),before);
  assert.equal(f.processing.createTaskSubmission({...input,requestHash:'other'}).conflict,true);
});
test('historical rows remain unknown and completed task-info evidence is exact-identity and lease bound',t=>{
  const f=fixture(t),attempt=f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,capabilityFingerprint:'fp-a'}),job=f.processing.claimJob('owner'),status={uuid:attempt.providerTaskId,status:'completed',statusCode:40,imagesCount:264};
  assert.equal(f.processing.recordAttemptProviderResult(job.id,'other',status),false);
  assert.equal(f.processing.recordAttemptProviderResult(job.id,'owner',{...status,uuid:'wrong'}),false);
  assert.equal(f.processing.recordAttemptProviderResult(job.id,'owner',status),true);
  const result=f.processing.getAttemptProvenance(attempt.id).providerResult;assert.equal(result.engine,null);assert.equal(result.engineVersion,null);assert.equal(result.imagesCount,264);assert.equal(result.producingEngineVerified,false);
  assert.equal(f.processing.recordAttemptProviderResult(job.id,'owner',{...status,engine:'odm',engineVersion:'changed'}),true);assert.deepEqual(f.processing.getAttemptProvenance(attempt.id).providerResult,result);
  f.db.prepare('DELETE FROM processing_attempt_provenance WHERE attempt_id=?').run(attempt.id);
  assert.equal(f.processing.getAttemptProvenance(attempt.id),null);assert.equal(f.processing.recordAttemptProviderResult(job.id,'owner',status),true);assert.equal(f.processing.getAttemptProvenance(attempt.id),null);
});
