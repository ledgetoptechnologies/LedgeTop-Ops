import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeInviteDeliveryAddress, sealInviteMail, openInviteMail, inviteMailIntent } from '../src/worker/client-onboarding-invite-mail-crypto.ts';
const commandId='11111111-1111-4111-8111-111111111111',invitationId='22222222-2222-4222-8222-222222222222',secret='a'.repeat(64);
const sha=s=>createHash('sha256').update(s).digest('hex');
const binding={commandId,invitationId,requestSha256:'b'.repeat(64),secretSha256:sha(`client-onboarding-invitation-v1:${invitationId}:${secret}`),expiresAt:'2099-01-01T00:00:00.000Z',staffId:'staff:1',accessSubject:'subject:1'};
const keys={encryptionKeyId:'mail-v1',encryptionKeyHex:'c'.repeat(64),fingerprintKeyId:'fingerprint-v1',fingerprintKeyHex:'d'.repeat(64)};
test('mailbox normalization preserves local identity and rejects header or multi-recipient input',()=>{
 assert.equal(normalizeInviteDeliveryAddress(' Test.User+tag@EXAMPLE.COM '),'Test.User+tag@example.com');
 for(const value of ['a@example.com\r\nBcc: x@example.com','a@example.com\n','a@example.com,b@example.com','a..b@example.com','a@example','a@-example.com','a@ex_ample.com',null])assert.equal(normalizeInviteDeliveryAddress(value),null);
});
test('envelope contains no mailbox or bearer and opens only with exact context and keys',async()=>{
 const envelope=await sealInviteMail('Test@example.com',secret,binding,keys);
 assert(!JSON.stringify(envelope).includes('Test@example.com'));assert(!JSON.stringify(envelope).includes(secret));
 assert.deepEqual(await openInviteMail(envelope,binding,keys),{recipient:'Test@example.com',secret});
 for(const altered of [{...binding,requestSha256:'e'.repeat(64)},{...binding,invitationId:commandId},{...binding,staffId:'staff:2'}])await assert.rejects(openInviteMail(envelope,altered,keys));
 await assert.rejects(openInviteMail({...envelope,recipientFingerprint:'e'.repeat(64)},binding,keys));
 await assert.rejects(openInviteMail({...envelope,ciphertextHex:(envelope.ciphertextHex[0]==='e'?'f':'e')+envelope.ciphertextHex.slice(1)},binding,keys));
 await assert.rejects(openInviteMail(envelope,binding,{...keys,encryptionKeyHex:'e'.repeat(64)}));
 await assert.rejects(sealInviteMail('x@example.com','f'.repeat(64),binding,keys));
 await assert.rejects(sealInviteMail('x@example.com',secret,{...binding,staffId:undefined},keys));
 await assert.rejects(sealInviteMail('x@example.com',secret,binding,{...keys,encryptionKeyId:undefined}));
});
test('binding fields reject coercion and sealing errors are redacted',async()=>{
 for(const name of ['commandId','invitationId','requestSha256','secretSha256','expiresAt']) {
  const fake={...binding,[name]:{toString:()=>binding[name]}};
  await assert.rejects(sealInviteMail('private@example.com',secret,fake,keys),{message:'client_onboarding_invite_mail_denied'});
 }
 const faulty={...binding,get commandId(){throw new Error('private@example.com');}};
 await assert.rejects(sealInviteMail('private@example.com',secret,faulty,keys),{message:'client_onboarding_invite_mail_denied'});
});
test('email intent binds normalized address, key version and underlying issuance digest',async()=>{
 const original=await inviteMailIntent('Test@EXAMPLE.COM','b'.repeat(64),'fp-v1','d'.repeat(64));
 assert.deepEqual(original,await inviteMailIntent('Test@example.com','b'.repeat(64),'fp-v1','d'.repeat(64)));
 assert.notEqual(original.requestSha256,'b'.repeat(64));
 for(const args of [['Other@example.com','b'.repeat(64),'fp-v1','d'.repeat(64)],
  ['Test@example.com','e'.repeat(64),'fp-v1','d'.repeat(64)],['Test@example.com','b'.repeat(64),'fp-v2','d'.repeat(64)]])
  assert.notEqual((await inviteMailIntent(...args)).requestSha256,original.requestSha256);
 await assert.rejects(inviteMailIntent('Test@example.com',{toString:()=> 'b'.repeat(64)},'fp-v1','d'.repeat(64)));
});
