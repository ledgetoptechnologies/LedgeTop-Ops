'use strict';
// Receipt trust derives from the supervisor's read-only mount, not this parser.
const fs=require('node:fs');
function readTerminalReceipt({file,runId,providerTaskId}){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>4096)throw Error('terminal receipt invalid');const r=JSON.parse(fs.readFileSync(fd,'utf8'));if(r.schemaVersion!==1||r.runId!==runId||r.providerTaskId!==providerTaskId||r.status!=='completed'||typeof r.archiveSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.archiveSha256)||!Number.isSafeInteger(r.archiveByteSize)||r.archiveByteSize<1)throw Error('terminal receipt mismatch');return{sha256:r.archiveSha256,byteSize:r.archiveByteSize};}finally{fs.closeSync(fd);}
}
function completionReceipt({runId,identity,job,attemptStatus,observedArchive}){
 const receipt={schemaVersion:1,runId,projectId:identity.projectId,datasetId:identity.datasetId,taskId:identity.taskId,attemptId:identity.attemptId,providerId:identity.providerId,providerTaskId:identity.providerTaskId,manifestSha256:identity.manifestSha256,jobId:job.id,jobType:job.job_type,claimOwner:job.lease_owner,claimCount:job.attempt_count,attemptStatus};
 if(job.job_type==='ingest'){receipt.expectedArchive=identity.expectedArchive;receipt.observedArchive=observedArchive;}
 return receipt;
}
module.exports={readTerminalReceipt,completionReceipt};
