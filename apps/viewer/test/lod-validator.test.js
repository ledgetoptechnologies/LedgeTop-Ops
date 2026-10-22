'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const validator = path.join(__dirname, '..', 'scripts', 'validate-lod.mjs');
const auditor = path.join(__dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');

function run(directory, mesh) {
  return spawnSync(process.execPath, [validator, directory, mesh], { encoding: 'utf8' });
}

test('offline validator accepts generated evidence and rejects a changed certified leaf', async (t) => {
  const { writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-validator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mesh = writeAuditableFixture(directory);
  const audit = spawnSync(process.execPath, [auditor, directory, mesh], { encoding: 'utf8' });
  assert.equal(audit.status, 0, audit.stderr);

  let result = run(directory, mesh);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, true);

  fs.appendFileSync(path.join(directory, 'leaf-a.b3dm'), 'stale');
  result = run(directory, mesh);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /audit artifact size changed/);
});

test('offline validator rejects a hand-authored legacy preservation assertion', async (t) => {
  const { writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-validator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mesh = writeAuditableFixture(directory);
  fs.writeFileSync(path.join(directory, 'lod-provenance.json'), JSON.stringify({
    schemaVersion: 1,
    sourceAsset: 'model.glb',
    sourceSha256: 'a'.repeat(64),
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
  }));
  const result = run(directory, mesh);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /exact v2 or controlled Obj2Tiles v3\/v4 audit evidence/);
});
