'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations}=require('../server/database');
const {evaluateCapacityBudget}=require('../server/capacityBudget');

const sample=(availableBytes,availableInodes)=>({domainId:'shared-nas',domainRevision:'v1',availableBytes,reserveBytes:100,availableInodes,reserveInodes:5});
const item=(id,remainingBytes,remainingInodes)=>({id,domainId:'shared-nas',domainRevision:'v1',remainingBytes,remainingInodes});
const input={domainId:'shared-nas',domainRevision:'v1',samples:[sample(1000,100)],commitments:[],requestBytes:0,requestInodes:0};

test('budget arithmetic groups explicitly identified cross-mount samples by their tightest headroom',()=>{
  const result=evaluateCapacityBudget({...input,samples:[sample(1000,100),sample(800,60)],commitments:[item('a',200,10),item('b',100,5)],requestBytes:400,requestInodes:40});
  assert.deepEqual(result,{allowed:true,usableBytes:700,usableInodes:55,committedBytes:300,committedInodes:15,requiredBytes:700,requiredInodes:55});
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(1000,100),sample(800,60)],commitments:[item('a',200,10)],requestBytes:501,requestInodes:1}).allowed,false);
  assert.equal(evaluateCapacityBudget({...input,commitments:[item('a',1,90)],requestBytes:1,requestInodes:6}).allowed,false);
});

test('a breached reserve denies even zero-sized requests; equality is allowed only without extra work',()=>{
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(99,100)]}).allowed,false);
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(1000,4)]}).allowed,false);
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(99,4)]}).allowed,false);
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(100,5)]}).allowed,true);
  assert.equal(evaluateCapacityBudget({...input,samples:[sample(100,5)],requestInodes:1}).allowed,false);
});

test('unknown domains, stale identity, duplicate rows and unsafe arithmetic fail closed',()=>{
  for(const change of [
    {samples:[]},{samples:[{...sample(500,20),domainRevision:'changed'}]},
    {samples:[{...sample(500,20),domainId:'other'}]},
    {commitments:[item('same',1,1),item('same',1,1)]},
    {commitments:[{...item('one',1,1),domainId:'other'}]},
    {requestBytes:-1},{requestInodes:0.5},{requestBytes:Number.MAX_SAFE_INTEGER,commitments:[item('one',1,0)]},
  ]) assert.throws(()=>evaluateCapacityBudget({...input,...change}),{code:'capacity_budget_invalid'});
});

test('v42 migration adds a disabled unassessed ledger without changing legacy in-flight work',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');
  for(const migration of MIGRATIONS.filter(m=>m.version<=42)){
    db.exec(migration.sql);migration.after?.(db);
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version,migration.name,'2000-01-01T00:00:00Z');
  }
  db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,lease_owner,lease_expires_at,available_at,created_at,updated_at) VALUES('legacy','import_adopt','test','{}','leased','old-worker','2099-01-01T00:00:00Z','t','t','t')").run();
  const before=JSON.stringify(db.prepare("SELECT * FROM dataset_operations WHERE id='legacy'").get());applyMigrations(db);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM dataset_operations WHERE id='legacy'").get()),before);
  assert.deepEqual({...db.prepare('SELECT mode,legacy_state FROM viewer_capacity_control WHERE singleton=1').get()},{mode:'disabled',legacy_state:'unassessed'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM viewer_capacity_reservations').get().n,0);
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=43').get().name,'viewer_cooperative_capacity_ledger');
});

test('ledger records reject inconsistent or decreasing materialized amounts',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());applyMigrations(db);
  db.prepare(`INSERT INTO viewer_capacity_reservations(id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,materialized_bytes,remaining_bytes,peak_inodes,materialized_inodes,remaining_inodes,state,created_at,updated_at) VALUES('r','d','v1','test','w','scope','owner','fence',1,100,10,90,20,2,18,'held','t','t')`).run();
  assert.throws(()=>db.prepare("UPDATE viewer_capacity_reservations SET materialized_bytes=9,remaining_bytes=91 WHERE id='r'").run(),/cannot decrease/);
  assert.throws(()=>db.prepare("UPDATE viewer_capacity_reservations SET materialized_inodes=1,remaining_inodes=19 WHERE id='r'").run(),/cannot decrease/);
  assert.throws(()=>db.prepare("UPDATE viewer_capacity_reservations SET remaining_bytes=0 WHERE id='r'").run(),/CHECK constraint/);
  for(const field of ['owner_generation','peak_bytes','materialized_bytes','remaining_bytes','peak_inodes','materialized_inodes','remaining_inodes']) assert.throws(()=>db.prepare(`UPDATE viewer_capacity_reservations SET ${field}=10.5 WHERE id='r'`).run(),/CHECK constraint/,field);
});
