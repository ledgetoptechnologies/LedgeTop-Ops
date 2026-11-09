'use strict';

const crypto=require('node:crypto');
const {NodeOdmProvider}=require('./nodeOdmProvider');

function validPayload(payload){
  const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
  return payload&&typeof payload==='object'&&!Array.isArray(payload)
    &&typeof payload.eventId==='string'&&/^viewer-acceptance-[a-f0-9-]{36}$/i.test(payload.eventId)
    &&uuid(payload.providerTaskId)&&uuid(payload.attemptId)&&/^[a-f0-9]{64}$/.test(payload.archiveSha256||'')
    &&uuid(payload.resultModelId)&&uuid(payload.resultModelVersionId)
    &&typeof payload.ingestedAt==='string'&&!Number.isNaN(Date.parse(payload.ingestedAt));
}

async function processOneViewerAcceptanceAck({processing,providerCredentials},owner=crypto.randomUUID(),{adapterFactory=(endpoint,token)=>new NodeOdmProvider({endpoint,token})}={}){
  const item=processing.claimViewerAcceptanceAck(owner);
  if(!item)return false;
  try{
    const endpoint=new URL(item.endpoint),payload=item.payload;
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!validPayload(payload))
      throw Object.assign(new Error('Viewer acceptance record is invalid'),{code:'viewer_acceptance_record_invalid'});
    const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if(digest!==item.payloadSha256)throw Object.assign(new Error('Viewer acceptance record integrity check failed'),{code:'viewer_acceptance_record_invalid'});
    const adapter=adapterFactory(item.endpoint,providerCredentials.resolve(item.providerId));
    const result=await adapter.postViewerAcceptance(payload);
    if(!processing.completeViewerAcceptanceAck(item.id,owner,{eventId:result.eventId}))throw Object.assign(new Error('Viewer acceptance lease was lost'),{code:'lease_lost'});
  }catch(error){
    const code=String(error?.code||'viewer_acceptance_failed').replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,80);
    processing.retryViewerAcceptanceAck(item.id,owner,code);
  }
  return true;
}

module.exports={processOneViewerAcceptanceAck,validPayload};
