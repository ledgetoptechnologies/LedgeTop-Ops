'use strict';

// Journal accounting only: callers must separately reserve/attest physical
// database and archive capacity and control all writers. The policy must be
// server-owned configuration, never supplied by an API request. No default
// quota is chosen here. The caller must own a BEGIN IMMEDIATE transaction
// spanning this check and insertion. isTransaction verifies only that some
// transaction exists; it cannot distinguish IMMEDIATE from DEFERRED.
function unavailable() {
  return Object.assign(new Error('GCP source storage capacity policy is unavailable'), {code:'gcp_capacity_unavailable'});
}
function exhausted() {
  return Object.assign(new Error('GCP source storage is full; the original file was not saved'), {code:'gcp_capacity_exceeded'});
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function requireRawJournalPolicy(policy) {
  if (!policy || typeof policy !== 'object' || !positive(policy.maxJournalBytes) || !positive(policy.maxJournalEntries)) throw unavailable();
}

function assertRawJournalCapacity(db, policy, incomingBytes) {
  requireRawJournalPolicy(policy);
  if (!db || db.isTransaction !== true || !positive(incomingBytes)) throw unavailable();
  let usage;
  try {
    usage = db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(length(source_bytes)), 0) AS bytes, COALESCE(SUM(CASE WHEN typeof(source_bytes) <> 'blob' OR length(source_bytes) = 0 THEN 1 ELSE 0 END), 0) AS invalid FROM viewer_gcp_raw_sources").get();
  } catch { throw unavailable(); }
  if (!Number.isSafeInteger(usage?.entries) || usage.entries < 0 ||
      !Number.isSafeInteger(usage?.bytes) || usage.bytes < 0 || usage.invalid !== 0) throw unavailable();
  // BigInt avoids precision loss when current usage plus the new request is
  // greater than MAX_SAFE_INTEGER. Count pending and ready rows equally.
  if (BigInt(usage.entries) + 1n > BigInt(policy.maxJournalEntries) ||
      BigInt(usage.bytes) + BigInt(incomingBytes) > BigInt(policy.maxJournalBytes)) throw exhausted();
}

module.exports={assertRawJournalCapacity,requireRawJournalPolicy};
