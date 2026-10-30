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
import { ORDINARY_FRONTEND_AUTHORITY_CONTRACT, validateOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority.mjs';
import { readOrdinaryFrontendAuthorityObservation } from './ordinary-frontend-authority-reader.mjs';
import { createAssetVerificationNonce, executeAssetVerification } from './production-auto-verify.mjs';
import { readCandidateVersionWithVisibilityRetry } from './production-deploy.mjs';
import { ProductionCloudflareProvider, newTemporaryVerifierName } from './production-auto-provider.mjs';
import { collectFrontendAssets } from './production-auto-assets.mjs';
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
  frontendAuthorityReview, readFrontendAuthority = readOrdinaryFrontendAuthorityObservation,
  reader, cli, journalDirectory, artifactSourceRoot, executorSourceRoot = ROOT, fetchImpl = fetch,
  runNative = runNativeProductionCommand, captureFn = capture, readStaffCutover = readNativeStaffCutoverReadiness,
  sourceReader = deploymentSourceCommit, now = () => Date.now() } = {}) {
  frontendAuthorityReview = frontendAuthorityReview ? structuredClone(frontendAuthorityReview) : undefined;
  const ordinaryPlan = pinnedPlan?.ordinaryPlan;
  needFn(['operations', 'client'].includes(app) && pinnedPlan?.schemaVersion === 2
    && pinnedPlan.contract === 'ordinary-frontend-retained-native-module-v2'
    && ordinaryPlan?.application === app && reader
    && typeof runNative === 'function' && typeof captureFn === 'function' && typeof readStaffCutover === 'function'
    && typeof sourceReader === 'function' && typeof now === 'function' && path.isAbsolute(journalDirectory ?? '')
    && path.isAbsolute(artifactSourceRoot ?? '') && path.isAbsolute(executorSourceRoot ?? ''),
  'Ordinary retained executor inputs invalid');
  needFn(typeof profile === 'object' && profile !== null && hash(canonical(profile)) === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    'Original exact installed profile v3 is required');
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
  const before = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions }), {
    profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  const baselineVersionId = before[app].version.id;
  const operationsBaselineRows = expectedDeploymentVersions?.operations
    ?? before.operations.deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage }));
  if (app === 'operations') needFn(expectedDeploymentVersions.operations.some(row => row.versionId === baselineVersionId && row.percentage === 100),
    'Reviewed Ops 100% baseline differs from captured active version');
  const bootstrap = app === 'operations' ? prepareOpsLegacyLedgerBootstrap(before) : null;
  const installedLedger = bootstrap ? null : readInstalledRetainedAssetLedger(before, { app, workerName });
  const priorBytesRows = bootstrap ? bootstrap.previousAssetRows : installedLedger.assets;
  const observedAt = Date.parse(pinnedPlan.retentionLedger?.observedAt);
  needFn(Number.isFinite(observedAt) && observedAt <= now() && now() - observedAt <= 5 * 60_000,
    'Pinned retained plan ledger observation is stale');

  needFn(['native-staff-cutover-v1', ORDINARY_FRONTEND_AUTHORITY_CONTRACT].includes(staffAuthorityContract),
    'Explicit supported Operations staff authority contract required');
  if (app !== 'operations') needFn(staffAuthorityContract === 'native-staff-cutover-v1' && !frontendAuthorityReview,
    'Client release cannot select an Operations-only authority contract');
  if (app === 'operations' && staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT) {
    needFn(frontendAuthorityReview && typeof readFrontendAuthority === 'function'
      && !staffCutoverReview && !staffReviewPath,
    'Frontend-only release requires its exact reviewed authority packet and separate snapshot reader');
  }
  if (app === 'operations' && staffAuthorityContract === 'native-staff-cutover-v1') {
    needFn(!frontendAuthorityReview, 'Frontend-only authority packet requires its explicit contract discriminator');
  }
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
  const priorAssetBytes = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: priorBytesRows, versionId: baselineVersionId, journalDirectory, receiptName: 'verified-prior-active-assets' });
  const previousLedger = bootstrap
    ? completeOpsLegacyLedgerBootstrap(bootstrap, { verifiedAssets: priorAssetBytes, verifiedVersionId: baselineVersionId })
    : installedLedger;
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before upload');
  needFn(hash(canonical(before)) === ordinaryPlan.baselineSHA256, 'Captured installation differs from exact pinned offline plan baseline');
  validateOrdinaryFrontendRetainedPlan(before, pinnedPlan, { ordinaryPlan, profile, previousLedger,
    previousAssetBytes: priorAssetBytes, observedAt: pinnedPlan.retentionLedger.observedAt });
  writePrivateJson(journalDirectory, 'release-plan.private.json', { schemaVersion: 2, contract: pinnedPlan.contract,
    application: app, sourceCommit, baselineVersionId, ordinaryPlanSHA256: pinnedPlan.ordinaryPlanSHA256,
    ledgerSHA256: pinnedPlan.retentionLedgerSHA256, rollbackVersionId: baselineVersionId,
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
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
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before upload');
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
  const candidateExpected = expectedDeploymentVersions;
  const inactive = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: candidateExpected }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  const expectedInactive = structuredClone(before); expectedInactive[app].latest = candidateId;
  needFn(equal(stableState(inactive, app), stableState(expectedInactive, app)), 'Production controls changed after inactive candidate upload');
  const stageRows = [{ versionId: baselineVersionId, percentage: 100 }, { versionId: candidateId, percentage: 0 }];
  const stageExpectations = expectedForPhase(expectedDeploymentVersions, app, stageRows);
  await qualifyStaff('before-candidate-namespace-stage');
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed before candidate namespace stage');
  appendIntent(journalDirectory, 'native-candidate-namespace-stage', { sourceCommit, workerName,
    baselineVersionId, candidateVersionId: candidateId, exactWeights: stageRows, droppedPreviousZeroPercentRow: app === 'operations'
      ? (operationsBaselineRows.find(row => row.percentage === 0)?.versionId ?? null) : null });
  await runNative(cliPath, ['versions', 'deploy', `${baselineVersionId}@100%`, `${candidateId}@0%`, '--yes', '--config', configPath],
    journalDirectory, 'namespace-stage', journalDirectory);
  const staged = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: stageExpectations }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions: stageExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  needFn(equal(deploymentRows(staged, app), [...stageRows].sort((a, b) => a.versionId.localeCompare(b.versionId)))
    && sameExceptSelectedDeployment(inactive, staged, app), 'Candidate namespace stage did not produce exact baseline100/candidate0 with unchanged controls');
  await qualifyStaff('before-candidate-asset-verification');
  const candidateAssetBytes = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: pinnedPlan.retentionLedger.assets, versionId: candidateId, journalDirectory, receiptName: 'verified-candidate-assets' });
  needFn(candidateAssetBytes.size === pinnedPlan.retentionLedger.assets.length && pinnedPlan.retentionLedger.assets.every(row => {
    const bytes = candidateAssetBytes.get(row.path); return Buffer.isBuffer(bytes) && bytes.length === row.size && sha(bytes) === row.sha256;
  }), 'Inactive candidate static asset bytes differ from retained ledger');
  const preactivation = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: stageExpectations }), {
    allowLatest: { [app]: candidateId }, profile, selectedApp: app, expectedDeploymentVersions: stageExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
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
  const after = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: activationExpectations }), { profile, selectedApp: app,
    expectedDeploymentVersions: activationExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  needFn(activeVersion(after[app]) === candidateId, 'Activation is uncertain; keep candidate and journal for GET-only reconciliation');
  needFn(deploymentRows(after, app)?.length === 1 && deploymentRows(after, app)[0].versionId === candidateId
    && deploymentRows(after, app)[0].percentage === 100, 'Postactivation distribution is not exactly candidate100');
  needFn(sourceStillPinned(), 'Reviewed artifact or executor source changed during activation');
  const postactivationReadiness = await qualifyStaff('after-activation');
  if (postactivationReadiness) writePrivateJson(journalDirectory, 'staff-after-activation.private.json', postactivationReadiness);
  const activeCandidate = await readCandidateVersionWithVisibilityRetry(reader, workerName, candidateId);
  const activeModern = await reader.get(`/workers/workers/${workerName}/versions/${candidateId}?include=modules`);
  const activeModulesProof = verifyOrdinaryFrontendRetainedCandidateModules({ before, plan: pinnedPlan, candidate: activeCandidate, modern: activeModern });
  const rollbackVersion = await readCandidateVersionWithVisibilityRetry(reader, workerName, baselineVersionId);
  const rollbackModern = await reader.get(`/workers/workers/${workerName}/versions/${baselineVersionId}?include=modules`);
  needFn(equal(rollbackVersion, before[app].version) && equal(rollbackModern, before[app].modern),
    'Exact baseline rollback version metadata changed; keep release held');
  await qualifyStaff('before-active-namespace-verification');
  const activeAssets = await verifyVersionAssets({ provider: assetVerifierProvider, application: app, workerName,
    entries: pinnedPlan.retentionLedger.assets, versionId: candidateId, journalDirectory, receiptName: 'verified-active-assets' });
  const postNamespace = validateInstallation(await captureFn(reader, { selectedApp: app, expectedDeploymentVersions: activationExpectations }), {
    profile, selectedApp: app, expectedDeploymentVersions: activationExpectations,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app });
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
  writePrivateJson(journalDirectory, 'verified-active.private.json', { candidateId, sourceCommit, executorCommit,
    rollbackVersionId: baselineVersionId, moduleProof: activeModulesProof,
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
    assetCount: namespaceProof.assetNamespaceQualification.assetCount,
    totalAssetBytes: namespaceProof.assetNamespaceQualification.totalBytes,
    assets: pinnedPlan.retentionLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime })),
    oldServedWithin48hPaths: namespaceEvidence.receipt.oldServedWithin48hPaths,
    providerCutoverAt, cutoverAt, namespaceObservedAt,
    earliestPermittedPruningAt: namespaceProof.assetNamespaceQualification.earliestPermittedPruningAt,
    automaticPruning: false, nativeExecutionQualification: { ready: false,
      reason: 'separate-executor-and-authority-qualification-required' } });
  return Object.freeze({ candidateId, rollbackVersionId: baselineVersionId, uploaded: true, activated: true,
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
  frontendAuthorityReviewPath, journalDirectory, env = process.env, fetchImpl = fetch } = {}) {
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
  needFn(staffAuthorityContract === 'native-staff-cutover-v1' || staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT,
    'Explicit supported Operations staff authority contract required');
  const review = app === 'operations' && staffAuthorityContract === 'native-staff-cutover-v1'
    ? readStaffCutoverReview(staffReviewPath) : undefined;
  const frontendReview = app === 'operations' && staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT
    ? readStaffCutoverReview(frontendAuthorityReviewPath) : undefined;
  if (app !== 'operations') needFn(!staffReviewPath && !frontendAuthorityReviewPath,
    'Operations authority packets cannot be supplied for a Client release');
  if (staffAuthorityContract === 'native-staff-cutover-v1') needFn(!frontendAuthorityReviewPath,
    'Frontend-only review packet requires its explicit authority contract');
  if (staffAuthorityContract === ORDINARY_FRONTEND_AUTHORITY_CONTRACT) needFn(!staffReviewPath,
    'Native cutover packet cannot be combined with frontend-only authority');
  needFn(!(review && frontendReview), 'Select exactly one Operations staff authority packet');
  const assetVerifierProvider = createJournaledAssetVerifierProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN, fetchImpl, profile: PROFILE, journalDirectory, sourceCommit: planSourceCommit });
  return executeOrdinaryFrontendRetainedRelease({ app, plan, profile, expectedDeploymentVersions,
    assetVerifierProvider, staffAuthorityContract, staffCutoverReview: review, frontendAuthorityReview: frontendReview,
    reader, cli: path.join(ROOT, `apps/${app}/node_modules/wrangler/wrangler-dist/cli.js`),
    journalDirectory, artifactSourceRoot, executorSourceRoot: ROOT, fetchImpl,
    runNative: (cli, args, directory, phase, cwd) => runNativeProductionCommand(cli, args, directory, phase, cwd, env),
    sourceReader: root => deploymentSourceCommit(root, env),
    readStaffCutover: args => readNativeStaffCutoverReadiness(args) });
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
