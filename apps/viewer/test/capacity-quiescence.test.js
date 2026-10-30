'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {reconcileRetained}=require('../server/capacityLedgerService');
const {createQuiescenceVerifier}=require('../server/capacityQuiescence');
const binding={id:'r',ownerId:'owner',fenceToken:'fence',generation:1};
function fixture(t){const db=new DatabaseSync(':memory:');applyMigrations(db);t.after(()=>db.close());db.exec("UPDATE viewer_capacity_control SET mode='cooperative',legacy_state='verified'; INSERT INTO viewer_capacity_reservations VALUES('r','domain','v1','copy','w','scope','owner','fence',1,100,10,90,10,1,9,'held','t','t')");return db;}
function verifier(resultFn,clock=()=>performance.now()){return createQuiescenceVerifier({verifier:{verify:b=>resultFn(b)},clock});}
test('only explicit held-to-quiescing-to-retained transitions are permitted; no release',t=>{
 const db=fixture(t);assert.throws(()=>db.exec("UPDATE viewer_capacity_reservations SET state='complete' WHERE id='r'"),/state transition forbidden/);
 db.exec("UPDATE viewer_capacity_reservations SET state='quiescing' WHERE id='r'");
 const v=verifier(b=>({...b,quiescent:true,verifiedAt:performance.now()}));
 assert.deepEqual(reconcileRetained(db,binding,v),{id:'r',state:'retained',remainingBytes:90,remainingInodes:9,idempotent:false});
 assert.equal(reconcileRetained(db,binding,v).idempotent,true);
 assert.throws(()=>db.exec("DELETE FROM viewer_capacity_reservations WHERE id='r'"),/deletion is forbidden/);
 assert.throws(()=>db.exec("UPDATE viewer_capacity_reservations SET state='complete' WHERE id='r'"),/state transition forbidden/);
 assert.equal(db.prepare("SELECT remaining_bytes FROM viewer_capacity_reservations WHERE id='r'").get().remaining_bytes,90);
});
test('live or unknown writer, fabricated verifier, stale generation and expired proof retain full commitment',t=>{
 const db=fixture(t);db.exec("UPDATE viewer_capacity_reservations SET state='quiescing' WHERE id='r'");
 assert.throws(()=>reconcileRetained(db,binding,{check:()=>({}),validate:()=>{}}),{code:'capacity_quiescence_unavailable'});
 const live=verifier(b=>({...b,quiescent:false,verifiedAt:performance.now()}));assert.throws(()=>reconcileRetained(db,binding,live),{code:'capacity_quiescence_unavailable'});
 const stale=verifier(b=>({...b,generation:2,quiescent:true,verifiedAt:performance.now()}));assert.throws(()=>reconcileRetained(db,binding,stale),{code:'capacity_quiescence_unavailable'});
 let clock=10;const expired=verifier(b=>{clock=3000;return {...b,quiescent:true,verifiedAt:3000}},()=>clock);assert.throws(()=>reconcileRetained(db,binding,expired),{code:'capacity_quiescence_unavailable'});
 assert.deepEqual({...db.prepare("SELECT state,remaining_bytes,remaining_inodes FROM viewer_capacity_reservations WHERE id='r'").get()},{state:'quiescing',remaining_bytes:90,remaining_inodes:9});
});
test('owner identity and generation cannot change away and back during verification',t=>{
 const db=fixture(t);db.exec("UPDATE viewer_capacity_reservations SET state='quiescing' WHERE id='r'");
 for(const sql of ["UPDATE viewer_capacity_reservations SET owner_generation=2 WHERE id='r'","UPDATE viewer_capacity_reservations SET owner_id='other' WHERE id='r'","UPDATE viewer_capacity_reservations SET fence_token='other' WHERE id='r'"]){
  const v=verifier(b=>{db.exec(sql);return {...b,quiescent:true,verifiedAt:performance.now()}});
  assert.throws(()=>reconcileRetained(db,binding,v),{code:'capacity_quiescence_unavailable'});
 }
 assert.deepEqual({...db.prepare("SELECT state,owner_generation,owner_id,fence_token FROM viewer_capacity_reservations WHERE id='r'").get()},{state:'quiescing',owner_generation:1,owner_id:'owner',fence_token:'fence'});
});

test('after interruption and reopening a file database, unverified reservation remains held',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-quiesce-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite');
 let db=new DatabaseSync(file);applyMigrations(db);db.exec("UPDATE viewer_capacity_control SET mode='cooperative',legacy_state='verified'; INSERT INTO viewer_capacity_reservations VALUES('r','domain','v1','copy','w','scope','owner','fence',1,100,10,90,10,1,9,'quiescing','t','t')");
 const failing=verifier(()=>{throw Error('worker unresponsive')});assert.throws(()=>reconcileRetained(db,binding,failing),{code:'capacity_quiescence_unavailable'});db.close();
 db=new DatabaseSync(file);assert.deepEqual({...db.prepare("SELECT state,remaining_bytes,remaining_inodes FROM viewer_capacity_reservations WHERE id='r'").get()},{state:'quiescing',remaining_bytes:90,remaining_inodes:9});assert.throws(()=>db.exec("DELETE FROM viewer_capacity_reservations WHERE id='r'"),/deletion is forbidden/);
 const success=verifier(b=>({...b,quiescent:true,verifiedAt:performance.now()}));assert.equal(reconcileRetained(db,binding,success).idempotent,false);db.close();
 db=new DatabaseSync(file);try{const retry=reconcileRetained(db,binding,success);assert.equal(retry.idempotent,true);assert.equal(retry.remainingBytes,90);assert.equal(retry.remainingInodes,9);}finally{db.close();}
});
