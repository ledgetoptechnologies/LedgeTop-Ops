import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceAccumulator,integrateSurfaceVolume,estimateSurfacePatchWork} from '../measurement-volume.mjs';
import {createDelaunayReference} from '../server/measurementDelaunayReference.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function fixture(){
  const vertices=Array.from({length:12},(_,i)=>{const a=i*Math.PI/6,r=i%2?20:30;return[406300+Math.cos(a)*r,4905300+Math.sin(a)*r,170+Math.sin(a)*2]});
  return {vertices,referenceBase:createDelaunayReference(vertices),width:160,height:160,bounds:{minE:406265,maxE:406335,minN:4905265,maxN:4905335},values:Float64Array.from({length:25600},(_,i)=>i%31===0?NaN:170+Math.sin(i*.017)*5)};
}
test('spatial native patch culling matches unculled fractional integration for concavity, NoData and both volume signs',()=>{
  const input=fixture(),unculled=integrateSurfaceVolume(input),culled=integrateSurfaceVolume({...input,spatialPatchCulling:true});
  for(const key of ['cutM3','fillM3','netM3','validAreaM2','missingAreaM2','coverage'])near(culled[key],unculled[key]);
  assert.equal(culled.sampleCount,unculled.sampleCount);assert.equal(culled.status,unculled.status);
  assert.ok(culled.cutM3>0&&culled.fillM3>0&&culled.missingAreaM2>0);
});
test('concave work budget counts only scanned candidate patches, leaving default callers unchanged',()=>{
  const input=fixture(),work=estimateSurfacePatchWork(input.referenceBase.patches,input);
  assert.ok(work<input.width*input.height*input.referenceBase.patches.length/3);
  assert.throws(()=>integrateSurfaceVolume({...input,maxWork:work}),{code:'measurement_limit'});
  assert.ok(integrateSurfaceVolume({...input,maxWork:work,spatialPatchCulling:true}).sampleCount>0);
  assert.throws(()=>integrateSurfaceVolume({...input,maxWork:work-1,spatialPatchCulling:true}),{code:'measurement_limit'});
});
test('spatial work guard is cumulative and streamed cells retain identical coverage',()=>{
  const input=fixture(),acc=createSurfaceAccumulator({...input,spatialPatchCulling:true});
  for(let row=0;row<input.height;row+=10)acc.addGrid({width:input.width,height:10,values:input.values.slice(row*input.width,(row+10)*input.width),bounds:{...input.bounds,maxN:input.bounds.maxN-row*70/input.height,minN:input.bounds.maxN-(row+10)*70/input.height}});
  const result=acc.result(),single=integrateSurfaceVolume({...input,spatialPatchCulling:true});
  near(result.netM3,single.netM3);near(result.validAreaM2,single.validAreaM2);assert.equal(result.sampleCount,single.sampleCount);
  const limited=createSurfaceAccumulator({...input,spatialPatchCulling:true,maxWork:estimateSurfacePatchWork(input.referenceBase.patches,input)});
  limited.addGrid(input);assert.throws(()=>limited.addGrid(input),{code:'measurement_limit'});
});
