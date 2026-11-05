/**
 * Offline compiler for the installed profile after the finite canonical
 * browser retirement. It consumes ordinary retained release plans, their
 * persisted verified-active journal records, the full predecessor captures
 * used by those plans, and one independently obtained full final capture.
 * This module grants no release authority and has no provider or filesystem
 * mutation path.
 */
import { canonical, hash, need, validateInstallation, resourcesShape, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  ORDINARY_FRONTEND_PREFLIGHT_MODE, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT,
  OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } from './production-deploy.mjs';
import { validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { validateOrdinaryFrontendRetainedPlan, validateInstalledRetainedLedger,
  verifyOrdinaryFrontendRetainedCandidateModules } from './ordinary-frontend-retained-plan.mjs';
import { normalizeCanonicalBrowserRetirementPoststate, normalizeCanonicalBrowserRetirementPredecessor,
  CANONICAL_BROWSER_RETIREMENT_SELECTOR } from './ordinary-frontend-canonical-browser-retirement.mjs';
import { NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const equal = (a, b) => canonical(a) === canonical(b);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const TARGETS = Object.freeze({
  operations: Object.freeze({ OPERATIONS_ORIGINS: 'https://ops.ledgetop.app' }),
  client: Object.freeze({ CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app',
    CLIENT_PORTAL_RETIRED_ORIGINS: 'https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com,https://client.ledgetopdroneservices.com',
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE }),
});
const WORKERS = Object.freeze({ operations: 'ledgetop-ops', client: 'ledgetop-clients' });

function activeCandidate(snapshot, app, candidateId) {
  const state = snapshot?.[app];
  need(UUID.test(candidateId ?? '') && state?.version?.id === candidateId && state?.modern?.id === candidateId
    && state?.latest === candidateId && state?.deployment?.versions?.length === 1
    && state.deployment.versions[0].version_id === candidateId && state.deployment.versions[0].percentage === 100,
  `Canonical v4 ${app} candidate is not the sole active latest version`);
  return state;
}

function validateReleaseEvidence({ app, profile, sourceCommit, predecessor, retainedPlan,
  receipt, previousLedger, previousAssetBytes, observedAt } = {}) {
  need(['operations', 'client'].includes(app) && retainedPlan?.application === app
    && retainedPlan?.schemaVersion === 2 && retainedPlan?.contract === 'ordinary-frontend-retained-native-module-v2'
    && retainedPlan?.canonicalBrowserRetirementSelector === CANONICAL_BROWSER_RETIREMENT_SELECTOR,
  `Canonical v4 ${app} transition plans are incomplete`);
  need(retainedPlan.sourceCommit === sourceCommit,
  `Canonical v4 ${app} source lineage differs`);
  need(retainedPlan.ordinaryPlan?.sourceCommit === sourceCommit && retainedPlan.ordinaryPlan?.application === app,
    `Canonical v4 ${app} ordinary plan source is invalid`);
  const ordinary = retainedPlan.ordinaryPlan;
  const expectedSelector = app === 'operations'
    ? { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT }
    : { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT };
  const releaseOptions = { app, release: ordinary.release, profile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    canonicalBrowserRetirementSelector: CANONICAL_BROWSER_RETIREMENT_SELECTOR,
    ...(app === 'operations' ? { canonicalBrowserRetirementClientVersionId: ordinary.canonicalBrowserRetirementClientVersionId } : {}),
    ...expectedSelector };
  let normalizedPredecessor = predecessor;
  if (app === 'operations') normalizedPredecessor = normalizeCanonicalBrowserRetirementPredecessor(predecessor,
    ordinary.canonicalBrowserRetirementTransition);
  validateInstallation(normalizedPredecessor, { profile, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    ordinaryFrontendApp: app, opsSuccessorReaderContract: app === 'operations'
      ? OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT : OPS_SUCCESSOR_READER_INSTALLED_CONTRACT });
  validateOrdinaryFrontendReleasePlan(predecessor, ordinary, releaseOptions);

  need(retainedPlan.ordinaryPlanSHA256 === hash(canonical(ordinary))
    && retainedPlan.retentionPolicy?.minimumHours === 48 && retainedPlan.retentionPolicy?.automaticPruning === false
    && retainedPlan.offlineOnly === true && retainedPlan.deploymentEnabled === false,
  `Canonical v4 ${app} retained plan is not the exact offline plan`);
  need(observedAt === retainedPlan.retentionLedger?.observedAt && previousAssetBytes instanceof Map,
    `Canonical v4 ${app} retained-plan inputs are incomplete`);
  validateOrdinaryFrontendRetainedPlan(predecessor, retainedPlan, { ordinaryPlan: ordinary, profile, previousLedger,
    previousAssetBytes, observedAt, canonicalBrowserRetirementSelector: CANONICAL_BROWSER_RETIREMENT_SELECTOR,
    ...(app === 'operations' ? { canonicalBrowserRetirementClientVersionId: ordinary.canonicalBrowserRetirementClientVersionId,
      opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT }
      : { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }) });

  need(receipt && UUID.test(receipt.candidateId ?? '') && receipt.sourceCommit === sourceCommit
    && receipt.rollbackVersionId === retainedPlan.parentVersionId
    && receipt.automaticPruning === false && receipt.nativeExecutionQualification?.ready === false,
  `Canonical v4 ${app} persisted verified-active receipt shape or lineage is invalid`);
  return Object.freeze({ app, ordinary, retainedPlan, receipt, predecessor, previousLedger, previousAssetBytes, observedAt });
}

function validateReceiptAndLedger(evidence, finalCapture, now) {
  const { app, ordinary, retainedPlan, receipt, previousLedger } = evidence;
  const candidate = activeCandidate(finalCapture, app, receipt.candidateId);
  need(candidate.deployment.versions[0].percentage === 100, `Canonical v4 ${app} deployment is not exactly 100%`);
  for (const [name, value] of Object.entries(TARGETS[app])) {
    for (const rows of [candidate.version.resources.bindings, candidate.settings.bindings]) {
      const row = rows.find(item => item.name === name);
      need(row?.type === 'plain_text' && row.text === value, `Canonical v4 ${app} target scalar differs: ${name}`);
    }
  }
  const proof = verifyOrdinaryFrontendRetainedCandidateModules({ before: evidence.predecessor, plan: retainedPlan,
    candidate: candidate.version, modern: candidate.modern });
  need(equal(receipt.moduleProof, proof), `Canonical v4 ${app} active module proof differs from recomputed proof`);

  const ledger = validateInstalledRetainedLedger(finalCapture, { app, workerName: WORKERS[app],
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId });
  need(equal(ledger, retainedPlan.retentionLedger)
    && ledger.parentVersionId === retainedPlan.parentVersionId
    && ledger.sourceCommit === evidence.receipt.sourceCommit && ledger.minimumRetentionHours === 48
    && ledger.automaticPruning === false,
  `Canonical v4 ${app} embedded active retention ledger differs from its pinned plan`);
  const expectedAssets = ledger.assets.map(({ path, size, sha256, mime }) => ({ path, size, sha256, mime }));
  need(equal(receipt.assets, expectedAssets) && receipt.assetCount === expectedAssets.length
    && receipt.totalAssetBytes === expectedAssets.reduce((sum, row) => sum + row.size, 0),
  `Canonical v4 ${app} active receipt does not match the exact retained asset union`);
  need(equal(receipt.rootHtmlArchive ?? null, retainedPlan.rootHtmlArchive ?? null),
    `Canonical v4 ${app} active receipt root archive differs from its exact retained plan`);
  const expectedOldPaths = (previousLedger.assets ?? []).filter(row => row.path !== '/index.html').map(row => row.path).sort();
  need(equal(receipt.oldServedWithin48hPaths, expectedOldPaths),
    `Canonical v4 ${app} receipt omitted or invented previously served asset paths`);
  const cutover = Date.parse(receipt.cutoverAt), observed = Date.parse(receipt.namespaceObservedAt), earliest = Date.parse(receipt.earliestPermittedPruningAt);
  need(Number.isFinite(cutover) && Number.isFinite(observed) && Number.isFinite(earliest)
    && observed >= cutover && observed <= now
    && earliest >= Math.max(cutover, observed) + 48 * 60 * 60_000,
  `Canonical v4 ${app} historical retention receipt is invalid or below the 48-hour floor`);
  return { app, candidateId: receipt.candidateId, activeVersionId: candidate.version.id,
    parentVersionId: retainedPlan.parentVersionId, ledgerSHA256: retainedPlan.retentionLedgerSHA256,
    earliestPermittedPruningAt: receipt.earliestPermittedPruningAt };
}

/**
 * Produce a reviewable v4 installed-profile candidate only after replaying both
 * ordinary retained plans and checking their persisted receipt data against
 * the exact final full capture. `finalCapture` must be supplied by the caller
 * from the authenticated read-only production capture path; this function
 * validates its complete content but cannot manufacture that authentication.
 */
export function compileCanonicalInstalledProfileV4({ predecessorProfile, client, operations, finalCaptureEvidence,
  expectedSourceCommit, now = Date.now() } = {}) {
  need(predecessorProfile && hash(canonical(predecessorProfile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    'Canonical v4 compilation requires the exact immutable v3 profile');
  need(/^[a-f0-9]{40}$/u.test(expectedSourceCommit ?? '') && Number.isSafeInteger(now),
    'Canonical v4 source or verification clock is invalid');
  const clientEvidence = validateReleaseEvidence({ ...client, app: 'client', profile: predecessorProfile,
    sourceCommit: expectedSourceCommit });
  const operationsEvidence = validateReleaseEvidence({ ...operations, app: 'operations', profile: predecessorProfile,
    sourceCommit: expectedSourceCommit });
  need(finalCaptureEvidence && Object.getPrototypeOf(finalCaptureEvidence) === Object.prototype
    && equal(Object.keys(finalCaptureEvidence).sort(), ['observedAt', 'sha256', 'snapshot'])
    && typeof finalCaptureEvidence.observedAt === 'string'
    && new Date(Date.parse(finalCaptureEvidence.observedAt)).toISOString() === finalCaptureEvidence.observedAt
    && /^[a-f0-9]{64}$/u.test(finalCaptureEvidence.sha256 ?? ''),
  'Canonical v4 fresh final capture timestamp and digest are required');
  const finalObservedAt = Date.parse(finalCaptureEvidence.observedAt);
  const finalCapture = finalCaptureEvidence.snapshot;
  need(Number.isFinite(finalObservedAt) && finalObservedAt <= now && now - finalObservedAt <= 5 * 60_000
    && hash(canonical(finalCapture)) === finalCaptureEvidence.sha256,
  'Canonical v4 final capture is stale or its digest does not match');
  const clientId = clientEvidence.receipt.candidateId;
  need(operationsEvidence.ordinary.canonicalBrowserRetirementClientVersionId === clientId,
    'Canonical v4 Operations plan does not pin the exact preceding Client candidate');
  need(finalCapture && equal(Object.keys(finalCapture).sort(), Object.keys(predecessorProfile.workers).sort()),
    'Canonical v4 final complete installation capture is required');
  activeCandidate(finalCapture, 'client', clientId);
  const opsId = operationsEvidence.receipt.candidateId;
  activeCandidate(finalCapture, 'operations', opsId);
  const clientProof = validateReceiptAndLedger(clientEvidence, finalCapture, now);
  const operationsProof = validateReceiptAndLedger(operationsEvidence, finalCapture, now);

  const operationsTransition = operationsEvidence.ordinary.canonicalBrowserRetirementTransition;
  const normalizedBoth = normalizeCanonicalBrowserRetirementPoststate(finalCapture, operationsEvidence.predecessor,
    operationsTransition);

  // This profile is an exact observed-state projection constrained to the
  // original v3 profile plus the two reviewed scalar deltas and known Ops RPC
  // additions. Existing secret, resource, asset, settings and other-worker
  // pins remain byte-for-byte inherited from v3.
  const profile = structuredClone(predecessorProfile);
  profile.schemaVersion = 4;
  profile.profile = 'canonical-browser-installed-v4-offline';
  profile.installedFrontendSHA256 = Object.freeze({ client: clientEvidence.ordinary.release.frontendSHA256,
    operations: operationsEvidence.ordinary.release.frontendSHA256 });
  for (const app of ['client', 'operations']) for (const [name, value] of Object.entries(TARGETS[app]))
    profile.workers[app].plainValueSHA256[name] = hash(value);
  profile.workers.operations.script = resourcesShape(finalCapture.operations.version.resources).script;
  // Normalizing only the two finite target tuples must recover the exact v3
  // install, including all secrets and non-target controls. The existing v3
  // promotion validator below checks the sole two-handler Operations delta.
  const baselineForV3 = structuredClone(normalizedBoth);
  validateInstallation(baselineForV3, { profile: predecessorProfile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'operations',
    opsSuccessorReaderContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT,
    opsSuccessorReaderReleaseCandidateId: opsId });
  const profileSHA256 = hash(canonical(profile));
  const provenance = Object.freeze({ schemaVersion: 1, contract: 'canonical-browser-installed-profile-v4-offline',
    predecessorProfileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256, sourceCommit: expectedSourceCommit,
    client: { ...clientProof, frontendSHA256: clientEvidence.ordinary.release.frontendSHA256 },
    operations: { ...operationsProof, frontendSHA256: operationsEvidence.ordinary.release.frontendSHA256 },
    finalCaptureObservedAt: finalCaptureEvidence.observedAt,
    finalCaptureSHA256: finalCaptureEvidence.sha256,
    offlineOnly: true, activationEnabled: false });
  return Object.freeze({ profile, profileSHA256, provenance });
}

/** Recompute rather than trusting stored hashes or qualification booleans. */
export function validateCanonicalInstalledProfileV4(input, candidate) {
  need(candidate && candidate.provenance?.offlineOnly === true
    && candidate.provenance?.activationEnabled === false,
  'Canonical installed profile v4 must remain offline-only and non-activating');
  const recomputed = compileCanonicalInstalledProfileV4(input);
  need(equal(candidate, recomputed), 'Canonical installed profile v4 artifact differs from its pinned evidence');
  return recomputed;
}
