'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ASSET, SHA256, carryVerifiedAsset } = require('../scripts/carry-viewer-asset.cjs');
const crypto = require('node:crypto');
const source = path.join(__dirname, '..', 'release-assets', ASSET);

test('retained bundle is exact and installs without replacing a current build', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-carry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), SHA256);
  const destination = carryVerifiedAsset(source, dir);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
  assert.equal(carryVerifiedAsset(source, dir), destination);
  fs.writeFileSync(destination, 'current build');
  assert.throws(() => carryVerifiedAsset(source, dir), /collision/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'current build');
});

test('retained bundle rejects changed input and symlink collision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-carry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const changed = path.join(dir, 'changed'); fs.writeFileSync(changed, 'modified');
  assert.throws(() => carryVerifiedAsset(changed, dir), /hash mismatch/);
  const assets = path.join(dir, 'assets'); fs.mkdirSync(assets);
  try { fs.symlinkSync(source, path.join(assets, ASSET)); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink creation unavailable'); return; } throw error; }
  assert.throws(() => carryVerifiedAsset(source, dir), /collision/);
});


test('assets directory symlink cannot redirect retained bundle outside dist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-carry-parent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist'), outside = path.join(root, 'outside');
  fs.mkdirSync(dist); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(dist, 'assets'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink creation unavailable'); return; } throw error; }
  assert.throws(() => carryVerifiedAsset(source, dist), /escapes dist/);
  assert.equal(fs.existsSync(path.join(outside, ASSET)), false);
});
