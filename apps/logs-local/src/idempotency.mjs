// Retry safety for writes that are not naturally idempotent (start import, decide a sign-in, revoke a device,
// assign or reassign a flight). The caller sends an Idempotency-Key; the record is scoped to the calling machine
// identity, the staff actor, the operation and its target, so one key can never answer for another actor or
// operation. Authentication and authorization happen before this, on every request; this is retry safety only.
//
// An operation is NEVER run twice for one record:
//   - same key + same request, finished        -> the stored answer is replayed (including a business refusal);
//   - same key + different request              -> 409 idempotency_conflict;
//   - same key while the first is still running -> 409 idempotency_in_progress;
//   - the first attempt died or failed in an unknown way (its effect may or may not have committed)
//                                               -> 409 idempotency_unresolved, for as long as the record exists.
//     It is not re-executed automatically: whether the effect happened needs reconciliation, not a guess.
//     Pending and unresolved records are kept until reconciled. Their number is bounded: past maxOpen, new keyed
//     writes are refused (503) instead of forgetting an ambiguous effect.
//   - a finished record keeps its key, fingerprint and outcome forever; after 24 h only the stored answer body
//     is dropped, and a retry then gets 409 idempotency_expired. A key never runs its operation a second time.
// This is not exactly-once for a separate business commit: operations that need that must write their own
// receipt in the same Logs SQLite transaction as their effect (or reconcile durably).
// Every state change is fenced by the attempt's own token, so a late attempt can never overwrite another's record.
import { createHash, randomUUID } from 'node:crypto';
import { LogsError } from '../../logs/src/worker/errors.mjs';

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY = Object.freeze({ ttlMs: 24 * 60 * 60_000, unresolvedAfterMs: 5 * 60_000, maxResultBytes: 64 * 1024, maxOpen: 1000 });

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
    const attempt = randomUUID();
    const at = now();
    // Records are never deleted. After the TTL a finished answer's body is dropped (the record stays, as 'expired');
    // a pending or unresolved record is the memory of a possibly-committed effect and is never touched here.
    await db.prepare("UPDATE idempotency_records SET state = 'expired', result = NULL WHERE id IN (SELECT id FROM idempotency_records WHERE state = 'done' AND expires_at < ? LIMIT 100)").bind(at).run();
    // The open-record cap and the claim are one statement, so concurrent new keys cannot all slip under the cap.
    const claimed = await db.prepare(`INSERT OR IGNORE INTO idempotency_records (id, fingerprint, state, attempt, result, created_at, expires_at)
      SELECT ?, ?, 'pending', ?, NULL, ?, ?
      WHERE (SELECT COUNT(*) FROM idempotency_records WHERE state IN ('pending', 'unresolved')) < ?`)
      .bind(id, fingerprint, attempt, at, at + IDEMPOTENCY.ttlMs, IDEMPOTENCY.maxOpen).run();
    if (!claimed.meta.changes) {
      const row = await db.prepare('SELECT fingerprint, state, result, created_at FROM idempotency_records WHERE id = ?').bind(id).first();
      if (!row) throw new LogsError('idempotency_backlog', 503, 'Too many requests are awaiting reconciliation. Try again later.');
      if (row.fingerprint !== fingerprint) throw new IdempotencyError('idempotency_conflict', 'This Idempotency-Key was used for a different request.');
      if (row.state === 'done') return replay(JSON.parse(row.result));
      if (row.state === 'expired') throw new IdempotencyError('idempotency_expired', 'This request already completed; its answer is no longer kept. It will not be repeated.');
      if (row.state === 'pending' && at - row.created_at < IDEMPOTENCY.unresolvedAfterMs)
        throw new IdempotencyError('idempotency_in_progress', 'This request is still being processed. Try again shortly.');
      throw new IdempotencyError('idempotency_unresolved', 'An earlier attempt of this request did not finish cleanly. It will not be repeated automatically.');
    }
    const finish = outcome => db.prepare("UPDATE idempotency_records SET state = 'done', result = ? WHERE id = ? AND attempt = ? AND state = 'pending'")
      .bind(JSON.stringify(outcome), id, attempt).run();
    let result;
    try {
      result = await fn();
    } catch (error) {
      if (error instanceof LogsError) {
        // A business refusal is this request's answer: replay it rather than run the operation again.
        await finish({ error: { code: error.code, status: error.status, message: error.message } });
      } else {
        // Unknown failure: the effect may have committed. Leave the record pending; it becomes unresolved.
        await db.prepare("UPDATE idempotency_records SET state = 'unresolved' WHERE id = ? AND attempt = ? AND state = 'pending'").bind(id, attempt).run();
      }
      throw error;
    }
    const stored = JSON.stringify({ value: result ?? null });
    // The effect has happened; an answer too large to keep is recorded as such, never re-run to recompute it.
    await finish(Buffer.byteLength(stored) > IDEMPOTENCY.maxResultBytes ? { value: null, resultTooLarge: true } : { value: result ?? null });
    return result ?? null;
  };
}

function replay(outcome) {
  if (outcome.error) throw new LogsError(outcome.error.code, outcome.error.status, outcome.error.message);
  if (outcome.resultTooLarge) throw new IdempotencyError('idempotency_result_unavailable', 'This request already completed; its result is too large to replay.');
  return outcome.value;
}
