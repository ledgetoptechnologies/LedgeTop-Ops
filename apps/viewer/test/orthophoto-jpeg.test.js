'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {createOrthophotoJpegPlan,requiredJpegScratchBytes,MAX_DIMENSION}=require('../server/orthophotoJpeg');
function input(){return {asset:{id:'asset-1',kind:'ortho',absolutePath:'/data/models/version-1/orthophoto.tif',sha256:'a'.repeat(64),byteSize:3678000000},sourceVersionId:'version-1',operationId:'11111111-2222-4333-8444-555555555555',stagingParent:'/data/cache/owned-jpg-job',width:40695,height:49335};}
test('full-resolution JPEG contract binds original version and dimensions without starting work',()=>{
  const value=input(),plan=createOrthophotoJpegPlan(value);
  assert.equal(plan.width,40695);assert.equal(plan.height,49335);
  assert.equal(plan.sourceSha256,value.asset.sha256);assert.equal(plan.sourceByteSize,value.asset.byteSize);
  assert.equal(plan.sourceAssetId,'asset-1');assert.equal(plan.sourceVersionId,'version-1');
  assert.equal(plan.jpeg.progressive,false);assert.equal(plan.jpeg.writeMetadata,false);
  assert.deepEqual(plan.backgroundRgb,[255,255,255]);assert.equal(plan.limits.threads,1);
  assert.equal(requiredJpegScratchBytes(plan.width,plan.height),2*40695*49335*3+64*1024*1024);
});
test('oversize images explicitly fail rather than silently downsampling or changing TIFF',()=>{
  for(const key of ['width','height'])assert.throws(()=>createOrthophotoJpegPlan({...input(),[key]:MAX_DIMENSION+1}),{code:'full_resolution_jpeg_dimension_limit'});
  for(const value of [0,-1,NaN,Infinity,'400',1.5])assert.throws(()=>createOrthophotoJpegPlan({...input(),width:value}),{code:'invalid_jpeg_dimensions'});
});
test('JPEG plan rejects unbound sources, virtual paths and staging overlap',()=>{
  for(const change of [{kind:'dtm'},{sha256:null},{byteSize:0},{id:'../asset'},{absolutePath:'/vsicurl/https://example.invalid/a.tif'},{absolutePath:'/data/../private/a.tif'},{absolutePath:'/data/a.png'}])
    assert.throws(()=>createOrthophotoJpegPlan({...input(),asset:{...input().asset,...change}}));
  assert.throws(()=>createOrthophotoJpegPlan({...input(),stagingParent:'/data/models'}),{code:'jpeg_source_staging_overlap'});
  assert.throws(()=>createOrthophotoJpegPlan({...input(),stagingParent:'/data/models/'}),{code:'invalid_jpeg_local_path'});
  assert.throws(()=>createOrthophotoJpegPlan({...input(),backgroundRgb:[255,255,-1]}),{code:'invalid_jpeg_background'});
});
