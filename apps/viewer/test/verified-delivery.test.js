'use strict';

// Invented, isolated fixtures only: random bytes in a temporary directory.

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
const { AssetIntegrityCache } = require('../server/assetIntegrityCache');
const { deliverVerified, openForDelivery, hooks } = require('../server/verifiedDelivery');

const MiB = 1024 * 1024;
const CHUNK = 4 * MiB;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const localPosix = { platform: 'linux', statfs: async () => ({ type: 0x2fc12fc1 }) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(app) {
  return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}
function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}
function chunksOf(body) {
  const chunks = [];
  for (let offset = 0, index = 0; offset < body.length; offset += CHUNK, index += 1) {
    const slice = body.subarray(offset, Math.min(body.length, offset + CHUNK));
    chunks.push({ chunkIndex: index, byteOffset: offset, byteSize: slice.length, sha256: sha256(slice) });
  }
  return chunks;
}

test('verified delivery reproduces res.sendFile statuses, headers and bodies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-parity-'));
  const files = { 'tile.b3dm': crypto.randomBytes(200_000), 'ortho.tif': crypto.randomBytes(300_000), 'tileset.json': Buffer.from('{"asset":{"version":"1.1"}}'), 'empty.laz': Buffer.alloc(0),
    'submilli-low.b3dm': crypto.randomBytes(1000), 'submilli-high.b3dm': crypto.randomBytes(1000), 'submilli-second.b3dm': crypto.randomBytes(1000) };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  // Sub-millisecond mtimes: fs.Stats rounds to the nearest millisecond for its
  // Date; ETag and Last-Modified must follow exactly (…0.6 ms rounds up; …999.6
  // ms rounds into the next second).
  fs.utimesSync(path.join(root, 'submilli-low.b3dm'), 1_700_000_000.0004, 1_700_000_000.0004);
  fs.utimesSync(path.join(root, 'submilli-high.b3dm'), 1_700_000_000.0006, 1_700_000_000.0006);
  fs.utimesSync(path.join(root, 'submilli-second.b3dm'), 1_700_000_000.9996, 1_700_000_000.9996);
  const app = express();
  const onError = (res) => (err) => { if (err && !res.headersSent) res.status(err.status || 404).json({ error: 'asset not found' }); };
  app.get('/send/:mode/:name', (req, res) => {
    if (req.params.mode === 'nostore') res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.join(root, req.params.name), onError(res));
  });
  app.get('/verified/:mode/:name', async (req, res) => {
    const file = path.join(root, req.params.name);
    const opened = await openForDelivery(file);
    await deliverVerified(req, res, { ...opened, filePath: file, verify: async () => true, onFailure: () => res.sendStatus(404), onError: onError(res),
      headers: req.params.mode === 'nostore' ? { 'Cache-Control': 'private, no-store' } : {} });
  });
  const server = await listen(app);
  t.after(async () => { await close(server); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const etagOf = async (name) => (await fetch(`${origin}/send/plain/${name}`)).headers.get('etag');
  const tileEtag = await etagOf('tile.b3dm');
  const cases = [
    ['GET', 'tile.b3dm', {}], ['HEAD', 'tile.b3dm', {}], ['GET', 'tileset.json', {}], ['GET', 'empty.laz', {}],
    ['GET', 'ortho.tif', { range: 'bytes=0-1023' }], ['GET', 'ortho.tif', { range: 'bytes=1000-' }], ['GET', 'ortho.tif', { range: 'bytes=-500' }],
    ['GET', 'ortho.tif', { range: 'bytes=0-9,100-199' }], ['GET', 'ortho.tif', { range: 'bytes=0-9,5-20' }], ['GET', 'ortho.tif', { range: 'bytes=999999-' }],
    ['GET', 'ortho.tif', { range: 'items=0-5' }], ['GET', 'ortho.tif', { range: 'bytes=abc' }], ['HEAD', 'ortho.tif', { range: 'bytes=10-20' }],
    ['GET', 'tile.b3dm', { 'if-none-match': tileEtag }], ['GET', 'tile.b3dm', { 'if-none-match': tileEtag, 'cache-control': 'no-cache' }],
    ['GET', 'tile.b3dm', { 'if-match': '"nope"' }], ['GET', 'tile.b3dm', { 'if-match': tileEtag }],
    ['GET', 'tile.b3dm', { 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() }],
    ['GET', 'tile.b3dm', { 'if-unmodified-since': new Date(0).toUTCString() }],
    ['GET', 'tile.b3dm', { range: 'bytes=0-99', 'if-range': '"stale"' }], ['GET', 'tile.b3dm', { range: 'bytes=0-99', 'if-range': tileEtag }],
    ['GET', 'empty.laz', { range: 'bytes=0-10' }],
    ['GET', 'submilli-low.b3dm', {}], ['GET', 'submilli-high.b3dm', {}], ['GET', 'submilli-second.b3dm', {}], ['HEAD', 'submilli-second.b3dm', {}],
    ['GET', 'submilli-high.b3dm', { 'if-modified-since': 'Tue, 14 Nov 2023 22:13:20 GMT' }],
    ['GET', 'submilli-second.b3dm', { 'if-modified-since': 'Tue, 14 Nov 2023 22:13:20 GMT' }],
  ];
  const ignored = new Set(['date', 'connection', 'keep-alive', 'x-powered-by']);
  const highEtag = (await fetch(`${origin}/send/plain/submilli-high.b3dm`)).headers.get('etag');
  const ourHighEtag = (await fetch(`${origin}/verified/plain/submilli-high.b3dm`)).headers.get('etag');
  assert.equal(ourHighEtag, highEtag, 'sub-millisecond mtime ETag matches send exactly');
  for (const mode of ['plain', 'nostore']) {
    for (const [method, name, headers] of cases) {
      const label = `${mode} ${method} ${name} ${JSON.stringify(headers)}`;
      const [expected, actual] = await Promise.all(['send', 'verified'].map(async (kind) => {
        const response = await fetch(`${origin}/${kind}/${mode}/${name}`, { method, headers });
        const body = Buffer.from(await response.arrayBuffer());
        const kept = Object.fromEntries([...response.headers].filter(([key]) => !ignored.has(key)));
        return { status: response.status, headers: kept, body: body.toString('base64') };
      }));
      assert.deepEqual(actual, expected, label);
    }
  }
});

async function managedFixture(t, { aged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-life-'));
  const modelsMount = path.join(root, 'models');
  fs.mkdirSync(modelsMount, { recursive: true });
  const previous = { modelsMount: config.modelsMount, xAccelRedirectPrefix: config.xAccelRedirectPrefix };
  Object.assign(config, { modelsMount, xAccelRedirectPrefix: '' });
  const write = (rel, body) => { const file = path.join(modelsMount, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const ortho = crypto.randomBytes(3 * CHUNK + 123_456);
  const tile = crypto.randomBytes(300_000);
  // A legacy raster: whole-file SHA-256 only, too large to buffer.
  const dsm = crypto.randomBytes(5 * MiB + 321);
  const tileset = Buffer.from('{"asset":{"version":"1.1"},"root":{}}');
  const files = { ortho: write('task/ortho.tif', ortho), tile: write('task/tiles/0/tile.b3dm', tile), dsm: write('task/dsm.tif', dsm) };
  write('task/tiles/tileset.json', tileset);
  const manifest = [{ relativePath: 'tileset.json', byteSize: tileset.length, sha256: sha256(tileset) }, { relativePath: '0/tile.b3dm', byteSize: tile.length, sha256: sha256(tile) }];
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID(), versionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  repository.upsertModelVersion({
    modelId, versionId, provider: 'ltds-processing', providerModelId: 'delivery', providerVersionId: sha256('delivery'),
    displayName: 'Delivery model', status: 'ready', sourceLocator: {}, versionMetadata: {},
    assets: [
      { kind: 'dsm', rootKey: 'models', relativePath: 'task/dsm.tif', format: 'tif', byteSize: dsm.length, sha256: sha256(dsm), storageMode: 'managed', published: true },
      { kind: 'ortho', rootKey: 'models', relativePath: 'task/ortho.tif', format: 'tif', byteSize: ortho.length, sha256: sha256(ortho), chunks: chunksOf(ortho), storageMode: 'managed', published: true },
      { kind: 'tiles', rootKey: 'models', relativePath: 'task/tiles/tileset.json', format: '3dtiles', byteSize: tileset.length, sha256: sha256(tileset), manifestSha256: sha256(JSON.stringify(manifest)), manifestFiles: manifest, storageMode: 'managed', published: true },
    ],
    makeActive: true,
  });
  repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'ops:test', audience: 'ops', permissions: { view: true }, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  // Real published assets are long settled; let the fixture age past the
  // racily-clean window so in-place rewrites always change ctime.
  if (aged) await sleep(2_200);
  assets.setRepository(repository);
  const integrity = assets.assetIntegrityCache;
  const saved = { platform: integrity.platform, statfs: integrity.statfs, maxConcurrentStreams: integrity.maxConcurrentStreams, maxQueuedStreams: integrity.maxQueuedStreams, bufferedHashMaxBytes: integrity.bufferedHashMaxBytes };
  Object.assign(integrity, localPosix);
  integrity.filesystems.clear();
  integrity.clear();
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await listen(app);
  t.after(async () => {
    hooks.afterVerify = null;
    await close(server);
    assets.setRepository(null);
    Object.assign(integrity, saved);
    integrity.filesystems.clear();
    integrity.clear();
    Object.assign(config, previous);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/session-assets/${token}/${modelId}/models/task`;
  return { base, files, bodies: { ortho, tile, dsm }, integrity, root };
}

async function attempt(url, headers = {}) {
  const response = await fetch(url, { headers });
  try { return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }; }
  catch (error) { return { status: response.status, aborted: true, error }; }
}

const variants = [
  ['tile, whole file', 'tile', 'tiles/0/tile.b3dm', null],
  ['ortho, range inside one chunk', 'ortho', 'ortho.tif', [100, 262_243]],
  ['ortho, range across chunks', 'ortho', 'ortho.tif', [CHUNK - 5000, CHUNK + 5000]],
  ['ortho, whole file', 'ortho', 'ortho.tif', null],
];

test('an asset replaced between verification and delivery never serves the replacement bytes', async (t) => {
  const f = await managedFixture(t);
  for (const [label, key, rel, range] of variants) {
    for (const kind of ['rename-over', 'in-place']) {
      const original = f.bodies[key];
      const replacement = Buffer.from(original); for (let i = 0; i < replacement.length; i += 4096) replacement[i] ^= 0xff;
      fs.writeFileSync(f.files[key], original); // restore before each case
      await sleep(kind === 'in-place' ? 2_200 : 0);
      f.integrity.clear();
      let fired = false;
      hooks.afterVerify = async () => {
        if (fired) return;
        fired = true;
        if (kind === 'rename-over') {
          const temp = `${f.files[key]}.new`;
          fs.writeFileSync(temp, replacement);
          // Windows refuses to rename over a file that is open; the open
          // descriptor already pins the verified bytes there.
          try { fs.renameSync(temp, f.files[key]); } catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; fs.rmSync(temp); }
        }
        else { const handle = fs.openSync(f.files[key], 'r+'); try { fs.writeSync(handle, replacement, 0, replacement.length, 0); } finally { fs.closeSync(handle); } }
      };
      const headers = range ? { range: `bytes=${range[0]}-${range[1]}` } : {};
      const result = await attempt(`${f.base}/${rel}`, headers);
      hooks.afterVerify = null;
      assert.ok(fired, `${label} ${kind}: hook ran after verification`);
      const expected = range ? original.subarray(range[0], range[1] + 1) : original;
      const replaced = range ? replacement.subarray(range[0], range[1] + 1) : replacement;
      if (result.aborted || result.status === 404) continue;
      assert.equal(result.status, range ? 206 : 200, `${label} ${kind}`);
      assert.notDeepEqual(result.body, replaced, `${label} ${kind}: replacement bytes were served`);
      assert.deepEqual(result.body, expected, `${label} ${kind}: only the verified original may be served`);
      if (kind === 'in-place') assert.fail(`${label}: an in-place rewrite after verification must not be served`);
    }
  }
});

test('a file rewritten mid-body never completes with unverified bytes', async (t) => {
  const f = await managedFixture(t);
  const cases = [
    // Registered chunks: the body is the hashed bytes, so it either completes
    // with exactly the verified original or aborts.
    ['ortho', 'ortho.tif', null, 'verified-or-abort'],
    ['ortho', 'ortho.tif', [MiB, 3 * CHUNK], 'verified-or-abort'],
    // Large whole file without chunk records: streamed; the closing fstat
    // sees the change and the response is aborted.
    ['dsm', 'dsm.tif', null, 'abort'],
    ['dsm', 'dsm.tif', [1000, 5 * MiB], 'abort'],
  ];
  for (const [key, rel, range, expectation] of cases) {
    const original = f.bodies[key];
    fs.writeFileSync(f.files[key], original);
    await sleep(2_200);
    f.integrity.clear();
    const response = await fetch(`${f.base}/${rel}`, range ? { headers: { range: `bytes=${range[0]}-${range[1]}` } } : {});
    assert.equal(response.status, range ? 206 : 200);
    const reader = response.body.getReader();
    const parts = [];
    const first = await reader.read(); // the server is now mid-body
    if (!first.done) parts.push(Buffer.from(first.value));
    const handle = fs.openSync(f.files[key], 'r+');
    try { fs.writeSync(handle, Buffer.from('tampered'), 0, 8, original.length - 4096); } finally { fs.closeSync(handle); }
    let completed = false;
    try { for (;;) { const { done, value } = await reader.read(); if (done) { completed = true; break; } parts.push(Buffer.from(value)); } } catch { /* aborted */ }
    const label = `${rel} ${range ? 'range' : 'full'}`;
    if (expectation === 'abort') assert.equal(completed, false, `${label}: must not complete after a mid-stream change`);
    else if (completed) assert.deepEqual(Buffer.concat(parts), range ? original.subarray(range[0], range[1] + 1) : original, `${label}: a completed body is exactly the verified bytes`);
  }
});

test('streamed checks are admitted through a bounded queue that rejects fast and drops closed requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = Array.from({ length: 6 }, (_, i) => { const file = path.join(root, `f${i}`), body = crypto.randomBytes(32 * 1024); fs.writeFileSync(file, body); return { file, sha: sha256(body) }; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new AssetIntegrityCache({ ...localPosix, wallNow: () => Date.now() + 60_000, bufferedHashMaxBytes: 0, maxConcurrentStreams: 1, maxQueuedStreams: 2,
    openFile: async (file) => { await gate; return fs.promises.open(file, 'r'); } });
  const stat = (file) => fs.statSync(file, { bigint: true });
  const cancel = new AbortController();
  const running = cache.verifyWholeFile(files[0].file, stat(files[0].file), files[0].sha);
  const queued = cache.verifyWholeFile(files[1].file, stat(files[1].file), files[1].sha);
  const cancelled = cache.verifyWholeFile(files[2].file, stat(files[2].file), files[2].sha, { signal: cancel.signal });
  while (cache.streamWaiters.length < 2) await sleep(1);
  await assert.rejects(cache.verifyWholeFile(files[3].file, stat(files[3].file), files[3].sha), { code: 'integrity_busy' });
  assert.equal(cache.stats.busy, 1);
  cancel.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(cache.streamWaiters.length, 1, 'the closed request left the queue');
  assert.equal(cache.stats.cancelled, 1);
  const late = cache.verifyWholeFile(files[4].file, stat(files[4].file), files[4].sha);
  release();
  assert.deepEqual(await Promise.all([running, queued, late]), [true, true, true]);
  assert.equal(cache.activeStreams, 0);
  assert.equal(cache.streamWaiters.length, 0);
});

test('a shared check whose owner request closed is redone for the remaining request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-share-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tile'), body = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(file, body);
  let opens = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new AssetIntegrityCache({ ...localPosix, wallNow: () => Date.now() + 60_000,
    openFile: async (p) => { opens += 1; if (opens === 1) await gate; return fs.promises.open(p, 'r'); } });
  const s = fs.statSync(file, { bigint: true });
  const owner = new AbortController();
  const first = cache.verifyWholeFile(file, s, sha256(body), { signal: owner.signal });
  while (cache.pending.size === 0) await sleep(1);
  const second = cache.verifyWholeFile(file, s, sha256(body));
  owner.abort();
  release();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await second, true);
  assert.equal(opens, 2, 'the remaining request ran its own check');
});

test('session asset requests get a fast 503 when the queue is full and leave it when the client goes away', async (t) => {
  const f = await managedFixture(t, { aged: false });
  Object.assign(f.integrity, { bufferedHashMaxBytes: 0, maxConcurrentStreams: 1, maxQueuedStreams: 1 });
  await f.integrity.acquireStream(); // occupy the only slot
  let held = true;
  t.after(() => { if (held) f.integrity.releaseStream(); });
  const client = new AbortController();
  const queued = fetch(`${f.base}/tiles/0/tile.b3dm`, { signal: client.signal }).catch((error) => error);
  while (f.integrity.streamWaiters.length < 1) await sleep(2);
  const busy = await fetch(`${f.base}/ortho.tif`, { headers: { range: 'bytes=0-99' } });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.deepEqual(await busy.json(), { error: 'asset delivery busy', code: 'integrity_busy' });
  client.abort();
  await queued;
  for (let i = 0; i < 200 && f.integrity.streamWaiters.length; i += 1) await sleep(5);
  assert.equal(f.integrity.streamWaiters.length, 0, 'the closed request was removed from the queue');
  f.integrity.releaseStream(); held = false;
  assert.equal(f.integrity.activeStreams, 0);
  const ok = await attempt(`${f.base}/tiles/0/tile.b3dm`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, f.bodies.tile);
});

// A file handle whose bytes can be switched while its fstat identity stays
// constant. It models the worst case: a change the identity checks cannot see.
function shiftyHandle(contents, size) {
  const mtimeNs = 1_700_000_000_000_000_000n;
  const big = { dev: 7n, ino: 99n, size: BigInt(size), mtimeNs, ctimeNs: mtimeNs, isFile: () => true };
  const handle = {
    reads: 0,
    async stat(options) { return options?.bigint ? big : { size, mtime: new Date(Number(mtimeNs / 1_000_000n)), isFile: () => true }; },
    async read(buffer, offset, length, position) {
      handle.reads += 1;
      const source = contents.current;
      const n = Math.max(0, Math.min(length, source.length - position));
      source.copy(buffer, offset, position, position + n);
      return { bytesRead: n, buffer };
    },
    async close() {},
  };
  return { handle, stat: big };
}

async function serveShifty(t, { eligible, chunkSize, range, bytesCacheMaxBytes }) {
  const good = crypto.randomBytes(4 * 64 * 1024 + 777);
  const tampered = Buffer.from(good); for (let i = 0; i < tampered.length; i += 512) tampered[i] ^= 0xff;
  const contents = { current: good };
  const chunks = chunkSize ? Array.from({ length: Math.ceil(good.length / chunkSize) }, (_, i) => {
    const slice = good.subarray(i * chunkSize, Math.min(good.length, (i + 1) * chunkSize));
    return { byteOffset: i * chunkSize, byteSize: slice.length, sha256: sha256(slice) };
  }) : [];
  const cache = new AssetIntegrityCache({ platform: eligible ? 'linux' : 'win32', statfs: async () => ({ type: 0x2fc12fc1 }), wallNow: () => Date.now() + 60_000,
    ...(bytesCacheMaxBytes === undefined ? {} : { bytesCacheMaxBytes }) });
  const hashed = [];
  const hashRegion = cache.hashRegion.bind(cache);
  cache.hashRegion = async (...args) => { const result = await hashRegion(...args); if (result?.buffer) hashed.push({ offset: args[2], bytes: Buffer.from(result.buffer), digest: result.digest }); return result; };
  const filePath = '/virtual/asset.bin';
  const app = express();
  app.get('/asset', async (req, res) => {
    const opened = shiftyHandle(contents, good.length);
    await deliverVerified(req, res, {
      ...opened, filePath, cache,
      verify: async (r, signal) => {
        if (!chunkSize) return cache.verifyWholeFile(filePath, opened.stat, sha256(good), { handle: opened.handle, signal });
        const selected = r ? chunks.filter((c) => c.byteOffset <= r.end && c.byteOffset + c.byteSize - 1 >= r.start) : chunks;
        for (const chunk of selected) if (!await cache.verifyChunk(filePath, opened.stat, chunk, { handle: opened.handle, signal })) return false;
        return true;
      },
      regions: (start, end) => (chunkSize
        ? chunks.filter((c) => c.byteOffset <= end && c.byteOffset + c.byteSize - 1 >= start).map((c) => ({ kind: 'chunk', offset: c.byteOffset, size: c.byteSize, sha256: c.sha256 }))
        : [{ kind: 'file', offset: 0, size: good.length, sha256: sha256(good), toEof: true }]),
      onFailure: () => res.sendStatus(404),
      onError: (error) => res.sendStatus(error.status || 500),
    });
  });
  const server = await listen(app);
  t.after(async () => { hooks.afterVerify = null; await close(server); });
  // Switch the bytes the moment verification has passed.
  hooks.afterVerify = async () => { contents.current = tampered; };
  let body = null, aborted = false, status = null;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/asset`, range ? { headers: { range: `bytes=${range[0]}-${range[1]}` } } : {});
    status = response.status;
    body = Buffer.from(await response.arrayBuffer());
  } catch { aborted = true; }
  hooks.afterVerify = null;
  const [from, to] = range || [0, good.length - 1];
  return { status, body, aborted, expected: good.subarray(from, to + 1), tampered: tampered.subarray(from, to + 1), hashed, from, to };
}

// Reassembles [from, to] from the buffers that were actually hashed.
function fromHashed(hashed, from, to) {
  const out = Buffer.alloc(to - from + 1);
  for (const { offset, bytes, digest } of hashed) {
    assert.equal(sha256(bytes), digest);
    const a = Math.max(from, offset), b = Math.min(to + 1, offset + bytes.length);
    if (a < b) bytes.copy(out, a - from, a - offset, b - offset);
  }
  return out;
}

for (const [label, chunkSize, range] of [
  ['registered chunks, range across chunks', 64 * 1024, [10_000, 150_000]],
  ['registered chunks, whole file', 64 * 1024, null],
  ['small whole file', 0, null],
  ['small whole file, range', 0, [100, 5_000]],
]) {
  test(`${label}: the bytes sent are the bytes that were hashed`, async (t) => {
    const result = await serveShifty(t, { eligible: true, chunkSize, range });
    assert.equal(result.aborted, false);
    assert.equal(result.status, range ? 206 : 200);
    assert.deepEqual(result.body, result.expected, 'sent bytes are the verified bytes, not the switched ones on disk');
    assert.deepEqual(result.body, fromHashed(result.hashed, result.from, result.to), 'sent bytes equal the hashed buffers');
  });
  test(`${label}: with nothing kept in memory, switched bytes are re-hashed and the response aborts`, async (t) => {
    for (const options of [{ eligible: false }, { eligible: true, bytesCacheMaxBytes: 0 }]) {
      const result = await serveShifty(t, { ...options, chunkSize, range });
      assert.equal(result.aborted, true, `${JSON.stringify(options)}: a response whose bytes fail their hash never completes`);
    }
  });
}

test('legacy large files are outside the guarantee and behave like main: whole-file hash per request, no reuse', async (t) => {
  const f = await managedFixture(t, { aged: false });
  const hashed = [];
  const hashRegion = f.integrity.hashRegion.bind(f.integrity);
  f.integrity.hashRegion = async (...args) => { hashed.push({ offset: args[2], size: args[3] }); return hashRegion(...args); };
  t.after(() => { delete f.integrity.hashRegion; });
  const before = { ...f.integrity.stats };
  for (const range of [[1000, 1999], [1000, 1999], null]) {
    const result = await attempt(`${f.base}/dsm.tif`, range ? { range: `bytes=${range[0]}-${range[1]}` } : {});
    assert.equal(result.status, range ? 206 : 200);
    assert.deepEqual(result.body, range ? f.bodies.dsm.subarray(range[0], range[1] + 1) : f.bodies.dsm);
  }
  assert.deepEqual(hashed, [0, 1, 2].map(() => ({ offset: 0, size: f.bodies.dsm.length })), 'the whole file is hashed for every request, even a 1000-byte range');
  assert.equal(f.integrity.stats.legacy - before.legacy, 3);
  assert.equal(f.integrity.stats.hits - before.hits, 0, 'no remembered result');
  assert.equal(f.integrity.stats.bytesHits - before.bytesHits, 0, 'no kept bytes');
  assert.ok([...f.integrity.bytes.keys()].every((key) => !key.includes('dsm.tif')));
  // A same-size rewrite immediately after a good response is caught next time.
  const tampered = Buffer.from(f.bodies.dsm); tampered[1500] ^= 0xff;
  fs.writeFileSync(f.files.dsm, tampered);
  assert.equal((await attempt(`${f.base}/dsm.tif`, { range: 'bytes=1000-1999' })).status, 404);
});

async function busyHarness(t, { onSecondSlice = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-busy-'));
  const filePath = path.join(root, 'asset.bin');
  const body = crypto.randomBytes(2 * 64 * 1024);
  fs.writeFileSync(filePath, body);
  const chunks = [0, 64 * 1024].map((offset) => ({ byteOffset: offset, byteSize: 64 * 1024, sha256: sha256(body.subarray(offset, offset + 64 * 1024)) }));
  const cache = new AssetIntegrityCache({ ...localPosix, wallNow: () => Date.now() + 60_000, bufferedBudgetBytes: 128 * 1024, maxQueuedStreams: 0 });
  if (onSecondSlice) {
    const original = cache.verifiedSlice.bind(cache);
    let calls = 0;
    cache.verifiedSlice = async (...args) => { calls += 1; if (calls === 2) await onSecondSlice(cache); return original(...args); };
  }
  const app = express();
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.get('/asset', async (req, res) => {
    const opened = await openForDelivery(filePath);
    await deliverVerified(req, res, {
      ...opened, filePath, cache, headers: { 'Cache-Control': 'private, no-store' },
      verify: async (_range, signal) => { for (const chunk of chunks) if (!await cache.verifyChunk(filePath, opened.stat, chunk, { handle: opened.handle, signal })) return false; return true; },
      regions: () => chunks.map((c) => ({ kind: 'chunk', offset: c.byteOffset, size: c.byteSize, sha256: c.sha256 })),
      onFailure: () => res.sendStatus(404),
      onError: (error) => res.sendStatus(error.status || 500),
    });
  });
  const server = await listen(app);
  t.after(async () => { await close(server); fs.rmSync(root, { recursive: true, force: true }); });
  return { cache, body, filePath, url: `http://127.0.0.1:${server.address().port}/asset` };
}

test('buffer budget exhausted before any body byte: 503 with Retry-After and no file headers', async (t) => {
  const h = await busyHarness(t);
  await h.cache.reserve(h.cache.bufferedBudgetBytes); // the whole budget is in use
  t.after(() => h.cache.unreserve(h.cache.bufferedBudgetBytes));
  const response = await fetch(h.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.deepEqual(await response.json(), { error: 'asset delivery busy', code: 'integrity_busy' });
  for (const name of ['last-modified', 'accept-ranges', 'content-range', 'cache-control']) assert.equal(response.headers.get(name), null, `${name} is not left on the 503`);
  const fileStat = fs.statSync(h.filePath);
  assert.notEqual(response.headers.get('etag'), `W/"${fileStat.size.toString(16)}-${fileStat.mtime.getTime().toString(16)}"`, 'the file ETag is not left on the 503 (express may add its own for the JSON body)');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', 'headers from other middleware are kept');
});

test('buffer budget exhausted after the body started: the response is aborted, never completed', async (t) => {
  const h = await busyHarness(t, { onSecondSlice: async (cache) => {
    const free = cache.bufferedBudgetBytes - cache.bufferedBytes;
    if (free > 0) await cache.reserve(free);
    t.after(() => cache.unreserve(free));
  } });
  let status = null, completed = false;
  try {
    const response = await fetch(h.url);
    status = response.status;
    await response.arrayBuffer();
    completed = true;
  } catch { /* aborted */ }
  assert.equal(status, 200, 'the status line was already committed');
  assert.equal(completed, false, 'a busy rejection mid-body aborts the response');
});

test('uncached path (verification not remembered): each region is read and hashed exactly once per request', async (t) => {
  const f = await managedFixture(t, { aged: false });
  f.integrity.platform = 'win32'; // the switch the other uncached tests use
  const hashed = [];
  const hashRegion = f.integrity.hashRegion.bind(f.integrity);
  f.integrity.hashRegion = async (...args) => { hashed.push(`${args[2]}+${args[3]}`); return hashRegion(...args); };
  t.after(() => { delete f.integrity.hashRegion; f.integrity.carryMaxBytes = 16 * MiB; });
  const once = (label, list) => assert.equal(new Set(list).size, list.length, `${label}: a region was hashed twice (${list.join(', ')})`);
  const cases = [
    ['ortho range inside one chunk', 'ortho.tif', [100, 262_243], 1],
    ['ortho range across chunks', 'ortho.tif', [CHUNK - 5000, CHUNK + 5000], 2],
    ['ortho whole file', 'ortho.tif', null, 4],
    ['tile', 'tiles/0/tile.b3dm', null, 1],
    ['tile range', 'tiles/0/tile.b3dm', [10, 2000], 1],
  ];
  for (const carryMaxBytes of [16 * MiB, 4 * MiB]) {
    f.integrity.carryMaxBytes = carryMaxBytes; // 4 MiB forces deferral past the first chunk
    for (const [label, rel, range, regions] of cases) {
      hashed.length = 0;
      const result = await attempt(`${f.base}/${rel}`, range ? { range: `bytes=${range[0]}-${range[1]}` } : {});
      const body = rel === 'ortho.tif' ? f.bodies.ortho : f.bodies.tile;
      assert.equal(result.status, range ? 206 : 200, label);
      assert.deepEqual(result.body, range ? body.subarray(range[0], range[1] + 1) : body, label);
      once(`${label} (carry ${carryMaxBytes / MiB} MiB)`, hashed);
      assert.equal(hashed.length, regions, `${label} (carry ${carryMaxBytes / MiB} MiB): one hash per region`);
    }
  }
  assert.equal(f.integrity.bufferedBytes, 0, 'every carried buffer was released');
  assert.equal(f.integrity.bytes.size, 0, 'nothing remembered on the uncached path');
});

// Isolated budget regression: a global budget of two 64 KiB chunks, many
// concurrent eight-chunk responses. Every request must finish (200 with exact
// bytes) or fail fast (503) — never hang — and all budget must come back.
async function budgetHarness(t, { eligible }) {
  const CH = 64 * 1024;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-delivery-budget-'));
  const filePath = path.join(root, 'asset.bin');
  const body = crypto.randomBytes(8 * CH);
  fs.writeFileSync(filePath, body);
  const chunks = Array.from({ length: 8 }, (_, i) => ({ byteOffset: i * CH, byteSize: CH, sha256: sha256(body.subarray(i * CH, (i + 1) * CH)) }));
  const cache = new AssetIntegrityCache({ platform: eligible ? 'linux' : 'win32', statfs: async () => ({ type: 0x2fc12fc1 }), wallNow: () => Date.now() + 60_000,
    bufferedBudgetBytes: 2 * CH, maxQueuedStreams: 4, bytesCacheMaxBytes: eligible ? 2 * CH : 0 });
  let inFlight = 0;
  const app = express();
  app.get('/asset', async (req, res) => {
    inFlight += 1;
    try {
      const opened = await openForDelivery(filePath);
      const read = opened.handle.read.bind(opened.handle);
      opened.handle.read = async (...args) => { await sleep(1); return read(...args); }; // force interleaving
      await deliverVerified(req, res, {
        ...opened, filePath, cache,
        verify: async (r, signal, carry) => {
          const selected = r ? chunks.filter((c) => c.byteOffset <= r.end && c.byteOffset + c.byteSize - 1 >= r.start) : chunks;
          for (const chunk of selected) if (!await cache.verifyChunk(filePath, opened.stat, chunk, { handle: opened.handle, signal, carry })) return false;
          return true;
        },
        regions: (start, end) => chunks.filter((c) => c.byteOffset <= end && c.byteOffset + c.byteSize - 1 >= start).map((c) => ({ kind: 'chunk', offset: c.byteOffset, size: c.byteSize, sha256: c.sha256 })),
        onFailure: () => res.sendStatus(404),
        onError: (error) => res.sendStatus(error.status || 500),
      });
    } finally { inFlight -= 1; }
  });
  const server = await listen(app);
  t.after(async () => { await close(server); fs.rmSync(root, { recursive: true, force: true }); });
  const settled = async () => {
    for (let i = 0; i < 400 && (inFlight || cache.bufferedBytes || cache.bufferWaiters.length || cache.activeStreams); i += 1) await sleep(25);
    return { inFlight, bufferedBytes: cache.bufferedBytes, bufferWaiters: cache.bufferWaiters.length, activeStreams: cache.activeStreams };
  };
  return { cache, body, settled, url: `http://127.0.0.1:${server.address().port}/asset` };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: hung for ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}

for (const eligible of [false, true]) {
  const mode = eligible ? 'cached path' : 'uncached path';
  test(`${mode}: concurrent multi-chunk responses over a two-chunk budget all finish or 503, never hang`, async (t) => {
    const h = await budgetHarness(t, { eligible });
    const ranges = [null, null, null, [0, 300_000], [70_000, 400_000], null, [10, 524_000], null, null, [200_000, 500_000], null, null];
    const outcomes = await withTimeout(Promise.all(ranges.map(async (range) => {
      const response = await fetch(h.url, range ? { headers: { range: `bytes=${range[0]}-${range[1]}` } } : {});
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status === 503) { assert.equal(response.headers.get('retry-after'), '1'); return 503; }
      assert.equal(response.status, range ? 206 : 200);
      assert.deepEqual(bytes, range ? h.body.subarray(range[0], range[1] + 1) : h.body);
      return response.status;
    })), 20_000, mode);
    assert.ok(outcomes.some((status) => status !== 503), 'some requests were served');
    assert.deepEqual(await h.settled(), { inFlight: 0, bufferedBytes: 0, bufferWaiters: 0, activeStreams: 0 }, 'all budget returned');
    assert.ok(h.cache.stats.peakBufferedBytes <= h.cache.bufferedBudgetBytes);
  });

  test(`${mode}: clients aborting mid-request never leak budget`, async (t) => {
    const h = await budgetHarness(t, { eligible });
    await withTimeout(Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 2 + (i % 6) * 4);
      try {
        const response = await fetch(h.url, { signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        if (i % 2) controller.abort();
        for (;;) { const { done } = await reader.read(); if (done) break; }
      } catch { /* aborted by the client */ }
    })), 20_000, `${mode} aborts`);
    assert.deepEqual(await h.settled(), { inFlight: 0, bufferedBytes: 0, bufferWaiters: 0, activeStreams: 0 }, 'all budget returned after aborts');
    // The pool still works afterwards.
    const after = await fetch(h.url);
    assert.equal(after.status, 200);
    assert.deepEqual(Buffer.from(await after.arrayBuffer()), h.body);
  });
}
