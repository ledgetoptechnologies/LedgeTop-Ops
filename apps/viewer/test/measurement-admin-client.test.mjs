import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementAdminClient} from '../measurement-admin-client.mjs';
import {availableAdminSources,adminCalculationRequest,adminResultSummary,openAdminCalculationDialog,acceptAdminAttachmentRecord,createAdminPreviewController} from '../measurement-admin-dialog.mjs';
const ids=['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'];
const scope={modelId:'model',modelVersionId:'version'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){let current=scope,index=0;const sent=[],timers=[];const client=createMeasurementAdminClient({context:()=>current,token:()=> 'v'.repeat(43),send:message=>sent.push(message),uuid:()=>ids[index++],setTimer:callback=>{timers.push(callback);return callback;},clearTimer:()=>{}});return{client,sent,timers,change:()=>{current={...scope,modelVersionId:'changed'};}};}
const reply=(message,result={capabilities:{serverCalculations:true}})=>({version:1,type:'ltds-viewer:measurement-response',requestId:message.requestId,modelId:message.modelId,modelVersionId:message.modelVersionId,ok:true,result});

test('admin client serializes correlated requests without possessing workspace credentials',async()=>{
  const h=harness(),one=h.client.request('capabilities'),two=h.client.request('list',{measurementId:ids[0]});await tick();
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].viewerToken,'v'.repeat(43));assert.equal(Object.hasOwn(h.sent[0],'adminToken'),false);
  assert.equal(h.client.handleMessage({...reply(h.sent[0]),modelVersionId:'wrong'}),false);
  assert.equal(h.client.handleMessage(reply(h.sent[0])),true);assert.deepEqual(await one,{capabilities:{serverCalculations:true}});await tick();
  assert.equal(h.sent.length,2);h.client.handleMessage(reply(h.sent[1],{calculations:[]}));assert.deepEqual(await two,{calculations:[]});
  assert.equal(h.client.handleMessage(reply(h.sent[0])),false);h.client.dispose();
});

test('admin client rejects denial, unavailable workspace, changed scope and disposal',async()=>{
  const h=harness();let promise=h.client.request('capabilities');await tick();h.client.handleMessage({...reply(h.sent[0]),ok:false,result:undefined,code:'measurement_admin_required',status:403});await assert.rejects(promise,/measurement admin required/);
  promise=h.client.request('capabilities');await tick();h.change();h.client.handleMessage(reply(h.sent[1]));await assert.rejects(promise,/measurement scope changed/);h.client.dispose();
  const expired=harness(),timeout=expired.client.request('capabilities');await tick();expired.timers[0]();await assert.rejects(timeout,/measurement workspace unavailable/);expired.client.dispose();
  const closed=harness(),pending=closed.client.request('capabilities');await tick();closed.client.dispose();await assert.rejects(pending,/measurement controller closed/);await assert.rejects(closed.client.request('capabilities'),/measurement controller closed/);
});

test('capabilities expose only declared operational methods and no client job controls',async()=>{
  const sources=[{assetId:'dsm',kind:'dsm'},{assetId:'obj',kind:'obj',methods:['closed-mesh','reconstructed-estimate']},{assetId:'ept',kind:'ept',methods:['point-surface-cut-fill']}];
  assert.deepEqual(availableAdminSources({capabilities:{serverCalculations:false},calculationSources:sources}),[]);
  assert.deepEqual(availableAdminSources({capabilities:{serverCalculations:true},calculationSources:sources}).map(s=>s.methods),[['surface-cut-fill'],['closed-mesh','reconstructed-estimate'],['point-surface-cut-fill']]);
  assert.deepEqual(availableAdminSources({capabilities:{serverCalculations:true},calculationSources:sources,calculationMethods:['closed-mesh']}).map(s=>s.assetId),['obj']);
  let created=false;
  await assert.rejects(openAdminCalculationDialog({record:{},request:async()=>({capabilities:{serverCalculations:false}}),documentRef:{createElement(){created=true;}}}),/does not allow/);assert.equal(created,false);
});

test('admin surface requests preserve saved revision and exact base fields without model paths or vertices',()=>{
  const record={id:ids[0],kind:'polygon',revision:7},sources=[{assetId:'dsm',methods:['surface-cut-fill']},{assetId:'ept',methods:['point-surface-cut-fill']}];
  const fields={method:'surface-cut-fill',sourceAssetId:'dsm',reference:'custom',offsetM:'0.000123456789',elevationM:'203.3456789123',confirmMeters:true};
  assert.deepEqual(adminCalculationRequest(record,fields,sources),{revision:7,method:'surface-cut-fill',sourceAssetId:'dsm',reference:{type:'custom',offsetM:0.000123456789,elevationM:203.3456789123},sourceVerticalUnit:'m'});
  assert.throws(()=>adminCalculationRequest({...record,revision:undefined},fields,sources),/Save this polygon/);
  assert.throws(()=>adminCalculationRequest(record,{...fields,offsetM:'Infinity'},sources),/finite/);
  const point=adminCalculationRequest(record,{...fields,method:'point-surface-cut-fill',sourceAssetId:'ept',cellSizeM:'0.025',classFilter:'ground'},sources);
  assert.equal(point.cellSizeM,0.025);assert.equal(point.classFilter,'ground');assert.equal(Object.hasOwn(point,'vertices'),false);
});

test('closed-mesh requests require explicit frame, seed and bounded object selection',()=>{
  const record={id:ids[0],kind:'polygon',revision:2},sources=[{assetId:'obj',methods:['closed-mesh']}];
  const fields={method:'closed-mesh',sourceAssetId:'obj',sourceCoordinateFrame:'local-enu',seedE:'400000',seedN:'4500000',seedZ:'205',minElevationM:'200',maxElevationM:'210',confirmObjectSelection:true};
  assert.deepEqual(adminCalculationRequest(record,fields,sources),{revision:2,method:'closed-mesh',sourceAssetId:'obj',sourceCoordinateFrame:'local-enu',selection:{seed:[400000,4500000,205],minElevationM:200,maxElevationM:210}});
  for(const changes of [{confirmObjectSelection:false},{sourceCoordinateFrame:''},{seedE:''},{minElevationM:'210'},{seedZ:'220'}])assert.throws(()=>adminCalculationRequest(record,{...fields,...changes},sources),/Confirm the source/);
});

test('reconstruction requires advertised method, explicit inference opt-in and native source declarations',()=>{
  const record={kind:'polygon',revision:3},sources=[{assetId:'ept',kind:'ept',methods:['reconstructed-estimate']},{assetId:'obj',kind:'obj',methods:['reconstructed-estimate']}];
  const fields={method:'reconstructed-estimate',sourceAssetId:'ept',seedE:400000,seedN:4500000,seedZ:100,minElevationM:90,maxElevationM:110,confirmObjectSelection:true,displayUnits:'imperial',depth:7,normalRadiusM:2,supportDistanceM:1,acknowledgeInferredGeometry:true,confirmReconstructionMeters:true,reconstructionClassFilter:'ground'};
  const request=adminCalculationRequest(record,fields,sources);
  assert.deepEqual(request.reconstruction,{depth:7,normalRadiusM:0.6096,supportDistanceM:0.3048,acknowledgeInferredGeometry:true});
  assert.equal(request.sourceVerticalUnit,'m');assert.equal(request.classFilter,'ground');assert.equal(Object.hasOwn(request,'sourceCoordinateFrame'),false);
  assert.deepEqual(request.selection.seed,[400000,4500000,30.48]);
  for(const changes of [{acknowledgeInferredGeometry:false},{depth:5},{depth:7.5},{normalRadiusM:''},{supportDistanceM:0},{confirmReconstructionMeters:false}])assert.throws(()=>adminCalculationRequest(record,{...fields,...changes},sources));
  assert.throws(()=>adminCalculationRequest(record,{...fields,sourceAssetId:'obj'},sources),/coordinate frame/);
  const obj=adminCalculationRequest(record,{...fields,sourceAssetId:'obj',sourceCoordinateFrame:'local-enu'},sources);
  assert.equal(obj.sourceCoordinateFrame,'local-enu');assert.equal(Object.hasOwn(obj,'sourceVerticalUnit'),false);
  assert.throws(()=>adminCalculationRequest(record,fields,[{assetId:'ept',kind:'ept',methods:['point-surface-cut-fill']}]),/unavailable/);
});

test('admin results retain incomplete coverage and estimated status with default cubic feet',()=>{
  const output=adminResultSummary({status:'complete',result:{status:'incomplete',cutM3:1,fillM3:0,netM3:1,coverage:.75,warnings:['Missing source samples.']}});
  assert.match(output,/incomplete/);assert.match(output,/35.315 ft³/);assert.match(output,/75.000%/);assert.match(output,/Missing source samples/);
  assert.match(adminResultSummary({status:'complete',result:{status:'estimate',volumeM3:1}},'metric'),/estimate: Volume 1.000 m³/);
  assert.match(adminResultSummary({status:'failed',errorCode:'measurement_source_missing'}),/source missing/);
});

test('admin length fields honor selected units while easting and northing stay in CRS meters',()=>{
  const record={kind:'polygon',revision:1},sources=[{assetId:'dsm',methods:['surface-cut-fill']},{assetId:'obj',methods:['closed-mesh']},{assetId:'ept',methods:['point-surface-cut-fill']}];
  const surface=adminCalculationRequest(record,{method:'surface-cut-fill',sourceAssetId:'dsm',reference:'custom',elevationM:100,offsetM:10,displayUnits:'imperial'},sources);
  assert.equal(surface.reference.elevationM,30.48);assert.equal(surface.reference.offsetM,3.048);
  const object=adminCalculationRequest(record,{method:'closed-mesh',sourceAssetId:'obj',sourceCoordinateFrame:'projected',seedE:400000,seedN:4500000,seedZ:100,minElevationM:90,maxElevationM:110,displayUnits:'imperial',confirmObjectSelection:true},sources);
  assert.deepEqual(object.selection.seed,[400000,4500000,30.48]);assert.equal(object.selection.minElevationM,27.432000000000002);
  const point=adminCalculationRequest(record,{method:'point-surface-cut-fill',sourceAssetId:'ept',reference:'lowest-boundary',offsetM:0,cellSizeM:10,classFilter:'ground',displayUnits:'centimeters',confirmMeters:true},sources);
  assert.equal(point.cellSizeM,.1);
});

test('second calculation uses the revision returned by its own result attachment, never changed geometry',()=>{
  let record={id:ids[0],kind:'polygon',collection:'spatial3d',revision:1,modelId:'model',modelVersionId:'version',vertices:[[0,0,0],[1,0,0],[1,1,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},source:{kind:'dsm'}};
  const fields={method:'surface-cut-fill',sourceAssetId:'dsm',reference:'lowest-boundary',offsetM:0},sources=[{assetId:'dsm',methods:['surface-cut-fill']}];
  assert.equal(adminCalculationRequest(record,fields,sources).revision,1);
  record=acceptAdminAttachmentRecord(record,{...record,revision:2,results:{volumeM3:1}});
  assert.equal(adminCalculationRequest(record,fields,sources).revision,2);
  assert.throws(()=>acceptAdminAttachmentRecord(record,{...record,revision:3,vertices:[[0,0,0],[10,0,0],[1,1,0]]}),/measurement changed/);
  assert.throws(()=>acceptAdminAttachmentRecord(record,{...record,revision:4}),/measurement changed/);
  assert.throws(()=>acceptAdminAttachmentRecord(record,{...record,revision:3,modelVersionId:'replacement'}),/measurement changed/);
});

test('admin job previews update on selection, preserve inferred warnings and clean up without resetting the same view',()=>{
  const calls=[];const preview=createAdminPreviewController({}, {units:'imperial',mount:(_host,options)=>{calls.push(['mount',options]);return{update:(...args)=>calls.push(['update',...args]),dispose:()=>calls.push(['dispose'])};}});
  const first={id:ids[0],revision:1,result:{method:'surface-cut-fill',preview:{samples:[[0,0,1,0]]}}};
  assert.equal(preview.show(first),true);preview.show(first);assert.equal(calls.length,1,'polling same immutable result does not reset orbit');
  preview.show({id:ids[1],revision:2,result:{method:'reconstructed-estimate',preview:{vertices:[[0,0,0]],triangles:[]}}});assert.equal(calls[1][0],'update');assert.equal(calls[1][1].inferred,true);
  preview.show({id:ids[1],revision:2,status:'failed'});assert.equal(calls[2][0],'dispose');
  preview.show(first);preview.dispose();preview.dispose();assert.equal(calls.filter(call=>call[0]==='dispose').length,2);assert.equal(preview.show(first),false);
});
