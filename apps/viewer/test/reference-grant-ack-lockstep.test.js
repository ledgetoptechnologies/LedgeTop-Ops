'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),p=require('../server/referenceProtocol'),{ReferenceProvider}=require('../server/referenceProvider'),fixture=require('./fixtures/reference-v1.contract.json');
test('six-field grant ACK binds canonical exact token on POST and status',async()=>{
 const grant=fixture.transferGrant,ack=fixture.transferGrantAcknowledgement,expected={jobId:grant.jobId,generation:grant.generation,environment:grant.environment,manifestSha256:grant.manifestSha256,pipelineDigest:'c'.repeat(64),objectIds:grant.objectIds},request={reservationId:grant.reservationId,generation:grant.generation,manifestSha256:grant.manifestSha256,nonce:grant.nonce,byteBudget:grant.byteBudget,expiresAt:grant.expiresAt};
 const job={...expected,phase:'awaiting_transfer',status:'running',nodeId:null,transferRequest:request,transferGrantAcknowledgement:null,error:null,resultManifestSha256:null};delete job.objectIds;
 let mode='pending';const fetchImpl=async(url)=>new Response(JSON.stringify(url.endsWith('/transfer-grants')?(mode==='wrong'?{...ack,grantSha256:'f'.repeat(64)}:ack):{...job,transferGrantAcknowledgement:mode==='pending'?null:ack}),{status:200,headers:{'content-type':'application/json'}});
 const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-owner-token',environment:'staging',enabled:true,fetchImpl});
 assert.equal(p.sha256(p.canonicalBytes(grant)),ack.grantSha256);for(const v of fixture.transferGrantCanonicalizationVectors)assert.equal(p.sha256(p.canonicalBytes({...grant,token:v.token})),v.grantSha256);
 await provider.status(grant.jobId,expected);mode='wrong';await assert.rejects(provider.postTransferGrant(grant.jobId,grant,expected),{code:'BINDING_MISMATCH'});mode='accepted';assert.deepEqual(await provider.postTransferGrant(grant.jobId,grant,expected),ack);
 await assert.rejects(provider.postTransferGrant(grant.jobId,{...grant,token:'changed-token'},expected),{code:'BINDING_MISMATCH'});
 await assert.rejects(provider.status(grant.jobId,expected),{code:'BINDING_REQUIRED'});
 await assert.rejects(provider.status(grant.jobId,{...expected,grantSha256:'f'.repeat(64)}),{code:'BINDING_MISMATCH'});
 assert.deepEqual((await provider.status(grant.jobId,{...expected,grantSha256:ack.grantSha256})).transferGrantAcknowledgement,ack);
});
