'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateTransectRequest,sameTransectEvidence}=require('../server/measurementTransectRequest');
function fixture(){
  const id='11111111-1111-4111-8111-111111111111';
  const source={id:'ept',kind:'ept',rootKey:'data',relativePath:'ept/ept.json',byteSize:100,sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
  const measurement={id:'polygon',kind:'polygon',revision:1,modelId:'model',modelVersionId:'version',collection:'spatial',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]]};
  const request={...measurement,method:'point-surface-cut-fill',source,sourceVerticalUnit:'m',cellSizeM:1,classFilter:'all',reference:{type:'custom',elevationM:0}};
  const samplingGrid={version:1,width:2,height:2,bounds:{minE:0,minN:0,maxE:2,maxN:2},cellSizeM:1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'};
  const result={method:request.method,calculationOrigin:'server-original-point-surface',reference:request.reference,source:{assetId:source.id,kind:'ept',sha256:source.sha256,manifestSha256:source.manifestSha256,modelVersionId:'version',cellSizeM:1,classFilter:'all',samplingGrid},preview:{referencePatches:[[[0,0,0],[2,0,0],[2,2,0]],[[0,0,0],[2,2,0],[0,2,0]]]}};
  const parent={request,job:{id,measurementId:measurement.id,revision:1,status:'complete',method:request.method,result}};
  const version={id:'version',assets:[source]},input={revision:1,method:'surface-transect',parentCalculationId:id,line:{start:[0,1],end:[2,1]}};
  return{measurement,version,parent,input};
}
test('point section copies only server-held parent grid and remains unavailable by default',()=>{
  const f=fixture();
  assert.throws(()=>validateTransectRequest(f.input,f.measurement,f.version,f.parent),{code:'measurement_transect_parent_unavailable'});
  const result=validateTransectRequest(f.input,f.measurement,f.version,f.parent,{allowPointSurface:true});
  assert.deepEqual(result.samplingGrid,f.parent.job.result.source.samplingGrid);
  assert.equal(result.classFilter,'all');assert.equal(result.cellSizeM,1);
  assert.ok(sameTransectEvidence(result,structuredClone(result)));
  for(const changes of [{cellSizeM:2},{classFilter:'ground'},{samplingGrid:{...result.samplingGrid,reduction:'median'}}])assert.equal(sameTransectEvidence(result,{...result,...changes}),false);
  assert.throws(()=>validateTransectRequest({...f.input,samplingGrid:result.samplingGrid},f.measurement,f.version,f.parent,{allowPointSurface:true}),{code:'measurement_transect_invalid'});
});
test('point parent evidence rejects changed manifest, filter, method and absent grid provenance',()=>{
  for(const mutate of [f=>f.version.assets[0].manifestSha256='c'.repeat(64),f=>f.parent.job.result.source.classFilter='ground',f=>f.parent.job.result.method='surface-cut-fill',f=>delete f.parent.job.result.source.samplingGrid]){
    const f=fixture();mutate(f);
    assert.throws(()=>validateTransectRequest(f.input,f.measurement,f.version,f.parent,{allowPointSurface:true}),{code:'measurement_transect_parent_unavailable'});
  }
});
