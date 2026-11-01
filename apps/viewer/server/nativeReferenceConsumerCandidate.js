'use strict';
// Disabled orchestration experiment. No HTTP client, acceptance sender, or cleanup.
const receipts=require('./nativeReferenceReceiptCandidate'),storage=require('./nativeReferenceStorageCandidate'),{validManifest}=require('./nativeReferenceProtocolCandidate');
async function stageAndHold({db,attemptId,root,storageReceiptId,receiptId,manifest,openObject,maxBytes,acceptedAt,authorizeBinding,authorizeReceipt,signal=null,enabled=false}){
  if(enabled!==true)throw new Error('reference consumer hold');const binding=receipts.readBinding(db,attemptId,{authorizeBinding}),expected={jobId:binding.jobId,generation:binding.generation,environment:binding.environment,pipelineDigest:binding.pipelineDigest},snapshot=validManifest(manifest,expected),stored=await storage.stage({root,storageReceiptId,manifest:snapshot,expected,openObject,maxBytes,signal,enabled:true}),input={attemptId,storageReceiptId,receiptId,manifest:snapshot,objects:stored.objects,acceptedAt};const created=receipts.holdReceipt(db,input,{authorizeReceipt,verifyDurableStorage:copy=>copy.storageReceiptId===stored.storageReceiptId&&JSON.stringify(copy.objects)===JSON.stringify(stored.objects)});return{state:'held',created,storageReceiptId,receiptId};
}
module.exports={stageAndHold};
