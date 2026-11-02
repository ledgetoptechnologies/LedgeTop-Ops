'use strict';
// Synthetic cross-record fixture only. No authentication, custody or receiver.
const crypto=require('node:crypto'),p=require('../../server/referenceProtocol');
const fields=['schemaVersion','receiptType','ackOperationId','acceptanceReceiptId','acceptanceSha256','binding','resultSetId','resultManifestSha256','acceptedArtifactIds','storageReceiptId','issuerId','acknowledgedAt'];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>p.canonicalBytes(x);
const acceptanceDigest=(acceptance,prefix=Buffer.from('LTDS-PARTIAL-ACCEPTANCE-V2\0','ascii'))=>sha(Buffer.concat([prefix,canonical(acceptance)]));
function validateFixture(ack,acceptance){
  const fail=()=>{throw Error('accepted_copy_fixture_invalid')};
  if(!ack||typeof ack!=='object'||Array.isArray(ack)||JSON.stringify(Object.keys(ack).sort())!==JSON.stringify([...fields].sort())||!acceptance||typeof acceptance!=='object')fail();
  if(ack.schemaVersion!==2||ack.receiptType!=='accepted_copy_ack'||typeof ack.issuerId!=='string'||!ack.issuerId||typeof ack.acknowledgedAt!=='string'||!Number.isFinite(Date.parse(ack.acknowledgedAt)))fail();
  if(ack.ackOperationId!==acceptance.ackOperationId||ack.acceptanceReceiptId!==acceptance.receiptId||ack.acceptanceSha256!==acceptanceDigest(acceptance)||ack.resultSetId!==acceptance.resultSetId||ack.resultManifestSha256!==acceptance.resultManifestSha256||ack.storageReceiptId!==acceptance.storageReceiptId)fail();
  if(!canonical(ack.binding).equals(canonical(acceptance.binding))||!Array.isArray(acceptance.acceptedArtifacts)||!acceptance.acceptedArtifacts.length||!Array.isArray(ack.acceptedArtifactIds)||!canonical(ack.acceptedArtifactIds).equals(canonical(acceptance.acceptedArtifacts.map(item=>item.id))))fail();
  if(new Set(ack.acceptedArtifactIds).size!==ack.acceptedArtifactIds.length||ack.acceptedArtifactIds.some(id=>typeof id!=='string'||!id))fail();
  return {scope:'synthetic-cross-record-only',action:'hold'};
}
module.exports={validateFixture,acceptanceDigest};
