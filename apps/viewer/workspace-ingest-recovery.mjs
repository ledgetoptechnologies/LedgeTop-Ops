/** Offer only the server-authorized existing-result ingest recovery. */
export function canRecoverExistingResult(diagnostic, canWrite) {
  return canWrite === true && diagnostic?.loading !== true && !diagnostic?.error
    && diagnostic?.recovery?.kind === 'ingest' && diagnostic.recovery.available === true;
}

const inFlight = new Set();
const storageKey = attemptId => `ltds-viewer-ingest-recovery:${attemptId}`;

/** Preserve a request identity across ambiguous outcomes and page refreshes. */
export async function recoverExistingResult(diagnostic, canWrite, attemptId, mutate, refresh,
  { storage = globalThis.sessionStorage, makeId = () => globalThis.crypto.randomUUID(), onUncertain = () => {} } = {}) {
  if (!canRecoverExistingResult(diagnostic, canWrite) || typeof attemptId !== 'string'
      || !attemptId || attemptId.length > 128 || typeof mutate !== 'function'
      || typeof refresh !== 'function' || inFlight.has(attemptId)) return;
  const key = storageKey(attemptId);
  let intent;
  try {
    intent = storage.getItem(key);
    if (!intent) { intent = makeId(); storage.setItem(key, intent); }
    if (!intent || storage.getItem(key) !== intent) return;
  } catch { return; } // Without durable session identity a retry cannot be safe.
  inFlight.add(attemptId);
  diagnostic.recovery = null; // no stale affirmative authorization during the request
  try {
    let failure, submitted = false;
    const result = await mutate(`/api/v1/attempts/${encodeURIComponent(attemptId)}/recover-ingest`,
      { method: 'POST', body: {}, headers: { 'Idempotency-Key': intent } }, 'Existing result recovery queued', (error, state) => { failure = error; submitted = state?.submitted === true; });
    // Do not discard the key on failure: the server may have accepted the request.
    const definiteRejection = !submitted && failure && failure.status >= 400 && failure.status < 500 && failure.code !== 'idempotency_in_progress';
    if (result || definiteRejection) { try { storage.removeItem(key); } catch { /* retaining a key is safer */ } }
    else onUncertain();
    return result;
  } finally {
    try { await refresh(); } finally { inFlight.delete(attemptId); }
  }
}
