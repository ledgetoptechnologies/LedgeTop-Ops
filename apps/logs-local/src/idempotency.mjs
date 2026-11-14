// Retry safety for writes that are not naturally idempotent (start import, decide a sign-in, revoke a device,
// assign or reassign a flight). The caller sends an Idempotency-Key; the record is scoped to the calling machine
// identity, the staff actor, the operation and its target, so one key can never answer for another actor or
// operation. The same key with the same request returns the stored result; the same key with a different
// request is a 409; a request still running is a 409 to retry later. This is retry safety, not replay defence:
// authentication and authorization happen before it, on every request.
import { createHash } from 'node:crypto';

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY = Object.freeze({ ttlMs: 24 * 60 * 60_000, abandonAfterMs: 5 * 60_000, maxResultBytes: 64 * 1024 });

export class IdempotencyError extends Error {
  constructor(code, message) { super(message); this.name = 'IdempotencyError'; this.code = code; this.status = 409; }
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** @param {import('./sqlite-d1.mjs').SqliteD1} db a database migrated with apps/logs-local/migrations */
export function createIdempotency(db, { now = Date.now } = {}) {
  return async function once({ identity, actorId = null, operation, scope = null, key, request }, fn) {
    if (!KEY.test(key ?? '')) throw new IdempotencyError('idempotency_key_invalid', 'A valid Idempotency-Key is required.');
    if (!identity || !operation) throw new Error('idempotency_scope_missing');
    const id = digest([identity, actorId, operation, scope, key]);
    const fingerprint = digest(request ?? null);
    const at = now();
    await db.prepare('DELETE FROM idempotency_records WHERE id IN (SELECT id FROM idempotency_records WHERE expires_at < ? LIMIT 100)').bind(at).run();
    const claimed = await db.prepare(`INSERT INTO idempotency_records (id, fingerprint, state, result, created_at, expires_at)
      VALUES (?, ?, 'pending', NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at
      WHERE idempotency_records.state = 'pending' AND idempotency_records.fingerprint = excluded.fingerprint
        AND idempotency_records.created_at < ?`)
      .bind(id, fingerprint, at, at + IDEMPOTENCY.ttlMs, at - IDEMPOTENCY.abandonAfterMs).run();
    if (!claimed.meta.changes) {
      const row = await db.prepare('SELECT fingerprint, state, result FROM idempotency_records WHERE id = ?').bind(id).first();
      if (row.fingerprint !== fingerprint) throw new IdempotencyError('idempotency_conflict', 'This Idempotency-Key was used for a different request.');
      if (row.state === 'done') return JSON.parse(row.result);
      throw new IdempotencyError('idempotency_in_progress', 'This request is still being processed. Try again shortly.');
    }
    let result;
    try { result = await fn(); } catch (error) {
      await db.prepare("DELETE FROM idempotency_records WHERE id = ? AND state = 'pending'").bind(id).run();
      throw error;
    }
    const stored = JSON.stringify(result ?? null);
    if (Buffer.byteLength(stored) > IDEMPOTENCY.maxResultBytes) throw new Error('idempotency_result_too_large');
    await db.prepare("UPDATE idempotency_records SET state = 'done', result = ? WHERE id = ?").bind(stored, id).run();
    return result ?? null;
  };
}
