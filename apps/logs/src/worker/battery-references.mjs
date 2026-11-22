import { LogsError } from './errors.mjs';
import { normalizeBatteryReference } from '../battery-reference.mjs';

const ID = /^[A-Za-z0-9-]{1,80}$/;

/** A reference edits equipment presentation only. Existing import authority owns fleet metadata writes. */
export async function setBatteryReference(env, actor, input = {}) {
  if (typeof actor?.staffId !== 'string' || !actor.staffId) throw new LogsError('unauthenticated', 401, 'Sign in again to use flight logs.');
  if (!Array.isArray(actor.permissions) || !actor.permissions.includes('flight_logs.import'))
    throw new LogsError('forbidden', 403, 'You do not have permission to name batteries.');
  const { aircraftId, batteryId } = input;
  if (!ID.test(aircraftId ?? '') || !ID.test(batteryId ?? ''))
    throw new LogsError('battery_invalid', 400, 'Choose an aircraft and battery.');
  let referenceName;
  try { referenceName = normalizeBatteryReference(input.referenceName); }
  catch (error) { throw new LogsError('battery_name_invalid', 400, error.message); }
  const normalizedName = referenceName?.toLowerCase() ?? null;
  const db = env.LOGS_DB;
  const exists = await db.prepare('SELECT 1 FROM flights WHERE aircraft_id = ? AND battery_id = ? LIMIT 1').bind(aircraftId, batteryId).first();
  if (!exists) throw new LogsError('battery_not_found', 404, 'That aircraft battery was not found.');
  const at = new Date().toISOString();
  const write = referenceName
    ? db.prepare(`INSERT INTO battery_references (aircraft_id, battery_id, reference_name, normalized_name, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (aircraft_id, battery_id) DO UPDATE SET reference_name = excluded.reference_name, normalized_name = excluded.normalized_name, updated_at = excluded.updated_at`)
      .bind(aircraftId, batteryId, referenceName, normalizedName, at)
    : db.prepare('DELETE FROM battery_references WHERE aircraft_id = ? AND battery_id = ?').bind(aircraftId, batteryId);
  try {
    await db.batch([write, db.prepare('INSERT INTO audit_events (id, actor_id, action, subject, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), actor.staffId, 'battery.reference', `aircraft:${aircraftId}:battery:${batteryId}`, JSON.stringify({ aircraftId, batteryId, referenceName }), at)]);
  } catch (error) {
    // D1 wraps SQLite errors in cause; classify the failed statement itself, without a racy follow-up read.
    if (referenceName && referenceNameConflict(error))
      throw new LogsError('battery_name_taken', 409, 'That reference name is already used by another battery on this aircraft.');
    throw error;
  }
  return { aircraftId, batteryId, referenceName };
}

function referenceNameConflict(error) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (/UNIQUE constraint failed:\s*battery_references\.aircraft_id,\s*battery_references\.normalized_name/i.test(String(cause.message))) return true;
  }
  return false;
}
