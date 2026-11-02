'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateClaim,expectedReceipt,validateReceipt}=require('../server/sourceCopyHandoffContractCandidate');
const vector=require('./fixtures/source-copy-handoff-candidate.json');
test('closed claim and exact receipt bind ordered metadata and generation',()=>{
 const claim=structuredClone(vector.claim);assert.deepEqual(validateClaim(claim),claim);assert.deepEqual(expectedReceipt(claim),vector.receipt);assert.deepEqual(validateReceipt(vector.receipt,claim),vector.receipt);
 for(const bad of [{...claim,extra:true},{...claim,operationId:'another'},{...claim,rootKey:'trash'},{...claim,datasetRelativePath:'../secret'},{...claim,fileCount:2},{...claim,byteSize:4},{...claim,manifestSha256:'a'.repeat(64)},{...claim,sourceInventorySha256:'b'.repeat(64)},{...claim,files:[{...claim.files[0],byteSize:0}]},{...claim,files:[{...claim.files[0],relativePath:'/absolute'}]},{...claim,files:[{...claim.files[0],id:'bad/id'}]}])assert.throws(()=>validateClaim(bad),{code:'SOURCE_COPY_CONTRACT_INVALID'});
 for(const bad of [{...vector.receipt,extra:true},{...vector.receipt,sealed:false},{...vector.receipt,generation:2},{...vector.receipt,sourceInventorySha256:'f'.repeat(64)},{...vector.receipt,sealSha256:'f'.repeat(64)}])assert.throws(()=>validateReceipt(bad,claim),{code:'SOURCE_COPY_CONTRACT_INVALID'});
});
