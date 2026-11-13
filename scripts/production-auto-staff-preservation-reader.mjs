// Automatic releases use one fixed, paced SELECT. Raw staff/alias/token-hash
// rows remain transient here; unrelated consumers retain their CLI reader.
// Diagnostic transports deliberately reject this SQL: only their two reviewed
// metadata SELECTs are allowed. This reader does not expand that boundary.
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { POST0226_STAFF_PRESERVATION_QUERY, qualifyPost0226Snapshot,
  validatePost0226StaffPreservationReview } from './ordinary-frontend-authority-post0226.mjs';

const MAX_BYTES = 24 * 1024 * 1024, TIMEOUT_MS = 30_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Error('runtime_staff_preservation_read_refused'); };

export async function readProductionAutoStaffPreservation({ sourceCommit, token, fetchImpl = fetch,
  review = null, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '') || (review && review.sourceCommit !== sourceCommit)
    || typeof token !== 'string' || !/^[\x21-\x7e]{16,16384}$/u.test(token)
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) fail();
  const target = NATIVE_STAFF_PRODUCTION_TARGET, controller = new AbortController();
  let timer, reader;
  const started = now();
  if (!Number.isSafeInteger(started) || started < 0) fail();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error('runtime_staff_preservation_read_refused')); }, timeoutMs);
  });
  const operation = async () => {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: POST0226_STAFF_PRESERVATION_QUERY, params: [] }),
    });
    if (controller.signal.aborted || response?.status !== 200 || response.redirected) fail();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) fail();
    reader = response.body?.getReader();
    if (!reader) fail();
    const chunks = []; let size = 0;
    for (;;) {
      const next = await reader.read();
      if (controller.signal.aborted) fail();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) fail();
      chunks.push(Buffer.from(next.value));
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!object(body) || body.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0
      || !Array.isArray(body.result) || body.result.length !== 1) fail();
    const result = body.result[0], meta = result?.meta;
    if (!object(result) || result.success !== true || !object(meta)
      || !Array.isArray(result.results) || result.results.length !== 1) fail();
    const writeCounts = ['changes', 'rows_written', 'rowsWritten'];
    if (!writeCounts.some(key => Object.hasOwn(meta, key)) && !Object.hasOwn(meta, 'changed_db')) fail();
    if (writeCounts.some(key => Object.hasOwn(meta, key) && (!Number.isSafeInteger(meta[key]) || meta[key] !== 0))
      || (Object.hasOwn(meta, 'changed_db') && meta.changed_db !== false)) fail();
    const ids = [result.database_id, result.databaseId, result.uuid, meta.database_id, meta.databaseId, meta.uuid];
    if (ids.some(value => value !== undefined && value !== target.databaseId)) fail();
    const row = result.results[0];
    if (!object(row) || Object.keys(row).length !== 1 || typeof row.frontend_authority_snapshot !== 'string'
      || Buffer.byteLength(row.frontend_authority_snapshot) > MAX_BYTES) fail();
    const raw = JSON.parse(row.frontend_authority_snapshot), finished = now();
    if (!Number.isSafeInteger(finished) || finished < started || finished - started > timeoutMs) fail();
    const observation = await qualifyPost0226Snapshot(raw, {
      sourceCommit, observedAt: new Date(started).toISOString(), now: finished,
    });
    if (controller.signal.aborted || now() < started || now() - started > timeoutMs) fail();
    return review ? validatePost0226StaffPreservationReview(review, observation, { sourceCommit, now: now() }) : observation;
  };
  try { return await Promise.race([operation(), deadline]); }
  catch { fail(); }
  finally { clearTimeout(timer); controller.abort(); try { void reader?.cancel().catch(() => {}); } catch {} }
}
