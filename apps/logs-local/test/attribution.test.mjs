// Flight attribution review over SQLite: administrators only, the target pilot active in Ops, an audit row if and
// only if a change happened, concurrent changes refused (never overwritten), and status counts that separate logs
// retained while waiting for the DJI key from failed ones. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import * as attribution from '../../logs/src/worker/attribution.mjs';

const T0 = '2026-11-01T10:00:00.000Z';
const admin = Object.freeze({ staffId: 'staff-admin', permissions: [], administrator: true });
const SUMMARY = JSON.stringify({ display_name: 'Roof survey', started_at: '2026-11-01T09:00:00Z', ended_at: '2026-11-01T09:12:00Z', duration_seconds: 720,
  distance_m: 1500, max_altitude_m: 60, max_speed_mps: 9, home_lat: 41.123456, home_lon: -90.654321, photo_count: 120, video_count: 0, telemetry_points: 7200 });
const hex = n => n.toString(16).padStart(64, '0');

function setup(t, { active = id => id !== 'staff-former' } = {}) {
  const db = new SqliteD1(':memory:');
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  t.after(() => db.close());
  const directory = { calls: [], async getStaffAuthority(id) { this.calls.push(id); if (active instanceof Error) throw active;
    return { active: active(id), canViewAll: false, canImport: false, administrator: false }; } };
  const env = { LOGS_DB: db, OPS_DIRECTORY: directory, LOGS_DECODER_STATE: () => 'waiting_for_key' };
  return { db, env, directory };
}

async function seedDevice(db) {
  await db.prepare("INSERT INTO devices (id, pilot_id, model, name, token_hash, approved_by, created_at) VALUES ('dev-1', 'staff-uploader', 'RC Plus 2', 'Truck RC', 'h', 'staff-admin', ?)")
    .bind(T0).run();
}
async function seedRaw(db, n, { status = 'decoded', errorCode = null, uploadedAt = T0 } = {}) {
  await db.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at, parse_status, error_code)
    VALUES (?, 10, ?, ?, 'controller', 'dev-1', 'staff-uploader', ?, ?, ?)`).bind(hex(n), `DJIFlightRecord_${n}.txt`, `raw/${hex(n)}.txt`, uploadedAt, status, errorCode).run();
}
async function seedDecoded(db, n, status, { conflictFlightId = null, flightId = null } = {}) {
  await seedRaw(db, n);
  await db.prepare(`INSERT INTO decoded_logs (raw_sha256, status, summary_json, telemetry_key, result_fingerprint, decoder_version, committed_attempt_token,
      flight_id, conflict_flight_id, decoded_at) VALUES (?, ?, ?, ?, ?, 'v1', 'attempt', ?, ?, ?)`)
    .bind(hex(n), status, SUMMARY, `telemetry/v1/raw-${hex(n)}/t.json.gz`, 'f'.repeat(64), flightId, conflictFlightId, T0).run();
}
async function seedFlight(db, id, pilot, fileHash) {
  await db.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, created_at, updated_at)
    VALUES (?, ?, 'opendronelog', ?, 'backup_owner', ?, ?)`).bind(id, fileHash, pilot, T0, T0).run();
}
const audits = async db => (await db.prepare("SELECT actor_id, subject, detail FROM audit_events WHERE action = 'flight.attribution' ORDER BY at, id").all()).results
  .map(row => ({ ...row, detail: JSON.parse(row.detail) }));

test('only administrators; every function refuses an actor without the fresh administrator flag', async t => {
  const { env } = setup(t);
  const notAdmin = { staffId: 'staff-x', permissions: ['flight_logs.view', 'flight_logs.import'] };
  for (const call of [() => attribution.logsStatus(env, notAdmin), () => attribution.reviewQueue(env, notAdmin, {}),
    () => attribution.assignDecodedLog(env, notAdmin, { rawSha256: hex(1), pilotId: 'staff-pilot' }),
    () => attribution.reassignFlight(env, notAdmin, { flightId: 'fl-1', pilotId: 'staff-pilot' }),
    () => attribution.resolveConflict(env, { ...notAdmin, administrator: 'yes' }, { rawSha256: hex(1), resolution: 'keep_existing' })])
    await assert.rejects(call(), { code: 'forbidden', status: 403 });
});

test('initial assignment creates the flight from the decoded summary, audited as initial, exactly once', async t => {
  const { db, env } = setup(t);
  await seedDevice(db);
  await seedDecoded(db, 1, 'unassigned');
  const result = await attribution.assignDecodedLog(env, admin, { rawSha256: hex(1), pilotId: 'staff-pilot', reason: 'Matched the job sheet' });
  assert.equal(result.kind, 'initial');
  const flight = await db.prepare('SELECT * FROM flights WHERE id = ?').bind(result.flightId).first();
  assert.equal(flight.pilot_id, 'staff-pilot');
  assert.equal(flight.pilot_attribution, 'admin_reassigned');
  assert.equal(flight.file_hash, hex(1));
  assert.equal(flight.source_system, 'controller');
  assert.deepEqual([flight.duration_seconds, flight.photo_count, flight.telemetry_points], [720, 120, 7200]);
  assert.equal(flight.raw_log_status, 'stored');
  assert.equal(flight.raw_log_key, `raw/${hex(1)}.txt`);
  const decoded = await db.prepare('SELECT status, flight_id, assigned_by FROM decoded_logs WHERE raw_sha256 = ?').bind(hex(1)).first();
  assert.deepEqual(decoded, { status: 'assigned', flight_id: result.flightId, assigned_by: 'staff-admin' });
  assert.equal((await db.prepare('SELECT flight_id FROM raw_logs WHERE sha256 = ?').bind(hex(1)).first()).flight_id, result.flightId);
  const [audit, ...more] = await audits(db);
  assert.equal(more.length, 0);
  assert.equal(audit.actor_id, 'staff-admin');
  assert.deepEqual(audit.detail, { kind: 'initial', rawSha256: hex(1), flightId: result.flightId, to: 'staff-pilot', reason: 'Matched the job sheet' });
  await assert.rejects(attribution.assignDecodedLog(env, admin, { rawSha256: hex(1), pilotId: 'staff-pilot' }), { code: 'not_unassigned', status: 409 });
  assert.equal((await audits(db)).length, 1, 'a refused request writes no audit row');
});

test('the target pilot must be active in Ops right now; Ops unreachable fails closed; nothing is written', async t => {
  const { db, env } = setup(t);
  await seedDevice(db);
  await seedDecoded(db, 1, 'unassigned');
  await assert.rejects(attribution.assignDecodedLog(env, admin, { rawSha256: hex(1), pilotId: 'staff-former' }), { code: 'pilot_not_active' });
  await assert.rejects(attribution.assignDecodedLog(env, admin, { rawSha256: hex(1), pilotId: 'bad id!' }), { code: 'pilot_invalid' });
  const down = setup(t, { active: new Error('ops down') });
  await seedDevice(down.db);
  await seedDecoded(down.db, 1, 'unassigned');
  await assert.rejects(attribution.assignDecodedLog(down.env, admin, { rawSha256: hex(1), pilotId: 'staff-pilot' }), { code: 'directory_unavailable', status: 503 });
  for (const target of [db, down.db]) {
    assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 0);
    assert.equal((await audits(target)).length, 0);
  }
});

test('a flight that appeared with the same hash while deciding: the assignment is refused (409) and nothing changes', async t => {
  const { db, env, directory } = setup(t);
  await seedDevice(db);
  await seedDecoded(db, 1, 'unassigned');
  // Ops answers, and meanwhile an import creates a flight with this exact hash.
  const original = directory.getStaffAuthority.bind(directory);
  directory.getStaffAuthority = async id => { await seedFlight(db, 'fl-race', 'staff-other', hex(1)); return original(id); };
  await assert.rejects(attribution.assignDecodedLog(env, admin, { rawSha256: hex(1), pilotId: 'staff-pilot' }), { code: 'attribution_changed', status: 409 });
  assert.equal((await db.prepare('SELECT status FROM decoded_logs').first()).status, 'unassigned');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 1);
  assert.equal((await audits(db)).length, 0, 'no audit row without the change');
});

test('reassigning any flight records from and to; a concurrent reassignment is refused, not overwritten', async t => {
  const { db, env, directory } = setup(t);
  await seedFlight(db, 'fl-1', 'staff-a', hex(9));
  const done = await attribution.reassignFlight(env, admin, { flightId: 'fl-1', pilotId: 'staff-b', reason: 'Wrong backup owner' });
  assert.deepEqual([done.from, done.pilotId, done.kind], ['staff-a', 'staff-b', 'reassign']);
  const flight = await db.prepare("SELECT pilot_id, pilot_attribution FROM flights WHERE id = 'fl-1'").first();
  assert.deepEqual(flight, { pilot_id: 'staff-b', pilot_attribution: 'admin_reassigned' });
  assert.deepEqual((await audits(db))[0].detail, { kind: 'reassign', flightId: 'fl-1', from: 'staff-a', to: 'staff-b', reason: 'Wrong backup owner' });
  await assert.rejects(attribution.reassignFlight(env, admin, { flightId: 'fl-1', pilotId: 'staff-b' }), { code: 'no_change' });
  await assert.rejects(attribution.reassignFlight(env, admin, { flightId: 'nope', pilotId: 'staff-c' }), { code: 'flight_not_found' });

  const original = directory.getStaffAuthority.bind(directory);
  directory.getStaffAuthority = async id => { await db.prepare("UPDATE flights SET pilot_id = 'staff-z' WHERE id = 'fl-1'").run(); return original(id); };
  await assert.rejects(attribution.reassignFlight(env, admin, { flightId: 'fl-1', pilotId: 'staff-c' }), { code: 'attribution_changed' });
  assert.equal((await db.prepare("SELECT pilot_id FROM flights WHERE id = 'fl-1'").first()).pilot_id, 'staff-z');
  assert.equal((await audits(db)).length, 1);
});

test('conflicts: keep the existing owner, or move that flight; both link the log and are audited with the uploader', async t => {
  const { db, env } = setup(t);
  await seedDevice(db);
  await seedFlight(db, 'fl-keep', 'staff-owner', hex(1));
  await seedDecoded(db, 1, 'conflict', { conflictFlightId: 'fl-keep' });
  const kept = await attribution.resolveConflict(env, admin, { rawSha256: hex(1), resolution: 'keep_existing' });
  assert.deepEqual([kept.kind, kept.pilotId], ['conflict_keep_existing', 'staff-owner']);
  const keptFlight = await db.prepare("SELECT pilot_id, pilot_attribution, raw_log_status, raw_log_key, telemetry_key FROM flights WHERE id = 'fl-keep'").first();
  assert.deepEqual(keptFlight, { pilot_id: 'staff-owner', pilot_attribution: 'backup_owner', raw_log_status: 'stored', raw_log_key: `raw/${hex(1)}.txt`,
    telemetry_key: `telemetry/v1/raw-${hex(1)}/t.json.gz` });
  assert.deepEqual(await db.prepare('SELECT status, flight_id FROM decoded_logs WHERE raw_sha256 = ?').bind(hex(1)).first(), { status: 'linked', flight_id: 'fl-keep' });

  await seedFlight(db, 'fl-move', 'staff-owner', hex(2));
  await seedDecoded(db, 2, 'conflict', { conflictFlightId: 'fl-move' });
  await assert.rejects(attribution.resolveConflict(env, admin, { rawSha256: hex(2), resolution: 'reassign_existing' }), { code: 'pilot_invalid' });
  await assert.rejects(attribution.resolveConflict(env, admin, { rawSha256: hex(2), resolution: 'reassign_existing', pilotId: 'staff-owner' }), { code: 'no_change' });
  const moved = await attribution.resolveConflict(env, admin, { rawSha256: hex(2), resolution: 'reassign_existing', pilotId: 'staff-uploader', reason: 'Controller pilot flew it' });
  assert.deepEqual([moved.from, moved.pilotId], ['staff-owner', 'staff-uploader']);
  assert.deepEqual(await db.prepare("SELECT pilot_id, pilot_attribution FROM flights WHERE id = 'fl-move'").first(), { pilot_id: 'staff-uploader', pilot_attribution: 'admin_reassigned' });

  const details = (await audits(db)).map(a => a.detail);
  assert.deepEqual(details.map(d => [d.kind, d.from, d.to, d.uploader]),
    [['conflict_keep_existing', 'staff-owner', 'staff-owner', 'staff-uploader'], ['conflict_reassign', 'staff-owner', 'staff-uploader', 'staff-uploader']]);
  await assert.rejects(attribution.resolveConflict(env, admin, { rawSha256: hex(2), resolution: 'keep_existing' }), { code: 'not_conflict' });
});

test('status separates accepted logs waiting for the DJI key from failed ones; the queue shows no coordinates', async t => {
  const { db, env } = setup(t);
  await seedDevice(db);
  await seedRaw(db, 10, { status: 'needs_parse', uploadedAt: '2026-11-02T00:00:00.000Z' });
  await seedRaw(db, 11, { status: 'needs_parse' });
  await seedRaw(db, 12, { status: 'failed', errorCode: 'corrupt_log' });
  await seedRaw(db, 13, { status: 'failed', errorCode: 'raw_missing' });
  await seedDecoded(db, 14, 'unassigned');
  await seedFlight(db, 'fl-odl', 'staff-a', hex(99));
  const status = await attribution.logsStatus(env, admin);
  assert.equal(status.decoder, 'waiting_for_key');
  assert.deepEqual({ ...status.raw, lastUploadAt: null }, { retained: 5, waiting: 2, waitingReason: 'waiting_for_key', decoding: 0, decoded: 1, failed: 2,
    failedByCode: { corrupt_log: 1, raw_missing: 1 }, lastUploadAt: null });
  assert.equal(status.raw.lastUploadAt, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(status.review, { unassigned: 1, conflict: 0, linked: 0, assigned: 0 });
  assert.deepEqual(status.flights, { total: 1, withoutOriginal: 1 });
  env.LOGS_DECODER_STATE = () => 'running';
  assert.equal((await attribution.logsStatus(env, admin)).raw.waitingReason, 'queued');

  const waiting = await attribution.reviewQueue(env, admin, { queue: 'waiting' });
  assert.deepEqual(waiting.items.map(i => i.rawSha256), [hex(10), hex(11)]);
  assert.equal(waiting.items[0].uploader.deviceName, 'Truck RC');
  const failed = await attribution.reviewQueue(env, admin, { queue: 'failed' });
  assert.deepEqual(failed.items.map(i => i.errorCode).sort(), ['corrupt_log', 'raw_missing']);
  const unassigned = await attribution.reviewQueue(env, admin, { queue: 'unassigned' });
  assert.equal(unassigned.items[0].summary.durationSeconds, 720);
  const text = JSON.stringify(unassigned);
  assert.ok(!text.includes('41.123456') && !text.includes('-90.654321') && !text.includes('telemetry/'), 'no home position or track location');
  await assert.rejects(attribution.reviewQueue(env, admin, { queue: 'everything' }), { code: 'queue_invalid' });
});

test('review pages are stable newest-first with a cursor', async t => {
  const { db, env } = setup(t);
  await seedDevice(db);
  for (let n = 1; n <= 5; n++) await seedRaw(db, n, { status: 'needs_parse', uploadedAt: `2026-11-0${n}T00:00:00.000Z` });
  const first = await attribution.reviewQueue(env, admin, { queue: 'waiting', limit: 2 });
  const second = await attribution.reviewQueue(env, admin, { queue: 'waiting', limit: 2, before: first.next });
  const third = await attribution.reviewQueue(env, admin, { queue: 'waiting', limit: 2, before: second.next });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(i => i.rawSha256), [5, 4, 3, 2, 1].map(hex));
  assert.equal(third.next, null);
  await assert.rejects(attribution.reviewQueue(env, admin, { queue: 'waiting', before: "x' OR 1=1 --|zz" }), { code: 'cursor_invalid' });
});
