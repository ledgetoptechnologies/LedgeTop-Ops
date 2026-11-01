'use strict';

// This synchronous database-only boundary serializes cancellation and reclaim
// with registration. Filesystem discovery and verification occur beforehand.
function registerIngest({processing,repository,fence,modelInput,outputInput}){
  if(processing.database!==repository.database)throw new Error('ingest repositories must share one database');
  const held=()=>{throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});};
  return processing.transaction(()=>{
    const check=()=>{const j=processing.provenanceJob(fence.jobId,fence.owner,'ingest'),a=j&&processing.getAttempt(j.attempt_id),t=a&&processing.getTask(a.taskId);if(!j||j.attempt_id!==fence.attemptId||j.attempt_count!==fence.generation||a?.status!=='ingesting'||t?.activeAttemptId!==a.id)held();};
    check();
    const model=repository.upsertModelVersionInTransaction(modelInput,{ingestFence:fence});
    const version=processing.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,modelInput.providerVersionId);
    if(!version||!processing.setAttemptResultForJobInTransaction(fence.jobId,fence.owner,model.id,version.id,fence.generation))held();
    processing.registerModelOutputInTransaction({...outputInput,modelId:model.id,versionId:version.id,ingestFence:fence});
    check();
    return {model,version};
  });
}
function recordIngestEvidence({processing,fence,write}){
  return processing.transaction(()=>{
    const check=()=>{const j=processing.provenanceJob(fence.jobId,fence.owner,'ingest'),a=j&&processing.getAttempt(j.attempt_id),t=a&&processing.getTask(a.taskId);if(!j||j.attempt_id!==fence.attemptId||j.attempt_count!==fence.generation||a?.status!=='ingesting'||t?.activeAttemptId!==a.id)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});};
    check();write();check();
  });
}
module.exports={registerIngest,recordIngestEvidence};
