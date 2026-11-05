/**
 * Backend-only automatic release for ledgetop-ops-sync. It deliberately has
 * no asset ledger, asset-session, verifier Worker, or retained-asset phase.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical, capture, deploymentSourceCommit, PROFILE, CANONICAL_INSTALLED_PROFILE_V4_SHA256, resourcesShape,
  validateInstallation, verifySourceMap } from './production-deploy.mjs';
import { ProductionMainCI, isExactMainCiWorkflowPath } from './production-auto-ci.mjs';
import { ProductionCloudflareProvider, readCandidateVersionWithVisibilityRetry } from './production-auto-provider.mjs';
import { readProductionAutoTriggerRun, runBuild, parseProductionAutoLedger,
  productionAutoControlsSHA256, productionAutoBuildProfileSHA256, productionAutoInstalledPreflight } from './production-auto-runtime.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { readPost0226StaffPreservationObservation } from './ordinary-frontend-authority-post0226-reader.mjs';
import { loadPinnedProductionAutoPost0226PreservationPolicy,
  validateProductionAutoPost0226PreservationObservation,
  validateRepeatedProductionAutoPost0226PreservationReceipts,
  assertProductionAutoPost0226PreservationReceiptFresh } from './production-auto-post0226-policy.mjs';
import { validateProductionMigrationAdmission } from './production-auto-migration-readiness.mjs';
import { loadPinnedAppendOnlyMigrationProfile,
  readProductionMigrationReadiness as readProductionMigrationDiagnostics } from './production-auto-migration-classification.mjs';
import { createInstalledSchemaPreservationSession, isProductionInstalledSchemaPreservationAdmission } from './production-auto-migration-profile/installed-schema-preservation-v1/installed-schema-preservation.mjs';
import { ProductionAutoJournal, loadPinnedProductionAutoRecipient, readVerifiedProductionAutoPredecessor } from './production-auto-journal.mjs';
import { ledgerBytes } from './production-auto-assets.mjs';
import { parseProductionAutoPredecessorHandoff, validateLiveProductionAutoPredecessor,
  validateProductionAutoPredecessorProof } from './production-auto-predecessor.mjs';
import { isProviderUtcTimestamp } from './production-auto-time.mjs';
import { createProductionAutoCloudflarePacer } from './production-auto-cloudflare-pacer.mjs';
import { assertProductionAutoGitHubQuota } from './production-auto-github-quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = 'ledgetop-ops-sync', APP = 'ops-sync', SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const INTENT_LEASE_MAX_AGE_MS = 30_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, code) => { if (!condition) throw Error(code); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
function sourceMapBytes(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024, 'sync_build_map_invalid');
  let map; try { map = JSON.parse(bytes.toString('utf8')); } catch { need(false, 'sync_build_map_invalid'); }
  need(map?.version === 3 && Array.isArray(map.sources) && Array.isArray(map.sourcesContent)
    && map.sources.length > 0 && map.sources.length === map.sourcesContent.length
    && map.sources.every(value => typeof value === 'string') && map.sourcesContent.every(value => typeof value === 'string')
    && typeof map.mappings === 'string' && Array.isArray(map.names), 'sync_build_map_invalid');
  return map;
}
function stableControls(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([app, state]) => {
    const settings = structuredClone(state.settings), annotations = settings.annotations ?? {};
    delete annotations['workers/message']; delete annotations['workers/triggered_by'];
    return [app, { resources: resourcesShape(state.version.resources), settings, schedules: state.schedules,
      assets: state.modern.assets ?? null }];
  }));
}
function projectCapture(snapshot, allowedLatestVersionId) {
  const app = snapshot[APP], deployment = app.deployment;
  need(deployment.versions.length === 1 && deployment.versions[0].percentage === 100
    && deployment.versions[0].version_id === app.version.id
    && (app.latest === app.version.id || app.latest === allowedLatestVersionId),
  'sync_deployment_must_be_single_active');
  need(UUID.test(deployment.id ?? '') && isProviderUtcTimestamp(deployment.created_on),
    'sync_deployment_identity_invalid');
  return { activeVersionId: app.version.id, latestVersionId: app.latest, deploymentId: deployment.id,
    deployedAt: deployment.created_on, controlsSHA256: hash(Buffer.from(canonical(stableControls(snapshot)))) };
}
export function exactSyncReady(value, sourceCommit, now = Date.now()) {
  need(exact(value, ['schemaVersion','sourceCommit','accountId','databaseId','reviewSha256','cohortSha256',
    'controlPlaneSha256','observedAt','staffCount','generation']) && value.schemaVersion === 2
    && value.sourceCommit === sourceCommit && value.accountId === NATIVE_STAFF_PRODUCTION_TARGET.accountId
    && value.databaseId === NATIVE_STAFF_PRODUCTION_TARGET.databaseId
    && [value.reviewSha256, value.cohortSha256, value.controlPlaneSha256].every(value => SHA.test(value ?? ''))
    && Number.isSafeInteger(value.staffCount) && value.staffCount > 0 && value.staffCount <= 1024
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(now) && Number.isFinite(Date.parse(value.observedAt)) && Date.parse(value.observedAt) <= now
    && now - Date.parse(value.observedAt) <= 60_000,
  'sync_staff_readiness_invalid');
  return structuredClone(value);
}
function codeFor(phase) {
  return ({ 'sync-prepare': 'release_sync_prepare_failed', 'sync-upload': 'release_sync_upload_failed',
    'sync-candidate-readback': 'release_sync_candidate_readback_failed', 'sync-activate': 'release_sync_activate_failed',
    'sync-verify': 'release_sync_verify_failed' })[phase] ?? 'release_sync_prepare_failed';
}

export function verifySyncBackendCandidate({ before, candidate, modern, moduleBytes, sourceMap, candidateVersionId }) {
  const parentId = before?.[APP]?.version?.id;
  need(UUID.test(parentId ?? '') && UUID.test(candidateVersionId ?? '') && candidateVersionId !== parentId
    && candidate?.id === candidateVersionId && candidate.resources?.script?.last_deployed_from === 'api'
    && modern?.id === candidateVersionId
    && canonical(resourcesShape(candidate.resources)) === canonical(resourcesShape(before[APP].version.resources))
    && canonical(modern.assets ?? null) === canonical(before[APP].modern.assets ?? null)
    && Array.isArray(modern.modules) && new Set(modern.modules.map(row => row.name)).size === modern.modules.length
    && modern.modules.length === 2 && modern.modules.every(row => ['index.js','index.js.map'].includes(row.name)),
  'sync_candidate_resources_or_source_refused');
  const main = modern.modules.find(row => row.name === 'index.js'), map = modern.modules.find(row => row.name === 'index.js.map');
  need(main && Buffer.from(main.content_base64, 'base64').toString('base64') === main.content_base64
    && hash(Buffer.from(main.content_base64, 'base64')) === hash(moduleBytes)
    && map && Buffer.from(map.content_base64, 'base64').toString('base64') === map.content_base64,
  'sync_candidate_module_readback_refused');
  let observedMap; try { observedMap = JSON.parse(Buffer.from(map.content_base64, 'base64').toString('utf8')); }
  catch { need(false, 'sync_candidate_map_invalid'); }
  verifySourceMap(observedMap, sourceMap);
  return { candidateVersionId, moduleSHA256: hash(moduleBytes), sourceMapSHA256: hash(Buffer.from(map.content_base64, 'base64')) };
}

export function createProductionAutoSyncAdapter({ sourceCommit, triggerRun = readProductionAutoTriggerRun(), env = process.env,
  fetchImpl = fetch, profile = PROFILE, sourceReader = deploymentSourceCommit, ciFactory = options => new ProductionMainCI(options),
  providerFactory = options => new ProductionCloudflareProvider(options), journalFactory = options => new ProductionAutoJournal(options),
  recipientLoader = loadPinnedProductionAutoRecipient, preservationReader = readPost0226StaffPreservationObservation,
  buildRunner = runBuild, buildArtifactsReader, migrationReader = readProductionMigrationDiagnostics,
  schemaPreservationSessionFactory,
  schemaPreservationAdmissionCheck = isProductionInstalledSchemaPreservationAdmission,
  predecessorReader = readVerifiedProductionAutoPredecessor,
  cloudflarePacerFactory = fetchImpl === globalThis.fetch ? createProductionAutoCloudflarePacer : null,
  monotonicNow = () => performance.now() } = {}) {
  need(COMMIT.test(sourceCommit ?? '') && triggerRun?.sourceCommit === sourceCommit && typeof fetchImpl === 'function'
    && profile === PROFILE && env.CLOUDFLARE_ACCOUNT_ID === NATIVE_STAFF_PRODUCTION_TARGET.accountId
    && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.CLOUDFLARE_API_TOKEN ?? '')
    && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.GITHUB_TOKEN ?? '')
    && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && typeof monotonicNow === 'function', 'sync_runtime_identity_or_credentials_invalid');
  const predecessorHandoff = parseProductionAutoPredecessorHandoff(env, { workerName: WORKER, sourceCommit, triggerRun });
  const post0226Policy = loadPinnedProductionAutoPost0226PreservationPolicy(), preservationReceipts = [];
  need(typeof predecessorReader === 'function', 'sync_predecessor_reader_invalid');
  const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const cloudflarePacer = cloudflarePacerFactory ? cloudflarePacerFactory({ fetchImpl, accountId }) : null;
  const apiFetch = cloudflarePacer?.fetchImpl ?? fetchImpl;
  const githubCoreCalls = { count: 0 };
  const githubFetch = async (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch {}
    if (url?.origin === 'https://api.github.com' && url.pathname !== '/rate_limit') githubCoreCalls.count++;
    return apiFetch(input, init);
  };
  const assertGitHubQuota = () => assertProductionAutoGitHubQuota({ workerName: WORKER, bucketCount: 0,
    callsMade: githubCoreCalls.count, token: env.GITHUB_TOKEN, fetchImpl: apiFetch });
  const ci = ciFactory({ token: env.GITHUB_TOKEN, fetchImpl: githubFetch }), token = env.CLOUDFLARE_API_TOKEN;
  let migrationPins, schemaPreservationSession, latestSchemaAdmission, latestSchemaAdmissionOptions;
  const schemaSessionFactory = schemaPreservationSessionFactory ?? createInstalledSchemaPreservationSession;
  const usesV4SchemaPreservation = hash(Buffer.from(canonical(profile))) === CANONICAL_INSTALLED_PROFILE_V4_SHA256;
  const checkMigrations = async () => {
    if (usesV4SchemaPreservation) {
      if (!schemaPreservationSession) schemaPreservationSession = await schemaSessionFactory({
        sourceCommit, canonicalV4Profile: profile, selectedApp: APP, token, fetchImpl: githubFetch,
      });
      const admissionOptions = { allowLatest: candidateVersionId ? { [APP]: candidateVersionId } : {} };
      if (latestSchemaAdmission && canonical(admissionOptions) === canonical(latestSchemaAdmissionOptions)
        && schemaPreservationAdmissionCheck(latestSchemaAdmission)) return latestSchemaAdmission;
      latestSchemaAdmission = await schemaPreservationSession.observe(admissionOptions);
      latestSchemaAdmissionOptions = admissionOptions;
      need(typeof schemaPreservationAdmissionCheck === 'function' && schemaPreservationAdmissionCheck(latestSchemaAdmission),
        'sync_schema_preservation_admission_refused');
      return latestSchemaAdmission;
    }
    const observed = validateProductionMigrationAdmission(await migrationReader({ sourceCommit, root: ROOT, env, token, fetchImpl: githubFetch,
      appendOnlyProfile: loadPinnedAppendOnlyMigrationProfile() }), { sourceCommit });
    const { observedAt: _observedAt, ...pins } = observed;
    need(migrationPins === undefined || canonical(pins) === canonical(migrationPins), 'sync_migration_readiness_drift');
    migrationPins = pins;
    return observed;
  };
  const assertSchemaPreservationFresh = () => {
    if (usesV4SchemaPreservation) need(schemaPreservationAdmissionCheck(latestSchemaAdmission),
      'sync_schema_preservation_admission_stale');
  };
  const leaseFresh = lease => lease && Number.isFinite(lease.startedMono)
    && monotonicNow() >= lease.startedMono && monotonicNow() - lease.startedMono <= INTENT_LEASE_MAX_AGE_MS;
  let preflightLease = null, dispatchLease = null;
  const beforeDispatch = async info => {
    const permit = cloudflarePacer ? await cloudflarePacer.reserve({
      path: `/client/v4/accounts/${accountId}${info?.path ?? ''}`, method: info?.method ?? 'POST', signal: info?.signal,
    }) : undefined;
    try {
      await assertGitHubQuota();
      const lease = dispatchLease;
      const { signal: _signal, automaticRetry: _automaticRetry, ...request } = info ?? {};
      const { automaticRetry: _recordedAutomaticRetry, ...expectedRequest } = lease?.request ?? {};
      need(lease && !lease.consumed && leaseFresh(lease)
        && canonical(request) === canonical(expectedRequest)
        && lease.sourceCommit === sourceCommit && lease.runId === triggerRun.runId
        && lease.runAttempt === triggerRun.runAttempt
        && canonical(lease.expectedState) === canonical(expected)
        && lease.parentVersionId === expected?.activeVersionId
        && sourceReader(ROOT, env) === lease.sourceCommit,
      'sync_mutation_dispatch_lease_invalid');
      assertProductionAutoPost0226PreservationReceiptFresh(post0226Policy,
        preservationReceipts.at(-1), { sourceCommit });
      assertSchemaPreservationFresh();
      lease.consumed = true;
      dispatchLease = null;
      return permit;
    } catch (error) {
      if (permit) cloudflarePacer.cancel(permit);
      dispatchLease = null;
      throw error;
    }
  };
  let provider, journal, baseline, expected, build, candidateVersionId, writesAttempted = false;
  let predecessorOwnState;
  let phase = 'sync-prepare';
  const current = async () => {
    const raw = await capture(provider, { selectedApp: APP });
    const preservationPreflight = productionAutoInstalledPreflight(PROFILE, APP);
    const snapshot = validateInstallation(raw, { profile, selectedApp: APP, ...preservationPreflight,
      allowLatest: candidateVersionId ? { [APP]: candidateVersionId } : {} });
    return { snapshot, state: projectCapture(snapshot, candidateVersionId) };
  };
  const verifyPredecessor = async snapshot => {
    const proof = validateProductionAutoPredecessorProof(await predecessorReader({ token: env.GITHUB_TOKEN,
      ...predecessorHandoff, fetchImpl: githubFetch }), predecessorHandoff);
    need(proof.runtime.profileSha256 === productionAutoBuildProfileSHA256(), 'sync_predecessor_profile_drift');
    const ledger = parseProductionAutoLedger(snapshot, 'operations', 'ledgetop-ops', NATIVE_STAFF_PRODUCTION_TARGET.accountId);
    need(ledger.sourceCommit === sourceCommit && proof.finalReceipt.parentVersionId === ledger.parentVersionId
      && proof.finalReceipt.ledgerSHA256 === hash(ledgerBytes(ledger)),
    'sync_predecessor_ledger_drift');
    if (predecessorOwnState === undefined) predecessorOwnState = structuredClone(snapshot[APP]);
    // Sync's own candidate advances during this release; compare other controls
    // to the Ops receipt using the exact pre-mutation Sync capture.
    const controlsSnapshot = { ...snapshot, [APP]: predecessorOwnState };
    validateLiveProductionAutoPredecessor({ proof, snapshot, app: 'operations',
      controlsSHA256: productionAutoControlsSHA256(controlsSnapshot, 'operations'),
      expectedControlsSHA256: proof.startedReceipt.controlsSHA256 });
  };
  const reconcileReadOnly = async () => {
    const raw = await capture(provider, { selectedApp: APP });
    const latest = raw?.[APP]?.latest;
    need(UUID.test(latest ?? ''), 'sync_reconciliation_latest_invalid');
    const preservationPreflight = productionAutoInstalledPreflight(PROFILE, APP);
    const checked = validateInstallation(raw, { profile, selectedApp: APP, ...preservationPreflight, allowLatest: { [APP]: latest } });
    const state = projectCapture(checked, latest);
    return { activeVersionId: state.activeVersionId, latestVersionId: state.latestVersionId,
      deploymentId: state.deploymentId, controlsUnchanged: state.controlsSHA256 === expected?.controlsSHA256 };
  };
  const verifySourceAndCI = async ({ migrationsChecked = false } = {}) => {
    if (!migrationsChecked) await checkMigrations();
    need(sourceReader(ROOT, env) === sourceCommit, 'sync_source_checkout_changed');
    const result = await ci.verify(sourceCommit);
    need(result.sourceCommit === sourceCommit && result.passed === true && result.runId === triggerRun.runId
      && result.runAttempt === triggerRun.runAttempt, 'sync_main_ci_not_exact_or_current');
    return result;
  };
  const checkSourceAndCI = async ({ migrationsChecked = false } = {}) => {
    const result = await verifySourceAndCI({ migrationsChecked });
    ensureProvider();
    const live = await current(); await verifyPredecessor(live.snapshot);
    return result;
  };
  const checkStaff = async () => {
    const observation = await preservationReader({ sourceCommit, env });
    const receipt = validateProductionAutoPost0226PreservationObservation(post0226Policy, observation, { sourceCommit });
    preservationReceipts.push(receipt);
    if (preservationReceipts.length > 1) validateRepeatedProductionAutoPost0226PreservationReceipts(post0226Policy,
      preservationReceipts, { sourceCommit });
    return receipt;
  };
  const assertFence = async state => {
    preflightLease = null;
    await checkMigrations(); await checkStaff();
    const startedMono = monotonicNow();
    const ciProof = await verifySourceAndCI({ migrationsChecked: true });
    ensureProvider();
    const observed = await current();
    await verifyPredecessor(observed.snapshot);
    need(JSON.stringify(observed.state) === JSON.stringify(state), 'sync_capture_fence_changed');
    need(sourceReader(ROOT, env) === sourceCommit && ciProof.sourceCommit === sourceCommit && ciProof.passed === true
      && ciProof.runId === triggerRun.runId && ciProof.runAttempt === triggerRun.runAttempt,
    'sync_intent_preflight_identity_invalid');
    const lease = { sourceCommit, runId: ciProof.runId, runAttempt: ciProof.runAttempt,
      expectedState: structuredClone(state), startedMono };
    need(leaseFresh(lease), 'sync_intent_preflight_stale');
    preflightLease = lease;
    return observed;
  };
  const ensureProvider = () => {
    if (provider) return;
    provider = providerFactory({ accountId, token, fetchImpl: apiFetch,
      recordIntent: async value => {
        need(preflightLease && !dispatchLease && leaseFresh(preflightLease)
          && preflightLease.sourceCommit === sourceCommit
          && canonical(preflightLease.expectedState) === canonical(expected)
          && value && value.automaticRetry === false && value.workerName === WORKER && value.method === 'POST'
          && value.parentVersionId === expected?.activeVersionId
          && ((value.phase === 'sync-version-upload'
            && value.path === `/workers/scripts/${WORKER}/versions?bindings_inherit=strict`
            && value.candidateVersionId === undefined)
            || (value.phase === 'sync-activate-candidate'
              && value.path === `/workers/scripts/${WORKER}/deployments`
              && value.candidateVersionId === expected?.latestVersionId)),
        'sync_mutation_intent_lease_invalid');
        await checkMigrations();
        need(leaseFresh(preflightLease), 'sync_mutation_intent_preflight_stale');
        await journal.recordIntent(value);
        dispatchLease = { request: structuredClone(value), sourceCommit: preflightLease.sourceCommit,
          runId: preflightLease.runId, runAttempt: preflightLease.runAttempt,
          expectedState: structuredClone(preflightLease.expectedState), parentVersionId: value.parentVersionId,
          startedMono: preflightLease.startedMono, consumed: false };
        preflightLease = null;
        writesAttempted = true;
      },
      persistResponse: value => journal.persistResponse(value), beforeDispatch, profile });
  };
  const adapter = {
    async release() {
      try {
      await checkMigrations(); await assertGitHubQuota();
      await checkSourceAndCI({ migrationsChecked: true });
      await checkStaff(); ensureProvider();
      const start = await current(); baseline = start.snapshot; expected = start.state;
      need(expected.activeVersionId === expected.latestVersionId, 'sync_incomplete_deployment_blocks_release');
      const activeModule = baseline[APP].modern.modules?.find(row => row.name === 'index.js');
      need(activeModule && typeof activeModule.content_base64 === 'string', 'sync_active_module_missing');
      if (buildArtifactsReader) {
        const artifact = buildArtifactsReader({ app: APP, sourceCommit });
        need(artifact && Buffer.isBuffer(artifact.moduleBytes) && Buffer.isBuffer(artifact.sourceMapBytes), 'sync_build_fixture_invalid');
        build = { moduleBytes: Buffer.from(artifact.moduleBytes), sourceMapBytes: Buffer.from(artifact.sourceMapBytes) };
      } else {
        await checkSourceAndCI(); buildRunner(APP);
        const mainPath = path.join(ROOT, 'apps', APP, 'dist', 'index.js');
        build = { moduleBytes: fs.readFileSync(mainPath), sourceMapBytes: fs.readFileSync(`${mainPath}.map`) };
      }
      need(build.moduleBytes.length > 0 && build.moduleBytes.length <= 32 * 1024 * 1024, 'sync_build_module_invalid');
      const map = sourceMapBytes(build.sourceMapBytes), moduleSHA256 = hash(build.moduleBytes);
      await checkStaff();
      await checkMigrations();
      const responseDirectory = path.join(ROOT, '.backups', 'production-auto-release', WORKER, sourceCommit);
      journal = journalFactory({ token: env.GITHUB_TOKEN, workerName: WORKER, releaseKind: 'backend-sync', sourceCommit,
        ciRunId: triggerRun.runId, ciRunAttempt: triggerRun.runAttempt, workflowRunId: Number(env.GITHUB_RUN_ID),
        workflowRunAttempt: Number(env.GITHUB_RUN_ATTEMPT), runtime: { profileSha256: hash(Buffer.from(JSON.stringify(profile))),
          moduleSha256: moduleSHA256, ledgerSha256: null }, recipient: recipientLoader(), responseDirectory, fetchImpl: githubFetch });
      await journal.receipt({ schemaVersion: 1, sourceCommit, workerName: WORKER, status: 'started', phase: 'sync-prepare',
        parentVersionId: expected.activeVersionId, controlsSHA256: expected.controlsSHA256, writesAttempted: false });
      await journal.receipt({ schemaVersion: 1, sourceCommit, workerName: WORKER, status: 'prepared', phase: 'sync-prepare',
        parentVersionId: expected.activeVersionId, controlsSHA256: expected.controlsSHA256, moduleSHA256 });

      phase = 'sync-upload';
      await assertGitHubQuota();
      let observed = await assertFence(expected);
      const annotations = { 'workers/message': `Ops Sync backend release ${sourceCommit.slice(0, 12)}`,
        'workers/tag': `auto-${sourceCommit.slice(0, 12)}` };
      const uploaded = await provider.createInactiveBackendVersion({ workerName: WORKER, state: observed.snapshot[APP],
        modules: { js: { bytes: build.moduleBytes, sha256: moduleSHA256 }, sourceMap: { bytes: build.sourceMapBytes,
          sha256: hash(build.sourceMapBytes) } }, annotations });
      candidateVersionId = uploaded.id;
      phase = 'sync-candidate-readback';
      const candidate = await readCandidateVersionWithVisibilityRetry(provider, WORKER, candidateVersionId);
      const modern = await provider.get(`/workers/workers/${WORKER}/versions/${candidateVersionId}?include=modules`);
      const candidateProof = verifySyncBackendCandidate({ before: baseline, candidate, modern,
        moduleBytes: build.moduleBytes, sourceMap: map, candidateVersionId });
      observed = await current();
      need(observed.state.activeVersionId === expected.activeVersionId && observed.state.latestVersionId === candidateVersionId
        && observed.state.deploymentId === expected.deploymentId && observed.state.controlsSHA256 === expected.controlsSHA256,
      'sync_candidate_capture_refused');
      expected = observed.state;
      await journal.receipt({ schemaVersion: 1, sourceCommit, workerName: WORKER, status: 'inactive-verified',
        phase: 'sync-candidate-readback', parentVersionId: baseline[APP].version.id, candidateVersionId,
        controlsSHA256: expected.controlsSHA256, moduleSHA256 });

      phase = 'sync-activate';
      await assertGitHubQuota();
      await assertFence(expected);
      await provider.activateBackendCandidate({ workerName: WORKER, parentVersionId: baseline[APP].version.id,
        candidateVersionId, message: `Ops Sync backend release ${sourceCommit.slice(0, 12)}` });
      phase = 'sync-verify';
      const after = await current();
      need(after.state.activeVersionId === candidateVersionId && after.state.latestVersionId === candidateVersionId
        && after.state.deploymentId !== expected.deploymentId && after.state.controlsSHA256 === expected.controlsSHA256
        && Date.parse(after.state.deployedAt) >= Date.parse(expected.deployedAt), 'sync_activation_readback_refused');
      await checkStaff(); await checkSourceAndCI();
      const final = await current();
      need(JSON.stringify(final.state) === JSON.stringify(after.state), 'sync_final_capture_changed');
      const receipt = { schemaVersion: 1, sourceCommit, workerName: WORKER, status: 'verified', phase: 'sync-verify',
        parentVersionId: baseline[APP].version.id, candidateVersionId, deploymentId: final.state.deploymentId,
        controlsSHA256: final.state.controlsSHA256, moduleSHA256, verifiedActive: true, writesAttempted: true };
      await journal.receipt(receipt);
      return { verifiedActive: true, candidateVersionId, deploymentId: final.state.deploymentId,
        moduleSHA256, sourceMapSHA256: candidateProof.sourceMapSHA256, releaseId: journal.releaseId };
      } catch (error) {
        if (journal) {
          let reconciliation = { readSucceeded: false };
          if (writesAttempted && provider && expected) {
            try { reconciliation = { readSucceeded: true, ...await reconcileReadOnly() }; }
            catch { /* Keep the original uncertainty; never retry or roll back. */ }
          }
          const migrationHoldCode = ['migration_required_pending', 'migration_application_schema_confirmation_required'].includes(error?.code)
            ? error.code : null;
          const failureCode = migrationHoldCode ?? codeFor(phase);
          const reconciliationCode = !writesAttempted ? 'not_attempted'
            : reconciliation.readSucceeded ? 'read_succeeded' : 'read_failed';
          try { await journal.receipt({ schemaVersion: 1, sourceCommit, workerName: WORKER, status: 'held', phase,
            ...(expected?.activeVersionId ? { parentVersionId: expected.activeVersionId } : {}),
            ...(candidateVersionId ? { candidateVersionId } : {}),
            ...(expected?.controlsSHA256 ? { controlsSHA256: expected.controlsSHA256 } : {}),
            ...(build?.moduleSHA256 ? { moduleSHA256: build.moduleSHA256 } : {}),
            writesAttempted, failureCode, reconciliationCode, reconciliation }); }
          catch { /* Preserve the earlier durable intent as unresolved. */ }
        }
        const migrationHoldCode = ['migration_required_pending', 'migration_application_schema_confirmation_required'].includes(error?.code)
          ? error.code : null;
        const held = new Error('Ops Sync backend release held; inspect the durable journal and reconcile read-only.');
        if (migrationHoldCode) held.code = migrationHoldCode;
        throw held;
      } finally { schemaPreservationSession?.close(); }
    },
  };
  return Object.freeze({ adapter, getJournal: () => journal, close: () => schemaPreservationSession?.close() });
}

export async function runProductionAutoSyncRelease({ env = process.env, fetchImpl = fetch,
  recipientLoader = loadPinnedProductionAutoRecipient, triggerReader = readProductionAutoTriggerRun,
  sourceReader = deploymentSourceCommit, runtimeFactory = createProductionAutoSyncAdapter } = {}) {
  need(env.PRODUCTION_AUTO_RELEASE_ENABLED === 'true', 'sync_auto_release_disabled');
  const recipient = recipientLoader();
  const triggerRun = triggerReader(env), sourceCommit = sourceReader(ROOT, env);
  need(triggerRun.sourceCommit === sourceCommit && isExactMainCiWorkflowPath('.github/workflows/ci.yml@main'),
    'sync_trigger_source_mismatch');
  const runtime = runtimeFactory({ sourceCommit, triggerRun, env, fetchImpl, recipientLoader: () => recipient, sourceReader });
  try { return await runtime.adapter.release(); }
  finally { runtime.close?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runProductionAutoSyncRelease())); }
  catch (error) {
    const reason = ['migration_required_pending', 'migration_application_schema_confirmation_required'].includes(error?.code)
      ? ` (${error.code})` : '';
    console.error(`Ops Sync automatic backend release held${reason}; inspect the durable journal and reconcile read-only.`);
    process.exitCode = 1;
  }
}
