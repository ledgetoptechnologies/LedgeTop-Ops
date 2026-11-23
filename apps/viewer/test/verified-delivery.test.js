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
  const files = { 'tile.b3dm': crypto.randomBytes(200_000), 'ortho.tif': crypto.randomBytes(300_000), 'tileset.json': Buffer.from('{"asset":{"version":"1.1"}}'), 'empty.laz': Buffer.alloc(0) };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
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
  ];
  const ignored = new Set(['date', 'connection', 'keep-alive', 'x-powered-by']);
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
  const tileset = Buffer.from('{"asset":{"version":"1.1"},"root":{}}');
  const files = { ortho: write('task/ortho.tif', ortho), tile: write('task/tiles/0/tile.b3dm', tile) };
  write('task/tiles/tileset.json', tileset);
  const manifest = [{ relativePath: 'tileset.json', byteSize: tileset.length, sha256: sha256(tileset) }, { relativePath: '0/tile.b3dm', byteSize: tile.length, sha256: sha256(tile) }];
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID(), versionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  repository.upsertModelVersion({
    modelId, versionId, provider: 'ltds-processing', providerModelId: 'delivery', providerVersionId: sha256('delivery'),
    displayName: 'Delivery model', status: 'ready', sourceLocator: {}, versionMetadata: {},
    assets: [
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
  return { base, files, bodies: { ortho, tile }, integrity, root };
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

test('a file rewritten while its body is streaming aborts the response instead of completing', async (t) => {
  const f = await managedFixture(t);
  for (const range of [null, [MiB, 3 * CHUNK]]) {
    fs.writeFileSync(f.files.ortho, f.bodies.ortho);
    await sleep(2_200);
    f.integrity.clear();
    const response = await fetch(`${f.base}/ortho.tif`, range ? { headers: { range: `bytes=${range[0]}-${range[1]}` } } : {});
    assert.equal(response.status, range ? 206 : 200);
    const reader = response.body.getReader();
    await reader.read(); // the server is now mid-body
    const handle = fs.openSync(f.files.ortho, 'r+');
    try { fs.writeSync(handle, Buffer.from('tampered'), 0, 8, f.bodies.ortho.length - 4096); } finally { fs.closeSync(handle); }
    let completed = false;
    try { for (;;) { const { done } = await reader.read(); if (done) { completed = true; break; } } } catch { /* expected: aborted */ }
    assert.equal(completed, false, `response ${range ? 'range' : 'full'} must not complete after a mid-stream change`);
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
  const cache = new AssetIntegrityCache({ ...localPosix, wallNow: () => Date.now() + 60_000, bufferedHashMaxBytes: 0,
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
