'use strict';
// Byte-level interoperability only; no runtime verifier or authority.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {canonicalBytes}=require('../server/referenceProtocol');
const v=require('./fixtures/processing-v2-reservation-pair-public.json');
const domain=s=>Buffer.from(s+'\0','ascii'),digest=b=>crypto.createHash('sha256').update(b).digest('hex');
test('Processing public pair has matching canonical bytes, intent commitment and signatures',()=>{
 const intent=JSON.parse(v.intentCanonical),receipt=JSON.parse(v.receiptCanonical),i=Buffer.from(v.intentCanonical,'ascii'),r=Buffer.from(v.receiptCanonical,'ascii');
 const idomain=domain('ltds-v2-reservation-intent-experiment-v1'),rdomain=domain('ltds-v2-reservation-receipt-experiment-v1'),idigest=domain('ltds-v2-reservation-intent-digest-experiment-v1');
 const ikey={key:Buffer.from(v.coordinatorSpkiDerHex,'hex'),format:'der',type:'spki'},rkey={key:Buffer.from(v.viewerSpkiDerHex,'hex'),format:'der',type:'spki'},isig=Buffer.from(v.intentSignature,'base64url'),rsig=Buffer.from(v.receiptSignature,'base64url');
 assert.deepEqual(canonicalBytes(intent),i);assert.deepEqual(canonicalBytes(receipt),r);assert.equal(receipt.intentDigest,digest(Buffer.concat([idigest,i])));
 for(const key of 'environment trustDomain coordinatorDeploymentId viewerDeploymentId viewerLedgerId viewerLedgerEpoch idempotencyId intentId jobId attemptId generation inputManifestSha256 objectCount totalSourceBytes byteBudget policyId'.split(' '))assert.equal(receipt[key],intent[key],key);
 assert.equal(intent.audience,intent.viewerDeploymentId);assert.equal(receipt.audience,receipt.coordinatorDeploymentId);assert.equal(intent.operation,'reserve-source');assert.equal(receipt.operation,'reserve-source-committed');
 assert.equal(crypto.verify(null,Buffer.concat([idomain,i]),ikey,isig),true);assert.equal(crypto.verify(null,Buffer.concat([rdomain,r]),rkey,rsig),true);
 assert.equal(crypto.verify(null,Buffer.concat([rdomain,i]),ikey,isig),false);assert.equal(crypto.verify(null,Buffer.concat([rdomain,Buffer.from(v.receiptCanonical+' ')]),rkey,rsig),false);assert.equal(crypto.verify(null,Buffer.concat([rdomain,r]),ikey,rsig),false);
});
