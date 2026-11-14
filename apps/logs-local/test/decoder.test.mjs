// The in-process decoder: keyless first boot makes no claim and burns nothing; the key file lives only in scratch
// while running; the reviewed runner works through the LocalClient against SQLite and the local store.
// Synthetic rows and a fake parser only; no DJI calls, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { FsR2 } from '../src/fs-r2.mjs';
import { createDecoderSupervisor, createLocalClient } from '../src/decoder.mjs';
import { decodeOne } from '../../logs-decoder/src/runner.mjs';
import { ParserError } from '../../logs-decoder/src/parser.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-decoder-'));
  const db = new SqliteD1(':memory:');
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  const bucket = new FsR2(path.join(dir, 'objects'), { durableBase: dir, statfs: () => ({ bavail: 1e9, bsize: 4096 }) });
  t.after(() => { bucket.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.prepare("INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES ('dev-1', 'staff-beau', 'DJI RC PLUS 2', 'h', 'staff-beau', ?)")
    .bind(new Date().toISOString()).run();
  const raw = Buffer.from('synthetic raw log');
  await bucket.put(`raw/${sha(raw)}.txt`, raw);
  await db.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, 'DJIFlightRecord_1.txt', ?, 'controller', 'dev-1', 'staff-beau', ?)`).bind(sha(raw), raw.length, `raw/${sha(raw)}.txt`, new Date().toISOString()).run();
  const row = () => db.prepare('SELECT parse_status, parse_attempts, lease_reclaims, attempt_token, error_code, next_attempt_at FROM raw_logs').first();
  return { dir, db, bucket, env: { LOGS_DB: db, LOGS_BUCKET: bucket }, raw, row, work: path.join(dir, 'work') };
}

test('keyless first boot: waiting_for_key, no claim, no lease, no attempt or reclaim counted', async t => {
  const { env, row, work } = await harness(t);
  const before = await row();
  let runnerCalls = 0;
  const supervisor = createDecoderSupervisor({ env, readKey: () => '', workRoot: work, parserBinary: '/nope', runner: async () => { runnerCalls++; } });
  assert.equal(await supervisor.start(), 'waiting_for_key');
  assert.equal(supervisor.state, 'waiting_for_key');
  assert.equal(runnerCalls, 0);
  assert.deepEqual(await row(), before, 'the queued original is untouched');
  assert.equal(before.parse_attempts, 0);
  assert.equal(fs.existsSync(path.join(work, '.dji-api-key')), false);
  for (const blank of ['   ', '\n']) {
    const again = createDecoderSupervisor({ env, readKey: () => blank, workRoot: work, parserBinary: '/nope', runner: async () => { runnerCalls++; } });
    assert.equal(await again.start(), 'waiting_for_key');
  }
  assert.equal(runnerCalls, 0);
});

test('a key with no parser binary does not claim either', async t => {
  const { env, row, work } = await harness(t);
  const before = await row();
  const supervisor = createDecoderSupervisor({ env, readKey: () => 'k'.repeat(32), workRoot: work, parserBinary: path.join(work, 'missing-binary'),
    runner: async () => { throw new Error('must not run'); } });
  assert.equal(await supervisor.start(), 'parser_unavailable');
  assert.deepEqual(await row(), before);
});

test('with a key: running, key only in a 0600 scratch file while running; reload picks up a removed key', async t => {
  const { env, work } = await harness(t);
  let key = 'k'.repeat(32), seenSignal;
  const supervisor = createDecoderSupervisor({ env, readKey: () => key, workRoot: work, parserBinary: 'unused', parser: async () => ({}),
    runner: ({ signal }) => { seenSignal = signal; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
  assert.equal(await supervisor.start(), 'running');
  const keyFile = path.join(work, '.dji-api-key');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  key = '';
  assert.equal(await supervisor.reload(), 'waiting_for_key');
  assert.equal(seenSignal.aborted, true);
  assert.equal(fs.existsSync(keyFile), false, 'the key copy is removed on stop');
});

test('the reviewed runner works through the LocalClient: a permanent parser error fails the row, a defer burns no attempt', async t => {
  const { env, row, work } = await harness(t);
  fs.mkdirSync(work, { recursive: true });
  const client = createLocalClient(env, { runnerId: 'local-test' });
  const lease = await client.claim(randomUUID());
  assert.ok(lease, 'claimed through the in-process contract');
  assert.equal((await row()).parse_status, 'leased');
  const deferred = await decodeOne(lease, { client, workRoot: work, parser: async () => { throw new ParserError('defer', 'keychain_unavailable'); } });
  assert.equal(deferred, 'defer:keychain_unavailable');
  const afterDefer = await row();
  assert.deepEqual([afterDefer.parse_status, afterDefer.parse_attempts, afterDefer.error_code], ['needs_parse', 0, 'keychain_unavailable']);
  assert.ok(afterDefer.next_attempt_at);
  await env.LOGS_DB.prepare('UPDATE raw_logs SET next_attempt_at = NULL').run();
  const again = await client.claim(randomUUID());
  const failed = await decodeOne(again, { client, workRoot: work, parser: async () => { throw new ParserError('fail', 'corrupt_log'); } });
  assert.equal(failed, 'fail:corrupt_log');
  const final = await row();
  assert.deepEqual([final.parse_status, final.error_code], ['failed', 'corrupt_log']);
  assert.deepEqual(fs.readdirSync(work).filter(name => name.startsWith('job-')), [], 'scratch cleaned');
});
