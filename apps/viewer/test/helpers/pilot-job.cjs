'use strict';
const {runWithPilotLease}=require('./pilot-lease.cjs'),{verifyPilotCompletion}=require('./pilot-completion.cjs'),{completionReceipt}=require('./pilot-receipts.cjs');
async function executePilotJob({processing,job,identity,runId,deps,work,emit}){
 await runWithPilotLease({processing,job,owner:job.lease_owner,work:signal=>work(job,{...deps,signal}),verifyCompletion:()=>verifyPilotCompletion({processing,job,identity})});
 const receipt=completionReceipt({runId,identity,job,attemptStatus:processing.getAttempt(identity.attemptId).status});
 emit(receipt);
 return receipt;
}
module.exports={executePilotJob};
