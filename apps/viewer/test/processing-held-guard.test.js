'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {applyMigrations}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker'),{NodeOdmProvider}=require('../server/nodeOdmProvider');
const {processingJobCounts}=require('../server/processingOverview');

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:crypto.createHash('sha256').update('x').digest('hex')}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 return{db,processing,task,attempt};
}

test('ambiguous submit phases cannot be replaced even before a warning is recorded', t => {
 const f=fixture(t);
 for(const submissionPhase of ['initializing','uploading','uploading_auxiliary','committing'])
  assert.equal(f.processing.canReplaceAttempt({...f.attempt,status:'failed',submissionPhase,errorCode:null}),false,submissionPhase);
});

for (const phase of ['initialize', 'upload', 'commit']) for (const failure of ['503', 'reset']) for (const reservation of [false,true])
test(`cutover ${failure} during ${phase} preserves source and holds without duplicate mutation (reservation=${reservation})`, async t => {
 const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-cutover-hold-')),file=path.join(root,'photo.jpg');
 fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls={initialize:0,upload:0,commit:0,remove:0},remote={exists:false};
 if(reservation)f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const {ProviderCredentials}=require('../server/providerCredentials'),credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 const rejected=()=>Object.assign(new Error('simulated cutover interruption'),failure==='503'?{status:503,code:'provider_unavailable'}:{code:'ECONNRESET'});
 const adapter={
  capabilities:async()=>({capabilities:{reservations:{version:1}}}),request:async()=>Response.json({state:'reserved'}),
  status:async()=>{if(!remote.exists)throw Object.assign(new Error('not found'),{code:'provider_task_not_found'});return{status:'queued_upstream',progress:0,imagesCount:1}},
  initialize:async({uuid})=>{calls.initialize++;if(phase==='initialize')throw rejected();remote.exists=true;return{uuid}},
  upload:async()=>{calls.upload++;if(phase==='upload')throw rejected()},
  commit:async()=>{calls.commit++;if(phase==='commit')throw rejected()},
  remove:async()=>{calls.remove++},
 };
 const deps={processing:f.processing,providerCredentials:credentials,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};
 await processOne(deps,'cutover-worker');
 assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:reservation?'reservation_cancel_required':'provider_execution_unresolved'});
 for(let i=1;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit' AND status='pending'").run(f.attempt.id);await processOne(deps,'cutover-worker')}
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,phase==='upload'?'provider_upload_acceptance_unknown':'provider_submission_observation_unavailable');
 assert.equal(calls.initialize,1);assert.equal(calls.upload,phase==='initialize'?0:1);assert.equal(calls.commit,phase==='commit'?1:0);assert.equal(calls.remove,0);
 assert.equal(fs.readFileSync(file,'utf8'),'x');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(f.task.id).n,1);
});

for (const blockedAt of ['reservation','status'])
test(`cutover before initialization resumes safely after ${blockedAt} recovers`, async t => {
 const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-cutover-preinit-')),file=path.join(root,'photo.jpg');
 fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const {ProviderCredentials}=require('../server/providerCredentials'),credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 let blocked=true,initializations=0,uploads=0,commits=0,removes=0;
 const reject=()=>Object.assign(new Error('cutover'),{status:503,code:'provider_unavailable'});
 const adapter={capabilities:async()=>({capabilities:{reservations:{version:1}}}),request:async()=>{if(blocked&&blockedAt==='reservation')throw reject();return Response.json({state:'reserved'})},status:async()=>{if(blocked&&blockedAt==='status')throw reject();throw Object.assign(new Error('not found'),{code:'provider_task_not_found'})},initialize:async({uuid})=>{initializations++;return{uuid}},upload:async()=>{uploads++},commit:async()=>{commits++},remove:async()=>{removes++}};
 const deps={processing:f.processing,providerCredentials:credentials,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};
 await processOne(deps,'cutover-worker');assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'new');assert.equal(initializations,0);
 blocked=false;f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit' AND status='pending'").run(f.attempt.id);await processOne(deps,'cutover-worker');
 assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'committed');assert.equal(initializations,1);assert.equal(uploads,1);assert.equal(commits,1);assert.equal(removes,0);assert.equal(fs.readFileSync(file,'utf8'),'x');
});

test('413 after a partial upload holds the attempt across worker retries',async t=>{
 const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-upload-hold-')),file=path.join(root,'photo.jpg');
 fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let uploads=0,statusCalls=0;
 const adapter={status:async()=>{statusCalls++;throw Object.assign(new Error('not found'),{code:'provider_task_not_found'});},initialize:async({uuid})=>({uuid}),upload:async()=>{uploads++;throw Object.assign(new Error('request rejected'),{status:413,code:'body_too_large'});}};
 const deps={processing:f.processing,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};
 await processOne(deps,'owner');
 assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,'provider_upload_acceptance_unknown');
 assert.equal(processingJobCounts(f.db).observationWarnings,1);
 assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_execution_unresolved'});
 assert.equal(f.processing.retryAttempt(f.attempt.id,'ops:test'),null);
 f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);
 await processOne(deps,'owner');
 assert.equal(uploads,1);assert.equal(statusCalls,1);
 assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,'provider_upload_acceptance_unknown');
 assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_execution_unresolved'});
 f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(f.attempt.id);
 assert.equal(f.processing.retryAttempt(f.attempt.id,'ops:test'),null);
 assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.attempt.providerId,options:{}}),{code:'provider_execution_unresolved'});
});

test('concurrent direct attempt requests cannot replace an unresolved upload',async t=>{
 const f=fixture(t),express=require('express'),auth=require('../server/auth'),{createProcessingApi}=require('../server/processingApi');
 f.processing.updateProviderCapabilities(f.attempt.providerId,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'}]},fingerprint:'d'.repeat(64),health:'healthy'});
 f.db.prepare("UPDATE processing_attempts SET status='failed',submission_phase='uploading',error_code='provider_upload_acceptance_unknown' WHERE id=?").run(f.attempt.id);
 f.processing.workerStatus=()=>({live:true});
 const token='direct-attempt-guard-token-000000000000';f.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:test',permissions:['viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const app=express();app.use(express.json());app.use(createProcessingApi({repository:{},processing:f.processing,storage:{}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=key=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/tasks/${f.task.id}/attempts`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify({providerId:f.attempt.providerId,options:{}})});
 const responses=await Promise.all([post('direct-one'),post('direct-two')]);
 for(const response of responses){assert.equal(response.status,409);assert.equal((await response.json()).code,'provider_execution_unresolved');}
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM processing_attempts WHERE task_id=?').get(f.task.id).n,1);
});

test('separate processes cannot replace an unresolved upload',async t=>{
 const {spawn}=require('node:child_process'),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-replace-race-')),dbPath=path.join(root,'viewer.sqlite');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:crypto.createHash('sha256').update('x').digest('hex')}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 db.prepare("UPDATE processing_attempts SET status='failed',submission_phase='uploading',error_code='provider_upload_acceptance_unknown' WHERE id=?").run(attempt.id);db.close();
 const script=`const {DatabaseSync}=require('node:sqlite'),{ProcessingRepository}=require('./server/processingRepository');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');try{new ProcessingRepository(db).createAttempt({taskId:process.argv[2],providerId:process.argv[3],options:{}});process.stdout.write('unexpected-success')}catch(e){process.stdout.write(e.code||'unknown')}finally{db.close()}`;
 const children=[];t.after(()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',script,dbPath,task.id,provider.id],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe']});children.push(child);let output='',errors='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{errors+=data});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('replacement child timed out'));},10000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(`replacement child failed: ${errors}`));});});
 assert.deepEqual(await Promise.all([run(),run()]),['provider_execution_unresolved','provider_execution_unresolved']);
 const check=new DatabaseSync(dbPath);try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM processing_attempts WHERE task_id=?').get(task.id).n,1);}finally{check.close();}
});

test('worker death during upload is held before provider access on restart',async t=>{
 const {spawn}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-upload-kill-')),dbPath=path.join(root,'viewer.sqlite'),file=path.join(root,'photo.jpg');
 fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
 let processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:1,sha256:crypto.createHash('sha256').update('x').digest('hex')}],'b'.repeat(64));
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 db.close();
 const script=`const {DatabaseSync}=require('node:sqlite');const {ProcessingRepository}=require('./server/processingRepository');const {processOne}=require('./server/processingWorker');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA foreign_keys=ON');const processing=new ProcessingRepository(db);const adapter={status:async()=>{throw Object.assign(new Error('missing'),{code:'provider_task_not_found'})},initialize:async({uuid})=>({uuid}),upload:async()=>{process.send('upload');await new Promise(()=>{});}};processOne({processing,storage:{resolve:()=>process.argv[2],requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter},'killed-owner').catch(()=>process.exit(2));`;
 const child=spawn(process.execPath,['-e',script,dbPath,file],{cwd:path.join(__dirname,'..'),stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child did not reach upload')),10000);child.once('message',value=>{clearTimeout(timer);value==='upload'?resolve():reject(new Error('unexpected child message'));});child.once('exit',()=>{clearTimeout(timer);reject(new Error('child exited before upload'));});});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 db=new DatabaseSync(dbPath);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');processing=new ProcessingRepository(db);
 assert.equal(processing.getAttempt(attempt.id).submissionPhase,'uploading');
 assert.throws(()=>processing.cancelAttempt(attempt.id,'ops:test'),{code:'provider_execution_unresolved'});
 assert.equal(processing.retryAttempt(attempt.id,'ops:test'),null);
 assert.equal(processingJobCounts(db).observationWarnings,0);
 // Advance only the disposable fixture lease, as if it had naturally expired.
 db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=? AND job_type='submit'").run(attempt.id);
 assert.equal(processingJobCounts(db).observationWarnings,1);
 let calls=0;await processOne({processing,storage:{resolve(){throw new Error('unexpected source access');}},config:{},adapterFactory:()=>({status:async()=>{calls++;},upload:async()=>{calls++;}})},'restarted-owner');
 assert.equal(calls,0);assert.equal(processing.getAttempt(attempt.id).errorCode,'provider_upload_acceptance_unknown');
});

test('attempt capability is persisted once under the live worker lease',t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 const job=f.db.prepare("SELECT id FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);
 f.db.prepare("UPDATE processing_jobs SET status='leased',lease_owner='owner',lease_expires_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
 const seal=credentials.sealAttemptCapability.bind(credentials);
 assert.equal(f.processing.ensureAttemptReservation(job.id,'other',seal),null);
 const first=f.processing.ensureAttemptReservation(job.id,'owner',seal),second=f.processing.ensureAttemptReservation(job.id,'owner',seal);
 assert.deepEqual(second,first);
 assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'reservation_cancel_required'});
 const value=credentials.openAttemptCapability(first.providerId,f.attempt.id,first.providerTaskId,first);
 assert.equal(value.length,43);assert.equal(first.ciphertext.includes(value),false);
 f.db.prepare("UPDATE processing_jobs SET lease_owner='other' WHERE id=?").run(job.id);
 assert.equal(f.processing.ensureAttemptReservation(job.id,'owner',seal),null);
});

test('reservation eligibility is fixed at attempt creation, not retroactive',t=>{
 const f=fixture(t);
 assert.equal(f.processing.attemptRequiresReservation(f.attempt.id),false);
 f.processing.updateProviderCapabilities(f.attempt.providerId,{capabilities:{reservations:{version:1,remaining:5}},fingerprint:'fixture',health:'healthy'});
 const task=f.processing.createTask({projectId:f.task.projectId,datasetId:f.attempt.datasetId,displayName:'New attempt'});
 const next=f.processing.createAttempt({taskId:task.id,providerId:f.attempt.providerId,options:{}});
 assert.equal(f.processing.attemptRequiresReservation(next.id),true);
 f.db.prepare("UPDATE processing_providers SET capabilities_json='{}' WHERE id=?").run(f.attempt.providerId);
 assert.equal(f.processing.attemptRequiresReservation(next.id),true);
 assert.equal(f.processing.attemptRequiresReservation(f.attempt.id),false);
 const another=f.processing.createTask({projectId:f.task.projectId,datasetId:f.attempt.datasetId,displayName:'After downgrade'});
 assert.equal(f.processing.attemptRequiresReservation(f.processing.createAttempt({taskId:another.id,providerId:f.attempt.providerId,options:{}}).id),true);
 const submitted=f.processing.createTaskSubmission({subject:'ops:test',submissionId:crypto.randomUUID(),requestHash:'a'.repeat(64),projectId:f.task.projectId,datasetId:f.attempt.datasetId,taskDisplayName:'Submission',providerId:f.attempt.providerId,options:{}});
 assert.equal(f.processing.attemptRequiresReservation(submitted.attempt.id),true);
});

test('a provider created with reservation support requires it immediately',t=>{
 const f=fixture(t);
 const provider=f.processing.upsertProvider({type:'nodeodm',displayName:'Reserved',endpoint:'https://example.test',enabled:true,capabilities:{reservations:{version:1,remaining:5}}});
 const task=f.processing.createTask({projectId:f.task.projectId,datasetId:f.attempt.datasetId,displayName:'New provider'});
 const attempt=f.processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 assert.equal(provider.reservationRequired,true);assert.equal(f.processing.attemptRequiresReservation(attempt.id),true);
});

test('eligible submission never falls back when the coordinator loses reservation support',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 let mutations=0;
 const adapter={capabilities:async()=>({capabilities:{}}),status:async()=>{mutations++;},initialize:async()=>{mutations++;},upload:async()=>{mutations++;},commit:async()=>{mutations++;}};
 const deps={processing:f.processing,providerCredentials:credentials,storage:{resolve(){assert.fail('source must not be read')}},config:{},adapterFactory:()=>adapter};
 assert.equal(await processOne(deps,'owner'),true);
 assert.equal(mutations,0);
 assert.ok(f.processing.getAttemptReservation(f.attempt.id));
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_observation_unavailable');
});

test('cancellation cannot finalize locally while a reservation request is in flight',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 let entered,release,mutations=0;
 const inFlight=new Promise(resolve=>{entered=resolve}), gate=new Promise(resolve=>{release=resolve});
 const adapter={capabilities:async()=>({capabilities:{reservations:{version:1}}}),request:async()=>{entered();await gate;return Response.json({state:'cancelled'});},status:async()=>{mutations++;},initialize:async()=>{mutations++;}};
 const running=processOne({processing:f.processing,providerCredentials:credentials,storage:{resolve(){assert.fail('source must not be read')}},config:{},adapterFactory:()=>adapter},'owner');
 await inFlight;
 assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'reservation_cancel_required'});
 release();await running;
 assert.equal(mutations,0);
 assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'cancelled');
});

test('uncertain reserved initialization remains pending through repeated failures',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 let calls=0;
 const adapter={capabilities:async()=>({capabilities:{reservations:{version:1}}}),request:async()=>Response.json({state:'reserved'}),status:async()=>{throw Object.assign(Error('missing'),{code:'provider_task_not_found'});},initialize:async()=>{calls++;throw new Error('connection lost after initialization');}};
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reserve-test-')),file=path.join(root,'photo.jpg');fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const deps={processing:f.processing,providerCredentials:credentials,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};
 for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);await processOne(deps,'owner');}
 assert.equal(calls,1);
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_observation_unavailable');
 assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');
});

test('a proven source change before initialization is reported rather than deferred',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-invalid-source-')),file=path.join(root,'photo.jpg');fs.writeFileSync(file,'changed');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let initialized=false;
 const adapter={capabilities:async()=>({capabilities:{reservations:{version:1}}}),request:async()=>Response.json({state:'reserved'}),status:async()=>{throw Object.assign(Error('missing'),{code:'provider_task_not_found'});},initialize:async()=>{initialized=true;}};
 await processOne({processing:f.processing,providerCredentials:credentials,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter},'owner');
 assert.equal(initialized,false);assert.equal(f.processing.getAttempt(f.attempt.id).status,'failed');
});

test('reserved ingestion survives repeated coordinator outages without terminal failure',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});credentials.resolve=()=>'';
 f.db.prepare("UPDATE processing_providers SET endpoint='https://127.0.0.1:1' WHERE id=?").run(f.attempt.providerId);
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const submit=f.processing.claimJob('owner');f.processing.ensureAttemptReservation(submit.id,'owner',credentials.sealAttemptCapability.bind(credentials));
 f.processing.completeJob(submit.id,'owner');f.processing.transitionAttempt(f.attempt.id,'ingesting');f.processing.enqueueJob(f.attempt.id,'ingest');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-ingest-outage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const deps={processing:f.processing,repository:{},providerCredentials:credentials,storage:{space:()=>({available:4*1024**3,reserve:0}),resolve:(_root,rel)=>path.join(root,rel)},config:{}};
 for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='ingest'").run(f.attempt.id);await processOne(deps,'owner');}
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(f.attempt.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_observation_unavailable');assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');
});

test('interrupted reserved archive streams remain retryable and remove partial files',async t=>{
 const f=fixture(t),{ProviderCredentials}=require('../server/providerCredentials');
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});credentials.resolve=()=>'';
 f.db.prepare("UPDATE processing_providers SET endpoint='https://example.test' WHERE id=?").run(f.attempt.providerId);
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const submit=f.processing.claimJob('owner');f.processing.ensureAttemptReservation(submit.id,'owner',credentials.sealAttemptCapability.bind(credentials));
 f.processing.completeJob(submit.id,'owner');f.processing.transitionAttempt(f.attempt.id,'ingesting');f.processing.enqueueJob(f.attempt.id,'ingest');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-stream-outage-')),originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
 const info={version:'2.2.3',engine:'ODM',engineVersion:'1.0',taskQueueCount:0,maxImages:1000,ledgetopReservations:{version:1,capabilityEncoding:'base64url-32',retention:'indefinite',runningCancellation:'requires_inspection',remaining:10}};
 global.fetch=async url=>url.pathname==='/info'?Response.json(info):url.pathname==='/options'?Response.json([]):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.error(new Error('synthetic connection reset'));}}));
 const deps={processing:f.processing,repository:{},providerCredentials:credentials,storage:{space:()=>({available:4*1024**3,reserve:0}),resolve:(_root,rel)=>path.join(root,rel)},config:{}};
 for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='ingest'").run(f.attempt.id);await processOne(deps,'owner');}
 const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(f.attempt.id);
 assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_observation_unavailable');assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');
 const parent=path.join(root,f.task.id);assert.deepEqual(fs.readdirSync(parent),[]);
 const originalWriter=fs.createWriteStream;
 try{
  let cancelled=false;
  global.fetch=async url=>url.pathname==='/info'?Response.json(info):url.pathname==='/options'?Response.json([]):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));},cancel(){cancelled=true;}}));
  fs.createWriteStream=()=>new (require('node:stream').Writable)({write(_chunk,_enc,cb){cb(Object.assign(new Error('synthetic local writer failure'),{code:'EMFILE'}));}});
  f.db.prepare("UPDATE processing_jobs SET available_at='2000',attempt_count=0 WHERE attempt_id=? AND job_type='ingest'").run(f.attempt.id);
  let timer;try{await Promise.race([processOne(deps,'owner'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('stream teardown stalled')),2000);})]);}finally{clearTimeout(timer);}
  assert.equal(cancelled,true);
  assert.equal(f.db.prepare("SELECT error_code FROM processing_jobs WHERE attempt_id=? AND job_type='ingest'").get(f.attempt.id).error_code,'EMFILE');
  assert.deepEqual(fs.readdirSync(parent),[]);
 }finally{fs.createWriteStream=originalWriter;}
});

test('cancellation API keeps a conflicting reservation and finalizes a confirmed tombstone',async t=>{
 const f=fixture(t),express=require('express'),auth=require('../server/auth'),{createProcessingApi}=require('../server/processingApi'),{ProviderCredentials}=require('../server/providerCredentials');
 const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});credentials.resolve=()=>'';
 f.db.prepare("UPDATE processing_providers SET endpoint='https://example.test' WHERE id=?").run(f.attempt.providerId);
 f.db.prepare('UPDATE processing_attempts SET reservation_required=1 WHERE id=?').run(f.attempt.id);
 const job=f.db.prepare("SELECT id FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);
 f.db.prepare("UPDATE processing_jobs SET status='leased',lease_owner='owner',lease_expires_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
 f.processing.ensureAttemptReservation(job.id,'owner',credentials.sealAttemptCapability.bind(credentials));
 f.db.prepare("UPDATE processing_attempts SET submission_phase='uploading',error_code='provider_upload_acceptance_unknown' WHERE id=?").run(f.attempt.id);
 const token='synthetic-session-token-0000000000000000';
 f.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:test',permissions:['viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 let conflict=true,seen=[];
 const app=express();app.use(express.json());app.use(createProcessingApi({repository:{},processing:f.processing,storage:{},providerCredentials:credentials,providerFetch:async(url,init)=>{
  seen.push(url.pathname);assert.ok(init.headers.get('X-LedgeTop-Capability'));
  if(url.pathname.endsWith('/reserve'))return Response.json({state:'reserved'});
  if(conflict)return Response.json({error:'running'},{status:409});
  return Response.json({state:'cancelled'});
 }}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=key=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/attempts/${f.attempt.id}/cancel`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:'{}'});
 assert.equal((await post('cancel-conflict')).status,409);assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'cancelled');
 conflict=false;assert.equal((await post('cancel-confirm')).status,200);assert.equal(f.processing.getAttempt(f.attempt.id).status,'cancelled');
 assert.deepEqual(seen,['/task/ledgetop/reserve','/task/ledgetop/cancel','/task/ledgetop/reserve','/task/ledgetop/cancel']);
 const receipt=f.db.prepare("SELECT id,details_json FROM audit_events WHERE action='processing_attempt.cancelled' AND entity_id=?").get(f.attempt.id),details=JSON.parse(receipt.details_json);
 f.db.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify({...details,providerTaskId:crypto.randomUUID()}),receipt.id);
 assert.equal(f.processing.retryAttempt(f.attempt.id,'ops:test'),null);
 f.db.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(receipt.details_json,receipt.id);
 const retry=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/attempts/${f.attempt.id}/retry`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'retry-after-confirm'},body:'{}'});
 assert.equal(retry.status,202);assert.notEqual((await retry.json()).attempt.id,f.attempt.id);
});

test('provider accepts only the agreed held marker on nonterminal status',async()=>{
 let info={uuid:'fixture',status:{code:20},ledgetopHeld:true};const adapter=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>new Response(JSON.stringify(info),{headers:{'Content-Type':'application/json'}})});
 assert.equal((await adapter.status('fixture')).held,true); for(const code of [10,20]){info={uuid:'fixture',status:{code},ledgetopHeld:true,ledgetopHoldReason:'option_evidence_invalid'};const result=await adapter.status('fixture');assert.equal(result.heldReason,'option_evidence_invalid');assert.equal(result.status,code===10?'queued_upstream':'running');info.ledgetopHoldReason='<unsafe>';assert.equal((await adapter.status('fixture')).heldReason,undefined);} info={uuid:'other',status:{code:10},ledgetopHeld:true};await assert.rejects(adapter.status('fixture'),/incompatible task response/);info={uuid:'fixture',status:{code:20}};assert.equal((await adapter.status('fixture')).held,undefined);
 for(const value of [false,'true',1,null]){info={uuid:'fixture',status:{code:20},ledgetopHeld:value};await assert.rejects(adapter.status('fixture'),/incompatible held status/)}
 info={uuid:'fixture',status:{code:30},ledgetopHeld:true};await assert.rejects(adapter.status('fixture'),/incompatible held status/);
});

test('held submit defers the original job without touching source or provider mutations',async t=>{
 const f=fixture(t),calls=[];f.db.prepare("UPDATE processing_attempts SET submission_phase='initialized' WHERE id=?").run(f.attempt.id);
 const adapter={status:async()=>({status:'queued_upstream',held:true,heldReason:'option_evidence_invalid'}),remove:async()=>calls.push('remove'),initialize:async()=>calls.push('initialize'),upload:async()=>calls.push('upload'),commit:async()=>calls.push('commit')};
 const deps={processing:f.processing,storage:{resolve(){assert.fail('held task must not touch source')}},config:{},adapterFactory:()=>adapter};
 for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);assert.equal(await processOne(deps,'held-worker'),true);}
 const job=f.db.prepare("SELECT status,attempt_count,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id),attempt=f.processing.getAttempt(f.attempt.id);
 assert.deepEqual(calls,[]);assert.equal(job.status,'pending');assert.equal(job.attempt_count,0);assert.equal(job.error_code,'provider_execution_held');assert.equal(attempt.errorCode,'provider_execution_held');assert.equal(attempt.errorMessage,'Processing options need inspection; Viewer will keep checking this job.');assert.equal(processingJobCounts(f.db).observationWarnings,1);assert.equal(processingJobCounts(f.db).failed,0);f.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(attempt.projectId||f.task.projectId);assert.equal(processingJobCounts(f.db).observationWarnings,0);f.db.prepare("UPDATE projects SET status='active' WHERE id=?").run(attempt.projectId||f.task.projectId);assert.notEqual(attempt.status,'failed');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(attempt.id).n,0);
});

test('held reconciliation keeps polling and clears the notice after recovery',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(f.attempt.id);f.db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(f.attempt.id);f.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('poll',?,'reconcile','pending','2000','2000','2000')").run(f.attempt.id);
 let held=true;const adapter={status:async()=>({status:'running',progress:0,held,heldReason:'option_evidence_invalid'}),output:async()=>({lines:[],nextLine:0})};const deps={processing:f.processing,config:{},adapterFactory:()=>adapter};
 await processOne(deps,'held-worker');assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,'provider_execution_held');assert.equal(f.processing.getAttempt(f.attempt.id).errorMessage,'Processing options need inspection; Viewer will keep checking this job.');assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
 held=false;f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND status='pending'").run(f.attempt.id);await processOne(deps,'held-worker');assert.equal(f.processing.getAttempt(f.attempt.id).errorCode,null);assert.equal(processingJobCounts(f.db).observationWarnings,0);assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');
});

test('unavailable submit status never becomes terminal after repeated polls',async t=>{const f=fixture(t);let count=0;const adapter={status:async()=>{count++;if(count<=7)throw Error('offline');return{status:'running',held:true}}};const deps={processing:f.processing,storage:{resolve(){assert.fail('source touched')}},config:{},adapterFactory:()=>adapter};for(let i=0;i<8;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);await processOne(deps,'held-worker');}const job=f.db.prepare("SELECT status,attempt_count,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);assert.equal(job.status,'pending');assert.equal(job.attempt_count,0);assert.equal(job.error_code,'provider_execution_held');assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');});

test('a task becoming held during source validation is not removed or restarted',async t=>{const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-held-race-')),file=path.join(root,'photo.jpg');fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let reads=0,mutations=0;const adapter={status:async()=>++reads===1?{status:'queued_upstream',progress:0,imagesCount:0}:{status:'running',held:true},remove:async()=>mutations++,initialize:async()=>mutations++,upload:async()=>mutations++,commit:async()=>mutations++};const deps={processing:f.processing,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};await processOne(deps,'held-worker');const job=f.db.prepare("SELECT status,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);assert.equal(reads,2);assert.equal(mutations,0);assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_execution_held');});

test('known held or unobservable execution cannot be locally cancelled or retried',t=>{const f=fixture(t);for(const code of ['provider_execution_held','provider_submission_observation_unavailable','staged_commitment_unavailable']){f.db.prepare("UPDATE processing_attempts SET status='running',error_code=? WHERE id=?").run(code,f.attempt.id);assert.throws(()=>f.processing.cancelAttempt(f.attempt.id,'ops:test'),{code:'provider_execution_unresolved'});assert.equal(f.processing.getAttempt(f.attempt.id).status,'running');f.db.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(f.attempt.id);assert.equal(f.processing.retryAttempt(f.attempt.id,'ops:test'),null);assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.attempt.providerId,options:{}}),{code:'provider_execution_unresolved'});}});

test('ambiguous queued provider task is never removed or recreated',async t=>{const f=fixture(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-held-remove-')),file=path.join(root,'photo.jpg');fs.writeFileSync(file,'x');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let removes=0,initializations=0;const adapter={status:async()=>({status:'queued_upstream',progress:0,imagesCount:0}),remove:async()=>{removes++;throw Object.assign(Error('held'),{status:409})},initialize:async()=>initializations++};const deps={processing:f.processing,storage:{resolve:()=>file,requireProcessingHeadroom:()=>{}},config:{},adapterFactory:()=>adapter};for(let i=0;i<7;i++){f.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(f.attempt.id);await processOne(deps,'held-worker');}const job=f.db.prepare("SELECT status,attempt_count,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);assert.equal(removes,0);assert.equal(initializations,0);assert.equal(job.status,'pending');assert.equal(job.attempt_count,0);assert.equal(job.error_code,'provider_submission_observation_unavailable');assert.notEqual(f.processing.getAttempt(f.attempt.id).status,'failed');});

test('missing upstream task after initialization stays unresolved and is never recreated',async t=>{for(const phase of ['initializing','initialized','uploading','uploading_auxiliary','uploaded','committing','committed']){const f=fixture(t);f.db.prepare('UPDATE processing_attempts SET submission_phase=? WHERE id=?').run(phase,f.attempt.id);let mutations=0;const adapter={status:async()=>{throw Object.assign(Error('missing'),{code:'provider_task_not_found'})},remove:async()=>mutations++,initialize:async()=>mutations++,upload:async()=>mutations++,commit:async()=>mutations++};await processOne({processing:f.processing,storage:{resolve(){assert.fail('source touched')}},config:{},adapterFactory:()=>adapter},'held-worker');const job=f.db.prepare("SELECT status,attempt_count,error_code FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(f.attempt.id);assert.equal(mutations,0,phase);assert.equal(job.status,'pending',phase);assert.equal(job.attempt_count,0,phase);assert.equal(job.error_code,['uploading','uploading_auxiliary'].includes(phase)?'provider_upload_acceptance_unknown':'provider_submission_observation_unavailable',phase);}});
