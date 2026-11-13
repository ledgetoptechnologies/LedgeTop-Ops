/** One fixed read-only capture witness, followed by a separate new-run
 * supersession admission. Neither a JSON object nor a selector grants it. */
import { createHash } from 'node:crypto';
import { canonical, scriptRuntimeShape } from './production-deploy.mjs';
import { OWNED_INACTIVE_CLIENT_POLICY as POLICY, ownedInactivePolicySHA256,
  isVerifiedPinnedOwnedInactiveCustody } from './production-auto-owned-inactive-policy.mjs';
import { assertOwnedUploadAnnotations } from './production-auto-upload-tag.mjs';

const witnesses = new WeakMap(), admissions = new WeakMap();
const keys = ['accountId','workerName','sourceCommit','ciRunId','ciRunAttempt','workflowRunId','workflowRunAttempt'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = condition => { if (!condition) throw Error('owned_inactive_admission_refused'); };
export function readOwnedInactiveSelector(env, workerName, { diagnostic = false } = {}) {
  const value = env.PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED;
  need(value === undefined || value === '' || value === 'false' || value === 'true');
  if (value !== 'true') return false;
  need(workerName === POLICY.workerName && diagnostic === false); return true;
}
function identity(value) {
  need(value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
  need(value.accountId === POLICY.accountId && value.workerName === POLICY.workerName
    && /^[a-f0-9]{40}$/u.test(value.sourceCommit ?? '') && value.sourceCommit !== POLICY.oldSourceCommit
    && ['ciRunId','ciRunAttempt','workflowRunId','workflowRunAttempt'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)
    && value.ciRunId !== POLICY.oldCiRunId && value.workflowRunId !== POLICY.oldReleaseRunId);
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
function sameIdentity(actual, expected) { return canonical(actual) === canonical(identity(expected)); }
function ciMatches(ci, value) {
  need(ci?.passed === true && ci.sourceCommit === value.sourceCommit
    && ci.runId === value.ciRunId && ci.runAttempt === value.ciRunAttempt);
}
export function ownedInactiveExpectedAdmissionDigest(value) {
  return hash(Buffer.from(canonical({ schemaVersion: 1, policySHA256: ownedInactivePolicySHA256(),
    operationSHA256: POLICY.oldOperationSha256, journalHead: POLICY.journalHead,
    artifactDigestSHA256: POLICY.artifactSha256, identity: identity(value) })));
}
export function createOwnedInactiveCaptureWitness({ custody, identity: supplied, ci }) {
  need(isVerifiedPinnedOwnedInactiveCustody(custody));
  const bound = identity(supplied); ciMatches(ci, bound);
  const witness = Object.freeze({ schemaVersion: 1, kind: 'owned-inactive-capture-only' });
  witnesses.set(witness, { identity: bound, custody, finalized: false });
  return witness;
}
function record(value, supplied) {
  const found = witnesses.get(value) ?? admissions.get(value);
  need(found && sameIdentity(found.identity, supplied)); return found;
}
export function ownedInactiveLatestForCapture(value, supplied) {
  record(value, supplied); return POLICY.priorInactiveCandidateVersionId;
}
function moduleHash(modern, name, expected) {
  const matches = modern?.modules?.filter(row => row?.name === name);
  need(matches?.length === 1 && typeof matches[0].content_base64 === 'string'
    && matches[0].content_base64.length > 0 && matches[0].content_base64.length <= 32 * 1024 * 1024);
  const encoded = matches[0].content_base64, bytes = Buffer.from(encoded, 'base64');
  need(bytes.toString('base64') === encoded && hash(bytes) === expected);
}
function protectedResources(resources) {
  const copy = structuredClone(resources);
  need(copy?.script && typeof copy.script === 'object');
  delete copy.script.etag; delete copy.script.last_deployed_from;
  copy.script_runtime = scriptRuntimeShape(copy.script_runtime); return copy;
}
/** Reuses actual latest metadata supplied by the normal complete capture.
 * This never reads C0's source map or treats C0 as activation-qualified. */
export function verifyOwnedInactivePendingCapture(value, supplied, snapshot, controlsSHA256) {
  record(value, supplied);
  const state = snapshot?.client;
  need(state?.version?.id === POLICY.parentVersionId && state.modern?.id === POLICY.parentVersionId
    && state.latest === POLICY.priorInactiveCandidateVersionId
    && state.latestVersion?.id === POLICY.priorInactiveCandidateVersionId
    && state.latestModern?.id === POLICY.priorInactiveCandidateVersionId
    && canonical(state.deployment?.versions) === canonical([{ version_id: POLICY.parentVersionId, percentage: 100 }])
    && controlsSHA256 === POLICY.priorCandidateEffectiveControlsSha256);
  assertOwnedUploadAnnotations(state, { workerName: POLICY.workerName, sourceCommit: POLICY.oldSourceCommit,
    candidateVersionId: POLICY.priorInactiveCandidateVersionId });
  need(state.latestVersion.resources?.script?.last_deployed_from === 'api'
    && typeof state.latestVersion.resources.script.etag === 'string' && state.latestVersion.resources.script.etag.length > 0
    && canonical(protectedResources(state.latestVersion.resources)) === canonical(protectedResources(state.version.resources))
    && canonical(state.latestModern.assets?.config) === canonical(state.modern.assets?.config));
  moduleHash(state.latestModern, 'index.js', POLICY.moduleSha256);
  moduleHash(state.latestModern, '__ops_release_ledger.json', POLICY.ledgerSha256);
  return true;
}
export function finalizeOwnedInactiveAdmission({ witness, identity: supplied, ci, snapshot, baseline }) {
  const found = witnesses.get(witness);
  need(found && !found.finalized && sameIdentity(found.identity, supplied)); ciMatches(ci, found.identity);
  verifyOwnedInactivePendingCapture(witness, supplied, snapshot, baseline?.controlsSHA256);
  need(baseline.activeVersionId === POLICY.parentVersionId && baseline.latestVersionId === POLICY.priorInactiveCandidateVersionId
    && canonical(baseline.versions) === canonical([{ versionId: POLICY.parentVersionId, percentage: 100 }]));
  const admission = Object.freeze({ schemaVersion: 1, proofSHA256: ownedInactiveExpectedAdmissionDigest(found.identity) });
  admissions.set(admission, { identity: found.identity, custody: found.custody,
    baseline: structuredClone(baseline), claimed: false });
  found.finalized = true; return admission;
}
export function isOwnedInactiveAdmission(value, supplied) {
  try { const found = admissions.get(value); return !!found && sameIdentity(found.identity, supplied); } catch { return false; }
}
export function ownedInactiveInitialStateAllowed(value, supplied, baseline) {
  try { const found = admissions.get(value); return !!found && !found.claimed
    && sameIdentity(found.identity, supplied) && canonical(found.baseline) === canonical(baseline); } catch { return false; }
}
export function ownedInactiveCoordinatorStateAllowed(value, { accountId, workerName, sourceCommit, ci, baseline }) {
  try {
    const found = admissions.get(value);
    return !!found && !found.claimed && found.identity.accountId === accountId
      && found.identity.workerName === workerName && found.identity.sourceCommit === sourceCommit
      && ci?.passed === true && ci.sourceCommit === sourceCommit && ci.runId === found.identity.ciRunId
      && ci.runAttempt === found.identity.ciRunAttempt && canonical(found.baseline) === canonical(baseline);
  } catch { return false; }
}
export function claimOwnedInactiveAdmission(value, supplied) {
  const found = admissions.get(value); need(found && !found.claimed && sameIdentity(found.identity, supplied));
  found.claimed = true; return value.proofSHA256;
}
export function ownedInactiveProviderParentAllowed(value, supplied, state) {
  try {
    const found = admissions.get(value); return !!found && found.claimed && sameIdentity(found.identity, supplied)
      && state?.version?.id === POLICY.parentVersionId && state.latest === POLICY.priorInactiveCandidateVersionId
      && canonical(state.deployment?.versions) === canonical([{ version_id: POLICY.parentVersionId, percentage: 100 }]);
  } catch { return false; }
}
