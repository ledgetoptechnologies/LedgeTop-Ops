import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageUiReleasePacket } from './ui-release-packet.mjs';

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
