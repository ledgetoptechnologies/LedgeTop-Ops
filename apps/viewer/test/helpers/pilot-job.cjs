'use strict';
const {runWithPilotLease}=require('./pilot-lease.cjs'),{verifyPilotCompletion}=require('./pilot-completion.cjs'),{completionReceipt}=require('./pilot-receipts.cjs');
async function executePilotJob({processing,job,identity,runId,deps,work,emit}){
 let observedArchive;
 await runWithPilotLease({processing,job,owner:job.lease_owner,work:signal=>work(job,{...deps,signal}),verifyCompletion:()=>verifyPilotCompletion({processing,job,identity,capture:archive=>{observedArchive=archive;}})});
 if(job.job_type==='ingest'){
  if(observedArchive?.sha256!==identity.expectedArchive?.sha256||observedArchive?.byteSize!==identity.expectedArchive?.byteSize)throw Error('pilot archive evidence mismatch');
 }
 const receipt=completionReceipt({runId,identity,job,attemptStatus:processing.getAttempt(identity.attemptId).status,observedArchive});
 emit(receipt);
 return receipt;
}
module.exports={executePilotJob};
