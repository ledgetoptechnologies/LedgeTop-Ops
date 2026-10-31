'use strict';
// Review-only evidence check; not a fence against other writers or rollback.
function verifyPilotCompletion({processing,job,identity,capture}){
 if(!processing?.database||!job||!identity||job.attempt_id!==identity.attemptId||!Number.isSafeInteger(job.attempt_count)||job.attempt_count<1)return false;
 if(processing.database.isTransaction)throw Error('pilot completion requires its own read snapshot');
 processing.database.exec('BEGIN');
 try{const valid=readPilotCompletion({processing,job,identity});if(valid&&capture){const archive=job.job_type==='ingest'?processing.getAttemptTransferProvenance(identity.attemptId)?.archive:null;capture(archive?{sha256:archive.archiveSha256,byteSize:archive.archiveByteSize}:null);}return valid;}finally{processing.database.exec('ROLLBACK');}
}
function readPilotCompletion({processing,job,identity}){
 const row=processing.database.prepare(`SELECT j.status AS job_status,j.lease_owner,j.attempt_count,j.job_type,a.status AS attempt_status,a.submission_phase,a.provider_id,a.provider_task_id,a.task_id,t.active_attempt_id FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id JOIN processing_tasks t ON t.id=a.task_id WHERE j.id=? AND j.attempt_id=?`).get(job.id,identity.attemptId);
 if(!row||row.job_status!=='complete'||row.lease_owner!==null||row.attempt_count!==job.attempt_count||row.job_type!==job.job_type||row.provider_id!==identity.providerId||row.provider_task_id!==identity.providerTaskId||row.task_id!==identity.taskId||row.active_attempt_id!==identity.attemptId)return false;
 if(job.job_type==='submit')return row.submission_phase==='committed'&&row.attempt_status==='queued_upstream'&&Boolean(processing.database.prepare("SELECT 1 FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").get(identity.attemptId));
 if(job.job_type==='reconcile')return row.attempt_status==='ingesting'&&Boolean(processing.database.prepare("SELECT 1 FROM processing_jobs WHERE attempt_id=? AND job_type='ingest' AND status='pending'").get(identity.attemptId));
 if(job.job_type==='ingest'){const archive=processing.getAttemptTransferProvenance(identity.attemptId)?.archive,expected=identity.expectedArchive;return row.attempt_status==='derivatives'&&typeof expected?.sha256==='string'&&/^[a-f0-9]{64}$/.test(expected.sha256)&&Number.isSafeInteger(expected.byteSize)&&expected.byteSize>0&&archive?.archiveSha256===expected.sha256&&archive?.archiveByteSize===expected.byteSize&&Boolean(processing.database.prepare("SELECT 1 FROM derivative_jobs WHERE attempt_id=? AND derivative_type='mesh_tiles' AND status='pending'").get(identity.attemptId));}
 return false;
}
module.exports={verifyPilotCompletion};
