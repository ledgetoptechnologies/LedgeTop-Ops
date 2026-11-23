'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { AssetIntegrityCache, RACY_WINDOW_MS, MAX_CONCURRENT_STREAMS } = require('../server/assetIntegrityCache');

const CHUNK = 4 * 1024 * 1024;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stat = (file) => fs.statSync(file, { bigint: true });
// Pretends the read starts well after the file was last written, so a result
// is eligible to be remembered. Only for tests that never rewrite the file.
const aged = () => Date.now() + 60_000;
const FS = { zfs: 0x2fc12fc1, ext4: 0xef53, xfs: 0x58465342, btrfs: 0x9123683e, overlay: 0x794c7630, tmpfs: 0x01021994, ntfs: 0x5346544e, nfs: 0x6969, cifs: 0xff534d42, smb2: 0xfe534d42, fuse: 0x65735546 };
// Pretends the fixture lives on a local POSIX filesystem (the deployed case).
const localPosix = { platform: 'linux', statfs: async () => ({ type: FS.zfs }) };

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function countingCache(options = {}) {
  const cache = new AssetIntegrityCache({ ...localPosix, ...options });
  const hashRegion = cache.hashRegion.bind(cache);
  cache.verifications = 0;
  cache.hashRegion = (...args) => { cache.verifications += 1; return hashRegion(...args); };
  return cache;
}

// Wraps every opened handle so a test can act right after a read completes.
function hookedOpen(afterRead) {
  return async (filePath) => {
    const handle = await fs.promises.open(filePath, 'r');
    const read = handle.read.bind(handle);
    let reads = 0;
    handle.read = async (...args) => { const result = await read(...args); reads += 1; await afterRead(filePath, reads); return result; };
    return handle;
  };
}

test('a verified region is hashed once per file identity and concurrent requests share one hash', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const body = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(file, body);
  const cache = countingCache({ wallNow: aged });
  const results = await Promise.all(Array.from({ length: 6 }, () => cache.verifyWholeFile(file, stat(file), sha256(body))));
  assert.deepEqual(results, [true, true, true, true, true, true]);
  assert.equal(cache.verifications, 1);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), true);
  assert.equal(cache.verifications, 1, 'repeat request is served from the remembered verification');
});

test('failures are never remembered and the wrong digest never passes', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile bytes');
  const cache = countingCache({ wallNow: aged });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('other bytes')), false);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('other bytes')), false);
  assert.equal(cache.verifications, 2);
  assert.equal(cache.verified.size, 0);
});

test('back-to-back same-size rewrites inside one timestamp tick always fail closed', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const good = crypto.randomBytes(4096);
  const tampered = Buffer.from(good); tampered[7] ^= 0xff;
  const cache = countingCache();
  const chunk = { byteOffset: 0, byteSize: good.length, sha256: sha256(good) };
  for (let i = 0; i < 300; i += 1) {
    fs.writeFileSync(file, good);
    assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), true);
    assert.equal(await cache.verifyChunk(file, stat(file), chunk), true);
    fs.writeFileSync(file, tampered);
    assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), false, `whole-file rewrite ${i}`);
    assert.equal(await cache.verifyChunk(file, stat(file), chunk), false, `chunk rewrite ${i}`);
  }
  assert.equal(cache.verified.size, 0, 'a file written within the racy window is never remembered');
  assert.ok(cache.stats.racy >= 600);
});

test('a result is remembered only once the read starts more than the racy window after the newest timestamp', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile');
  const s = stat(file);
  const newest = Number((s.mtimeNs > s.ctimeNs ? s.mtimeNs : s.ctimeNs) / 1_000_000n);
  let wall = newest + RACY_WINDOW_MS;
  const cache = countingCache({ wallNow: () => wall });
  assert.equal(await cache.verifyWholeFile(file, s, sha256('tile')), true);
  assert.equal(cache.verified.size, 0, 'exactly at the window edge is still racy');
  wall = newest + RACY_WINDOW_MS + 1;
  assert.equal(await cache.verifyWholeFile(file, s, sha256('tile')), true);
  assert.equal(cache.verified.size, 1);
});

test('after the racy window a rewrite changes the identity, misses the cache and fails closed', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'ortho.tif');
  const good = crypto.randomBytes(32 * 1024);
  fs.writeFileSync(file, good);
  await new Promise((resolve) => setTimeout(resolve, RACY_WINDOW_MS + 150));
  const cache = countingCache();
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), true);
  assert.equal(cache.verified.size, 1, 'the settled file is remembered with the real clock');
  const original = fs.statSync(file);
  const tampered = Buffer.from(good); tampered[100] ^= 0xff;
  fs.writeFileSync(file, tampered);
  fs.utimesSync(file, original.atime, original.mtime);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), false, 'in-place same-size rewrite with restored mtime');
  assert.equal(cache.verifications, 2);
});

test('rename-over replacements and a stat taken before a swap fail closed', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const good = Buffer.from('good tile bytes'), bad = Buffer.from('bad! tile bytes');
  fs.writeFileSync(file, good);
  const cache = countingCache({ wallNow: aged });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), true);
  const replacement = path.join(root, 'replacement.b3dm');
  fs.writeFileSync(replacement, bad);
  fs.renameSync(replacement, file);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), false, 'rename-over replacement');

  const before = stat(file);
  fs.writeFileSync(replacement, good);
  fs.renameSync(replacement, file);
  const fresh = countingCache({ wallNow: aged });
  assert.equal(await fresh.verifyWholeFile(file, before, sha256(good)), false, 'good bytes cannot be recorded under the old identity');
  assert.equal(fresh.verified.size, 0);
});

test('an identity change while the bytes are read fails closed and is not remembered', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const body = crypto.randomBytes(8192);
  fs.writeFileSync(file, body);
  let changed = false;
  const openFile = hookedOpen(async (filePath) => { if (!changed) { changed = true; fs.appendFileSync(filePath, 'x'); } });
  const cache = countingCache({ wallNow: aged, openFile });
  assert.equal(await cache.verifyChunk(file, stat(file), { byteOffset: 0, byteSize: body.length, sha256: sha256(body) }), false);
  assert.equal(cache.verified.size, 0);
});

test('large whole files without chunk records keep main-equivalent behaviour: full hash every time, nothing cached or shared', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'dsm.tif');
  const body = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(file, body);
  const cache = countingCache({ wallNow: aged, bufferedHashMaxBytes: 1024 });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), true);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), true);
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => cache.verifyWholeFile(file, stat(file), sha256(body)))), [true, true, true]);
  assert.equal(cache.verifications, 5, 'every request hashes the whole file itself');
  assert.equal(cache.stats.legacy, 5);
  assert.equal(cache.stats.hits, 0);
  assert.equal(cache.verified.size + cache.pending.size + cache.bytes.size, 0, 'nothing remembered, shared or kept');
  assert.equal(cache.stats.streamed, 5);
  assert.equal(cache.stats.peakBufferedBytes, 0, 'streaming never allocates the whole file');
  const tampered = Buffer.from(body); tampered[12345] ^= 0xff;
  fs.writeFileSync(file, tampered);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), false, 'any change is caught on the next request, same tick or not');

  let appended = false;
  const changing = countingCache({ wallNow: aged, bufferedHashMaxBytes: 1024, openFile: hookedOpen(async (filePath, reads) => { if (reads === 2 && !appended) { appended = true; fs.appendFileSync(filePath, 'x'); } }) });
  const current = stat(file);
  assert.equal(await changing.verifyWholeFile(file, current, sha256(body)), false);
  assert.equal(changing.verified.size, 0);
});

test('buffered hashing stays within the per-file limit and the global in-flight budget', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const files = Array.from({ length: 12 }, (_, i) => {
    const file = path.join(root, `photo-${i}.jpg`), body = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(file, body);
    return { file, sha: sha256(body) };
  });
  const cache = countingCache({ wallNow: aged, bufferedHashMaxBytes: 64 * 1024 + 1, bufferedBudgetBytes: 160 * 1024 });
  const results = await Promise.all(files.map(({ file, sha }) => cache.verifyWholeFile(file, stat(file), sha)));
  assert.ok(results.every(Boolean));
  assert.ok(cache.stats.peakBufferedBytes <= 160 * 1024, `peak ${cache.stats.peakBufferedBytes}`);
  assert.ok(cache.stats.peakBufferedBytes > 0, 'small files are buffered while the budget allows');
  assert.ok(cache.stats.streamed > 0, 'over-budget checks fall back to fixed-buffer streaming');
  assert.equal(cache.bufferedBytes, 0, 'reservations are released');
  const big = path.join(root, 'big.tif'), bigBody = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(big, bigBody);
  const before = cache.stats.streamed;
  assert.equal(await cache.verifyWholeFile(big, stat(big), sha256(bigBody)), true);
  assert.equal(cache.stats.streamed, before + 1, 'files over the per-file limit always stream');
});

test('remembered verifications expire on the monotonic clock and are bounded in number', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  let now = 1_000;
  const cache = countingCache({ ttlMs: 50, maxEntries: 2, now: () => now, wallNow: aged });
  const files = ['a', 'b', 'c'].map((name) => { const file = path.join(root, name); fs.writeFileSync(file, name); return file; });
  assert.equal(await cache.verifyWholeFile(files[0], stat(files[0]), sha256('a')), true);
  now += 49;
  assert.equal(await cache.verifyWholeFile(files[0], stat(files[0]), sha256('a')), true);
  assert.equal(cache.verifications, 1);
  now += 1;
  assert.equal(await cache.verifyWholeFile(files[0], stat(files[0]), sha256('a')), true);
  assert.equal(cache.verifications, 2, 'expired entry is re-hashed');
  await cache.verifyWholeFile(files[1], stat(files[1]), sha256('b'));
  await cache.verifyWholeFile(files[2], stat(files[2]), sha256('c'));
  assert.equal(cache.verified.size, 2);

  const real = new AssetIntegrityCache({ ...localPosix, wallNow: aged });
  assert.equal(await real.verifyWholeFile(files[0], stat(files[0]), sha256('a')), true);
  const dateNow = Date.now;
  Date.now = () => dateNow() + 365 * 86_400_000;
  try {
    const [until] = real.verified.values();
    assert.ok(until < dateNow() + 365 * 86_400_000 / 2, 'TTL is not on the wall clock');
    assert.equal(await real.verifyWholeFile(files[0], stat(files[0]), sha256('a')), true);
    assert.equal(real.stats.hits, 1, 'a wall-clock jump neither expires nor extends entries');
  } finally { Date.now = dateNow; }
});

test('clear() during an in-flight verification neither drops the newer check nor stores the stale result', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let opens = 0;
  const cache = countingCache({ wallNow: aged, openFile: async (filePath) => { opens += 1; if (opens === 1) await gate; return fs.promises.open(filePath, 'r'); } });
  const s = stat(file);
  const first = cache.verifyWholeFile(file, s, sha256('tile'));
  while (opens === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.pending.size, 1, 'the first check is in flight');
  cache.clear();
  const second = cache.verifyWholeFile(file, s, sha256('tile'));
  while (cache.pending.size === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.pending.size, 1, 'the newer check has its own in-flight entry');
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(cache.verifications, 2, 'the cleared check did not satisfy the newer request');
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.verified.size, 1, 'only the post-clear verification is remembered');
});

test('results are remembered only on allowlisted local POSIX filesystems', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile');
  const cases = [
    ...['zfs', 'ext4', 'xfs', 'btrfs', 'overlay', 'tmpfs'].map((name) => [name, 'linux', FS[name], true]),
    ...['ntfs', 'nfs', 'cifs', 'smb2', 'fuse'].map((name) => [name, 'linux', FS[name], false]),
    ['zfs reported on Windows', 'win32', FS.zfs, false],
  ];
  for (const [name, platform, type, cacheable] of cases) {
    let statfsCalls = 0;
    const cache = countingCache({ wallNow: aged, platform, statfs: async () => { statfsCalls += 1; return { type }; } });
    const results = await Promise.all(Array.from({ length: 4 }, () => cache.verifyWholeFile(file, stat(file), sha256('tile'))));
    assert.deepEqual(results, [true, true, true, true], name);
    assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true, name);
    assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('bad')), false, name);
    if (cacheable) {
      assert.equal(cache.verifications, 2, `${name}: one shared hash, then a hit; the wrong digest is hashed`);
      assert.equal(statfsCalls, 1, `${name}: statfs is asked once per device`);
    } else {
      assert.equal(cache.verifications, 6, `${name}: every request hashes its own bytes, nothing shared`);
      assert.equal(cache.verified.size + cache.pending.size, 0, name);
      assert.equal(cache.stats.uncached, 6, name);
      if (platform === 'win32') assert.equal(statfsCalls, 0);
    }
  }
});

test('a failing statfs keeps the cache off and is asked again later', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile');
  let calls = 0, fail = true;
  const cache = countingCache({ wallNow: aged, statfs: async () => { calls += 1; if (fail) throw new Error('EIO'); return { type: FS.ext4 }; } });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true);
  assert.equal(cache.verifications, 2);
  assert.equal(calls, 2);
  fail = false;
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true);
  assert.equal(cache.verifications, 3, 'remembered once statfs succeeds on an allowlisted filesystem');
});

test('the real default never enables the cache on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  fs.writeFileSync(file, 'tile');
  const cache = new AssetIntegrityCache({ wallNow: aged });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('tile')), true);
  assert.equal(cache.verified.size, 0);
  assert.equal(cache.stats.uncached, 1);
});

test('streamed checks are limited to a fixed number at once', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const files = Array.from({ length: 24 }, (_, i) => {
    const file = path.join(root, `dsm-${i}.tif`), body = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(file, body);
    return { file, sha: sha256(body) };
  });
  const slow = hookedOpen(() => new Promise((resolve) => setTimeout(resolve, 2)));
  const cache = countingCache({ wallNow: aged, bufferedHashMaxBytes: 0, openFile: slow });
  const results = await Promise.all(files.map(({ file, sha }) => cache.verifyWholeFile(file, stat(file), sha)));
  assert.ok(results.every(Boolean));
  assert.equal(cache.stats.streamed, 24);
  assert.equal(MAX_CONCURRENT_STREAMS, 8);
  assert.ok(cache.stats.peakStreams <= MAX_CONCURRENT_STREAMS, `peak ${cache.stats.peakStreams}`);
  assert.ok(cache.stats.peakStreams >= 2, 'streams do run in parallel up to the limit');
  assert.equal(cache.activeStreams, 0, 'every slot is released');
  assert.equal(cache.streamWaiters.length, 0);
  const tiny = countingCache({ wallNow: aged, bufferedHashMaxBytes: 0, maxConcurrentStreams: 1, openFile: slow });
  await Promise.all(files.slice(0, 6).map(({ file, sha }) => tiny.verifyWholeFile(file, stat(file), sha)));
  assert.equal(tiny.stats.peakStreams, 1);
  const failing = countingCache({ wallNow: aged, bufferedHashMaxBytes: 0, maxConcurrentStreams: 2 });
  await Promise.all(files.slice(0, 6).map(({ file }) => failing.verifyWholeFile(file, stat(file), sha256('wrong'))));
  assert.equal(failing.activeStreams, 0, 'slots are released on failure too');
});

test('session asset ranges and tiles stay byte-exact, verify once, fail closed after tampering and on chunk-table gaps', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-integrity-http-'));
  const modelsMount = path.join(root, 'models');
  fs.mkdirSync(modelsMount, { recursive: true });
  const previous = { modelsMount: config.modelsMount, xAccelRedirectPrefix: config.xAccelRedirectPrefix };
  config.modelsMount = modelsMount;
  config.xAccelRedirectPrefix = '';
  const write = (rel, body) => { const file = path.join(modelsMount, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };

  const ortho = crypto.randomBytes(CHUNK + 512 * 1024);
  const orthoFile = write('task/ortho.tif', ortho);
  const chunks = [0, CHUNK].map((offset, index) => {
    const slice = ortho.subarray(offset, Math.min(ortho.length, offset + CHUNK));
    return { chunkIndex: index, byteOffset: offset, byteSize: slice.length, sha256: sha256(slice) };
  });
  // A raster whose chunk table is missing its middle MiB.
  const dsm = crypto.randomBytes(3 * 1024 * 1024);
  write('task/dsm.tif', dsm);
  const MiB = 1024 * 1024;
  const dsmChunks = [0, 2 * MiB].map((offset, index) => ({ chunkIndex: index, byteOffset: offset, byteSize: MiB, sha256: sha256(dsm.subarray(offset, offset + MiB)) }));
  const tileset = Buffer.from('{"asset":{"version":"1.1"},"root":{}}');
  const tile = crypto.randomBytes(96 * 1024);
  write('task/tiles/tileset.json', tileset);
  const tileFile = write('task/tiles/0/0/tile.b3dm', tile);
  const manifest = [
    { relativePath: 'tileset.json', byteSize: tileset.length, sha256: sha256(tileset) },
    { relativePath: '0/0/tile.b3dm', byteSize: tile.length, sha256: sha256(tile) },
  ];

  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID(), versionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  repository.upsertModelVersion({
    modelId, versionId, provider: 'ltds-processing', providerModelId: 'integrity', providerVersionId: sha256('integrity'),
    displayName: 'Integrity model', status: 'ready', sourceLocator: {}, versionMetadata: {},
    assets: [
      { kind: 'ortho', rootKey: 'models', relativePath: 'task/ortho.tif', format: 'tif', byteSize: ortho.length, sha256: sha256(ortho), chunks, storageMode: 'managed', published: true },
      { kind: 'dsm', rootKey: 'models', relativePath: 'task/dsm.tif', format: 'tif', byteSize: dsm.length, sha256: sha256(dsm), chunks: dsmChunks, storageMode: 'managed', published: true },
      { kind: 'tiles', rootKey: 'models', relativePath: 'task/tiles/tileset.json', format: '3dtiles', byteSize: tileset.length, sha256: sha256(tileset), manifestSha256: sha256(JSON.stringify(manifest)), manifestFiles: manifest, storageMode: 'managed', published: true },
    ],
    makeActive: true,
  });
  repository.createViewerSession({
    tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'ops:test', audience: 'ops',
    permissions: { view: true, cameras: true }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assets.setRepository(repository);
  const integrity = assets.assetIntegrityCache, realWallNow = integrity.wallNow;
  integrity.clear();
  // Treat the fixture as settled so the caching path is exercised; the real
  // clock is restored before any rewrite below.
  integrity.wallNow = () => Date.now() + 60_000;
  const realPlatform = integrity.platform, realStatfs = integrity.statfs;
  Object.assign(integrity, localPosix);
  integrity.filesystems.clear();
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assets.setRepository(null);
    integrity.wallNow = realWallNow;
    Object.assign(integrity, { platform: realPlatform, statfs: realStatfs });
    integrity.filesystems.clear();
    integrity.clear();
    Object.assign(config, previous);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/session-assets/${token}/${modelId}/models/task`;
  const get = async (rel, range) => {
    const response = await fetch(`${base}/${rel}`, range ? { headers: { range } } : {});
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()), cacheControl: response.headers.get('cache-control') };
  };

  const missesBefore = integrity.stats.misses;
  const ranges = [[0, 262143], [262144, 524287], [CHUNK - 1000, CHUNK + 1000], [CHUNK + 1024, ortho.length - 1]];
  for (const [start, end] of ranges) {
    const response = await get('ortho.tif', `bytes=${start}-${end}`);
    assert.equal(response.status, 206);
    assert.deepEqual(response.body, ortho.subarray(start, end + 1));
    assert.match(response.cacheControl, /^private, max-age=(5\d|60), must-revalidate$/, 'kept by the browser no longer than the 60 s session');
  }
  assert.equal(integrity.stats.misses - missesBefore, 2, 'each 4 MiB chunk is hashed once for many block requests');
  for (let i = 0; i < 2; i += 1) {
    const response = await get('tiles/0/0/tile.b3dm');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, tile);
  }
  assert.equal(integrity.stats.misses - missesBefore, 3, 'repeat tile requests reuse the verification');

  const gapped = await get('dsm.tif', `bytes=${MiB - 100}-${MiB + 100}`);
  assert.equal(gapped.status, 404, 'a range reaching bytes with no registered chunk fails closed');
  assert.equal((await get('dsm.tif', `bytes=${MiB + 10}-${MiB + 20}`)).status, 404);
  const covered = await get('dsm.tif', `bytes=${2 * MiB}-${2 * MiB + 99}`);
  assert.equal(covered.status, 206);
  assert.deepEqual(covered.body, dsm.subarray(2 * MiB, 2 * MiB + 100));

  // Rewrites below use the real clock: freshly written files are never remembered.
  integrity.clear();
  integrity.wallNow = realWallNow;
  const tamperedTile = Buffer.from(tile); tamperedTile[10] ^= 0xff;
  fs.writeFileSync(tileFile, tamperedTile);
  assert.equal((await get('tiles/0/0/tile.b3dm')).status, 404);
  const tamperedOrtho = Buffer.from(ortho.subarray(0, CHUNK)); tamperedOrtho[5] ^= 0xff;
  const handle = fs.openSync(orthoFile, 'r+');
  try { fs.writeSync(handle, tamperedOrtho, 0, tamperedOrtho.length, 0); } finally { fs.closeSync(handle); }
  assert.equal((await get('ortho.tif', 'bytes=0-262143')).status, 404, 'tampered chunk fails closed');
  const missesAfterTamper = integrity.stats.misses;
  const intact = await get('ortho.tif', `bytes=${CHUNK + 1024}-${CHUNK + 2047}`);
  assert.equal(intact.status, 206, 'an untouched chunk still serves, exactly as before');
  assert.deepEqual(intact.body, ortho.subarray(CHUNK + 1024, CHUNK + 2048));
  assert.equal(integrity.stats.misses - missesAfterTamper, 1, 'the untouched chunk was hashed again, not served from memory');
  assert.equal((await get('ortho.tif')).status, 404, 'a full response still requires every chunk');
});
