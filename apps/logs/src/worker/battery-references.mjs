import { LogsError } from './errors.mjs';

const ID = /^[A-Za-z0-9-]{1,80}$/;

/** A reference edits equipment presentation only. Existing import authority owns fleet metadata writes. */
export async function setBatteryReference(env, actor, input = {}) {
  if (typeof actor?.staffId !== 'string' || !actor.staffId) throw new LogsError('unauthenticated', 401, 'Sign in again to use flight logs.');
  if (!Array.isArray(actor.permissions) || !actor.permissions.includes('flight_logs.import'))
    throw new LogsError('forbidden', 403, 'You do not have permission to name batteries.');
  const { aircraftId, batteryId } = input;
  if (!ID.test(aircraftId ?? '') || !ID.test(batteryId ?? ''))
    throw new LogsError('battery_invalid', 400, 'Choose an aircraft and battery.');
  if (input.referenceName !== null && typeof input.referenceName !== 'string')
    throw new LogsError('battery_name_invalid', 400, 'Use a battery reference name of up to 40 characters.');
  const referenceName = input.referenceName?.normalize('NFKC').trim() || null;
  if (referenceName && (referenceName.length > 40 || /[\p{Cc}\p{Cf}]/u.test(referenceName)))
    throw new LogsError('battery_name_invalid', 400, 'Use a battery reference name of up to 40 characters without control characters.');
  const normalizedName = referenceName?.toLowerCase() ?? null;
  if (normalizedName?.length > 40) throw new LogsError('battery_name_invalid', 400, 'Use a shorter battery reference name.');
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
    // Resolve only the unique-name conflict; storage/audit failures must still fail and roll back.
    if (referenceName && await db.prepare('SELECT 1 FROM battery_references WHERE aircraft_id = ? AND normalized_name = ? AND battery_id <> ?')
      .bind(aircraftId, normalizedName, batteryId).first())
      throw new LogsError('battery_name_taken', 400, 'That reference name is already used by another battery on this aircraft.');
    throw error;
  }
  return { aircraftId, batteryId, referenceName };
}
