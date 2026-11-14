// Snapshot import: checked before writing, add-only, exact sealed keychains with provenance, objects before rows,
// resumable, an explicit controller sign-in choice, and aggregate-only receipts. Synthetic rows and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { FsR2 } from '../src/fs-r2.mjs';
import { readSnapshot, planSnapshot, importSnapshot, packSnapshot, SnapshotError } from '../src/snapshot.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const T0 = '2025-06-01T10:00:00.000Z';
const SECRET_CIPHERTEXT = 'c2VhbGVkLWJ5LWNsb3VkZmxhcmUta2V5LW5vdC1sb2NhbA==';
const TRACK = Buffer.from('synthetic track bytes');
const RAW = Buffer.from('synthetic raw log bytes');

function rows() {
  return {
    aircraft: [{ id: 'ac-1', serial: 'SYNTH-SERIAL-001', model: 'M30T', status: 'active', created_at: T0, updated_at: T0 }],
    flights: [
      { id: 'fl-1', file_hash: 'f'.repeat(64), source_system: 'opendronelog', pilot_id: 'staff-known', pilot_attribution: 'backup_owner',
        aircraft_id: 'ac-1', home_lat: 41.5, home_lon: -90.5, telemetry_points: 3, telemetry_key: 'telemetry/fl-1.json.gz', created_at: T0, updated_at: T0 },
      { id: 'fl-2', file_hash: 'e'.repeat(64), source_system: 'opendronelog', pilot_id: 'unassigned', pilot_attribution: 'backup_owner',
        created_at: T0, updated_at: T0, notes: null },
    ],
    flight_messages: Array.from({ length: 1203 }, (_, i) => ({ flight_id: 'fl-1', seq: i, offset_ms: i * 10, level: 'tip', text: `message ${i}` })),
    keychains: [{ file_hash: 'f'.repeat(64), ciphertext: SECRET_CIPHERTEXT, iv: 'aXYtMTIzNDU2Nzg5', key_version: 1, fetched_at: T0, created_at: T0 }],
    audit_events: [{ id: 'ev-1', actor_id: 'staff-beau', action: 'import_completed', subject: 'import:x', detail: null, at: T0 }],
    devices: [{ id: 'dev-1', pilot_id: 'staff-known', model: 'RC Plus 2', token_hash: 'a'.repeat(64), status: 'active', approved_by: 'staff-beau',
      created_at: T0, eligibility_revision: 4 }],
    raw_logs: [{ sha256: sha(RAW), size_bytes: RAW.length, file_name: 'DJIFlightRecord_1.txt', r2_key: `raw/${sha(RAW)}.txt`, source: 'controller',
      device_id: 'dev-1', pilot_id: 'staff-known', uploaded_at: T0, parse_status: 'needs_parse' }],
  };
}

async function makeSnapshot(t, { mutate, objects = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = rows();
  mutate?.(data);
  fs.mkdirSync(path.join(dir, 'tables'));
  for (const [table, list] of Object.entries(data)) fs.writeFileSync(path.join(dir, 'tables', `${table}.jsonl`), list.map(r => `${JSON.stringify(r)}\n`).join(''));
  if (objects) {
    fs.mkdirSync(path.join(dir, 'objects'));
    fs.writeFileSync(path.join(dir, 'objects', 'track-1'), TRACK);
    fs.writeFileSync(path.join(dir, 'objects', 'raw-1'), RAW);
    fs.writeFileSync(path.join(dir, 'objects.jsonl'), [
      { key: 'telemetry/fl-1.json.gz', file: 'objects/track-1' }, { key: `raw/${sha(RAW)}.txt`, file: 'objects/raw-1' },
    ].map(o => `${JSON.stringify(o)}\n`).join(''));
  }
  await packSnapshot(dir, { label: 'synthetic test snapshot' });
  return dir;
}

function host(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-host-'));
  const db = new SqliteD1(':memory:');
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  const store = new FsR2(path.join(dir, 'objects'), { durableBase: dir, statfs: () => ({ bavail: 1e9, bsize: 4096 }) });
  t.after(() => { store.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, store };
}
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const preserve = { deviceTokens: 'preserve' };

test('imports every table and object exactly, keeps the sealed keychain byte-for-byte with provenance, and receipts hold counts only', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.equal(plan.ok, true);
  assert.equal(plan.tables.flight_messages.inserted, 1203);
  assert.equal(await count(db, 'flights'), 0, 'planning writes nothing');

  const receipt = await importSnapshot(db, store, snapshot, preserve);
  assert.deepEqual(receipt.tables.flights, { rows: 2, inserted: 2, present: 0 });
  assert.deepEqual(receipt.tables.flight_messages, { rows: 1203, inserted: 1203, present: 0 });
  assert.deepEqual(receipt.objects, { listed: 2, stored: 2, present: 0 });
  assert.equal(receipt.keychainsVerified, 1);

  const kc = await db.prepare('SELECT ciphertext, iv, key_version FROM keychains').first();
  assert.deepEqual(kc, { ciphertext: SECRET_CIPHERTEXT, iv: 'aXYtMTIzNDU2Nzg5', key_version: 1 });
  const prov = await db.prepare('SELECT snapshot_id, sealed_by, source_key_version FROM keychain_provenance').first();
  assert.deepEqual(prov, { snapshot_id: snapshot.id, sealed_by: 'source-key', source_key_version: 1 });

  const flight = await db.prepare("SELECT * FROM flights WHERE id = 'fl-1'").first();
  assert.equal(flight.home_lat, 41.5);
  assert.equal(flight.pilot_attribution, 'backup_owner');
  assert.equal((await db.prepare("SELECT pilot_id FROM flights WHERE id = 'fl-2'").first()).pilot_id, 'unassigned', 'unknown owner kept as exported');
  assert.equal((await store.head('telemetry/fl-1.json.gz')).etag, sha(TRACK));
  assert.equal((await db.prepare("SELECT status FROM devices WHERE id = 'dev-1'").first()).status, 'active');

  const text = JSON.stringify(receipt) + JSON.stringify(plan);
  for (const secret of [SECRET_CIPHERTEXT, 'SYNTH-SERIAL-001', '41.5', 'staff-known', 'message 7', 'a'.repeat(64)]) assert.ok(!text.includes(secret), `receipt leaks ${secret}`);
  const audit = await db.prepare("SELECT actor_id, detail FROM audit_events WHERE action = 'snapshot_imported'").first();
  assert.equal(audit.actor_id, 'system:snapshot-import');
  assert.ok(!audit.detail.includes(SECRET_CIPHERTEXT));

  const again = await importSnapshot(db, store, snapshot, preserve);
  assert.equal(again.alreadyCompleted, true);
  assert.equal(await count(db, 'flight_messages'), 1203);
});

test('a file that does not match the manifest is refused before anything is read into the database', async t => {
  const dir = await makeSnapshot(t);
  fs.appendFileSync(path.join(dir, 'tables', 'flights.jsonl'), '\n');
  await assert.rejects(readSnapshot(dir), { code: 'snapshot_checksum' });
  const dir2 = await makeSnapshot(t);
  fs.writeFileSync(path.join(dir2, 'objects', 'raw-1'), 'tampered');
  await assert.rejects(readSnapshot(dir2), { code: 'snapshot_checksum' });
});

test('a row that differs from existing data stops the import before any write; nothing is overwritten', async t => {
  const { db, store } = host(t);
  await db.prepare("INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, created_at, updated_at) VALUES ('fl-2', ?, 'opendronelog', 'staff-other', 'admin_reassigned', ?, ?)")
    .bind('e'.repeat(64), T0, T0).run();
  const snapshot = await readSnapshot(await makeSnapshot(t));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.equal(plan.ok, false);
  assert.equal(plan.tables.flights.conflicts, 1);
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'snapshot_conflicts' });
  assert.equal(await count(db, 'flights'), 1);
  assert.equal(await count(db, 'flight_messages'), 0);
  assert.equal(await store.head('telemetry/fl-1.json.gz'), null, 'objects are not stored either');
  assert.equal((await db.prepare("SELECT pilot_id FROM flights WHERE id = 'fl-2'").first()).pilot_id, 'staff-other');
});

test('a different keychain already stored is a conflict, never replaced', async t => {
  const { db, store } = host(t);
  await db.prepare("INSERT INTO keychains (file_hash, ciphertext, iv, key_version, created_at) VALUES (?, 'local-sealed', 'local-iv', 1, ?)").bind('f'.repeat(64), T0).run();
  const snapshot = await readSnapshot(await makeSnapshot(t));
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'snapshot_conflicts' });
  assert.equal((await db.prepare('SELECT ciphertext FROM keychains').first()).ciphertext, 'local-sealed');
});

test('an immutable original already holding different bytes is a conflict', async t => {
  const { db, store } = host(t);
  await store.put(`raw/${sha(RAW)}.txt`, Buffer.from('other bytes'));
  const snapshot = await readSnapshot(await makeSnapshot(t));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.equal(plan.objects.conflicts, 1);
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'snapshot_conflicts' });
});

test('referenced objects missing from the snapshot are refused unless explicitly accepted', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t, { objects: false }));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.deepEqual([plan.ok, plan.references.missing], [false, 2]);
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'snapshot_conflicts' });
  assert.equal(await count(db, 'flights'), 0);
  const accepted = await importSnapshot(db, store, snapshot, { ...preserve, acceptMissingObjects: true });
  assert.equal(accepted.references.missingAccepted, true);
  assert.equal(await count(db, 'flights'), 2);
});

test('controller sign-ins need an explicit choice; revoke imports devices revoked', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t));
  await assert.rejects(planSnapshot(db, store, snapshot, {}), { code: 'device_tokens_required' });
  await assert.rejects(importSnapshot(db, store, snapshot, {}), { code: 'device_tokens_required' });
  await importSnapshot(db, store, snapshot, { deviceTokens: 'revoke' });
  const device = await db.prepare("SELECT status, revoked_by, token_hash FROM devices WHERE id = 'dev-1'").first();
  assert.deepEqual([device.status, device.revoked_by], ['revoked', 'system:snapshot-import']);
  assert.equal(device.token_hash, 'a'.repeat(64), 'the hash is kept; the device just cannot sign in');
});

test('an interrupted import resumes to the same result without duplicates, and keeps its controller choice', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t));
  let chunks = 0;
  await assert.rejects(importSnapshot(db, store, snapshot, { deviceTokens: 'revoke', faults: { afterChunk: table => { if (table === 'flight_messages' && ++chunks === 2) throw new Error('power cut'); } } }), /power cut/);
  const partial = await count(db, 'flight_messages');
  assert.ok(partial > 0 && partial < 1203);
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'device_tokens_changed' });
  const receipt = await importSnapshot(db, store, snapshot, { deviceTokens: 'revoke' });
  assert.equal(receipt.tables.flight_messages.present, partial);
  assert.equal(receipt.tables.flight_messages.inserted, 1203 - partial);
  assert.deepEqual(receipt.objects, { listed: 2, stored: 0, present: 2 });
  assert.equal(await count(db, 'flight_messages'), 1203);
  assert.equal((await db.prepare("SELECT status FROM snapshot_imports").first()).status, 'completed');
});

test('unknown tables, unknown columns, unsafe paths and links are refused', async t => {
  const { db, store } = host(t);
  const withColumn = await readSnapshot(await makeSnapshot(t, { mutate: d => { d.flights[0].surprise = 1; } }));
  await assert.rejects(planSnapshot(db, store, withColumn, preserve), { code: 'snapshot_column' });

  const dir = await makeSnapshot(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rewrite = m => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  rewrite({ ...manifest, tables: { ...manifest.tables, device_sign_ins: manifest.tables.devices } });
  await assert.rejects(readSnapshot(dir), { code: 'table_not_importable' });
  rewrite({ ...manifest, tables: { flights: { ...manifest.tables.flights, file: '../outside.jsonl' } } });
  await assert.rejects(readSnapshot(dir), { code: 'snapshot_path' });
  rewrite({ ...manifest, tables: { flights: { ...manifest.tables.flights, file: '/etc/passwd' } } });
  await assert.rejects(readSnapshot(dir), { code: 'snapshot_path' });

  if (process.platform !== 'win32') {
    const linked = await makeSnapshot(t);
    const real = path.join(linked, 'tables', 'flights.jsonl');
    fs.renameSync(real, `${real}.real`);
    fs.symlinkSync(`${real}.real`, real);
    await assert.rejects(readSnapshot(linked), { code: 'snapshot_path' });
  }
});

test('pack joins wrangler --json pages and never overwrites', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tables', 'flight_messages'), { recursive: true });
  const all = rows().flight_messages;
  fs.writeFileSync(path.join(dir, 'tables', 'flight_messages', '0001.json'), JSON.stringify([{ results: all.slice(0, 600), success: true }]));
  fs.writeFileSync(path.join(dir, 'tables', 'flight_messages', '0002.json'), JSON.stringify([{ results: all.slice(600), success: true }]));
  fs.writeFileSync(path.join(dir, 'tables', 'flights.jsonl'), rows().flights.map(r => `${JSON.stringify(r)}\n`).join(''));
  const packed = await packSnapshot(dir, { label: 'pages' });
  assert.deepEqual(packed.tables, { flights: 2, flight_messages: 1203 });
  await assert.rejects(packSnapshot(dir, { label: 'pages' }), { code: 'snapshot_exists' });
  const snapshot = await readSnapshot(dir);
  assert.equal(snapshot.id, packed.snapshot);
  assert.ok(!fs.readdirSync(path.join(dir, 'tables')).some(n => n.endsWith('.partial')));
});

test('SnapshotError messages never carry row values', async t => {
  const { db, store } = host(t);
  const bad = await readSnapshot(await makeSnapshot(t, { mutate: d => { d.flights[0].home_lat = { nested: 'SYNTH-SECRET' }; } }));
  const error = await planSnapshot(db, store, bad, preserve).catch(e => e);
  assert.ok(error instanceof SnapshotError);
  assert.ok(!error.message.includes('SYNTH-SECRET') && !error.message.includes('41.5'));
});
