'use strict';
// Review-only helper. An external supervisor must still fence all other workers
// and bound the process and descendants; abort is cooperative, not a fence.
async function runWithPilotLease({processing,job,owner,work,verifyCompletion,heartbeatMs=10000,leaseSeconds=300,maxDurationMs=240000}){
 if(!processing||!job||job.lease_owner!==owner||typeof job.id!=='string'||!job.id||typeof job.attempt_id!=='string'||!job.attempt_id||!['submit','reconcile','ingest'].includes(job.job_type)||!Number.isSafeInteger(job.attempt_count)||job.attempt_count<1||typeof owner!=='string'||typeof work!=='function'||typeof verifyCompletion!=='function'||!Number.isSafeInteger(heartbeatMs)||heartbeatMs<1||!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1||heartbeatMs*3>=leaseSeconds*1000||maxDurationMs>leaseSeconds*1000)throw Error('invalid pilot lease configuration');
 const controller=new AbortController(),started=performance.now();let failure=null;
 const renew=()=>{if(failure)return;try{const now=new Date().toISOString(),until=new Date(Date.now()+leaseSeconds*1000).toISOString(),result=processing.database.prepare("UPDATE processing_jobs SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND attempt_id=? AND job_type=? AND attempt_count=? AND status='leased' AND lease_owner=? AND lease_expires_at>?").run(now,until,now,job.id,job.attempt_id,job.job_type,job.attempt_count,owner,now);if(result.changes!==1)throw Error('pilot lease lost');}catch(error){failure=error;controller.abort();}};
 renew();if(failure)throw failure;
 const heartbeat=setInterval(renew,heartbeatMs),deadline=setTimeout(()=>{if(!failure){failure=new Error('pilot deadline exceeded');controller.abort();}},maxDurationMs);
 try{const result=await work(controller.signal);if(failure)throw failure;if(performance.now()-started>=maxDurationMs)throw Error('pilot deadline exceeded');if(verifyCompletion({processing,job,owner,result})!==true)throw Error('pilot completion unverified');return result;}finally{clearInterval(heartbeat);clearTimeout(deadline);}
}
module.exports={runWithPilotLease};
