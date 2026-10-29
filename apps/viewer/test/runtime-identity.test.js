'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { readRuntimeRevision, readSchemaVersion, runtimeIdentity } = require('../server/runtimeIdentity');

test('runtime identity accepts only an exact regular-file source revision and current schema', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-runtime-identity-'));
  const source = path.join(root, 'source-commit.txt');
  const revision = 'a'.repeat(40);
  fs.writeFileSync(source, `${revision}\n`);
  assert.equal(readRuntimeRevision(source), revision);
  fs.writeFileSync(source, 'latest\n');
  assert.equal(readRuntimeRevision(source), null);

  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(readSchemaVersion(database), 41);
  assert.deepEqual(runtimeIdentity(database), { revision: 'unavailable', schemaVersion: 41 });
});

test('runtime identity rejects a symlinked source stamp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-runtime-identity-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'source-commit.txt');
  fs.writeFileSync(target, `${'b'.repeat(40)}\n`);
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Windows symlink creation is not available in this environment');
      return;
    }
    throw error;
  }
  assert.equal(readRuntimeRevision(link), null);
});
