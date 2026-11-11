/** Offer only the server-authorized existing-result ingest recovery. */
export function canRecoverExistingResult(diagnostic, canWrite) {
  return canWrite === true && diagnostic?.loading !== true && !diagnostic?.error
    && diagnostic?.recovery?.kind === 'ingest' && diagnostic.recovery.available === true;
}

/** The caller supplies the normal authenticated mutation helper. */
export async function recoverExistingResult(diagnostic, canWrite, attemptId, mutate, refresh) {
  if (!canRecoverExistingResult(diagnostic, canWrite) || typeof attemptId !== 'string'
      || !attemptId || attemptId.length > 128 || typeof mutate !== 'function') return;
  const result = await mutate(`/api/v1/attempts/${encodeURIComponent(attemptId)}/recover-ingest`,
    { method: 'POST', body: {} }, 'Existing result recovery queued');
  if (result) {
    // Never leave the old affirmative candidate actionable while fetching the
    // new server-authoritative eligibility after an accepted recovery.
    diagnostic.recovery = null;
    if (typeof refresh === 'function') await refresh();
  }
  return result;
}
