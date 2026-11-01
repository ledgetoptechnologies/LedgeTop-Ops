'use strict';
// Inactive same-process experiment; this is not a production service or fence.
const crypto=require('node:crypto'),intents=require('./nativeDerivativeIntentCandidate'),completion=require('./nativeDerivativeCompletionCandidate'),{digest}=require('./nativeReadinessRequestDigestCandidate');
class NativeDerivativeLocalBrokerCandidate{
  constructor(db,{authorizeRequest,authorizeInspect,reviewBaseUrl}={}){if(typeof authorizeRequest!=='function'||typeof authorizeInspect!=='function'||typeof reviewBaseUrl!=='string')throw new Error('derivative broker hold');this.db=db;this.authorizeRequest=authorizeRequest;this.authorizeInspect=authorizeInspect;this.reviewBaseUrl=reviewBaseUrl;}
  async prepareDerivative(input){const old=intents.inspect(this.db,input.jobId,{authorize:this.authorizeInspect});if(old.state==='reconcile'){const expected={operation:'completeDerivative',requestId:old.request.requestId,...input};if(digest(old.request)!==digest(expected))throw new Error('derivative broker hold');return old.request;}return intents.prepare(this.db,{operation:'completeDerivative',requestId:crypto.randomUUID(),...input},{authorize:this.authorizeRequest});}
  async confirmPrepared(request){const old=intents.inspect(this.db,request.jobId,{authorize:this.authorizeInspect});return old.state==='reconcile'&&digest(old.request)===digest(request)&&this.authorizeRequest(request)===true;}
  async completeDerivative(request){if(!await this.confirmPrepared(request))throw new Error('derivative broker hold');return completion.complete(this.db,request,{authorize:this.authorizeRequest,reviewBaseUrl:this.reviewBaseUrl});}
  async reconcilePending(){
    const rows=this.db.prepare("SELECT i.job_id FROM native_derivative_intent_candidate i LEFT JOIN native_derivative_resolution_candidate r ON r.job_id=i.job_id LEFT JOIN native_derivative_receipt_candidate c ON c.job_id=i.job_id LEFT JOIN derivative_jobs j ON j.id=i.job_id WHERE r.job_id IS NULL AND (c.job_id IS NOT NULL OR j.id IS NULL OR j.status<>'leased' OR j.lease_expires_at IS NULL OR j.lease_expires_at>?) ORDER BY i.job_id LIMIT 20").all(new Date().toISOString());
    for(const row of rows){try{intents.reconcile(this.db,row.job_id,{authorizeInspect:this.authorizeInspect,authorizeCompletion:this.authorizeRequest,reviewBaseUrl:this.reviewBaseUrl});}catch(error){const receipt=this.db.prepare('SELECT 1 FROM native_derivative_receipt_candidate WHERE job_id=?').get(row.job_id),job=this.db.prepare('SELECT status,lease_expires_at FROM derivative_jobs WHERE id=?').get(row.job_id);if(!receipt&&job?.status==='leased'&&Date.parse(job.lease_expires_at||'')<=Date.now())continue;throw error;}}
  }
}
module.exports={NativeDerivativeLocalBrokerCandidate};
