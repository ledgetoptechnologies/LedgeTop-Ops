'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {EphemeralMeasurementRepository}=require('../server/ephemeralMeasurementRepository');
const {createEphemeralMeasurementApi}=require('../server/ephemeralMeasurementApi');
const {processOneEphemeralMeasurement}=require('../server/ephemeralMeasurementWorker');
const {resolveEphemeralAccess}=require('../server/ephemeralMeasurementAccess');
const auth=require('../server/auth');
const {MeasurementSourceUnitEvidence}=require('../server/measurementSourceUnitEvidence');
async function fixture(t,{preflightPoint=async()=>{}}={}){
 const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');applyMigrations(database);t.after(()=>database.close());
 const repository=new ViewerRepository(database),jobs=new EphemeralMeasurementRepository(database);
 const model=repository.upsertModelVersion({provider:'webodm',providerModelId:crypto.randomUUID(),providerVersionId:'v1',displayName:'Encoded EPT',status:'ready',assets:[{kind:'ept',format:'ept',published:true,rootKey:'models',relativePath:'ept/ept.json',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),byteSize:100}]});
 const asset=model.activeVersion.assets[0];database.prepare('INSERT INTO model_asset_files(asset_id,relative_path,byte_size,sha256) VALUES(?,?,?,?)').run(asset.id,'ept-data/0-0-0-0.bin',24,'c'.repeat(64));
 const share=repository.createPublicShare({modelId:model.id,publicIdHash:crypto.randomBytes(32).toString('hex'),permissions:{view:true,measure:true}}),token=auth.sign({kind:'share-asset',shareId:share.id,modelId:model.id},3600000),page=crypto.randomBytes(32).toString('base64url');
 const measurement={id:crypto.randomUUID(),name:'Pile',kind:'polygon',collection:'map',vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
 const request={revision:1,method:'point-surface-cut-fill',sourceAssetId:asset.id,cellSizeM:1,classFilter:'ground',reference:{type:'custom',elevationM:0}};
 const f={database,repository,jobs,model,asset,share,token,page,measurement,request};
 const app=express();app.use(express.json());app.use('/temporary',createEphemeralMeasurementApi(repository,{preflightPoint:request=>preflightPoint(request,f),validator:{allows:async()=>true}}));app.use((e,_req,res,_next)=>res.status(e.status||500).json({code:e.code}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 f.call=(route,method='GET',body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}/temporary${route}`,{method,headers:{Authorization:`Bearer ${token}`,'X-Measurement-Page':page,'X-Measurement-Model-Version':model.activeVersion.id,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 f.create=()=>f.call('/calculations','POST',{measurement,request});
 f.run=runCalculation=>processOneEphemeralMeasurement({repository,config:{},storage:{resolve:()=>'/trusted/ept.json'},validator:{allows:async()=>true},runCalculation},'point-worker');
 return f;
}

test('public calculations reuse staff source evidence without gaining review or persistence authority',async t=>{
 let seen;const f=await fixture(t,{preflightPoint:async request=>{seen=request;}});
 const registry=new MeasurementSourceUnitEvidence(f.database);
 const evidence=registry.recordStaffReview({modelId:f.model.id,modelVersionId:f.model.activeVersion.id,source:f.asset,coordinateReference:f.measurement.coordinateReference,sourceVerticalUnit:'m'},'staff');
 const response=await f.create();assert.equal(response.status,202);
 assert.equal(seen.sourceVerticalUnit,null);assert.deepEqual(seen.sourceUnitEvidence,evidence);
 await f.run(async(_file,request)=>{assert.deepEqual(request.sourceUnitEvidence,evidence);return {method:'point-surface-cut-fill'};});
 assert.equal((await f.call('/calculations','POST',{measurement:f.measurement,request:{...f.request,sourceUnitEvidence:evidence}})).status,400);
 assert.equal(f.database.prepare('SELECT COUNT(*) n FROM private_measurements').get().n,0);
 assert.equal(f.database.prepare('SELECT COUNT(*) n FROM measurement_source_unit_evidence').get().n,1);
});

test('public EPT capability and queue stay page scoped without exposing admin controls',async t=>{
 let preflights=0;const f=await fixture(t,{preflightPoint:async request=>{preflights++;assert.equal(request.requireEncodedVerticalUnits,true);}});
 const caps=await(await f.call('/capabilities')).json();assert.equal(caps.capabilities.pointSurfaceCalculations,true);assert.equal(caps.capabilities.serverCalculations,false);assert.deepEqual(caps.calculationSources[0].methods,['point-surface-cut-fill','surface-transect']);
 for(const method of ['closed-mesh','reconstructed-estimate'])assert.equal((await f.call('/calculations','POST',{measurement:f.measurement,request:{...f.request,method}})).status,403);
 const forged=await f.call('/calculations','POST',{measurement:f.measurement,request:{...f.request,sourceVerticalUnit:'m'}});assert.equal(forged.status,422);assert.equal(preflights,0);
 const response=await f.create();assert.equal(response.status,202);const job=(await response.json()).calculation;assert.equal(job.parameters.cellSizeM,1);assert.equal(job.parameters.classFilter,'ground');assert.equal(job.requireEncodedVerticalUnits,undefined);
 const other={'X-Measurement-Page':crypto.randomBytes(32).toString('base64url')};assert.equal((await f.call(`/calculations/${job.id}`,'GET',null,other)).status,404);assert.deepEqual((await(await f.call('/calculations','GET',null,other)).json()).calculations,[]);
 assert.equal(f.database.prepare('SELECT COUNT(*) n FROM private_measurements').get().n,0);
 await f.run(async(_file,request,controls)=>{assert.equal(request.requireEncodedVerticalUnits,true);assert.equal(controls.isLive(),true);assert.deepEqual(controls.sourceFiles.map(file=>({...file})),[{relativePath:'ept-data/0-0-0-0.bin',byteSize:24,sha256:'c'.repeat(64)}]);return{method:'point-surface-cut-fill',cutM3:1};});
 assert.equal((await(await f.call(`/calculations/${job.id}`)).json()).calculation.status,'complete');
});

test('unknown units, unpublished sources and authority/source changes cannot enter public EPT queue',async t=>{
 const f=await fixture(t,{preflightPoint:async()=>{throw Object.assign(new Error('missing'),{code:'measurement_source_vertical_units_required'});}});assert.equal((await f.create()).status,422);assert.equal(f.database.prepare('SELECT COUNT(*) n FROM ephemeral_measurement_jobs').get().n,0);
 f.database.prepare('UPDATE model_assets SET published=0').run();assert.deepEqual((await(await f.call('/capabilities')).json()).calculationSources,[]);assert.equal((await f.create()).status,422);
 const revoked=await fixture(t,{preflightPoint:async(_request,value)=>value.database.prepare('UPDATE public_shares SET revoked_at=?').run(new Date().toISOString())});assert.equal((await revoked.create()).status,403);
 const changed=await fixture(t,{preflightPoint:async(_request,value)=>value.database.prepare('UPDATE model_assets SET manifest_sha256=?').run('f'.repeat(64))});assert.equal((await changed.create()).status,409);
});

test('worker requires encoded policy, exact method-kind pair and unchanged EPT manifest',async t=>{
 for(const mutation of ['policy','method','manifest']){
  const f=await fixture(t);const response=await f.create();assert.equal(response.status,202);const job=(await response.json()).calculation;
  if(mutation==='manifest')f.database.prepare('UPDATE model_assets SET manifest_sha256=?').run('f'.repeat(64));
  else{const row=f.database.prepare('SELECT request_json FROM ephemeral_measurement_jobs WHERE id=?').get(job.id),request=JSON.parse(row.request_json);if(mutation==='policy')delete request.requireEncodedVerticalUnits;else request.method='closed-mesh';f.database.prepare('UPDATE ephemeral_measurement_jobs SET request_json=? WHERE id=?').run(JSON.stringify(request),job.id);}
  let runs=0;await f.run(async()=>{runs++;});assert.equal(runs,0);assert.equal((await(await f.call(`/calculations/${job.id}`)).json()).calculation.status,'failed');
 }
});

test('temporary point section preserves its page-owned parent grid and frozen base',async t=>{
 const f=await fixture(t),created=await f.create();assert.equal(created.status,202);const parent=(await created.json()).calculation;
 const grid={version:1,width:1,height:1,bounds:{minE:0,minN:0,maxE:1,maxN:1},cellSizeM:1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'},referencePatches=[[[0,0,0],[1,0,0],[1,1,0]],[[0,0,0],[1,1,0],[0,1,0]]];
 await f.run(async(_file,request)=>({method:'point-surface-cut-fill',calculationOrigin:'server-original-point-surface',reference:request.reference,source:{assetId:request.source.id,kind:'ept',sha256:request.source.sha256,manifestSha256:request.source.manifestSha256,modelVersionId:request.modelVersionId,cellSizeM:1,classFilter:'ground',samplingGrid:grid,verticalUnitBasis:'ept-vertical-crs'},preview:{referencePatches}}));
 const section={revision:1,method:'surface-transect',parentCalculationId:parent.id,line:{start:[0,.5],end:[1,.5]}};
 const other={'X-Measurement-Page':crypto.randomBytes(32).toString('base64url')};assert.equal((await f.call('/calculations','POST',{measurement:f.measurement,request:section},other)).status,422);
 const response=await f.call('/calculations','POST',{measurement:f.measurement,request:section});assert.equal(response.status,202);const job=(await response.json()).calculation;
 await f.run(async(_file,request,controls)=>{assert.equal(controls.isLive(),true);assert.equal(request.requireEncodedVerticalUnits,true);assert.deepEqual(request.samplingGrid,grid);assert.deepEqual(request.referencePatches,referencePatches);assert.equal(request.classFilter,'ground');assert.equal(controls.sourceFiles.length,1);return{method:'surface-transect'};});
 assert.equal((await(await f.call(`/calculations/${job.id}`)).json()).calculation.status,'complete');
 const access=await resolveEphemeralAccess(f.token,f.repository);assert.equal(f.jobs.get(access.scopeKey,auth.hashToken(f.page),job.id).parameters.cellSizeM,1);
});
