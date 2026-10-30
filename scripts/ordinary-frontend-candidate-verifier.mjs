/** Pure post-upload checks for the ordinary Operations and Client frontend path.
 * This module verifies evidence only. It cannot upload, activate, or turn an
 * offline plan into execution authorization.
 */
import fs from 'node:fs';
import { canonical, hash, need, validateInstallation, verifyCandidate,
  ORDINARY_FRONTEND_PREFLIGHT_MODE, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256 } from './production-deploy.mjs';
import { validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { collectFrontendAssets, mergeAssetLedger, validateAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const equal = (a, b) => canonical(a) === canonical(b);
const workerFor = app => app === 'operations' ? 'ledgetop-ops' : 'ledgetop-clients';
const receiptKeys = ['schemaVersion','workerName','accountId','sourceCommit','activeVersionId','observedAt',
  'cutoverAt','earliestPermittedPruningAt','minimumRetentionHours','automaticPruning','oldServedWithin48hPaths','assets'];

function exactObject(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function timestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 && new Date(parsed).toISOString() === value;
}
function strictModuleBytes(module, expectedName) {
  need(module && module.name === expectedName && typeof module.content_base64 === 'string'
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(module.content_base64),
  `Candidate ${expectedName} module missing or malformed`);
  const bytes = Buffer.from(module.content_base64, 'base64');
  need(bytes.toString('base64') === module.content_base64, `Candidate ${expectedName} base64 is noncanonical`);
  return bytes;
}
function planProfile(before, plan, profile, expectedDeploymentVersions) {
  need(plan?.schemaVersion === 1 && ['operations','client'].includes(plan.application)
    && plan.offlineOnly === true && plan.deploymentEnabled === false
    && plan.nativeExecutionQualification?.ready === false,
  'A pinned offline ordinary frontend plan is required');
  need(plan.installationPreflight?.mode === ORDINARY_FRONTEND_PREFLIGHT_MODE
    && plan.installationPreflight.profileSHA256 === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256
    && profile && Object.getPrototypeOf(profile) === Object.prototype
    && hash(canonical(profile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  'Exact installed frontend profile v3 is required');
  const expected = expectedDeploymentVersions ?? plan.expectedDeploymentVersions;
  validateOrdinaryFrontendReleasePlan(before, plan, {
    app: plan.application, release: plan.release, profile,
    ...(expected === undefined ? {} : { expectedDeploymentVersions: expected }),
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
  });
  return expected;
}

function verifyNamespaceReceipt({ evidence, plan, candidate, unionLedger, previousLedger, accountId, now }) {
  if (evidence === undefined) return { ready: false, reason: 'active-namespace-byte-receipt-required' };
  need(exactObject(evidence, ['receipt','bytesByPath']), 'Active namespace evidence shape invalid');
  const { receipt, bytesByPath } = evidence;
  need(exactObject(receipt, receiptKeys) && bytesByPath instanceof Map,
    'Active namespace evidence shape invalid');
  const app = plan.application, workerName = workerFor(app);
  need(receipt.schemaVersion === 1 && receipt.workerName === workerName && receipt.accountId === accountId
    && receipt.sourceCommit === plan.sourceCommit && receipt.activeVersionId === candidate.id
    && timestamp(receipt.observedAt) && timestamp(receipt.cutoverAt) && timestamp(receipt.earliestPermittedPruningAt)
    && Date.parse(receipt.cutoverAt) <= Date.parse(receipt.observedAt)
    && Date.parse(receipt.cutoverAt) <= 8.64e15 - 48 * 60 * 60_000
    && Date.parse(receipt.observedAt) - Date.parse(receipt.cutoverAt) <= 5 * 60_000
    && Date.parse(receipt.observedAt) <= now && now - Date.parse(receipt.observedAt) <= 5 * 60_000
    && receipt.earliestPermittedPruningAt >= new Date(Date.parse(receipt.cutoverAt) + 48 * 60 * 60_000).toISOString()
    && receipt.minimumRetentionHours === 48 && receipt.automaticPruning === false,
  'Active namespace retention receipt is stale, mismatched, or shorter than 48 hours');

  const expected = unionLedger.assets.map(({ path, size, sha256, mime }) => ({ path, size, sha256, mime }));
  need(Array.isArray(receipt.assets) && equal(receipt.assets, expected),
    'Active namespace receipt does not cover the exact retained old/new asset union');
  need(bytesByPath.size === expected.length && expected.every(row => {
    const bytes = bytesByPath.get(row.path);
    return Buffer.isBuffer(bytes) && bytes.length === row.size && hash(bytes) === row.sha256;
  }), 'Active namespace bytes do not match every retained old/new asset path');
  const priorPaths = new Set((previousLedger?.assets ?? []).filter(row => row.path !== '/index.html').map(row => row.path));
  const oldPaths = receipt.oldServedWithin48hPaths;
  const allPriorPaths = [...priorPaths].sort();
  need(Array.isArray(oldPaths) && equal(oldPaths, allPriorPaths),
    'Receipt omits, invents, or duplicates previously retained browser asset paths');
  return { ready: true, reason: null, cutoverAt: receipt.cutoverAt,
    earliestPermittedPruningAt: receipt.earliestPermittedPruningAt,
    assetCount: expected.length, totalBytes: expected.reduce((sum, row) => sum + row.size, 0),
    namespaceByteEvidenceVerified: true };
}

/** Evidence cannot qualify the eventual native executor or grant release authority. */
export function ordinaryFrontendExecutionQualification(namespaceQualification) {
  need(namespaceQualification && typeof namespaceQualification.ready === 'boolean'
    && (namespaceQualification.ready || typeof namespaceQualification.reason === 'string'
      && namespaceQualification.reason.length > 0 && namespaceQualification.reason.length <= 160),
  'Namespace qualification result required');
  return Object.freeze({ ready: false,
    reason: namespaceQualification.ready ? 'executor-and-authority-qualification-required' : namespaceQualification.reason,
    offlinePlanRemainsNonAuthorizing: true });
}

/** Verify candidate runtime modules and native resource/config invariants. */
export function verifyOrdinaryFrontendCandidateModules({ before, plan, candidate, modern } = {}) {
  need(plan?.schemaVersion === 1 && ['operations','client'].includes(plan.application)
    && plan.offlineOnly === true && plan.deploymentEnabled === false,
  'Pinned offline ordinary frontend plan is required');
  const app = plan.application, state = before?.[app];
  need(state?.version?.resources && candidate?.id && UUID.test(candidate.id) && modern?.id === candidate.id,
    'Candidate version identity mismatch');
  const pinnedMain = fs.readFileSync(plan.release.main.path);
  const pinnedMapBytes = fs.readFileSync(plan.release.sourceMap.path);
  need(pinnedMain.length === plan.release.main.size && hash(pinnedMain) === plan.release.main.sha256
    && pinnedMapBytes.length === plan.release.sourceMap.size && hash(pinnedMapBytes) === plan.release.sourceMap.sha256,
  'Pinned Worker main or source map changed');
  const modules = modern.modules;
  need(Array.isArray(modules) && modules.length === 2 && new Set(modules.map(row => row.name)).size === 2,
    'Candidate must expose exactly the pinned main and source map modules');
  const main = strictModuleBytes(modules.find(row => row.name === 'index.js'), 'index.js');
  const map = strictModuleBytes(modules.find(row => row.name === 'index.js.map'), 'index.js.map');
  need(hash(main) === plan.release.main.sha256 && main.equals(pinnedMain), 'Candidate main bytes differ from pinned release');
  let sourceMap;
  try { sourceMap = JSON.parse(pinnedMapBytes.toString('utf8')); } catch { throw new Error('Pinned source map JSON invalid'); }
  try { JSON.parse(map.toString('utf8')); } catch { throw new Error('Candidate source map JSON invalid'); }
  verifyCandidate(before, app, candidate, modern, pinnedMain, sourceMap);
  need(equal(candidate.resources.bindings, plan.expectedBindings)
    && equal(modern.assets ?? null, plan.expectedAssetsConfiguration),
  'Candidate bindings or asset routing config changed');
  return Object.freeze({ candidateModulesVerified: true, pinnedMainSHA256: plan.release.main.sha256,
    pinnedSourceMapSHA256: plan.release.sourceMap.sha256, returnedSourceMapSemanticsVerified: true,
    bindingAndRoutingProfileVerified: true });
}

/** Build the old/new retained union and require complete post-cutover byte evidence. */
export function verifyOrdinaryFrontendAssetNamespace({ plan, candidateId, baselineVersionId, previousLedger, previousAssetBytes = new Map(),
  namespaceEvidence, now = Date.now(), accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId } = {}) {
  need(['operations','client'].includes(plan?.application) && UUID.test(candidateId ?? '')
    && /^[a-f0-9]{40}$/u.test(plan?.sourceCommit ?? ''), 'Pinned candidate identity required');
  need(Number.isSafeInteger(now) && now >= 0 && now <= 8.64e15, 'Verification clock invalid');
  need(accountId === NATIVE_STAFF_PRODUCTION_TARGET.accountId, 'Production account identity mismatch');
  const app = plan.application, collected = collectFrontendAssets(plan.release.assets.directory);
  const planned = plan.browserProof.files.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }));
  const actual = collected.entries.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  need(equal(actual, planned), 'Browser upload tree differs from pinned plan inventory');
  need(previousLedger !== undefined, 'Previously verified active asset ledger is required for production frontend release');
  const prior = validateAssetLedger(previousLedger, { workerName: workerFor(app), accountId });
  need(UUID.test(baselineVersionId ?? '') && prior.parentVersionId === baselineVersionId,
    'Previous asset ledger is not tied to captured active version');
  need(previousAssetBytes instanceof Map, 'Previous verified asset bytes must be a Map');
  const payloads = new Map(previousAssetBytes);
  for (const [assetPath, bytes] of collected.payloads) payloads.set(assetPath, bytes);
  const unionLedger = mergeAssetLedger({ previous: prior, current: { entries: collected.entries, payloads },
    workerName: workerFor(app), accountId, sourceCommit: plan.sourceCommit, parentVersionId: candidateId,
    observedAt: new Date(now).toISOString() });
  const namespace = verifyNamespaceReceipt({ evidence: namespaceEvidence, plan, candidate: { id: candidateId },
    unionLedger, previousLedger: prior, accountId, now });
  return Object.freeze({ browserAssetInventoryVerified: true, assetNamespaceQualification: namespace,
    retainedAssetLedger: unionLedger });
}

/**
 * Verify a native candidate and, when supplied, post-activation namespace
 * evidence. `before` is the complete captured installation used to compile
 * the plan. `profile` must be the original v3 profile, not the plan's derived
 * beforeProfile. `previousLedger` and its payload map must come from the separately
 * verified active namespace inventory. Namespace evidence must be gathered
 * from active namespace byte reads; Worker asset-association metadata alone
 * does not satisfy this evidence contract.
 */
export function verifyOrdinaryFrontendCandidate({ before, plan, candidate, modern, profile,
  expectedDeploymentVersions, previousLedger, previousAssetBytes = new Map(), namespaceEvidence, now = Date.now(), accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId } = {}) {
  need(Number.isSafeInteger(now) && now >= 0 && now <= 8.64e15, 'Verification clock invalid');
  const expected = planProfile(before, plan, profile, expectedDeploymentVersions);
  validateInstallation(before, { profile, selectedApp: plan.application,
    ...(expected === undefined ? {} : { expectedDeploymentVersions: expected }),
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: plan.application });
  const app = plan.application;
  const moduleProof = verifyOrdinaryFrontendCandidateModules({ before, plan, candidate, modern });
  const assetProof = verifyOrdinaryFrontendAssetNamespace({ plan, candidateId: candidate.id, baselineVersionId: before[app].version.id, previousLedger,
    previousAssetBytes, namespaceEvidence, now, accountId });
  return Object.freeze({ candidateId: candidate.id, application: app, sourceCommit: plan.sourceCommit,
    ...moduleProof, ...assetProof,
    nativeExecutionQualification: ordinaryFrontendExecutionQualification(assetProof.assetNamespaceQualification),
    candidateEvidenceVerified: true,
    namespaceEvidenceVerified: assetProof.assetNamespaceQualification.ready,
  });
}
