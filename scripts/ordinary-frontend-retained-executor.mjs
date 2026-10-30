/** Explicit callable native-Wrangler executor for retained ordinary frontends.
 * It is intentionally not wired into production-deploy's CLI or automation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capture, CloudflareReader, deploymentSourceCommit, hash, canonical, need, PROFILE,
  preparePrivateProductionDirectory, readStaffCutoverReview, runNativeProductionCommand,
  stableState, validateBuildEnvironment, validateInstallation, validateStaffReadinessReceipt,
  ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256, ORDINARY_FRONTEND_PREFLIGHT_MODE } from './production-deploy.mjs';
import { readNativeStaffCutoverReadiness, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { collectVerifiedAssets, ASSET_VERIFICATION_LIMITS, createAssetVerificationNonce, executeAssetVerification } from './production-auto-verify.mjs';
import { readCandidateVersionWithVisibilityRetry } from './production-deploy.mjs';
import { ProductionCloudflareProvider, newTemporaryVerifierName } from './production-auto-provider.mjs';
import { collectFrontendAssets } from './production-auto-assets.mjs';
import { retainedNativeConfig, stageOrdinaryFrontendRetainedModules,
  validateInstalledRetainedLedger, validateOrdinaryFrontendRetainedPlan, verifyOrdinaryFrontendRetainedCandidateModules } from './ordinary-frontend-retained-plan.mjs';
import { verifyOrdinaryFrontendAssetNamespace } from './ordinary-frontend-candidate-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = Object.freeze({ operations: { name: 'ledgetop-ops', origin: 'https://ops.ledgetop.app' },
  client: { name: 'ledgetop-clients', origin: 'https://portal.ledgetop.app' } });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const equal = (a, b) => canonical(a) === canonical(b);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const needFn = (ok, message) => need(ok, message);

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

export async function readOrdinaryFrontendNamespaceAssets({ origin, workerName, entries, fetchImpl = fetch }) {
  needFn(Object.values(WORKERS).some(target => target.name === workerName && target.origin === origin)
    && typeof fetchImpl === 'function' && Array.isArray(entries) && entries.length > 0
    && entries.length <= ASSET_VERIFICATION_LIMITS.files, 'Namespace inventory exceeds bounded HTTP verifier limits');
  const rows = entries.map(row => ({ path: row.path, size: row.size, sha256: row.sha256,
    contentType: row.mime ?? row.contentType }));
  return collectVerifiedAssets({ entries: rows, timeoutMs: 120_000,
    fetchAsset: async ({ path: assetPath }, { method = 'GET', signal } = {}) => {
      needFn(['GET', 'HEAD'].includes(method) && typeof assetPath === 'string' && assetPath.startsWith('/') && !assetPath.startsWith('//'),
        'Namespace asset request path invalid');
      const requestPath = assetPath === '/index.html' ? (workerName === 'ledgetop-clients' ? '/portal' : '/') : assetPath;
      const url = new URL(requestPath, origin);
      needFn(url.origin === origin && url.pathname === requestPath && !url.search && !url.hash, 'Namespace asset URL escaped origin');
      const response = await fetchImpl(url, { method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: signal ?? AbortSignal.timeout(30_000),
        headers: { Accept: '*/*', 'Cache-Control': 'no-cache' } });
      needFn(response instanceof Response && response.status === 200 && !response.redirected,
        'Active static asset namespace did not return an exact 200');
      return response;
    } });
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
    && typeof intent.path === 'string' && intent.automaticRetry === false,
  'Temporary verifier mutation intent invalid');
  const detail = Object.fromEntries(['requestId','method','path','phase','name','workerName','sourceSHA256','automaticRetry']
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

async function verifyCandidateAssets({ provider, plan, candidateId, journalDirectory }) {
  needFn(provider && ['createVerifier','fetchVerifierAsset','removeVerifier','verifierAbsent'].every(name => typeof provider[name] === 'function'),
    'Journaled native asset verifier provider required');
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entries = plan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, contentType: mime }));
  const result = await executeAssetVerification({ entries, timeoutMs: 300_000,
    create: () => provider.createVerifier({ name, workerName: plan.workerName,
      origin: WORKERS[plan.application].origin, entries, nonceHash: nonce.nonceHash, versionId: candidateId }),
    fetchAsset: ({ path: assetPath }, { method, signal }) => provider.fetchVerifierAsset({ name, path: assetPath,
      method, bearer: nonce.bearer, signal }),
    remove: () => provider.removeVerifier(name), readAbsent: () => provider.verifierAbsent(name) });
  needFn(result.receipt.temporaryWorkerRemoved === true && result.receipt.absenceVerified === true,
    'Temporary candidate asset verifier cleanup was not independently confirmed');
  writePrivateJson(journalDirectory, 'verified-candidate-assets.private.json', { candidateId,
    assetCount: entries.length, totalBytes: entries.reduce((sum, row) => sum + row.size, 0),
    temporaryVerifierRemoved: true, absenceVerified: true, automaticRetry: false });
  return result.assets;
}

function stageRetainedAssets(directory, plan, previousAssetBytes) {
  const current = collectFrontendAssets(plan.ordinaryPlan.release.assets.directory), payloads = new Map(previousAssetBytes);
  for (const [assetPath, bytes] of current.payloads) payloads.set(assetPath, bytes);
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
  needFn(equal(checked.entries.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })),
    plan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime }))),
  'Staged browser asset union differs from retained ledger');
  return target;
}

function writePrivateJson(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * Callable ordinary frontend release state machine. All provider writes are
 * native Wrangler versions upload/deploy and happen only after exact source,
 * installed v3 profile, retained old bytes, current controls and (for Ops)
 * freshly read native staff consent have passed. No automatic replay or rollback.
 *
 * Tests can inject bounded low-level adapters. An adapter returns observations
 * or native CLI text/exit status, never a `ready` authorization boolean.
 */
export async function executeOrdinaryFrontendRetainedRelease({ app, plan: pinnedPlan, profile, expectedDeploymentVersions, assetVerifierProvider,
  staffCutoverReview, staffReviewPath, reader, cli, journalDirectory, fetchImpl = fetch,
  runNative = runNativeProductionCommand, captureFn = capture, readStaffCutover = readNativeStaffCutoverReadiness,
  sourceReader = deploymentSourceCommit, now = () => Date.now() } = {}) {
  const ordinaryPlan = pinnedPlan?.ordinaryPlan;
  needFn(['operations', 'client'].includes(app) && pinnedPlan?.schemaVersion === 2
    && pinnedPlan.contract === 'ordinary-frontend-retained-native-module-v2'
    && ordinaryPlan?.application === app && reader
    && typeof runNative === 'function' && typeof captureFn === 'function' && typeof readStaffCutover === 'function'
    && typeof sourceReader === 'function' && typeof now === 'function' && path.isAbsolute(journalDirectory ?? ''),
  'Ordinary retained executor inputs invalid');
  needFn(typeof profile === 'object' && profile !== null && hash(canonical(profile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    'Original exact installed profile v3 is required');
  needFn(assetVerifierProvider && ['createVerifier','fetchVerifierAsset','removeVerifier','verifierAbsent']
    .every(name => typeof assetVerifierProvider[name] === 'function'), 'Bounded candidate namespace verifier is required before upload');
  expectedDeploymentVersions ??= ordinaryPlan.expectedDeploymentVersions;
  if (ordinaryPlan.expectedDeploymentVersions !== undefined) needFn(equal(expectedDeploymentVersions, ordinaryPlan.expectedDeploymentVersions),
    'Executor deployment weights differ from exact pinned plan');
  needFn(sourceReader(ROOT) === ordinaryPlan.sourceCommit && pinnedPlan.sourceCommit === ordinaryPlan.sourceCommit,
    'Ordinary release source differs from exact clean reviewed commit');
  const sourceCommit = ordinaryPlan.sourceCommit, target = WORKERS[app], workerName = target.name;
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
  const before = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions }), {
    profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  const baselineVersionId = before[app].version.id;
  if (app === 'operations') needFn(expectedDeploymentVersions.operations.some(row => row.versionId === baselineVersionId && row.percentage === 100),
    'Reviewed Ops 100% baseline differs from captured active version');
  const previousLedger = readInstalledRetainedAssetLedger(before, { app, workerName });
  const priorBytesRows = previousLedger.assets;
  const priorAssetBytes = await readOrdinaryFrontendNamespaceAssets({ origin: target.origin, workerName, entries: priorBytesRows, fetchImpl });
  const observedAt = Date.parse(pinnedPlan.retentionLedger?.observedAt);
  needFn(Number.isFinite(observedAt) && observedAt <= now() && now() - observedAt <= 5 * 60_000,
    'Pinned retained plan ledger observation is stale');

  const observations = { beforeReadiness: null };
  const review = app === 'operations' ? (staffCutoverReview ?? (staffReviewPath ? readStaffCutoverReview(staffReviewPath) : undefined)) : undefined;
  const qualifyStaff = async phase => {
    if (app !== 'operations') return null;
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
  await qualifyStaff('before-upload');
  needFn(hash(canonical(before)) === ordinaryPlan.baselineSHA256, 'Captured installation differs from exact pinned offline plan baseline');
  validateOrdinaryFrontendRetainedPlan(before, pinnedPlan, { ordinaryPlan, profile, previousLedger,
    previousAssetBytes: priorAssetBytes, observedAt: pinnedPlan.retentionLedger.observedAt });
  preparePrivateProductionDirectory(journalDirectory);
  writePrivateJson(journalDirectory, 'release-plan.private.json', { schemaVersion: 2, contract: pinnedPlan.contract,
    application: app, sourceCommit, baselineVersionId, ordinaryPlanSHA256: pinnedPlan.ordinaryPlanSHA256,
    ledgerSHA256: pinnedPlan.retentionLedgerSHA256, rollbackVersionId: baselineVersionId,
    oldAssetCount: previousLedger.assets.length, retainedAssetCount: pinnedPlan.retentionLedger.assets.length });
  if (observations.beforeReadiness) writePrivateJson(journalDirectory, 'staff-before-upload.private.json', observations.beforeReadiness);
  const moduleStage = stageOrdinaryFrontendRetainedModules(pinnedPlan, path.join(journalDirectory, 'native-modules'));
  const assetDirectory = stageRetainedAssets(journalDirectory, pinnedPlan, priorAssetBytes);
  const config = retainedNativeConfig(pinnedPlan, moduleStage); config.assets.directory = assetDirectory;
  const configPath = path.join(journalDirectory, 'wrangler.retained.private.json'); writePrivateJson(journalDirectory, path.basename(configPath), config);

  const preupload = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions }), {
    profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  needFn(equal(stableState(before, app), stableState(preupload, app)), 'Production controls changed before native asset/module upload');
  validateOrdinaryFrontendRetainedPlan(preupload, pinnedPlan, { ordinaryPlan, profile, previousLedger,
    previousAssetBytes: priorAssetBytes, observedAt: pinnedPlan.retentionLedger.observedAt });
  needFn(sourceReader(ROOT) === sourceCommit, 'Reviewed source changed before upload');
  await qualifyStaff('before-upload-dispatch');
  appendIntent(journalDirectory, 'native-version-upload', { sourceCommit, workerName, parentVersionId: baselineVersionId,
    mainSHA256: ordinaryPlan.release.main.sha256, mapSHA256: ordinaryPlan.release.sourceMap.sha256,
    ledgerSHA256: pinnedPlan.retentionLedgerSHA256, assetInventorySHA256: ordinaryPlan.browserProof.inventorySHA256 });
  const uploadOutput = await runNative(cliPath, ['versions', 'upload', '--config', configPath], journalDirectory, 'upload', journalDirectory);
  const candidateId = parseCandidateId(uploadOutput);
  writePrivateJson(journalDirectory, 'candidate.private.json', { candidateId, parentVersionId: baselineVersionId });

  const candidate = await readCandidateVersionWithVisibilityRetry(reader, workerName, candidateId);
  const modern = await reader.get(`/workers/workers/${workerName}/versions/${candidateId}?include=modules`);
  const moduleProof = verifyOrdinaryFrontendRetainedCandidateModules({ before, plan: pinnedPlan, candidate, modern });
  const candidateAssetBytes = await verifyCandidateAssets({ provider: assetVerifierProvider, plan: pinnedPlan,
    candidateId, journalDirectory });
  needFn(candidateAssetBytes.size === pinnedPlan.retentionLedger.assets.length
    && pinnedPlan.retentionLedger.assets.every(row => {
      const bytes = candidateAssetBytes.get(row.path); return Buffer.isBuffer(bytes) && bytes.length === row.size && sha(bytes) === row.sha256;
    }), 'Inactive candidate static asset bytes differ from retained ledger');
  const inactive = validateInstallation(await captureFn(reader, { selectedApp: app, allowLatest: { [app]: candidateId }, expectedDeploymentVersions }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  const expectedInactive = structuredClone(before); expectedInactive[app].latest = candidateId;
  needFn(equal(stableState(inactive, app), stableState(expectedInactive, app)), 'Production controls changed after inactive candidate upload');
  const preactivation = validateInstallation(await captureFn(reader, { selectedApp: app, allowLatest: { [app]: candidateId }, expectedDeploymentVersions }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  needFn(equal(stableState(inactive, app), stableState(preactivation, app)), 'Production controls changed immediately before activation');
  needFn(sourceReader(ROOT) === sourceCommit, 'Reviewed source changed before activation');
  const preactivationReadiness = await qualifyStaff('before-activation');
  if (preactivationReadiness) writePrivateJson(journalDirectory, 'staff-before-activation.private.json', preactivationReadiness);

  appendIntent(journalDirectory, 'native-version-activate', { sourceCommit, workerName, candidateVersionId: candidateId,
    parentVersionId: baselineVersionId, exactRollbackVersionId: baselineVersionId, percentage: 100 });
  await runNative(cliPath, ['versions', 'deploy', `${candidateId}@100%`, '--yes', '--config', configPath], journalDirectory, 'activate', journalDirectory);
  const after = validateInstallation(await captureFn(reader, { selectedApp: app }), { profile, selectedApp: app,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  needFn(activeVersion(after[app]) === candidateId, 'Activation is uncertain; keep candidate and journal for GET-only reconciliation');
  const postactivationReadiness = await qualifyStaff('after-activation');
  if (postactivationReadiness) writePrivateJson(journalDirectory, 'staff-after-activation.private.json', postactivationReadiness);
  const activeCandidate = await readCandidateVersionWithVisibilityRetry(reader, workerName, candidateId);
  const activeModern = await reader.get(`/workers/workers/${workerName}/versions/${candidateId}?include=modules`);
  const activeModulesProof = verifyOrdinaryFrontendRetainedCandidateModules({ before, plan: pinnedPlan, candidate: activeCandidate, modern: activeModern });
  const rollbackVersion = await readCandidateVersionWithVisibilityRetry(reader, workerName, baselineVersionId);
  const rollbackModern = await reader.get(`/workers/workers/${workerName}/versions/${baselineVersionId}?include=modules`);
  needFn(equal(rollbackVersion, before[app].version) && equal(rollbackModern, before[app].modern),
    'Exact baseline rollback version metadata changed; keep release held');
  const activeAssets = await readOrdinaryFrontendNamespaceAssets({ origin: target.origin, workerName, entries: pinnedPlan.retentionLedger.assets, fetchImpl });
  const cutoverAt = after[app].deployment.created_on;
  needFn(typeof cutoverAt === 'string' && Number.isFinite(Date.parse(cutoverAt)) && new Date(Date.parse(cutoverAt)).toISOString() === cutoverAt,
    'Actual active deployment cutover timestamp unavailable');
  const namespaceObservedAt = new Date(now()).toISOString();
  const namespaceEvidence = { receipt: { schemaVersion: 1, workerName, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    sourceCommit, activeVersionId: candidateId, observedAt: namespaceObservedAt, cutoverAt,
    earliestPermittedPruningAt: new Date(Date.parse(cutoverAt) + 48 * 60 * 60_000).toISOString(),
    minimumRetentionHours: 48, automaticPruning: false,
    oldServedWithin48hPaths: previousLedger.assets.filter(row => row.path !== '/index.html').map(row => row.path).sort(),
    assets: pinnedPlan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })) },
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
  writePrivateJson(journalDirectory, 'verified-active.private.json', { candidateId, sourceCommit,
    rollbackVersionId: baselineVersionId, moduleProof: activeModulesProof,
    assetCount: namespaceProof.assetNamespaceQualification.assetCount,
    totalAssetBytes: namespaceProof.assetNamespaceQualification.totalBytes,
    assets: pinnedPlan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })),
    oldServedWithin48hPaths: namespaceEvidence.receipt.oldServedWithin48hPaths,
    cutoverAt, earliestPermittedPruningAt: namespaceProof.assetNamespaceQualification.earliestPermittedPruningAt,
    automaticPruning: false, nativeExecutionQualification: { ready: false,
      reason: 'separate-executor-and-authority-qualification-required' } });
  return Object.freeze({ candidateId, rollbackVersionId: baselineVersionId, uploaded: true, activated: true,
    candidateModulesVerified: true, activeNamespaceBytesVerified: true,
    earliestPermittedPruningAt: namespaceProof.assetNamespaceQualification.earliestPermittedPruningAt,
    nativeExecutionQualification: { ready: false, reason: 'separate-executor-and-authority-qualification-required' },
    journalDirectory });
}

/** Production entry point. Nothing invokes this automatically; callers must
 * supply a reviewed offline plan, the original accepted profile, and Ops packet. */
export async function executeOrdinaryFrontendRetainedProduction({ app, plan, profile, expectedDeploymentVersions,
  staffReviewPath, journalDirectory, env = process.env, fetchImpl = fetch } = {}) {
  needFn(env.CLOUDFLARE_ACCOUNT_ID === NATIVE_STAFF_PRODUCTION_TARGET.accountId
    && typeof env.CLOUDFLARE_API_TOKEN === 'string' && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.CLOUDFLARE_API_TOKEN),
  'Cloudflare account and API token are required by the explicitly invoked production executor');
  const sourceCommit = deploymentSourceCommit(ROOT, env), reader = new CloudflareReader(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  const review = app === 'operations' ? readStaffCutoverReview(staffReviewPath) : undefined;
  const assetVerifierProvider = new ProductionCloudflareProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN, fetchImpl, profile: PROFILE,
    recordIntent: intent => appendProviderIntent(journalDirectory, { ...intent, sourceCommit }),
    persistResponse: response => appendProviderResponseDigest(journalDirectory, response) });
  return executeOrdinaryFrontendRetainedRelease({ app, plan, profile, expectedDeploymentVersions,
    assetVerifierProvider, staffCutoverReview: review, reader, cli: path.join(ROOT, `apps/${app}/node_modules/wrangler/wrangler-dist/cli.js`),
    journalDirectory, fetchImpl, sourceReader: root => deploymentSourceCommit(root, env),
    readStaffCutover: args => readNativeStaffCutoverReadiness(args) });
}
