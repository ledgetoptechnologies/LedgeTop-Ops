'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const {openFixture,validateGrant,mac}=require('./helpers/reference-v2-range-ledger-fixture.cjs');
test('closed v2 proposal and charged ranges survive close/reopen, replacement and failed verification',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-range-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'fixture.sqlite'),key=Buffer.alloc(32,7),policy={version:1,chunkBytes:4,requestBudget:2,byteBudget:8};
 const r={version:2,environment:'staging',jobId:'job-1',manifestSha256:'a'.repeat(64),generation:1,reservationId:'reservation-1',policy};
 const g={...r,grantId:'grant-1'};validateGrant(g,r);
 assert.throws(()=>validateGrant({...g,extra:true},r),{code:'FIXTURE_REJECTED'});
 assert.throws(()=>validateGrant({...g,policy:{...policy,requestBudget:3}},r),{code:'FIXTURE_REJECTED'});
 let f=openFixture(file,key);assert.equal(f.charge(r,g,'object-1',0,4),'charged');f.close();
 f=openFixture(file,key);try{
  assert.equal(f.status(r,'object-1',0).state,'uncertain');
  const r2={...r,generation:2,reservationId:'reservation-2'},g2={...r2,grantId:'grant-2'};
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
