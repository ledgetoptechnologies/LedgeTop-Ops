'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{authorize}=require('../server/nativeReadinessGrantCandidate');
test('signed readiness grant binds authenticated peer, request, identity, lease and short validity',()=>{
  const pair=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),now=Date.now();
  const request={requestId:crypto.randomUUID(),attemptId:crypto.randomUUID(),jobId:crypto.randomUUID(),owner:crypto.randomUUID(),event:{projectId:crypto.randomUUID(),requestedBySubject:'synthetic-subject'}};
  const claims={version:1,issuer:'synthetic-issuer',audience:'viewer-readiness',peerUid:'21002',requestId:request.requestId,attemptId:request.attemptId,jobId:request.jobId,projectId:request.event.projectId,subject:request.event.requestedBySubject,owner:request.owner,notBefore:now-1000,expiresAt:now+1000};
  const sign=(value,key=pair.privateKey)=>{const data=Buffer.from(typeof value==='string'?value:JSON.stringify(value));return data.toString('base64url')+'.'+crypto.sign(null,data,key).toString('base64url');};
  const token=sign(claims),context={token,peerUid:'21002',publicKey,issuer:'synthetic-issuer',nowMs:now};assert.equal(authorize(request,context),true);
  for(const changed of [{...context,peerUid:'568'},{...context,issuer:'other'},{...context,nowMs:now+1000},{...context,nowMs:now-1001},{...context,token:sign(claims,other.privateKey)},{...context,token:token+'='}])assert.equal(authorize(request,changed),false);
  for(const changed of [{...request,requestId:crypto.randomUUID()},{...request,jobId:crypto.randomUUID()},{...request,owner:'wrong'},{...request,event:{...request.event,projectId:crypto.randomUUID()}},{...request,event:{...request.event,requestedBySubject:'other'}}])assert.equal(authorize(changed,context),false);
  assert.equal(authorize(request,{...context,token:sign({...claims,expiresAt:now+600000})}),false);assert.equal(authorize(request,{...context,token:sign({...claims,extra:true})}),false);assert.equal(authorize(request,{...context,token:sign(JSON.stringify(claims).replace('{','{"version":1,'))}),false);
});
