'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync:Database}=require('node:sqlite');
const {createBatchIntentFixture}=require('../server/referenceBatchIntentFixture');
const {FIXTURE_SCOPE}=require('../server/referenceV2FixtureLedger');
const ids=Array.from({length:6},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const file=(name,role='photo')=>({wireNameUtf8Base64url:Buffer.from(name).toString('base64url'),role,sizeBytes:'6',sha256:'11'.repeat(32)});
const input=()=>({attemptId:ids[0],batchId:ids[1],providerId:ids[2],providerTaskId:ids[3],initializationSha256:'22'.repeat(32),manifestSha256:'33'.repeat(32),reservationSha256:'44'.repeat(32),entries:[file('first.jpg'),file('second.jpg')]});
test('fixture persists immutable batch and maps observations without releasing hold',()=>{
  const db=new Database(':memory:');try{
    assert.throws(()=>createBatchIntentFixture(db,'production'),{code:'fixture_scope_required'});
    let fixture=createBatchIntentFixture(db,FIXTURE_SCOPE),intent=input(),first=fixture.persist(intent);
    assert.equal(first.replayed,false);assert.deepEqual(fixture.persist(intent),{digest:first.digest,replayed:true});
    assert.throws(()=>fixture.persist({...intent,entries:[...intent.entries].reverse()}),{code:'batch_conflict'});
    assert.throws(()=>fixture.persist({...intent,manifestSha256:'55'.repeat(32)}),{code:'batch_conflict'});
    fixture=createBatchIntentFixture(db,FIXTURE_SCOPE);
    const observation={observationId:ids[4],batchId:ids[1],intentSha256:first.digest,complete:true,entries:intent.entries};
    assert.deepEqual(fixture.observe(observation),{comparison:'exact',action:'hold',replayed:false});
    assert.deepEqual(fixture.observe(observation),{comparison:'exact',action:'hold',replayed:true});
    assert.throws(()=>fixture.observe({...observation,complete:false}),{code:'observation_conflict'});
    assert.deepEqual(fixture.observe({...observation,observationId:ids[5],entries:[intent.entries[0]]}),{comparison:'subset',action:'hold',replayed:false});
    assert.throws(()=>fixture.observe({...observation,intentSha256:'66'.repeat(32)}),{code:'intent_mismatch'});
  }finally{db.close()}
});
test('fixture rejects aliases and maps incomplete or conflicting evidence to hold',()=>{
  const db=new Database(':memory:');try{
    const fixture=createBatchIntentFixture(db,FIXTURE_SCOPE),intent=input();
    assert.throws(()=>fixture.persist({...intent,entries:[file('FIRST.jpg'),file('first.jpg')]}),{code:'invalid_fixture_entries'});
    assert.throws(()=>fixture.persist({...intent,entries:[file('../x.jpg')]}),{code:'invalid_fixture_entries'});
    const {digest}=fixture.persist(intent),base={batchId:ids[1],intentSha256:digest,complete:false,entries:[]};
    assert.equal(fixture.observe({...base,observationId:ids[4]}).comparison,'unknown');
    const result=fixture.observe({...base,observationId:ids[5],complete:true,entries:[{...intent.entries[0],sha256:'ff'.repeat(32)}]});
    assert.equal(result.comparison,'conflict');assert.equal(result.action,'hold');
  }finally{db.close()}
});
test('fixture persists across database close and reopen',{skip:!process.env.BATCH_FIXTURE_DB},()=>{
  const intent=input(),db=new Database(process.env.BATCH_FIXTURE_DB);let digest;
  try{digest=createBatchIntentFixture(db,FIXTURE_SCOPE).persist(intent).digest}finally{db.close()}
  const reopened=new Database(process.env.BATCH_FIXTURE_DB);try{
    const fixture=createBatchIntentFixture(reopened,FIXTURE_SCOPE);
    assert.deepEqual(fixture.persist(intent),{digest,replayed:true});
    assert.equal(fixture.observe({observationId:ids[4],batchId:ids[1],intentSha256:digest,complete:true,entries:intent.entries}).action,'hold');
  }finally{reopened.close()}
});
