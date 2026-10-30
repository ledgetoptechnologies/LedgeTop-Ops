'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getStagedCommitment}=require('../server/stagedCommitmentClient');
const uuid='12345678-1234-4234-8234-123456789abc',authority='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',secret=Buffer.alloc(32,7).toString('base64url');
const commitment={schemaVersion:1,taskId:uuid,generation:2,archiveSha256:'a'.repeat(64),archiveBytes:123,coordinatorReceiptSha256:'b'.repeat(64),issuer:'viewer-1',audience:authority,environment:'staging',namespace:'ledgetop-viewer-staged-byte-claim-v1'};
const opts={enabled:true,origin:'https://coordinator.test',principalId:'viewer-1',authorityId:authority,environment:'staging',bearer:secret,capability:secret,taskId:uuid};
function reply(body=JSON.stringify(commitment),extra={}){return new Response(body,{status:200,headers:{'content-type':'application/json',...extra}})}
test('client disabled by default and requires scoped HTTPS credentials',async()=>{
 await assert.rejects(getStagedCommitment({...opts,enabled:false,fetchImpl:()=>assert.fail()}),{code:'staged_commitment_disabled'});
 for(const bad of [{origin:'http://coordinator.test'},{origin:'https://user:pass@coordinator.test'},{origin:'https://coordinator.test/base'},{bearer:'bad'},{capability:'bad'},{taskId:'../x'}])await assert.rejects(getStagedCommitment({...opts,...bad,fetchImpl:()=>assert.fail()}),{code:'staged_commitment_invalid'});
});
test('verifies commitment and sends scoped credentials without redirects',async()=>{
 const value=await getStagedCommitment({...opts,fetchImpl:async(url,init)=>{assert.equal(url.href,`https://coordinator.test/ltds/v1/viewer-staged-acks/${uuid}/commitment`);assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,`Bearer ${secret}`);assert.equal(init.headers['X-LedgeTop-Capability'],secret);return reply();}});
 assert.deepEqual(value,commitment);assert.ok(Object.isFrozen(value));
});
test('rejects ambiguous identities, malformed responses, and mismatched length',async()=>{
 const invalid=[JSON.stringify({...commitment,taskId:authority}),JSON.stringify({...commitment,issuer:'other'}),JSON.stringify({...commitment,audience:uuid}),JSON.stringify({...commitment,environment:'production'}),JSON.stringify({...commitment,generation:0}),JSON.stringify({...commitment,archiveSha256:'A'.repeat(64)}),JSON.stringify({...commitment,extra:1}),JSON.stringify(commitment).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'),'{"schemaVersion":1,"nested":{}}','x'.repeat(4097)];
 for(const body of invalid)await assert.rejects(getStagedCommitment({...opts,fetchImpl:async()=>reply(body)}),{code:'staged_commitment_invalid'});
 for(const headers of [{'content-type':'application/json, application/json'},{'content-encoding':'gzip'},{'content-length':'1, 1'},{'content-length':'1'}])await assert.rejects(getStagedCommitment({...opts,fetchImpl:async()=>reply(JSON.stringify(commitment),headers)}),{code:'staged_commitment_invalid'});
 await assert.rejects(getStagedCommitment({...opts,fetchImpl:async()=>new Response('',{status:409})}),{code:'staged_commitment_invalid'});
});
