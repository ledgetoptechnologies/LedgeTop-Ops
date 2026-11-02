'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateFixture,acceptanceDigest}=require('./helpers/reference-v2-accepted-copy-fixture.cjs');
const base=process.env.PROCESSING_V2_VECTOR_DIR;
test('pinned accepted-copy ACK fixture binds all acceptance identities',{skip:!base},()=>{
  const raw=fs.readFileSync(path.join(base,'valid','combined.json'));
  assert.ok(raw.length<4*1024*1024);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),'0bc5d5307ea52d7fdd63322100d38bb3c76081eeedc0dc14f85a5904b2479d91');
  const docs=JSON.parse(raw).documents,acceptances=docs.filter(x=>x.type==='PartialAcceptance'),acks=docs.filter(x=>x.type==='AcceptedCopyAck');
  assert.ok(acks.length>0);
  for(const {value:ack} of acks){
    const acceptance=acceptances.find(x=>x.value.receiptId===ack.acceptanceReceiptId)?.value;assert.ok(acceptance);
    assert.deepEqual(validateFixture(ack,acceptance),{scope:'synthetic-cross-record-only',action:'hold'});
    for(const key of Object.keys(ack)){
      const changed=structuredClone(ack);
      if(key==='binding')changed.binding.jobId='other-job';else if(key==='acceptedArtifactIds')changed.acceptedArtifactIds=['other-artifact'];else if(key==='schemaVersion')changed.schemaVersion=3;else if(key==='acknowledgedAt')changed.acknowledgedAt='invalid';else if(key==='issuerId')changed.issuerId='';else changed[key]='mismatch';
      assert.throws(()=>validateFixture(changed,acceptance),/accepted_copy_fixture_invalid/,key);
      const missing=structuredClone(ack);delete missing[key];assert.throws(()=>validateFixture(missing,acceptance),/accepted_copy_fixture_invalid/,key);
    }
    assert.throws(()=>validateFixture({...ack,extra:true},acceptance),/accepted_copy_fixture_invalid/);
    const changed=structuredClone(acceptance);changed.acceptedArtifacts[0].sha256='f'.repeat(64);assert.throws(()=>validateFixture(ack,changed),/accepted_copy_fixture_invalid/);
    const multiple=structuredClone(acceptance);multiple.acceptedArtifacts.push({...multiple.acceptedArtifacts[0],id:'another-artifact'});
    const ordered={...ack,acceptanceSha256:acceptanceDigest(multiple),acceptedArtifactIds:multiple.acceptedArtifacts.map(item=>item.id)};
    assert.doesNotThrow(()=>validateFixture(ordered,multiple));
    assert.throws(()=>validateFixture({...ordered,acceptedArtifactIds:[...ordered.acceptedArtifactIds].reverse()},multiple),/accepted_copy_fixture_invalid/);
    const wrongNul=acceptanceDigest(acceptance,Buffer.from('LTDS-PARTIAL-ACCEPTANCE-V2\\0','ascii'));assert.notEqual(wrongNul,ack.acceptanceSha256);
    assert.throws(()=>validateFixture({...ack,acceptanceSha256:wrongNul},acceptance),/accepted_copy_fixture_invalid/);
  }
});
