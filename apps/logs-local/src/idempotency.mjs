// Retry safety for writes that are not naturally idempotent (start import, decide a sign-in, revoke a device,
// clear pending sign-ins, and later assign/reassign). The caller sends an Idempotency-Key; the record is scoped to
// the calling machine identity, the staff actor, the operation and its target, so one key can never answer for
// another actor or operation. Authentication and authorization happen before this, on every request.
//
// The operation's FIRST database write commits together with an attempt-fenced receipt (state 'committed'), in
// one SQLite transaction on the same Logs database (sqlite-d1 writeReceipts). That makes every state exact:
//   pending    no write of the operation has committed. A retry after the in-progress window takes the record
//              over with a new attempt token and runs the operation; the old attempt's first write then fails its
//              fence and rolls back, so the effect can never happen twice.
//   committed  the effect committed but the answer was not recorded (crash, or an error after the write). It is
//              never run again; a retry gets 409 idempotency_completed.
//   done       the answer (or a business refusal) is stored and replayed to retries.
//   expired    a done record older than 24 h: the answer body is dropped, the record stays; a retry gets 409.
//   unresolved legacy state from before receipts; treated like committed.
// Same key with a different request is 409 idempotency_conflict. Records with a committed effect are never deleted.
// Open (pending) records are capped atomically; past the cap new keys get 503 instead of being forgotten.
// This covers writes made through this database; an operation with an external side effect would need its own.
import { createHash, randomUUID } from 'node:crypto';
import { LogsError } from '../../logs/src/worker/errors.mjs';
import { writeReceipts, ReceiptFenceError } from './sqlite-d1.mjs';

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY = Object.freeze({ ttlMs: 24 * 60 * 60_000, inProgressMs: 5 * 60_000, maxResultBytes: 64 * 1024, maxOpen: 1000 });

export class IdempotencyError extends Error {
  constructor(code, message) { super(message); this.name = 'IdempotencyError'; this.code = code; this.status = 409; }
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** @param {import('./sqlite-d1.mjs').SqliteD1} db the Logs database, migrated with apps/logs-local/migrations */
export function createIdempotency(db, { now = Date.now } = {}) {
  return async function once({ identity, actorId = null, operation, scope = null, key, request }, fn) {
    if (!KEY.test(key ?? '')) throw new IdempotencyError('idempotency_key_invalid', 'A valid Idempotency-Key is required.');
    if (!identity || !operation) throw new Error('idempotency_scope_missing');
    const id = digest([identity, actorId, operation, scope, key]);
    const fingerprint = digest(request ?? null);
    let attempt = randomUUID();
    const at = now();
    await db.prepare("UPDATE idempotency_records SET state = 'expired', result = NULL WHERE id IN (SELECT id FROM idempotency_records WHERE state = 'done' AND expires_at < ? LIMIT 100)").bind(at).run();
    // The open-record cap and the claim are one statement, so concurrent new keys cannot all slip under the cap.
    const claimed = await db.prepare(`INSERT OR IGNORE INTO idempotency_records (id, fingerprint, state, attempt, result, created_at, expires_at)
      SELECT ?, ?, 'pending', ?, NULL, ?, ?
      WHERE (SELECT COUNT(*) FROM idempotency_records WHERE state = 'pending') < ?`)
      .bind(id, fingerprint, attempt, at, at + IDEMPOTENCY.ttlMs, IDEMPOTENCY.maxOpen).run();
    if (!claimed.meta.changes) {
      const row = await db.prepare('SELECT fingerprint, state, attempt, result, created_at FROM idempotency_records WHERE id = ?').bind(id).first();
      if (!row) throw new LogsError('idempotency_backlog', 503, 'Too many requests are in progress. Try again later.');
      if (row.fingerprint !== fingerprint) throw new IdempotencyError('idempotency_conflict', 'This Idempotency-Key was used for a different request.');
      if (row.state === 'done') return replay(JSON.parse(row.result));
      if (row.state === 'expired') throw new IdempotencyError('idempotency_expired', 'This request already completed; its answer is no longer kept. It will not be repeated.');
      if (row.state !== 'pending') throw new IdempotencyError('idempotency_completed', 'This request already completed. It will not be repeated.');
      if (at - row.created_at < IDEMPOTENCY.inProgressMs) throw new IdempotencyError('idempotency_in_progress', 'This request is still being processed. Try again shortly.');
      // Pending past the window: nothing of the earlier attempt committed (its first write would carry a receipt),
      // so it is safe to take over. The take-over is fenced: only one retry can win it.
      const taken = await db.prepare("UPDATE idempotency_records SET attempt = ?, created_at = ? WHERE id = ? AND state = 'pending' AND attempt = ?")
        .bind(attempt, at, id, row.attempt).run();
      if (!taken.meta.changes) throw new IdempotencyError('idempotency_in_progress', 'This request is still being processed. Try again shortly.');
    }
    const context = { db, used: false,
      statement: d => d.prepare("UPDATE idempotency_records SET state = 'committed' WHERE id = ? AND attempt = ? AND state = 'pending'").bind(id, attempt) };
    const finish = outcome => db.prepare("UPDATE idempotency_records SET state = 'done', result = ? WHERE id = ? AND attempt = ? AND state IN ('pending', 'committed')")
      .bind(JSON.stringify(outcome), id, attempt).run();
    let result;
    try {
      result = await writeReceipts.run(context, fn);
    } catch (error) {
      if (error instanceof ReceiptFenceError)
        throw new IdempotencyError('idempotency_superseded', 'A newer attempt of this request took over. Nothing from this attempt was saved.');
      if (error instanceof LogsError) {
        // A business refusal is this request's answer: replay it rather than run the operation again.
        await finish({ error: { code: error.code, status: error.status, message: error.message } });
      } else if (!context.used) {
        // Nothing committed: release the claim so a retry runs the operation.
        await db.prepare("DELETE FROM idempotency_records WHERE id = ? AND attempt = ? AND state = 'pending'").bind(id, attempt).run();
      }
      // Otherwise the effect committed and the record stays 'committed': never re-run.
      throw error;
    }
    const stored = JSON.stringify({ value: result ?? null });
    // An answer too large to keep is recorded as such; the operation is never re-run to recompute it.
    await finish(Buffer.byteLength(stored) > IDEMPOTENCY.maxResultBytes ? { value: null, resultTooLarge: true } : { value: result ?? null });
    return result ?? null;
  };
}

function replay(outcome) {
  if (outcome.error) throw new LogsError(outcome.error.code, outcome.error.status, outcome.error.message);
  if (outcome.resultTooLarge) throw new IdempotencyError('idempotency_result_unavailable', 'This request already completed; its result is too large to replay.');
  return outcome.value;
}
