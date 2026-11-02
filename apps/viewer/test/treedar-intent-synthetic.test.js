'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openFixture } = require('./helpers/treedar-intent-synthetic.cjs');

test('synthetic intent persists and exact replay is guarded after reopening', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treedar-intent-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.sqlite'), a = 'a'.repeat(64), f = 'f'.repeat(64);
  const request = { intentId:'intent-1', projectId:'project-1', assetId:'asset-1', receiptId:'receipt-1', sha256:a, capabilityFingerprint:f, treedar:true, gaussianSplat:false };
  const capability = { available:true, current:true, fingerprint:f };
  const evidence = { authenticated:true, immutable:true, projectId:'project-1', assetId:'asset-1', receiptId:'receipt-1', sha256:a, genuineSensorLidar:true, photogrammetryDerived:false };
  const resolve = () => evidence;
  let fixture = openFixture(file);
  const saved = fixture.prepare(request, capability, resolve);
  fixture.close();
  fixture = openFixture(file);
  try {
    assert.deepEqual(fixture.inspect('intent-1'), saved);
    assert.deepEqual(fixture.prepare(request, capability, resolve), saved);
    for (const [change, caps, proof] of [
      [{}, {...capability, available:false}, resolve],
      [{}, {...capability, current:false}, resolve],
      [{}, {...capability, fingerprint:'b'.repeat(64)}, resolve],
      [{gaussianSplat:true}, capability, resolve],
      [{treedar:false}, capability, resolve],
      [{projectId:'project-2'}, capability, resolve],
      [{sha256:'b'.repeat(64)}, capability, resolve],
      [{}, capability, () => ({...evidence, authenticated:false})],
      [{}, capability, () => ({...evidence, photogrammetryDerived:true})],
      [{receiptId:'receipt-2'}, capability, () => ({...evidence, receiptId:'receipt-2'})],
    ]) assert.throws(() => fixture.prepare({...request, ...change}, caps, proof), {code:'INTENT_REFUSED'});
    assert.deepEqual(fixture.inspect('intent-1'), saved);
    assert.equal(fixture.inspect('unknown'), null);
  } finally { fixture.close(); }
});
