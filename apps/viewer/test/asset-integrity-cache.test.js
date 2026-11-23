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
const { AssetIntegrityCache } = require('../server/assetIntegrityCache');

const CHUNK = 4 * 1024 * 1024;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stat = (file) => fs.statSync(file, { bigint: true });

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function countingCache(options = {}) {
  const cache = new AssetIntegrityCache(options);
  const remember = cache.remember.bind(cache);
  cache.verifications = 0;
  cache.remember = (key, verify) => remember(key, async () => { cache.verifications += 1; return verify(); });
  return cache;
}

test('a verified region is hashed once per file identity and concurrent requests share one hash', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const body = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(file, body);
  const cache = countingCache();
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
  const cache = countingCache();
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('other bytes')), false);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256('other bytes')), false);
  assert.equal(cache.verifications, 2);
  assert.equal(cache.verified.size, 0);
});

test('same-size rewrites, restored timestamps, and rename-over replacements are re-hashed and fail closed', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'ortho.tif');
  const good = crypto.randomBytes(32 * 1024);
  fs.writeFileSync(file, good);
  const cache = countingCache();
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), true);

  const original = fs.statSync(file);
  const tampered = Buffer.from(good); tampered[100] ^= 0xff;
  fs.writeFileSync(file, tampered);
  fs.utimesSync(file, original.atime, original.mtime);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), false, 'in-place same-size rewrite with restored mtime');

  fs.writeFileSync(file, good);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), true);
  const replacement = path.join(root, 'replacement.tif');
  fs.writeFileSync(replacement, tampered);
  fs.renameSync(replacement, file);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(good)), false, 'rename-over replacement');
});

test('a stat taken before a swap cannot verify the swapped-in file under the old identity', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'tile.b3dm');
  const good = Buffer.from('good tile bytes');
  fs.writeFileSync(file, Buffer.from('bad! tile bytes'));
  const before = stat(file);
  const replacement = path.join(root, 'good.b3dm');
  fs.writeFileSync(replacement, good);
  fs.renameSync(replacement, file);
  const cache = countingCache();
  assert.equal(await cache.verifyWholeFile(file, before, sha256(good)), false);
  assert.equal(cache.verified.size, 0);
});

test('remembered verifications expire after the TTL and are bounded in number', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  let now = 1_000;
  const cache = countingCache({ ttlMs: 50, maxEntries: 2, now: () => now });
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
});

test('large legacy files stream-hash and still bind the result to the file identity', async (t) => {
  const root = tempDir(t, 'ltds-integrity-unit-');
  const file = path.join(root, 'dsm.tif');
  const body = crypto.randomBytes(256 * 1024);
  fs.writeFileSync(file, body);
  const cache = countingCache({ bufferedHashMaxBytes: 1024 });
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), true);
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), true);
  assert.equal(cache.verifications, 1);
  fs.appendFileSync(file, 'x');
  assert.equal(await cache.verifyWholeFile(file, stat(file), sha256(body)), false);
});

test('session asset ranges and tiles stay byte-exact, verify once, and fail closed after tampering', async (t) => {
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
      { kind: 'tiles', rootKey: 'models', relativePath: 'task/tiles/tileset.json', format: '3dtiles', byteSize: tileset.length, sha256: sha256(tileset), manifestSha256: sha256(JSON.stringify(manifest)), manifestFiles: manifest, storageMode: 'managed', published: true },
    ],
    makeActive: true,
  });
  repository.createViewerSession({
    tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'ops:test', audience: 'ops',
    permissions: { view: true, cameras: true }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assets.setRepository(repository);
  assets.assetIntegrityCache.clear();
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assets.setRepository(null);
    assets.assetIntegrityCache.clear();
    Object.assign(config, previous);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/session-assets/${token}/${modelId}/models/task`;
  const get = async (rel, range) => {
    const response = await fetch(`${base}/${rel}`, range ? { headers: { range } } : {});
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()), cacheControl: response.headers.get('cache-control') };
  };

  const missesBefore = assets.assetIntegrityCache.stats.misses;
  const ranges = [[0, 262143], [262144, 524287], [CHUNK - 1000, CHUNK + 1000], [CHUNK + 1024, ortho.length - 1]];
  for (const [start, end] of ranges) {
    const response = await get('ortho.tif', `bytes=${start}-${end}`);
    assert.equal(response.status, 206);
    assert.deepEqual(response.body, ortho.subarray(start, end + 1));
    assert.equal(response.cacheControl, 'private, no-store', 'authorization-bound caching policy is unchanged');
  }
  assert.equal(assets.assetIntegrityCache.stats.misses - missesBefore, 2, 'each 4 MiB chunk is hashed once for many block requests');
  for (let i = 0; i < 2; i += 1) {
    const response = await get('tiles/0/0/tile.b3dm');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, tile);
  }
  assert.equal(assets.assetIntegrityCache.stats.misses - missesBefore, 3, 'repeat tile requests reuse the verification');

  const tamperedTile = Buffer.from(tile); tamperedTile[10] ^= 0xff;
  fs.writeFileSync(tileFile, tamperedTile);
  assert.equal((await get('tiles/0/0/tile.b3dm')).status, 404);
  const tamperedOrtho = Buffer.from(ortho.subarray(0, CHUNK)); tamperedOrtho[5] ^= 0xff;
  const handle = fs.openSync(orthoFile, 'r+');
  try { fs.writeSync(handle, tamperedOrtho, 0, tamperedOrtho.length, 0); } finally { fs.closeSync(handle); }
  assert.equal((await get('ortho.tif', 'bytes=0-262143')).status, 404, 'tampered chunk fails closed');
  const missesAfterTamper = assets.assetIntegrityCache.stats.misses;
  const intact = await get('ortho.tif', `bytes=${CHUNK + 1024}-${CHUNK + 2047}`);
  assert.equal(intact.status, 206, 'an untouched chunk still serves, exactly as before');
  assert.deepEqual(intact.body, ortho.subarray(CHUNK + 1024, CHUNK + 2048));
  assert.equal(assets.assetIntegrityCache.stats.misses - missesAfterTamper, 1, 'the changed file identity forced a fresh hash of that chunk');
  assert.equal((await get('ortho.tif')).status, 404, 'a full response still requires every chunk');
});
