'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ReferenceAcceptanceLedger, syncDirectory } = require('../server/referenceAcceptance');
const fixture = require('./fixtures/reference-v1.contract.json');
const protocol = require('../server/referenceProtocol');

let directorySupported = true;
try { syncDirectory(os.tmpdir()); } catch (e) { assert.equal(e.code, 'DIRECTORY_DURABILITY_UNAVAILABLE'); directorySupported = false; }
const supported = { skip: !directorySupported && 'Real directory fsync unsupported on this platform; no mocked durability barriers' };
function setup(t, failpoint) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-reference-ledger-test-'));
  const root = path.join(base, 'managed'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'result'));
  fs.writeFileSync(path.join(root, 'result/one.bin'), 'abc'); fs.writeFileSync(path.join(root, 'result/two.bin'), '');
  let ledger;
  t.after(() => { if (ledger) ledger.close(); fs.rmSync(base, { recursive:true, force:true }); });
  const databasePath = path.join(base, 'acceptance.sqlite');
  const open = point => { ledger = new ReferenceAcceptanceLedger({ databasePath, managedRoot:root, failpoint:point }); return ledger; };
  const close = () => { ledger.close(); ledger = null; };
  const expected = { ...fixture.acceptance, objectIds: fixture.resultManifest.objects.map(o => o.id) };
  const input = { expected, resultManifest:structuredClone(fixture.resultManifest), acceptance:structuredClone(fixture.acceptance), objects:[{id:'result-1', relativePath:'result/one.bin'}], pins:[{objectId:'result-1',pinId:'read-1'}], reconstruction:{ datasetId:'synthetic-dataset', projectionVersion:1 } };
  if (directorySupported) open(failpoint);
  return {base,root,databasePath,input,open,close,get ledger(){return ledger;}};
}

test('unsupported directory barrier fails closed before creating ledger', { skip:directorySupported }, t => {
  const s = setup(t);
  assert.throws(() => s.open(), {code:'DIRECTORY_DURABILITY_UNAVAILABLE'});
  assert.equal(fs.existsSync(s.databasePath), false);
});

test('receipt stores reconstruction, exact outbox and derived partial membership across reopen', supported, t => {
  const s = setup(t); const first = s.ledger.accept(s.input);
  assert.deepEqual(first.acceptance, fixture.acceptance);
  assert.deepEqual(first.storage.resultManifest, fixture.resultManifest);
  assert.deepEqual(first.storage.reconstruction, s.input.reconstruction);
  assert.equal(s.ledger.membership('receipt-1',['result-1','result-2']).fullyAccepted, false);
  assert.equal(s.ledger.membership('receipt-1',['result-1']).fullyAccepted, true);
  s.close(); s.open();
  assert.deepEqual(s.ledger.get('receipt-1'), first);
  assert.deepEqual(s.ledger.accept(s.input), first);
  assert.deepEqual(s.ledger.pendingOutbox()[0].payload, fixture.acceptance);
  assert.equal(Object.hasOwn(first.acceptance,'fullyAccepted'), false);
});

test('receipt and generation conflicts cannot replace immutable records', supported, t => {
  const s=setup(t); s.ledger.accept(s.input);
  const changed=structuredClone(s.input); changed.acceptance.acceptedAt='2026-10-27T13:00:00.000Z';
  assert.throws(()=>s.ledger.accept(changed), {code:'ACCEPTANCE_CONFLICT'});
  const conflict=structuredClone(s.input); conflict.acceptance.receiptId='receipt-2'; conflict.acceptance.storageReceiptId='storage-2'; conflict.acceptance.inputManifestSha256='d'.repeat(64); conflict.expected.inputManifestSha256='d'.repeat(64);
  assert.throws(()=>s.ledger.accept(conflict), {code:'GENERATION_CONFLICT'});
  assert.equal(s.ledger.pendingOutbox().length,1);
});

test('digest, binding, accepted closure, path escapes and changed bytes reject before acceptance', supported, t => {
  const s=setup(t);
  for (const mutate of [
    x=>{x.expected.generation=2;},
    x=>{x.expected.resultManifestSha256='d'.repeat(64);},
    x=>{x.objects=[];},
    x=>{x.objects[0].relativePath='../outside.bin';},
    x=>{x.objects[0].relativePath='result/../one.bin';},
    x=>{x.acceptance.acceptedObjectIds=['unknown'];},
  ]) { const input=structuredClone(s.input); mutate(input); assert.throws(()=>s.ledger.accept(input)); }
  fs.writeFileSync(path.join(s.root,'result/one.bin'),'bad');
  assert.throws(()=>s.ledger.accept(s.input), {code:'STORAGE_DIGEST_MISMATCH'});
  assert.equal(s.ledger.get('receipt-1'),null); assert.equal(s.ledger.pendingOutbox().length,0);
});

test('symlink and hardlink objects are never durable acceptance candidates', supported, t => {
  const s=setup(t); const object=path.join(s.root,'result/one.bin'); fs.unlinkSync(object);
  const outside=path.join(s.base,'outside.bin'); fs.writeFileSync(outside,'abc'); fs.symlinkSync(outside,object);
  assert.throws(()=>s.ledger.accept(s.input), {code:'UNSAFE_STORAGE_PATH'});
  fs.unlinkSync(object); fs.linkSync(outside,object);
  assert.throws(()=>s.ledger.accept(s.input), {code:'UNSAFE_STORAGE_OBJECT'});
  assert.equal(s.ledger.pendingOutbox().length,0);
});

test('directory symlink and replacement during file barrier reject', supported, t => {
  const s=setup(t); const sub=path.join(s.root,'result'), moved=path.join(s.base,'moved'); fs.renameSync(sub,moved); fs.symlinkSync(moved,sub,'dir');
  assert.throws(()=>s.ledger.accept(s.input), {code:'UNSAFE_STORAGE_PATH'});
  fs.unlinkSync(sub); fs.renameSync(moved,sub);
  s.close(); s.open(point=>{ if(point==='beforeFileBarrier') {const file=path.join(sub,'one.bin'); fs.renameSync(file,file+'.old'); fs.writeFileSync(file,'abc');} });
  assert.throws(()=>s.ledger.accept(s.input), {code:'STORAGE_OBJECT_CHANGED'});
  assert.equal(s.ledger.pendingOutbox().length,0);
});

for (const point of ['beforeFileBarrier','beforeDirectoryBarrier','beforeLedgerCommit','afterLedgerCommit']) {
  test(`abrupt process exit at ${point}: real SQLite reopen recovers only committed outbox`, supported, t => {
    const s=setup(t); s.close(); const inputFile=path.join(s.base,'input.json'); fs.writeFileSync(inputFile,JSON.stringify(s.input));
    const script=`const fs=require('node:fs'); const {ReferenceAcceptanceLedger}=require(process.argv[1]); const l=new ReferenceAcceptanceLedger({databasePath:process.argv[2],managedRoot:process.argv[3],failpoint:p=>{if(p===process.argv[5])process.exit(73)}}); l.accept(JSON.parse(fs.readFileSync(process.argv[4],'utf8'))); process.exit(74);`;
    const child=spawnSync(process.execPath,['-e',script,require.resolve('../server/referenceAcceptance'),s.databasePath,s.root,inputFile,point],{encoding:'utf8',timeout:10000});
    assert.equal(child.status,73,child.stderr); s.open();
    const committed=point==='afterLedgerCommit';
    assert.equal(s.ledger.pendingOutbox().length,committed?1:0);
    assert.equal(!!s.ledger.get('receipt-1'),committed);
    if(committed) assert.deepEqual(s.ledger.pendingOutbox()[0].payload,fixture.acceptance);
  });
}

test('outbox retry backoff is bounded, exact ACK binding and ACK state survive reopen', supported, t=>{
  const s=setup(t); s.ledger.accept(s.input);
  assert.throws(()=>s.ledger.markAcked('receipt-1',{...fixture.acceptance,generation:2}),{code:'ACK_BINDING_MISMATCH'});
  let now=100;
  for(let attempt=0;attempt<20;attempt++) {
    s.ledger.markFailed('receipt-1',now); const delay=Math.min(300000,1000*2**Math.min(attempt,19));
    assert.equal(s.ledger.pendingOutbox(now+delay-1).length,0);
    assert.equal(s.ledger.pendingOutbox(now+delay)[0].attempts,attempt+1); now+=delay;
  }
  s.close(); s.open(); assert.equal(s.ledger.pendingOutbox(now)[0].attempts,20);
  s.ledger.markAcked('receipt-1',fixture.acceptance); s.close();s.open();
  assert.equal(s.ledger.pendingOutbox(Number.MAX_SAFE_INTEGER).length,0);
  assert.throws(()=>s.ledger.markFailed('receipt-1'),{code:'OUTBOX_NOT_PENDING'});
});

test('pins remain durable and cleanup advice never permits managed or unaccepted copies', supported, t=>{
  const s=setup(t);s.ledger.accept(s.input);s.close();s.open();
  const target={receiptId:'receipt-1',objectId:'result-1',terminalConfirmed:true,target:'producer-source'};
  assert.equal(s.ledger.cleanupEligibility(target),false);
  s.ledger.removePin('receipt-1','result-1','read-1');
  assert.equal(s.ledger.cleanupEligibility(target),true);
  assert.equal(s.ledger.cleanupEligibility({...target,target:'managed-copy'}),false);
  assert.equal(s.ledger.cleanupEligibility({...target,terminalConfirmed:false}),false);
  assert.equal(s.ledger.cleanupEligibility({...target,objectId:'result-2'}),false);
  s.ledger.addPin('receipt-1','result-1','downstream-1');s.close();s.open();
  assert.equal(s.ledger.cleanupEligibility(target),false);
});

test('a second partial acceptance derives complete required membership without a synthetic full receipt', supported,t=>{
  const s=setup(t);s.ledger.accept(s.input);const second=structuredClone(s.input);
  second.acceptance.receiptId='receipt-2';second.acceptance.storageReceiptId='storage-2';second.acceptance.acceptedObjectIds=['result-2'];
  second.objects=[{id:'result-2',relativePath:'result/two.bin'}];second.pins=[];
  s.ledger.accept(second);
  assert.equal(s.ledger.membership('receipt-1',['result-1','result-2']).fullyAccepted,true);
  assert.equal(s.ledger.pendingOutbox().length,2);
});
