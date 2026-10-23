import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { PROFILE, checkMode, hash } from './production-deploy.mjs';
import { inventoryDirectory, planRetainedUiAssets } from './production-ui-assets.mjs';

const VERSION = '12345678-1234-4123-8123-123456789abc';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-retained-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), next = path.join(root, 'next');
  for (const directory of [old, next]) fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(old, 'index.html'), '<script src="/assets/old-123.js"></script>');
  fs.writeFileSync(path.join(old, 'assets/old-123.js'), 'old client bytes');
  fs.writeFileSync(path.join(next, 'index.html'), '<script src="/assets/new-456.js"></script>');
  fs.writeFileSync(path.join(next, 'assets/new-456.js'), 'new client bytes');
  const inventory = { schemaVersion: 2, workerName: PROFILE.workers.client.name,
    activeVersionId: VERSION, assetConfigSHA256: PROFILE.workers.client.assetsSHA256,
    supportedVersionIds: [VERSION], files: inventoryDirectory(old) };
  const input = { app: 'client', retainedDirectory: old, candidateDirectory: next,
    activeVersionId: VERSION, assetConfigSHA256: inventory.assetConfigSHA256 };
  function argumentsFor(value = inventory) {
    const inventoryBytes = Buffer.from(JSON.stringify(value));
    return { ...input, inventoryBytes, approvedInventorySHA256: hash(inventoryBytes) };
  }
  return { root, old, next, inventory, input, argumentsFor };
}

test('plans an exact union and preserves rollback bytes without enabling deployment', t => {
  const f = fixture(t), oldBefore = inventoryDirectory(f.old), nextBefore = inventoryDirectory(f.next);
  const plan = planRetainedUiAssets(f.argumentsFor());
  assert.deepEqual(plan.files.map(file => file.path), ['/assets/new-456.js', '/assets/old-123.js', '/index.html']);
  assert.deepEqual(plan.rollback.files, oldBefore);
  assert.equal(plan.files.find(file => file.path === '/assets/old-123.js').sha256, hash('old client bytes'));
  assert.equal(plan.files.find(file => file.path === '/index.html').source, 'candidate');
  assert.equal(plan.deploymentEnabled, false); assert.equal(plan.completenessProvedByPlanner, false);
  assert.equal(plan.writesPerformed, false);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.assetConfigSHA256, f.inventory.assetConfigSHA256);
  assert.equal(plan.rollback.assetConfigSHA256, f.inventory.assetConfigSHA256);
  assert.equal('assetAssociationSHA256' in plan, false);
  assert.equal('assetAssociationSHA256' in plan.rollback, false);
  assert.equal(plan.liveAssetGenerationBindingVerified, false);
  assert.equal(plan.liveAssetContentVerified, false);
  assert.deepEqual(inventoryDirectory(f.old), oldBefore); assert.deepEqual(inventoryDirectory(f.next), nextBefore);
  assert.deepEqual(planRetainedUiAssets(f.argumentsFor()), plan);
  assert.throws(() => checkMode('ui'), /UI deployment denied/);
});

test('requires an externally approved exact manifest digest before reading asset directories', t => {
  const f = fixture(t);
  for (const patch of [{ approvedInventorySHA256: undefined }, { approvedInventorySHA256: 'a'.repeat(64) },
    { inventoryBytes: Buffer.from('{}') }]) {
    assert.throws(() => planRetainedUiAssets({ ...f.argumentsFor(), ...patch, retainedDirectory: 'does-not-exist' }), /reviewed historical inventory digest/);
  }
});

test('rejects changed Worker, active version, asset configuration and unsupported coverage claims', t => {
  const f = fixture(t);
  for (const patch of [{ workerName: 'foreign' }, { activeVersionId: '87654321-1234-4123-8123-123456789abc' },
    { assetConfigSHA256: 'b'.repeat(64) }, { schemaVersion: 1 }, { completeness: true }])
    assert.throws(() => planRetainedUiAssets(f.argumentsFor({ ...f.inventory, ...patch })));
  for (const supportedVersionIds of [[], [VERSION, VERSION], ['invalid'], ['87654321-1234-4123-8123-123456789abc']])
    assert.throws(() => planRetainedUiAssets(f.argumentsFor({ ...f.inventory, supportedVersionIds })), /historical version identities/);
  assert.throws(() => planRetainedUiAssets({ ...f.argumentsFor(), app: 'ops-sync' }), /Only existing UI/);
});

test('rejects the old association field even with a reviewed digest', t => {
  const f = fixture(t), { assetConfigSHA256, ...rest } = f.inventory;
  for (const schemaVersion of [1, 2]) {
    const legacy = { ...rest, schemaVersion, assetAssociationSHA256: assetConfigSHA256 };
    assert.throws(() => planRetainedUiAssets(f.argumentsFor(legacy)), /schema 2/);
  }
  assert.throws(() => planRetainedUiAssets(f.argumentsFor({ ...f.inventory,
    assetAssociationSHA256: assetConfigSHA256 })), /schema 2/);
  const { assetConfigSHA256: ignored, ...inputWithoutConfig } = f.argumentsFor();
  assert.throws(() => planRetainedUiAssets({ ...inputWithoutConfig,
    assetAssociationSHA256: assetConfigSHA256 }), /schema 2/);
});

test('equal asset configuration does not establish content or generation identity', t => {
  const f = fixture(t), before = planRetainedUiAssets(f.argumentsFor());
  fs.writeFileSync(path.join(f.old, 'assets/old-123.js'), 'different retained bytes');
  // Configuration equality cannot substitute for the separately reviewed bytes.
  assert.throws(() => planRetainedUiAssets(f.argumentsFor()), /exactly match/);
  f.inventory.files = inventoryDirectory(f.old);
  const after = planRetainedUiAssets(f.argumentsFor());
  assert.equal(after.activeVersionId, before.activeVersionId);
  assert.equal(after.assetConfigSHA256, before.assetConfigSHA256);
  assert.notEqual(after.historicalInventorySHA256, before.historicalInventorySHA256);
  assert.notEqual(after.unionSHA256, before.unionSHA256);
  for (const plan of [before, after]) {
    assert.equal(plan.liveAssetGenerationBindingVerified, false);
    assert.equal(plan.liveAssetContentVerified, false);
    assert.equal(plan.deploymentEnabled, false);
  }
});

test('rejects incomplete, extra or modified retained payload instead of assuming inventory completeness', t => {
  const f = fixture(t);
  const args = f.argumentsFor();
  fs.writeFileSync(path.join(f.old, 'assets/old-123.js'), 'tampered');
  assert.throws(() => planRetainedUiAssets(args), /exactly match/);
  fs.writeFileSync(path.join(f.old, 'assets/old-123.js'), 'old client bytes');
  fs.writeFileSync(path.join(f.old, 'extra.js'), 'unexpected');
  assert.throws(() => planRetainedUiAssets(args), /exactly match/);
  fs.unlinkSync(path.join(f.old, 'extra.js')); fs.unlinkSync(path.join(f.old, 'assets/old-123.js'));
  assert.throws(() => planRetainedUiAssets(args), /exactly match/);
});

test('only the HTML entry can advance; every retained immutable path keeps exact bytes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.next, 'assets/old-123.js'), 'overwritten client bytes');
  assert.throws(() => planRetainedUiAssets(f.argumentsFor()), /Historical asset path would change bytes/);
  fs.writeFileSync(path.join(f.next, 'assets/old-123.js'), 'old client bytes');
  assert.equal(planRetainedUiAssets(f.argumentsFor()).files.length, 3);
  fs.writeFileSync(path.join(f.old, 'logo.svg'), 'original logo');
  f.inventory.files = inventoryDirectory(f.old);
  fs.writeFileSync(path.join(f.next, 'logo.svg'), 'changed logo');
  assert.throws(() => planRetainedUiAssets(f.argumentsFor()), /Historical asset path would change bytes/);
});

test('rejects ambiguous paths, duplicate names and traversal before reading assets', t => {
  const f = fixture(t);
  for (const value of ['/../escape.js', '/assets/../escape.js', '//host/file', '/assets/a%2fb.js',
    '/assets/a\\b.js', '/assets/a.js?token=secret', '/assets/con.txt', '/assets/dot.', '/assets/a:stream']) {
    const files = [{ ...f.inventory.files[0], path: value }, ...f.inventory.files.slice(1)];
    assert.throws(() => planRetainedUiAssets(f.argumentsFor({ ...f.inventory, files })), /asset path/i);
  }
  assert.throws(() => planRetainedUiAssets(f.argumentsFor({ ...f.inventory,
    files: [...f.inventory.files, { ...f.inventory.files[0], path: f.inventory.files[0].path.toUpperCase() }] })), /Duplicate\/case/);
});

test('rejects candidate case aliases, absent entrypoints and linked payloads', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.next, 'assets/OLD-123.js'), 'old client bytes');
  assert.throws(() => planRetainedUiAssets(f.argumentsFor()), /collide by case/);
  fs.unlinkSync(path.join(f.next, 'assets/OLD-123.js')); fs.unlinkSync(path.join(f.next, 'index.html'));
  assert.throws(() => planRetainedUiAssets(f.argumentsFor()), /HTML entry/);
  fs.linkSync(path.join(f.old, 'assets/old-123.js'), path.join(f.next, 'linked.js'));
  assert.throws(() => inventoryDirectory(f.next), /unlinked regular/);
});
