/** Concrete runtime adapters for the retained-asset coordinator.
 * Nothing in this module is enabled by default. The GitHub entry point checks
 * the reviewed response recipient before looking at provider credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical, capture, deploymentSourceCommit, PROFILE, CANONICAL_INSTALLED_PROFILE_V4_SHA256,
  ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, resourcesShape, validateBuildEnvironment, validateInstallation, varsOf, buildModulePath } from './production-deploy.mjs';
import { ProductionMainCI, isExactMainCiWorkflowPath } from './production-auto-ci.mjs';
import { ProductionCloudflareProvider, newTemporaryVerifierName, readCandidateVersionWithVisibilityRetry } from './production-auto-provider.mjs';
import { collectFrontendAssets, ledgerBytes, validateAssetLedger } from './production-auto-assets.mjs';
import { ASSET_VERIFICATION_LIMITS, createAssetVerificationNonce, executeAssetVerification } from './production-auto-verify.mjs';
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
import { parseProductionAutoPredecessorHandoff, validateLiveProductionAutoPredecessor,
  validateProductionAutoPredecessorProof } from './production-auto-predecessor.mjs';
import { coordinateProductionAutoRelease } from './production-auto-coordinate.mjs';
import { isProviderUtcTimestamp } from './production-auto-time.mjs';
import { assetBootstrapVerificationEntries, completeAssetInventoryBootstrap, prepareAssetInventoryBootstrap,
  readPinnedAssetInventoryBootstrap } from './production-auto-asset-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WORKERS = Object.freeze({ operations: { name: 'ledgetop-ops', origin: 'https://ops.ledgetop.app' },
  client: { name: 'ledgetop-clients', origin: 'https://portal.ledgetop.app' } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };
export function validateDeploymentTransitionIntent({ intent, candidateVersionId, parentVersionId,
  baselineVersionId, coordinatorFence, candidateReadbackVerified }) {
  need(intent && ['stage-zero-percent','activate-candidate'].includes(intent.phase)
    && candidateReadbackVerified === true && UUID.test(candidateVersionId ?? '')
    && UUID.test(parentVersionId ?? '') && parentVersionId === baselineVersionId
    && intent.candidateVersionId === candidateVersionId && intent.parentVersionId === parentVersionId
    && coordinatorFence?.candidateVersionId === candidateVersionId
    && coordinatorFence?.parentVersionId === parentVersionId,
  'runtime_deployment_intent_invalid');
  const expectedCount = intent.phase === 'stage-zero-percent' ? 2 : 1, rows = intent.versions;
  need(Array.isArray(rows) && rows.length === expectedCount
    && rows.every(row => UUID.test(row.version_id) && Number.isInteger(row.percentage) && row.percentage >= 0 && row.percentage <= 100)
    && new Set(rows.map(row => row.version_id)).size === rows.length, 'runtime_deployment_intent_invalid');
  if (intent.phase === 'stage-zero-percent') {
    need(rows.some(row => row.version_id === parentVersionId && row.percentage === 100)
      && rows.some(row => row.version_id === candidateVersionId && row.percentage === 0), 'runtime_deployment_intent_invalid');
    return { activeVersionId: parentVersionId, latestVersionId: candidateVersionId,
      versions: rows.map(row => ({ versionId: row.version_id, percentage: row.percentage })) };
  }
  need(rows[0].version_id === candidateVersionId && rows[0].percentage === 100, 'runtime_deployment_intent_invalid');
  return { activeVersionId: candidateVersionId, latestVersionId: candidateVersionId,
    versions: rows.map(row => ({ versionId: row.version_id, percentage: row.percentage })) };
}
export function readProductionAutoTriggerRun(env = process.env) {
  need(env.GITHUB_EVENT_NAME === 'workflow_run' && typeof env.GITHUB_EVENT_PATH === 'string' && path.isAbsolute(env.GITHUB_EVENT_PATH), 'runtime_trigger_event_missing');
  let fd;
  try {
    const st = fs.lstatSync(env.GITHUB_EVENT_PATH); need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= 64 * 1024);
    fd = fs.openSync(env.GITHUB_EVENT_PATH, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd); need(opened.isFile() && opened.nlink === 1 && opened.ino === st.ino && opened.dev === st.dev && opened.size === st.size);
    const bytes = fs.readFileSync(fd); need(bytes.length === st.size && bytes.length <= 64 * 1024);
    const event = JSON.parse(bytes.toString('utf8')), run = event?.workflow_run;
    need(run?.name === 'CI' && isExactMainCiWorkflowPath(run.path) && run.event === 'push'
      && run.status === 'completed' && run.conclusion === 'success' && run.head_branch === 'main'
      && run.repository?.full_name === 'ledgetoptechnologies/LedgeTop-Ops'
      && run.head_repository?.full_name === 'ledgetoptechnologies/LedgeTop-Ops'
      && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
      && /^[a-f0-9]{40}$/u.test(run.head_sha ?? ''), 'runtime_trigger_run_refused');
    return Object.freeze({ sourceCommit: run.head_sha, runId: run.id, runAttempt: run.run_attempt });
  } catch { need(false, 'runtime_trigger_event_invalid'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const activeVersion = state => {
  const rows = state?.deployment?.versions;
  need(Array.isArray(rows) && rows.length >= 1 && rows.length <= 2, 'runtime_deployment_shape_refused');
  const active = rows.filter(row => row?.percentage === 100);
  need(active.length === 1 && UUID.test(active[0].version_id), 'runtime_active_version_refused');
  return active[0].version_id;
};
function stableSettings(settings) {
  const copy = structuredClone(settings); copy.annotations ??= {};
  delete copy.annotations['workers/message']; delete copy.annotations['workers/triggered_by'];
  return copy;
}
function controlsProjection(snapshot, selectedApp) {
  return Object.fromEntries(Object.entries(snapshot).map(([app, state]) => [app, {
    settings: stableSettings(state.settings), schedules: state.schedules,
    resources: resourcesShape(state.version.resources), vars: varsOf(state),
    assetsConfig: app === 'ops-sync' ? null : state.modern.assets?.config,
    ...(app === selectedApp ? {} : { versionId: state.version.id, latestVersionId: state.latest,
      deploymentId: state.deployment.id, deploymentVersions: state.deployment.versions }),
  }]));
}
export function productionAutoControlsSHA256(snapshot, selectedApp) {
  return hash(Buffer.from(canonical(controlsProjection(snapshot, selectedApp))));
}
export function productionAutoInstalledPreflight(profile, app) {
  return hash(Buffer.from(canonical(profile))) === CANONICAL_INSTALLED_PROFILE_V4_SHA256
    ? { ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ordinaryFrontendApp: app } : {};
}
export function isProductionAutoCanonicalV4Profile(profile) {
  return hash(Buffer.from(canonical(profile))) === CANONICAL_INSTALLED_PROFILE_V4_SHA256;
}
function validatedCapture(snapshot, workerName, baselineAssetsConfig, baselineAssets, candidateVersionId, expectedDeploymentVersions) {
  const app = workerName === 'ledgetop-ops' ? 'operations' : 'client';
  const profile = structuredClone(PROFILE);
  const preservationPreflight = productionAutoInstalledPreflight(PROFILE, app);
  const exactCanonicalV4 = Object.keys(preservationPreflight).length > 0;
  // The normal profile pins the currently served asset association. Candidate
  // upload intentionally replaces that association; the fixed asset config,
  // every other protected control, and actual served bytes remain pinned.
  const allowLatest = candidateVersionId ? { [app]: candidateVersionId } : {};
  if (baselineAssetsConfig === undefined) validateInstallation(snapshot, { profile, allowLatest, ...preservationPreflight,
    expectedDeploymentVersions: expectedDeploymentVersions ? { [app]: expectedDeploymentVersions } : {} });
  else {
    const candidateAssetsSHA256 = hash(Buffer.from(canonical(snapshot[app].modern.assets ?? null)));
    if (!exactCanonicalV4) profile.workers[app].assetsSHA256 = candidateAssetsSHA256;
    validateInstallation(snapshot, { profile, allowLatest, ...preservationPreflight,
      ...(exactCanonicalV4 ? { assetAssociationOverrides: { [app]: { baselineAssets } } } : {}),
      expectedDeploymentVersions: expectedDeploymentVersions ? { [app]: expectedDeploymentVersions } : {} });
    need(canonical(snapshot[app].modern.assets?.config) === canonical(baselineAssetsConfig), 'runtime_asset_config_drift');
  }
  return snapshot;
}
function git(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 1024 * 1024 });
  need(!result.error && result.status === 0, 'runtime_git_source_refused'); return result.stdout.trim();
}
export function runBuild(app) {
  validateBuildEnvironment();
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--prefix', `apps/${app}`], {
    cwd: ROOT, env: productionAutoBuildEnvironment(process.env), encoding: 'utf8', windowsHide: true, shell: false, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  need(!result.error && result.status === 0, 'runtime_build_failed');
}
export function productionAutoBuildEnvironment(source = process.env) {
  const result = { ...source };
  for (const key of ['GITHUB_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','NATIVE_STAFF_CUTOVER_REVIEW_JSON',
    'GITHUB_OUTPUT','GITHUB_EVENT_PATH','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','ACTIONS_ID_TOKEN_REQUEST_URL']) delete result[key];
  return result;
}
export function productionAutoBuildProfileSHA256() { return hash(fs.readFileSync(path.join(ROOT, 'scripts/production-deploy-profile.json'))); }
function ensureAssetsIgnore(directory) {
  const file = path.join(directory, '.assetsignore'), expected = 'wrangler.json\n.dev.vars\n';
  try { need(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n') === expected, 'runtime_assets_ignore_drift'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.writeFileSync(file, expected, { flag: 'wx', mode: 0o600 });
  }
}
function assetVerifierEntries(ledger) {
  return ledger.assets.map(row => ({ path: row.path, size: row.size, sha256: row.sha256, contentType: row.mime }));
}
export function parseProductionAutoLedger(snapshot, app, workerName, accountId) {
  const state = snapshot?.[app];
  const activeId = activeVersion(state);
  need(activeId === state.version?.id && state.modern?.id === activeId, 'runtime_active_ledger_version_mismatch');
  const module = state.modern.modules?.find(row => row.name === '__ops_release_ledger.json');
  need(module && typeof module.content_base64 === 'string' && module.content_base64.length <= 12 * 1024 * 1024, 'runtime_active_ledger_missing');
  const bytes = Buffer.from(module.content_base64, 'base64'); need(bytes.length <= 8 * 1024 * 1024 && bytes.toString('base64') === module.content_base64);
  let ledger; try { ledger = JSON.parse(bytes.toString('utf8')); } catch { need(false, 'runtime_active_ledger_invalid'); }
  need(Buffer.from(ledgerBytes(ledger)).equals(bytes), 'runtime_active_ledger_noncanonical');
  return validateAssetLedger(ledger, { workerName, accountId });
}

export function createProductionAutoReleaseAdapter({ workerName, sourceCommit, env = process.env, triggerRun = readProductionAutoTriggerRun(env), fetchImpl = fetch,
  profile = PROFILE, providerFactory = options => new ProductionCloudflareProvider(options), ciFactory = options => new ProductionMainCI(options),
  journalFactory = options => new ProductionAutoJournal(options), recipientLoader = loadPinnedProductionAutoRecipient,
  preservationReader = readPost0226StaffPreservationObservation, sourceReader = deploymentSourceCommit, buildRunner = runBuild,
  buildArtifactsReader, migrationReader = readProductionMigrationDiagnostics,
  schemaPreservationSessionFactory,
  schemaPreservationAdmissionCheck = isProductionInstalledSchemaPreservationAdmission,
  assetBootstrapReader = readPinnedAssetInventoryBootstrap, predecessorReader = readVerifiedProductionAutoPredecessor } = {}) {
  need(Object.values(WORKERS).some(row => row.name === workerName) && /^[a-f0-9]{40}$/u.test(sourceCommit ?? '')
    && typeof fetchImpl === 'function' && profile === PROFILE, 'runtime_target_or_profile_refused');
  const app = workerName === 'ledgetop-ops' ? 'operations' : 'client', target = WORKERS[app];
  const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  need(env.CLOUDFLARE_ACCOUNT_ID === accountId && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.CLOUDFLARE_API_TOKEN ?? '')
    && /^[A-Za-z0-9_-]{20,1024}$/u.test(env.GITHUB_TOKEN ?? '')
    && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'runtime_credentials_or_run_identity_missing');
  const mainCI = ciFactory({ token: env.GITHUB_TOKEN, fetchImpl });
  need(triggerRun.sourceCommit === sourceCommit, 'runtime_trigger_source_mismatch');
  const predecessorHandoff = workerName === 'ledgetop-ops'
    ? parseProductionAutoPredecessorHandoff(env, { workerName, sourceCommit, triggerRun }) : null;
  need(typeof predecessorReader === 'function', 'runtime_predecessor_reader_invalid');
  const token = env.CLOUDFLARE_API_TOKEN;
  const post0226Policy = workerName === 'ledgetop-ops' ? loadPinnedProductionAutoPost0226PreservationPolicy() : null;
  const preservationReceipts = [];
  let migrationPins, schemaPreservationSession, latestSchemaAdmission;
  const schemaSessionFactory = schemaPreservationSessionFactory ?? createInstalledSchemaPreservationSession;
  const usesV4SchemaPreservation = isProductionAutoCanonicalV4Profile(profile);
  const checkMigrations = async () => {
    if (usesV4SchemaPreservation) {
      if (!schemaPreservationSession) schemaPreservationSession = await schemaSessionFactory({
        sourceCommit, canonicalV4Profile: profile, selectedApp: app, token,
        allowAssetAssociationRotation: app === 'operations' || app === 'client',
      });
      const expectedWeights = pendingTransition ? (pendingTransition.versions.length === 2 ? pendingTransition.versions : null)
        : verifiedDeploymentVersions;
      latestSchemaAdmission = await schemaPreservationSession.observe({
        allowLatest: candidateVersionId ? { [app]: candidateVersionId } : {},
        expectedDeploymentVersions: expectedWeights ? { [app]: expectedWeights } : {},
      });
      need(typeof schemaPreservationAdmissionCheck === 'function' && schemaPreservationAdmissionCheck(latestSchemaAdmission),
        'runtime_schema_preservation_admission_refused');
      return latestSchemaAdmission;
    }
    const observed = validateProductionMigrationAdmission(await migrationReader({ sourceCommit, root: ROOT, env, token, fetchImpl,
      appendOnlyProfile: loadPinnedAppendOnlyMigrationProfile() }), { sourceCommit });
    const { observedAt: _observedAt, ...pins } = observed;
    need(migrationPins === undefined || canonical(pins) === canonical(migrationPins), 'runtime_migration_readiness_drift');
    migrationPins = pins;
    return observed;
  };
  let provider, journal, build, baselineCapture, expectedCapture, previousLedger, assetBootstrap, candidateVersionId, verifiedCI;
  let durableRuntime = null, candidateReadbackVerified = false;
  let predecessorOwnState;
  let pendingCoordinatorFence = null, pendingTransition = null, verifiedDeploymentVersions = null;
  const currentCapture = async () => {
    const expectedWeights = pendingTransition ? (pendingTransition.versions.length === 2 ? pendingTransition.versions : null)
      : verifiedDeploymentVersions;
    const expectedDeploymentVersions = expectedWeights ? { [app]: expectedWeights } : {};
    const raw = await capture(provider, { selectedApp: app, expectedDeploymentVersions });
    const checked = validatedCapture(raw, workerName, baselineCapture?.[app]?.modern.assets?.config,
      baselineCapture?.[app]?.modern.assets,
      candidateVersionId, expectedWeights);
    const activeVersionId = activeVersion(checked[app]);
    const latestVersionId = checked[app].latest;
    const deployment = checked[app].deployment;
    need(UUID.test(deployment.id ?? '') && isProviderUtcTimestamp(deployment.created_on),
    'runtime_deployment_timestamp_missing');
    return { raw: checked, value: { activeVersionId, latestVersionId, controlsSHA256: hash(Buffer.from(canonical(controlsProjection(checked, app)))),
      deploymentId: deployment.id, deployedAt: deployment.created_on,
      versions: deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage })) } };
  };
  const assertSchemaPreservationFresh = () => {
    if (usesV4SchemaPreservation) need(schemaPreservationAdmissionCheck(latestSchemaAdmission),
      'runtime_schema_preservation_admission_stale');
  };
  const beforeDispatch = () => {
    if (post0226Policy) assertProductionAutoPost0226PreservationReceiptFresh(post0226Policy,
      preservationReceipts.at(-1), { sourceCommit });
    assertSchemaPreservationFresh();
  };
  const verifyPredecessor = async snapshot => {
    if (!predecessorHandoff) return;
    const proof = validateProductionAutoPredecessorProof(await predecessorReader({ token: env.GITHUB_TOKEN,
      ...predecessorHandoff, fetchImpl }), predecessorHandoff);
    need(proof.runtime.profileSha256 === productionAutoBuildProfileSHA256(), 'runtime_predecessor_profile_drift');
    const ledger = parseProductionAutoLedger(snapshot, app === 'operations' ? 'client' : 'operations',
      predecessorHandoff.workerName, accountId);
    need(ledger.sourceCommit === sourceCommit && proof.finalReceipt.parentVersionId === ledger.parentVersionId
      && proof.finalReceipt.ledgerSHA256 === hash(Buffer.from(ledgerBytes(ledger))),
      'runtime_predecessor_ledger_drift');
    if (predecessorOwnState === undefined) predecessorOwnState = structuredClone(snapshot[app]);
    // This release may advance its own version. Keep that state pinned to the
    // pre-mutation capture while hashing the predecessor's cross-worker controls.
    const controlsSnapshot = { ...snapshot, [app]: predecessorOwnState };
    validateLiveProductionAutoPredecessor({ proof, snapshot, app: app === 'operations' ? 'client' : 'operations',
      controlsSHA256: productionAutoControlsSHA256(controlsSnapshot, app === 'operations' ? 'client' : 'operations'),
      expectedControlsSHA256: proof.startedReceipt.controlsSHA256 });
  };
  const assertFence = async () => {
    await checkMigrations();
    verifiedCI = await mainCI.verify(sourceCommit);
    need(sourceReader(ROOT, env) === sourceCommit && verifiedCI.passed === true,
      'runtime_source_or_main_drift');
    need(verifiedCI.runId === triggerRun.runId && verifiedCI.runAttempt === triggerRun.runAttempt, 'runtime_trigger_ci_run_superseded');
    const observed = await currentCapture();
    await verifyPredecessor(observed.raw);
    if (expectedCapture) need(JSON.stringify(observed.value) === JSON.stringify(expectedCapture), 'runtime_capture_fence_drift');
    return observed;
  };
  const createJournalBeforeOldAssetRead = async baseline => {
    await checkMigrations();
    need(!journal, 'runtime_preparation_journal_already_claimed');
    need(build, 'runtime_preparation_build_missing');
    need(previousLedger, 'runtime_preparation_ledger_missing');
    need(durableRuntime === null, 'runtime_preparation_already_started');
    need(baseline?.activeVersionId, 'runtime_preparation_parent_missing');
    // Reading old bytes uses a short lived verifier Worker (create, enable,
    // delete). Claim the release before its first write. The exact candidate
    // ledger is not knowable until those bytes have been checked, so bind that
    // one digest exactly once when the coordinator records `prepared`.
    durableRuntime = { profileSha256: productionAutoBuildProfileSHA256(), moduleSha256: build.moduleSHA256, ledgerSha256: null };
    const releaseId = hash(`${workerName}\n${sourceCommit}`);
    const root = path.join(ROOT, '.backups', 'production-auto-release', workerName, sourceCommit);
    need(verifiedCI && verifiedCI.sourceCommit === sourceCommit && Number.isSafeInteger(verifiedCI.runId)
      && Number.isSafeInteger(verifiedCI.runAttempt), 'runtime_verified_ci_identity_missing');
    journal = journalFactory({ token: env.GITHUB_TOKEN, workerName, sourceCommit, ciRunId: verifiedCI.runId,
      ciRunAttempt: verifiedCI.runAttempt, workflowRunId: Number(env.GITHUB_RUN_ID), workflowRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      runtime: durableRuntime, recipient: recipientLoader(),
      responseDirectory: root, fetchImpl });
    await journal.receipt({ schemaVersion: 1, sourceCommit, workerName, status: 'started', phase: 'prepare',
      parentVersionId: baseline.activeVersionId, controlsSHA256: expectedCapture.controlsSHA256, writesAttempted: false });
    return releaseId;
  };
  const persistIntent = async intent => {
    need(journal && durableRuntime && intent && (intent.sourceCommit === undefined || intent.sourceCommit === sourceCommit)
      && (intent.workerName === undefined || intent.workerName === workerName),
      'runtime_mutation_fence_missing');
    const sourceFence = pendingCoordinatorFence?.phase === intent.phase ? pendingCoordinatorFence : {
      sourceCommit, workerName, phase: intent.phase, hashes: [], parentVersionId: baselineCapture?.[app]?.version?.id,
      ...(candidateVersionId ? { candidateVersionId } : {}),
    };
    need(UUID.test(sourceFence.parentVersionId ?? ''), 'runtime_mutation_parent_missing');
    const fenceCapture = await assertFence();
    const fence = { sourceCommit, workerName, phase: sourceFence.phase, hashes: sourceFence.hashes,
      parentVersionId: sourceFence.parentVersionId, ...(sourceFence.candidateVersionId
        ? { candidateVersionId: sourceFence.candidateVersionId } : {}) };
    need(JSON.stringify(fenceCapture.value) === JSON.stringify(expectedCapture), 'runtime_mutation_expected_state_drift');
    await journal.recordIntent({ ...intent, sourceCommit, coordinatorFence: fence });
    // Arm a narrowly-derived expected deployment transition only after the
    // mutation intent is durable, but before the provider dispatches its POST.
    // Arming earlier would make the pre-dispatch fence expect a write that has
    // not happened yet; arming later would leave the readback uncorrelated.
    if (intent.phase === 'stage-zero-percent' || intent.phase === 'activate-candidate')
      pendingTransition = validateDeploymentTransitionIntent({ intent, candidateVersionId,
        parentVersionId: baselineCapture?.[app]?.version?.id, baselineVersionId: baselineCapture?.[app]?.version?.id,
        coordinatorFence: fence, candidateReadbackVerified });
  };
  const ensureProvider = () => {
    if (provider) return;
    provider = providerFactory({ accountId, token, fetchImpl,
      recordIntent: persistIntent,
      persistResponse: value => { need(journal, 'runtime_journal_not_claimed'); return journal.persistResponse(value); },
      beforeDispatch, profile });
  };
  const adapter = {
    sourceFence: async () => {
      if (predecessorHandoff) {
        await checkMigrations();
        ensureProvider();
        const observed = await currentCapture(); await verifyPredecessor(observed.raw);
      }
      return { sourceCommit: sourceReader(ROOT, env), mainCommit: await mainCI.mainCommit(), clean: true };
    },
    ciGate: async () => {
      await checkMigrations();
      verifiedCI = await mainCI.verify(sourceCommit);
      need(verifiedCI.runId === triggerRun.runId && verifiedCI.runAttempt === triggerRun.runAttempt, 'runtime_trigger_ci_run_superseded');
      if (predecessorHandoff) {
        ensureProvider(); const observed = await currentCapture(); await verifyPredecessor(observed.raw);
      }
      return verifiedCI;
    },
    capture: async () => {
      ensureProvider(); const observed = await currentCapture();
      if (!baselineCapture) { baselineCapture = observed.raw; expectedCapture = observed.value; }
      else if (pendingTransition) {
        const transition = pendingTransition; pendingTransition = null;
        need(observed.value.controlsSHA256 === expectedCapture.controlsSHA256
          && observed.value.activeVersionId === transition.activeVersionId && observed.value.latestVersionId === transition.latestVersionId
          && JSON.stringify(observed.value.versions) === JSON.stringify(transition.versions), 'runtime_transition_readback_refused');
        expectedCapture = observed.value;
        verifiedDeploymentVersions = transition.versions.length === 1 ? null : transition.versions;
      } else need(JSON.stringify(observed.value) === JSON.stringify(expectedCapture), 'runtime_unexpected_capture_change');
      return observed.value;
    },
    build: async () => {
      verifiedCI = await mainCI.verify(sourceCommit);
      need(sourceReader(ROOT, env) === sourceCommit && verifiedCI.passed === true
        && verifiedCI.runId === triggerRun.runId && verifiedCI.runAttempt === triggerRun.runAttempt, 'runtime_build_source_fence_refused');
      buildRunner(app);
      let moduleBytes, sourceMapBytes, sourceMap, assets;
      if (buildArtifactsReader) {
        const artifact = buildArtifactsReader({ app, sourceCommit });
        need(artifact && Buffer.isBuffer(artifact.moduleBytes) && Buffer.isBuffer(artifact.sourceMapBytes)
          && artifact.assets && Array.isArray(artifact.assets.entries) && artifact.assets.payloads instanceof Map,
        'runtime_build_artifact_fixture_invalid');
        moduleBytes = Buffer.from(artifact.moduleBytes); sourceMapBytes = Buffer.from(artifact.sourceMapBytes);
        sourceMap = artifact.sourceMap; assets = { entries: structuredClone(artifact.assets.entries), payloads: new Map(artifact.assets.payloads) };
      } else {
        const modulePath = buildModulePath(app, ROOT); moduleBytes = fs.readFileSync(modulePath); sourceMapBytes = fs.readFileSync(`${modulePath}.map`);
        try { sourceMap = JSON.parse(sourceMapBytes.toString('utf8')); } catch { need(false, 'runtime_build_map_invalid'); }
        const assetDir = path.join(ROOT, 'apps', app, 'dist', 'client'); ensureAssetsIgnore(assetDir);
        assets = collectFrontendAssets(assetDir);
      }
      need(sourceMap?.version === 3 && Array.isArray(sourceMap.sources) && Array.isArray(sourceMap.sourcesContent)
        && sourceMap.sources.length === sourceMap.sourcesContent.length && typeof sourceMap.mappings === 'string', 'runtime_build_map_invalid');
      build = { sourceCommit, moduleSHA256: hash(moduleBytes), moduleBytes, sourceMapBytes, sourceMap, assets };
      return { sourceCommit, moduleSHA256: build.moduleSHA256, assets };
    },
    readLedger: async () => {
      ensureProvider();
      const snapshot = (await currentCapture()).raw;
      previousLedger = parseProductionAutoLedger(snapshot, app, workerName, accountId);
      assetBootstrap = assetBootstrapReader({ app, workerName, accountId,
        activeVersionId: activeVersion(snapshot[app]) });
      if (assetBootstrap) {
        const prepared = prepareAssetInventoryBootstrap({ bootstrap: assetBootstrap, previous: previousLedger,
          activeVersionId: activeVersion(snapshot[app]), workerName, accountId });
        const total = prepared.rows.reduce((sum, row) => sum + row.size, 0);
        need(prepared.rows.length <= ASSET_VERIFICATION_LIMITS.files
          && prepared.rows.every(row => row.size <= ASSET_VERIFICATION_LIMITS.fileBytes)
          && total <= ASSET_VERIFICATION_LIMITS.totalBytes, 'runtime_bootstrap_inventory_exceeds_verifier_bounds');
      }
      return previousLedger;
    },
    readOldAssets: async ({ ledger }) => {
      need(previousLedger && JSON.stringify(previousLedger) === JSON.stringify(ledger), 'runtime_old_ledger_changed');
      await createJournalBeforeOldAssetRead(expectedCapture);
      await assertFence();
      const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
      const verificationLedger = assetBootstrap
        ? prepareAssetInventoryBootstrap({ bootstrap: assetBootstrap, previous: ledger,
          activeVersionId: baselineCapture[app].version.id, workerName, accountId }) : null;
      const verificationEntries = verificationLedger
        ? assetBootstrapVerificationEntries(ledger, verificationLedger)
        : assetVerifierEntries(ledger);
      const result = await executeAssetVerification({ entries: verificationEntries, timeoutMs: 300_000,
        create: () => provider.createVerifier({ name, workerName, origin: target.origin, entries: verificationEntries,
          nonceHash: nonce.nonceHash, versionId: baselineCapture[app].version.id }),
        fetchAsset: ({ path: assetPath }, { method, signal }) => provider.fetchVerifierAsset({ name, path: assetPath, method, bearer: nonce.bearer, signal }),
        remove: () => provider.removeVerifier(name), readAbsent: () => provider.verifierAbsent(name) });
      await assertFence();
      if (assetBootstrap) previousLedger = completeAssetInventoryBootstrap({ bootstrap: assetBootstrap,
        previous: ledger, verifiedAssets: result.assets, activeVersionId: baselineCapture[app].version.id, workerName, accountId });
      return result.assets;
    },
    completeInventory: async ({ previous, verifiedAssets, baseline }) => {
      if (!assetBootstrap) return previous;
      return completeAssetInventoryBootstrap({ bootstrap: assetBootstrap, previous, verifiedAssets,
        activeVersionId: baseline.activeVersionId, workerName, accountId });
    },
    upload: async ({ baseline, ledger, manifest, payloads, recordIntent }) => {
      ensureProvider(); const tokenResponse = await provider.uploadAssets({ workerName, manifest,
        resolvePayload: async providerHash => {
          const row = ledger.assets.find(entry => entry.providerHash === providerHash), bytes = row && payloads.get(row.path);
          need(row && Buffer.isBuffer(bytes) && hash(bytes) === row.sha256, 'runtime_asset_payload_missing');
          return { bytes, sha256: row.sha256, mime: row.mime };
        }, recordIntent });
      // The coordinator requires one pre-write fence for the version-upload
      // transition. The provider records the request-bound journal intent
      // immediately afterward, directly before dispatching its POST.
      await recordIntent({ phase: 'worker-version-upload', hashes: [] });
      const candidate = await provider.createInactiveVersion({ workerName, state: baselineCapture[app], modules: {
        js: { bytes: build.moduleBytes, sha256: build.moduleSHA256 }, sourceMap: { bytes: build.sourceMapBytes, sha256: hash(build.sourceMapBytes) },
      }, ledger, assetCompletionToken: tokenResponse.completionToken,
      annotations: { 'workers/message': `Retained assets release ${sourceCommit.slice(0, 12)}`, 'workers/tag': `auto-${sourceCommit.slice(0, 12)}` } });
      candidateVersionId = candidate.id;
      return { candidateVersionId: candidate.id, moduleSHA256: build.moduleSHA256 };
    },
    candidateReadback: async ({ versionId, moduleSHA256, ledgerSHA256, ledger, baseline }) => {
      const before = baselineCapture;
      const candidate = await readCandidateVersionWithVisibilityRetry(provider, workerName, versionId);
      const modern = await provider.get(`/workers/workers/${workerName}/versions/${versionId}?include=modules`);
      const main = modern.modules?.find(row => row.name === 'index.js');
      const ledgerModule = modern.modules?.find(row => row.name === '__ops_release_ledger.json');
      need(main && hash(Buffer.from(main.content_base64, 'base64')) === moduleSHA256 && ledgerModule
        && hash(Buffer.from(ledgerModule.content_base64, 'base64')) === ledgerSHA256
        && Buffer.from(ledgerModule.content_base64, 'base64').equals(ledgerBytes(ledger)), 'runtime_candidate_module_readback_refused');
      const mapModule = modern.modules?.find(row => row.name === 'index.js.map');
      need(mapModule && hash(Buffer.from(mapModule.content_base64, 'base64')) === hash(build.sourceMapBytes), 'runtime_candidate_map_readback_refused');
      need(JSON.stringify(candidate.resources) === JSON.stringify(before[app].version.resources)
        && JSON.stringify(modern.assets?.config) === JSON.stringify(before[app].modern.assets?.config), 'runtime_candidate_configuration_drift');
      const observed = await currentCapture();
      need(observed.value.controlsSHA256 === baseline.controlsSHA256 && observed.value.activeVersionId === baseline.activeVersionId
        && observed.value.latestVersionId === versionId, 'runtime_candidate_state_refused');
      // Candidate creation intentionally changes only the latest-version head;
      // bind the subsequent coordinator fence to this verified parent100 /
      // candidate-latest state before zero-percent staging.
      expectedCapture = observed.value;
      candidateReadbackVerified = true;
      return { verified: true, candidateVersionId: versionId, moduleSHA256, ledgerSHA256, controlsSHA256: observed.value.controlsSHA256 };
    },
    stageZero: async ({ versions, candidateVersionId, parentVersionId }) => {
      const result = await provider.stageVersion({ workerName, parentVersionId, candidateVersionId,
        message: `Retained assets release ${sourceCommit.slice(0, 12)} at 0 percent` });
      return result;
    },
    activate: async ({ candidateVersionId }) => {
      return provider.activateCandidate({ workerName, parentVersionId: baselineCapture[app].version.id, candidateVersionId,
        message: `Retained assets release ${sourceCommit.slice(0, 12)} active` });
    },
    readDeployment: async () => {
      const observed = await currentCapture();
      if (pendingTransition) {
        const transition = pendingTransition; pendingTransition = null;
        need(observed.value.controlsSHA256 === expectedCapture.controlsSHA256
          && observed.value.activeVersionId === transition.activeVersionId && observed.value.latestVersionId === transition.latestVersionId
          && JSON.stringify(observed.value.versions) === JSON.stringify(transition.versions), 'runtime_deployment_readback_refused');
        expectedCapture = observed.value;
        verifiedDeploymentVersions = transition.versions.length === 1 ? null : transition.versions;
      } else need(expectedCapture && JSON.stringify(observed.value) === JSON.stringify(expectedCapture), 'runtime_deployment_unexpected_drift');
      return observed.value;
    },
    verifyAssets: async ({ versionId, ledger, ledgerSHA256, stage, routingDeploymentId }) => {
      need(previousLedger && ledger && SHA.test(ledgerSHA256) && ['zero-percent','active'].includes(stage)
        && expectedCapture?.deploymentId === routingDeploymentId && expectedCapture.latestVersionId === versionId,
      'runtime_asset_proof_phase_refused');
      const previous = new Map(previousLedger.assets.map(row => [row.path, row.sha256]));
      const distinct = ledger.assets.some(row => previous.get(row.path) !== row.sha256);
      need(distinct, 'runtime_candidate_asset_route_not_distinguishable');
      const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName(), entries = assetVerifierEntries(ledger);
      const before = await assertFence();
      const result = await executeAssetVerification({ entries, timeoutMs: 300_000,
        create: () => provider.createVerifier({ name, workerName, origin: target.origin, entries, nonceHash: nonce.nonceHash, versionId }),
        fetchAsset: ({ path: assetPath }, { method, signal }) => provider.fetchVerifierAsset({ name, path: assetPath, method, bearer: nonce.bearer, signal }),
        remove: () => provider.removeVerifier(name), readAbsent: () => provider.verifierAbsent(name) });
      const after = await assertFence();
      need(JSON.stringify(before.value) === JSON.stringify(after.value) && result.assets.size === ledger.assets.length,
        'runtime_asset_proof_capture_drift');
      for (const row of ledger.assets) { const bytes = result.assets.get(row.path); need(bytes && bytes.length === row.size && hash(bytes) === row.sha256, 'runtime_asset_byte_proof_refused'); }
      return { verified: true, versionRoutingVerified: true, routingDeploymentId, versionId, ledgerSHA256,
        files: ledger.assets.length, bytes: ledger.assets.reduce((sum, row) => sum + row.size, 0) };
    },
    recordIntent: async value => {
      const observed = await assertFence();
      need(expectedCapture && JSON.stringify(observed.value) === JSON.stringify(expectedCapture), 'runtime_coordinator_fence_refused');
      pendingCoordinatorFence = structuredClone(value);
    },
    receipt: async value => {
      if (journal) {
        if (value.status === 'prepared' && durableRuntime?.ledgerSha256 === null) {
          need(SHA.test(value.ledgerSHA256 ?? ''), 'runtime_prepared_ledger_missing');
          durableRuntime = { ...durableRuntime, ledgerSha256: value.ledgerSHA256 };
        }
        return journal.receipt(value);
      }
    },
    ...(workerName === 'ledgetop-ops' ? { post0226Preservation: async ({ sourceCommit: expectedSource }) => {
      need(expectedSource === sourceCommit, 'runtime_post0226_source_mismatch');
      const observation = await preservationReader({ sourceCommit, env });
      const receipt = validateProductionAutoPost0226PreservationObservation(post0226Policy, observation, { sourceCommit });
      preservationReceipts.push(receipt);
      if (preservationReceipts.length > 1) validateRepeatedProductionAutoPost0226PreservationReceipts(post0226Policy,
        preservationReceipts, { sourceCommit });
      return receipt;
    } } : {}),
  };
  return Object.freeze({ adapter, getJournal: () => journal, getReleaseId: () => hash(`${workerName}\n${sourceCommit}`),
    close: () => schemaPreservationSession?.close() });
}

export async function runProductionAutoRelease({ workerName = process.env.PRODUCTION_AUTO_WORKER, env = process.env,
  fetchImpl = fetch, recipientLoader = loadPinnedProductionAutoRecipient, triggerReader = readProductionAutoTriggerRun,
  sourceReader = deploymentSourceCommit, runtimeFactory = createProductionAutoReleaseAdapter } = {}) {
  // The reviewed source pin supplies encryption only. Independent policy,
  // identity, CI, migration, authority, and profile checks still gate release.
  const recipient = recipientLoader();
  need(env.PRODUCTION_AUTO_RELEASE_ENABLED === 'true', 'production_auto_release_disabled');
  const triggerRun = triggerReader(env), sourceCommit = sourceReader(ROOT, env);
  need(triggerRun.sourceCommit === sourceCommit, 'runtime_trigger_source_mismatch');
  const runtime = runtimeFactory({ workerName, sourceCommit, triggerRun, env, fetchImpl, recipientLoader: () => recipient });
  try {
    return await coordinateProductionAutoRelease({ accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
      workerName, sourceCommit, adapter: runtime.adapter });
  } finally { runtime.close?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runProductionAutoRelease(); console.log(JSON.stringify({ status: 'verified', ...result })); }
  catch (error) {
    const reason = ['migration_required_pending', 'migration_application_schema_confirmation_required'].includes(error?.code)
      ? ` (${error.code})` : '';
    console.error(`Production retained-asset release held${reason}; inspect the durable journal and reconcile read-only.`);
    process.exitCode = 1;
  }
}
