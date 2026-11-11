/** Offer only the server-authorized existing-result ingest recovery. */
export function canRecoverExistingResult(diagnostic, canWrite) {
  return canWrite === true && diagnostic?.loading !== true && !diagnostic?.error
    && diagnostic?.recovery?.kind === 'ingest' && diagnostic.recovery.available === true;
}

/** The caller supplies the normal authenticated mutation helper. */
export function recoverExistingResult(diagnostic, canWrite, attemptId, mutate) {
  if (!canRecoverExistingResult(diagnostic, canWrite) || typeof attemptId !== 'string'
      || !attemptId || attemptId.length > 128 || typeof mutate !== 'function') return;
  return mutate(`/api/v1/attempts/${encodeURIComponent(attemptId)}/recover-ingest`,
    { method: 'POST', body: {} }, 'Existing result recovery queued');
}
