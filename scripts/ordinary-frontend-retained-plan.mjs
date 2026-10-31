/** Versioned ordinary frontend contract that pins the retained asset ledger as
 * one exact Wrangler additional module. Existing v1 plans remain unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash, need, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  ORDINARY_FRONTEND_PREFLIGHT_MODE } from './production-deploy.mjs';
import { validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { collectFrontendAssets, ledgerBytes, mergeAssetLedger, preserveRootHtmlArchive, validateAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { verifyOrdinaryFrontendCandidateModules } from './ordinary-frontend-candidate-verifier.mjs';
import { validateOpsLegacyLedgerBootstrap } from './ordinary-frontend-ops-ledger-bootstrap.mjs';

const WORKERS = Object.freeze({ operations: 'ledgetop-ops', client: 'ledgetop-clients' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const equal = (a, b) => canonical(a) === canonical(b);
const codepoint = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Bind historical ledger lineage to the version that actually serves it.
 * Its parentVersionId identifies the release before that ledger was installed,
 * so after cutover it must not be confused with the currently active version. */
export function validateInstalledRetainedLedger(snapshot, { app, workerName, accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId } = {}) {
  need(['operations', 'client'].includes(app) && WORKERS[app] === workerName,
    'Retained ledger capture target invalid');
  const state = snapshot?.[app], versionId = state?.version?.id;
  need(UUID.test(versionId ?? '') && state?.modern?.id === versionId,
    'Active ledger is not from captured production version');
  const rows = state.modern.modules?.filter(module => module?.name === '__ops_release_ledger.json');
  need(Array.isArray(rows) && rows.length === 1 && typeof rows[0].content_base64 === 'string'
    && rows[0].content_base64.length <= 12 * 1024 * 1024, 'Previously installed retained ledger is required');
  const bytes = Buffer.from(rows[0].content_base64, 'base64');
  need(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024 && bytes.toString('base64') === rows[0].content_base64,
    'Previously installed retained ledger encoding invalid');
  let ledger; try { ledger = JSON.parse(bytes.toString('utf8')); } catch { throw Error('Previously installed retained ledger JSON invalid'); }
  need(Buffer.from(ledgerBytes(ledger)).equals(bytes), 'Previously installed retained ledger is noncanonical');
  return validateAssetLedger(ledger, { workerName, accountId });
}

function compileRetainedPlan(snapshot, { ordinaryPlan, profile, previousLedger, previousAssetBytes, observedAt } = {}) {
  need(ordinaryPlan?.schemaVersion === 1 && ['operations', 'client'].includes(ordinaryPlan.application),
    'Version 1 pinned ordinary frontend plan required');
  need(ordinaryPlan.installationPreflight?.mode === ORDINARY_FRONTEND_PREFLIGHT_MODE
    && ordinaryPlan.installationPreflight.profileSHA256 === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256
    && profile && hash(canonical(profile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  'Exact original installed frontend profile v3 required');
  validateOrdinaryFrontendReleasePlan(snapshot, ordinaryPlan, { app: ordinaryPlan.application,
    release: ordinaryPlan.release, profile,
    ...(ordinaryPlan.expectedDeploymentVersions === undefined ? {} : { expectedDeploymentVersions: ordinaryPlan.expectedDeploymentVersions }),
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE });
  const app = ordinaryPlan.application, workerName = WORKERS[app], accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const parentVersionId = snapshot?.[app]?.version?.id;
  need(UUID.test(parentVersionId ?? ''), 'Captured active parent version is required');
  need(previousAssetBytes instanceof Map, 'Complete independently verified prior asset bytes are required');
  const prior = validateAssetLedger(previousLedger, { workerName, accountId });
  if (app === 'operations' && parentVersionId === 'a45943f4-e5c5-4142-9057-fb9adb5cf739') {
    validateOpsLegacyLedgerBootstrap(snapshot, { previousLedger: prior, previousAssetBytes });
  } else {
    const installedPrior = validateInstalledRetainedLedger(snapshot, { app, workerName, accountId });
    need(equal(prior, installedPrior), 'Prior asset ledger differs from the ledger embedded in captured active version');
  }
  need(typeof observedAt === 'string' && Number.isFinite(Date.parse(observedAt))
    && new Date(Date.parse(observedAt)).toISOString() === observedAt, 'Canonical observation time required');

  const collected = collectFrontendAssets(ordinaryPlan.release.assets.directory);
  const expected = ordinaryPlan.browserProof.files.map(({ path: assetPath, size, sha256 }) => ({ path: assetPath, size, sha256 })).sort(codepoint);
  const actual = collected.entries.map(({ path: assetPath, size, sha256 }) => ({ path: assetPath, size, sha256 })).sort(codepoint);
  need(equal(actual, expected), 'Current browser asset bytes differ from pinned ordinary plan');
  const retained = preserveRootHtmlArchive({ application: app, previous: prior, previousAssetBytes, current: collected });
  const ledger = mergeAssetLedger({ previous: prior, current: retained.current, workerName, accountId,
    sourceCommit: ordinaryPlan.sourceCommit, parentVersionId, observedAt });
  const bytes = ledgerBytes(ledger);
  const modulePin = Object.freeze({ name: '__ops_release_ledger.json', type: 'Text', mime: 'text/plain',
    size: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString('base64') });
  const planHash = hash(canonical(ordinaryPlan));
  const pinnedOrdinaryPlan = deepFreeze(structuredClone(ordinaryPlan));
  return deepFreeze({ schemaVersion: 2, contract: 'ordinary-frontend-retained-native-module-v2',
    application: app, workerName, accountId, sourceCommit: ordinaryPlan.sourceCommit, parentVersionId,
    rootHtmlArchive: retained.archive,
    ordinaryPlan: pinnedOrdinaryPlan, ordinaryPlanSHA256: planHash, retentionLedger: ledger, retentionLedgerSHA256: hash(bytes),
    nativeAdditionalModule: modulePin,
    additionalModuleRule: Object.freeze({ type: 'Text', globs: Object.freeze(['__ops_release_ledger.json']), fallthrough: false }),
    assetProviderIdentifierProvenance: Object.freeze({ schema: 'sha256-prefix32-v1',
      newIdentifiers: 'reconstructed-from-exact-verified-asset-bytes', priorOpaqueIdentifiers: 'preserved-verbatim',
      observedWranglerBlake3Identifiers: false }),
    retentionPolicy: Object.freeze({ minimumHours: 48, automaticPruning: false }),
    offlineOnly: true, deploymentEnabled: false,
    nativeExecutionQualification: { ready: false, reason: 'versioned-native-executor-and-authority-qualification-required' } });
}

/** Compile a separately versioned opt-in contract. The prior bytes must come
 * from active namespace verification; this pure compiler does not assert that. */
export function compileOrdinaryFrontendRetainedPlan(snapshot, options) {
  return compileRetainedPlan(snapshot, options);
}

export function validateOrdinaryFrontendRetainedPlan(snapshot, plan, options) {
  need(equal(plan, compileRetainedPlan(snapshot, options)), 'Ordinary retained frontend plan changed');
  return plan;
}

/** Assemble an isolated module root with only three pinned inputs. Assets stay
 * in their separate complete retained-union directory, preserving Wrangler's
 * native assets JWT flow. Existing build files are copied after stable reads. */
export function stageOrdinaryFrontendRetainedModules(plan, directory) {
  need(plan?.schemaVersion === 2 && plan.contract === 'ordinary-frontend-retained-native-module-v2'
    && path.isAbsolute(directory) && fs.existsSync(plan.ordinaryPlan.release.main.path), 'Retained module staging input invalid');
  const target = path.resolve(directory), mainPin = plan.ordinaryPlan.release.main, mapPin = plan.ordinaryPlan.release.sourceMap;
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  const copyPinned = (pin, name) => {
    const stat = fs.lstatSync(pin.path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === pin.size, 'Pinned module input changed');
    const bytes = fs.readFileSync(pin.path);
    need(bytes.length === pin.size && hash(bytes) === pin.sha256, 'Pinned module digest changed');
    fs.writeFileSync(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  };
  try {
    copyPinned(mainPin, 'index.js'); copyPinned(mapPin, 'index.js.map');
    const ledger = Buffer.from(plan.nativeAdditionalModule.contentBase64, 'base64');
    need(ledger.length === plan.nativeAdditionalModule.size && hash(ledger) === plan.nativeAdditionalModule.sha256
      && ledger.equals(ledgerBytes(plan.retentionLedger)), 'Pinned retained ledger module changed');
    fs.writeFileSync(path.join(target, plan.nativeAdditionalModule.name), ledger, { flag: 'wx', mode: 0o600 });
    const names = fs.readdirSync(target).sort();
    need(equal(names, ['__ops_release_ledger.json', 'index.js', 'index.js.map']), 'Unexpected retained module staging files');
    return Object.freeze({ directory: target, main: path.join(target, 'index.js'), sourceMap: path.join(target, 'index.js.map'),
      ledger: path.join(target, plan.nativeAdditionalModule.name) });
  } catch (error) {
    // Preserve failed staging for inspection/reconciliation; never retry a
    // native mutation based on a partially prepared candidate.
    throw error;
  }
}

/** Native config projection: the only deltas are private module-root paths,
 * one exact Text glob and the opt-in discovery bit. */
export function retainedNativeConfig(plan, staged) {
  need(plan?.schemaVersion === 2 && staged?.main === path.join(staged.directory, 'index.js')
    && staged?.sourceMap === path.join(staged.directory, 'index.js.map'), 'Verified retained module stage required');
  const config = structuredClone(plan.ordinaryPlan.config);
  need(config.no_bundle === true && config.upload_source_maps === true,
    'Pinned native unbundled main/map upload configuration is required');
  need(plan.accountId === NATIVE_STAFF_PRODUCTION_TARGET.accountId
    && (config.account_id === undefined || config.account_id === plan.accountId),
  'Native account selection differs from the exact production account pin');
  config.account_id = plan.accountId;
  need(!Array.isArray(config.rules) || config.rules.length === 0,
    'Existing module rules require separate review before retained ledger inclusion');
  config.main = staged.main;
  config.find_additional_modules = true;
  config.base_dir = staged.directory;
  config.rules = [structuredClone(plan.additionalModuleRule)];
  config.assets.directory = path.resolve(plan.ordinaryPlan.release.assets.directory);
  return config;
}

/** Verify the v2 ledger plus exact main and provider-optional map while
 * delegating runtime, returned-map, binding and assets-config checks. */
export function verifyOrdinaryFrontendRetainedCandidateModules({ before, plan, candidate, modern, opsSuccessorReaderContract } = {}) {
  need(plan?.schemaVersion === 2 && plan.contract === 'ordinary-frontend-retained-native-module-v2'
    && Array.isArray(modern?.modules) && modern.modules.length >= 2 && modern.modules.length <= 3
    && new Set(modern.modules.map(row => row?.name)).size === modern.modules.length,
  'Exact retained candidate modules required');
  const module = modern.modules.find(row => row.name === '__ops_release_ledger.json');
  need(module && typeof module.content_base64 === 'string', 'Candidate retained ledger module missing');
  const bytes = Buffer.from(module.content_base64, 'base64');
  need(bytes.length > 0 && bytes.toString('base64') === module.content_base64
    && bytes.length === plan.nativeAdditionalModule.size && hash(bytes) === plan.nativeAdditionalModule.sha256
    && module.content_type === 'text/plain', 'Candidate retained ledger bytes or MIME differ from pin');
  const pinned = Buffer.from(plan.nativeAdditionalModule.contentBase64, 'base64');
  need(bytes.equals(pinned) && bytes.equals(ledgerBytes(plan.retentionLedger)), 'Candidate retained ledger content differs from canonical plan');
  const ledger = validateAssetLedger(JSON.parse(bytes.toString('utf8')), { workerName: plan.workerName, accountId: plan.accountId });
  need(equal(ledger, plan.retentionLedger) && ledger.parentVersionId === plan.parentVersionId
    && ledger.sourceCommit === plan.sourceCommit, 'Candidate ledger lineage or identity mismatch');
  const nativeModules = modern.modules.filter(row => row.name !== module.name);
  const runtimeProof = verifyOrdinaryFrontendCandidateModules({ before, plan: plan.ordinaryPlan, candidate,
    modern: { ...modern, modules: nativeModules }, allowProviderOmittedMap: true, opsSuccessorReaderContract });
  return Object.freeze({ ...runtimeProof, retainedLedgerModuleVerified: true,
    retainedLedgerSHA256: plan.retentionLedgerSHA256, retainedAssetCount: ledger.assets.length,
    retainedAssetBytes: ledger.assets.reduce((sum, row) => sum + row.size, 0) });
}
