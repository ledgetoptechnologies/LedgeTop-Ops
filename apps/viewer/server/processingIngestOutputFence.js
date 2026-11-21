'use strict';
const fail=code=>{throw Object.assign(new Error(code),{code});};

function captureIngestOutputFence(job){
 const fence={jobId:job?.id,owner:job?.lease_owner,claimAttemptCount:job?.attempt_count};
 if(![fence.jobId,fence.owner].every(value=>typeof value==='string'&&value.length>0&&value.length<=200)||
   !Number.isSafeInteger(fence.claimAttemptCount)||fence.claimAttemptCount<1)fail('invalid_ingest_output_claim');
 return Object.freeze(fence);
}

// Scan is synchronous and outside the registration SQL transaction. The
// repository MUST enforce this original claim inside its actual write TX.
function registerIngestModelOutput({processing,storage,destination,output,fence}){
 const original=captureIngestOutputFence({id:fence?.jobId,lease_owner:fence?.owner,attempt_count:fence?.claimAttemptCount});
 const tree=storage.scanAbsolute(destination);
 return processing.registerModelOutput({...output,byteSize:tree.byteSize,...original});
}

// The repository owns BEGIN IMMEDIATE. Validate the original claim and link
// its result inside that same synchronous transaction before its only COMMIT.
function commitIngestModelResult({processing,repository,fence,attemptId,input}){
 const original=captureIngestOutputFence({id:fence?.jobId,lease_owner:fence?.owner,attempt_count:fence?.claimAttemptCount});
 if(!processing?.database||processing.database!==repository?.database||typeof repository.upsertModelVersion!=='function')fail('invalid_ingest_model_composition');
 const check=()=>{
  const owned=processing.provenanceJob(original.jobId,original.owner,'ingest');
  if(!owned||owned.attempt_id!==attemptId||owned.attempt_count!==original.claimAttemptCount)fail('lease_lost');
  const attempt=processing.getAttempt(attemptId);
  if(!attempt||attempt.status!=='ingesting'||input?.provider!=='ltds-processing'||input.providerVersionId!==attemptId||
   input.providerModelId!==attempt.taskId||input.sourceLocator?.attemptId!==attemptId||input.sourceLocator?.taskId!==attempt.taskId||
   input.status!=='importing'||input.makeActive!==false)fail('ingest_model_identity_mismatch');
 };
 check();
 return repository.upsertModelVersion(input,{beforeCommit:({modelId,versionId})=>{
  if(processing.database.isTransaction!==true)fail('ingest_model_transaction_missing');
  check();
  const changed=processing.database.prepare("UPDATE processing_attempts SET result_model_id=?,result_model_version_id=?,updated_at=? WHERE id=? AND status='ingesting'").run(modelId,versionId,new Date().toISOString(),attemptId);
  if(changed.changes!==1)fail('lease_lost');
  check();
 }});
}
module.exports={captureIngestOutputFence,registerIngestModelOutput,commitIngestModelResult};
