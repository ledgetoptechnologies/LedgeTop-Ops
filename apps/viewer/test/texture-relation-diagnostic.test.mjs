import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseImagePair,diagnoseRecoveryTextureRelation,ENGINE_COMMIT,ENGINE_FILES}
  from '../scripts/diagnose_recovery_texture_relation.mjs';
import {compareAtlasLevelZero} from '../scripts/lib/raw-atlas-rows.mjs';
import {TEXTURE_RELATION_POLICY} from '../scripts/lib/texture-relation-policy.mjs';
const hash='a'.repeat(64);
function fixture({different=false,lateFailure=false}={}){
  let closed=0,rawClosed=0,lowerMips=0;
  const image={width:2,height:2,levels:2,sha256:hash},atlas={width:2,height:2,sha256:hash};
  const decoder={async *levels(){try{yield{level:0,width:2,height:2,rgba:new Uint8Array(16).fill(different?0:255)};
    lowerMips++;yield{level:1,width:1,height:1,rgba:new Uint8Array(4).fill(255)};}finally{closed++;}}};
  const rows=async function*(){try{for(let y=0;y<2;y++)yield{y,rgba:new Uint8Array(8).fill(255),
    header:{interpretation:'rgba8-straight-srgb-byte-values-no-transform',gdalVersion:'fixture',sha256:hash}};
    if(lateFailure)throw Error('final raw hash failed');}finally{rawClosed++;}};
  return{args:{image,atlas,decoder,rows,compare:compareAtlasLevelZero},state:()=>({closed,rawClosed,lowerMips})};
}
test('diagnostic exposes failed unchanged-policy metrics after closing decoder and raw iterators',async()=>{
  const f=fixture({different:true}),metric=await diagnoseImagePair(f.args);
  assert.equal(metric.candidatePass,false);assert.equal(metric.calibrationRequired,true);
  assert.equal(metric.rgb.mae,255);assert.equal(metric.rgb.rmse,255);assert.equal(metric.alpha.maximum,255);
  assert.deepEqual(metric.rgb.maximumAt,{x:0,y:0,channel:0});assert.equal(metric.regions[0].passed,false);
  assert.deepEqual(f.state(),{closed:1,rawClosed:1,lowerMips:0});
  assert.equal(metric.policyRevision,TEXTURE_RELATION_POLICY.revision);
});
test('passing lower-component comparison is still only a level-zero metric',async()=>{
  const f=fixture(),metric=await diagnoseImagePair(f.args);assert.equal(metric.candidatePass,true);
  assert.equal(metric.rgb.mae,0);assert.equal(metric.ready,undefined);
  assert.deepEqual(f.state(),{closed:1,rawClosed:1,lowerMips:0});
});
test('late raw-stream failure cannot become a diagnostic metric and closes both iterators',async()=>{
  const f=fixture({lateFailure:true});await assert.rejects(diagnoseImagePair(f.args),/final raw hash failed/);
  assert.deepEqual(f.state(),{closed:1,rawClosed:1,lowerMips:0});
});
test('dimension and level mismatch reject before comparing a different pair',async()=>{
  const f=fixture();f.args.atlas.width=3;
  await assert.rejects(diagnoseImagePair(f.args),{code:'texture_diagnostic_atlas_dimensions'});
  assert.deepEqual(f.state(),{closed:1,rawClosed:0,lowerMips:0});
});
test('relative request and pre-cancellation reject before model or decoder execution',async()=>{
  const request={output:'relative',engineScripts:'relative',basisJavascript:'relative',basisWasm:'relative'};
  await assert.rejects(diagnoseRecoveryTextureRelation(request),{code:'texture_diagnostic_root'});
  const abort=new AbortController();abort.abort(Error('cancelled'));
  await assert.rejects(diagnoseRecoveryTextureRelation(request,{signal:abort.signal}),/cancelled/);
  assert.equal(ENGINE_COMMIT,'0e18f938a157f882057fcbd3b040e5f0ed71ae10');
  assert.equal(Object.keys(ENGINE_FILES).length,5);assert.equal(Object.isFrozen(ENGINE_FILES),true);
});
