/** Pure post-upload checks for the ordinary Operations and Client frontend path.
 * This module verifies evidence only. It cannot upload, activate, or turn an
 * offline plan into execution authorization.
 */
import fs from 'node:fs';
import { canonical, hash, need, validateInstallation, verifyCandidate,
  OPS_SUCCESSOR_READER_INSTALLED_CONTRACT, ORDINARY_FRONTEND_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256 } from './production-deploy.mjs';
import { validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { collectFrontendAssets, mergeAssetLedger, preserveRootHtmlArchive, validateAssetLedger } from './production-auto-assets.mjs';
import { compileCanonicalBrowserRetirementTransition, validateCanonicalBrowserRetirementTarget }
  from './ordinary-frontend-canonical-browser-retirement.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const MAX_NATIVE_MODULE_BYTES = 64 * 1024 * 1024;
const equal = (a, b) => canonical(a) === canonical(b);
const compareAssetPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
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
export function decodeNativeModuleBytes(encoded, maxBytes = MAX_NATIVE_MODULE_BYTES) {
  need(typeof encoded === 'string' && Number.isSafeInteger(maxBytes) && maxBytes > 0
    && maxBytes <= MAX_NATIVE_MODULE_BYTES, 'Candidate module byte limit invalid');
  const encodedLimit = Math.ceil(maxBytes / 3) * 4;
  need(encoded.length > 0 && encoded.length <= encodedLimit && encoded.length % 4 === 0,
    'Candidate module base64 size invalid');
  const bytes = Buffer.from(encoded, 'base64');
  need(bytes.length > 0 && bytes.length <= maxBytes && bytes.toString('base64') === encoded,
    'Candidate module base64 malformed, noncanonical, or oversized');
  return bytes;
}
function strictModuleBytes(module, expectedName) {
  need(module && module.name === expectedName && typeof module.content_base64 === 'string',
    `Candidate ${expectedName} module missing or malformed`);
  return decodeNativeModuleBytes(module.content_base64);
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
    installedOpsSuccessorReaderContract: plan.installedOpsSuccessorReaderContract,
    ...(plan.canonicalBrowserRetirementSelector === undefined ? {} : { canonicalBrowserRetirementSelector: plan.canonicalBrowserRetirementSelector }),
    ...(plan.canonicalBrowserRetirementClientVersionId === undefined ? {} : { canonicalBrowserRetirementClientVersionId: plan.canonicalBrowserRetirementClientVersionId }),
    ...(plan.opsSuccessorReaderPromotionContract === undefined ? {} : { opsSuccessorReaderPromotionContract: plan.opsSuccessorReaderPromotionContract }),
  });
  return expected;
}

function verifyNamespaceReceipt({ evidence, plan, candidate, unionLedger, previousLedger, rootHtmlArchive, accountId, now }) {
  if (evidence === undefined) return { ready: false, reason: 'active-namespace-byte-receipt-required' };
  need(exactObject(evidence, ['receipt','bytesByPath']), 'Active namespace evidence shape invalid');
  const { receipt, bytesByPath } = evidence;
  need(exactObject(receipt, rootHtmlArchive ? [...receiptKeys, 'rootHtmlArchive'] : receiptKeys) && bytesByPath instanceof Map,
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
  const archive = rootHtmlArchive ?? null;
  if (archive) {
    need(equal(receipt.rootHtmlArchive, archive), 'Receipt does not identify the exact retained root HTML archive transport');
    const bytes = bytesByPath.get(archive.path);
    need(Buffer.isBuffer(bytes) && bytes.length === archive.size && hash(bytes) === archive.sha256,
      'Archived root HTML bytes do not match the prior root document');
  } else need(receipt.rootHtmlArchive === undefined || receipt.rootHtmlArchive === null,
    'Unexpected root HTML archive receipt');
  return { ready: true, reason: null, cutoverAt: receipt.cutoverAt, rootHtmlArchive: archive,
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
export function verifyOrdinaryFrontendCandidateModules({ before, plan, candidate, modern, allowProviderOmittedMap = false,
  opsSuccessorReaderContract } = {}) {
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
  const allowedNames = allowProviderOmittedMap ? ['index.js', 'index.js.map'] : ['index.js', 'index.js.map'];
  need(Array.isArray(modules) && modules.length >= (allowProviderOmittedMap ? 1 : 2) && modules.length <= 2
    && new Set(modules.map(row => row.name)).size === modules.length
    && modules.every(row => allowedNames.includes(row.name))
    && modules.some(row => row.name === 'index.js')
    && (allowProviderOmittedMap || modules.some(row => row.name === 'index.js.map')),
  'Candidate must expose the pinned main and only an optional source map module');
  const main = strictModuleBytes(modules.find(row => row.name === 'index.js'), 'index.js');
  need(hash(main) === plan.release.main.sha256 && main.equals(pinnedMain), 'Candidate main bytes differ from pinned release');
  let sourceMap;
  try { sourceMap = JSON.parse(pinnedMapBytes.toString('utf8')); } catch { throw new Error('Pinned source map JSON invalid'); }
  const mapModule = modules.find(row => row.name === 'index.js.map');
  if (mapModule) {
    const map = strictModuleBytes(mapModule, 'index.js.map');
    try { JSON.parse(map.toString('utf8')); } catch { throw new Error('Candidate source map JSON invalid'); }
  }
  if (opsSuccessorReaderContract !== undefined) {
    need(opsSuccessorReaderContract === OPS_SUCCESSOR_READER_INSTALLED_CONTRACT && app === 'operations'
      && plan.sourceCommit === 'a0c8fd230d46690a7090c79190e125f5a02f0f35'
      && plan.release.main.sha256 === 'f4cdefd633441df8db18cc5c0b192fc8faa72ebd7b1db730122bd77318164e68'
      && plan.release.sourceMap.sha256 === '375962dbe22ed0038009d0790c1c12a33b0668010f99916b8addade0a489d08b',
    'Ops successor reader candidate plan differs from exact reviewed source bundle and source map');
  }
  let candidateBaseline = before;
  if (plan.canonicalBrowserRetirementTransition) {
    const transition = compileCanonicalBrowserRetirementTransition(before, { app, profile: plan.beforeProfile,
      selector: plan.canonicalBrowserRetirementTransition.selector,
      predecessorProfileSHA256: plan.installationPreflight?.profileSHA256,
      clientVersionId: plan.canonicalBrowserRetirementClientVersionId });
    validateCanonicalBrowserRetirementTarget(transition, plan.expectedBindings);
    candidateBaseline = structuredClone(before);
    candidateBaseline[app].version.resources.bindings = structuredClone(plan.expectedBindings);
  }
  const runtimeProof = verifyCandidate(candidateBaseline, app, candidate, modern, pinnedMain, sourceMap, { opsSuccessorReaderContract });
  need(equal(candidate.resources.bindings, plan.expectedBindings)
    && equal(modern.assets ?? null, plan.expectedAssetsConfiguration),
  'Candidate bindings or asset routing config changed');
  return Object.freeze({ candidateModulesVerified: true, pinnedMainSHA256: plan.release.main.sha256,
    pinnedSourceMapSHA256: plan.release.sourceMap.sha256, ...runtimeProof,
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
  const planned = plan.browserProof.files.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort(compareAssetPath);
  const actual = collected.entries.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort(compareAssetPath);
  need(equal(actual, planned), 'Browser upload tree differs from pinned plan inventory');
  need(previousLedger !== undefined, 'Previously verified active asset ledger is required for production frontend release');
  const prior = validateAssetLedger(previousLedger, { workerName: workerFor(app), accountId });
  need(UUID.test(baselineVersionId ?? '') && prior.parentVersionId === baselineVersionId,
    'Previous asset ledger is not tied to captured active version');
  need(previousAssetBytes instanceof Map, 'Previous verified asset bytes must be a Map');
  const retained = preserveRootHtmlArchive({ application: app, previous: prior, previousAssetBytes, current: collected });
  const unionLedger = mergeAssetLedger({ previous: prior, current: retained.current,
    workerName: workerFor(app), accountId, sourceCommit: plan.sourceCommit, parentVersionId: candidateId,
    observedAt: new Date(now).toISOString() });
  const namespace = verifyNamespaceReceipt({ evidence: namespaceEvidence, plan, candidate: { id: candidateId },
    unionLedger, previousLedger: prior, rootHtmlArchive: retained.archive, accountId, now });
  return Object.freeze({ browserAssetInventoryVerified: true, rootHtmlArchive: retained.archive, assetNamespaceQualification: namespace,
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
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: plan.application,
    opsSuccessorReaderContract: plan.opsSuccessorReaderPromotionContract ?? plan.installedOpsSuccessorReaderContract });
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
