'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {validateClaim,expectedReceipt,validateReceipt}=require('../server/sourceCopyHandoffContractCandidate');
const vector=require('./fixtures/source-copy-handoff-candidate.json');
test('closed claim and exact receipt bind ordered metadata and generation',()=>{
 const claim=structuredClone(vector.claim);assert.deepEqual(validateClaim(claim),claim);assert.deepEqual(expectedReceipt(claim),vector.receipt);assert.deepEqual(validateReceipt(vector.receipt,claim),vector.receipt);
 for(const bad of [{...claim,extra:true},{...claim,operationId:'another'},{...claim,rootKey:'trash'},{...claim,datasetRelativePath:'../secret'},{...claim,fileCount:2},{...claim,byteSize:4},{...claim,manifestSha256:'a'.repeat(64)},{...claim,sourceInventorySha256:'b'.repeat(64)},{...claim,files:[{...claim.files[0],byteSize:0}]},{...claim,files:[{...claim.files[0],relativePath:'/absolute'}]},{...claim,files:[{...claim.files[0],id:'bad/id'}]}])assert.throws(()=>validateClaim(bad),{code:'SOURCE_COPY_CONTRACT_INVALID'});
 for(const bad of [{...vector.receipt,extra:true},{...vector.receipt,sealed:false},{...vector.receipt,generation:2},{...vector.receipt,sourceInventorySha256:'f'.repeat(64)},{...vector.receipt,sealSha256:'f'.repeat(64)}])assert.throws(()=>validateReceipt(bad,claim),{code:'SOURCE_COPY_CONTRACT_INVALID'});
});
test('valid supplementary Unicode is preserved and lone surrogate paths are rejected',()=>{
 const c=structuredClone(vector.claim),digest=x=>crypto.createHash('sha256').update(JSON.stringify(x),'utf8').digest('hex');
 c.files[0].relativePath='photos/café/🌲.jpg';
 c.manifestSha256=digest(c.files.map(f=>({relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})));
 c.sourceInventorySha256=digest(c.files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256})));
 assert.equal(validateClaim(c).files[0].relativePath,'photos/café/🌲.jpg');
 for(const value of ['bad\ud800.jpg','bad\udc00.jpg']){const bad=structuredClone(c);bad.files[0].relativePath=value;assert.throws(()=>validateClaim(bad),{code:'SOURCE_COPY_CONTRACT_INVALID'});const other=structuredClone(c);other.datasetRelativePath=value;assert.throws(()=>validateClaim(other),{code:'SOURCE_COPY_CONTRACT_INVALID'});}
});
