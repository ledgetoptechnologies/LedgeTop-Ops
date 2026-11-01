'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validate}=require('../server/nativeEpochReceiptCandidate'),{buildPlan}=require('../server/nativePlanCandidate'),{parse}=require('../server/nativeBindingStrictJson');
// Copied byte-for-byte from Processing commit d285f8e, blob b3c694cafc325933775272deb28d41dc0ec55650.
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/native-plan-epoch-wire-vectors.json'),'utf8'));
test('Processing canonical vectors match Viewer decoding and plan construction',()=>{
  assert.equal(fixture.profile,'native-plan-epoch-v2-experiment');
  for(const vector of fixture.vectors)assert.equal(crypto.createHash('sha256').update(vector.canonical,'utf8').digest('hex'),vector.sha256);
  const wire=fixture.vectors.find(v=>v.name==='open_unbound_wrapper'),envelope=parse(Buffer.from(wire.canonical));
  const r=envelope.result,expected={operationId:r.operationId,taskUuid:r.taskUuid,environment:r.environment,manifestId:r.manifestId,manifestSha256:r.manifestSha256};
  assert.equal(validate(envelope,expected,{action:'status'}).state,'open_unbound');
  const v=fixture.vectors.find(v=>v.name==='unicode_plan_request'),plan=parse(Buffer.from(v.canonical));
  const built=buildPlan({receipt:{environment:plan.environment,taskUuid:plan.taskUuid,generation:plan.generation,bindingId:plan.bindingId,manifestSha256:plan.manifestSha256},taskName:plan.taskName,options:{},outputs:plan.outputs,catalogDigest:plan.expectedCatalogDigest});
  assert.deepEqual(built.bytes,Buffer.from(v.canonical,'utf8'));
});
