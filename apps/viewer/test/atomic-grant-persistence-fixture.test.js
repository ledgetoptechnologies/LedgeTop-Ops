'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const f=require('./helpers/atomic-grant-persistence-fixture.cjs');
test('synthetic transaction commits exact encrypted grant and holds uncertain sends',()=>{
 const db=new DatabaseSync(':memory:');try{f.schema(db);const key=Buffer.alloc(32,1),binding={attemptId:'a',environment:'staging',jobId:'j',generation:1,reservationId:'r',manifestSha256:'a'.repeat(64),objectIds:['photo']},grant={jobId:'j',environment:'staging',generation:1,reservationId:'r',manifestSha256:binding.manifestSha256,objectIds:['photo'],token:'synthetic-only'},mint=()=>grant;
 assert.throws(()=>f.issue(db,'before',binding,'key',key,()=>{throw Error('before mint')}));assert.equal(db.prepare('SELECT count(*) n FROM synthetic_grants').get().n,0);
 const bytes=f.issue(db,'op',binding,'key',key,mint);assert.equal(f.recover(db,'op',binding,'key',key).toString(),bytes.toString());let called=0;assert.equal(f.issue(db,'op',binding,'key',key,()=>{called++;return {...grant,token:'wrong'}}).toString(),bytes.toString());assert.equal(called,0);
 assert.throws(()=>f.recover(db,'op',binding,'other',key),/fixture_hold/);assert.throws(()=>f.recover(db,'op',binding,'key',Buffer.alloc(32,2)),/fixture_hold/);assert.throws(()=>f.recover(db,'op',{...binding,objectIds:['other']},'key',key),/fixture_hold/);
 f.markSending(db,'op');assert.throws(()=>f.markSending(db,'op'),/fixture_hold/);f.acknowledge(db,'op','b'.repeat(64));f.acknowledge(db,'op','b'.repeat(64));assert.throws(()=>f.acknowledge(db,'op','c'.repeat(64)),/fixture_hold/);
 }finally{db.close();}
});
