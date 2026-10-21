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

test('staff preflight records source review once and ordinary calculations reuse only server evidence',async t=>{
 const f=fixture(t),seen=[];
 const app=express();app.use(express.json());app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async request=>{seen.push(structuredClone(request));return {verticalFactor:1};}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`;
 const call=(body,staff=false)=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'Content-Type':'application/json',...(staff?{'X-Viewer-Admin-Authorization':`Bearer ${f.adminToken}`}:{})},body:JSON.stringify(body)});
 const first=await call(f.body,true);assert.equal(first.status,202);const job=(await first.json()).calculation;
 const evidence=f.jobs.parent(f.measurement.id,job.id).request.sourceUnitEvidence;
 assert.equal(evidence.basis,'administrator-reviewed-source');assert.equal(evidence.reviewedBy,f.principal.subject);assert.equal(seen[0].sourceUnitEvidence,undefined);
 f.jobs.cancel(f.measurement.id,job.id);
 const {sourceVerticalUnit,...ordinary}=f.body;
 const second=await call(ordinary);assert.equal(second.status,202);assert.deepEqual(seen[1].sourceUnitEvidence,evidence);assert.equal(seen[1].sourceVerticalUnit,null);
 assert.equal((await call({...ordinary,sourceUnitEvidence:evidence})).status,400);
 assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n,1);
});

test('encoded feet preflight never records an incidental metres checkbox as source evidence',async t=>{
 const f=fixture(t),app=express();app.use(express.json());app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>({verticalFactor:0.3048})}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'X-Viewer-Admin-Authorization':`Bearer ${f.adminToken}`,'Content-Type':'application/json'},body:JSON.stringify(f.body)});
 assert.equal(response.status,202);const job=(await response.json()).calculation;
 assert.equal(f.jobs.parent(f.measurement.id,job.id).request.sourceUnitEvidence,undefined);
 assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM measurement_source_unit_evidence').get().n,0);
});

test('ordinary point jobs require encoded-unit preflight and narrowly scoped worker authority',async t=>{
 const f=fixture(t);
 f.database.prepare("UPDATE model_assets SET kind='ept',format='ept',manifest_sha256=? WHERE id=?").run('b'.repeat(64),f.request.source.id);
 const app=express();let preflightCalls=0,rejectUnits=true;
 app.use(express.json());app.use('/measurements',createMeasurementApi(f.repository,{preflightPoint:async request=>{preflightCalls++;assert.equal(request.requireEncodedVerticalUnits,true);assert.equal(request.sourceVerticalUnit,null);if(rejectUnits)throw Object.assign(new Error('units'),{code:'measurement_source_vertical_units_required'});}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`;
 const body={revision:1,method:'point-surface-cut-fill',sourceAssetId:f.request.source.id};
 const call=body=>fetch(url,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await call({...body,sourceVerticalUnit:'m'})).status,422);assert.equal(preflightCalls,0);
 assert.equal((await call(body)).status,422);assert.equal(f.jobs.list(f.measurement.id).length,0);
 rejectUnits=false;const response=await call(body);assert.equal(response.status,202);
 const job=(await response.json()).calculation;assert.equal(job.parameters.requireEncodedVerticalUnits,true);assert.equal(job.parameters.cellSizeM,.1);
 const request=f.jobs.parent(f.measurement.id,job.id).request;
 assert.equal(request.authority.scope,'personal-point-surface');assert.equal(authorizationLive(request,f.repository,f.processing),true);
 for(const patch of [{method:'reconstructed-estimate'},{sourceVerticalUnit:'m'},{requireEncodedVerticalUnits:false},{source:{...request.source,kind:'obj'}}])assert.equal(authorizationLive({...request,...patch},f.repository,f.processing),false);
 f.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());assert.equal(authorizationLive(request,f.repository,f.processing),false);
});

test('attached point result survives rename but not manifest replacement',t=>{
 const f=fixture(t),manifest='b'.repeat(64);
 f.database.prepare("UPDATE model_assets SET kind='ept',format='ept',manifest_sha256=? WHERE id=?").run(manifest,f.request.source.id);
 const request={...f.request,method:'point-surface-cut-fill',source:{...f.request.source,kind:'ept',manifestSha256:manifest},cellSizeM:1,classFilter:'all'};
 const queued=f.jobs.enqueue(f.measurement,request),claimed=f.jobs.claim('worker');
 const result={method:'point-surface-cut-fill',cutM3:1,fillM3:0,netM3:1,coverage:1,source:{assetId:request.source.id,kind:'ept',sha256:request.source.sha256,manifestSha256:manifest,modelVersionId:request.modelVersionId},reference:request.reference};
 f.jobs.finish(claimed,'worker',result);
 let current=f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:1,results:{...result,calculationJobId:queued.id}});
 assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,2);
 current=f.measurements.update(f.principal,current.id,{...f.document,name:'Renamed',revision:2,results:current.results});
 assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,3);
 f.database.prepare('UPDATE model_assets SET manifest_sha256=? WHERE id=?').run('c'.repeat(64),request.source.id);
 assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,null);
});

test('historical result reuse requires explicit stored attachment, exact coordinate frame and source identity',t=>{
  const f=fixture(t),queued=f.jobs.enqueue(f.measurement,f.request),claimed=f.jobs.claim('worker'),result={method:'surface-cut-fill',cutM3:1,fillM3:0,netM3:1,coverage:1,source:{assetId:f.request.source.id,kind:'dsm',sha256:f.request.source.sha256,modelVersionId:f.request.modelVersionId},reference:f.request.reference};f.jobs.finish(claimed,'worker',result);
  f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:1,results:{...result,calculationJobId:crypto.randomUUID()}});assert.equal(f.jobs.get(f.measurement.id,queued.id).attachmentRevision,null);
  f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:2,results:{...result,calculationJobId:queued.id}});assert.equal(f.jobs.get(f.measurement.id,queued.id).attachmentRevision,3);
  const row=f.database.prepare('SELECT request_json FROM measurement_calculation_jobs WHERE id=?').get(queued.id),request=JSON.parse(row.request_json);request.coordinateReference.crs='EPSG:32617';f.database.prepare('UPDATE measurement_calculation_jobs SET request_json=? WHERE id=?').run(JSON.stringify(request),queued.id);assert.equal(f.jobs.get(f.measurement.id,queued.id).attachmentRevision,null);
});

test('runtime repository attests attached results across save revisions but rejects changed geometry or source',t=>{
  const f=fixture(t),queued=f.jobs.enqueue(f.measurement,f.request),claimed=f.jobs.claim('worker'),result={method:'surface-cut-fill',cutM3:12,fillM3:0,netM3:12,coverage:1,source:{assetId:f.request.source.id,kind:'dsm',sha256:f.request.source.sha256,modelVersionId:f.request.modelVersionId},reference:f.request.reference};
  assert.equal(f.jobs.finish(claimed,'worker',result),true);
  let current=f.measurements.update(f.principal,f.measurement.id,{...f.document,revision:1,results:{...result,calculationJobId:queued.id}});assert.equal(current.revision,2);assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,2);assert.equal(f.jobs.get(current.id,queued.id).revision,1);
  current=f.measurements.update(f.principal,current.id,{...f.document,revision:current.revision,results:current.results});assert.equal(current.revision,3);assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,3);
  current=f.measurements.update(f.principal,current.id,{...f.document,name:'Renamed pile',revision:current.revision,results:current.results});assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,4);assert.equal(f.jobs.list(current.id).length,1);
  f.database.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run('b'.repeat(64),f.request.source.id);assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,null);f.database.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run(f.request.source.sha256,f.request.source.id);
  current=f.measurements.update(f.principal,current.id,{...f.document,revision:current.revision,results:current.results,vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]]});assert.equal(f.jobs.get(current.id,queued.id).attachmentRevision,null);
});
test('job queue snapshots revision, enforces singleton, cancels on edit, hides private request', t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request);
  assert.equal(queued.status, 'queued'); assert.equal(queued.request, undefined);
  assert.throws(() => f.jobs.enqueue(f.measurement, f.request), { code: 'measurement_calculation_already_active' });
  const job = f.jobs.claim('one'); assert.ok(job); assert.equal(f.jobs.claim('two'), null); assert.ok(f.jobs.live(job, 'one')); assert.equal(f.jobs.live(job, 'two'), false);
  assert.equal(f.processing.measurementCalculationActive(), true);
  f.measurements.update(f.principal, f.measurement.id, { ...f.document, name: 'Edit', revision: 1 });
  assert.equal(f.jobs.live(job, 'one'), false); assert.equal(f.jobs.finish(job, 'one', { cutM3: 5 }), false); assert.equal(f.jobs.get(f.measurement.id, job.id).status, 'cancelled');
});
test('expired calculation leases fail rather than silently rerunning', t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request), job = f.jobs.claim('one');
  assert.equal(f.jobs.claim('two', Date.now() + 91_000), null);
  assert.equal(f.jobs.get(f.measurement.id, queued.id).errorCode, 'worker_interrupted'); assert.equal(f.jobs.finish(job, 'one', {}), false);
});
test('worker rechecks both authorities and source identity, records only current results', async t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request);
  let calls = 0;
  const deps = { ...f, storage: { resolve: () => '/trusted/a.tif' }, config: {}, runCalculation: async (_path, _request, controls) => { assert.equal(controls.isLive(), true); calls++; return { cutM3: 1.23456789 }; } };
  assert.equal(await processOneMeasurementCalculation(deps, 'worker'), true); assert.equal(calls, 1); assert.equal(f.jobs.get(f.measurement.id, queued.id).result.cutM3, 1.23456789);
  const next = f.jobs.enqueue(f.measurement, f.request);
  f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());
  assert.equal(authorizationLive(f.request, f.repository, f.processing), false);
  await processOneMeasurementCalculation(deps, 'worker'); assert.equal(calls, 1); assert.equal(f.jobs.get(f.measurement.id, next.id).errorCode, 'measurement_authorization_lost');
});
test('API allows owned raster measurements without general processing authority and retains advanced admin checks', async t => {
  const f = fixture(t), app = express(); let preflightCalls = 0, preflightError;
  app.use(express.json()); app.use('/measurements', createMeasurementApi(f.repository, { preflightRaster: async () => { preflightCalls++; if (preflightError) throw Object.assign(new Error(preflightError), { code: preflightError }); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`;
  const call = (extra = {}, body = f.body, method = 'POST') => fetch(url, { method, headers: { Authorization: `Bearer ${f.viewerToken}`, 'Content-Type': 'application/json', ...extra }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call({}, {...f.body,method:'closed-mesh'})).status, 403);
  assert.equal(preflightCalls, 0, 'ordinary viewer access cannot start advanced processing');
  const headers = { 'X-Viewer-Admin-Authorization': `Bearer ${f.adminToken}` };
  assert.equal((await call(headers, { ...f.body, absolutePath: '/etc/passwd' })).status, 400);
  preflightError = 'measurement_source_vertical_units_required';
  const missingUnits = await call(headers); assert.equal(missingUnits.status, 422);
  assert.equal((await missingUnits.json()).code, preflightError); assert.equal(f.jobs.list(f.measurement.id).length, 0);
  preflightError = 'measurement_raster_block_too_large';
  assert.equal((await call(headers)).status, 422); assert.equal(f.jobs.list(f.measurement.id).length, 0);
  preflightError = null;
  const response = await call(headers); assert.equal(response.status, 202); assert.equal((await response.json()).calculation.status, 'queued');
  const list = await (await call(headers, undefined, 'GET')).json(); assert.equal(list.calculations.length, 1); assert.ok(!JSON.stringify(list).includes('viewerHash'));
  f.database.prepare("UPDATE admin_sessions SET subject='another-person'").run(); assert.equal((await call(headers, undefined, 'GET')).status, 403);
  assert.throws(() => validateCalculationRequest({ ...f.body, method: 'reconstruct' }, f.measurement, f.model.activeVersion), { code: 'measurement_method_unavailable' });
});

test('revocation during calculation discards results',async t=>{
 const f=fixture(t),queued=f.jobs.enqueue(f.measurement,f.request);
 await processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>'/trusted/a.tif'},runCalculation:async(_p,_r,controls)=>{f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());assert.equal(controls.isLive(),false);return{volumeM3:99};}},'worker');
 const job=f.jobs.get(f.measurement.id,queued.id);assert.equal(job.status,'failed');assert.equal(job.result,null);assert.equal(job.errorCode,'measurement_authorization_lost');
});

test('authority is rechecked after native source preflight before creating any job', async t => {
  const f=fixture(t),app=express();app.use(express.json());
  app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{
    f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());
  }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'X-Viewer-Admin-Authorization':`Bearer ${f.adminToken}`,'Content-Type':'application/json'},body:JSON.stringify(f.body)});
  assert.equal(response.status,403);assert.equal(f.jobs.list(f.measurement.id).length,0);
});

test('reconstruction requires explicit inferred geometry acknowledgement and immutable native source',t=>{
 const f=fixture(t),asset={id:'native-obj',kind:'obj',format:'obj',sha256:'b'.repeat(64),rootKey:'models',relativePath:'native.obj',byteSize:42};
 const version={...f.model.activeVersion,georef:{epsg:32616},assets:[asset]};
 const body={revision:1,method:'reconstructed-estimate',sourceAssetId:asset.id,sourceCoordinateFrame:'projected',selection:{seed:[.5,.5,0],minElevationM:-1,maxElevationM:10},reconstruction:{depth:6,normalRadiusM:.2,supportDistanceM:.1,acknowledgeInferredGeometry:true}};
 const request=validateCalculationRequest(body,f.measurement,version);assert.equal(request.collection,'map');assert.equal(request.source.sha256,asset.sha256);assert.equal(request.reconstruction.acknowledgeInferredGeometry,true);
 assert.throws(()=>validateCalculationRequest({...body,reconstruction:{...body.reconstruction,acknowledgeInferredGeometry:false}},f.measurement,version),{code:'measurement_reconstruction_settings_invalid'});
 assert.throws(()=>validateCalculationRequest({...body,reconstruction:{...body.reconstruction,depth:10}},f.measurement,version),{code:'measurement_reconstruction_settings_invalid'});
});

test('client own raster jobs use scoped Viewer authority; cross-person and advanced paths remain closed',async t=>{
 const f=fixture(t),client={...f.principal,audience:'client',subject:'client-one'},other={...client,subject:'client-two'};
 const own=f.measurements.create(client,{...f.document,id:crypto.randomUUID()}).measurement;
 const foreign=f.measurements.create(other,{...f.document,id:crypto.randomUUID()}).measurement;
 const token=crypto.randomBytes(32).toString('base64url');
 f.repository.createViewerSession({...client,tokenHash:auth.hashToken(token),permissions:{view:true,measure:true,personalMeasurements:true},expiresAt:new Date(Date.now()+3600000).toISOString()});
 let preflights=0;const app=express();app.use(express.json());app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{preflights++;}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/measurements`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 const call=(path,method='GET',body)=>fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
 const caps=await(await call('/capabilities')).json();assert.equal(caps.capabilities.rasterCalculations,true);assert.equal(caps.capabilities.transectCalculations,true);assert.equal(caps.capabilities.serverCalculations,false);assert.deepEqual(caps.calculationMethods,['surface-cut-fill','surface-transect']);
 for(const method of ['closed-mesh','reconstructed-estimate'])assert.equal((await call(`/${own.id}/calculations`,'POST',{...f.body,method})).status,403);
 assert.equal((await call(`/${own.id}/calculations`,'POST',{...f.body,method:'point-surface-cut-fill'})).status,422,'a raster asset cannot be used as a point-cloud source');
 assert.equal(preflights,0);assert.equal((await call(`/${foreign.id}/calculations`,'POST',f.body)).status,404);
 const response=await call(`/${own.id}/calculations`,'POST',f.body);assert.equal(response.status,202);const queued=(await response.json()).calculation;
 assert.equal(queued.method,'surface-cut-fill');assert.equal(queued.request,undefined);assert.equal(queued.authority,undefined);
 assert.equal((await call(`/${foreign.id}/calculations/${queued.id}`)).status,404);
 const internal=JSON.parse(f.database.prepare('SELECT request_json FROM measurement_calculation_jobs WHERE id=?').get(queued.id).request_json);
 assert.equal(internal.authority.scope,'personal-raster');assert.equal(internal.authority.audience,'client');assert.equal(internal.authority.adminHash,undefined);
 assert.equal(authorizationLive(internal,f.repository,f.processing),true);
 assert.equal(authorizationLive({...internal,method:'closed-mesh'},f.repository,f.processing),false);
 assert.equal(authorizationLive({...internal,source:{...internal.source,kind:'obj'}},f.repository,f.processing),false);
 assert.equal(authorizationLive({...internal,authority:{...internal.authority,subject:'client-two'}},f.repository,f.processing),false);
 assert.equal(authorizationLive({...internal,modelVersionId:crypto.randomUUID()},f.repository,f.processing),false);
 assert.equal((await call(`/${own.id}/calculations/${queued.id}`,'DELETE')).status,204);
 // Method-only filtering is intentional: even a legacy advanced job on an
 // owned measurement cannot become accessible without staff authority.
 const advanced=f.jobs.enqueue(own,{...internal,method:'closed-mesh'});
 assert.equal((await call(`/${own.id}/calculations/${advanced.id}`)).status,404);
 assert.equal((await call(`/${own.id}/calculations/${advanced.id}`,'DELETE')).status,404);
 const listed=await(await call(`/${own.id}/calculations`)).json();assert.deepEqual(listed.calculations.map(j=>j.id),[queued.id]);
 f.jobs.cancel(own.id,advanced.id);
 const workerJob=f.jobs.enqueue(own,internal);
 await processOneMeasurementCalculation({...f,storage:{resolve:()=>'/trusted/a.tif'},config:{},runCalculation:async(_p,_r,controls)=>{assert.equal(controls.isLive(),true);f.database.prepare('UPDATE viewer_sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(),auth.hashToken(token));assert.equal(controls.isLive(),false);return{cutM3:20};}},'client-raster');
 assert.equal(f.jobs.get(own.id,workerJob.id).result,null);assert.equal(f.jobs.get(own.id,workerJob.id).errorCode,'measurement_authorization_lost');
 assert.equal((await call(`/${own.id}/calculations`)).status,403);
});

test('scoped raster preflight cannot enqueue after client access revocation',async t=>{
 const f=fixture(t),app=express();app.use(express.json());app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{f.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'Content-Type':'application/json'},body:JSON.stringify(f.body)});
 assert.equal(response.status,403);assert.equal(f.jobs.list(f.measurement.id).length,0);
});
