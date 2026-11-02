'use strict';
// Synthetic file-backed recovery only; retained fixture directory is reported.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const f=require('./helpers/atomic-grant-persistence-fixture.cjs');
test('file-backed synthetic encrypted grants survive reopen and uncertain outcomes hold',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-atomic-grant-fixture-'));t.diagnostic(`Retained synthetic fixture directory: ${root}`);
 const file=path.join(root,'fixture.sqlite'),key=Buffer.alloc(32,17),other=Buffer.alloc(32,18);
 const binding={attemptId:'a',environment:'staging',jobId:'j',generation:1,reservationId:'r',manifestSha256:'a'.repeat(64),objectIds:['one','two']};
 const grant={jobId:'j',environment:'staging',generation:1,reservationId:'r',manifestSha256:binding.manifestSha256,objectIds:['one','two'],token:'synthetic-token-only'};
 const open=()=>{const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');f.schema(db);return db};let db=open();
 try{
  assert.throws(()=>f.issue(db,'precommit',binding,'key-1',key,()=>{throw Error('synthetic mint fault')}));
  assert.equal(db.prepare('SELECT count(*) n FROM synthetic_grants').get().n,0);
  db.exec("CREATE TRIGGER synthetic_insert_fault BEFORE INSERT ON synthetic_grants BEGIN SELECT RAISE(ABORT,'synthetic insert fault'); END");
  assert.throws(()=>f.issue(db,'precommit',binding,'key-1',key,()=>grant));db.exec('DROP TRIGGER synthetic_insert_fault');
  assert.equal(db.prepare('SELECT count(*) n FROM synthetic_grants').get().n,0);
  const original=f.issue(db,'operation',binding,'key-1',key,()=>grant);const row=db.prepare('SELECT * FROM synthetic_grants WHERE operation_id=?').get('operation');
  assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from(grant.token)),false);
  assert.throws(()=>db.exec("INSERT INTO synthetic_grants SELECT 'duplicate',binding,key_id,nonce,ciphertext,tag,digest,state,ack_digest FROM synthetic_grants WHERE operation_id='operation'"));
  db.close();db=open();let mints=0;
  assert.deepEqual(f.issue(db,'operation',binding,'key-1',key,()=>{mints++;return grant}),original);assert.equal(mints,0);
  assert.throws(()=>f.compareGrant(db,'operation',binding,'key-1',key,{...grant,token:'changed'}),/fixture_hold/);
  assert.throws(()=>f.recover(db,'operation',binding,'key-1',null),/fixture_hold/);
  assert.throws(()=>f.recover(db,'operation',binding,'key-2',other),/fixture_hold/);
  assert.throws(()=>f.recover(db,'operation',{...binding,objectIds:['two','one']},'key-1',key),/fixture_hold/);
  f.markSending(db,'operation');db.close();db=open();assert.throws(()=>f.markSending(db,'operation'),/fixture_hold/);
  assert.deepEqual(f.recover(db,'operation',binding,'key-1',key),original);
  const ack='b'.repeat(64);f.acknowledge(db,'operation',ack);db.close();db=open();f.acknowledge(db,'operation',ack);assert.throws(()=>f.acknowledge(db,'operation','c'.repeat(64)),/fixture_hold/);
  db.prepare('UPDATE synthetic_grants SET ciphertext=? WHERE operation_id=?').run(Buffer.from([1,2,3]),'operation');assert.throws(()=>f.recover(db,'operation',binding,'key-1',key),/fixture_hold/);
  assert.equal(db.prepare('SELECT count(*) n FROM synthetic_grants').get().n,1);
 }finally{db.close();}
});
