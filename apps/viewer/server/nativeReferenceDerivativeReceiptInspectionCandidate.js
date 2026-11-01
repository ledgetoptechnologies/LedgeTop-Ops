'use strict';
// Database evidence only. This does not authorize adoption or prove output bytes or writer fencing.
const intents=require('./nativeDerivativeIntentCandidate');
const completions=require('./nativeDerivativeCompletionCandidate');
const {digest}=require('./nativeReadinessRequestDigestCandidate');
const marker=require('./nativeIngestCommitCandidate');
const hold=()=>Object.assign(new Error('native derivative receipt requires review'),{code:'native_derivative_receipt_hold'});

function inspect(db,{attemptId,jobId,authorize,enabled=false}={}){
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
    db.exec('COMMIT');return{state:'receipt_evidence_only',attemptId,jobId,requestDigest:intent.request_digest,ready:result.ready,commitId:result.commitId};
  }catch{if(db.isTransaction)db.exec('ROLLBACK');throw hold();}
}
module.exports={inspect};
