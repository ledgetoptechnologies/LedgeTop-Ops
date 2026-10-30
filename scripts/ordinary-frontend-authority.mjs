import { createHash } from 'node:crypto';
import { canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';

export const ORDINARY_FRONTEND_AUTHORITY_CONTRACT = 'ordinary-frontend-preserve-native-staff-v1';
export const ORDINARY_FRONTEND_AUTHORITY_REVIEW_MAX_AGE_MS = 30 * 60_000;
export const ORDINARY_FRONTEND_AUTHORITY_OBSERVATION_MAX_AGE_MS = 60_000;

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const fail = message => { throw new Error(`ordinary_frontend_authority:${message}`); };
const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => canonicalStaffReadiness(a) === canonicalStaffReadiness(b);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

const TABLE_KEYS = Object.freeze(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES));
const SNAPSHOT_KEYS = Object.freeze(['schemaSha256','bridgeMismatchCount','nativeStaffCohort','controlPlane',
  'nativeControlCandidates','tables']);
const OBSERVATION_KEYS = Object.freeze(['schemaVersion','accountId','databaseId','observedAt','snapshot']);
const REVIEW_KEYS = Object.freeze(['schemaVersion','contract','application','sourceCommit','accountId','databaseId',
  'reviewedAt','expiresAt','snapshotObservedAt','snapshotSha256','snapshot']);
const COHORT_KEYS = Object.freeze(['staffId','email','accessSubject','displayName','legacyStatus','bridgeStatus',
  'nativeActive','admissionVersion','profileVersion']);
const CONTROL_PLANE_KEYS = Object.freeze(['staff_id','bound_access_subject','admission_version','profile_version']);

function validateReviewedSnapshot(value) {
  if (!exact(value, SNAPSHOT_KEYS) || !SHA.test(value.schemaSha256 ?? '')
    || !Number.isSafeInteger(value.bridgeMismatchCount) || value.bridgeMismatchCount < 0 || value.bridgeMismatchCount > 20_000
    || !exact(value.tables, TABLE_KEYS)) fail('snapshot_shape_invalid');
  for (const [table, keys] of Object.entries(ORDINARY_FRONTEND_AUTHORITY_TABLES)) {
    const rows = value.tables[table];
    if (!Array.isArray(rows) || rows.length > 20_000 || rows.some(row => !exact(row, keys))) fail(`snapshot_${table}_invalid`);
  }
  const staff = value.tables.staff_users;
  if (!staff.length || staff.length > 20_000 || staff.some(row => typeof row.id !== 'string' || !STAFF_ID.test(row.id)
    || typeof row.email !== 'string' || typeof row.display_name !== 'string'
    || (row.access_subject !== null && typeof row.access_subject !== 'string')
    || !['active','inactive'].includes(row.status)) || new Set(staff.map(row => row.id)).size !== staff.length
    || !staff.some(row => row.status === 'active')) fail('legacy_staff_cohort_invalid');
  const staffIds = new Set(staff.map(row => row.id));
  if (!Array.isArray(value.nativeStaffCohort) || value.nativeStaffCohort.length > 20_000
    || value.nativeStaffCohort.some(row => !exact(row, COHORT_KEYS) || typeof row.staffId !== 'string'
      || !staffIds.has(row.staffId) || typeof row.email !== 'string' || typeof row.displayName !== 'string'
      || (row.accessSubject !== null && typeof row.accessSubject !== 'string')
      || !['active','inactive'].includes(row.legacyStatus)
      || !['matched','not_admitted','profile_missing','identity_mismatch','display_name_mismatch','status_mismatch'].includes(row.bridgeStatus)
      || (row.nativeActive !== null && row.nativeActive !== 0 && row.nativeActive !== 1)
      || (row.admissionVersion !== null && (!Number.isSafeInteger(row.admissionVersion) || row.admissionVersion < 1))
      || (row.profileVersion !== null && (!Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1)))) fail('native_staff_cohort_invalid');
  const controlRows = value.tables.native_staff_access_reconciliation;
  if (controlRows.length !== 1) fail('native_staff_control_missing');
  const control = controlRows[0];
  if (control.singleton !== 1 || control.enabled !== 0 || !Number.isSafeInteger(control.generation) || control.generation < 0
    || control.applied_generation !== control.generation || control.lease_id !== null || control.lease_until !== null
    || control.attempt_generation !== null || control.last_error !== null) fail('disabled_control_baseline_required');
  if (!Array.isArray(value.controlPlane) || value.controlPlane.length > 1024
    || value.controlPlane.some(row => !exact(row, CONTROL_PLANE_KEYS) || typeof row.staff_id !== 'string'
      || !STAFF_ID.test(row.staff_id) || !staffIds.has(row.staff_id)
      || typeof row.bound_access_subject !== 'string' || !Number.isSafeInteger(row.admission_version)
      || !Number.isSafeInteger(row.profile_version))) fail('control_plane_snapshot_invalid');
  if (!Array.isArray(value.nativeControlCandidates) || value.nativeControlCandidates.length > 1024
    || value.nativeControlCandidates.some(row => !exact(row, CONTROL_PLANE_KEYS) || typeof row.staff_id !== 'string'
      || !STAFF_ID.test(row.staff_id) || !staffIds.has(row.staff_id)
      || typeof row.bound_access_subject !== 'string' || !Number.isSafeInteger(row.admission_version)
      || !Number.isSafeInteger(row.profile_version))) fail('native_control_candidates_invalid');
  for (const row of value.nativeStaffCohort) {
    const corresponding = staff.find(person => person.id === row.staffId);
    if (!corresponding || row.legacyStatus !== corresponding.status) fail('bridge_staff_link_invalid');
  }
  let bytes;
  try { bytes = Buffer.byteLength(canonicalStaffReadiness(value)); } catch { fail('snapshot_encoding_invalid'); }
  if (bytes < 1 || bytes > 20 * 1024 * 1024) fail('snapshot_too_large');
  return value;
}

/**
 * Validate an externally reviewed, short-lived Operations frontend-only packet
 * against a fresh read-only snapshot. It pins the exact legacy staff cohort and
 * permission surfaces plus any present native staff records while keeping
 * native control disabled. It neither grants authority nor infers identity
 * from email or Project Alpha roles. Packet creation and review remain external.
 */
export function validateOrdinaryFrontendAuthorityObservation(review, observation, { sourceCommit, application = 'operations', now = Date.now() } = {}) {
  if (application !== 'operations' || !COMMIT.test(sourceCommit ?? '') || !Number.isSafeInteger(now)
    || !exact(review, REVIEW_KEYS) || review.schemaVersion !== 1
    || review.contract !== ORDINARY_FRONTEND_AUTHORITY_CONTRACT || review.application !== application
    || review.sourceCommit !== sourceCommit || review.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId
    || review.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId) fail('review_identity_invalid');
  if (!timestamp(review.reviewedAt) || !timestamp(review.expiresAt) || !timestamp(review.snapshotObservedAt)
    || Date.parse(review.reviewedAt) > now || Date.parse(review.snapshotObservedAt) > Date.parse(review.reviewedAt)
    || Date.parse(review.reviewedAt) - Date.parse(review.snapshotObservedAt) > ORDINARY_FRONTEND_AUTHORITY_OBSERVATION_MAX_AGE_MS
    || Date.parse(review.expiresAt) <= now
    || Date.parse(review.expiresAt) - Date.parse(review.reviewedAt) > ORDINARY_FRONTEND_AUTHORITY_REVIEW_MAX_AGE_MS) fail('review_expired_or_stale');
  const reviewedSnapshot = validateReviewedSnapshot(review.snapshot);
  const snapshotSha256 = hash(canonicalStaffReadiness(reviewedSnapshot));
  if (!SHA.test(review.snapshotSha256 ?? '') || snapshotSha256 !== review.snapshotSha256) fail('review_snapshot_digest_invalid');
  if (!exact(observation, OBSERVATION_KEYS) || observation.schemaVersion !== 1
    || observation.accountId !== review.accountId || observation.databaseId !== review.databaseId
    || !timestamp(observation.observedAt) || Date.parse(observation.observedAt) > now
    || now - Date.parse(observation.observedAt) > ORDINARY_FRONTEND_AUTHORITY_OBSERVATION_MAX_AGE_MS) fail('observation_stale_or_invalid');
  const currentSnapshot = validateReviewedSnapshot(observation.snapshot);
  if (!same(currentSnapshot, reviewedSnapshot)) fail('reviewed_staff_or_control_state_changed');
  const nativeStaffActiveCount = currentSnapshot.nativeStaffCohort.filter(row => row.nativeActive === 1).length;
  return Object.freeze({ schemaVersion: 1, contract: ORDINARY_FRONTEND_AUTHORITY_CONTRACT,
    sourceCommit, accountId: review.accountId, databaseId: review.databaseId,
    reviewSha256: hash(canonicalStaffReadiness(review)), snapshotSha256, observedAt: observation.observedAt,
    legacyActiveStaffCount: currentSnapshot.tables.staff_users.filter(row => row.status === 'active').length,
    nativeStaffCount: currentSnapshot.nativeStaffCohort.length, nativeStaffActiveCount,
    controlPlaneCount: currentSnapshot.controlPlane.length, nativeControlCandidateCount: currentSnapshot.nativeControlCandidates.length,
    bridgeMismatchCount: currentSnapshot.bridgeMismatchCount,
    controlEnabled: 0, controlGeneration: currentSnapshot.tables.native_staff_access_reconciliation[0].generation });
}
