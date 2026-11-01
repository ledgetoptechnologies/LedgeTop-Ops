'use strict';
// Diagnostic observation only; cannot authorize recovery, publication, or acceptance.
const fileEvidence=require('./nativeReferenceDerivativeFilesCandidate');
const hold=()=>Object.assign(new Error('native derivative set requires review'),{code:'native_derivative_set_hold'});
function state(db,attemptId){
  const jobs=db.prepare('SELECT * FROM derivative_jobs WHERE attempt_id=? ORDER BY derivative_type,id').all(attemptId);if(!jobs.length||jobs.length>16)throw hold();
  const pending=[],complete=[],journals=[];for(const job of jobs){const journal=db.prepare('SELECT * FROM derivative_storage_journal WHERE job_id=?').get(job.id);if(!journal)throw hold();journals.push(journal);
    if(job.status==='complete'){complete.push(job.id);continue;}
    if(job.status!=='pending'||job.attempt_count!==0||job.lease_owner!==null||job.lease_expires_at!==null||job.lease_token!==null||job.heartbeat_at!==null||job.first_started_at!==null||job.deadline_at!==null||job.completed_at!==null||job.recovery_requeued_at!==null||job.result_json!=='{}'||journal.state!=='reserved'||journal.lease_token!==null||journal.incomplete_relative_path!==null||journal.complete_relative_path!==null||journal.final_relative_path!==null||journal.actual_byte_size!==null||journal.manifest_sha256!==null||journal.accounted_byte_size!==journal.reserved_byte_size)throw hold();pending.push(job.id);
  }if(!complete.length)throw hold();return{jobs,journals,pending,complete};
}
async function inspect({db,storage,attemptId,authorize,maxBytes,signal,enabled=false}){
  if(enabled!==true||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw hold();
  try{const before=state(db,attemptId),items=[];let remaining=maxBytes,plan=null;for(const jobId of before.complete){if(remaining<1)throw hold();const evidence=await fileEvidence.inspect({db,storage,attemptId,jobId,authorize,maxBytes:remaining,signal,enabled:true});if(plan!==null&&plan!==evidence.activationPlanSha256)throw hold();plan=evidence.activationPlanSha256;remaining-=evidence.byteSize;items.push(evidence);}const after=state(db,attemptId);if(JSON.stringify(before)!==JSON.stringify(after))throw hold();return{state:'derivative_set_evidence_only',attemptId,activationPlanSha256:plan,completed:items,pendingJobIds:before.pending};}catch{throw hold();}
}
module.exports={inspect};
