// Test helper: a fresh Logs schema through battery references (0007). 0004 is reserved for pairing.
import fs from 'node:fs';

const TABLES = ['battery_references', 'decoded_logs', 'raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'];

export async function applySchema(db) {
  for (const table of TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  const files = ['0001_flight_logs.sql', '0002_devices_raw_logs.sql', '0003_device_eligibility_revision.sql', '0005_local_decoder_leases.sql', '0006_decoded_logs.sql', '0007_battery_references.sql']
    .map(f => new URL(`../migrations/${f}`, import.meta.url));
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
