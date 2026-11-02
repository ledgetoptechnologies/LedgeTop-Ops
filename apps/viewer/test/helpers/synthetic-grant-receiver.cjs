'use strict';
// In-memory synthetic receiver: not authenticated, durable or a service.
const p=require('../../server/referenceProtocol');
function receiverFixture(){const sealed=new Map();return {post(bytes){const grant=JSON.parse(bytes.toString('utf8')),digest=p.sha256(p.canonicalBytes(grant)),old=sealed.get(grant.jobId);if(old&&old.digest!==digest)throw Error('synthetic receiver conflict');if(old)return old.ack;const ack={reservationId:grant.reservationId,generation:grant.generation,manifestSha256:grant.manifestSha256,nonce:grant.nonce,accepted:true,grantSha256:digest};sealed.set(grant.jobId,{digest,ack});return ack;}};}
async function replayFixture({broker,owner,input,binding,operationId,senderGeneration,receiver,loseResponse=false,keyProvider}){
 const bytes=owner.issue(operationId,binding,input),grant=JSON.parse(bytes.toString('utf8'));
 if(Date.parse(grant.expiresAt)<=Date.now())throw Error('synthetic expired hold');
 broker.reclaimAtomicDeliveryFixture({scope:'synthetic-only',operationId,senderGeneration});
 const ack=receiver.post(bytes);if(loseResponse){broker.markAtomicDeliveryUncertainFixture({scope:'synthetic-only',operationId,senderGeneration});throw Error('synthetic lost response');}
 broker.acknowledgeAtomicDeliveryFixture({scope:'synthetic-only',operationId,senderGeneration,ack,keyProvider,verifyReceiver:()=>true});return {bytes,ack};
}
module.exports={receiverFixture,replayFixture};
