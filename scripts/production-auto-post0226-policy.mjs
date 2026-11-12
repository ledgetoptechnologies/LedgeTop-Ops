/** Fixed-state policy for recurring Operations staff/login preservation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_LOGIN_TABLES, POST0226_STAFF_PRESERVATION_CONTRACT } from './ordinary-frontend-authority-post0226.mjs';
import { PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS,
  PRODUCTION_AUTO_FIXED_OPS_PRESERVATION_FENCES,
  PRODUCTION_AUTO_POSTBUILD_PRESERVATION_REFRESHES } from './production-auto-limits.mjs';

export const PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_CONTRACT = 'production-auto-post0226-preservation-policy-v1';
export const PRODUCTION_AUTO_POST0226_PRESERVATION_RECEIPT_CONTRACT = 'production-auto-post0226-preservation-receipt-v1';
export const PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_SHA256 = '915025b52c29bc69ad8c92e503f4df2c9084f41157d0b148f4430de67dc91e33';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = path.join(ROOT, 'scripts/production-auto-post0226-preservation-policy.json');
const MAX_AGE_MS = 60_000;
// Each automatic worker job has a 45-minute timeout; scope this in-process
// receipt sequence to that same maximum.
const MAX_RECEIPT_SEQUENCE_MS = 45 * 60_000;
// The retained-release journal's total intent cap reserves the required
// non-bucket mutations and permits up to 243 asset-bucket intents. Ops
// preservation reads occur at seven additional fixed coordinator fences:
// initial source/CI, asset-session, version upload, inactive readback, stage-zero,
// activation, and final active acceptance. Temporary-verifier fences are
// separate and do not add sourceAndCi receipts. One post-build refresh is
// additionally reserved if the initial receipt expired during build, before
// the first temporary verifier mutation; that refresh is one-shot. Each of
// B+10 noncleanup mutation intents adds one post-journal read. Thus the
// exact upper bound is (B+7+1)+(B+10)=2B+18, within the same 45-minute session.
export const PRODUCTION_AUTO_POST0226_MAX_RECEIPTS = PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS
  + PRODUCTION_AUTO_FIXED_OPS_PRESERVATION_FENCES + PRODUCTION_AUTO_POSTBUILD_PRESERVATION_REFRESHES
  + PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS + 10;
const MAX_ROWS = 20_000;
const COMMIT = /^[a-f0-9]{40}$/u, SHA = /^[a-f0-9]{64}$/u;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const same = (a, b) => canonicalStaffReadiness(a) === canonicalStaffReadiness(b);
const PREVALIDATED_RECEIPTS = new WeakSet();
const fail = code => { throw Error(`production_auto_post0226_policy:${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

const OBSERVATION_KEYS = Object.freeze(['schemaVersion','contract','sourceCommit','accountId','databaseId','observedAt',
  'baseSnapshotSha256','baseTableCounts','loginSchemaSha256','loginRows','loginRowsSha256','bridgeMismatchCount',
  'nativeControlEnabled','legacyActiveStaffCount','preservationOnly','fullStaffCutoverReadiness','aliasLinkingAuthorized','schemaSha256']);
const BASELINE_KEYS = Object.freeze(['baseSnapshotSha256','baseTableCounts','loginSchemaSha256','loginRows','loginRowsSha256',
  'bridgeMismatchCount','nativeControlEnabled','legacyActiveStaffCount','preservationOnly','fullStaffCutoverReadiness','aliasLinkingAuthorized']);
const POLICY_KEYS = Object.freeze(['schemaVersion','contract','accountId','databaseId','maximumObservationAgeMs','baseline']);
const RECEIPT_KEYS = Object.freeze(['schemaVersion','contract','sourceCommit','accountId','databaseId','observedAt','policySha256',
  'stateSha256','baseSnapshotSha256','baseTableCounts','loginSchemaSha256','loginRows','loginRowsSha256','bridgeMismatchCount',
  'nativeControlEnabled','legacyActiveStaffCount','preservationOnly','fullStaffCutoverReadiness','aliasLinkingAuthorized']);

function policyBaseline(observation) {
  return Object.fromEntries(BASELINE_KEYS.map(key => [key, structuredClone(observation[key])]));
}

function validateObservationShape(observation, { sourceCommit, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15
    || !exact(observation, OBSERVATION_KEYS) || observation.schemaVersion !== 1
    || observation.contract !== POST0226_STAFF_PRESERVATION_CONTRACT || observation.sourceCommit !== sourceCommit
    || !COMMIT.test(sourceCommit ?? '') || observation.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId
    || observation.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId || !stamp(observation.observedAt)
    || Date.parse(observation.observedAt) > now || now - Date.parse(observation.observedAt) > MAX_AGE_MS
    || !SHA.test(observation.baseSnapshotSha256 ?? '') || !SHA.test(observation.loginSchemaSha256 ?? '')
    || observation.schemaSha256 !== observation.loginSchemaSha256 || !SHA.test(observation.loginRowsSha256 ?? '')
    || !Number.isSafeInteger(observation.bridgeMismatchCount) || observation.bridgeMismatchCount < 0 || observation.bridgeMismatchCount > MAX_ROWS
    || observation.nativeControlEnabled !== 0 || !Number.isSafeInteger(observation.legacyActiveStaffCount)
    || observation.legacyActiveStaffCount < 1 || observation.legacyActiveStaffCount > MAX_ROWS
    || observation.preservationOnly !== true || observation.fullStaffCutoverReadiness !== false
    || observation.aliasLinkingAuthorized !== false || !exact(observation.baseTableCounts, Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES))
    || Object.values(observation.baseTableCounts).some(count => !Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS)
    || !exact(observation.loginRows, Object.keys(POST0226_LOGIN_TABLES))
    || Object.values(observation.loginRows).some(value => !exact(value, ['count','sha256'])
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_ROWS || !SHA.test(value.sha256 ?? ''))
    || hash(canonicalStaffReadiness(observation.loginRows)) !== observation.loginRowsSha256)
    fail('observation_invalid_or_stale');
  return policyBaseline(observation);
}

/** Compile only from the sanitized summary returned by the qualified read-only reader. */
export function compileProductionAutoPost0226PreservationPolicy(observation, { sourceCommit, now = Date.now() } = {}) {
  const baseline = validateObservationShape(observation, { sourceCommit, now });
  const policy = { schemaVersion: 1, contract: PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_CONTRACT,
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    maximumObservationAgeMs: MAX_AGE_MS, baseline };
  return Object.freeze({ policy, policySha256: hash(canonicalStaffReadiness(policy)),
    provenance: Object.freeze({ sourceCommit, observedAt: observation.observedAt,
      observationSha256: hash(canonicalStaffReadiness(observation)) }),
    offlineOnly: true, activationEnabled: false });
}

export function validateProductionAutoPost0226PreservationPolicy(policy) {
  if (!exact(policy, POLICY_KEYS) || policy.schemaVersion !== 1
    || policy.contract !== PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_CONTRACT
    || policy.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId
    || policy.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId
    || policy.maximumObservationAgeMs !== MAX_AGE_MS || !exact(policy.baseline, BASELINE_KEYS)) fail('policy_invalid');
  const baseline = policy.baseline;
  if (!SHA.test(baseline.baseSnapshotSha256 ?? '') || !SHA.test(baseline.loginSchemaSha256 ?? '')
    || !SHA.test(baseline.loginRowsSha256 ?? '') || baseline.nativeControlEnabled !== 0
    || baseline.preservationOnly !== true || baseline.fullStaffCutoverReadiness !== false
    || baseline.aliasLinkingAuthorized !== false || !Number.isSafeInteger(baseline.bridgeMismatchCount)
    || baseline.bridgeMismatchCount < 0 || baseline.bridgeMismatchCount > MAX_ROWS
    || !Number.isSafeInteger(baseline.legacyActiveStaffCount) || baseline.legacyActiveStaffCount < 1
    || baseline.legacyActiveStaffCount > MAX_ROWS || !exact(baseline.baseTableCounts, Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES))
    || Object.values(baseline.baseTableCounts).some(count => !Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS)
    || !exact(baseline.loginRows, Object.keys(POST0226_LOGIN_TABLES))
    || Object.values(baseline.loginRows).some(value => !exact(value, ['count','sha256'])
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_ROWS || !SHA.test(value.sha256 ?? ''))
    || hash(canonicalStaffReadiness(baseline.loginRows)) !== baseline.loginRowsSha256) fail('policy_baseline_invalid');
  return policy;
}

/** Validate each fresh read against the fixed public state policy. No database
 * rows or staff identity values enter the returned receipt. */
export function validateProductionAutoPost0226PreservationObservation(policy, observation,
  { sourceCommit, now = Date.now() } = {}) {
  validateProductionAutoPost0226PreservationPolicy(policy);
  const baseline = validateObservationShape(observation, { sourceCommit, now });
  if (!same(baseline, policy.baseline)) fail('preservation_state_changed');
  const policySha256 = hash(canonicalStaffReadiness(policy));
  const receipt = { schemaVersion: 1, contract: PRODUCTION_AUTO_POST0226_PRESERVATION_RECEIPT_CONTRACT,
    sourceCommit, accountId: policy.accountId, databaseId: policy.databaseId, observedAt: observation.observedAt,
    policySha256, stateSha256: hash(canonicalStaffReadiness(baseline)), ...structuredClone(baseline) };
  PREVALIDATED_RECEIPTS.add(receipt);
  return receipt;
}

function validateReceipt(policy, receipt, { sourceCommit, now = Date.now(), requireFresh } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15
    || !exact(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== 1
    || receipt.contract !== PRODUCTION_AUTO_POST0226_PRESERVATION_RECEIPT_CONTRACT
    || receipt.sourceCommit !== sourceCommit || !COMMIT.test(sourceCommit ?? '')
    || receipt.accountId !== policy.accountId || receipt.databaseId !== policy.databaseId
    || !stamp(receipt.observedAt) || Date.parse(receipt.observedAt) > now
    || (requireFresh && now - Date.parse(receipt.observedAt) > MAX_AGE_MS)
    || receipt.policySha256 !== hash(canonicalStaffReadiness(policy))) fail('receipt_invalid_or_stale');
  const timestamp = Date.parse(receipt.observedAt);
  const baseline = Object.fromEntries(BASELINE_KEYS.map(key => [key, receipt[key]]));
  if (!exact(receipt.baseTableCounts, Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES))
    || !exact(receipt.loginRows, Object.keys(POST0226_LOGIN_TABLES))
    || Object.values(receipt.loginRows).some(value => !exact(value, ['count','sha256']))
    || !same(baseline, policy.baseline)
    || receipt.stateSha256 !== hash(canonicalStaffReadiness(baseline))) fail('receipt_state_mismatch');
  return { receipt: structuredClone(receipt), timestamp };
}

/** Validate one receipt at the current mutation/read fence. Call this for each
 * newly observed state; each read must remain no older than 60 seconds. */
export function validateProductionAutoPost0226PreservationReceipt(policy, receipt,
  { sourceCommit, now = Date.now() } = {}) {
  validateProductionAutoPost0226PreservationPolicy(policy);
  const validated = validateReceipt(policy, receipt, { sourceCommit, now, requireFresh: true }).receipt;
  PREVALIDATED_RECEIPTS.add(validated);
  return validated;
}

/** Recheck the exact receipt captured by this process immediately before a
 * provider dispatch. This does not read or refresh state; expired evidence
 * holds the already-journaled mutation intent without sending the request. */
export function assertProductionAutoPost0226PreservationReceiptFresh(policy, receipt,
  { sourceCommit, now = Date.now() } = {}) {
  validateProductionAutoPost0226PreservationPolicy(policy);
  if (!PREVALIDATED_RECEIPTS.has(receipt)) fail('dispatch_receipt_not_prevalidated_in_run');
  validateReceipt(policy, receipt, { sourceCommit, now, requireFresh: true });
  return true;
}

/** Require repeat observations during one release to be byte-identical after
 * removing only their timestamp. Prior entries are structurally/digest checked
 * but may be older than 60 seconds; the just-observed receipt must be fresh.
 * The sequence is monotonic, one source/run, at most the qualified intent/fence
 * bound, and at most 45m. */
export function validateRepeatedProductionAutoPost0226PreservationReceipts(policy, receipts,
  { sourceCommit, now = Date.now() } = {}) {
  validateProductionAutoPost0226PreservationPolicy(policy);
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) fail('repeated_receipt_clock_invalid');
  if (!Array.isArray(receipts) || receipts.length < 2 || receipts.length > PRODUCTION_AUTO_POST0226_MAX_RECEIPTS)
    fail('repeated_receipts_required');
  const timestamps = [];
  const normalized = receipts.map(receipt => {
    const validated = validateReceipt(policy, receipt, { sourceCommit, now, requireFresh: false });
    if (!PREVALIDATED_RECEIPTS.has(receipt)) fail('repeated_receipt_not_prevalidated_in_run');
    timestamps.push(validated.timestamp);
    const comparable = { ...validated.receipt }; delete comparable.observedAt;
    return comparable;
  });
  if (timestamps.some((timestamp, index) => index > 0 && timestamp < timestamps[index - 1]))
    fail('repeated_receipt_time_order_invalid');
  if (timestamps.at(-1) > now || now - timestamps.at(-1) > MAX_AGE_MS)
    fail('repeated_receipt_latest_stale');
  if (timestamps.at(-1) - timestamps[0] > MAX_RECEIPT_SEQUENCE_MS)
    fail('repeated_receipt_sequence_too_long');
  if (normalized.some(receipt => !same(receipt, normalized[0]))) fail('repeated_receipt_drift');
  return Object.freeze({ count: receipts.length, stableStateSha256: normalized[0].stateSha256,
    latestObservedAt: receipts.at(-1).observedAt });
}

/** Production loader has no path/env override and accepts only the fixed pin. */
export function loadPinnedProductionAutoPost0226PreservationPolicy() {
  if (!SHA.test(PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_SHA256)) fail('policy_unprovisioned');
  let stat;
  try { stat = fs.lstatSync(POLICY_PATH); } catch { fail('policy_file_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 64 * 1024)
    fail('policy_file_invalid');
  const bytes = fs.readFileSync(POLICY_PATH);
  if (bytes.length !== stat.size) fail('policy_file_changed');
  let policy;
  try { policy = JSON.parse(bytes.toString('utf8')); } catch { fail('policy_file_json_invalid'); }
  if (hash(canonicalStaffReadiness(policy)) !== PRODUCTION_AUTO_POST0226_PRESERVATION_POLICY_SHA256) fail('policy_pin_mismatch');
  return validateProductionAutoPost0226PreservationPolicy(policy);
}
