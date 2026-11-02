'use strict';
// File-backed synthetic receiver: not authenticated or a deployed service.
const p=require('../../server/referenceProtocol');
const {DatabaseSync}=require('node:sqlite');
function receiverFixture(file,{now=Date.now}={}){const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS fixture_received (job_id TEXT PRIMARY KEY, digest TEXT NOT NULL, ack TEXT NOT NULL)');return {close(){db.close()},post(bytes){const grant=JSON.parse(bytes.toString('utf8')),digest=p.sha256(p.canonicalBytes(grant));db.exec('BEGIN IMMEDIATE');try{const old=db.prepare('SELECT * FROM fixture_received WHERE job_id=?').get(grant.jobId);if(old&&old.digest!==digest)throw Error('synthetic receiver conflict');if(old){db.exec('COMMIT');return JSON.parse(old.ack);}if(Date.parse(grant.expiresAt)<=now())throw Error('synthetic expired hold');const ack={reservationId:grant.reservationId,generation:grant.generation,manifestSha256:grant.manifestSha256,nonce:grant.nonce,accepted:true,grantSha256:digest};db.prepare('INSERT INTO fixture_received VALUES(?,?,?)').run(grant.jobId,digest,JSON.stringify(ack));db.exec('COMMIT');return ack;}catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}}};}
async function replayFixture({broker,owner,input,binding,operationId,senderGeneration,receiver,loseResponse=false,keyProvider}){
 const bytes=owner.issue(operationId,binding,input),grant=JSON.parse(bytes.toString('utf8'));
 broker.reclaimAtomicDeliveryFixture({scope:'synthetic-only',operationId,senderGeneration});
 const ack=receiver.post(bytes);if(loseResponse){broker.markAtomicDeliveryUncertainFixture({scope:'synthetic-only',operationId,senderGeneration});throw Error('synthetic lost response');}
 broker.acknowledgeAtomicDeliveryFixture({scope:'synthetic-only',operationId,senderGeneration,ack,keyProvider,verifyReceiver:()=>true});return {bytes,ack};
}
module.exports={receiverFixture,replayFixture};
