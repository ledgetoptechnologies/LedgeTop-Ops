// The R2-shaped local object store: R2 semantics, originals forever, durable ACK ordering, crash points,
// conditional races, adversarial keys and disk-full backpressure. Temp dirs only; synthetic bytes; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FsR2, ObjectStoreError, OBJECT_LIMITS } from '../src/fs-r2.mjs';
import { LIMITS as SERVICE_LIMITS } from '../../logs/src/worker/service.mjs';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate } from '../src/migrations.mjs';
import { fileURLToPath } from 'node:url';
import { handleDeviceRequest } from '../../logs/src/worker/device-routes.mjs';
import * as device from '../../logs/src/worker/device.mjs';
const { DEVICE_LIMITS } = device;

const sha = data => createHash('sha256').update(data).digest('hex');
const plenty = () => ({ bavail: 1e7, bsize: 4096 });

/** A temp store root; every store opened through open() is closed before the dir is removed. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-objects-'));
  const opened = [];
  t.after(() => { for (const s of opened) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, open: (options = {}) => { const s = new FsR2(dir, { statfs: plenty, ...options }); opened.push(s); return s; } };
}
function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
}
const blobCount = dir => filesUnder(path.join(dir, 'blobs')).length;
const tmpCount = dir => filesUnder(path.join(dir, 'tmp')).length;

test('put/get/head/list follow R2 shapes; the etag is the body SHA-256', async t => {
  const { open } = scratch(t);
  const store = open();
  t.diagnostic(`platform ${process.platform} node ${process.version} durability ${JSON.stringify(store.durability)}`);
  const put = await store.put('tracks/a.json.gz', 'hello', { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { flightId: 'f1' } });
  assert.equal(put.etag, sha('hello'));
  assert.equal(put.httpEtag, `"${sha('hello')}"`);
  assert.equal(put.size, 5);
  assert.ok(put.uploaded instanceof Date);
  const got = await store.get('tracks/a.json.gz');
  assert.equal(await got.text(), 'hello');
  assert.equal(got.bodyUsed, true);
  await assert.rejects(got.text(), /already been used/);
  assert.deepEqual(got.httpMetadata, { contentType: 'application/json', contentEncoding: 'gzip' });
  assert.deepEqual(got.customMetadata, { flightId: 'f1' });
  const headers = new Headers();
  got.writeHttpMetadata(headers);
  assert.equal(headers.get('content-encoding'), 'gzip');
  assert.equal(new Uint8Array(await (await store.get('tracks/a.json.gz')).arrayBuffer()).length, 5);
  const streamed = await store.get('tracks/a.json.gz');
  assert.equal(Buffer.concat(await Array.fromAsync(streamed.body)).toString(), 'hello');
  assert.equal((await store.head('tracks/a.json.gz')).etag, sha('hello'));
  assert.equal(await store.head('missing'), null);
  assert.equal(await store.get('missing'), null);
  for (const key of ['tracks/b', 'tracks/c', 'other/d']) await store.put(key, key);
  const page = await store.list({ prefix: 'tracks/', limit: 2 });
  assert.deepEqual(page.objects.map(o => o.key), ['tracks/a.json.gz', 'tracks/b']);
  assert.equal(page.truncated, true);
  const rest = await store.list({ prefix: 'tracks/', limit: 2, cursor: page.cursor });
  assert.deepEqual([rest.objects.map(o => o.key), rest.truncated], [['tracks/c'], false]);
  const ignored = await store.get('tracks/b');
  await ignored.cancel();
});

test('bodies of every supported type are stored byte-for-byte', async t => {
  const store = scratch(t).open();
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const bodies = { string: 'text', arrayBuffer: bytes.buffer.slice(0), view: bytes.subarray(1, 3), blob: new Blob([bytes]),
    stream: new Blob([bytes]).stream(), node: fs.createReadStream(fileURLToPath(import.meta.url)), empty: null };
  for (const [name, body] of Object.entries(bodies)) await store.put(`t/${name}`, body);
  assert.deepEqual([...await (await store.get('t/view')).bytes()], [1, 2]);
  assert.deepEqual([...await (await store.get('t/stream')).bytes()], [0, 1, 2, 255]);
  assert.equal((await store.head('t/node')).etag, sha(fs.readFileSync(fileURLToPath(import.meta.url))));
  assert.equal((await store.head('t/empty')).size, 0);
  await assert.rejects(store.put('t/bad', { nope: true }), err => err.code === 'invalid_body');
});

test('adversarial keys never become paths; nothing is written outside the store', async t => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-objects-outer-'));
  const root = path.join(outer, 'store');
  const store = new FsR2(root, { statfs: plenty });
  t.after(() => { store.close(); fs.rmSync(outer, { recursive: true, force: true }); });
  const keys = ['../escape', '../../etc/passwd', '/abs/path', 'C:\\Windows\\x', 'raw/../../x', 'a/./b', '..', 'ünïcødé/ключ', 'x'.repeat(1024)];
  for (const key of keys) await store.put(key, key);
  for (const key of keys) assert.equal(await (await store.get(key)).text(), key);
  assert.deepEqual(fs.readdirSync(outer), ['store'], 'nothing outside the root');
  assert.deepEqual(fs.readdirSync(root).sort(), ['blobs', 'index.sqlite', 'index.sqlite-shm', 'index.sqlite-wal', 'tmp'].sort());
  for (const file of filesUnder(path.join(root, 'blobs'))) assert.match(path.basename(file), /^[0-9a-f-]{36}$/, 'blob names are uuids only');
  for (const bad of ['', 'x'.repeat(1025), 'a\0b', 7, null]) await assert.rejects(store.put(bad, 'x'), err => err.code === 'invalid_key');
  await assert.rejects(store.put('k', 'x', { customMetadata: { big: 'y'.repeat(3000) } }), err => err.code === 'metadata_too_large');
});

test('originals under raw/ are create-only: identical bytes dedupe, different bytes and deletes are refused', async t => {
  const { dir, open } = scratch(t);
  const store = open();
  const first = await store.put('raw/a.txt', 'original', { customMetadata: { source: 'controller' } });
  const again = await store.put('raw/a.txt', 'original', { customMetadata: { source: 'someone-else' } });
  assert.deepEqual([again.version, again.uploaded.getTime(), again.customMetadata], [first.version, first.uploaded.getTime(), { source: 'controller' }],
    'a duplicate returns the stored original unchanged (first custody wins)');
  const withSha = await store.put('raw/a.txt', 'original', { sha256: sha('original') });
  assert.equal(withSha.version, first.version);
  await assert.rejects(store.put('raw/a.txt', 'different'), err => err instanceof ObjectStoreError && err.code === 'immutable_object' && err.status === 409);
  await assert.rejects(store.put('raw/a.txt', 'different', { onlyIf: { etagMatches: first.etag } }), err => err.code === 'immutable_object',
    'a matching etag CAS still cannot replace an original');
  await assert.rejects(store.delete('raw/a.txt'), err => err.code === 'immutable_object');
  await assert.rejects(store.delete(['tracks/x', 'raw/a.txt']), err => err.code === 'immutable_object');
  assert.equal(await (await store.get('raw/a.txt')).text(), 'original');
  assert.equal(blobCount(dir), 1, 'refused writes leave no blob behind');
  assert.equal(tmpCount(dir), 0);
  await store.put('tracks/t', 'one');
  await store.delete('tracks/t');
  assert.equal(await store.head('tracks/t'), null);
  assert.equal(blobCount(dir), 1, 'a deleted mutable object releases its blob');
});

test('conditional puts: create-only and etag CAS return null without leaving bytes behind', async t => {
  const { dir, open } = scratch(t);
  const store = open();
  const v1 = await store.put('tracks/k', 'v1');
  assert.equal(await store.put('tracks/k', 'v2', { onlyIf: { etagDoesNotMatch: '*' } }), null);
  assert.equal(await store.put('tracks/k', 'v2', { onlyIf: { etagMatches: sha('nope') } }), null);
  assert.equal(await store.put('tracks/k', 'v2', { onlyIf: new Headers({ 'if-match': '"' + sha('nope') + '"' }) }), null);
  assert.equal(await store.put('tracks/new', 'x', { onlyIf: { etagMatches: '*' } }), null, 'etagMatches needs an existing object');
  const v2 = await store.put('tracks/k', 'v2', { onlyIf: { etagMatches: v1.httpEtag } });
  assert.equal(v2.etag, sha('v2'));
  assert.equal(await (await store.get('tracks/k')).text(), 'v2');
  assert.equal(blobCount(dir), 1, 'the replaced body is released; failed conditions wrote nothing');
  const conditional = await store.get('tracks/k', { onlyIf: { etagDoesNotMatch: v2.etag } });
  assert.equal(conditional.etag, v2.etag);
  assert.equal('body' in conditional, false, 'a failed get condition returns metadata only');
  await assert.rejects(store.get('tracks/k', { range: { offset: 0 } }), err => err.code === 'range_unsupported');
});

test('concurrent create-only puts across two store instances: exactly one winner, no stray blobs', async t => {
  const { dir, open } = scratch(t);
  const a = open(), b = open();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    (i % 2 ? a : b).put('tracks/race', `body-${i}`, { onlyIf: { etagDoesNotMatch: '*' } })));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal((await a.head('tracks/race')).etag, winners[0].etag);
  assert.equal(blobCount(dir), 1);
  assert.equal(tmpCount(dir), 0);
  // Same-key originals racing with identical bytes all resolve to the single stored original.
  const same = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).put('raw/same', 'identical')));
  assert.equal(new Set(same.map(o => o.version)).size, 1);
  // Racing different bytes for one original: one stored, the rest refused, never replaced.
  const mixed = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).put('raw/contested', `v${i}`)));
  assert.equal(mixed.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(mixed.filter(r => r.status === 'rejected').every(r => r.reason.code === 'immutable_object'));
  assert.equal(blobCount(dir), 3);
});

test('a crash at any step before commit leaves no row and nothing acknowledged; a retry stores once', async t => {
  for (const step of ['afterBodySync', 'afterRename', 'afterDirSync', 'beforeCommit']) {
    const { dir, open } = scratch(t);
    let armed = true;
    const store = open({ faults: { [step]: () => { if (armed) { armed = false; throw new Error(`crash ${step}`); } } } });
    await assert.rejects(store.put('raw/r.txt', 'payload'), new RegExp(`crash ${step}`));
    assert.equal(await store.head('raw/r.txt'), null, `${step}: no row`);
    assert.equal(blobCount(dir), 0, `${step}: the unacknowledged body is not kept as an object`);
    assert.equal(tmpCount(dir), 0, `${step}: no partial file left`);
    const stored = await store.put('raw/r.txt', 'payload');
    assert.equal(stored.etag, sha('payload'));
    assert.equal(blobCount(dir), 1);
  }
});

test('a lost ACK after commit is safe: the bytes are durable and the retry returns the same original', async t => {
  const { dir, open } = scratch(t);
  let armed = true;
  const store = open({ faults: { afterCommit: () => { if (armed) { armed = false; throw new Error('connection dropped'); } } } });
  await assert.rejects(store.put('raw/l.txt', 'kept'), /connection dropped/);
  const fresh = new DatabaseSync(path.join(dir, 'index.sqlite'));
  try {
    assert.equal(fresh.prepare('SELECT etag FROM objects WHERE key = ?').get('raw/l.txt').etag, sha('kept'), 'committed and visible to another connection');
  } finally { fresh.close(); }
  const retry = await store.put('raw/l.txt', 'kept');
  assert.equal(retry.etag, sha('kept'));
  assert.equal(blobCount(dir), 1, 'the retry did not store a second copy');
});

test('a hard crash between rename and commit leaves an unreferenced blob that audit counts and nothing deletes', async t => {
  const { dir, open } = scratch(t);
  const store = open();
  await store.put('raw/keep.txt', 'keep');
  // Simulate a process that died after renaming its body into blobs/ but before committing (no cleanup ran).
  const orphan = '0f'.padEnd(36, 'a');
  fs.mkdirSync(path.join(dir, 'blobs', '0f'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blobs', '0f', orphan), 'never acknowledged');
  fs.writeFileSync(path.join(dir, 'tmp', 'fresh.part'), 'in progress elsewhere');
  store.close();
  const reopened = open();
  assert.deepEqual(await reopened.audit(), { objects: 1, bytes: 4, unreferencedBlobs: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'blobs', '0f', orphan)), 'never deleted automatically');
  assert.ok(fs.existsSync(path.join(dir, 'tmp', 'fresh.part')), 'a recent tmp file may belong to another writer and is kept');
  assert.equal(await (await reopened.get('raw/keep.txt')).text(), 'keep');
});

test('size cap, checksum mismatch and low disk refuse before anything is stored', async t => {
  const { dir, open } = scratch(t);
  const small = open({ limits: { maxObjectBytes: 8 } });
  await assert.rejects(small.put('raw/big', '123456789'), err => err.code === 'object_too_large' && err.status === 413);
  await assert.rejects(small.put('raw/sum', 'abc', { sha256: sha('abd') }), err => err.code === 'checksum_mismatch' && err.status === 422);
  await assert.rejects(small.put('raw/sum', 'abc', { sha256: 'not-hex' }), err => err.code === 'invalid_checksum');
  let free = 10 * 1024 ** 3;
  const full = open({ statfs: () => ({ bavail: free / 4096, bsize: 4096 }), limits: { minFreeBytes: 1024 ** 3 } });
  await full.put('raw/ok', 'fits');
  free = 512 * 1024 ** 2;
  await assert.rejects(full.put('raw/later', 'no room'), err => err.code === 'storage_full' && err.status === 507);
  assert.equal(await full.head('raw/later'), null);
  assert.equal(await (await full.get('raw/ok')).text(), 'fits', 'backpressure never evicts what is stored');
  assert.equal(blobCount(dir), 1);
  assert.equal(tmpCount(dir), 0);
});

test('a closed store refuses work', async t => {
  const store = scratch(t).open();
  store.close();
  store.close();
  await assert.rejects(store.put('k', 'v'), err => err.code === 'store_closed');
});

test('the Logs controller upload runs unchanged on SQLite + the local store, and dedupes by verified SHA', async t => {
  const { dir, open } = scratch(t);
  const bucket = open();
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  const env = { LOGS_DB: db, LOGS_BUCKET: bucket, OPS_DIRECTORY: {
    async resolvePilotUsername(u) { return u === 'bkoltz' ? { staffId: 'staff-beau', eligibilityRevision: 1 } : null; },
    async getPilotDeviceAuthority(id) { return id === 'staff-beau' ? { eligible: true, revision: 1 } : { eligible: false, revision: null }; },
    async isActiveStaff(id) { return id === 'staff-beau'; },
  } };
  device.clearActiveCache();
  const call = async (method, route, { body, raw, token, poll } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (poll) headers['X-Poll-Token'] = poll;
    const init = { method, headers };
    if (raw !== undefined) { init.body = raw; headers['Content-Length'] = String(raw.byteLength); }
    else if (body !== undefined) { init.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const response = await handleDeviceRequest(new Request(`https://logs.example.test${route}`, init), env);
    return { status: response.status, body: await response.json() };
  };
  const beau = { staffId: 'staff-beau', permissions: ['flight_logs.view'] };
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', model: 'DJI RC PLUS 2' } });
  await device.decideSignIn(env, beau, { signInId: (await device.pendingSignIns(env, beau)).items[0].id, approve: true });
  const { deviceToken } = (await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })).body;
  const log = new TextEncoder().encode('synthetic flight log bytes');
  const hash = sha(log);
  const first = await call('PUT', `/api/v1/device/logs/${hash}?name=DJIFlightRecord_test.txt`, { raw: log, token: deviceToken });
  assert.deepEqual([first.status, first.body], [201, { stored: true, duplicate: false }]);
  const again = await call('PUT', `/api/v1/device/logs/${hash}?name=DJIFlightRecord_test.txt`, { raw: log, token: deviceToken });
  assert.deepEqual(again.body, { stored: true, duplicate: true });
  const wrong = await call('PUT', `/api/v1/device/logs/${sha('other')}`, { raw: log, token: deviceToken });
  assert.equal(wrong.status, 422, 'the SHA is verified at the upload boundary');
  const stored = await bucket.get(`raw/${hash}.txt`);
  assert.deepEqual([...await stored.bytes()], [...log]);
  assert.deepEqual(stored.customMetadata, { sha256: hash, source: 'controller' });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM raw_logs').first()).n, 1);
  assert.equal(blobCount(dir), 1);
});

test('short writes are completed and a stalled disk is refused', async t => {
  const { dir, open } = scratch(t);
  const oneByte = open({ faults: { write: (h, c, o) => h.write(c, o, 1) } });
  const body = 'written one byte at a time';
  assert.equal((await oneByte.put('tracks/short', body)).size, body.length);
  assert.equal(await (await oneByte.get('tracks/short')).text(), body);
  const stalled = open({ faults: { write: async () => ({ bytesWritten: 0 }) } });
  await assert.rejects(stalled.put('raw/stall', 'abc'), err => err.code === 'write_stalled');
  assert.equal(await stalled.head('raw/stall'), null);
  assert.equal(blobCount(dir), 1);
  assert.equal(tmpCount(dir), 0);
});

test('a new shard directory is made durable in blobs/ before its first object, then the shard, then tmp/', async t => {
  const { dir, open } = scratch(t);
  const synced = [];
  const store = open({ faults: { syncDir: ({ dir: d }) => synced.push(path.relative(dir, d).split(path.sep).join('/')) } });
  await store.put('tracks/one', 'x');
  assert.equal(synced.length, 3);
  assert.equal(synced[0], 'blobs', 'the new shard entry is synced in its parent first');
  assert.match(synced[1], /^blobs\/[0-9a-f]{2}$/);
  assert.equal(synced[2], 'tmp');
  await assert.rejects(open({ faults: { syncDir: () => { throw new Error('fsync failed'); } } }).put('raw/nosync', 'y'), /fsync failed/);
  assert.equal(await store.head('raw/nosync'), null, 'a failed directory sync is never acknowledged');
});

test('the default object cap never lowers what the Logs code already accepts', () => {
  assert.ok(OBJECT_LIMITS.maxObjectBytes >= DEVICE_LIMITS.rawLogBytes, 'controller raw logs');
  assert.ok(OBJECT_LIMITS.maxObjectBytes >= SERVICE_LIMITS.telemetryBytes, 'imported tracks');
});

test('a supplied SHA never stands in for the body: a different body claiming an existing original is refused', async t => {
  const { dir, open } = scratch(t);
  const store = open();
  const original = await store.put('raw/o.txt', 'original');
  await assert.rejects(store.put('raw/o.txt', 'tampered', { sha256: sha('original') }), err => err.code === 'checksum_mismatch' && err.status === 422);
  assert.equal(await (await store.get('raw/o.txt')).text(), 'original');
  assert.equal((await store.head('raw/o.txt')).version, original.version);
  assert.equal(blobCount(dir), 1);
});

test('a writer that did not create a shard still syncs blobs/ before acknowledging (creator paused before its sync)', async t => {
  const { dir, open } = scratch(t);
  let release, paused;
  const pausedAt = new Promise(resolve => { paused = resolve; });
  const creator = open({ faults: { blobName: () => 'ab000000-0000-4000-8000-000000000001',
    afterShardMkdir: () => { paused(); return new Promise(resolve => { release = resolve; }); } } });
  const synced = [];
  const other = open({ faults: { blobName: () => 'ab000000-0000-4000-8000-000000000002',
    syncDir: ({ dir: d }) => synced.push(path.relative(dir, d).split(path.sep).join('/')) } });
  const first = creator.put('raw/creator.txt', 'created the shard');
  await pausedAt;
  assert.ok(fs.existsSync(path.join(dir, 'blobs', 'ab')), 'the creator made the shard and is paused before syncing blobs/');
  const acked = await other.put('raw/other.txt', 'same shard');
  assert.equal(acked.etag, sha('same shard'));
  assert.deepEqual(synced, ['blobs', 'blobs/ab', 'tmp'], 'the non-creator synced blobs/ before its own ACK');
  release();
  assert.equal((await first).etag, sha('created the shard'));
});

test('opening a store syncs its directories and every ancestor up to the durable base, whoever created them', t => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-objects-base-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'flight-logs', 'objects');
  for (let i = 0; i < 2; i++) {
    const synced = [];
    const store = new FsR2(root, { statfs: plenty, durableBase: outer, faults: { syncDirSync: ({ dir }) => synced.push(path.relative(outer, dir).split(path.sep).join('/') || '.') } });
    store.close();
    assert.deepEqual(synced, ['flight-logs/objects/blobs', 'flight-logs/objects/tmp', 'flight-logs/objects', 'flight-logs', '.'],
      i ? 'again on a later open, even though nothing was created' : 'deepest first, up to the durable base');
  }
  assert.throws(() => new FsR2(root, { statfs: plenty, durableBase: path.join(outer, 'elsewhere') }), /outside_durable_base/);
  assert.throws(() => new FsR2(outer, { statfs: plenty, durableBase: outer }), /outside_durable_base/);
});

test('the free-space floor is rechecked while streaming, so a large write stops when the floor is reached', async t => {
  const { dir, open } = scratch(t);
  let checks = 0;
  const store = open({ limits: { minFreeBytes: 1024 }, statfs: () => ({ bavail: ++checks > 2 ? 0 : 1e9, bsize: 1 }) });
  const chunks = Array.from({ length: 4 }, () => new Uint8Array(1024 * 1024));
  await assert.rejects(store.put('raw/stream', new Blob(chunks).stream()), err => err.code === 'storage_full');
  assert.ok(checks >= 3, 'checked again mid-stream');
  assert.equal(await store.head('raw/stream'), null);
  assert.equal(blobCount(dir), 0);
  assert.equal(tmpCount(dir), 0);
});
