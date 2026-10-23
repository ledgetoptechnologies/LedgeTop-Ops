import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RELEASE_ID, RELEASE_MANIFEST_PINS, stageUiReleasePacket } from './ui-release-packet.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-ui-packet-policy-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('viewer-ui-packet-policy-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'proof'); fs.mkdirSync(source);
  return { root, source };
}
test('packet rejects direct and case-alias writes inside proof before manifest reads', t => {
  const { source } = fixture(t);
  assert.throws(() => stageUiReleasePacket(source, path.join(source, 'output')), /outside proof inputs/);
  if (process.platform === 'win32') {
    assert.throws(() => stageUiReleasePacket(source, path.join(source.toUpperCase(), 'output')), /outside proof inputs/);
  }
  assert.deepEqual(fs.readdirSync(source), []);
});
test('packet resolves a parent link before checking proof containment', t => {
  const { root, source } = fixture(t), alias = path.join(root, 'alias');
  try { fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creating filesystem links is unavailable'); throw error; }
  assert.throws(() => stageUiReleasePacket(source, path.join(alias, 'output')), /outside proof inputs/);
  assert.deepEqual(fs.readdirSync(source), []);
});
test('packet never overwrites an existing sibling directory', t => {
  const { root, source } = fixture(t), output = path.join(root, 'existing');
  fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'sentinel'), 'retained');
  assert.throws(() => stageUiReleasePacket(source, output), /new directory/);
  assert.equal(fs.readFileSync(path.join(output, 'sentinel'), 'utf8'), 'retained');
});
test('packet refuses a release without reviewed manifest pins before any read or write', t => {
  const { root, source } = fixture(t), output = path.join(root, 'output');
  for (const releaseId of ['0'.repeat(40), 'constructor', '__proto__', ''])
    assert.throws(() => stageUiReleasePacket(source, output, releaseId), /Unpinned release/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(source), []);
});
test('the original release keeps its exact pins and stays the default', () => {
  assert.equal(DEFAULT_RELEASE_ID, 'cfcf5cf992084f7b3658763cdf362fbc37101665');
  assert.deepEqual(RELEASE_MANIFEST_PINS[DEFAULT_RELEASE_ID], {
    client: 'ffcfa84f31e7855b05895338c6f53ad4d3bc963ad115c3c1290912c7b438a4b9',
    operations: '621ddeead1c3edb4d3218b8919269f843e5a22b74b2eea42271f2b93ae7292c4',
  });
  for (const pins of Object.values(RELEASE_MANIFEST_PINS)) assert.ok(Object.isFrozen(pins));
});
