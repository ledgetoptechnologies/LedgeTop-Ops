'use strict';
// Database evidence only. This does not authorize adoption or prove output bytes or writer fencing.
const intents=require('./nativeDerivativeIntentCandidate');
const completions=require('./nativeDerivativeCompletionCandidate');
const {digest}=require('./nativeReadinessRequestDigestCandidate');
const marker=require('./nativeIngestCommitCandidate');
const referenceReceipts=require('./nativeReferenceReceiptCandidate'),derivativeSnapshots=require('./nativeReferenceDerivativeSnapshotCandidate'),{hash}=require('./nativeReferenceModelSnapshotCandidate');
const hold=()=>Object.assign(new Error('native derivative receipt requires review'),{code:'native_derivative_receipt_hold'});

function inspect(db,{attemptId,jobId,authorize,enabled=false,requireActivation=false}={}){
  if(enabled!==true||typeof attemptId!=='string'||typeof jobId!=='string'||typeof authorize!=='function'||authorize({attemptId,jobId})!==true||db.isTransaction)throw hold();
  try{
    db.exec('BEGIN IMMEDIATE');
    intents.attestInTransaction(db);completions.attestInTransaction(db);
    const job=db.prepare('SELECT attempt_id,status,result_json,lease_owner,lease_expires_at,completed_at FROM derivative_jobs WHERE id=?').get(jobId);
    const intent=db.prepare('SELECT * FROM native_derivative_intent_candidate WHERE job_id=?').get(jobId);
    const receipt=db.prepare('SELECT * FROM native_derivative_receipt_candidate WHERE job_id=?').get(jobId);
    const resolution=db.prepare('SELECT * FROM native_derivative_resolution_candidate WHERE job_id=?').get(jobId);
    if(!job||!intent||!receipt||!resolution||job.attempt_id!==attemptId||job.status!=='complete'||job.lease_owner!==null||job.lease_expires_at!==null||!job.completed_at||intent.attempt_id!==attemptId||intent.request_id!==receipt.request_id||intent.request_digest!==receipt.request_digest||intent.request_digest!==resolution.request_digest||receipt.result_json!==resolution.result_json)throw hold();
    const request=JSON.parse(intent.request_json),result=JSON.parse(receipt.result_json);
    if(request.operation!=='completeDerivative'||request.jobId!==jobId||request.attemptId!==attemptId||request.requestId!==intent.request_id||digest(request)!==intent.request_digest||JSON.stringify(request.result)!==job.result_json||!result||Object.keys(result).sort().join('|')!=='attemptId|commitId|ready'||result.attemptId!==attemptId||typeof result.ready!=='boolean'||(result.ready?(typeof result.commitId!=='string'||marker.read(db,attemptId,true).commit_id!==result.commitId):result.commitId!==null))throw hold();
    let activationPlanSha256=null;
    if(requireActivation===true){
      referenceReceipts.attest(db);
      const activation=db.prepare('SELECT * FROM native_reference_derivative_activation_candidate WHERE attempt_id=?').get(attemptId),registration=db.prepare('SELECT * FROM native_reference_model_registration_candidate WHERE attempt_id=?').get(attemptId),current=db.prepare('SELECT a.result_model_id,a.result_model_version_id,t.active_attempt_id FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id WHERE a.id=?').get(attemptId);
      if(!activation||!registration||!current||activation.stage_id!==registration.stage_id||activation.model_id!==registration.model_id||activation.version_id!==registration.version_id||current.result_model_id!==activation.model_id||current.result_model_version_id!==activation.version_id||current.active_attempt_id!==attemptId)throw hold();
      const plan=JSON.parse(activation.plan_json),actual=derivativeSnapshots.plan(db,attemptId,activation.version_id);
      if(hash(plan)!==activation.plan_sha256||JSON.stringify(plan)!==JSON.stringify(actual)||plan.attemptId!==attemptId||plan.versionId!==activation.version_id||plan.jobs.filter(value=>value.jobId===jobId).length!==1)throw hold();
      activationPlanSha256=activation.plan_sha256;
    }else if(requireActivation!==false)throw hold();
    db.exec('COMMIT');return{state:'receipt_evidence_only',attemptId,jobId,requestDigest:intent.request_digest,ready:result.ready,commitId:result.commitId,...(activationPlanSha256?{activationPlanSha256}:{})};
  }catch{if(db.isTransaction)db.exec('ROLLBACK');throw hold();}
}
module.exports={inspect};
