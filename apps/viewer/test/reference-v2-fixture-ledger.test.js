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

test('two concurrent worker connections cannot overspend the same job', async t => {
  const {Worker}=require('node:worker_threads');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-ledger-race-'));
  const file=path.join(dir,'fixture.sqlite');let db=new DatabaseSync(file);
  let workers=[];
  t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));try{db.close()}catch{}for(const suffix of ['', '-journal', '-wal', '-shm']){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(dir)});
  createFixtureLedger(db,FIXTURE_SCOPE).provision({jobId:'job',manifestHash:'a'.repeat(64),byteLimit:3,requestLimit:2});db.close();
  const barrier=new SharedArrayBuffer(4),state=new Int32Array(barrier),modulePath=require.resolve('../server/referenceV2FixtureLedger');
  const script=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const {createFixtureLedger,FIXTURE_SCOPE}=require(workerData.modulePath);const db=new DatabaseSync(workerData.file);const l=createFixtureLedger(db,FIXTURE_SCOPE);const id=n=>Buffer.alloc(32,n).toString('base64url');parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0,5000);try{l.admit({jobId:'job',manifestHash:'a'.repeat(64),requestId:id(workerData.n),requestHash:(workerData.n===1?'b':'c').repeat(64),deliveryId:id(workerData.n+2),responseBytes:3});parentPort.postMessage('accepted')}catch(e){parentPort.postMessage(e.code||'unexpected_error')}finally{db.close();parentPort.close()}`;
  workers=[1,2].map(n=>new Worker(script,{eval:true,workerData:{file,modulePath,barrier,n}}));
  const outcomes=workers.map(w=>new Promise((resolve,reject)=>{let ready=false;w.on('message',m=>{if(m==='ready'){ready=true;if(workers.every(x=>x.fixtureReady)){Atomics.store(state,0,1);Atomics.notify(state,0,2)} }else resolve(m)});w.on('error',reject);w.on('exit',code=>{if(code!==0)reject(Error('worker exited '+code));else if(!ready)reject(Error('worker exited before barrier'))})}));
  // Mark readiness separately so both admissions are released together.
  for(const w of workers)w.on('message',m=>{if(m==='ready'){w.fixtureReady=true;if(workers.every(x=>x.fixtureReady)){Atomics.store(state,0,1);Atomics.notify(state,0,2)}}});
  const values=await Promise.all(outcomes);assert.deepEqual(values.sort(),['accepted','byte_limit']);
  db=new DatabaseSync(file);assert.equal(db.prepare('SELECT charged_bytes FROM v2_fixture_jobs').get().charged_bytes,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_fixture_deliveries').get().n,1);
});

test('owned child killed after committed admission leaves its charge and active hold', async t => {
  const {spawn}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-v2-ledger-kill-'));
  const file=path.join(dir,'fixture.sqlite');let child,db;
  t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve))}if(db)db.close();for(const suffix of ['', '-journal', '-wal', '-shm']){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(dir)});
  const modulePath=require.resolve('../server/referenceV2FixtureLedger');
  const script=`const {DatabaseSync}=require('node:sqlite');const {createFixtureLedger,FIXTURE_SCOPE}=require(process.argv[1]);const db=new DatabaseSync(process.argv[2]);const l=createFixtureLedger(db,FIXTURE_SCOPE);const id=n=>Buffer.alloc(32,n).toString('base64url');l.provision({jobId:'job',manifestHash:'a'.repeat(64),byteLimit:6,requestLimit:2});l.admit({jobId:'job',manifestHash:'a'.repeat(64),requestId:id(1),requestHash:'b'.repeat(64),deliveryId:id(2),responseBytes:3});process.send('committed');setInterval(()=>{},1000);`;
  child=spawn(process.execPath,['-e',script,modulePath,file],{stdio:['ignore','ignore','ignore','ipc']});
  const committed=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout')),10000);child.once('message',m=>{clearTimeout(timer);resolve(m)});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error('child exited before commit'))})});
  assert.equal(committed,'committed');const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
  db=new DatabaseSync(file);const ledger=createFixtureLedger(db,FIXTURE_SCOPE);
  assert.deepEqual(ledger.fixtureRead(id(2)),{outcome:'recorded',state:'active',chargedBytes:3});
  assert.throws(()=>ledger.admit(input({deliveryId:id(3)})),{code:'fence_required'});
  assert.equal(db.prepare('SELECT charged_bytes FROM v2_fixture_jobs').get().charged_bytes,3);
});
