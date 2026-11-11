'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { createSyntheticHandoff } = require('./helpers/synthetic-handoff-rehearsal.cjs');
function fixture(t, failpoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-handoff-'));
  const file = path.join(dir, 'test.sqlite'); let db = new DatabaseSync(file);
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir,{recursive:true,force:true}); });
  return { service:() => createSyntheticHandoff(db,{failpoint}), reopen:() => { db.close(); db = new DatabaseSync(file); return createSyntheticHandoff(db); } };
}
const input = () => ({operationId:'op-1',attemptId:'attempt-1',generation:1,manifestSha256:'a'.repeat(64),request:Buffer.from('synthetic payload')});
const committed = ({operationId,requestSha256}) => ({status:'committed',operationId,requestSha256,receiptId:'fake-receipt-1'});

test('durable intent replays exactly and conflicts on any changed binding', t => {
  const f=fixture(t), s=f.service(), first=input();
  assert.deepEqual(s.prepare(first),{state:'prepared',replay:false});
  const reopened=f.reopen(); assert.deepEqual(reopened.prepare(first),{state:'prepared',replay:true});
  for (const change of [{attemptId:'other'}, {generation:2}, {manifestSha256:'b'.repeat(64)}, {request:Buffer.from('changed')}]) assert.throws(()=>reopened.prepare({...first,...change}),{code:'INTENT_CONFLICT'});
  assert.equal(reopened.get('op-1').state,'prepared');
});
test('failure before intent commit rolls back, and retry after restart is new', t => {
  const f=fixture(t, stage => { if(stage==='before_intent_commit') throw Error('crash'); });
  assert.throws(()=>f.service().prepare(input()),/crash/);
  const reopened=f.reopen(); assert.equal(reopened.get('op-1'),undefined); assert.equal(reopened.prepare(input()).replay,false);
});
test('crash before fake send persists unknown and does not send twice', t => {
  let sends=0; const f=fixture(t, stage => {if(stage==='after_unknown_commit') throw Error('crash');}), s=f.service(); s.prepare(input());
  assert.throws(()=>s.sendOnce('op-1',{send(){sends++;}}),/crash/);
  const reopened=f.reopen(); assert.equal(reopened.get('op-1').state,'outcome_unknown');
  assert.throws(()=>reopened.sendOnce('op-1',{send(){sends++;}}),{code:'HELD_REQUIRES_RECONCILIATION'});
  assert.equal(reopened.reconcile('op-1',{lookup:()=>({status:'unavailable'})}).state,'outcome_unknown'); assert.equal(sends,0);
});
test('crash after fake send reconciles exact committed operation after restart', t => {
  let captured,sends=0; const f=fixture(t,stage=>{if(stage==='after_fake_send')throw Error('crash');}), s=f.service(); s.prepare(input());
  assert.throws(()=>s.sendOnce('op-1',{send(x){sends++;captured=x;return committed(x);}}),/crash/);
  const reopened=f.reopen(); assert.equal(reopened.get('op-1').state,'outcome_unknown');
  assert.equal(reopened.reconcile('op-1',{lookup:()=>committed(captured)}).state,'observed_committed');
  assert.equal(sends,1); assert.throws(()=>reopened.sendOnce('op-1',{}),{code:'HELD_REQUIRES_RECONCILIATION'});
  assert.deepEqual(f.reopen().prepare(input()),{state:'observed_committed',replay:true});
});
test('unavailable, rejected, unknown and mismatched authorities stay held', t => {
  for(const response of [null,{status:'rejected'}, {status:'unavailable'}, {status:'outcome_unknown'}, {status:'committed',operationId:'wrong',requestSha256:'a'.repeat(64),receiptId:'r'}, {status:'committed',operationId:'op-1',requestSha256:'a'.repeat(64),receiptId:'r'}]) {
    const f=fixture(t),s=f.service(); s.prepare(input()); assert.equal(s.sendOnce('op-1',{send:()=>response}).state,'outcome_unknown'); assert.equal(f.reopen().get('op-1').state,'outcome_unknown');
  }
});
test('crash during observation commit leaves unknown for exact reconciliation', t => {
  let captured; const f=fixture(t,stage=>{if(stage==='before_observation_commit')throw Error('crash');}),s=f.service();s.prepare(input());
  assert.throws(()=>s.sendOnce('op-1',{send:x=>(captured=x,committed(x))}),/crash/);
  const reopened=f.reopen(); assert.equal(reopened.get('op-1').state,'outcome_unknown'); assert.equal(reopened.reconcile('op-1',{lookup:()=>committed(captured)}).state,'observed_committed');
});
test('process exit after durable unknown holds operation across a fresh process', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-handoff-process-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const dbPath=path.join(dir,'test.sqlite'), helper=path.join(__dirname,'helpers/synthetic-handoff-rehearsal.cjs');
  const child=`const {DatabaseSync}=require('node:sqlite');const {createSyntheticHandoff}=require(process.argv[2]);const db=new DatabaseSync(process.argv[1]);const s=createSyntheticHandoff(db,{failpoint:n=>{if(n==='after_unknown_commit')process.exit(91)}});s.prepare({operationId:'op-1',attemptId:'attempt-1',generation:1,manifestSha256:'a'.repeat(64),request:Buffer.from('synthetic payload')});s.sendOnce('op-1',{send(){throw Error('must not run')}});`;
  const run=spawnSync(process.execPath,['-e',child,dbPath,helper],{timeout:10000,encoding:'utf8'});
  assert.equal(run.error,undefined); assert.equal(run.status,91,run.stderr);
  const db=new DatabaseSync(dbPath); try { const s=createSyntheticHandoff(db);assert.equal(s.get('op-1').state,'outcome_unknown');assert.throws(()=>s.sendOnce('op-1',{}),{code:'HELD_REQUIRES_RECONCILIATION'}); } finally { db.close(); }
});
