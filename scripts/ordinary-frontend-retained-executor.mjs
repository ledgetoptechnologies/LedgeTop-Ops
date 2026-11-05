/** Explicit callable native-Wrangler executor for retained ordinary frontends.
 * It is intentionally not wired into production-deploy's CLI or automation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capture, CloudflareReader, deploymentSourceCommit, hash, canonical, need, PROFILE,
  preparePrivateProductionDirectory, readStaffCutoverReview, runNativeProductionCommand,
  stableState, validateBuildEnvironment, validateInstallation, validateStaffReadinessReceipt,
  OPS_SUCCESSOR_READER_INSTALLED_CONTRACT, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  ORDINARY_FRONTEND_PREFLIGHT_MODE, resourcesShape } from './production-deploy.mjs';
import { readNativeStaffCutoverReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_CONTRACT, validateOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority.mjs';
import { readOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_STAFF_PRESERVATION_CONTRACT, validatePost0226StaffPreservationReview } from './ordinary-frontend-authority-post0226.mjs';
import { readPost0226StaffPreservationObservation } from './ordinary-frontend-authority-post0226-reader.mjs';
import { createAssetVerificationNonce, executeAssetVerification } from './production-auto-verify.mjs';
import { readCandidateVersionWithVisibilityRetry } from './production-deploy.mjs';
import { ProductionCloudflareProvider, newTemporaryVerifierName } from './production-auto-provider.mjs';
import { collectFrontendAssets, preserveRootHtmlArchive } from './production-auto-assets.mjs';
import { minimumRetainedUntil, parseProviderUtcTimestamp } from './production-auto-time.mjs';
import { retainedNativeConfig, stageOrdinaryFrontendRetainedModules,
  validateInstalledRetainedLedger, validateOrdinaryFrontendRetainedPlan, verifyOrdinaryFrontendRetainedCandidateModules } from './ordinary-frontend-retained-plan.mjs';
import { verifyOrdinaryFrontendAssetNamespace } from './ordinary-frontend-candidate-verifier.mjs';
import { completeOpsLegacyLedgerBootstrap, prepareOpsLegacyLedgerBootstrap } from './ordinary-frontend-ops-ledger-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = Object.freeze({ operations: { name: 'ledgetop-ops', origin: 'https://ops.ledgetop.app' },
  client: { name: 'ledgetop-clients', origin: 'https://portal.ledgetop.app' } });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const equal = (a, b) => canonical(a) === canonical(b);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const needFn = (ok, message) => need(ok, message);
const SUCCESSOR_READER_CLASS = 'OperationsPortalNativeDeliveryAuthorizationReader';
const REVIEWED_SUCCESSOR_SOURCE_COMMIT = 'a0c8fd230d46690a7090c79190e125f5a02f0f35';
const REVIEWED_SUCCESSOR_MAIN_SHA256 = 'f4cdefd633441df8db18cc5c0b192fc8faa72ebd7b1db730122bd77318164e68';
const REVIEWED_SUCCESSOR_MAP_SHA256 = '375962dbe22ed0038009d0790c1c12a33b0668010f99916b8addade0a489d08b';
const REVIEWED_SUCCESSOR_CANDIDATE_ID = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
const REVIEWED_PRIOR_VERIFIER_SOURCE_SHA256 = 'f9ff69620e2e001e53a852387323e6308f1a3063fc1c1cb2a1f7c28d938ad861';
const SUCCESSOR_READER_ADDITIONS = Object.freeze([
  'readWindowsCatalogSuccessorAuthorization',
  'readWindowsDeliverySuccessorAuthorization',
].sort());

/** The reviewed inactive a0 candidate adds exactly two read-only successor RPC methods
 * to the existing Ops reader class. All other exports, handlers, runtime,
 * bindings and named-handler records stay byte-for-byte equivalent. */
export function verifyExactOpsSuccessorNamedHandlerAddition(before, candidate, { sourceCommit, mainSHA256, sourceMapSHA256 } = {}) {
  needFn(before?.operations?.version?.resources && candidate?.resources
    && candidate.resources.script?.named_handlers && before.operations.version.resources.script?.named_handlers,
  'Ops successor reader resource evidence is incomplete');
  needFn(candidate.id === REVIEWED_SUCCESSOR_CANDIDATE_ID && sourceCommit === REVIEWED_SUCCESSOR_SOURCE_COMMIT
    && mainSHA256 === REVIEWED_SUCCESSOR_MAIN_SHA256
    && sourceMapSHA256 === REVIEWED_SUCCESSOR_MAP_SHA256,
  'Ops successor reader exception is pinned to the reviewed a0 source, main bundle and source map');
  const baseline = resourcesShape(before.operations.version.resources);
  const actual = resourcesShape(candidate.resources);
  needFn(equal(actual.script.handlers, baseline.script.handlers)
    && equal(actual.script.named_handlers.map(({ name }) => name), baseline.script.named_handlers.map(({ name }) => name)),
  'Ops candidate changed script exports or named-handler classes');
  const baseByName = new Map(baseline.script.named_handlers.map(row => [row.name, row]));
  const actualByName = new Map(actual.script.named_handlers.map(row => [row.name, row]));
  const baseReader = baseByName.get(SUCCESSOR_READER_CLASS), actualReader = actualByName.get(SUCCESSOR_READER_CLASS);
  needFn(baseReader && actualReader, 'Ops candidate omitted the pinned successor reader class');
  const added = actualReader.handlers.filter(name => !baseReader.handlers.includes(name)).sort();
  needFn(equal(added, SUCCESSOR_READER_ADDITIONS)
    && actualReader.handlers.length === baseReader.handlers.length + SUCCESSOR_READER_ADDITIONS.length
    && SUCCESSOR_READER_ADDITIONS.every(name => !baseReader.handlers.includes(name)),
  'Ops candidate named-handler delta differs from the exact reviewed read-only successor RPC pair');
  const normalizedActual = structuredClone(actual);
  const normalizedReader = normalizedActual.script.named_handlers.find(row => row.name === SUCCESSOR_READER_CLASS);
  normalizedReader.handlers = [...baseReader.handlers];
  needFn(equal(normalizedActual, baseline),
    'Ops candidate changed resources beyond the two reviewed successor RPC methods');
  return Object.freeze({ schemaVersion: 1, contract: 'ops-successor-reader-additive-rpc-v1',
    sourceCommit, mainSHA256, sourceMapSHA256,
    className: SUCCESSOR_READER_CLASS, addedMethods: [...SUCCESSOR_READER_ADDITIONS],
    allOtherResourcesUnchanged: true });
}

function activeVersion(state) {
  const rows = state?.deployment?.versions;
  needFn(Array.isArray(rows) && rows.length >= 1 && rows.length <= 2, 'Ordinary deployment version distribution invalid');
  const active = rows.filter(row => row?.percentage === 100);
  needFn(active.length === 1 && UUID.test(active[0].version_id), 'Ordinary active version is ambiguous');
  return active[0].version_id;
}

export function readInstalledRetainedAssetLedger(snapshot, { app, workerName, accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId } = {}) {
  const id = activeVersion(snapshot?.[app]);
  needFn(id === snapshot?.[app]?.version?.id, 'Active ledger is not from captured production version');
  return validateInstalledRetainedLedger(snapshot, { app, workerName, accountId });
}

function parseCandidateId(text) {
  const matches = [...String(text).matchAll(/Worker Version ID:\s*([a-f0-9-]{36})/gu)].map(row => row[1]);
  needFn(matches.length === 1 && UUID.test(matches[0]), 'Native upload candidate ID is ambiguous; GET-only reconciliation required');
  return matches[0];
}

function appendIntent(directory, phase, detail) {
  const file = path.join(directory, 'journal.jsonl');
  const row = JSON.stringify({ sequence: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length + 1 : 1,
    at: new Date().toISOString(), phase, ...detail, automaticRetry: false });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, `${row}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function appendProviderIntent(directory, intent) {
  needFn(intent && typeof intent.requestId === 'string' && ['PUT', 'POST', 'DELETE'].includes(intent.method)
    && typeof intent.path === 'string' && HEX40.test(intent.sourceCommit ?? '') && intent.automaticRetry === false,
  'Temporary verifier mutation intent invalid');
  const detail = Object.fromEntries(['requestId','method','path','phase','name','workerName','sourceSHA256','sourceCommit','automaticRetry']
    .filter(key => Object.hasOwn(intent, key)).map(key => [key, intent[key]]));
  appendIntent(directory, 'temporary-asset-verifier-mutation', detail);
}

function appendProviderResponseDigest(directory, response) {
  needFn(response && typeof response.requestId === 'string' && ['PUT', 'POST', 'DELETE'].includes(response.method)
    && typeof response.path === 'string' && (response.rawResponse === undefined || Buffer.isBuffer(response.rawResponse)),
  'Temporary verifier response receipt invalid');
  const body = response.rawResponse ?? Buffer.alloc(0);
  const detail = { requestId: response.requestId, method: response.method, path: response.path,
    status: Number.isInteger(response.status) ? response.status : null,
    errorCodes: Array.isArray(response.errorCodes) ? response.errorCodes.filter(Number.isSafeInteger) : [],
    responseBytes: body.length, responseSHA256: sha(body), incomplete: response.incomplete === true };
  const fd = fs.openSync(path.join(directory, 'provider-responses.private.jsonl'), 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(detail)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function verifyVersionAssets({ provider, application, workerName, entries, versionId, journalDirectory, receiptName }) {
  needFn(provider && ['createVerifier','fetchVerifierAsset','removeVerifier','verifierAbsent'].every(name => typeof provider[name] === 'function'),
    'Journaled native asset verifier provider required');
  needFn(['operations', 'client'].includes(application) && WORKERS[application].name === workerName
    && UUID.test(versionId ?? '') && /^[a-z0-9][a-z0-9-]{0,47}$/u.test(receiptName ?? ''), 'Asset verifier version target invalid');
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const manifest = entries.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, contentType: mime }));
  appendIntent(journalDirectory, 'temporary-asset-verifier-create', { workerName, verifiedVersionId: versionId, verifierName: name,
    assetCount: manifest.length, receiptName, automaticRetry: false });
  const result = await executeAssetVerification({ entries: manifest, timeoutMs: 300_000,
    create: () => provider.createVerifier({ name, workerName,
      origin: WORKERS[application].origin, entries: manifest, nonceHash: nonce.nonceHash, versionId }),
    fetchAsset: ({ path: assetPath }, { method, signal }) => provider.fetchVerifierAsset({ name, path: assetPath,
      method, bearer: nonce.bearer, signal }),
    remove: () => provider.removeVerifier(name), readAbsent: () => provider.verifierAbsent(name) });
  needFn(result.receipt.temporaryWorkerRemoved === true && result.receipt.absenceVerified === true,
    'Temporary candidate asset verifier cleanup was not independently confirmed');
  writePrivateJson(journalDirectory, `${receiptName}.private.json`, { versionId,
    assetCount: manifest.length, totalBytes: manifest.reduce((sum, row) => sum + row.size, 0),
    temporaryVerifierRemoved: true, absenceVerified: true, automaticRetry: false });
  return result.assets;
}

function deploymentRows(snapshot, app) {
  return snapshot?.[app]?.deployment?.versions?.map(row => ({ versionId: row.version_id, percentage: row.percentage }))
    .sort((a, b) => a.versionId.localeCompare(b.versionId));
}
function withoutSelectedDeployment(state, app) {
  const stable = stableState(state, app);
  const selected = stable[app];
  delete selected.deployment;
  return stable;
}
function expectedForPhase(base, app, rows) {
  const result = structuredClone(base ?? {});
  result[app] = rows;
  return result;
}
function sameExceptSelectedDeployment(before, after, app) {
  return equal(withoutSelectedDeployment(before, app), withoutSelectedDeployment(after, app));
}

export function qualifyPriorCandidateResumeJournal(resumeCandidate, { app, baselineVersionId, pinnedPlan, oldAssetCount, oldAssetBytes, cliPath } = {}) {
  needFn(app === 'operations' && resumeCandidate && path.isAbsolute(resumeCandidate.priorJournalDirectory ?? '')
    && UUID.test(resumeCandidate.candidateId ?? '') && resumeCandidate.originalSnapshot,
  'Resume is limited to an explicitly identified inactive Operations candidate and original snapshot');
  const directory = path.resolve(resumeCandidate.priorJournalDirectory);
  needFn(!fs.lstatSync(directory).isSymbolicLink() && fs.statSync(directory).isDirectory(), 'Prior candidate journal directory must be a real directory');
  const readJson = name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    needFn(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 8 * 1024 * 1024,
      `Prior candidate journal ${name} is missing or outside its bound`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const journalPath = path.join(directory, 'journal.jsonl'), journalStat = fs.lstatSync(journalPath);
  needFn(journalStat.isFile() && !journalStat.isSymbolicLink() && journalStat.nlink === 1
    && journalStat.size > 0 && journalStat.size <= 8 * 1024 * 1024, 'Prior journal is missing or outside its bound');
  const journalBytes = fs.readFileSync(journalPath);
  const rows = journalBytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const uploadIndex = rows.findIndex(row => row.phase === 'native-version-upload');
  const verifierName = rows[0]?.verifierName, verifierPath = `/workers/scripts/${verifierName}`;
  const expectedKeys = [
    ['sequence','at','phase','workerName','verifiedVersionId','verifierName','assetCount','receiptName','automaticRetry'],
    ['sequence','at','phase','requestId','method','path','name','workerName','sourceSHA256','sourceCommit','automaticRetry'],
    ['sequence','at','phase','requestId','method','path','name','sourceCommit','automaticRetry'],
    ['sequence','at','phase','requestId','method','path','name','sourceCommit','automaticRetry'],
    ['sequence','at','phase','sourceCommit','workerName','parentVersionId','mainSHA256','mapSHA256','ledgerSHA256','assetInventorySHA256','automaticRetry'],
  ];
  const exactPhases = ['temporary-asset-verifier-create','temporary-verifier-create','temporary-verifier-enable',
    'temporary-verifier-delete','native-version-upload'];
  needFn(equal(rows.map(row => row.phase), exactPhases)
    && rows.every((row, index) => row.sequence === index + 1 && row.automaticRetry === false
      && equal(Object.keys(row).sort(), expectedKeys[index].sort()))
    && rows[0].workerName === 'ledgetop-ops' && rows[0].verifiedVersionId === baselineVersionId
    && rows[0].assetCount === oldAssetCount && rows[0].receiptName === 'verified-prior-active-assets'
    && typeof verifierName === 'string' && /^ops-ui-verify-[a-f0-9]{24}$/u.test(verifierName)
    && rows[1].method === 'PUT' && rows[1].path === verifierPath && rows[1].name === verifierName
    && rows[1].workerName === 'ledgetop-ops' && rows[1].sourceSHA256 === REVIEWED_PRIOR_VERIFIER_SOURCE_SHA256
    && rows[1].sourceCommit === pinnedPlan.sourceCommit
    && rows[2].method === 'POST' && rows[2].path === `${verifierPath}/subdomain` && rows[2].name === verifierName
    && rows[2].sourceCommit === pinnedPlan.sourceCommit
    && rows[3].method === 'DELETE' && rows[3].path === verifierPath && rows[3].name === verifierName
    && rows[3].sourceCommit === pinnedPlan.sourceCommit && uploadIndex === rows.length - 1,
  'Prior journal differs from the exact completed baseline verifier and single upload sequence');
  needFn(!fs.existsSync(path.join(directory, 'namespace-stage-intent.json'))
    && !fs.existsSync(path.join(directory, 'activate-intent.json'))
    && !fs.existsSync(path.join(directory, 'namespace-stage-pid.json'))
    && !fs.existsSync(path.join(directory, 'activate-pid.json')),
  'Prior journal contains a consumed namespace-stage or activation intent');
  const uploadIntent = rows.find(row => row.phase === 'native-version-upload');
  const uploadExit = readJson('upload-exit.json'), candidate = readJson('candidate.private.json'), plan = readJson('release-plan.private.json');
  const uploadCommand = readJson('upload-intent.json');
  const priorAssetReceipt = readJson('verified-prior-active-assets.private.json');
  const uploadLogPath = path.join(directory, 'upload.private.log'), uploadLogStat = fs.lstatSync(uploadLogPath);
  needFn(uploadLogStat.isFile() && !uploadLogStat.isSymbolicLink() && uploadLogStat.nlink === 1 && uploadLogStat.size <= 8 * 1024 * 1024,
    'Prior upload result log is missing or outside its bound');
  const priorCandidate = parseCandidateId(fs.readFileSync(uploadLogPath, 'utf8'));
  const expectedPlanKeys = ['schemaVersion','contract','application','sourceCommit','baselineVersionId','ordinaryPlanSHA256',
    'ledgerSHA256','rollbackVersionId','assetProviderIdentifierProvenance','oldAssetCount','retainedAssetCount'];
  const expectedCandidateKeys = ['candidateId','parentVersionId'];
  const expectedUploadKeys = ['sequence','at','phase','sourceCommit','workerName','parentVersionId','mainSHA256','mapSHA256',
    'ledgerSHA256','assetInventorySHA256','automaticRetry'];
  const expectedCommandKeys = ['argv','phase','automaticRetry'];
  const argv = uploadCommand.argv;
  needFn(uploadExit.code === 0 && candidate.candidateId === resumeCandidate.candidateId && priorCandidate === candidate.candidateId
    && candidate.parentVersionId === baselineVersionId && uploadIntent.workerName === 'ledgetop-ops'
    && equal(Object.keys(candidate).sort(), expectedCandidateKeys.sort())
    && equal(Object.keys(plan).sort(), expectedPlanKeys.sort())
    && equal(Object.keys(uploadIntent).sort(), expectedUploadKeys.sort())
    && equal(Object.keys(uploadCommand).sort(), expectedCommandKeys.sort())
    && uploadCommand.phase === 'upload' && uploadCommand.automaticRetry === false
    && Array.isArray(argv) && argv.length === 7 && argv[0] === process.execPath && argv[1] === '--no-warnings'
    && path.resolve(argv[2]) === path.resolve(cliPath ?? '') && argv[3] === 'versions' && argv[4] === 'upload'
    && argv[5] === '--config' && path.resolve(argv[6]) === path.join(directory, 'wrangler.retained.private.json')
    && uploadIntent.parentVersionId === baselineVersionId && uploadIntent.sourceCommit === pinnedPlan.sourceCommit
    && uploadIntent.mainSHA256 === pinnedPlan.ordinaryPlan.release.main.sha256
    && uploadIntent.mapSHA256 === pinnedPlan.ordinaryPlan.release.sourceMap.sha256
    && uploadIntent.ledgerSHA256 === pinnedPlan.retentionLedgerSHA256
    && uploadIntent.assetInventorySHA256 === pinnedPlan.ordinaryPlan.browserProof.inventorySHA256
    && plan.schemaVersion === 2 && plan.contract === pinnedPlan.contract && plan.application === app
    && plan.sourceCommit === pinnedPlan.sourceCommit && plan.baselineVersionId === baselineVersionId
    && plan.ordinaryPlanSHA256 === pinnedPlan.ordinaryPlanSHA256
    && plan.ledgerSHA256 === pinnedPlan.retentionLedgerSHA256 && plan.rollbackVersionId === baselineVersionId
    && plan.oldAssetCount === oldAssetCount
    && plan.retainedAssetCount === pinnedPlan.retentionLedger.assets.length
    && equal(plan.assetProviderIdentifierProvenance, pinnedPlan.assetProviderIdentifierProvenance)
    && priorAssetReceipt.versionId === baselineVersionId && priorAssetReceipt.assetCount === oldAssetCount
    && priorAssetReceipt.totalBytes === oldAssetBytes
    && priorAssetReceipt.temporaryVerifierRemoved === true && priorAssetReceipt.absenceVerified === true
    && priorAssetReceipt.automaticRetry === false,
  'Prior upload journal, candidate, source or retained plan pins do not match the supplied candidate');
  return Object.freeze({ candidateId: candidate.candidateId, priorJournalSHA256: sha(journalBytes),
    priorUploadLogSHA256: sha(fs.readFileSync(uploadLogPath)), priorPlanSHA256: sha(fs.readFileSync(path.join(directory, 'release-plan.private.json'))) });
}

export function assertResumeControls(original, current, { app, candidateId, profile, expectedDeploymentVersions, opsSuccessorReaderContract }) {
  needFn(current?.[app]?.latest === candidateId
    && (current[app].latestVersion == null || current[app].latestVersion.id === candidateId)
    && (current[app].latestModern == null || current[app].latestModern.id === candidateId),
  'Resume requires the exact supplied inactive candidate to remain the latest version');
  validateInstallation(current, { allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app, opsSuccessorReaderContract });
  const rows = deploymentRows(current, app);
  needFn(equal(rows, deploymentRows(original, app)), 'Resume refuses any candidate already staged or any changed deployment weights');
  const normalized = structuredClone(current); normalized[app].latest = original[app].latest;
  needFn(equal(stableState(normalized, app), stableState(original, app)),
    'Resume current controls differ from the exact original baseline beyond the latest candidate pointer');
  needFn(equal(current[app].version, original[app].version) && equal(current[app].modern, original[app].modern),
    'Resume active baseline version metadata or modules differ from the original snapshot');
  for (const other of Object.keys(original).filter(name => name !== app)) needFn(
    equal(current[other].version, original[other].version) && equal(current[other].modern, original[other].modern)
      && equal(current[other].settings, original[other].settings) && equal(current[other].schedules, original[other].schedules),
    'Resume another Worker version, module, setting, or schedule changed');
}

export function stageRetainedAssets(directory, plan, previousLedger, previousAssetBytes) {
  const current = collectFrontendAssets(plan.ordinaryPlan.release.assets.directory);
  const retained = preserveRootHtmlArchive({ application: plan.application, previous: previousLedger,
    previousAssetBytes, current });
  needFn(equal(retained.archive, plan.rootHtmlArchive ?? null), 'Retained root HTML archive differs from compiled plan');
  const payloads = retained.current.payloads;
  const target = path.join(directory, 'retained-assets'); fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  for (const row of plan.retentionLedger.assets) {
    const bytes = payloads.get(row.path);
    needFn(Buffer.isBuffer(bytes) && bytes.length === row.size && sha(bytes) === row.sha256, 'Retained union asset bytes differ from canonical ledger');
    const output = path.resolve(target, row.path.slice(1));
    needFn(output.startsWith(`${target}${path.sep}`), 'Retained union asset escaped staging root');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  }
  fs.writeFileSync(path.join(target, '.assetsignore'), 'wrangler.json\n.dev.vars\n', { flag: 'wx', mode: 0o600 });
  const checked = collectFrontendAssets(target);
  // Local extension-based MIME inference is not authoritative for retained
  // assets (for example, deployed .ico responses may be image/vnd.microsoft.icon).
  // Pin local upload paths and bytes here; the nonce service-binding verifier
  // independently checks the MIME actually served by the staged Worker.
  needFn(equal(checked.entries.map(({ path: assetPath, size, sha256 }) => ({ path: assetPath, size, sha256 })),
    plan.retentionLedger.assets.map(({ path: assetPath, size, sha256 }) => ({ path: assetPath, size, sha256 }))),
  'Staged browser asset union differs from retained ledger');
  return target;
}

function writePrivateJson(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * Callable ordinary frontend release state machine. Worker release mutations
 * use native Wrangler versions upload/deploy. Temporary verifier create/delete
 * calls use the separate journaled provider adapter and happen only after exact source,
 * installed v3 profile, retained old bytes, current controls and (for Ops)
 * the explicitly selected reviewed staff authority contract have passed. No automatic replay or rollback.
 *
 * Tests can inject bounded low-level adapters. An adapter returns observations
 * or native CLI text/exit status, never a `ready` authorization boolean.
 */
export async function executeOrdinaryFrontendRetainedRelease({ app, plan: pinnedPlan, profile, expectedDeploymentVersions, assetVerifierProvider,
  staffAuthorityContract = 'native-staff-cutover-v1', staffCutoverReview, staffReviewPath,
  frontendAuthorityReview, post0226StaffPreservationReview, resumeCandidate, installedOpsSuccessorReaderContract,
  readFrontendAuthority = readOrdinaryFrontendAuthorityObservation,
  readPost0226StaffPreservation = readPost0226StaffPreservationObservation,
  reader, cli, journalDirectory, artifactSourceRoot, executorSourceRoot = ROOT, fetchImpl = fetch,
  runNative = runNativeProductionCommand, captureFn = capture, readStaffCutover = readNativeStaffCutoverReadiness,
  sourceReader = deploymentSourceCommit, now = () => Date.now() } = {}) {
  frontendAuthorityReview = frontendAuthorityReview ? structuredClone(frontendAuthorityReview) : undefined;
  post0226StaffPreservationReview = post0226StaffPreservationReview ? structuredClone(post0226StaffPreservationReview) : undefined;
  const ordinaryPlan = pinnedPlan?.ordinaryPlan;
  needFn(['operations', 'client'].includes(app) && pinnedPlan?.schemaVersion === 2
    && pinnedPlan.contract === 'ordinary-frontend-retained-native-module-v2'
    && ordinaryPlan?.application === app && reader
    && typeof runNative === 'function' && typeof captureFn === 'function' && typeof readStaffCutover === 'function'
    && typeof sourceReader === 'function' && typeof now === 'function' && path.isAbsolute(journalDirectory ?? '')
    && path.isAbsolute(artifactSourceRoot ?? '') && path.isAbsolute(executorSourceRoot ?? ''),
  'Ordinary retained executor inputs invalid');
  const isReviewedSuccessorPlan = app === 'operations' && ordinaryPlan.sourceCommit === REVIEWED_SUCCESSOR_SOURCE_COMMIT
    && ordinaryPlan.release.main.sha256 === REVIEWED_SUCCESSOR_MAIN_SHA256
    && ordinaryPlan.release.sourceMap.sha256 === REVIEWED_SUCCESSOR_MAP_SHA256;
  needFn(!isReviewedSuccessorPlan || (resumeCandidate?.candidateId === REVIEWED_SUCCESSOR_CANDIDATE_ID),
    'The reviewed a0 Ops candidate can only continue through its exact existing-candidate resume path');
  needFn(!resumeCandidate || (app === 'operations' && isReviewedSuccessorPlan
    && resumeCandidate.candidateId === REVIEWED_SUCCESSOR_CANDIDATE_ID),
  'Resume is limited to the exact reviewed inactive a0 Operations candidate');
  needFn(typeof profile === 'object' && profile !== null && hash(canonical(profile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    'Original exact installed profile v3 is required');
  needFn(installedOpsSuccessorReaderContract === undefined
    || installedOpsSuccessorReaderContract === OPS_SUCCESSOR_READER_INSTALLED_CONTRACT,
  'Unreviewed installed Ops successor reader contract');
  needFn(installedOpsSuccessorReaderContract === undefined || app === 'client',
    'Installed Ops successor reader recognition is read-only and cannot authorize an Operations release');
  needFn(ordinaryPlan.installedOpsSuccessorReaderContract === installedOpsSuccessorReaderContract
    && pinnedPlan.installedOpsSuccessorReaderContract === installedOpsSuccessorReaderContract,
  'Executor selector must exactly match the read-only Ops contract pinned in both release plans');
  needFn(assetVerifierProvider && ['createVerifier','fetchVerifierAsset','removeVerifier','verifierAbsent']
    .every(name => typeof assetVerifierProvider[name] === 'function'), 'Bounded candidate namespace verifier is required before upload');
  expectedDeploymentVersions ??= ordinaryPlan.expectedDeploymentVersions;
  if (ordinaryPlan.expectedDeploymentVersions !== undefined) needFn(equal(expectedDeploymentVersions, ordinaryPlan.expectedDeploymentVersions),
    'Executor deployment weights differ from exact pinned plan');
  const sourceCommit = ordinaryPlan.sourceCommit;
  const artifactCommit = sourceReader(artifactSourceRoot), executorCommit = sourceReader(executorSourceRoot);
  needFn(artifactCommit === sourceCommit && pinnedPlan.sourceCommit === sourceCommit
    && /^[a-f0-9]{40}$/u.test(executorCommit ?? ''),
  'Ordinary release artifacts and clean executor checkout provenance must be independently pinned');
  const sourceStillPinned = () => sourceReader(artifactSourceRoot) === artifactCommit
    && sourceReader(executorSourceRoot) === executorCommit;
  const target = WORKERS[app], workerName = target.name;
  const cliPath = path.resolve(cli ?? path.join(ROOT, `apps/${app}/node_modules/wrangler/wrangler-dist/cli.js`));
  needFn(fs.existsSync(cliPath) && /^[a-f0-9]{64}$/u.test(PROFILE.wranglerRuntimeSHA256)
    && hash(fs.readFileSync(cliPath)) === PROFILE.wranglerRuntimeSHA256,
  'Installed native Wrangler binary is missing or differs from locked production runtime');
  validateBuildEnvironment();

  if (app === 'operations') {
    const rows = expectedDeploymentVersions?.operations;
    needFn(Array.isArray(rows) && rows.length === 2
      && rows.filter(row => row.percentage === 100).length === 1
      && rows.filter(row => row.percentage === 0).length === 1,
    'Operations requires the exact reviewed 0/100 baseline distribution in its pinned plan');
  }
  const liveAtStart = await captureFn(reader, { selectedApp: app, expectedDeploymentVersions });
  const before = resumeCandidate
    ? validateInstallation(structuredClone(resumeCandidate.originalSnapshot), { profile, selectedApp: app, expectedDeploymentVersions,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app })
    : validateInstallation(liveAtStart, { profile, selectedApp: app, expectedDeploymentVersions,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app, opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
  const baselineVersionId = before[app].version.id;
  const operationsBaselineRows = expectedDeploymentVersions?.operations
    ?? before.operations.deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage }));
  if (app === 'operations') needFn(expectedDeploymentVersions.operations.some(row => row.versionId === baselineVersionId && row.percentage === 100),
    'Reviewed Ops 100% baseline differs from captured active version');
  if (resumeCandidate) assertResumeControls(before, liveAtStart, { app, candidateId: resumeCandidate.candidateId, profile,
    expectedDeploymentVersions, opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
  const bootstrap = app === 'operations' ? prepareOpsLegacyLedgerBootstrap(before) : null;
  const installedLedger = bootstrap ? null : readInstalledRetainedAssetLedger(before, { app, workerName });
  const priorBytesRows = bootstrap ? bootstrap.previousAssetRows : installedLedger.assets;
  const priorResumeProof = resumeCandidate ? qualifyPriorCandidateResumeJournal(resumeCandidate, { app, baselineVersionId, pinnedPlan,
    oldAssetCount: priorBytesRows.length, oldAssetBytes: priorBytesRows.reduce((sum, row) => sum + row.size, 0), cliPath }) : null;
  const observedAt = Date.parse(pinnedPlan.retentionLedger?.observedAt);
  needFn(Number.isFinite(observedAt) && observedAt <= now() && (resumeCandidate || now() - observedAt <= 5 * 60_000),
    'Pinned retained plan ledger observation is stale');

  needFn(['native-staff-cutover-v1', ORDINARY_FRONTEND_AUTHORITY_CONTRACT, POST0226_STAFF_PRESERVATION_CONTRACT].includes(staffAuthorityContract),
    'Explicit supported Operations staff authority contract required');
  if (app !== 'operations') needFn(staffAuthorityContract === 'native-staff-cutover-v1' && !frontendAuthorityReview && !post0226StaffPreservationReview,
    'Client release cannot select an Operations-only authority contract');
  if (app === 'operations' && staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT) {
    needFn(frontendAuthorityReview && typeof readFrontendAuthority === 'function'
      && !staffCutoverReview && !staffReviewPath,
    'Frontend-only release requires its exact reviewed authority packet and separate snapshot reader');
  }
  if (app === 'operations' && staffAuthorityContract === 'native-staff-cutover-v1') {
    needFn(!frontendAuthorityReview && !post0226StaffPreservationReview,
      'Frontend-only authority packet requires its explicit contract discriminator');
  }
  if (app === 'operations' && staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT)
    needFn(!post0226StaffPreservationReview, 'Post-0226 authority packet requires its exact contract discriminator');
  if (app === 'operations' && staffAuthorityContract === POST0226_STAFF_PRESERVATION_CONTRACT)
    needFn(post0226StaffPreservationReview && typeof readPost0226StaffPreservation === 'function'
      && !frontendAuthorityReview && !staffCutoverReview && !staffReviewPath,
    'Post-0226 frontend release requires only its separate preservation review and reader');
  if (app === 'operations' && staffAuthorityContract !== POST0226_STAFF_PRESERVATION_CONTRACT)
    needFn(!post0226StaffPreservationReview, 'Post-0226 authority packet cannot accompany another staff contract');
  const observations = { beforeReadiness: null };
  const review = app === 'operations' && staffAuthorityContract === 'native-staff-cutover-v1'
    ? (staffCutoverReview ?? (staffReviewPath ? readStaffCutoverReview(staffReviewPath) : undefined)) : undefined;
  const qualifyStaff = async phase => {
    if (app !== 'operations') return null;
    if (staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT) {
      const observed = await readFrontendAuthority({ review: structuredClone(frontendAuthorityReview), sourceCommit });
      const receipt = validateOrdinaryFrontendAuthorityObservation(frontendAuthorityReview, observed, { sourceCommit, application: app, now: now() });
      if (observations.beforeReadiness) needFn(equal(
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'observedAt')),
        Object.fromEntries(Object.entries(observations.beforeReadiness).filter(([key]) => key !== 'observedAt'))),
      'Reviewed frontend-only staff authority changed during release; reconcile without retry');
      else observations.beforeReadiness = receipt;
      return receipt;
    }
    if (staffAuthorityContract === POST0226_STAFF_PRESERVATION_CONTRACT) {
      const observed = await readPost0226StaffPreservation({ sourceCommit });
      const receipt = validatePost0226StaffPreservationReview(post0226StaffPreservationReview, observed, { sourceCommit, now: now() });
      if (observations.beforeReadiness) needFn(equal(
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'observedAt')),
        Object.fromEntries(Object.entries(observations.beforeReadiness).filter(([key]) => key !== 'observedAt'))),
      'Reviewed post-0226 staff/login authority changed during release; reconcile without retry');
      else observations.beforeReadiness = receipt;
      return receipt;
    }
    needFn(review && typeof readStaffCutover === 'function', 'Operations requires the exact reviewed native staff cutover packet');
    const observed = await readStaffCutover({ review: structuredClone(review), sourceCommit });
    const receipt = validateStaffReadinessReceipt(observed, sourceCommit);
    if (observations.beforeReadiness) needFn(equal(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'observedAt')),
      Object.fromEntries(Object.entries(observations.beforeReadiness).filter(([key]) => key !== 'observedAt'))),
    'Native staff readiness changed during frontend release; reconcile without retry');
    else observations.beforeReadiness = receipt;
    return receipt;
  };
  await qualifyStaff('before-prior-asset-verification');
  preparePrivateProductionDirectory(journalDirectory);
  if (resumeCandidate) writePrivateJson(journalDirectory, 'resume-candidate.private.json', {
    schemaVersion: 1, candidateId: priorResumeProof.candidateId, baselineVersionId,
    originalSnapshotSHA256: hash(canonical(before)), pinnedPlanSHA256: hash(canonical(pinnedPlan)),
    sourceCommit, executorCommit, priorJournalSHA256: priorResumeProof.priorJournalSHA256,
    priorUploadLogSHA256: priorResumeProof.priorUploadLogSHA256,
    priorReleasePlanSHA256: priorResumeProof.priorPlanSHA256, uploadReplayed: false,
  });
  const priorAssetBytes = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: priorBytesRows, versionId: baselineVersionId, journalDirectory, receiptName: 'verified-prior-active-assets' });
  const previousLedger = bootstrap
    ? completeOpsLegacyLedgerBootstrap(bootstrap, { verifiedAssets: priorAssetBytes, verifiedVersionId: baselineVersionId })
    : installedLedger;
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before upload');
  needFn(hash(canonical(before)) === ordinaryPlan.baselineSHA256, 'Captured installation differs from exact pinned offline plan baseline');
  validateOrdinaryFrontendRetainedPlan(before, pinnedPlan, { ordinaryPlan, profile, previousLedger,
    previousAssetBytes: priorAssetBytes, observedAt: pinnedPlan.retentionLedger.observedAt,
    installedOpsSuccessorReaderContract });
  writePrivateJson(journalDirectory, 'release-plan.private.json', { schemaVersion: 2, contract: pinnedPlan.contract,
    application: app, sourceCommit, baselineVersionId, ordinaryPlanSHA256: pinnedPlan.ordinaryPlanSHA256,
    ledgerSHA256: pinnedPlan.retentionLedgerSHA256, rollbackVersionId: baselineVersionId,
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
    oldAssetCount: previousLedger.assets.length, retainedAssetCount: pinnedPlan.retentionLedger.assets.length });
  if (observations.beforeReadiness) writePrivateJson(journalDirectory, 'staff-before-upload.private.json', observations.beforeReadiness);
  const moduleStage = stageOrdinaryFrontendRetainedModules(pinnedPlan, path.join(journalDirectory, 'native-modules'));
  const assetDirectory = stageRetainedAssets(journalDirectory, pinnedPlan, previousLedger, priorAssetBytes);
  const config = retainedNativeConfig(pinnedPlan, moduleStage); config.assets.directory = assetDirectory;
  const configPath = path.join(journalDirectory, 'wrangler.retained.private.json'); writePrivateJson(journalDirectory, path.basename(configPath), config);

  const preuploadRaw = await captureFn(reader, { selectedApp: app, expectedDeploymentVersions });
  if (resumeCandidate) assertResumeControls(before, preuploadRaw, { app, candidateId: resumeCandidate.candidateId, profile, expectedDeploymentVersions });
  else {
    validateInstallation(preuploadRaw, { profile, selectedApp: app, expectedDeploymentVersions,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
      opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
    needFn(equal(stableState(before, app), stableState(preuploadRaw, app)), 'Production controls changed before native asset/module upload');
  }
  validateOrdinaryFrontendRetainedPlan(before, pinnedPlan, { ordinaryPlan, profile, previousLedger,
    previousAssetBytes: priorAssetBytes, observedAt: pinnedPlan.retentionLedger.observedAt,
    installedOpsSuccessorReaderContract });
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before candidate qualification');
  let candidateId;
  if (resumeCandidate) {
    candidateId = resumeCandidate.candidateId;
    writePrivateJson(journalDirectory, 'candidate.private.json', { candidateId, parentVersionId: baselineVersionId,
      resumedFromPriorUpload: true, uploadReplayed: false });
  } else {
    await qualifyStaff('before-upload-dispatch');
    appendIntent(journalDirectory, 'native-version-upload', { sourceCommit, workerName, parentVersionId: baselineVersionId,
      mainSHA256: ordinaryPlan.release.main.sha256, mapSHA256: ordinaryPlan.release.sourceMap.sha256,
      ledgerSHA256: pinnedPlan.retentionLedgerSHA256, assetInventorySHA256: ordinaryPlan.browserProof.inventorySHA256 });
    const uploadOutput = await runNative(cliPath, ['versions', 'upload', '--config', configPath], journalDirectory, 'upload', journalDirectory);
    candidateId = parseCandidateId(uploadOutput);
    writePrivateJson(journalDirectory, 'candidate.private.json', { candidateId, parentVersionId: baselineVersionId });
  }

  const candidate = await readCandidateVersionWithVisibilityRetry(reader, workerName, candidateId);
  const modern = await reader.get(`/workers/workers/${workerName}/versions/${candidateId}?include=modules`);
  const candidateResourceShape = resourcesShape(candidate.resources);
  const baselineResourceShape = resourcesShape(before[app].version.resources);
  const namedHandlerProof = app === 'operations' && !equal(candidateResourceShape, baselineResourceShape)
    ? verifyExactOpsSuccessorNamedHandlerAddition(before, candidate, { sourceCommit,
      mainSHA256: ordinaryPlan.release.main.sha256, sourceMapSHA256: ordinaryPlan.release.sourceMap.sha256 }) : null;
  const candidateContract = namedHandlerProof ? OPS_SUCCESSOR_READER_INSTALLED_CONTRACT : undefined;
  const moduleProof = verifyOrdinaryFrontendRetainedCandidateModules({ before, plan: pinnedPlan, candidate, modern,
    opsSuccessorReaderContract: candidateContract });
  writePrivateJson(journalDirectory, 'verified-inactive-candidate.private.json', { candidateId,
    sourceCommit, mainSHA256: ordinaryPlan.release.main.sha256, sourceMapSHA256: ordinaryPlan.release.sourceMap.sha256,
    candidateResourcesSHA256: hash(canonical(resourcesShape(candidate.resources))),
    baselineResourcesSHA256: hash(canonical(resourcesShape(before[app].version.resources))),
    namedHandlerProof, moduleProof, ...(resumeCandidate ? { resumedPriorUpload: true, uploadReplayed: false } : {}) });
  const candidateExpected = expectedDeploymentVersions;
  const inactive = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: candidateExpected }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
  const expectedInactive = structuredClone(before); expectedInactive[app].latest = candidateId;
  needFn(equal(stableState(inactive, app), stableState(expectedInactive, app)), 'Production controls changed after inactive candidate upload');
  if (resumeCandidate) needFn(equal(inactive[app].latestVersion, candidate)
    && equal(inactive[app].latestModern, modern), 'Current latest candidate metadata differs from the exact candidate GET');
  const stageRows = [{ versionId: baselineVersionId, percentage: 100 }, { versionId: candidateId, percentage: 0 }];
  const stageExpectations = expectedForPhase(expectedDeploymentVersions, app, stageRows);
  await qualifyStaff('before-candidate-namespace-stage');
  if (resumeCandidate) assertResumeControls(before, await captureFn(reader, { selectedApp: app, expectedDeploymentVersions }), {
    app, candidateId, profile, expectedDeploymentVersions });
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before candidate namespace stage');
  appendIntent(journalDirectory, 'native-candidate-namespace-stage', { sourceCommit, executorCommit, workerName,
    baselineVersionId, candidateVersionId: candidateId, exactWeights: stageRows,
    ...(resumeCandidate ? { resumedPriorUpload: true, priorJournalSHA256: priorResumeProof.priorJournalSHA256 } : {}),
    droppedPreviousZeroPercentRow: app === 'operations'
      ? (operationsBaselineRows.find(row => row.percentage === 0)?.versionId ?? null) : null });
  await runNative(cliPath, ['versions', 'deploy', `${baselineVersionId}@100%`, `${candidateId}@0%`, '--yes', '--config', configPath],
    journalDirectory, 'namespace-stage', journalDirectory);
  const staged = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: stageExpectations }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions: stageExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
  needFn(equal(deploymentRows(staged, app), [...stageRows].sort((a, b) => a.versionId.localeCompare(b.versionId)))
    && sameExceptSelectedDeployment(inactive, staged, app), 'Candidate namespace stage did not produce exact baseline100/candidate0 with unchanged controls');
  await qualifyStaff('before-candidate-asset-verification');
  const candidateAssetBytes = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: pinnedPlan.retentionLedger.assets, versionId: candidateId, journalDirectory, receiptName: 'verified-candidate-assets' });
  needFn(candidateAssetBytes.size === pinnedPlan.retentionLedger.assets.length && pinnedPlan.retentionLedger.assets.every(row => {
    const bytes = candidateAssetBytes.get(row.path); return Buffer.isBuffer(bytes) && bytes.length === row.size && sha(bytes) === row.sha256;
  }), 'Inactive candidate static asset bytes differ from retained ledger');
  if (pinnedPlan.rootHtmlArchive) {
    const archive = pinnedPlan.rootHtmlArchive, bytes = candidateAssetBytes.get(archive.path);
    needFn(Buffer.isBuffer(bytes) && bytes.length === archive.size && sha(bytes) === archive.sha256,
      'Inactive candidate root HTML archive bytes differ from prior root document');
    writePrivateJson(journalDirectory, 'verified-candidate-root-html-archive.private.json', {
      candidateId, path: archive.path, transportPath: archive.transportPath, size: archive.size,
      sha256: archive.sha256, mime: archive.mime, verified: true });
  }
  const preactivation = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: stageExpectations }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions: stageExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: installedOpsSuccessorReaderContract });
  needFn(equal(deploymentRows(preactivation, app), deploymentRows(staged, app))
    && equal(stableState(staged, app), stableState(preactivation, app)), 'Staged deployment or controls changed immediately before activation');
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before activation');
  const preactivationReadiness = await qualifyStaff('before-activation');
  if (preactivationReadiness) writePrivateJson(journalDirectory, 'staff-before-activation.private.json', preactivationReadiness);

  appendIntent(journalDirectory, 'native-version-activate', { sourceCommit, workerName, candidateVersionId: candidateId,
    parentVersionId: baselineVersionId, exactRollbackVersionId: baselineVersionId, percentage: 100 });
  await runNative(cliPath, ['versions', 'deploy', `${candidateId}@100%`, '--yes', '--config', configPath], journalDirectory, 'activate', journalDirectory);
  const activationExpectations = app === 'operations'
    ? structuredClone(expectedDeploymentVersions)
    : expectedDeploymentVersions;
  if (app === 'operations') delete activationExpectations.operations;
  const afterRaw = await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: activationExpectations });
  if (namedHandlerProof) verifyExactOpsSuccessorNamedHandlerAddition(before, afterRaw.operations.version, {
    sourceCommit, mainSHA256: ordinaryPlan.release.main.sha256, sourceMapSHA256: ordinaryPlan.release.sourceMap.sha256 });
  const after = validateInstallation(afterRaw, { profile, selectedApp: app,
    expectedDeploymentVersions: activationExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: namedHandlerProof ? OPS_SUCCESSOR_READER_INSTALLED_CONTRACT : installedOpsSuccessorReaderContract });
  needFn(activeVersion(after[app]) === candidateId, 'Activation is uncertain; keep candidate and journal for GET-only reconciliation');
  needFn(deploymentRows(after, app)?.length === 1 && deploymentRows(after, app)[0].versionId === candidateId
    && deploymentRows(after, app)[0].percentage === 100, 'Postactivation distribution is not exactly candidate100');
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed during activation');
  const postactivationReadiness = await qualifyStaff('after-activation');
  if (postactivationReadiness) writePrivateJson(journalDirectory, 'staff-after-activation.private.json', postactivationReadiness);
  const activeCandidate = await readCandidateVersionWithVisibilityRetry(reader, workerName, candidateId);
  const activeModern = await reader.get(`/workers/workers/${workerName}/versions/${candidateId}?include=modules`);
  if (namedHandlerProof) verifyExactOpsSuccessorNamedHandlerAddition(before, activeCandidate, {
    sourceCommit, mainSHA256: ordinaryPlan.release.main.sha256, sourceMapSHA256: ordinaryPlan.release.sourceMap.sha256 });
  const activeModulesProof = verifyOrdinaryFrontendRetainedCandidateModules({ before, plan: pinnedPlan,
    candidate: activeCandidate, modern: activeModern, opsSuccessorReaderContract: candidateContract });
  const rollbackVersion = await readCandidateVersionWithVisibilityRetry(reader, workerName, baselineVersionId);
  const rollbackModern = await reader.get(`/workers/workers/${workerName}/versions/${baselineVersionId}?include=modules`);
  needFn(equal(rollbackVersion, before[app].version) && equal(rollbackModern, before[app].modern),
    'Exact baseline rollback version metadata changed; keep release held');
  await qualifyStaff('before-active-namespace-verification');
  const activeAssets = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: pinnedPlan.retentionLedger.assets, versionId: candidateId, journalDirectory, receiptName: 'verified-active-assets' });
  const postNamespaceRaw = await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: activationExpectations });
  if (namedHandlerProof) verifyExactOpsSuccessorNamedHandlerAddition(before, postNamespaceRaw.operations.version, {
    sourceCommit, mainSHA256: ordinaryPlan.release.main.sha256, sourceMapSHA256: ordinaryPlan.release.sourceMap.sha256 });
  const postNamespace = validateInstallation(postNamespaceRaw, {
    profile, selectedApp: app, expectedDeploymentVersions: activationExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: namedHandlerProof ? OPS_SUCCESSOR_READER_INSTALLED_CONTRACT : installedOpsSuccessorReaderContract });
  needFn(activeVersion(postNamespace[app]) === candidateId
    && deploymentRows(postNamespace, app)?.length === 1
    && deploymentRows(postNamespace, app)[0].versionId === candidateId
    && deploymentRows(postNamespace, app)[0].percentage === 100
    && equal(stableState(after, app), stableState(postNamespace, app)),
  'Production controls changed during post-cutover namespace byte verification');
  await qualifyStaff('after-active-namespace-verification');
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed during post-cutover verification');
  const providerCutoverAt = after[app].deployment.created_on, parsedCutover = parseProviderUtcTimestamp(providerCutoverAt);
  needFn(parsedCutover,
    'Actual active deployment cutover timestamp unavailable');
  const cutoverAt = new Date(parsedCutover.milliseconds).toISOString();
  const namespaceObservedAt = new Date(now()).toISOString();
  const earliestPermittedPruningAt = [minimumRetainedUntil(providerCutoverAt),
    new Date(Date.parse(namespaceObservedAt) + 48 * 60 * 60_000).toISOString()].sort().at(-1);
  const namespaceEvidence = { receipt: { schemaVersion: 1, workerName, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    sourceCommit, activeVersionId: candidateId, observedAt: namespaceObservedAt, cutoverAt,
    earliestPermittedPruningAt,
    minimumRetentionHours: 48, automaticPruning: false,
    oldServedWithin48hPaths: previousLedger.assets.filter(row => row.path !== '/index.html').map(row => row.path).sort(),
    assets: pinnedPlan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })),
    ...(pinnedPlan.rootHtmlArchive ? { rootHtmlArchive: pinnedPlan.rootHtmlArchive } : {}) },
    bytesByPath: activeAssets };
  const namespaceProof = verifyOrdinaryFrontendAssetNamespace({ plan: ordinaryPlan, candidateId,
    // v1 helper checks ledger ancestry; v2 separately binds that ledger to the
    // active version's exact embedded bytes before reusing its namespace proof.
    baselineVersionId: previousLedger.parentVersionId,
    previousLedger, previousAssetBytes: priorAssetBytes, namespaceEvidence, now: now(), accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId });
  // The independent verifier constructs the same retained union. Compare its
  // public asset inventory to the exact module ledger used for this candidate.
  needFn(equal(namespaceProof.retainedAssetLedger.assets.map(({ path: p, size, sha256, mime }) => ({ path: p, size, sha256, mime })),
    pinnedPlan.retentionLedger.assets.map(({ path: p, size, sha256, mime }) => ({ path: p, size, sha256, mime }))),
  'Post-cutover namespace union differs from native candidate ledger');
  if (pinnedPlan.rootHtmlArchive) {
    const archive = pinnedPlan.rootHtmlArchive, bytes = activeAssets.get(archive.path);
    needFn(Buffer.isBuffer(bytes) && bytes.length === archive.size && sha(bytes) === archive.sha256,
      'Active root HTML archive bytes differ from prior root document');
    writePrivateJson(journalDirectory, 'verified-active-root-html-archive.private.json', {
      candidateId, path: archive.path, transportPath: archive.transportPath, size: archive.size,
      sha256: archive.sha256, mime: archive.mime, verified: true });
  }
  writePrivateJson(journalDirectory, 'verified-active.private.json', { candidateId, sourceCommit, executorCommit,
    rollbackVersionId: baselineVersionId, moduleProof: activeModulesProof,
    ...(resumeCandidate ? { resumedPriorUpload: true, uploadReplayed: false } : {}),
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
    assetCount: namespaceProof.assetNamespaceQualification.assetCount,
    totalAssetBytes: namespaceProof.assetNamespaceQualification.totalBytes,
    assets: pinnedPlan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })),
    rootHtmlArchive: pinnedPlan.rootHtmlArchive ?? null,
    oldServedWithin48hPaths: namespaceEvidence.receipt.oldServedWithin48hPaths,
    providerCutoverAt, cutoverAt, namespaceObservedAt,
    earliestPermittedPruningAt: namespaceProof.assetNamespaceQualification.earliestPermittedPruningAt,
    automaticPruning: false, nativeExecutionQualification: { ready: false,
      reason: 'separate-executor-and-authority-qualification-required' } });
  return Object.freeze({ candidateId, rollbackVersionId: baselineVersionId, uploaded: !resumeCandidate,
    resumedPriorUpload: !!resumeCandidate, activated: true,
    candidateModulesVerified: true, activeNamespaceBytesVerified: true,
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
    earliestPermittedPruningAt: namespaceProof.assetNamespaceQualification.earliestPermittedPruningAt,
    nativeExecutionQualification: { ready: false, reason: 'separate-executor-and-authority-qualification-required' },
    journalDirectory });
}

/** Production entry point. Nothing invokes this automatically; callers must
 * supply a reviewed offline plan, the original accepted profile, and exactly
 * one Operations authority packet matching its explicit contract. */
export async function executeOrdinaryFrontendRetainedProduction({ app, plan, profile, expectedDeploymentVersions,
  staffAuthorityContract = 'native-staff-cutover-v1', artifactSourceRoot, staffReviewPath,
  frontendAuthorityReviewPath, post0226StaffPreservationReviewPath, journalDirectory, env = process.env, fetchImpl = fetch } = {}) {
  needFn(env.CLOUDFLARE_ACCOUNT_ID === NATIVE_STAFF_PRODUCTION_TARGET.accountId
    && typeof env.CLOUDFLARE_API_TOKEN === 'string' && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.CLOUDFLARE_API_TOKEN),
  'Cloudflare account and API token are required by the explicitly invoked production executor');
  validateBuildEnvironment(env);
  needFn(path.isAbsolute(artifactSourceRoot ?? ''), 'Pinned frontend artifact source checkout is required separately from executor source');
  const planSourceCommit = plan?.ordinaryPlan?.sourceCommit;
  needFn(plan?.schemaVersion === 2 && plan.contract === 'ordinary-frontend-retained-native-module-v2'
    && plan.application === app && planSourceCommit === plan.sourceCommit && HEX40.test(planSourceCommit ?? ''),
  'Pinned ordinary retained plan source identity is invalid');
  const reader = new CloudflareReader(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  needFn(staffAuthorityContract === 'native-staff-cutover-v1' || staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT
    || staffAuthorityContract === POST0226_STAFF_PRESERVATION_CONTRACT,
    'Explicit supported Operations staff authority contract required');
  const review = app === 'operations' && staffAuthorityContract === 'native-staff-cutover-v1'
    ? readStaffCutoverReview(staffReviewPath) : undefined;
  const frontendReview = app === 'operations' && staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT
    ? readStaffCutoverReview(frontendAuthorityReviewPath) : undefined;
  const post0226Review = app === 'operations' && staffAuthorityContract === POST0226_STAFF_PRESERVATION_CONTRACT
    ? readStaffCutoverReview(post0226StaffPreservationReviewPath) : undefined;
  if (app !== 'operations') needFn(!staffReviewPath && !frontendAuthorityReviewPath && !post0226StaffPreservationReviewPath,
    'Operations authority packets cannot be supplied for a Client release');
  if (staffAuthorityContract === 'native-staff-cutover-v1') needFn(!frontendAuthorityReviewPath && !post0226StaffPreservationReviewPath,
    'Frontend-only review packet requires its explicit authority contract');
  if (staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT) needFn(!staffReviewPath && !post0226StaffPreservationReviewPath,
    'Native cutover packet cannot be combined with frontend-only authority');
  if (staffAuthorityContract === POST0226_STAFF_PRESERVATION_CONTRACT)
    needFn(!staffReviewPath && !frontendAuthorityReviewPath, 'Post-0226 preservation review cannot be combined with another authority packet');
  validateProductionAuthorityPacketSelection({ app, review, frontendReview, post0226Review });
  const assetVerifierProvider = createJournaledAssetVerifierProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN, fetchImpl, profile: PROFILE, journalDirectory, sourceCommit: planSourceCommit });
  return executeOrdinaryFrontendRetainedRelease({ app, plan, profile, expectedDeploymentVersions,
    assetVerifierProvider, staffAuthorityContract, staffCutoverReview: review, frontendAuthorityReview: frontendReview,
    post0226StaffPreservationReview: post0226Review,
    reader, cli: path.join(ROOT, `apps/${app}/node_modules/wrangler/wrangler-dist/cli.js`),
    journalDirectory, artifactSourceRoot, executorSourceRoot: ROOT, fetchImpl,
    runNative: (cli, args, directory, phase, cwd) => runNativeProductionCommand(cli, args, directory, phase, cwd, env),
    sourceReader: root => deploymentSourceCommit(root, env),
    readStaffCutover: args => readNativeStaffCutoverReadiness(args) });
}

/** Operations releases select one authority packet; Client releases select none. */
export function validateProductionAuthorityPacketSelection({ app, review, frontendReview, post0226Review } = {}) {
  needFn(app === 'operations' || app === 'client', 'Production authority packet application is invalid');
  const count = [review, frontendReview, post0226Review].filter(Boolean).length;
  needFn(app === 'operations' ? count === 1 : count === 0,
    app === 'operations' ? 'Select exactly one Operations staff authority packet'
      : 'Client release cannot select an Operations staff authority packet');
  return true;
}

/** Bind every temporary verifier mutation intent to the already validated plan. */
export function createJournaledAssetVerifierProvider({ accountId, token, fetchImpl = fetch, profile = PROFILE,
  journalDirectory, sourceCommit, Provider = ProductionCloudflareProvider } = {}) {
  needFn(accountId === NATIVE_STAFF_PRODUCTION_TARGET.accountId && typeof token === 'string'
    && /^[A-Za-z0-9_-]{20,1024}$/u.test(token) && typeof fetchImpl === 'function'
    && path.isAbsolute(journalDirectory ?? '') && HEX40.test(sourceCommit ?? '') && typeof Provider === 'function',
  'Temporary asset verifier provider identity invalid');
  return new Provider({ accountId, token, fetchImpl, profile,
    recordIntent: intent => appendProviderIntent(journalDirectory, { ...intent, sourceCommit }),
    persistResponse: response => appendProviderResponseDigest(journalDirectory, response) });
}
