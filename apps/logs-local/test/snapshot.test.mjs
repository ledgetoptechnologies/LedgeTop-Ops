// Snapshot import: checked before writing, add-only, exact sealed keychains with provenance, objects before rows,
// resumable, an explicit controller sign-in choice, and aggregate-only receipts. Synthetic rows and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { FsR2 } from '../src/fs-r2.mjs';
import { readSnapshot as readSnapshotRaw, planSnapshot, importSnapshot, packSnapshot, SnapshotError } from '../src/snapshot.mjs';
import { run } from '../src/snapshot-cli.mjs';

/** readSnapshot with its private staging folder removed after each test. */
const openedSnapshots = [];
const readSnapshot = async dir => { const snapshot = await readSnapshotRaw(dir); openedSnapshots.push(snapshot); return snapshot; };
test.afterEach(() => { while (openedSnapshots.length) openedSnapshots.pop().close(); });

const sha = data => createHash('sha256').update(data).digest('hex');
const T0 = '2025-06-01T10:00:00.000Z';
const SECRET_CIPHERTEXT = 'c2VhbGVkLWJ5LWNsb3VkZmxhcmUta2V5LW5vdC1sb2NhbA==';
const TRACK_JSON = Buffer.from(JSON.stringify({ points: [[0, 0, 0]] }));
const TRACK = gzipSync(TRACK_JSON);
const md5 = data => createHash('md5').update(data).digest('hex');
/** What R2 head/list reports for a single-part object: its size and an MD5 ETag. */
const source = data => ({ sourceBytes: data.length, sourceEtag: `"${md5(data)}"` });
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

async function makeSnapshot(t, { mutate, objects = true, trackFile = TRACK, objectLines } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = rows();
  mutate?.(data);
  fs.mkdirSync(path.join(dir, 'tables'));
  for (const [table, list] of Object.entries(data)) fs.writeFileSync(path.join(dir, 'tables', `${table}.jsonl`), list.map(r => `${JSON.stringify(r)}\n`).join(''));
  if (objects) {
    fs.mkdirSync(path.join(dir, 'objects'));
    fs.writeFileSync(path.join(dir, 'objects', 'track-1'), trackFile);
    fs.writeFileSync(path.join(dir, 'objects', 'raw-1'), RAW);
    fs.writeFileSync(path.join(dir, 'objects.jsonl'), (objectLines ?? [
      { key: 'telemetry/fl-1.json.gz', file: 'objects/track-1', ...source(TRACK) }, { key: `raw/${sha(RAW)}.txt`, file: 'objects/raw-1', ...source(RAW) },
    ]).map(o => `${JSON.stringify(o)}\n`).join(''));
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

test('an export that changed object bytes is refused: decompressed .gz, other size, ETag mismatch, multipart without SHA-256', async t => {
  // The transport decompressed the track (same JSON content, not the original bytes): size and ETag both disagree.
  await assert.rejects(makeSnapshot(t, { trackFile: TRACK_JSON }), { code: 'snapshot_object_transformed' });
  // Even if the transformed size and ETag were copied in, a .gz key that is not gzip is refused.
  await assert.rejects(makeSnapshot(t, { trackFile: TRACK_JSON, objectLines: [{ key: 'telemetry/fl-1.json.gz', file: 'objects/track-1', ...source(TRACK_JSON) }] }),
    { code: 'snapshot_object_transformed' });
  await assert.rejects(makeSnapshot(t, { objectLines: [{ key: 'telemetry/fl-1.json.gz', file: 'objects/track-1', sourceBytes: TRACK.length }] }),
    { code: 'snapshot_object_source' });
  await assert.rejects(makeSnapshot(t, { objectLines: [{ key: 'telemetry/fl-1.json.gz', file: 'objects/track-1', sourceBytes: TRACK.length, sourceEtag: `${md5(TRACK)}-3` }] }),
    { code: 'snapshot_object_source' });
  const multipart = await makeSnapshot(t, { objectLines: [
    { key: 'telemetry/fl-1.json.gz', file: 'objects/track-1', sourceBytes: TRACK.length, sourceEtag: `${'0'.repeat(32)}-3`, sourceSha256: sha(TRACK) },
    { key: `raw/${sha(RAW)}.txt`, file: 'objects/raw-1', ...source(RAW) }] });
  assert.equal((await readSnapshot(multipart)).objects.length, 2, 'a multipart object is verified by its source SHA-256');

  // The packed object list is checked again when reading, not only when packing.
  const dir = await makeSnapshot(t);
  const listFile = path.join(dir, 'objects.manifest.jsonl');
  const tampered = fs.readFileSync(listFile, 'utf8').replace(/"sourceEtag":"[0-9a-f]{32}"/, `"sourceEtag":"${'1'.repeat(32)}"`);
  fs.writeFileSync(listFile, tampered);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.objects = { ...manifest.objects, bytes: Buffer.byteLength(tampered), sha256: sha(tampered) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(readSnapshot(dir), { code: 'snapshot_object_transformed' });
});

test('a raw log object must be exactly the size its row records', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t, { mutate: d => { d.raw_logs[0].size_bytes = RAW.length + 1; } }));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.deepEqual([plan.ok, plan.objects.sizeMismatches], [false, 1]);
  await assert.rejects(importSnapshot(db, store, snapshot, preserve), { code: 'snapshot_conflicts' });
  assert.equal(await count(db, 'raw_logs'), 0);
});

test('table bytes changed after verification are never imported: planning and importing read the verified private copy', async t => {
  const { db, store } = host(t);
  const dir = await makeSnapshot(t);
  const snapshot = await readSnapshot(dir);
  const flightsFile = path.join(dir, 'tables', 'flights.jsonl');
  const forged = fs.readFileSync(flightsFile, 'utf8').replace('staff-known', 'staff-forged');
  fs.writeFileSync(flightsFile, forged); // after readSnapshot
  const plan = await planSnapshot(db, store, snapshot, preserve);
  fs.writeFileSync(flightsFile, forged.replace('staff-forged', 'staff-forged-again')); // after plan, before writes
  assert.equal(plan.ok, true);
  await importSnapshot(db, store, snapshot, preserve);
  assert.equal((await db.prepare("SELECT pilot_id FROM flights WHERE id = 'fl-1'").first()).pilot_id, 'staff-known');
  // A fresh read of the edited folder is refused against the manifest.
  await assert.rejects(readSnapshot(dir), { code: 'snapshot_checksum' });
});

test('if the private copy itself changes while being read, reading stops with snapshot_changed', async t => {
  const { db, store } = host(t);
  const snapshot = await readSnapshot(await makeSnapshot(t));
  fs.appendFileSync(snapshot.files.flight_messages.path, `${JSON.stringify({ flight_id: 'fl-1', seq: 99999, level: 'tip', text: 'x' })}\n`);
  await assert.rejects(planSnapshot(db, store, snapshot, preserve), { code: 'snapshot_changed' });
  snapshot.close();
  assert.equal(fs.existsSync(path.dirname(snapshot.files.flights.path)), false, 'close removes the private copies');
});

test('CLI plan is read-only: an unprepared host is refused and left untouched; a prepared host is not modified', async t => {
  const snapshotDir = await makeSnapshot(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-cli-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const out = [];
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-staging-'));
  t.after(() => fs.rmSync(stagingDir, { recursive: true, force: true }));
  const args = ['plan', '--snapshot', snapshotDir, '--staging-dir', stagingDir, '--device-tokens', 'preserve'];
  assert.equal(await run(['plan', '--snapshot', snapshotDir, '--device-tokens', 'preserve'], { dataDir, print: v => out.push(v) }), 2, 'staging dir is required');
  assert.equal(await run(args, { dataDir, print: v => out.push(v) }), 3);
  assert.equal(out.at(-1).code, 'host_not_ready');
  assert.deepEqual(fs.readdirSync(dataDir), [], 'planning created nothing');

  // Prepare the host the way it is prepared in service (open, migrate, close), then snapshot the files.
  const db = new SqliteD1(path.join(fs.mkdirSync(path.join(dataDir, 'db')) ?? path.join(dataDir, 'db'), 'logs.sqlite'));
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  db.close();
  new FsR2(path.join(dataDir, 'objects'), { durableBase: dataDir, statfs: () => ({ bavail: 1e9, bsize: 4096 }) }).close();
  const state = () => {
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push([path.relative(dataDir, p), sha(fs.readFileSync(p))]); } };
    walk(dataDir);
    return files.sort();
  };
  const before = state();
  assert.equal(await run(args, { dataDir, print: v => out.push(v) }), 0, JSON.stringify(out.at(-1)));
  assert.equal(out.at(-1).tables.flights.inserted, 2);
  // SQLite may create its own coordination files for a WAL database even when opened read-only (a running host
  // already has them). The WAL must stay empty and every database byte must be unchanged.
  const after = state().filter(([name]) => !/-(wal|shm)$/.test(name));
  assert.deepEqual(after, before, 'no database or other file added, removed or changed by planning');
  for (const [name, digest] of state()) if (name.endsWith('-wal')) assert.equal(digest, sha(Buffer.alloc(0)), `${name} stays empty`);

  assert.equal(await run(['import', '--snapshot', snapshotDir, '--staging-dir', stagingDir, '--device-tokens', 'preserve'], { dataDir, print: v => out.push(v) }), 0, JSON.stringify(out.at(-1)));
  assert.deepEqual(fs.readdirSync(stagingDir), [], 'private copies removed after each command');
  assert.equal(await run(args, { dataDir, print: v => out.push(v) }), 0);
  assert.equal(out.at(-1).tables.flights.present, 2);
});

test('multibyte text (accents, emoji, a character split across read chunks) is counted in bytes, not characters', async t => {
  const { db, store } = host(t);
  // 64 KiB read chunks: pad so that a 2-byte "é" and a 4-byte emoji straddle the first chunk boundary.
  const pad = 'x'.repeat(65536 - 120);
  const snapshot = await readSnapshot(await makeSnapshot(t, { mutate: d => {
    d.aircraft[0].model = 'Café 🚁 Mavic';
    d.flight_messages[0].text = `${pad}é🚁é`;
  } }));
  const plan = await planSnapshot(db, store, snapshot, preserve);
  assert.equal(plan.ok, true);
  await importSnapshot(db, store, snapshot, preserve);
  assert.equal((await db.prepare("SELECT model FROM aircraft WHERE id = 'ac-1'").first()).model, 'Café 🚁 Mavic');
  assert.equal((await db.prepare("SELECT text FROM flight_messages WHERE seq = 0").first()).text, `${pad}é🚁é`);
});

test('the staging folder must be a real folder with room for every table; nothing is copied otherwise', async t => {
  const dir = await makeSnapshot(t);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-snapshot-small-'));
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }));
  await assert.rejects(readSnapshotRaw(dir, { stagingDir: staging, statfs: () => ({ bavail: 1024, bsize: 4096 }) }), { code: 'staging_space' });
  assert.deepEqual(fs.readdirSync(staging), [], 'nothing copied');
  await assert.rejects(readSnapshotRaw(dir, { stagingDir: path.join(staging, 'missing') }), { code: 'staging_dir' });
});
