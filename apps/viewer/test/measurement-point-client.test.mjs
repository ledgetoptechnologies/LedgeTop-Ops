import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerSurfaceCalculator} from '../measurement-server-surface.mjs';
import {createServerProfileCalculator} from '../measurement-server-profile.mjs';
import {validateNativeProfile,exportNativeProfile} from '../measurement-native-profile.mjs';

const samplingGrid={version:1,width:10,height:10,bounds:{minE:0,minN:0,maxE:1,maxN:1},cellSizeM:.1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'};
const source={assetId:'points',kind:'ept',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),modelVersionId:'version',samplingGrid,cellSizeM:.1,classFilter:'all',verticalUnit:'m',verticalUnitBasis:'ept-vertical-crs',crs:'EPSG:32616'};
const reference={type:'boundary-triangulated',offsetM:0};
const result={method:'point-surface-cut-fill',calculationOrigin:'server-original-point-surface',source,reference,cutM3:2,fillM3:0,netM3:2,coverage:1};
const record={id:'polygon',revision:2,kind:'polygon',modelVersionId:'version',collection:'spatial3d',source:{kind:'mesh'}};
const caps={capabilities:{pointSurfaceCalculations:true,rasterCalculations:true,serverCalculations:false,transectCalculations:true},calculationSources:[{assetId:'points',kind:'ept',methods:['point-surface-cut-fill','surface-transect']},{assetId:'dsm',kind:'dsm',methods:['surface-cut-fill']}]};
function volumeFixture({response=result,capabilities=caps}={}){
  const calls=[];
  const calculate=createServerSurfaceCalculator({request:async(op,payload)=>{calls.push([op,payload]);if(op==='capabilities')return capabilities;if(op==='list')return{calculations:[]};return{calculation:{id:'volume',measurementId:'polygon',revision:2,status:'complete',result:response}};}});
  return{calculate,calls};
}
test('all views fall back to original EPT only when no eligible DSM exists, without unit assertion',async()=>{
  for(const kind of ['mesh','pointCloud','glb','obj','ept','ortho','dsm','dtm']){
    const f=volumeFixture({capabilities:{...caps,calculationSources:[caps.calculationSources[0]]}});assert.equal((await f.calculate({...record,collection:['ortho','dsm','dtm'].includes(kind)?'map':'spatial3d',source:{kind}},{confirmMeters:true})).method,'point-surface-cut-fill');
    assert.deepEqual(f.calls.find(([op])=>op==='create')[1].request,{revision:2,method:'point-surface-cut-fill',sourceAssetId:'points',reference,cellSizeM:.1,classFilter:'all'});
  }
});
test('missing saved point asset and missing point capability never substitute a raster',async()=>{
  for(const [input,capabilities] of [[{...record,results:{...result,source:{...source,assetId:'retired'}}},caps],[{...record,results:result},{...caps,capabilities:{rasterCalculations:true}}]]){
    const f=volumeFixture({capabilities});await assert.rejects(f.calculate(input),/surface.*unavailable/);assert.equal(f.calls.length,1);
  }
});
test('saved point base and construction settings are retained, and bad point provenance rejected',async()=>{
  const saved={...result,reference:{type:'custom',elevationM:12,offsetM:2},source:{...source,classFilter:'ground',samplingGrid:{...samplingGrid,cellSizeM:.2}}};
  const f=volumeFixture({response:saved});await f.calculate({...record,results:saved});const body=f.calls.find(([op])=>op==='create')[1].request;assert.deepEqual(body.reference,saved.reference);assert.equal(body.cellSizeM,.2);assert.equal(body.classFilter,'ground');assert.equal(Object.hasOwn(body,'sourceVerticalUnit'),false);
  for(const patch of [{verticalUnitBasis:'administrator-declared'},{manifestSha256:'bad'},{classFilter:'ground'},{samplingGrid:{...samplingGrid,emptyCells:'zero'}}])await assert.rejects(volumeFixture({response:{...result,source:{...source,...patch}}}).calculate({...record,results:result}));
});
const line={start:[0,0],end:[1,0]},baseHash='c'.repeat(64);
const profile={method:'surface-transect',calculationOrigin:'server-original-point-surface',sampling:'point-grid-step',source,parentCalculationId:'volume',baseHash,line,lengthM:1,cellCount:1,segments:[{startM:0,endM:.5,start:[0,0],end:[.5,0],status:'sample',cell:[0,0],surfaceM:2,baseStartM:0,baseEndM:0},{startM:.5,endM:1,start:[.5,0],end:[1,0],status:'outside-surface'}]};
test('point profiles preserve gaps and require exact parent manifest and grid',()=>{
  assert.equal(validateNativeProfile(profile,{source}),profile);
  for(const patch of [{manifestSha256:'d'.repeat(64)},{samplingGrid:{...samplingGrid,cellSizeM:.2}},{classFilter:'ground'}])assert.throws(()=>validateNativeProfile({...profile,source:{...source,...patch}},{source}));
});

test('staff point profile presentation preserves declared units and rejects changed parent basis',()=>{
  const declared={...profile,source:{...source,verticalUnitBasis:'administrator-declared'}};
  assert.equal(validateNativeProfile(declared,{source:declared.source}),declared);
  assert.match(exportNativeProfile(declared),/administrator-declared/);
  assert.doesNotMatch(exportNativeProfile(declared),/ept-vertical-crs/);
  assert.throws(()=>validateNativeProfile(declared,{source}),/different point surface/);
  assert.throws(()=>validateNativeProfile(profile,{source:declared.source}),/different point surface/);
  for(const patch of [{verticalUnitBasis:'guessed'},{verticalUnitBasis:''},{verticalUnit:'ft'},{crs:'EPSG:32617'}]){
    assert.throws(()=>validateNativeProfile({...declared,source:{...declared.source,...patch}},{source:declared.source}));
  }
});
test('ordinary profile follows the saved point parent and freezes its base hash',async()=>{
  const calls=[],saved={...record,results:{...result,calculationJobId:'volume'}};
  const calculate=createServerProfileCalculator({request:async(op,p)=>{calls.push([op,p]);if(op==='capabilities')return caps;if(op==='status')return{calculation:{id:'volume',measurementId:'polygon',revision:2,status:'complete',result}};if(op==='list')return{calculations:[]};return{calculation:{id:'section',measurementId:'polygon',revision:2,status:'complete',parameters:{...p.request,baseHash},result:profile}};}});
  assert.equal((await calculate(saved,{line})).sampling,'point-grid-step');
  assert.deepEqual(calls.find(([op])=>op==='create')[1].request,{revision:2,method:'surface-transect',parentCalculationId:'volume',line});
});
