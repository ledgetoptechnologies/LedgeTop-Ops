'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { createAssetRateLimiter } = require('../server/assetRateLimiter');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const WINDOW = 5 * 60_000;
const refuse = { rateLimited: () => assert.fail('overflow used below the bound'), abuseWindowLive: () => assert.fail('overflow read below the bound') };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-asset-limit-')), file = path.join(root, 'viewer.sqlite');
  const database = openDatabase(file), repository = new ViewerRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, database, repository };
}

test('allows and denies exactly like the SQLite limiter at every boundary', (t) => {
  const { repository } = fixture(t);
  let at = Date.parse('2026-11-23T00:00:00.000Z');
  const limiter = createAssetRateLimiter({ windowMs: WINDOW, now: () => at });
  const both = (bucket, max) => {
    const expected = repository.rateLimited(bucket, max, WINDOW, { at });
    assert.equal(limiter.rateLimited(bucket, max, refuse), expected, `${bucket} at ${new Date(at).toISOString()}`);
    return expected;
  };
  const start = at;
  assert.deepEqual([both('a', 2), both('a', 2), both('a', 2), both('a', 2)], [false, false, true, true]);
  assert.equal(both('b', 2), false, 'buckets are independent');
  at = start + WINDOW - 1; assert.equal(both('a', 2), true, 'blocked to the end of the block');
  at = start + WINDOW; assert.equal(both('a', 2), false, 'released exactly when the block ends');
  assert.equal(both('b', 2), false, 'a fresh window');
  // A block starts at the denied request, so it outlives the window it broke.
  const late = at + WINDOW - 10;
  at = late; assert.deepEqual([both('a', 2), both('a', 2)], [false, true]);
  at = late + 20; assert.equal(both('a', 2), true, 'the block continues past the original window');
  at = late + WINDOW; assert.equal(both('a', 2), false);
  // Unicode-equivalent buckets are one bucket, as before.
  assert.deepEqual([both('é', 1), both('é', 1)], [false, true]);
});

test('allows and denies exactly like the SQLite limiter over randomized traffic', (t) => {
  const { database, repository } = fixture(t);
  database.exec('PRAGMA synchronous=OFF');
  let at = Date.parse('2026-11-23T00:00:00.000Z'), state = 7;
  const random = (n) => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return Math.floor(state / 65536) % n; };
  const limiter = createAssetRateLimiter({ windowMs: WINDOW, now: () => at });
  const decisions = { allowed: 0, denied: 0 };
  for (let index = 0; index < 6000; index += 1) {
    const choice = random(40);
    if (choice === 0) at += WINDOW;
    else if (choice === 1) at += WINDOW - random(3000);
    else at += random(4000);
    const bucket = `bucket-${random(6)}`, max = 1 + Number(bucket.at(-1));
    const expected = repository.rateLimited(bucket, max, WINDOW, { at });
    assert.equal(limiter.rateLimited(bucket, max, refuse), expected, `request ${index}`);
    decisions[expected ? 'denied' : 'allowed'] += 1;
  }
  assert.ok(decisions.allowed > 1000 && decisions.denied > 1000, JSON.stringify(decisions));
});

test('elapsed entries are dropped and nothing touches SQLite below the bound', () => {
  let at = 1000;
  const limiter = createAssetRateLimiter({ windowMs: WINDOW, maxEntries: 100, now: () => at });
  for (let round = 0; round < 5; round += 1) {
    for (let index = 0; index < 100; index += 1) assert.equal(limiter.rateLimited(`bucket-${index}`, 1, refuse), false);
    for (let index = 0; index < 100; index += 1) assert.equal(limiter.rateLimited(`bucket-${index}`, 1, refuse), true);
    assert.equal(limiter.size, 100);
    at += WINDOW;
    limiter.rateLimited('next', 1, refuse);
    assert.equal(limiter.size, 1);
    at += WINDOW;
  }
});

test('at the bound live blocks and quotas survive, and new buckets are decided by SQLite', (t) => {
  const { database, repository } = fixture(t), reference = fixture(t).repository;
  database.exec('PRAGMA synchronous=OFF'); reference.database.exec('PRAGMA synchronous=OFF');
  const start = Date.parse('2026-11-23T00:00:00.000Z');
  let at = start;
  const limiter = createAssetRateLimiter({ windowMs: WINDOW, maxEntries: 100, now: () => at });
  const check = (bucket, max) => {
    const decision = limiter.rateLimited(bucket, max, repository);
    assert.equal(decision, reference.rateLimited(bucket, max, WINDOW, { at }), bucket);
    assert.ok(limiter.size <= 100);
    return decision;
  };
  // The oldest entries, so eviction by age or release would take them first.
  check('blocked', 1); assert.equal(check('blocked', 1), true);
  for (let hit = 0; hit < 5; hit += 1) assert.equal(check('counting', 6), false);
  const rows = () => database.prepare('SELECT COUNT(*) AS n FROM abuse_windows').get().n;
  for (let index = 0; index < 98; index += 1) check(`filler-${index}`, 10);
  assert.equal(rows(), 0);
  at += 1;
  for (let index = 0; index < 3000; index += 1) check(`junk-${index}-${'x'.repeat(2000)}`, 10);
  assert.equal(limiter.size, 100);
  assert.equal(rows(), 3000, 'overflow is counted in SQLite');
  assert.equal(check('blocked', 1), true, 'a live block survives saturation');
  assert.equal(check('counting', 6), false, 'the sixth request is still allowed');
  assert.equal(check('counting', 6), true, 'and a live quota survives saturation');
  // A legitimate newcomer is not locked out and has the normal quota.
  assert.deepEqual([check('client', 3), check('client', 3), check('client', 3), check('client', 3)], [false, false, false, true]);
  // Room again: the newcomer's block continues in SQLite until it ends.
  at = start + WINDOW;
  assert.equal(check('fresh', 10), false);
  assert.ok(limiter.size < 100);
  assert.equal(check('client', 3), true, 'freeing the table does not forget an overflowed block');
  at = start + 1 + WINDOW;
  assert.equal(check('client', 3), false, 'released when SQLite releases it');
  // Long after the overflow nothing is written to SQLite any more.
  at += 3 * WINDOW;
  const before = database.prepare('SELECT MAX(updated_at) AS latest FROM abuse_windows').get().latest;
  for (let index = 0; index < 50; index += 1) check(`later-${index}`, 10);
  assert.equal(database.prepare('SELECT MAX(updated_at) AS latest FROM abuse_windows').get().latest, before);
});

test('decisions equal SQLite over randomized traffic at a saturated bound', (t) => {
  const { database, repository } = fixture(t), reference = fixture(t).repository;
  database.exec('PRAGMA synchronous=OFF'); reference.database.exec('PRAGMA synchronous=OFF');
  let at = Date.parse('2026-11-23T00:00:00.000Z'), state = 99;
  const random = (n) => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return Math.floor(state / 65536) % n; };
  const limiter = createAssetRateLimiter({ windowMs: WINDOW, maxEntries: 4, now: () => at });
  let overflowed = 0, kept = 0, denied = 0;
  const spy = { abuseWindowLive: (...args) => repository.abuseWindowLive(...args), rateLimited: (...args) => { overflowed += 1; return repository.rateLimited(...args); } };
  for (let index = 0; index < 8000; index += 1) {
    const choice = random(60);
    at += choice === 0 ? WINDOW : choice === 1 ? WINDOW - random(3000) : random(6000);
    const bucket = `bucket-${random(10)}`, max = 1 + Number(bucket.at(-1)) % 4, before = overflowed;
    const expected = reference.rateLimited(bucket, max, WINDOW, { at });
    assert.equal(limiter.rateLimited(bucket, max, spy), expected, `request ${index}`);
    if (overflowed === before) kept += 1;
    if (expected) denied += 1;
    assert.ok(limiter.size <= 4);
  }
  assert.ok(overflowed > 1000 && kept > 1000 && denied > 1000, JSON.stringify({ overflowed, kept, denied }));
});

async function delivery(t) {
  const c = fixture(t), root = path.join(c.root, 'assets');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'model.glb'), 'mesh');
  c.repository.upsertModelVersion({ modelId: 'model', versionId: 'version', provider: 'webodm', providerModelId: 'p', providerVersionId: 'version', displayName: 'Model', status: 'ready',
    sourceLocator: { legacyAssetRoots: { fixture: root } },
    assets: [{ kind: 'glb', rootKey: 'fixture', relativePath: 'model.glb', byteSize: 4, sha256: crypto.createHash('sha256').update('mesh').digest('hex'), published: true }] });
  c.repository.createViewerSession({ tokenHash: auth.hashToken('session'), modelId: 'model', modelVersionId: 'version', subject: 's', audience: 'ops', permissions: { view: true, cameras: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assets.setRepository(c.repository);
  const app = express();
  app.use((req, _res, next) => { req.cookies = req.get('x-viewer') ? { ltds_viewer: req.get('x-viewer') } : {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); assets.setRepository(null); assets.setAssetRateLimiter(createAssetRateLimiter()); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...c, get: async (url, headers) => { const response = await fetch(base + url, { headers }); return { status: response.status, body: await response.text() }; } };
}

const TILE = '/session-assets/session/model/fixture/model.glb';
const COOKIE_TILE = '/assets/model/fixture/model.glb';
const PHOTO = '/session-camera-photos/session/model/photo.jpg';

test('asset routes keep their buckets, limits and 429 responses', async (t) => {
  const c = await delivery(t), calls = [];
  let limited = false;
  assets.setAssetRateLimiter({ rateLimited: (bucket, max, overflow) => { assert.equal(overflow, c.repository); calls.push([bucket.replace(/:(::ffff:)?127\.0\.0\.1:/, ':IP:'), max]); return limited; } });
  const hash = auth.hashToken('session'), expected = [[`capability-asset:${hash}:IP:model`, 6000], [`public-asset:${hash}:IP:model`, 6000], [`camera-photo:${hash}:IP:model`, 1200]];
  assert.deepEqual(await c.get(TILE), { status: 200, body: 'mesh' });
  assert.deepEqual(await c.get(COOKIE_TILE, { 'x-viewer': 'session' }), { status: 200, body: 'mesh' });
  assert.equal((await c.get(PHOTO)).status, 404);
  assert.deepEqual(calls, expected);
  assert.equal((await c.get(COOKIE_TILE)).status, 403, 'a request without a capability is not counted');
  assert.equal(calls.length, 3);
  limited = true;
  assert.deepEqual(await c.get(TILE), { status: 429, body: '{"error":"too many asset requests"}' });
  assert.deepEqual(await c.get(COOKIE_TILE, { 'x-viewer': 'session' }), { status: 429, body: '{"error":"too many asset requests"}' });
  assert.deepEqual(await c.get(PHOTO), { status: 429, body: '{"error":"too many photo requests"}' });
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM abuse_windows').get().n, 0, 'asset traffic no longer writes the database');
});

test('the real limit denies the 1201st photo request in a window', async (t) => {
  const c = await delivery(t);
  let at = 1000;
  assets.setAssetRateLimiter(createAssetRateLimiter({ now: () => at }));
  for (let index = 0; index < 1200; index += 1) assert.equal((await c.get(PHOTO)).status, 404);
  assert.equal((await c.get(PHOTO)).status, 429);
  assert.equal((await c.get(TILE)).status, 200, 'photos and tiles are counted separately');
  at += WINDOW - 1; assert.equal((await c.get(PHOTO)).status, 429);
  at += 1; assert.equal((await c.get(PHOTO)).status, 404);
});

test('a held SQLite write lock does not delay or fail asset requests', async (t) => {
  const c = await delivery(t);
  assert.equal((await c.get(TILE)).status, 200);
  const writer = new DatabaseSync(c.file);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    for (let index = 0; index < 20; index += 1) assert.deepEqual(await c.get(TILE), { status: 200, body: 'mesh' });
    assert.deepEqual(await c.get(COOKIE_TILE, { 'x-viewer': 'session' }), { status: 200, body: 'mesh' });
    assert.equal((await c.get(PHOTO)).status, 404);
    assert.ok(performance.now() - started < 4500, 'no request waited for the lock');
    // Control: the lock is really held, so anything that writes still waits for it.
    c.database.exec('PRAGMA busy_timeout=50');
    assert.throws(() => c.repository.rateLimited('share-unlock:x', 8, WINDOW), /locked/);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
});

test('credential limits stay in SQLite and survive a restart', (t) => {
  const { file, repository } = fixture(t);
  assert.equal(repository.rateLimited('share-unlock:token:ip', 1, WINDOW), false);
  assert.equal(repository.rateLimited('share-unlock:token:ip', 1, WINDOW), true);
  const reopened = openDatabase(file);
  try { assert.equal(new ViewerRepository(reopened).rateLimited('share-unlock:token:ip', 1, WINDOW), true); } finally { reopened.close(); }
});
