'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashRecordedFile } = require('../server/scopedFileHash');
const { hashFileChunks } = require('../server/storageManager');
const { RACES, race } = require('./helpers/scoped-file-races');

const MIB = 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const linux = { skip: process.platform === 'win32' };

function fixture(t, size = 9 * MIB + 1) {
  // The path the operating system reports, so opened paths compare exactly.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-scoped-'))), root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'tree'), { recursive: true });
  const file = path.join(root, 'tree', 'model.glb'), bytes = crypto.randomBytes(size);
  fs.writeFileSync(file, bytes);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, file, bytes, outside: path.join(base, 'outside'), relativePath: 'tree/model.glb', recorded: { byteSize: size, sha256: sha(bytes) } };
}
const refused = { code: 'scoped_file_changed' };

for (const size of [4 * MIB, 4 * MIB + 1, 8 * MIB, 9 * MIB + 1]) test(`proven bytes give the same chunks as the writers: ${size} bytes`, async t => {
  const f = fixture(t, size), before = fs.statSync(f.file);
  assert.deepEqual(await hashRecordedFile(f.root, f.relativePath, f.recorded), (await hashFileChunks(f.file)).chunks);
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs);
});

test('a short read is continued, not mistaken for the end of the file', async t => {
  const f = fixture(t), open = fs.promises.open;
  t.after(() => { fs.promises.open = open; });
  fs.promises.open = async (...args) => {
    const handle = await open.apply(fs.promises, args), read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 700001), position);
    return handle;
  };
  const chunks = await hashRecordedFile(f.root, f.relativePath, f.recorded);
  fs.promises.open = open;
  assert.deepEqual(chunks, (await hashFileChunks(f.file)).chunks);
});

test('an approved prefix or a shorter file is not the recorded file', async t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, 'tail');
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, f.recorded), refused, 'the recorded bytes followed by more');
  fs.truncateSync(f.file, f.recorded.byteSize - 1);
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, f.recorded), refused);
});

test('changed content, a missing file, a directory and a missing record are refused', async t => {
  const f = fixture(t);
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, { ...f.recorded, sha256: 'f'.repeat(64) }), refused);
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, { byteSize: f.recorded.byteSize, sha256: null }), refused);
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, { byteSize: null, sha256: f.recorded.sha256 }), refused);
  await assert.rejects(hashRecordedFile(f.root, 'tree/none.glb', f.recorded), refused);
  // Windows cannot open a directory at all, so there it is an ordinary error.
  await assert.rejects(hashRecordedFile(f.root, 'tree', f.recorded), process.platform === 'win32' ? undefined : refused);
});

test('paths that leave the root are refused before anything is opened', async t => {
  const f = fixture(t), open = fs.promises.open;
  fs.writeFileSync(f.outside, f.bytes);
  t.after(() => { fs.promises.open = open; });
  fs.promises.open = () => assert.fail('opened');
  for (const relativePath of ['../outside', 'tree/../../outside', f.outside, f.outside.replaceAll('\\', '/'), 'tree//model.glb', './tree/model.glb', 'tree\\model.glb', '', 'tree/model.glb\0'])
    await assert.rejects(hashRecordedFile(f.root, relativePath, f.recorded), refused, relativePath);
});

test('links inside the root and special files are refused', linux, async t => {
  const f = fixture(t);
  fs.symlinkSync(f.file, path.join(f.root, 'link.glb'));
  fs.symlinkSync(path.join(f.root, 'tree'), path.join(f.root, 'linked'));
  assert.equal(spawnSync('mkfifo', [path.join(f.root, 'pipe.glb')]).status, 0);
  for (const relativePath of ['link.glb', 'linked/model.glb', 'pipe.glb']) await assert.rejects(hashRecordedFile(f.root, relativePath, f.recorded), refused, relativePath);
});

for (const [label, change] of Object.entries(RACES)) test(`refused: ${label}`, linux, async t => {
  const f = fixture(t), state = race(t, change, f.file, f.outside);
  await assert.rejects(hashRecordedFile(f.root, f.relativePath, f.recorded), refused);
  assert.equal(state.fired, 1);
  if (/outside|link/.test(label)) assert.equal(state.bytesRead, 0, 'nothing is read through a refused descriptor');
});

test('cancellation keeps its own code, between chunks and after the last one', async t => {
  const f = fixture(t), open = fs.promises.open;
  t.after(() => { fs.promises.open = open; });
  for (const at of [1, 4]) {
    const stop = new AbortController();
    let reads = 0;
    fs.promises.open = async (...args) => {
      const handle = await open.apply(fs.promises, args), read = handle.read.bind(handle);
      handle.read = async (...rest) => { const result = await read(...rest); reads += 1; if (reads === at) stop.abort(); return result; };
      return handle;
    };
    await assert.rejects(hashRecordedFile(f.root, f.relativePath, { ...f.recorded, signal: stop.signal }), { code: 'lease_lost' });
    assert.equal(reads, at);
  }
});
