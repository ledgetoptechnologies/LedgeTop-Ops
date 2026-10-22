'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {MeasurementRepository}=require('../server/measurementRepository');
const {MeasurementCalculationRepository}=require('../server/measurementCalculationRepository');
const {EphemeralMeasurementRepository}=require('../server/ephemeralMeasurementRepository');
const {createEphemeralMeasurementApi}=require('../server/ephemeralMeasurementApi');
const {resolveEphemeralAccess,localAccess}=require('../server/ephemeralMeasurementAccess');
const {processOneEphemeralMeasurement}=require('../server/ephemeralMeasurementWorker');
const {validateCalculationRequest}=require('../server/measurementCalculationApi');
const auth=require('../server/auth');
function fixture(t){
 const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');applyMigrations(database);t.after(()=>database.close());const repository=new ViewerRepository(database),processing=new ProcessingRepository(database),jobs=new EphemeralMeasurementRepository(database);
 const model=repository.upsertModelVersion({provider:'webodm',providerModelId:crypto.randomUUID(),providerVersionId:'v1',displayName:'Pile',status:'ready',assets:[{kind:'dsm',format:'tif',published:true,rootKey:'models',relativePath:'dsm.tif',sha256:'a'.repeat(64),byteSize:1}]});
 const share=repository.createPublicShare({modelId:model.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true,measure:true}});
 const token=auth.sign({kind:'share-asset',shareId:share.id,modelId:model.id},3600000),page=crypto.randomBytes(32).toString('base64url');
 const measurement={id:crypto.randomUUID(),name:'Pile',kind:'polygon',collection:'map',vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
 const request={revision:1,method:'surface-cut-fill',sourceAssetId:model.activeVersion.assets[0].id,reference:{type:'custom',elevationM:0},sourceVerticalUnit:'m'};
 return{database,repository,processing,jobs,model,share,token,page,measurement,request};
}
async function server(t,f,{preflightRaster=async()=>{},validator={allows:async()=>true}}={}){
 const app=express();app.use(express.json());app.use('/temporary',createEphemeralMeasurementApi(f.repository,{preflightRaster,validator}));app.use((error,_req,res,_next)=>res.status(error.status||500).json({code:error.code}));
 const s=await new Promise(resolve=>{const handle=app.listen(0,'127.0.0.1',()=>resolve(handle));});t.after(()=>new Promise(resolve=>s.close(resolve)));
 return(path,method='GET',body,overrides={})=>fetch(`http://127.0.0.1:${s.address().port}/temporary${path}`,{method,headers:{Authorization:`Bearer ${f.token}`,'X-Measurement-Page':f.page,'X-Measurement-Model-Version':f.model.activeVersion.id,'Content-Type':'application/json',...overrides},...(body?{body:JSON.stringify(body)}:{})});
}
test('public page can calculate native raster without a personal row; new page cannot discover old results',async t=>{
 const f=fixture(t),call=await server(t,f),caps=await(await call('/capabilities')).json();assert.equal(caps.capabilities.temporaryCalculations,true);assert.equal(caps.capabilities.rasterCalculations,true);assert.equal(caps.modelVersionId,f.model.activeVersion.id);
 assert.equal((await call('/calculations','POST',{measurement:f.measurement,request:{...f.request,method:'closed-mesh'}})).status,403);
 const created=await call('/calculations','POST',{measurement:f.measurement,request:f.request});assert.equal(created.status,202);const job=(await created.json()).calculation;
 assert.equal(job.measurementId,f.measurement.id);assert.equal(job.revision,1);assert.equal(job.parameters.sourceAssetId,f.request.sourceAssetId);assert.equal(job.request,undefined);assert.equal(job.authority,undefined);
 const {measurementGeometryHash}=await import('../measurement-surface-client.mjs');assert.equal(job.geometryHash,await measurementGeometryHash(f.measurement));
 assert.equal((await call('/capabilities','GET',null,{'X-Measurement-Model-Version':crypto.randomUUID()})).status,403);assert.equal((await call(`/calculations/${job.id}`,'GET',null,{'X-Measurement-Model-Version':''})).status,403);
 assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM private_measurements').get().n,0);
 const serialized=JSON.stringify(f.database.prepare('SELECT * FROM ephemeral_measurement_jobs').get());assert.equal(serialized.includes(f.page),false);assert.equal(serialized.includes(f.token),false);
 const otherPage={'X-Measurement-Page':crypto.randomBytes(32).toString('base64url')};assert.deepEqual((await(await call('/calculations','GET',null,otherPage)).json()).calculations,[]);assert.equal((await call(`/calculations/${job.id}`,'GET',null,otherPage)).status,404);assert.equal((await call(`/calculations/${job.id}`,'DELETE',null,otherPage)).status,404);
 assert.equal((await call('/calculations','POST',{measurement:{...f.measurement,vertices:[[0,0,0],[2,0,0],[2,2,0]]},request:f.request})).status,429);
 const claimed=f.jobs.claim('worker');assert.ok(claimed);assert.equal(f.jobs.finish(claimed,'worker',{method:'surface-cut-fill',cutM3:1,source:{modelVersionId:f.model.activeVersion.id}}),1);
 assert.equal((await(await call(`/calculations/${job.id}`)).json()).calculation.result.cutM3,1);
 f.jobs.prune(Date.now()+16*60_000);assert.equal((await call(`/calculations/${job.id}`)).status,404);
});
test('temporary access checks exact public grant/version, permissions, token expiry and async source authorization',async t=>{
 const f=fixture(t);
 await assert.rejects(resolveEphemeralAccess(auth.sign({kind:'share-asset',shareId:f.share.id,modelId:f.model.id},-1),f.repository),{code:'temporary_measurement_access_unavailable'});
 await assert.rejects(resolveEphemeralAccess(f.token,f.repository,{validator:{allows:async()=>false}}),{code:'temporary_measurement_access_unavailable'});
 await assert.rejects(resolveEphemeralAccess(f.token,f.repository,{validator:{allows:async()=>{f.database.prepare('UPDATE public_shares SET revoked_at=?').run(new Date().toISOString());return true;}}}),{code:'temporary_measurement_access_unavailable'});
 f.database.prepare('UPDATE public_shares SET revoked_at=NULL,permissions_json=?').run(JSON.stringify({view:true,measure:false}));await assert.rejects(resolveEphemeralAccess(f.token,f.repository),{code:'temporary_measurement_access_unavailable'});
});
test('preflight grant revocation prevents queue admission and unregistered/unpublished sources are refused',async t=>{
 const f=fixture(t),call=await server(t,f,{preflightRaster:async()=>{f.database.prepare('UPDATE public_shares SET revoked_at=?').run(new Date().toISOString());}});
 const response=await call('/calculations','POST',{measurement:f.measurement,request:f.request});assert.equal(response.status,403);assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ephemeral_measurement_jobs').get().n,0);
 f.database.prepare('UPDATE public_shares SET revoked_at=NULL').run();f.database.prepare('UPDATE model_assets SET published=0').run();assert.equal((await call('/calculations','POST',{measurement:f.measurement,request:f.request})).status,422);
});
test('temporary and private jobs share singleton, heavy-lane exclusion and global queue ceiling',async t=>{
 const f=fixture(t),access=await resolveEphemeralAccess(f.token,f.repository),measurement={...f.measurement,modelId:f.model.id,modelVersionId:f.model.activeVersion.id,revision:1},request=validateCalculationRequest(f.request,measurement,f.model.activeVersion);
 const first=f.jobs.enqueue(access,auth.hashToken(f.page),measurement,request),privateJobs=new MeasurementCalculationRepository(f.database),records=new MeasurementRepository(f.database),principal={modelId:f.model.id,modelVersionId:f.model.activeVersion.id,audience:'ops',subject:'staff'};
 const own=records.create(principal,{...f.measurement,id:crypto.randomUUID()}).measurement;privateJobs.enqueue(own,{...request,authority:{}});
 const claimed=f.jobs.claim('temporary');assert.ok(claimed);assert.equal(privateJobs.claim('private'),null);assert.equal(f.processing.measurementCalculationActive(),true);f.jobs.cancel(access.scopeKey,auth.hashToken(f.page),first.id);
 const privateClaim=privateJobs.claim('private');assert.ok(privateClaim);assert.equal(f.jobs.claim('temporary'),null);privateJobs.finish(privateClaim,'private',{});
 for(let i=0;i<20;i++)f.jobs.enqueue(access,auth.hashToken(f.page),{...measurement,id:crypto.randomUUID()},request);
 assert.throws(()=>privateJobs.enqueue(own,request),{code:'measurement_queue_full'});assert.throws(()=>f.jobs.enqueue(access,auth.hashToken(f.page),{...measurement,id:crypto.randomUUID()},request),{code:'measurement_queue_full'});
});
test('ephemeral worker rejects revoked grants and discards results after async source permission loss',async t=>{
 const f=fixture(t),access=await resolveEphemeralAccess(f.token,f.repository),measurement={...f.measurement,modelId:f.model.id,modelVersionId:f.model.activeVersion.id,revision:1},request=validateCalculationRequest(f.request,measurement,f.model.activeVersion),pageHash=auth.hashToken(f.page);
 const queued=f.jobs.enqueue(access,pageHash,measurement,request);let checks=0,runs=0;
 await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>'/trusted/dsm.tif'},validator:{allows:async()=>++checks===1},runCalculation:async(_p,_r,controls)=>{runs++;assert.equal(controls.isLive(),true);return{cutM3:1};}},'worker');
 assert.equal(runs,1);assert.equal(f.jobs.get(access.scopeKey,pageHash,queued.id).result,null);assert.equal(f.jobs.get(access.scopeKey,pageHash,queued.id).errorCode,'measurement_authorization_lost');
 const next=f.jobs.enqueue(access,pageHash,measurement,request);f.database.prepare('UPDATE public_shares SET revoked_at=?').run(new Date().toISOString());
 await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>'/trusted/dsm.tif'},runCalculation:async()=>{runs++;}},'worker');assert.equal(runs,1);assert.equal(f.jobs.get(access.scopeKey,pageHash,next.id).result,null);
});
test('unverified signed-in identities can use temporary raster without personal persistence',async t=>{
 const f=fixture(t),token=crypto.randomBytes(32).toString('base64url');f.repository.createViewerSession({tokenHash:auth.hashToken(token),modelId:f.model.id,modelVersionId:f.model.activeVersion.id,subject:'legacy-client',audience:'client',permissions:{view:true,measure:true,personalMeasurements:false},expiresAt:new Date(Date.now()+3600000).toISOString()});
 const access=await resolveEphemeralAccess(token,f.repository);assert.equal(access.authority.kind,'viewer');assert.ok(localAccess(access.authority,f.repository));f.database.prepare('UPDATE viewer_sessions SET permissions_json=?').run(JSON.stringify({view:true,measure:false}));assert.equal(localAccess(access.authority,f.repository),null);
});

test('public project token stays tied to exact active task output and fails after project-share revocation',async t=>{
 const f=fixture(t),project=f.processing.createProject({displayName:'Public project'}),dataset=f.processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
 f.database.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?").run('b'.repeat(64),new Date().toISOString(),dataset.id);
 const task=f.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Pile'}),provider=f.processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=f.processing.createAttempt({taskId:task.id,providerId:provider.id,options:{},createdBy:'staff'});
 f.processing.setAttemptResult(attempt.id,f.model.id,f.model.activeVersion.id);f.processing.registerModelOutput({versionId:f.model.activeVersion.id,modelId:f.model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:'models',relativePath:'output',storageMode:'external_reference',byteSize:1,assetCount:1});
 const now=new Date().toISOString();f.database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now,now,attempt.id);f.database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id,f.model.id,now,task.id);f.database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now,f.model.activeVersion.id);
 const share=f.repository.createProjectShare({projectId:project.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true,measure:true}}),payload={kind:'project-share-asset',shareId:share.id,projectId:project.id,taskId:task.id,modelId:f.model.id,modelVersionId:f.model.activeVersion.id};
 const token=auth.sign(payload,3600000),access=await resolveEphemeralAccess(token,f.repository);assert.equal(access.authority.kind,'project-share-asset');
 await assert.rejects(resolveEphemeralAccess(auth.sign({...payload,taskId:crypto.randomUUID()},3600000),f.repository),{code:'temporary_measurement_access_unavailable'});
 await assert.rejects(resolveEphemeralAccess(auth.sign({...payload,modelVersionId:crypto.randomUUID()},3600000),f.repository),{code:'temporary_measurement_access_unavailable'});
 f.database.prepare('UPDATE public_project_shares SET revoked_at=? WHERE id=?').run(now,share.id);assert.equal(localAccess(access.authority,f.repository),null);
});

test('ephemeral worker cannot read changed source; leases and page TTL do not replay interrupted jobs',async t=>{
 const f=fixture(t),access=await resolveEphemeralAccess(f.token,f.repository),measurement={...f.measurement,modelId:f.model.id,modelVersionId:f.model.activeVersion.id,revision:1},request=validateCalculationRequest(f.request,measurement,f.model.activeVersion),pageHash=auth.hashToken(f.page);
 const first=f.jobs.enqueue(access,pageHash,measurement,request);f.database.prepare('UPDATE model_assets SET sha256=?').run('b'.repeat(64));let runs=0;
 await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>'/trusted/dsm.tif'},runCalculation:async()=>{runs++;}},'worker');assert.equal(runs,0);assert.equal(f.jobs.get(access.scopeKey,pageHash,first.id).errorCode,'measurement_source_changed');
 const second=f.jobs.enqueue(access,pageHash,measurement,request),claimed=f.jobs.claim('worker');assert.ok(claimed);f.database.prepare('UPDATE ephemeral_measurement_jobs SET lease_expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),second.id);assert.equal(f.jobs.claim('replacement'),null);assert.equal(f.jobs.get(access.scopeKey,pageHash,second.id).errorCode,'worker_interrupted');assert.equal(f.jobs.finish(claimed,'worker',{cutM3:3}),false);
 const third=f.jobs.enqueue(access,pageHash,measurement,request);f.database.prepare('UPDATE ephemeral_measurement_jobs SET expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),third.id);assert.equal(f.jobs.claim('worker'),null);assert.equal(f.jobs.get(access.scopeKey,pageHash,third.id),null);
});

test('shared job lane waits for existing local processing work and direct disabled worker stays idle',async t=>{
 const f=fixture(t),access=await resolveEphemeralAccess(f.token,f.repository),measurement={...f.measurement,modelId:f.model.id,modelVersionId:f.model.activeVersion.id,revision:1},request=validateCalculationRequest(f.request,measurement,f.model.activeVersion);
  f.jobs.enqueue(access,auth.hashToken(f.page),measurement,request);
 const operation=f.processing.createImportPreviewOperation({request:{},subject:'staff'});f.database.prepare("UPDATE dataset_operations SET status='leased',lease_owner='other',lease_expires_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),operation.id);assert.equal(f.jobs.claim('measurement'),null);f.database.prepare("UPDATE dataset_operations SET status='cancelled' WHERE id=?").run(operation.id);
 // Existing private API queue admission and worker execution share a durable
 // reservation; the processing repository must also refuse heavy lanes.
 const claimed=f.jobs.claim('measurement');assert.ok(claimed);assert.equal(f.processing.measurementCalculationActive(),true);
 const {processOneMeasurementCalculation}=require('../server/measurementCalculationWorker');assert.equal(await processOneMeasurementCalculation({...f,config:{measurementCalculationsEnabled:false}},'disabled'),false);
});

test('polygon-filtered page list can recover an older active job beyond twenty newer terminal jobs',async t=>{
 const f=fixture(t),call=await server(t,f),access=await resolveEphemeralAccess(f.token,f.repository),pageHash=auth.hashToken(f.page),measurement={...f.measurement,modelId:f.model.id,modelVersionId:f.model.activeVersion.id,revision:1},request=validateCalculationRequest(f.request,measurement,f.model.activeVersion);
 const original=f.jobs.enqueue(access,pageHash,measurement,request);f.database.prepare('UPDATE ephemeral_measurement_jobs SET created_at=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),original.id);
 for(let i=0;i<21;i++){const job=f.jobs.enqueue(access,pageHash,{...measurement,id:crypto.randomUUID()},request);f.jobs.cancel(access.scopeKey,pageHash,job.id);}
 assert.equal(f.jobs.list(access.scopeKey,pageHash).some(job=>job.id===original.id),false);
 const selected=(await(await call(`/calculations?measurementId=${measurement.id}`)).json()).calculations;assert.deepEqual(selected.map(job=>job.id),[original.id]);
 assert.equal((await call('/calculations?measurementId=invalid')).status,400);
 assert.deepEqual((await(await call(`/calculations?measurementId=${crypto.randomUUID()}`)).json()).calculations,[]);
});

test('actual temporary surface client and calculator create, poll and recover server results without personal persistence',async t=>{
 const f=fixture(t),call=await server(t,f),{createMeasurementSurfaceClient}=await import('../measurement-surface-client.mjs'),{createServerSurfaceCalculator}=await import('../measurement-server-surface.mjs');
 const context=()=>({modelId:f.model.id,modelVersionId:f.model.activeVersion.id,temporary:true});let creates=0,runs=0;
 const request=createMeasurementSurfaceClient({token:()=>f.token,context,fetcher:async(path,options)=>{if(options.method==='POST')creates++;return call(path.replace('/api/v1/measurements/temporary',''),options.method,options.body?JSON.parse(options.body):undefined,options.headers);}});
 const calculate=createServerSurfaceCalculator({request,wait:async()=>{await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>'/trusted/dsm.tif'},validator:{allows:async()=>true},runCalculation:async(_path,job,controls)=>{runs++;assert.equal(controls.isLive(),true);return{method:'surface-cut-fill',cutM3:12,fillM3:0,netM3:12,coverage:1,source:{assetId:job.source.id,kind:job.source.kind,modelVersionId:job.modelVersionId},reference:job.reference};}},'integration');}});
 const options={reference:{type:'custom',elevationM:0},confirmMeters:true};const first=await calculate(f.measurement,options);assert.equal(first.cutM3,12);assert.equal(creates,1);assert.equal(runs,1);
 const recovered=await calculate(f.measurement,options);assert.equal(recovered.calculationJobId,first.calculationJobId);assert.equal(creates,1);assert.equal(runs,1);
 assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM private_measurements').get().n,0);assert.equal(JSON.parse(f.database.prepare('SELECT request_json FROM ephemeral_measurement_jobs').get().request_json).ephemeralAuthority,undefined);
});
