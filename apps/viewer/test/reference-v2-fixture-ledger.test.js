'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createFixtureLedger, FIXTURE_SCOPE } = require('../server/referenceV2FixtureLedger');
const id = n => Buffer.alloc(32, n).toString('base64url');
const input = (overrides = {}) => ({jobId:'job',manifestHash:'a'.repeat(64),requestId:id(1),requestHash:'b'.repeat(64),deliveryId:id(2),responseBytes:3,...overrides});

test('fixture scope, durable charge, duplicate and stopped retry', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-ledger-'));
  const file=path.join(dir,'fixture.sqlite'); let db=new DatabaseSync(file);
  t.after(()=>{ try { db.close(); } catch {} for(const suffix of ['', '-journal', '-wal', '-shm']) { try {fs.unlinkSync(file+suffix)} catch(e) {if(e.code!=='ENOENT')throw e} } fs.rmdirSync(dir); });
  assert.throws(()=>createFixtureLedger(db,'production'),{code:'fixture_scope_required'});
  let ledger=createFixtureLedger(db,FIXTURE_SCOPE);
  ledger.provision({jobId:'job',manifestHash:'a'.repeat(64),byteLimit:6,requestLimit:2});
  assert.deepEqual(ledger.admit(input()),{chargedBytes:3});
  assert.throws(()=>ledger.admit(input()),{code:'delivery_already_admitted'});
  assert.throws(()=>ledger.admit(input({deliveryId:id(3)})),{code:'fence_required'});
  assert.throws(()=>ledger.admit(input({requestHash:'c'.repeat(64),deliveryId:id(3)})),{code:'request_conflict'});
  assert.throws(()=>ledger.admit(input({responseBytes:2,deliveryId:id(3)})),{code:'request_conflict'});
  db.close(); db=new DatabaseSync(file); ledger=createFixtureLedger(db,FIXTURE_SCOPE);
  assert.deepEqual(ledger.fixtureRead(id(2)),{outcome:'recorded',state:'active',chargedBytes:3});
  assert.deepEqual(ledger.fixtureRead(id(9)),{outcome:'unknown'});
  assert.throws(()=>ledger.admit(input({deliveryId:id(3)})),{code:'fence_required'});
  ledger.fixtureProveStopped(id(2));
  assert.deepEqual(ledger.admit(input({deliveryId:id(3)})),{chargedBytes:3});
  ledger.fixtureProveStopped(id(3));
  assert.throws(()=>ledger.admit(input({deliveryId:id(4)})),{code:'byte_limit'});
  const row=db.prepare('SELECT charged_bytes,deliveries FROM v2_fixture_jobs WHERE job_id=?').get('job');
  assert.equal(row.charged_bytes,6); assert.equal(row.deliveries,2);
});

test('separate connections observe atomic charges and conflicting IDs', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-ledger-'));
  const file=path.join(dir,'fixture.sqlite'), a=new DatabaseSync(file), b=new DatabaseSync(file);
  t.after(()=>{a.close();b.close();for(const suffix of ['', '-journal', '-wal', '-shm']){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(dir)});
  const one=createFixtureLedger(a,FIXTURE_SCOPE), two=createFixtureLedger(b,FIXTURE_SCOPE);
  one.provision({jobId:'job',manifestHash:'a'.repeat(64),byteLimit:5,requestLimit:5});
  one.admit(input());
  assert.throws(()=>two.admit(input({requestId:id(5),requestHash:'d'.repeat(64),deliveryId:id(6)})),{code:'byte_limit'});
  assert.throws(()=>two.admit(input({requestId:id(5),requestHash:'d'.repeat(64)})),{code:'delivery_conflict'});
  assert.equal(a.prepare('SELECT COUNT(*) AS n FROM v2_fixture_requests').get().n,1);
  assert.equal(b.prepare('SELECT charged_bytes FROM v2_fixture_jobs').get().charged_bytes,3);
});

test('process exit without database close preserves the committed charge', t => {
  const {spawnSync}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-ledger-'));
  const file=path.join(dir,'fixture.sqlite');
  t.after(()=>{for(const suffix of ['', '-journal', '-wal', '-shm']){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(dir)});
  const modulePath=require.resolve('../server/referenceV2FixtureLedger');
  const script=`const {DatabaseSync}=require('node:sqlite');const {createFixtureLedger,FIXTURE_SCOPE}=require(process.argv[1]);const db=new DatabaseSync(process.argv[2]);const l=createFixtureLedger(db,FIXTURE_SCOPE);const id=n=>Buffer.alloc(32,n).toString('base64url');l.provision({jobId:'job',manifestHash:'a'.repeat(64),byteLimit:6,requestLimit:2});l.admit({jobId:'job',manifestHash:'a'.repeat(64),requestId:id(1),requestHash:'b'.repeat(64),deliveryId:id(2),responseBytes:3});process.exit(7);`;
  // A child exits without closing SQLite; no background process remains.
  const child=spawnSync(process.execPath,['-e',script,modulePath,file],{stdio:'ignore',timeout:10000});
  assert.ok(child.signal || child.status !== 0);
  const db=new DatabaseSync(file);
  try {const ledger=createFixtureLedger(db,FIXTURE_SCOPE);assert.deepEqual(ledger.fixtureRead(id(2)),{outcome:'recorded',state:'active',chargedBytes:3});assert.throws(()=>ledger.admit(input({deliveryId:id(3)})),{code:'fence_required'});assert.equal(db.prepare('SELECT charged_bytes FROM v2_fixture_jobs').get().charged_bytes,3)} finally {db.close()}
});
