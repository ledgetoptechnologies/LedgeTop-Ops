'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const vector=require('./fixtures/reference-v2-hash-vector.json');
const negative=require('./fixtures/reference-v2-negative-vectors.json');
const {decodeV2Admission,admitLiveV2,createSyntheticAdmission,MAX_BYTES}=require('../server/referenceV2AdmissionCandidate');
const {FIXTURE_SCOPE}=require('../server/referenceV2FixtureLedger');
const {canonicalBytes}=require('../server/referenceProtocol');

test('shared v2 canonical admission and negative wire vectors',()=>{
  const raw=Buffer.from(vector.canonicalAdmission,'utf8');
  assert.equal(decodeV2Admission(raw).requestHash,vector.requestSha256);
  for(const item of negative.vectors)assert.throws(()=>decodeV2Admission(Buffer.from(item.wireHex,'hex')),{code:'invalid_admission'},item.name);
  assert.throws(()=>decodeV2Admission(Buffer.alloc(MAX_BYTES+1,32)),{code:'invalid_admission'});
  const altered=JSON.parse(vector.canonicalAdmission);altered.deliveryId=Buffer.alloc(32,8).toString('base64url');
  assert.equal(decodeV2Admission(canonicalBytes(altered)).requestHash,vector.requestSha256);
});

test('real admission cannot be enabled and synthetic path atomically charges parsed bytes',()=>{
  assert.throws(()=>admitLiveV2(),{code:'v2_not_qualified'});
  const db=new DatabaseSync(':memory:');
  try {
    assert.throws(()=>createSyntheticAdmission(db,'production'),{code:'fixture_scope_required'});
    const ledger=createSyntheticAdmission(db,FIXTURE_SCOPE),raw=Buffer.from(vector.canonicalAdmission,'utf8'),v=JSON.parse(vector.canonicalAdmission);
    ledger.provision({jobId:v.binding.jobId,manifestHash:v.binding.manifestSha256,byteLimit:6,requestLimit:2});
    assert.deepEqual(ledger.admit(raw),{chargedBytes:3});
    assert.throws(()=>ledger.admit(raw),{code:'delivery_already_admitted'});
    const retry=structuredClone(v);retry.deliveryId=Buffer.alloc(32,9).toString('base64url');
    assert.throws(()=>ledger.admit(canonicalBytes(retry)),{code:'fence_required'});
    ledger.fixtureProveStopped(v.deliveryId);
    assert.deepEqual(ledger.admit(canonicalBytes(retry)),{chargedBytes:3});
    assert.equal(db.prepare('SELECT charged_bytes FROM v2_fixture_jobs').get().charged_bytes,6);
    const altered=structuredClone(v);altered.binding.objectLength=2;altered.deliveryId=Buffer.alloc(32,10).toString('base64url');
    assert.throws(()=>ledger.admit(canonicalBytes(altered)),{code:'request_conflict'});
  } finally {db.close()}
});
