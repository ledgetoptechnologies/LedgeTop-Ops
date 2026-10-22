'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-f0-9-]{16,64}$/i;
const TOKEN = '[a-f0-9]{32}';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reconcileLodDerivativeStorage(processing, storage, {
  graceMs = 24 * 3600_000,
  limit = 100,
  nowMs = Date.now(),
} = {}) {
  const cutoff = nowMs - Math.max(3600_000, Number(graceMs) || 24 * 3600_000);
  const pageSize = Math.max(1, Math.min(Number(limit) || 100, 500));
  const cursorKey = 'lod_derivative_storage_cursor';
  let cursor = null;
  try {
    cursor = JSON.parse(processing.database.prepare('SELECT value FROM app_state WHERE key=?').get(cursorKey)?.value || 'null');
  } catch {}
  if (!cursor || typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string') cursor = null;
  const select = `SELECT d.id,d.attempt_id,d.status,d.updated_at,a.task_id
    FROM derivative_jobs d
    JOIN processing_attempts a ON a.id=d.attempt_id
    WHERE d.derivative_type IN ('lod_audit','mesh_tiles')
      AND d.status IN ('complete','failed','cancelled')`;
  const rows = cursor
    ? processing.database.prepare(`${select}
      AND (d.updated_at>? OR (d.updated_at=? AND d.id>?))
      ORDER BY d.updated_at,d.id LIMIT ?`).all(cursor.updatedAt, cursor.updatedAt, cursor.id, pageSize)
    : processing.database.prepare(`${select}
      ORDER BY d.updated_at,d.id LIMIT ?`).all(pageSize);
  let scanned = 0;
  let removed = 0;
  for (const row of rows) {
    if (!ID.test(row.id) || !ID.test(row.attempt_id) || !ID.test(row.task_id)) continue;
    const relativeBase = `${row.task_id}/${row.attempt_id}`;
    const candidate = storage.resolve('models', relativeBase);
    if (!fs.existsSync(candidate)) continue;
    let base;
    try { base = storage.resolve('models', relativeBase, { mustExist: true }); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'invalid_storage_location') continue;
      throw error;
    }
    if (base !== candidate) continue;
    const prefix = `tiles-ktx2-etc1s-${escapeRegExp(row.id)}`;
    const owned = new RegExp(`^${prefix}(?:\\.${TOKEN}\\.(?:incomplete|complete)|\\.\\d+\\.quarantine)$`, 'i');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!owned.test(entry.name)) continue;
      scanned += 1;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relative = `${relativeBase}/${entry.name}`;
      const referenced = processing.database.prepare("SELECT 1 FROM model_assets WHERE root_key='models' AND (relative_path=? OR relative_path LIKE ?) LIMIT 1").get(relative, `${relative}/%`);
      if (referenced) continue;
      const absolute = path.join(base, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.mtimeMs > cutoff) continue;
      fs.rmSync(absolute, { recursive: true, force: false });
      processing.database.prepare('INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
        crypto.randomUUID(),
        'system',
        null,
        'derivative.storage_reconciled',
        'derivative_job',
        row.id,
        JSON.stringify({ relativePath: relative, terminalStatus: row.status }),
        new Date(nowMs).toISOString(),
      );
      removed += 1;
    }
  }
  const last = rows.at(-1);
  const nextCursor = last && rows.length === pageSize
    ? JSON.stringify({ updatedAt: last.updated_at, id: last.id })
    : 'null';
  processing.database.prepare(`INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(
    cursorKey, nextCursor, new Date(nowMs).toISOString(),
  );
  return { scanned, removed };
}

module.exports = { reconcileLodDerivativeStorage };
