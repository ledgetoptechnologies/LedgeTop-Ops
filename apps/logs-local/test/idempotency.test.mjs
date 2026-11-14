// Idempotency with transactional receipts: the operation's first write and its receipt commit together, so a
// pending record proves nothing committed and a committed record proves the effect happened. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteD1, ReceiptFenceError } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { createIdempotency, IdempotencyError, IDEMPOTENCY } from '../src/idempotency.mjs';
import { LogsError } from '../../logs/src/worker/errors.mjs';

const T = Date.parse('2026-11-14T06:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = { identity: 'staff-proxy', actorId: 'staff-beau', operation: 'revoke-device', scope: 'dev-1', key: 'k'.repeat(24), request: { deviceId: 'dev-1' } };

function open(db) {
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  db.transaction(raw => raw.exec('CREATE TABLE IF NOT EXISTS effects (n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)'));
  return db;
}
function memoryDb(t) { const db = open(new SqliteD1(':memory:')); t.after(() => db.close()); return db; }
const effects = async db => (await db.prepare('SELECT COUNT(*) AS n FROM effects').first()).n;
const states = async db => (await db.prepare('SELECT state FROM idempotency_records ORDER BY state').all()).results.map(r => r.state);
/** A business operation with one real write, optionally failing after it. */
const write = (db, label, after) => async () => {
  await db.prepare('INSERT INTO effects (label) VALUES (?)').bind(label).run();
  if (after) after();
  return { label };
};

test('same key and request replays; a different request conflicts; another actor or operation is a separate record', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  assert.deepEqual(await once(scope, write(db, 'a')), { label: 'a' });
  assert.deepEqual(await once(scope, write(db, 'again')), { label: 'a' }, 'replayed');
  assert.equal(await effects(db), 1);
  await assert.rejects(once({ ...scope, request: { deviceId: 'dev-2' } }, write(db, 'x')), err => err.code === 'idempotency_conflict');
  await once({ ...scope, actorId: 'staff-kollin' }, write(db, 'k'));
  await once({ ...scope, operation: 'decide-sign-in' }, write(db, 'd'));
  assert.equal(await effects(db), 3);
  await assert.rejects(once({ ...scope, key: 'short' }, write(db, 'x')), err => err.code === 'idempotency_key_invalid');
});

test('the receipt commits in the same transaction as the first write (batch or run)', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  let seen;
  await once(scope, async () => {
    await db.batch([db.prepare('INSERT INTO effects (label) VALUES (?)').bind('batch')]);
    seen = await states(db);
    return 'ok';
  });
  assert.deepEqual(seen, ['committed'], 'the receipt landed with the batch');
  let beforeWrite, afterWrite;
  await once({ ...scope, key: 'r'.repeat(24) }, async () => {
    await db.prepare('SELECT 1').run();
    beforeWrite = await states(db);
    await db.prepare('UPDATE effects SET label = ? WHERE label = ?').bind('x', 'nothing').run();
    afterWrite = await states(db);
    return 'ok';
  });
  assert.deepEqual(beforeWrite, ['done', 'pending'], 'a read does not commit the receipt');
  assert.deepEqual(afterWrite, ['committed', 'done'], 'a run() write commits the receipt even when it changes no rows');
});

test('an error after the write leaves "committed": the effect is never run again', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  await assert.rejects(once(scope, write(db, 'a', () => { throw new Error('connection lost after commit'); })), /connection lost/);
  assert.deepEqual(await states(db), ['committed']);
  await assert.rejects(once(scope, write(db, 'again')), err => err instanceof IdempotencyError && err.code === 'idempotency_completed');
  assert.equal(await effects(db), 1);
});

test('an error before any write releases the claim; the retry runs the operation once', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  await assert.rejects(once(scope, async () => { throw new Error('directory timeout'); }), /directory timeout/);
  assert.deepEqual(await states(db), []);
  assert.deepEqual(await once(scope, write(db, 'retry')), { label: 'retry' });
  assert.equal(await effects(db), 1);
});

test('a business refusal is stored and replayed', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  await assert.rejects(once(scope, async () => { throw new LogsError('device_not_found', 404, 'No such controller.'); }), err => err.code === 'device_not_found');
  await assert.rejects(once(scope, write(db, 'x')), err => err instanceof LogsError && err.code === 'device_not_found');
  assert.equal(await effects(db), 0);
});

test('a pending attempt that wrote nothing is taken over after the window; its late first write is fenced out', async t => {
  let now = T;
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => now });
  let releaseA;
  const slowA = once(scope, async () => { await new Promise(resolve => { releaseA = resolve; }); return write(db, 'A')(); });
  await tick();
  await assert.rejects(once(scope, write(db, 'early')), err => err.code === 'idempotency_in_progress');
  now += IDEMPOTENCY.inProgressMs + 1;
  assert.deepEqual(await once(scope, write(db, 'B')), { label: 'B' }, 'B took over: A had committed nothing');
  releaseA();
  await assert.rejects(slowA, err => err.code === 'idempotency_superseded', 'the late first write failed its fence and rolled back');
  assert.deepEqual((await db.prepare('SELECT label FROM effects').all()).results, [{ label: 'B' }], 'exactly one effect');
  assert.deepEqual(await once(scope, write(db, 'C')), { label: 'B' });
});

test('a receipt that cannot be written rolls the whole write back', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  await assert.rejects(once(scope, async () => {
    // Simulate another attempt owning the record (no write-receipt context for this maintenance statement).
    db.transaction(raw => raw.prepare("UPDATE idempotency_records SET attempt = 'other'").run());
    return write(db, 'lost')();
  }), err => err.code === 'idempotency_superseded');
  assert.equal(await effects(db), 0);
  void ReceiptFenceError;
});

test('only finished answers expire (body dropped, never re-run); committed records stay', async t => {
  let now = T;
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => now });
  await once(scope, write(db, 'a'));
  const crashed = { ...scope, key: 'c'.repeat(24) };
  await assert.rejects(once(crashed, write(db, 'c', () => { throw new Error('lost'); })), /lost/);
  now += 7 * IDEMPOTENCY.ttlMs;
  await assert.rejects(once(scope, write(db, 'again')), err => err.code === 'idempotency_expired');
  await assert.rejects(once(crashed, write(db, 'again')), err => err.code === 'idempotency_completed');
  assert.equal(await effects(db), 2);
});

test('an answer too large to store is recorded as completed and never recomputed', async t => {
  const db = memoryDb(t);
  const once = createIdempotency(db, { now: () => T });
  const big = await once(scope, async () => { await write(db, 'big')(); return 'x'.repeat(IDEMPOTENCY.maxResultBytes + 1); });
  assert.equal(big.length, IDEMPOTENCY.maxResultBytes + 1);
  await assert.rejects(once(scope, write(db, 'again')), err => err.code === 'idempotency_result_unavailable');
  assert.equal(await effects(db), 1);
});

test('the open-record cap is atomic across connections, and known keys still answer at full cap', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-idem-'));
  const a = open(new SqliteD1(path.join(dir, 'logs.sqlite'))), b = new SqliteD1(path.join(dir, 'logs.sqlite'));
  t.after(() => { a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const onceA = createIdempotency(a, { now: () => T }), onceB = createIdempotency(b, { now: () => T });
  const known = { ...scope, key: 'known-key-0000000000' };
  await onceA(known, write(a, 'kept'));
  for (let i = 0; i < IDEMPOTENCY.maxOpen - 1; i++)
    await a.prepare("INSERT INTO idempotency_records (id, fingerprint, state, attempt, result, created_at, expires_at) VALUES (?, 'f', 'pending', 'a', NULL, ?, 0)").bind(`open-${i}`, T).run();
  const hold = [], refused = [];
  const calls = Array.from({ length: 8 }, (_, i) => (i % 2 ? onceA : onceB)({ ...scope, key: `cross-key-${String(i).padStart(10, '0')}` },
    () => new Promise(resolve => hold.push(resolve))).catch(error => refused.push(error.code)));
  while (hold.length + refused.length < 8) await tick();
  assert.deepEqual([hold.length, refused.filter(c => c === 'idempotency_backlog').length], [1, 7]);
  hold[0]('done');
  await Promise.all(calls);
  assert.deepEqual(await onceB(known, write(b, 'rerun')), { label: 'kept' });
});
