'use strict';
// Unwired synthetic orchestration experiment only. No real custody or authority.
const {createHash}=require('node:crypto');
const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
function validateJob(job,environment,manifestSha256){if(!job||typeof job.jobId!=='string'||!job.jobId||job.environment!==environment||job.manifestSha256!==manifestSha256||!Number.isSafeInteger(job.generation)||job.generation<1||typeof job.pipelineDigest!=='string'||!/^[a-f0-9]{64}$/.test(job.pipelineDigest))throw fail('reference_synthetic_job_mismatch');return job}
class SyntheticReferenceCoordinator {
 constructor({enabled=false,syntheticOnly=false,journal,fakeCustody,provider}={}){this.enabled=enabled===true;this.syntheticOnly=syntheticOnly===true;this.journal=journal;this.fakeCustody=fakeCustody;this.provider=provider}
 async submit({attemptId,submission,environment}){
  if(!this.enabled||!this.syntheticOnly)throw fail('reference_synthetic_disabled');
  if(environment!=='staging'||typeof attemptId!=='string'||!attemptId||!submission||typeof submission!=='object')throw fail('reference_synthetic_invalid');
  const body=JSON.stringify(structuredClone(submission)),bodySha256=digest(body);
  // This lock is an injected fake for this test seam. A real implementation
  // requires a durable cross-process lease and immutable protected journal.
  return this.journal.withAttemptLock(attemptId,async()=>{
   const frozen=await this.journal.freeze({attemptId,body,bodySha256,environment});
   if(!frozen||frozen.attemptId!==attemptId||frozen.body!==body||frozen.bodySha256!==bodySha256||frozen.environment!==environment)throw fail('reference_synthetic_conflict');
   const request=JSON.parse(frozen.body);
   // Fake marker establishes ordering only; it is not an authenticated receipt.
   const pin=await this.fakeCustody.pin({attemptId,environment,manifestSha256:request.manifest.sha256});
   if(!pin||pin.scope!=='synthetic-only'||pin.attemptId!==attemptId||pin.environment!==environment||pin.manifestSha256!==request.manifest.sha256)throw fail('reference_synthetic_pin_missing');
   if(frozen.job){validateJob(frozen.job,environment,request.manifest.sha256);if(frozen.jobSha256!==digest(JSON.stringify(frozen.job)))throw fail('reference_synthetic_conflict');return structuredClone(frozen.job)}
   // The pipeline digest is opaque and supplied by the server; never compute it
   // from local options. Binding assumes real provider authentication/idempotency.
   const job=validateJob(await this.provider.submit(request),environment,request.manifest.sha256);
   await this.journal.bindJob({attemptId,bodySha256,job,jobSha256:digest(JSON.stringify(job))});return structuredClone(job);
  });
 }
}
module.exports={SyntheticReferenceCoordinator};
