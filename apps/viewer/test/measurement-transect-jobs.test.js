'use strict';
// Exact-runtime tests: only shipped server/numerical dependencies are imported.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {MeasurementRepository}=require('../server/measurementRepository');
const {MeasurementCalculationRepository}=require('../server/measurementCalculationRepository');
const {EphemeralMeasurementRepository}=require('../server/ephemeralMeasurementRepository');
const {resolveEphemeralAccess}=require('../server/ephemeralMeasurementAccess');
const {createMeasurementApi}=require('../server/measurementApi');
const {validateCalculationRequest}=require('../server/measurementCalculationApi');
const {validateTransectRequest}=require('../server/measurementTransectRequest');
const {processOneMeasurementCalculation}=require('../server/measurementCalculationWorker');
const {processOneEphemeralMeasurement}=require('../server/ephemeralMeasurementWorker');
const auth=require('../server/auth');

async function fixture(t,{temporary=false,real=false}={}){
 const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');applyMigrations(database);t.after(()=>database.close());
 const repository=new ViewerRepository(database),processing=new ProcessingRepository(database),measurements=new MeasurementRepository(database),jobs=new MeasurementCalculationRepository(database),ephemeral=new EphemeralMeasurementRepository(database);
 let file='/trusted/dsm.tif',bytes=Buffer.from('fixture');
 if(real){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-profile-job-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));file=path.join(directory,'surface.tif');const {writeArrayBuffer}=await import('geotiff');bytes=Buffer.from(writeArrayBuffer(Float64Array.from(Array(16).fill(5)),{width:4,height:4,ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,4,0],ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001,GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1}));fs.writeFileSync(file,bytes);}
 const model=repository.upsertModelVersion({provider:'webodm',providerModelId:crypto.randomUUID(),providerVersionId:'v1',displayName:'Pile',status:'ready',assets:[{kind:'dsm',format:'tif',rootKey:'models',relativePath:'surface.tif',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,published:true}]});
 const principal={modelId:model.id,modelVersionId:model.activeVersion.id,audience:'client',subject:'profile-owner'},document={id:crypto.randomUUID(),name:'Pile',kind:'polygon',collection:'map',vertices:[[0,0,0],[4,0,0],[4,4,0],[0,4,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
 let token=crypto.randomBytes(32).toString('base64url'),share,access;const page=crypto.randomBytes(32).toString('base64url'),pageHash=auth.hashToken(page);
 if(temporary){share=repository.createPublicShare({modelId:model.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true,measure:true}});token=auth.sign({kind:'share-asset',shareId:share.id,modelId:model.id},3600000);access=await resolveEphemeralAccess(token,repository);}else repository.createViewerSession({...principal,tokenHash:auth.hashToken(token),permissions:{view:true,measure:true,personalMeasurements:true},expiresAt:new Date(Date.now()+3600000).toISOString()});
 let measurement=temporary?{...document,modelId:model.id,modelVersionId:model.activeVersion.id,revision:1}:measurements.create(principal,document).measurement;
 const parentBody={revision:1,method:'surface-cut-fill',sourceAssetId:model.activeVersion.assets[0].id,reference:{type:'custom',elevationM:0,offsetM:1}},parentRequest=validateCalculationRequest(parentBody,measurement,model.activeVersion);
 if(!temporary)parentRequest.authority={viewerHash:auth.hashToken(token),subject:principal.subject,audience:principal.audience,scope:'personal-raster'};
 const parent=temporary?ephemeral.enqueue(access,pageHash,measurement,parentRequest):jobs.enqueue(measurement,parentRequest),claimed=temporary?ephemeral.claim('seed'):jobs.claim('seed');
 const parentResult=real?await(await import('../server/measurementRasterCalculation.mjs')).calculateNativeRaster(file,parentRequest):{method:'surface-cut-fill',status:'complete',calculationOrigin:'server-native-raster',cutM3:64,fillM3:0,netM3:64,coverage:1,reference:parentRequest.reference,source:{assetId:parentRequest.source.id,kind:'dsm',sha256:parentRequest.source.sha256,modelVersionId:model.activeVersion.id},preview:{samples:[],referencePatches:[[[0,0,1],[4,0,1],[4,4,1]],[[0,0,1],[4,4,1],[0,4,1]]]}};
 if(temporary)ephemeral.finish(claimed,'seed',parentResult);else{jobs.finish(claimed,'seed',parentResult);const{preview,...result}=parentResult;measurement=measurements.update(principal,document.id,{...document,revision:1,results:{...result,calculationJobId:parent.id}});}
 const body={revision:measurement.revision,method:'surface-transect',parentCalculationId:parent.id,line:{start:[.25,2.5],end:[3.75,2.5]}};
 return{database,repository,processing,measurements,jobs,ephemeral,model,principal,document,measurement,token,page,pageHash,share,access,temporary,file,parent,parentRequest,parentResult,body};
}
async function serve(t,f,preflightRaster=async()=>{}){
 const app=express();app.use(express.json());app.use('/api/v1/measurements',createMeasurementApi(f.repository,{preflightRaster}));app.use((error,_req,res,_next)=>res.status(error.status||500).json({code:error.code||'unexpected'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/v1/measurements`;
 return(suffix='',method='GET',body,headers={})=>fetch(base+suffix,{method,headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json',...(f.temporary?{'X-Measurement-Page':f.page,'X-Measurement-Model-Version':f.model.activeVersion.id}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
}
const route=f=>f.temporary?'/temporary/calculations':`/${f.measurement.id}/calculations`;
const payload=(f,body=f.body,document=f.document)=>f.temporary?{measurement:document,request:body}:body;
const profileResult=request=>({method:'surface-transect',status:'calculated',parentCalculationId:request.parentCalculationId,baseHash:request.baseHash,line:request.line,reference:request.reference,source:{assetId:request.source.id,kind:request.source.kind,sha256:request.source.sha256,modelVersionId:request.modelVersionId},segments:[]});

test('owned client transect copies only trusted parent source/base and leaves saved volume and revision unchanged',async t=>{
 const f=await fixture(t),call=await serve(t,f),caps=await(await call('/capabilities')).json();assert.equal(caps.capabilities.transectCalculations,true);assert.equal(caps.capabilities.serverCalculations,false);
 const response=await call(route(f),'POST',payload(f));assert.equal(response.status,202);const job=(await response.json()).calculation;assert.equal(job.method,'surface-transect');assert.equal(job.parameters.parentCalculationId,f.parent.id);assert.equal(job.parameters.parentRevision,1);assert.equal(job.parameters.baseHash,crypto.createHash('sha256').update(JSON.stringify(f.parentResult.preview.referencePatches)).digest('hex'));assert.equal(job.request,undefined);
 const stored=JSON.parse(f.database.prepare('SELECT request_json FROM measurement_calculation_jobs WHERE id=?').get(job.id).request_json);assert.deepEqual(stored.referencePatches,f.parentResult.preview.referencePatches);assert.deepEqual(stored.source,f.parentRequest.source);assert.equal(stored.authority.scope,'personal-raster');assert.equal(stored.authority.adminHash,undefined);assert.equal(stored.authority.viewerHash,auth.hashToken(f.token));
 let runs=0;await processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>f.file},runCalculation:async(_p,r,controls)=>{runs++;assert.equal(controls.isLive(),true);return profileResult(r);}},'profile');assert.equal(runs,1);assert.equal(f.jobs.get(f.measurement.id,job.id).status,'complete');assert.equal(f.measurements.get(f.principal,f.measurement.id).revision,2);assert.deepEqual(f.measurements.get(f.principal,f.measurement.id).results,f.measurement.results);assert.deepEqual(f.jobs.get(f.measurement.id,f.parent.id).result,f.parentResult);
 assert.equal((await call(route(f)+`/${job.id}`)).status,200);assert.ok((await(await call(route(f))).json()).calculations.some(j=>j.id===job.id));
 const queued=(await(await call(route(f),'POST',f.body)).json()).calculation;assert.equal((await call(route(f)+`/${queued.id}`,'DELETE')).status,204);assert.equal(f.jobs.get(f.measurement.id,queued.id).status,'cancelled');
});

test('profile API rejects arbitrary source/base, invalid line, non-native parent and other-person polygons',async t=>{
 const f=await fixture(t),call=await serve(t,f);
 for(const body of [{...f.body,sourceAssetId:f.parentRequest.source.id},{...f.body,referencePatches:[]},{...f.body,parentCalculationId:undefined},{...f.body,line:{start:[0,0],end:[0,0]}},{...f.body,parentCalculationId:crypto.randomUUID()}])assert.ok([400,422].includes((await call(route(f),'POST',body)).status));
 assert.equal((await call(route(f),'POST',{...f.body,method:'closed-mesh'})).status,403);
 const other=f.measurements.create({...f.principal,subject:'another-person'},{...f.document,id:crypto.randomUUID()}).measurement;assert.equal((await call(`/${other.id}/calculations`,'POST',{...f.body,revision:other.revision})).status,404);
 const saved=f.database.prepare('SELECT result_json FROM measurement_calculation_jobs WHERE id=?').get(f.parent.id).result_json;f.database.prepare('UPDATE measurement_calculation_jobs SET result_json=? WHERE id=?').run(JSON.stringify({...f.parentResult,calculationOrigin:'browser'}),f.parent.id);assert.equal((await call(route(f),'POST',f.body)).status,422);f.database.prepare('UPDATE measurement_calculation_jobs SET result_json=? WHERE id=?').run(saved,f.parent.id);
 f.database.prepare("UPDATE measurement_calculation_jobs SET status='failed' WHERE id=?").run(f.parent.id);assert.equal((await call(route(f),'POST',f.body)).status,422);assert.equal(f.jobs.list(f.measurement.id).length,1);
});

test('edited geometry or source identity cannot reuse an attached parent; unchanged rename can',async t=>{
 const f=await fixture(t),call=await serve(t,f);
 let current=f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:2,name:'Renamed',results:f.measurement.results});assert.equal((await call(route(f),'POST',{...f.body,revision:3})).status,202);const queued=f.jobs.list(current.id).find(j=>j.method==='surface-transect');f.jobs.cancel(current.id,queued.id);
 f.database.prepare('UPDATE model_assets SET sha256=?').run('b'.repeat(64));assert.equal((await call(route(f),'POST',{...f.body,revision:3})).status,409);f.database.prepare('UPDATE model_assets SET sha256=?').run(f.parentRequest.source.sha256);
 current=f.measurements.update(f.principal,current.id,{...f.document,revision:3,results:current.results,vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]]});assert.equal((await call(route(f),'POST',{...f.body,revision:4})).status,409);
});

test('profile preflight rechecks permissions and frozen parent evidence after awaited IO',async t=>{
 const f=await fixture(t),call=await serve(t,f,async()=>{f.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());});assert.equal((await call(route(f),'POST',f.body)).status,403);assert.equal(f.jobs.list(f.measurement.id).length,1);
 const g=await fixture(t),changed=await serve(t,g,async()=>{const result=structuredClone(g.parentResult);result.preview.referencePatches[0][0][2]=7;g.database.prepare('UPDATE measurement_calculation_jobs SET result_json=? WHERE id=?').run(JSON.stringify(result),g.parent.id);});assert.equal((await changed(route(g),'POST',g.body)).status,409);assert.equal(g.jobs.list(g.measurement.id).length,1);
});

test('worker discards profiles after parent changes, authorization loss, or measurement edits',async t=>{
 for(const change of ['parent','access','edit']){
  const f=await fixture(t),call=await serve(t,f),job=(await(await call(route(f),'POST',f.body)).json()).calculation;let ran=0;
  await processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>f.file},runCalculation:async(_p,r,controls)=>{ran++;if(change==='parent')f.database.prepare("UPDATE measurement_calculation_jobs SET status='failed' WHERE id=?").run(f.parent.id);else if(change==='access')f.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());else f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:2,name:'Updated',results:f.measurement.results});assert.equal(controls.isLive(),false);return profileResult(r);}},'profile');
  assert.equal(ran,1);assert.equal(f.jobs.get(f.measurement.id,job.id).result,null);assert.notEqual(f.jobs.get(f.measurement.id,job.id).status,'complete');
 }
});

test('bounded terminal retention preserves the attached native volume parent across repeated profiles',async t=>{
 const f=await fixture(t),version=f.model.activeVersion;
 for(let i=0;i<25;i++){const request=validateTransectRequest(f.body,f.measurement,version,f.jobs.parent(f.measurement.id,f.parent.id)),job=f.jobs.enqueue(f.measurement,request),claimed=f.jobs.claim('retention');assert.equal(job.id,claimed.id);f.jobs.finish(claimed,'retention',profileResult(request));}
 assert.equal(f.jobs.list(f.measurement.id).length,20);assert.equal(f.jobs.get(f.measurement.id,f.parent.id).status,'complete');assert.equal(f.measurements.get(f.principal,f.measurement.id).revision,2);
});

test('temporary profiles require same page, parent geometry, published source and expire with their parent',async t=>{
 const f=await fixture(t,{temporary:true}),call=await serve(t,f);assert.equal((await(await call('/temporary/capabilities')).json()).capabilities.transectCalculations,true);
 assert.equal((await call(route(f),'POST',payload(f),{'X-Measurement-Page':crypto.randomBytes(32).toString('base64url')})).status,422);
 assert.equal((await call(route(f),'POST',payload(f,f.body,{...f.document,vertices:[[0,0,0],[2,0,0],[2,2,0]]}))).status,409);
 const response=await call(route(f),'POST',payload(f));assert.equal(response.status,202);const job=(await response.json()).calculation;assert.ok(Date.parse(job.expiresAt)<=Date.parse(f.parent.expiresAt));assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM private_measurements').get().n,0);
 await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>f.file},validator:{allows:async()=>true},runCalculation:async(_p,r,c)=>{assert.ok(c.isLive());return profileResult(r);}},'temporary');assert.equal(f.ephemeral.get(f.access.scopeKey,f.pageHash,job.id).status,'complete');
 f.database.prepare('UPDATE ephemeral_measurement_jobs SET expires_at=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),f.parent.id);assert.equal((await call(route(f),'POST',payload(f))).status,422);
});

test('temporary profile worker stops when public raster publication is withdrawn before or during work',async t=>{
 for(const when of ['before','during']){const f=await fixture(t,{temporary:true}),call=await serve(t,f),job=(await(await call(route(f),'POST',payload(f))).json()).calculation;let ran=0;
  if(when==='before')f.database.prepare('UPDATE model_assets SET published=0').run();
  await processOneEphemeralMeasurement({...f,config:{},storage:{resolve:()=>f.file},validator:{allows:async()=>true},runCalculation:async(_p,r,c)=>{ran++;f.database.prepare('UPDATE model_assets SET published=0').run();assert.equal(c.isLive(),false);return profileResult(r);}},'temporary');
  assert.equal(ran,when==='before'?0:1);assert.equal(f.ephemeral.get(f.access.scopeKey,f.pageHash,job.id).result,null);assert.equal((await call(route(f),'POST',payload(f))).status,422);
 }
});

test('HTTP admitted profile executes the shipped child against an actual native TIFF and preserves volume',async t=>{
 const f=await fixture(t,{real:true}),call=await serve(t,f,request=>import('../server/measurementRasterCalculation.mjs').then(module=>module.preflightNativeRaster(f.file,request))),response=await call(route(f),'POST',f.body);assert.equal(response.status,202);const job=(await response.json()).calculation;
 await processOneMeasurementCalculation({...f,config:{measurementTimeoutMs:10000,measurementMemoryMiB:256},storage:{resolve:()=>f.file}},'native-child');
 const finished=f.jobs.get(f.measurement.id,job.id);assert.equal(finished.status,'complete',finished.errorCode);assert.equal(finished.result.method,'surface-transect');assert.equal(finished.result.parentCalculationId,f.parent.id);assert.equal(finished.result.baseHash,job.parameters.baseHash);assert.equal(finished.result.cellCount,4);assert.ok(finished.result.segments.every(s=>s.status==='sample'&&s.surfaceM===5&&s.baseStartM===1&&s.baseEndM===1));assert.equal(f.measurements.get(f.principal,f.measurement.id).revision,2);assert.equal(f.jobs.get(f.measurement.id,f.parent.id).result.cutM3,64);
});
