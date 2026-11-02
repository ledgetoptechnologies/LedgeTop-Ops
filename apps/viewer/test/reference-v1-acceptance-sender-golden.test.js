'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixtures/reference-v1-acceptance-sender.golden.json');
const p=require('../server/referenceProtocol'),{ReferenceProvider}=require('../server/referenceProvider');
const {validateResultBinding}=require('../server/referenceResultJournal');
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const job=(phase='completed')=>({jobId:fixture.expected.jobId,generation:1,environment:'staging',phase,
  manifestSha256:fixture.expected.inputManifestSha256,pipelineDigest:fixture.expected.pipelineDigest,
  status:phase==='completed'?'succeeded':'running',nodeId:null,transferRequest:null,
  transferGrantAcknowledgement:null,error:null,resultManifestSha256:fixture.expected.resultManifestSha256});
test('public synthetic golden matches reference-v1 canonical receipt and result binding',()=>{
  const bytes=p.canonicalBytes(fixture.acceptance);assert.equal(bytes.toString(),fixture.canonicalAcceptanceUtf8);
  assert.equal(p.sha256(bytes),fixture.acceptanceSha256);
  assert.equal(p.resultManifestSha256(fixture.resultManifest),fixture.expected.resultManifestSha256);
  assert.doesNotThrow(()=>p.validateAcceptance(fixture.acceptance,{...fixture.expected,objectIds:['archive-1']}));
});
test('separate synthetic bridge-key vector matches the local result binding',()=>{
  const candidate={...fixture.acceptance,receiptId:fixture.bridgeKeyCandidate.receiptId,storageReceiptId:fixture.bridgeKeyCandidate.storageReceiptId};
  const key=p.sha256(p.canonicalBytes(validateResultBinding(fixture.expected,fixture.resultManifest,'archive-1')));
  assert.equal(key,candidate.storageReceiptId);assert.equal(p.sha256(p.canonicalBytes(candidate)),fixture.bridgeKeyCandidate.canonicalAcceptanceSha256);
  assert.doesNotThrow(()=>p.validateAcceptance(candidate,{...fixture.expected,objectIds:['archive-1']}));
});
test('actual v1 sender retries identical receipt after a lost response and validates confirmation',async()=>{
  const bodies=[];let lost=true,invalid=false;
  const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async(url,init)=>{
    if(url.endsWith('/results'))return response(fixture.resultManifest);
    if(url.endsWith('/acceptance')){
      bodies.push(init.body);if(lost){lost=false;throw Error('synthetic lost reply')}
      return response({job:job(),created:false,fullyAccepted:true,acceptedObjectIds:invalid?[]:['archive-1']});
    }
    throw Error('unexpected fixture route');
  }});
  await provider.results(fixture.expected.jobId,fixture.expected);
  await assert.rejects(provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected),{code:'UNCERTAIN'});
  const result=await provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected);
  assert.equal(result.fullyAccepted,true);assert.equal(result.created,false);assert.deepEqual(result.acceptedObjectIds,['archive-1']);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.deepEqual(JSON.parse(bodies[0]),fixture.acceptance);
  invalid=true;await assert.rejects(provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected),{code:'BINDING_MISMATCH'});
  const changed={...fixture.acceptance,jobId:'44444444-4444-4444-8444-444444444444'};
  const count=bodies.length;await assert.rejects(provider.acceptResult(fixture.expected.jobId,changed,fixture.expected),{code:'BINDING_MISMATCH'});assert.equal(bodies.length,count);
});
test('actual sender accepts exact legacy and receipt-bound confirmations and rejects conflicting envelopes',async()=>{
  const base={job:job(),created:false,fullyAccepted:true,acceptedObjectIds:['archive-1']};let envelope=base;
  const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async url=>{
    if(url.endsWith('/results'))return response(fixture.resultManifest);
    if(url.endsWith('/acceptance'))return response(envelope);
    throw Error('unexpected fixture route');
  }});
  await provider.results(fixture.expected.jobId,fixture.expected);
  assert.deepEqual(await provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected),base);
  const extended={...base,receiptId:fixture.acceptance.receiptId,receiptSha256:fixture.acceptanceSha256};
  envelope=extended;assert.deepEqual(await provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected),extended);
  for(const invalid of [
    {...base,receiptId:fixture.acceptance.receiptId},
    {...base,receiptSha256:fixture.acceptanceSha256},
    {...extended,unexpected:true},
    {...extended,receiptId:'other-receipt'},
    {...extended,receiptSha256:'0'.repeat(64)},
    {...extended,receiptSha256:fixture.acceptanceSha256.toUpperCase()},
    {...extended,receiptSha256:null},
  ]){
    envelope=invalid;await assert.rejects(provider.acceptResult(fixture.expected.jobId,fixture.acceptance,fixture.expected));
  }
});
test('receipt confirmation binds the immutable sent snapshot despite caller mutation',async()=>{
  let receipt=structuredClone(fixture.acceptance),sent;
  const provider=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async(url,init)=>{
    if(url.endsWith('/results'))return response(fixture.resultManifest);
    if(url.endsWith('/acceptance')){sent=JSON.parse(init.body);receipt.receiptId='caller-mutated';return response({job:job(),created:true,fullyAccepted:true,acceptedObjectIds:['archive-1'],receiptId:fixture.acceptance.receiptId,receiptSha256:fixture.acceptanceSha256})}
    throw Error('unexpected fixture route');
  }});
  await provider.results(fixture.expected.jobId,fixture.expected);
  const result=await provider.acceptResult(fixture.expected.jobId,receipt,fixture.expected);
  assert.equal(receipt.receiptId,'caller-mutated');assert.deepEqual(sent,fixture.acceptance);assert.equal(result.receiptId,fixture.acceptance.receiptId);
});
