'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');
const { makeZip } = require('./helpers/zipFixture');
const { captureProcessingArchive: capture, verifyProcessingArchive: verify } = require('../server/processingArchiveEvidence');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const linux = { skip: process.platform !== 'linux' && 'descriptor extraction requires Linux /proc/self/fd' };
function setup(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-archive-evidence-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, destination: path.join(parent, 'output') };
}
const options = { maxBytes: 1024 * 1024, maxArchiveBytes: 1024 * 1024, maxDiskBytes: 2 * 1024 * 1024, maxEntries: 100 };
const bytes = () => makeZip([{ path: 'b.txt', data: 'second', descriptor: true }, { path: 'nested/a.txt', data: 'first', method: 8 }, { path: 'empty.txt', data: '' }], { comment: 'archive metadata in response tail' });
test('captures entire ZIP response digest and exact sorted byte inventory; verifies retry', linux, async t => {
  const { parent, destination } = setup(t), zip = bytes(); let ended = false;
  const stream = Readable.from((async function* () { yield zip.subarray(0, 50); yield zip.subarray(50); ended = true; })());
  const receipt = await capture(stream, destination, options);
  assert.equal(ended, true); assert.equal(receipt.archiveSha256, hash(zip)); assert.equal(receipt.archiveByteSize, zip.length);
  assert.deepEqual(receipt.archiveFiles, [
    { relativePath: 'b.txt', byteSize: 6, sha256: hash('second') },
    { relativePath: 'empty.txt', byteSize: 0, sha256: hash('') },
    { relativePath: 'nested/a.txt', byteSize: 5, sha256: hash('first') },
  ]);
  assert.equal(receipt.archiveManifestSha256, hash(JSON.stringify(receipt.archiveFiles)));
  assert.deepEqual(fs.readdirSync(parent), ['output']);
  assert.equal(await verify(destination, receipt, options), true);
});
test('same-size source/companion changes and added/missing files fail retry verification', linux, async t => {
  for (const mutation of [destination => fs.writeFileSync(path.join(destination, 'b.txt'), 'CHANGE'), destination => fs.writeFileSync(path.join(destination, 'extra'), 'x'), destination => fs.unlinkSync(path.join(destination, 'nested/a.txt'))]) {
    const { destination } = setup(t), receipt = await capture(Readable.from([bytes()]), destination, options);
    mutation(destination); await assert.rejects(() => verify(destination, receipt, options), error => error.code === 'processing_archive_changed');
  }
});
test('receipt hashes, sorting and original response digest cannot be omitted or invented', linux, async t => {
  const { destination } = setup(t), receipt = await capture(Readable.from([bytes()]), destination, options);
  for (const forged of [{ ...receipt, archiveSha256: null }, { ...receipt, archiveManifestSha256: hash('wrong') }, { ...receipt, archiveFiles: [...receipt.archiveFiles].reverse() }]) {
    await assert.rejects(() => verify(destination, forged, options), error => error.code === 'invalid_archive');
  }
});
test('stream error after complete ZIP bytes does not publish partial evidence or leave temp', linux, async t => {
  const { parent, destination } = setup(t);
  const stream = Readable.from((async function* () { yield bytes(); throw new Error('network failed after final chunk'); })());
  await assert.rejects(() => capture(stream, destination, options), /network failed/);
  assert.deepEqual(fs.readdirSync(parent), []);
});
test('abort during streaming and extraction cleans only private temporary directory', linux, async t => {
  for (const phase of ['stream', 'extract']) {
    const { parent, destination } = setup(t), controller = new AbortController();
    fs.writeFileSync(path.join(parent, 'keep'), 'untouched');
    const stream = phase === 'stream' ? Readable.from((async function* () { yield bytes().subarray(0, 50); controller.abort(); yield Buffer.from('x'); })()) : Readable.from([bytes()]);
    await assert.rejects(() => capture(stream, destination, { ...options, signal: controller.signal, onProgress: () => { if (phase === 'extract') controller.abort(); } }));
    assert.deepEqual(fs.readdirSync(parent), ['keep']);
  }
});
test('spool + expansion share one disk headroom budget', linux, async t => {
  const { parent, destination } = setup(t), zip = bytes();
  await assert.rejects(() => capture(Readable.from([zip]), destination, { ...options, maxDiskBytes: zip.length + 10 }), /expansion limit/);
  assert.deepEqual(fs.readdirSync(parent), []);
  const receipt = await capture(Readable.from([zip]), destination, { ...options, maxDiskBytes: zip.length + 11 });
  assert.equal(receipt.archiveByteSize, zip.length);
});
test('compressed response cap, expansion cap, entry cap and truncated ZIP clean staging', linux, async t => {
  for (const [zip, bounds] of [[bytes(), { maxArchiveBytes: 10 }], [bytes(), { maxBytes: 2 }], [bytes(), { maxEntries: 1 }], [bytes().subarray(0, 60), {}]]) {
    const { parent, destination } = setup(t);
    await assert.rejects(() => capture(Readable.from([zip]), destination, { ...options, ...bounds }));
    assert.deepEqual(fs.readdirSync(parent), []);
  }
});
test('duplicate case-folded paths, ambiguous ancestor spellings, links, special files and traversal fail', linux, async t => {
  for (const entries of [
    [{ path: 'one', data: 'a' }, { path: 'ONE', data: 'b' }],
    [{ path: 'Root/a', data: 'a' }, { path: 'root/b', data: 'b' }],
    [{ path: 'link', data: 'target', mode: 0o120777 }],
    [{ path: 'special', data: 'x', mode: 0o020666 }],
    [{ path: '../escape', data: 'x' }],
    [{ path: 'one', data: 'x', crc: 1 }],
  ]) {
    const { parent, destination } = setup(t);
    await assert.rejects(() => capture(Readable.from([makeZip(entries)]), destination, options));
    assert.deepEqual(fs.readdirSync(parent), []);
  }
});
test('existing destination preserved and no receipt generated; publication collision also preserved', linux, async t => {
  const { parent, destination } = setup(t);
  fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'keep'), 'old');
  await assert.rejects(() => capture(Readable.from([bytes()]), destination, options));
  assert.equal(fs.readFileSync(path.join(destination, 'keep'), 'utf8'), 'old');
  const target = path.join(parent, 'racing'); let created = false;
  await assert.rejects(() => capture(Readable.from([bytes()]), target, { ...options, onProgress: () => {
    if (!created) { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'new'); created = true; }
  } }));
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(parent).sort(), ['output', 'racing']);
});
test('retry rejects symlinks and cancellation', linux, async t => {
  const { destination } = setup(t), receipt = await capture(Readable.from([bytes()]), destination, options);
  await assert.rejects(() => verify(destination, receipt, { ...options, signal: AbortSignal.abort() }), error => error.code === 'lease_lost');
  fs.unlinkSync(path.join(destination, 'b.txt')); fs.symlinkSync('nested/a.txt', path.join(destination, 'b.txt'));
  await assert.rejects(() => verify(destination, receipt, options));
});
