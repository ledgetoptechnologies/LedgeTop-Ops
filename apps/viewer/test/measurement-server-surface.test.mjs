import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerSurfaceCalculator,surfaceCalculationError} from '../measurement-server-surface.mjs';
import {measurementGeometryHash} from '../measurement-surface-client.mjs';

const record={id:'polygon',modelVersionId:'version',revision:2,kind:'polygon',source:{kind:'ortho'}};
const options={reference:{type:'boundary-triangulated',offsetM:0},sourceKind:'auto'};
const capabilities={capabilities:{serverCalculations:true},calculationSources:[{assetId:'dsm-source',kind:'dsm',methods:['surface-cut-fill']},{assetId:'dtm-source',kind:'dtm',methods:['surface-cut-fill']}]};
const result={method:'surface-cut-fill',status:'calculated',cutM3:10,fillM3:2,netM3:8,coverage:1,source:{assetId:'dsm-source',kind:'dsm',modelVersionId:'version',boundaryElevationBasis:'native-raster'},reference:{type:'boundary-triangulated',offsetM:0},preview:{samples:[[1,2,3,0]]}};
const job=(status='complete',extra={})=>({id:'job',measurementId:'polygon',revision:2,status,result,...extra});
function setup({responses=[],existing=[],caps=capabilities,current=()=>true,getRecord,wait=async()=>{}}={}){
  const calls=[];const calculate=createServerSurfaceCalculator({isCurrent:current,getRecord,wait,request:async(operation,payload)=>{calls.push([operation,payload]);if(operation==='capabilities')return caps;if(operation==='list')return{calculations:existing};return{calculation:responses.shift()||job()};}});
  return{calculate,calls};
}
test('server stockpile dispatches once and polls the accepted job, preserving native preview and unit uncertainty',async()=>{
  const f=setup({responses:[job('queued'),job('running'),job()]}),progress=[];
  const output=await f.calculate(record,{...options,onProgress:value=>progress.push(value)});
  assert.deepEqual(f.calls.map(c=>c[0]),['capabilities','list','create','status','status']);
  assert.deepEqual(f.calls[2][1],{measurementId:'polygon',request:{revision:2,method:'surface-cut-fill',sourceAssetId:'dsm-source',reference:{type:'boundary-triangulated',offsetM:0}}});
  assert.deepEqual(output,{...result,calculationJobId:'job'});assert.match(progress.join(' '),/Waiting to calculate.*Calculating your volume/);
  assert.doesNotMatch(progress.join(' '),/\bserver\b/i);
});
test('server reference values are already meters and explicit vertical-unit confirmation is opt-in',async()=>{
  const reference={type:'custom',offsetM:.3048,elevationM:100},f=setup({responses:[job('complete',{result:{...result,reference,source:{...result.source,assetId:'dtm-source',kind:'dtm'}}})]});await f.calculate(record,{...options,reference,confirmMeters:true,sourceKind:'dtm'});
  assert.deepEqual(f.calls[2][1].request,{revision:2,method:'surface-cut-fill',sourceAssetId:'dtm-source',reference:{type:'custom',offsetM:.3048,elevationM:100},sourceVerticalUnit:'m'});
});

test('scoped raster capability supports client volumes without advanced processing capability',async()=>{
  const f=setup({caps:{...capabilities,capabilities:{rasterCalculations:true,serverCalculations:false}}});
  const output=await f.calculate(record,options);assert.equal(output.cutM3,10);assert.equal(f.calls[2][1].request.method,'surface-cut-fill');
});

test('new outlines prefer the same DSM across model, cloud and all map sources',async()=>{
  const caps={...capabilities,capabilities:{rasterCalculations:true,pointSurfaceCalculations:true},calculationSources:[{assetId:'points',kind:'ept',methods:['point-surface-cut-fill']},...capabilities.calculationSources]};
  for(const kind of ['mesh','pointCloud','glb','obj','ept','ortho','dsm','dtm']){
    const f=setup({caps});await f.calculate({...record,collection:['ortho','dsm','dtm'].includes(kind)?'map':'spatial3d',source:{kind}},options);
    assert.equal(f.calls[2][1].request.sourceAssetId,'dsm-source');assert.equal(f.calls[2][1].request.method,'surface-cut-fill');
  }
});

test('saved missing DSM is not replaced by points and saved second DSM remains pinned',async()=>{
  const saved={...record,results:{...result,source:{...result.source,assetId:'saved-dsm'}}};
  const caps={...capabilities,capabilities:{rasterCalculations:true,pointSurfaceCalculations:true},calculationSources:[...capabilities.calculationSources,{assetId:'points',kind:'ept',methods:['point-surface-cut-fill']}]};
  const missing=setup({caps});await assert.rejects(missing.calculate(saved,options),/surface.*unavailable/);assert.equal(missing.calls.length,1);
  const f=setup({caps:{...caps,calculationSources:[...caps.calculationSources,{assetId:'saved-dsm',kind:'dsm',methods:['surface-cut-fill']}]},responses:[job('complete',{result:saved.results})]});
  await f.calculate(saved,options);assert.equal(f.calls[2][1].request.sourceAssetId,'saved-dsm');
});
test('client capabilities and missing DSM never dispatch server processing or silently substitute DTM',async()=>{
  const denied=setup({caps:{...capabilities,capabilities:{serverCalculations:false}}});await assert.rejects(denied.calculate(record,options),/does not allow/);assert.equal(denied.calls.length,1);
  const missing=setup({caps:{...capabilities,calculationSources:[capabilities.calculationSources[1]]}});await assert.rejects(missing.calculate(record,options),error=>{assert.match(error.message,/survey surface.*unavailable.*Contact the model owner/);assert.doesNotMatch(error.message,/DSM|DTM|Choose/);return true;});assert.equal(missing.calls.length,1);
});
test('unknown units error from source preflight is propagated without retry or local fallback',async()=>{
  const calls=[];const calculate=createServerSurfaceCalculator({request:async op=>{calls.push(op);if(op==='capabilities')return capabilities;if(op==='list')return{calculations:[]};throw Object.assign(new Error('measurement source vertical units required'),{code:'measurement_source_vertical_units_required'});}});
  await assert.rejects(calculate(record,options),/height units verified.*outline is saved.*do not guess/);assert.deepEqual(calls,['capabilities','list','create']);
});

test('missing calculation guidance does not misdiagnose persistent authorization as expiry',()=>{
  const error=surfaceCalculationError({code:'measurement_calculation_not_found',status:404});
  assert.match(error.message,/current session/);
  assert.match(error.message,/saved outline and volume have not been changed/);
  assert.doesNotMatch(error.message,/expire|calculate again|temporary/i);
  assert.equal(error.code,'measurement_calculation_not_found');
});

test('stockpile setup and already-running errors provide plain-language next steps',()=>{
  const units=surfaceCalculationError({code:'measurement_source_vertical_units_required',status:422});
  assert.equal(units.code,'measurement_source_vertical_units_required');assert.equal(units.status,422);
  assert.match(units.message,/administrator.*original elevation data/);
  const active=surfaceCalculationError({code:'measurement_calculation_already_active'});
  assert.match(active.message,/already running.*cancel it here/);
  const crs=surfaceCalculationError({code:'measurement_source_crs_mismatch',status:422});
  assert.equal(crs.code,'measurement_source_crs_mismatch');assert.equal(crs.status,422);assert.match(crs.message,/model owner.*outline and area are unchanged/);assert.doesNotMatch(crs.message,/CRS|EPSG|DSM|EPT/);
});
test('abort and view/access invalidation suppress polling and delivery without cancelling an accepted job',async()=>{
  for(const action of ['abort','revoke']){
    const controller=new AbortController();let current=true;const f=setup({responses:[job('queued')],current:()=>current,wait:async()=>{if(action==='abort')controller.abort();else current=false;}});
    await assert.rejects(f.calculate(record,{...options,signal:controller.signal}),action==='abort'?/Stopped watching/:/access or view changed/);
    assert.deepEqual(f.calls.map(c=>c[0]),['capabilities','list','create']);
  }
});
test('late capability response after invalidation cannot launch a job',async()=>{
  let current=true,calls=0;const calculate=createServerSurfaceCalculator({isCurrent:()=>current,request:async()=>{calls++;current=false;return capabilities;}});
  await assert.rejects(calculate(record,options),/access or view changed/);assert.equal(calls,1);
});
test('failed, cancelled, wrong-revision and malformed server results are never attached',async()=>{
  for(const response of [job('failed',{errorCode:'measurement_source_vertical_units_required'}),job('cancelled'),job('complete',{revision:1}),job('complete',{measurementId:'different'}),job('complete',{result:{...result,method:'closed-mesh'}}),job('complete',{result:{...result,coverage:NaN}})]){
    const f=setup({responses:[response]});await assert.rejects(f.calculate(record,options));assert.equal(f.calls.length,3);
  }
});
test('fresh record getter submits current saved revision on repeated calculations',async()=>{
  const f=setup({getRecord:()=>({...record,revision:3}),responses:[job('complete',{revision:3})]});await f.calculate(record,options);assert.equal(f.calls[2][1].request.revision,3);
});

test('completed result source, version and reference provenance must match the submitted request',async()=>{
  for(const patch of [{source:{...result.source,assetId:'other'}},{source:{...result.source,modelVersionId:'old'}},{source:{...result.source,kind:'dtm'}},{reference:{type:'average-boundary',offsetM:0}},{reference:{type:'boundary-triangulated',offsetM:1}}]){
    const f=setup({responses:[job('complete',{result:{...result,...patch}})]});await assert.rejects(f.calculate(record,options),/does not match the selected source/);
  }
});

const parameters={revision:2,method:'surface-cut-fill',sourceAssetId:'dsm-source',reference:{type:'boundary-triangulated',offsetM:0},sourceVerticalUnit:null};
const legacyResult={...result,source:{assetId:'dsm-source',kind:'dsm',modelVersionId:'version'}};
test('explicit calculate replaces only legacy completed raster work, preserving the saved record',async()=>{
  const saved={...record,results:{...legacyResult,calculationJobId:'old'}},before=structuredClone(saved);
  for(const listed of [true,false]){
    const old=job('complete',{id:'old',revision:1,attachmentRevision:2,parameters,result:legacyResult});
    const f=setup({existing:listed?[old]:[],responses:listed?[job()]:[old,job()]});
    await f.calculate(saved,options);assert.equal(f.calls.filter(([op])=>op==='create').length,1);assert.deepEqual(saved,before);
  }
  const f=setup({existing:[job('complete',{parameters,result:legacyResult})]});await f.calculate(saved,options);assert.equal(f.calls.filter(([op])=>op==='create').length,1);
});
test('current attached raster result is recovered without a duplicate and legacy custom base stays valid',async()=>{
  for(const listed of [true,false]){
    const old=job('complete',{id:'old',revision:1,attachmentRevision:2,parameters});
    const f=setup({existing:listed?[old]:[],responses:[old]});await f.calculate({...record,results:{...result,calculationJobId:'old'}},options);assert.equal(f.calls.some(([op])=>op==='create'),false);
  }
  const reference={type:'custom',elevationM:3,offsetM:0},f=setup({existing:[job('complete',{parameters:{...parameters,reference},result:{...legacyResult,reference}})]});
  await f.calculate(record,{reference});assert.equal(f.calls.some(([op])=>op==='create'),false);
});
test('legacy active raster work is observed without duplication and never attached as an updated result',async()=>{
  const f=setup({existing:[job('running',{parameters})],responses:[job('complete',{result:legacyResult})]});
  await assert.rejects(f.calculate(record,options),/older ground reference.*No new volume was saved.*Calculate volume again/);
  assert.deepEqual(f.calls.map(([op])=>op),['capabilities','list','status']);
});
test('reopening resumes the matching active job or retrieves its completed result without duplicate work',async()=>{
  for(const status of ['queued','complete']){
    const f=setup({existing:[job(status,{parameters})]});await f.calculate(record,options);
    assert.equal(f.calls.some(([op])=>op==='create'),false);
    assert.equal(f.calls.filter(([op])=>op==='status').length,status==='queued'?1:0);
  }
});
test('different active settings expose scoped cancellation instead of inaccessible advanced UI',async()=>{
  const f=setup({existing:[job('running',{parameters:{...parameters,reference:{...parameters.reference,offsetM:1}}})]});let active;
  await assert.rejects(f.calculate(record,{...options,onJob:value=>{active=value;}}),/different settings.*cancel it here/);
  await active.cancel();assert.deepEqual(f.calls.at(-1),['cancel',{measurementId:'polygon',jobId:'job'}]);assert.equal(f.calls.some(([op])=>op==='create'),false);
});
test('unit confirmation and revision differences never reuse an unrelated completed result',async()=>{
  for(const previous of [job('complete',{parameters:{...parameters,sourceVerticalUnit:'m'}}),job('complete',{parameters,revision:1})]){
    const f=setup({existing:[previous]});await f.calculate(record,options);assert.equal(f.calls.some(([op])=>op==='create'),true);
  }
});
test('simultaneous creation conflict recovers a matching job and cancellation is access fenced',async()=>{
  let listed=0,current=true,active;const calls=[];
  const calculate=createServerSurfaceCalculator({isCurrent:()=>current,wait:async()=>{},request:async op=>{
    calls.push(op);if(op==='capabilities')return capabilities;if(op==='list')return{calculations:listed++?[job('running',{parameters})]:[]};
    if(op==='create')throw Object.assign(new Error('Already running'),{code:'measurement_calculation_already_active'});return{calculation:job()};
  }});
  await calculate(record,{...options,onJob:value=>{if(value)active=value;}});assert.deepEqual(calls,['capabilities','list','create','list','status']);
  current=false;await assert.rejects(active.cancel(),/access or view changed/);assert.equal(calls.includes('cancel'),false);
});

test('temporary result requires matching geometry and scoped model version without personal persistence',async()=>{
  const temporary={...record,revision:undefined,modelVersionId:undefined,collection:'map',vertices:[[0,0,0],[2,0,0],[0,2,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  const geometryHash=await measurementGeometryHash(temporary),caps={...capabilities,capabilities:{rasterCalculations:true,temporaryCalculations:true},modelVersionId:'version'};
  const response=job('complete',{revision:1,geometryHash});
  const f=setup({caps,responses:[response]});await f.calculate(temporary,options);assert.equal(f.calls[2][1].request.revision,1);
  const wrong=setup({caps,responses:[{...response,geometryHash:'wrong'}]});await assert.rejects(wrong.calculate(temporary,options),/does not match this polygon/);
});
