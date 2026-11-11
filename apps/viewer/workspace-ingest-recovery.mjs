/** Offer only the server-authorized existing-result ingest recovery. */
export function canRecoverExistingResult(diagnostic, canWrite) {
  return canWrite === true && diagnostic?.loading !== true && !diagnostic?.error
    && diagnostic?.recovery?.kind === 'ingest' && diagnostic.recovery.available === true;
}
const inFlight = new Set();
const storageKey = attemptId => `ltds-viewer-ingest-recovery:${attemptId}`;
const MAX_INTENT_AGE_MS = 14 * 60 * 1000; // pending server receipts can be reclaimed after 15 minutes
function validBinding(session) { return typeof session?.id === 'string' && !!session.id && typeof session?.subject === 'string' && !!session.subject; }
function bindingMatches(intent, session, now) {
  const age = now - intent.createdAt;
  return validBinding(session) && intent.sessionId === session.id && intent.subject === session.subject
    && Number.isFinite(age) && age >= 0 && age < MAX_INTENT_AGE_MS
    && Date.parse(session.expiresAt || '') > now;
}

/** Preserve an uncertain request only within the exact server receipt binding. */
export async function recoverExistingResult(diagnostic, canWrite, attemptId, mutate, refresh,
  { storage = globalThis.sessionStorage, makeId = () => globalThis.crypto.randomUUID(),
    getSession = () => null, now = () => Date.now(), onUncertain = () => {}, onHold = () => {} } = {}) {
  if (!canRecoverExistingResult(diagnostic, canWrite) || typeof attemptId !== 'string'
      || !attemptId || attemptId.length > 128 || typeof mutate !== 'function'
      || typeof refresh !== 'function' || inFlight.has(attemptId)) return;
  const key = storageKey(attemptId), session = getSession();
  let intent;
  try {
    const raw = storage.getItem(key);
    if (raw) intent = JSON.parse(raw);
    else {
      if (!validBinding(session)) { onHold(); return; }
      intent = { key: makeId(), sessionId: session.id, subject: session.subject, createdAt: now() };
      storage.setItem(key, JSON.stringify(intent));
    }
    if (typeof intent.key !== 'string' || !intent.key || !bindingMatches(intent, session, now())) { onHold(); return; }
    if (storage.getItem(key) !== JSON.stringify(intent)) { onHold(); return; }
  } catch { onHold(); return; }
  const guard = () => bindingMatches(intent, getSession(), now()) && getSession()?.permissions?.includes('viewer.processing.write') === true;
  inFlight.add(attemptId);
  diagnostic.recovery = null;
  try {
    let failure, submitted = false;
    const result = await mutate(`/api/v1/attempts/${encodeURIComponent(attemptId)}/recover-ingest`,
      { method: 'POST', body: {}, headers: { 'Idempotency-Key': intent.key }, recoveryGuard: guard },
      'Existing result recovery queued', (error, state) => { failure = error; submitted = state?.submitted === true; });
    const definiteRejection = !submitted && failure && failure.status >= 400 && failure.status < 500 && failure.code !== 'idempotency_in_progress';
    if (result || definiteRejection) { try { storage.removeItem(key); } catch { /* retain safely */ } }
    else onUncertain();
    return result;
  } finally {
    try { await refresh(); } finally { inFlight.delete(attemptId); }
  }
}
