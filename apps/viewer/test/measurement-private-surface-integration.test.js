// Source-only end-to-end coverage: the production image bundles browser modules
// into dist and intentionally does not ship raw frontend module sources. Keep
// this test in the full source suite, separate from exact-runtime backend tests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const express = require('express');
const { applyMigrations } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { MeasurementRepository } = require('../server/measurementRepository');
const { MeasurementCalculationRepository } = require('../server/measurementCalculationRepository');
const { createMeasurementApi } = require('../server/measurementApi');
const { validateCalculationRequest } = require('../server/measurementCalculationApi');
const { authorizationLive, processOneMeasurementCalculation } = require('../server/measurementCalculationWorker');
const auth = require('../server/auth');
function fixture(t) {
  const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys=ON'); applyMigrations(database); t.after(() => database.close());
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database), measurements = new MeasurementRepository(database), jobs = new MeasurementCalculationRepository(database);
  const model = repository.upsertModelVersion({ provider: 'webodm', providerModelId: 'one', providerVersionId: 'v1', displayName: 'One', status: 'ready', assets: [{ kind: 'dsm', rootKey: 'models', relativePath: 'a.tif', format: 'tif', byteSize: 1, sha256: 'a'.repeat(64) }] });
  const principal = { modelId: model.id, modelVersionId: model.activeVersion.id, subject: 'admin-person', audience: 'ops' };
  const document = { id: crypto.randomUUID(), name: 'A', kind: 'polygon', collection: 'map', vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]], coordinateReference: { crs: 'EPSG:32616', verticalUnit: 'm' } };
  const measurement = measurements.create(principal, document).measurement;
  const viewerToken = crypto.randomBytes(32).toString('base64url'), adminToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  repository.createViewerSession({ ...principal, tokenHash: auth.hashToken(viewerToken), permissions: { view: true, measure: true }, expiresAt });
  processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: principal.subject, permissions: ['viewer.processing.write'], expiresAt });
  const body = { revision: 1, method: 'surface-cut-fill', sourceAssetId: model.activeVersion.assets[0].id, reference: { type: 'custom', elevationM: 0 }, sourceVerticalUnit: 'm' };
  const request = { ...validateCalculationRequest(body, measurement, model.activeVersion), authority: { viewerHash: auth.hashToken(viewerToken), adminHash: auth.hashToken(adminToken), subject: principal.subject } };
  return { database, repository, processing, measurements, jobs, model, principal, measurement, document, viewerToken, adminToken, body, request };
}

test('real private result attachment revision can recover only its exact unchanged completed calculation',async t=>{
  const f=fixture(t),app=express();app.use(express.json());app.use('/api/v1/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  let creates=0,runs=0;const fetcher=(path,options)=>{if(options.method==='POST'&&path.endsWith('/calculations'))creates++;return fetch(`http://127.0.0.1:${server.address().port}${path}`,options);};
  const {createMeasurementStore}=await import('../measurement-store.mjs'),{createMeasurementSurfaceClient}=await import('../measurement-surface-client.mjs'),{createServerSurfaceCalculator}=await import('../measurement-server-surface.mjs');
  const store=createMeasurementStore({token:()=>f.viewerToken,fetcher});await store.load();
  const request=createMeasurementSurfaceClient({token:()=>f.viewerToken,context:()=>f.principal,fetcher});
  const calculate=createServerSurfaceCalculator({request,getRecord:()=>store.records.get(f.measurement.id),wait:async()=>{await processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>'/trusted/a.tif'},runCalculation:async(_path,job,controls)=>{runs++;assert.ok(controls.isLive());return{method:'surface-cut-fill',status:'calculated',cutM3:12,fillM3:0,netM3:12,coverage:1,source:{assetId:job.source.id,kind:job.source.kind,sha256:job.source.sha256,modelVersionId:job.modelVersionId},reference:job.reference};}},'integration');}});
  const options={reference:{type:'custom',elevationM:0},confirmMeters:true},initial=store.records.get(f.measurement.id),result=await calculate(initial,options);await store.attachResults(initial,result);
  let current=store.records.get(initial.id);assert.equal(current.revision,2);assert.equal(f.jobs.get(initial.id,result.calculationJobId).revision,1);assert.equal(f.jobs.get(initial.id,result.calculationJobId).attachmentRevision,2);
  const recovered=await calculate(current,options);assert.equal(recovered.calculationJobId,result.calculationJobId);assert.equal(creates,1);assert.equal(runs,1);
  await store.attachResults(current,recovered);current=store.records.get(initial.id);assert.equal(current.revision,3);assert.equal((await calculate(current,options)).calculationJobId,result.calculationJobId);assert.equal(creates,1);
  await store.patch(current,{name:'Renamed unchanged pile'});current=store.records.get(initial.id);assert.equal((await calculate(current,options)).calculationJobId,result.calculationJobId);assert.equal(creates,1);
  f.database.prepare('UPDATE model_assets SET sha256=?').run('b'.repeat(64));assert.equal(f.jobs.get(initial.id,result.calculationJobId).attachmentRevision,null);f.database.prepare('UPDATE model_assets SET sha256=?').run('a'.repeat(64));
  const different=await calculate(current,{...options,reference:{type:'custom',elevationM:1}});assert.notEqual(different.calculationJobId,result.calculationJobId);assert.equal(creates,2);assert.equal(runs,2);
  await store.save({...current,vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]]});current=store.records.get(initial.id);assert.equal(f.jobs.get(initial.id,result.calculationJobId).attachmentRevision,null);
  const edited=await calculate(current,options);assert.notEqual(edited.calculationJobId,result.calculationJobId);assert.equal(creates,3);assert.equal(runs,3);
  f.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());await assert.rejects(calculate(current,options),{code:'measurement_surface_access_unavailable'});assert.equal(creates,3);
});

test('shipped profile client and private store use HTTP parent linkage without attaching section arrays',async t=>{
  const f=fixture(t),app=express();app.use(express.json());app.use('/api/v1/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const writes=[],fetcher=(path,options)=>{if(options.method!=='GET')writes.push([path,options.method]);return fetch(`http://127.0.0.1:${server.address().port}${path}`,options);};
  const {createMeasurementStore}=await import('../measurement-store.mjs'),{createMeasurementSurfaceClient}=await import('../measurement-surface-client.mjs'),{createServerProfileCalculator}=await import('../measurement-server-profile.mjs');
  const store=createMeasurementStore({token:()=>f.viewerToken,fetcher});await store.load();
  const parent=f.jobs.enqueue(f.measurement,f.request),claimed=f.jobs.claim('volume');
  const source={assetId:f.request.source.id,kind:'dsm',sha256:f.request.source.sha256,modelVersionId:f.model.activeVersion.id,verticalUnit:'m',verticalUnitBasis:'requester-declared',crs:'EPSG:32616',resolutionM:[1,1]};
  const volume={method:'surface-cut-fill',status:'calculated',calculationOrigin:'server-native-raster',cutM3:2,fillM3:0,netM3:2,coverage:1,reference:f.request.reference,source};
  f.jobs.finish(claimed,'volume',{...volume,preview:{samples:[],referencePatches:[[[0,0,0],[1,0,0],[1,1,0]],[[0,0,0],[1,1,0],[0,1,0]]]}});
  await store.attachResults(store.records.get(f.measurement.id),{...volume,calculationJobId:parent.id});const before=JSON.stringify(store.records.get(f.measurement.id));writes.length=0;let runs=0;
  const request=createMeasurementSurfaceClient({token:()=>f.viewerToken,context:()=>f.principal,fetcher}),line={start:[0,.5],end:[1,.5]};
  const calculate=createServerProfileCalculator({request,getRecord:()=>store.records.get(f.measurement.id),wait:async()=>processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>'/trusted/a.tif'},runCalculation:async(_path,r,controls)=>{runs++;assert.ok(controls.isLive());return{method:'surface-transect',status:'calculated',sampling:'native-cell-step',parentCalculationId:r.parentCalculationId,baseHash:r.baseHash,source,line:r.line,lengthM:1,cellCount:1,segments:[{startM:0,endM:1,start:r.line.start,end:r.line.end,status:'sample',surfaceM:2,baseStartM:0,baseEndM:0,cell:[0,0]}]};}},'profile')});
  const result=await calculate(store.records.get(f.measurement.id),{line});assert.equal(result.segments[0].surfaceM,2);assert.equal((await calculate(store.records.get(f.measurement.id),{line})).calculationJobId,result.calculationJobId);assert.equal(runs,1);assert.equal(writes.length,1);assert.ok(writes[0][0].endsWith('/calculations'));assert.equal(writes[0][1],'POST');assert.equal(JSON.stringify(store.records.get(f.measurement.id)),before);assert.equal(f.measurements.get(f.principal,f.measurement.id).revision,2);
});
