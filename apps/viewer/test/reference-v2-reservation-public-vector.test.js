'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const vector=require('./fixtures/viewer-synthetic-reservation-v1.json');
const {createSyntheticReservation,SCOPE}=require('../server/referenceV2ReservationFixture');
const {canonicalBytes}=require('../server/referenceProtocol');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('public synthetic vector reproduces reservation bytes and verifies signature',()=>{
 const db=new DatabaseSync(':memory:');try{
  const input={...vector.input,publicKeyDer:Buffer.from(vector.input.publicKeyDer,'base64url')},source=Buffer.from(vector.sourceBase64,'base64'),intent=canonicalBytes({...input,publicKeyDer:vector.input.publicKeyDer});
  assert.equal(sha(source),input.sourceSha256);assert.equal(intent.toString('utf8'),vector.canonicalIntentUtf8);assert.equal(sha(intent),vector.intentSha256);
  const fixture=createSyntheticReservation(db,SCOPE);fixture.provisionQuota(input.byteBudget);fixture.addSource({sourceId:input.sourceId,revision:input.sourceRevision,bytes:source});
  const receipt=fixture.reserve(input).receipt,signature=Buffer.from(vector.signatureBase64url,'base64url'),key={key:input.publicKeyDer,format:'der',type:'spki'},domain=Buffer.from(vector.signatureDomainUtf8WithNul,'utf8');
  assert.equal(receipt.toString('utf8'),vector.receiptUtf8);assert.equal(sha(receipt),vector.receiptSha256);assert.equal(crypto.verify(null,Buffer.concat([domain,receipt]),key,signature),true);
  assert.equal(crypto.verify(null,Buffer.concat([domain,Buffer.from(vector.receiptUtf8+' ')]),key,signature),false);
  assert.equal(crypto.verify(null,Buffer.concat([Buffer.from('wrong-domain\0'),receipt]),key,signature),false);
 }finally{db.close()}
});
