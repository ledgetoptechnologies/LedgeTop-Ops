import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementSurfaceClient,measurementAssetBearer,measurementGeometryHash} from '../measurement-surface-client.mjs';
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',job='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
function fixture({response={ok:true,status:200,json:async()=>({capabilities:{rasterCalculations:true}})},during=()=>{}}={}){
  let scope={modelId:'model',modelVersionId:'version',audience:'client',subject:'person'},token='viewer-token';const calls=[];
  const request=createMeasurementSurfaceClient({token:()=>token,context:()=>scope,fetcher:async(url,options)=>{calls.push({url,options});during(()=>{scope={...scope,subject:'different'};});return response;}});
  return{request,calls,clearToken:()=>{token=null;}};
}
test('personal surface client uses only Viewer bearer and fixed raster endpoints',async()=>{
  const f=fixture();await f.request('create',{measurementId:id,request:{method:'surface-cut-fill',revision:1}});
  assert.equal(f.calls[0].url,`/api/v1/measurements/${id}/calculations`);
  assert.equal(f.calls[0].options.headers.Authorization,'Bearer viewer-token');
  assert.equal(f.calls[0].options.headers['X-Viewer-Admin-Authorization'],undefined);
  assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.redirect,'error');
  await f.request('status',{measurementId:id,jobId:job});assert.equal(f.calls[1].options.method,'GET');
});
test('other processing methods, paths and extra payload fields never leave the client',async()=>{
  for(const [op,payload]of [['create',{measurementId:id,request:{method:'closed-mesh'}}],['fetch',{url:'https://elsewhere'}],['status',{measurementId:'../tasks',jobId:job}],['capabilities',{path:'/tasks'}]]){
    const f=fixture();await assert.rejects(f.request(op,payload));assert.equal(f.calls.length,0);
  }
});
test('a changed private scope suppresses a late server response',async()=>{
  const f=fixture({during:change=>change()});await assert.rejects(f.request('capabilities'),{code:'measurement_scope_changed'});
});
test('known source errors remain typed while unknown server details remain hidden',async()=>{
  for(const [code,expected]of [['measurement_source_vertical_units_required','measurement_source_vertical_units_required'],['secret path /server/data','measurement_request_failed']]){
    const f=fixture({response:{ok:false,status:422,json:async()=>({code,error:'secret absolute path'})}});
    await assert.rejects(f.request('capabilities'),error=>error.code===expected&&!error.message.includes('secret'));
  }
});
test('missing or denied access never becomes a browser calculation',async()=>{
  const missing=fixture();missing.clearToken();await assert.rejects(missing.request('capabilities'),{code:'measurement_surface_session_required'});assert.equal(missing.calls.length,0);
  const denied=fixture({response:{ok:false,status:403,json:async()=>({code:'private details'})}});await assert.rejects(denied.request('capabilities'),{code:'measurement_surface_access_unavailable'});
});

test('public asset bearer extraction is same-origin and never accepts arbitrary URLs or share-page tokens',()=>{
  const token='signedpayload.'+'a'.repeat(43),origin='https://viewer.example';
  assert.equal(measurementAssetBearer(`/session-assets/${token}/model/dsm.tif`,origin),token);
  for(const root of [`https://other.example/session-assets/${token}/model/dsm.tif`,`/view/${token}`,`/session-assets/not-signed/model/dsm.tif`])assert.equal(measurementAssetBearer(root,origin),null);
});
test('temporary jobs use a per-page memory handle and send bounded geometry only to temporary endpoints',async()=>{
  const calls=[],scope={modelId:'model',modelVersionId:'version',audience:'public',temporary:true};
  const fetcher=async(url,options)=>{calls.push({url,options});return{ok:true,status:200,json:async()=>({calculations:[{measurementId:id},{measurementId:job}]})};};
  const client=()=>createMeasurementSurfaceClient({token:()=> 'signed.public',context:()=>scope,fetcher});
  const a=client(),record={id,name:'Pile',kind:'polygon',collection:'map',vertices:[[0,0,0],[2,0,0],[0,2,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},results:{secret:'not sent'}};
  await a('create',{measurementId:id,request:{method:'surface-cut-fill',revision:1}},record);
  assert.equal(calls[0].url,'/api/v1/measurements/temporary/calculations');
  assert.equal(JSON.parse(calls[0].options.body).measurement.results,undefined);
  assert.match(calls[0].options.headers['X-Measurement-Page'],/^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((await a('list',{measurementId:id})).calculations,[{measurementId:id}]);
  assert.equal(calls[0].options.headers['X-Measurement-Page'],calls[1].options.headers['X-Measurement-Page']);
  await client()('list',{measurementId:id});assert.notEqual(calls[0].options.headers['X-Measurement-Page'],calls[2].options.headers['X-Measurement-Page']);
});
test('geometry identity is stable across metadata key order but changes with sampled boundary',async()=>{
  const a={collection:'map',vertices:[[0,0,0],[2,0,0],[0,2,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  assert.equal(await measurementGeometryHash(a),await measurementGeometryHash({...a,coordinateReference:{verticalUnit:'m',crs:'EPSG:32616'}}));
  assert.notEqual(await measurementGeometryHash(a),await measurementGeometryHash({...a,vertices:[[0,0,0],[3,0,0],[0,2,0]]}));
});

test('temporary capabilities from a newer latest-share model version cannot authorize the old open view',async()=>{
  const scope={modelId:'model',modelVersionId:'open-version',temporary:true};
  const request=createMeasurementSurfaceClient({token:()=> 'signed.public',context:()=>scope,fetcher:async()=>({ok:true,status:200,json:async()=>({capabilities:{rasterCalculations:true,temporaryCalculations:true},modelVersionId:'new-version'})})});
  await assert.rejects(request('capabilities'),error=>error.code==='measurement_scope_changed');
});

test('temporary capabilities must identify the exact current model version',async()=>{
  const scope={modelId:'model',modelVersionId:'open-version',temporary:true};
  for(const modelVersionId of [undefined,'open-version']){
    const request=createMeasurementSurfaceClient({token:()=> 'signed.public',context:()=>scope,fetcher:async()=>({ok:true,status:200,json:async()=>({capabilities:{rasterCalculations:true,temporaryCalculations:true},modelVersionId})})});
    if(modelVersionId)assert.equal((await request('capabilities')).modelVersionId,modelVersionId);
    else await assert.rejects(request('capabilities'),error=>error.code==='measurement_scope_changed');
  }
});
