'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const {openFixture,validateGrant,mac}=require('./helpers/reference-v2-range-ledger-fixture.cjs');
const vectors=require('./fixtures/reference-v2-range-ledger-vectors.json');
test('closed v2 proposal and charged ranges survive close/reopen, replacement and failed verification',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-range-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'fixture.sqlite'),key=Buffer.alloc(32,7),r=vectors.reservation,policy=r.policy;
 const g={...r,...vectors.grants[0]};validateGrant(g,r);
 assert.throws(()=>validateGrant({...g,extra:true},r),{code:'FIXTURE_REJECTED'});
 assert.throws(()=>validateGrant({...g,policy:{...policy,requestBudget:3}},r),{code:'FIXTURE_REJECTED'});
 let f=openFixture(file,key);assert.equal(f.charge(r,g,'object-1',0,4),'charged');f.close();
 f=openFixture(file,key);try{
  assert.equal(f.status(r,'object-1',0).state,'uncertain');
  const r2={...r,generation:vectors.grants[1].generation,reservationId:vectors.grants[1].reservationId},g2={...r2,grantId:vectors.grants[1].grantId};
  assert.throws(()=>f.charge(r2,g2,'object-1',0,4),{code:'FIXTURE_REJECTED'});
  assert.throws(()=>f.verify(r2,'object-1',0,Buffer.from('abcd'),'0'.repeat(64)),{code:'FIXTURE_REJECTED'});
  assert.equal(f.status(r,'object-1',0).state,'uncertain');
  const evidence={identity:JSON.stringify([r.environment,r.jobId,r.manifestSha256]),objectId:'object-1',start:0,length:4,sha256:crypto.createHash('sha256').update('abcd').digest('hex')};
  const proof=mac(key,evidence);assert.throws(()=>f.verify(r,'object-1',0,Buffer.from('abce'),proof),{code:'FIXTURE_REJECTED'});
  f.verify(r,'object-1',0,Buffer.from('abcd'),proof);f.close();f=openFixture(file,key);assert.equal(f.status(r2,'object-1',0).state,'verified');
  assert.equal(f.charge(r2,g2,'object-1',4,4),'charged');
  assert.throws(()=>f.charge(r2,g2,'object-1',8,1),{code:'FIXTURE_REJECTED'});
  assert.deepEqual({...f.usage(r2)},{requests:2,bytes:8});
 }finally{f.close();}
});

test('shared v2 event vectors drive fixture charge, reopen and synthetic evidence checks', t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-range-vectors-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'fixture.sqlite'),key=Buffer.alloc(32,7),base=vectors.reservation;
 let fixture=openFixture(file,key);
 try { for(const event of vectors.events) {
  const ref=vectors.grants[event.grant],reordered={byteBudget:base.policy.byteBudget,requestBudget:base.policy.requestBudget,chunkBytes:base.policy.chunkBytes,version:base.policy.version},r={...base,generation:ref.generation,reservationId:ref.reservationId,policy:event.reorderPolicy?reordered:base.policy},g={...r,grantId:ref.grantId};
  if(event.action==='reopen'){fixture.close();fixture=openFixture(file,key);assert.equal(fixture.status(r,event.objectId,event.start).state,event.expected);}
  else if(event.action==='charge'){const run=()=>fixture.charge(r,g,event.objectId,event.start,event.length);if(event.expected==='rejected')assert.throws(run,{code:'FIXTURE_REJECTED'});else assert.equal(run(),event.expected);}
  else {const bytes=Buffer.from(event.content),evidence={identity:JSON.stringify([r.environment,r.jobId,r.manifestSha256]),objectId:event.objectId,start:event.start,length:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},proof=event.action==='verify-invalid'?'0'.repeat(64):event.proof;if(event.expected==='rejected')assert.throws(()=>fixture.verify(r,event.objectId,event.start,bytes,proof),{code:'FIXTURE_REJECTED'});else {assert.equal(mac(key,evidence),event.proof);fixture.verify(r,event.objectId,event.start,bytes,proof);assert.equal(fixture.status(r,event.objectId,event.start).state,event.expected);}}
  assert.deepEqual({...fixture.usage(r)},{requests:event.requests,bytes:event.bytes});
  assert.equal(fixture.status(r,event.objectId,event.start)?.state??null,event.rangeState);
 }} finally {fixture.close();}
});
