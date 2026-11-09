'use strict';

const { NodeOdmProvider } = require('./nodeOdmProvider');

async function deliverOneViewerAcceptanceAck(processing,providerCredentials,owner,fetchImpl=fetch){
  const row=processing.claimViewerAcceptanceAck(owner);
  if(!row)return false;
  let errorCode=null;
  try{
    if(!/^https:\/\//i.test(row.provider_endpoint))throw Object.assign(new Error('unsupported_transport'),{code:'unsupported_transport'});
    const payload=JSON.parse(row.payload_json);
    const attempt=processing.getAttempt(row.attempt_id),archive=processing.getAttemptTransferProvenance(row.attempt_id)?.archive;
    const expected={eventId:row.event_id,providerTaskId:row.provider_task_id,attemptId:row.attempt_id,archiveSha256:archive?.archiveSha256,resultModelId:attempt?.resultModelId,resultModelVersionId:attempt?.resultModelVersionId,ingestedAt:attempt?.ingestedAt};
    const keys=payload&&typeof payload==='object'&&!Array.isArray(payload)?Object.keys(payload).sort():[];
    if(keys.join(',')!=='archiveSha256,attemptId,eventId,ingestedAt,providerTaskId,resultModelId,resultModelVersionId'||Object.entries(expected).some(([key,value])=>payload[key]!==value)||!attempt||attempt.taskId!==row.task_id||attempt.providerId!==row.provider_id||attempt.providerTaskId!==row.provider_task_id||row.event_id!==`viewer-acceptance-${attempt.id}`||archive?.attemptId!==row.attempt_id||archive?.providerTaskId!==row.provider_task_id||!/^[a-f0-9]{64}$/.test(archive?.archiveSha256||''))throw Object.assign(new Error('payload_identity_mismatch'),{code:'payload_identity_mismatch'});
    const token=providerCredentials.resolve(row.provider_id),provider=new NodeOdmProvider({endpoint:row.provider_endpoint,token,fetchImpl});
    const route=`/task/${encodeURIComponent(row.provider_task_id)}/viewer-acceptance`;
    const response=await fetchImpl(provider.url(route),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','Idempotency-Key':row.event_id},body:row.payload_json});
    if(response.status!==200&&response.status!==202){try{await response.body?.cancel();}catch{}errorCode=`http_${response.status}`;}
    else{try{await response.body?.cancel();}catch{}processing.completeViewerAcceptanceAck(row.event_id,owner);return true;}
  }catch(error){
    const allowed=new Set(['provider_credential_unavailable','invalid_provider_credential','unsupported_transport','payload_identity_mismatch','AbortError','TimeoutError','ECONNREFUSED','ECONNRESET','ENOTFOUND','EHOSTUNREACH','ETIMEDOUT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN']);
    const code=String(error?.code||error?.name||'delivery_failed');errorCode=allowed.has(code)?code:'delivery_failed';
  }
  processing.retryViewerAcceptanceAck(row.event_id,owner,errorCode,row.attempt_count);
  return true;
}

module.exports={deliverOneViewerAcceptanceAck};
