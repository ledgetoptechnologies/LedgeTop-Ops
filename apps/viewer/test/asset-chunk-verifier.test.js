'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAssetChunkVerifier } = require('../server/assetChunkVerifier');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(options = {}) {
  const body = Buffer.from('abcdefgh');
  const chunks = [0, 4].map(byteOffset => ({ byteOffset, byteSize: 4, sha256: digest(body.subarray(byteOffset, byteOffset + 4)) }));
  const counts = { open: 0, close: 0, read: 0, bytes: 0 };
  const state = { mtimeNs: 1n, ctimeNs: 1n, ino: 2n, size: 8n, fail: false, short: false };
  const filesystem = { async open(filePath, mode) {
    assert.equal(mode, 'r'); counts.open++;
    let closed = false;
    return {
      async stat(options) { assert.equal(closed, false); assert.deepEqual(options, { bigint: true });
        return { dev: 1n, ino: state.ino, size: state.size, mtimeNs: state.mtimeNs, ctimeNs: state.ctimeNs, isFile: () => true }; },
      async read(buffer, offset, length, position) {
        assert.equal(closed, false); counts.read++; counts.bytes += length;
        await options.barrier?.promise;
        if (state.fail) throw new Error('read failed');
        body.copy(buffer, offset, position, position + length);
        return { bytesRead: state.short ? length - 1 : length };
      },
      async close() { assert.equal(closed, false); closed = true; counts.close++; },
    };
  } };
  return { verify: createAssetChunkVerifier({ filesystem, maxInFlight: options.maxInFlight || 32 }), chunks, counts, state, body };
}

test('concurrent ranges share one active chunk hash; later requests verify again', async () => {
  const barrier = deferred(), f = fixture({ barrier });
  const pending = Array.from({ length: 8 }, () => f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8));
  await tick();
  assert.equal(f.counts.read, 1);
  assert.equal(f.counts.bytes, 4);
  barrier.resolve();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(true));
  assert.equal(f.counts.close, 8);
  assert.equal(await f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8), true);
  assert.equal(f.counts.read, 2, 'completed successes must not be cached');
  assert.equal(f.counts.close, 9);
});

test('different paths, chunks or expected hashes never share a verification', async () => {
  const barrier = deferred(), f = fixture({ barrier });
  const wrong = f.chunks.map(chunk => ({ ...chunk, sha256: '0'.repeat(64) }));
  const results = [f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8),
    f.verify('/other', f.chunks, { start: 0, end: 1 }, 8),
    f.verify('/ortho', f.chunks, { start: 4, end: 5 }, 8),
    f.verify('/ortho', wrong, { start: 0, end: 1 }, 8)];
  await tick(); assert.equal(f.counts.read, 4); barrier.resolve();
  assert.deepEqual(await Promise.all(results), [true, true, true, false]);
  assert.equal(f.counts.close, 4);
});

test('different descriptor identity does not reuse an in-flight proof', async () => {
  const barrier = deferred(), f = fixture({ barrier });
  const first = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  await tick(); f.state.ino = 3n;
  const replacement = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  await tick(); assert.equal(f.counts.read, 2); barrier.resolve();
  assert.deepEqual(await Promise.all([first, replacement]), [false, true]);
  assert.equal(f.counts.close, 2);
});

test('all callers reject a source change during a shared hash, including restored mtime', async () => {
  const barrier = deferred(), f = fixture({ barrier });
  const a = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  const b = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  await tick(); f.state.ctimeNs++; barrier.resolve();
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(f.counts.close, 2);
});

test('read errors retire shared work and close every caller descriptor before retry', async () => {
  const barrier = deferred(), f = fixture({ barrier }); f.state.fail = true;
  const a = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  const b = f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8);
  const rejected = [assert.rejects(a, /read failed/), assert.rejects(b, /read failed/)];
  await tick(); barrier.resolve(); await Promise.all(rejected);
  assert.equal(f.counts.read, 1); assert.equal(f.counts.close, 2);
  f.state.fail = false;
  assert.equal(await f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8), true);
  assert.equal(f.counts.read, 2); assert.equal(f.counts.close, 3);
});

test('saturated bookkeeping falls back to independent hashing without accepting unchecked data', async () => {
  const barrier = deferred(), f = fixture({ barrier, maxInFlight: 1 });
  const results = [f.verify('/a', f.chunks, { start: 0, end: 1 }, 8),
    f.verify('/b', f.chunks, { start: 0, end: 1 }, 8),
    f.verify('/b', f.chunks, { start: 0, end: 1 }, 8)];
  await tick(); assert.equal(f.counts.read, 3); barrier.resolve();
  assert.deepEqual(await Promise.all(results), [true, true, true]);
  assert.equal(f.counts.close, 3);
});

test('full-file and crossing-range verification check every selected chunk', async () => {
  const f = fixture();
  assert.equal(await f.verify('/ortho', f.chunks, null, 8), true);
  assert.equal(f.counts.read, 2);
  assert.equal(await f.verify('/ortho', f.chunks, { start: 3, end: 4 }, 8), true);
  assert.equal(f.counts.read, 4);
  f.body[7] = 0;
  assert.equal(await f.verify('/ortho', f.chunks, { start: 3, end: 4 }, 8), false);
  assert.equal(f.counts.close, 3);
});

test('invalid metadata, changed size, short reads and missing range coverage fail closed', async () => {
  const f = fixture();
  assert.equal(await f.verify('/ortho', f.chunks.slice(1), null, 8), false);
  assert.equal(await f.verify('/ortho', f.chunks, { start: 9, end: 10 }, 8), false);
  assert.equal(await f.verify('/ortho', [{ ...f.chunks[0], byteSize: -1 }], null, 8), false);
  assert.equal(f.counts.open, 0);
  f.state.size = 9n;
  assert.equal(await f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8), false);
  assert.equal(f.counts.read, 0); assert.equal(f.counts.close, 1);
  f.state.size = 8n; f.state.short = true;
  assert.equal(await f.verify('/ortho', f.chunks, { start: 0, end: 1 }, 8), false);
  assert.equal(f.counts.close, 2);
});

test('real filesystem descriptors verify range bytes and detect subsequent same-size content changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-chunk-proof-'));
  const file = path.join(directory, 'fixture.bin');
  fs.writeFileSync(file, 'abcdefgh');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(directory); });
  const chunks = [{ byteOffset: 0, byteSize: 4, sha256: digest(Buffer.from('abcd')) },
    { byteOffset: 4, byteSize: 4, sha256: digest(Buffer.from('efgh')) }];
  const verify = createAssetChunkVerifier();
  assert.equal(await verify(file, chunks, { start: 0, end: 1 }, 8), true);
  assert.equal(await verify(file, chunks, null, 8), true);
  fs.writeFileSync(file, 'abXdefgh');
  assert.equal(await verify(file, chunks, { start: 0, end: 1 }, 8), false);
  assert.equal(await verify(file, chunks, { start: 6, end: 7 }, 8), true);
});
