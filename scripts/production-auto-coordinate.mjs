/** Injected release state machine only: no cloud implementation, authentication,
 * default adapters, scheduling, automatic rollback, or live qualification.
 * Every adapter is a trusted boundary with the explicit normalized contracts
 * below; booleans returned by a fake adapter are not evidence of production.
 * Durable recordIntent must reject replay and survive the build process.
 */
import { createHash } from 'node:crypto';
import { mergeAssetLedger, providerManifest, ledgerBytes, validateAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const need = (condition, message) => { if (!condition) throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const weights = values => JSON.stringify(values.map(({ versionId, percentage }) => ({ versionId, percentage }))
  .sort((a, b) => a.versionId.localeCompare(b.versionId)));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const copy = value => structuredClone(value);
const STAFF_KEYS = ['schemaVersion', 'sourceCommit', 'accountId', 'databaseId', 'reviewSha256',
  'cohortSha256', 'controlPlaneSha256', 'observedAt', 'staffCount', 'generation'];
function staffReceipt(value, sourceCommit, accountId) {
  need(value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === STAFF_KEYS.length && STAFF_KEYS.every(key => Object.hasOwn(value, key)
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined)
    && value.schemaVersion === 2 && value.sourceCommit === sourceCommit
    && accountId === NATIVE_STAFF_PRODUCTION_TARGET.accountId && value.accountId === accountId
    && value.databaseId === NATIVE_STAFF_PRODUCTION_TARGET.databaseId
    && [value.reviewSha256, value.cohortSha256, value.controlPlaneSha256].every(v => typeof v === 'string' && SHA.test(v))
    && Number.isSafeInteger(value.staffCount) && value.staffCount > 0 && value.staffCount <= 1024
    && Number.isSafeInteger(value.generation) && value.generation >= 0 && iso(value.observedAt)
    && Date.parse(value.observedAt) <= Date.now() && Date.now() - Date.parse(value.observedAt) <= 60_000,
  'Fresh exact native-staff readiness receipt is required');
  return Object.fromEntries(STAFF_KEYS.filter(key => key !== 'observedAt').map(key => [key, value[key]]));
}
// Reject before reading old payloads/uploading. Both preparatory inventories and
// the final exact union must fit the smallest existing byte verifier.
function verifierBounds(...inventories) {
  const union = new Map();
  for (const rows of inventories) {
    need(Array.isArray(rows), 'Verifier asset inventory is unavailable');
    for (const row of rows) {
      need(row && typeof row.path === 'string' && Number.isSafeInteger(row.size) && row.size >= 0
        && row.size <= 16 * 1024 * 1024, 'Asset exceeds the qualified verifier file bound');
      union.set(row.path, row.size);
    }
  }
  need(union.size > 0 && union.size <= 1024
    && [...union.values()].reduce((sum, size) => sum + size, 0) <= 128 * 1024 * 1024,
  'Asset union exceeds the qualified verifier bound');
}

/** capture/readDeployment normalized result:
 * {activeVersionId,latestVersionId,controlsSHA256,deploymentId,deployedAt,
 * versions:[{versionId,percentage}]}.
 * controlsSHA256 MUST cover all protected settings/scalars/bindings/resources/
 * schedules for all relevant Workers, excluding only reviewed versioned
 * code/assets/deployment identities. It cannot be the ordinary config hash.
 * readDeployment reads actual provider state; never synthesizes requested weights.
 */
function state(value) {
  need(value && UUID.test(value.activeVersionId) && UUID.test(value.latestVersionId)
    && SHA.test(value.controlsSHA256) && UUID.test(value.deploymentId) && iso(value.deployedAt)
    && Array.isArray(value.versions) && value.versions.length > 0 && value.versions.length <= 2,
  'Release control capture is invalid');
  const ids = new Set();
  for (const row of value.versions) {
    need(row && UUID.test(row.versionId) && !ids.has(row.versionId)
      && Number.isInteger(row.percentage) && row.percentage >= 0 && row.percentage <= 100,
    'Release deployment weights are invalid');
    ids.add(row.versionId);
  }
  need(value.versions.reduce((sum, row) => sum + row.percentage, 0) === 100
    && value.versions.some(row => row.versionId === value.activeVersionId && row.percentage === 100),
  'Release deployment is not one fully active version');
  return copy(value);
}

/** build -> {sourceCommit,moduleSHA256,assets:{entries,payloads:Map}}.
 * readLedger -> validated complete ledger for the current active version.
 * readOldAssets -> Map(path,Buffer), independently rehashed by mergeAssetLedger.
 * upload -> {candidateVersionId,moduleSHA256}; MUST await supplied recordIntent
 * immediately before EVERY underlying POST, including worker-version-upload.
 * candidateReadback -> {verified:true,candidateVersionId,moduleSHA256,
 * ledgerSHA256,controlsSHA256}; verifies actual returned code, genuine map,
 * embedded ledger, asset association and all protected resources.
 * stageZero/activate perform one fixed deployment POST, with no retry/settings.
 * Ops-only staffReadiness -> genuine native-staff schema2 receipt for this exact
 * source/account/database. The adapter must validate the private reviewed packet
 * through the supported native readiness reader, never fabricate approval.
 * verifyAssets -> {verified:true,versionRoutingVerified:true,routingDeploymentId,
 * versionId,ledgerSHA256,files,bytes}; checks all
 * old+new actual bytes and exact version routing, not override-header assumption.
 * receipt persists only the supplied sanitized journal entries.
 */
export async function coordinateProductionAutoRelease({ accountId, workerName, sourceCommit, adapter }) {
  need(/^[a-f0-9]{32}$/.test(accountId) && ['ledgetop-ops', 'ledgetop-clients'].includes(workerName)
    && COMMIT.test(sourceCommit), 'Release target/source is invalid');
  const methods = ['capture', 'sourceFence', 'ciGate', 'build', 'readLedger', 'readOldAssets', 'upload',
    'candidateReadback', 'stageZero', 'verifyAssets', 'activate', 'readDeployment', 'recordIntent', 'receipt'];
  need(adapter && methods.every(name => typeof adapter[name] === 'function'), 'Release adapters are incomplete');
  need(workerName !== 'ledgetop-ops' || typeof adapter.staffReadiness === 'function',
    'Operations release requires the native-staff readiness adapter');
  let phase = 'initial', baseline, candidateVersionId, ledgerSHA256, writesAttempted = false;
  let staffPins;
  const record = async (status, details = {}) => adapter.receipt({ schemaVersion: 1, sourceCommit,
    workerName, phase, status, ...details });
  const sourceAndCi = async () => {
    const source = await adapter.sourceFence({ sourceCommit });
    need(source?.sourceCommit === sourceCommit && source.mainCommit === sourceCommit && source.clean === true,
      'Release source is dirty, superseded or unrecognized');
    const ci = await adapter.ciGate({ sourceCommit });
    need(ci?.sourceCommit === sourceCommit && ci.passed === true, 'Exact source CI gate is not satisfied');
    if (workerName === 'ledgetop-ops') {
      const pins = staffReceipt(await adapter.staffReadiness({ sourceCommit }), sourceCommit, accountId);
      need(!staffPins || JSON.stringify(pins) === JSON.stringify(staffPins), 'Native-staff readiness changed during release');
      staffPins ??= pins;
    }
  };
  const fence = async expected => {
    await sourceAndCi();
    const actual = state(await adapter.capture());
    need(actual.controlsSHA256 === baseline.controlsSHA256
      && actual.activeVersionId === expected.activeVersionId && actual.latestVersionId === expected.latestVersionId
      && actual.deploymentId === expected.deploymentId && weights(actual.versions) === weights(expected.versions),
    'Release controls or deployment changed before mutation');
    return actual;
  };
  const beforeWrite = async (expected, intentPhase, hashes = []) => {
    await fence(expected);
    // Intent failure means no callback may perform the associated mutation.
    await adapter.recordIntent(Object.freeze({ sourceCommit, workerName, phase: intentPhase,
      hashes: Object.freeze([...hashes]), parentVersionId: baseline.activeVersionId,
      ...(candidateVersionId ? { candidateVersionId } : {}) }));
    writesAttempted = true;
  };
  const deploymentProof = (value, expectedWeights, active, previousDeployment) => {
    const actual = state(value);
    need(actual.controlsSHA256 === baseline.controlsSHA256 && actual.activeVersionId === active
      && actual.latestVersionId === candidateVersionId && actual.deploymentId !== previousDeployment.deploymentId
      && Date.parse(actual.deployedAt) >= Date.parse(previousDeployment.deployedAt)
      && Date.parse(actual.deployedAt) <= Date.now()
      && weights(actual.versions) === weights(expectedWeights), 'Provider deployment acknowledgement is not proven');
    return actual;
  };
  const verify = async (ledger, stage, deployment) => {
    const value = await adapter.verifyAssets({ versionId: candidateVersionId, ledger: copy(ledger), ledgerSHA256,
      stage, routingDeploymentId: deployment.deploymentId });
    need(value?.verified === true && value.versionId === candidateVersionId && value.ledgerSHA256 === ledgerSHA256
      && value.versionRoutingVerified === true && value.routingDeploymentId === deployment.deploymentId
      && value.files === ledger.assets.length && value.bytes === ledger.assets.reduce((sum, row) => sum + row.size, 0),
    'Complete old/new asset-byte acceptance is not proven');
  };
  try {
    await sourceAndCi();
    baseline = state(await adapter.capture());
    need(baseline.latestVersionId === baseline.activeVersionId
      && weights(baseline.versions) === weights([{ versionId: baseline.activeVersionId, percentage: 100 }]),
    'An unfinished or split deployment blocks release');
    await record('started', { parentVersionId: baseline.activeVersionId, controlsSHA256: baseline.controlsSHA256 });
    phase = 'prepare';
    const built = await adapter.build({ sourceCommit, workerName });
    need(built?.sourceCommit === sourceCommit && SHA.test(built.moduleSHA256), 'Build source/module pin is invalid');
    const previous = validateAssetLedger(await adapter.readLedger({ baseline: copy(baseline) }), { workerName, accountId });
    verifierBounds(previous.assets, built.assets?.entries);
    const old = await adapter.readOldAssets({ ledger: copy(previous), baseline: copy(baseline) });
    need(old instanceof Map && built.assets?.payloads instanceof Map, 'Old/new asset payloads are unavailable');
    const payloads = new Map(old);
    for (const [name, bytes] of built.assets.payloads) payloads.set(name, bytes);
    const ledger = mergeAssetLedger({ previous, current: { entries: built.assets.entries, payloads },
      workerName, accountId, sourceCommit, parentVersionId: baseline.activeVersionId, observedAt: new Date().toISOString() });
    verifierBounds(ledger.assets);
    ledgerSHA256 = hash(ledgerBytes(ledger));
    await record('prepared', { ledgerSHA256, files: ledger.assets.length, automaticPruning: false, minimumRetentionHours: 48 });
    phase = 'upload';
    let versionIntents = 0;
    const upload = await adapter.upload({ sourceCommit, workerName, baseline: copy(baseline), build: built,
      ledger: copy(ledger), ledgerSHA256, manifest: providerManifest(ledger), payloads,
      recordIntent: async value => {
        need(value && ['asset-session', 'asset-bucket', 'worker-version-upload'].includes(value.phase)
          && Array.isArray(value.hashes) && value.hashes.every(v => /^[a-f0-9]{32}$/.test(v)), 'Upload intent is invalid');
        need(versionIntents === 0, 'No writes may follow a version upload in the upload phase');
        if (value.phase === 'worker-version-upload') versionIntents++;
        await beforeWrite(baseline, value.phase, value.hashes);
      } });
    need(versionIntents === 1 && upload && UUID.test(upload.candidateVersionId)
      && upload.candidateVersionId !== baseline.activeVersionId && upload.moduleSHA256 === built.moduleSHA256,
    'Inactive candidate upload is not acknowledged');
    candidateVersionId = upload.candidateVersionId;
    phase = 'candidate-readback';
    const readback = await adapter.candidateReadback({ versionId: candidateVersionId,
      moduleSHA256: built.moduleSHA256, ledgerSHA256, ledger: copy(ledger), baseline: copy(baseline) });
    need(readback?.verified === true && readback.candidateVersionId === candidateVersionId
      && readback.moduleSHA256 === built.moduleSHA256 && readback.ledgerSHA256 === ledgerSHA256
      && readback.controlsSHA256 === baseline.controlsSHA256, 'Inactive candidate readback is not proven');
    const inactive = { ...baseline, latestVersionId: candidateVersionId };
    await fence(inactive);
    await record('inactive-verified', { candidateVersionId, ledgerSHA256 });
    phase = 'stage-zero';
    await beforeWrite(inactive, 'stage-zero');
    const stagedWeights = [{ versionId: baseline.activeVersionId, percentage: 100 }, { versionId: candidateVersionId, percentage: 0 }];
    await adapter.stageZero({ versions: copy(stagedWeights), candidateVersionId, parentVersionId: baseline.activeVersionId });
    const staged = deploymentProof(await adapter.readDeployment(), stagedWeights, baseline.activeVersionId, baseline);
    await record('zero-percent-verified', { candidateVersionId, deploymentId: staged.deploymentId });
    phase = 'candidate-assets';
    await verify(ledger, 'zero-percent', staged);
    await record('candidate-assets-verified', { candidateVersionId, ledgerSHA256 });
    phase = 'activate';
    await beforeWrite(staged, 'activate');
    const activeWeights = [{ versionId: candidateVersionId, percentage: 100 }];
    await adapter.activate({ versions: copy(activeWeights), candidateVersionId });
    const active = deploymentProof(await adapter.readDeployment(), activeWeights, candidateVersionId, staged);
    phase = 'active-assets';
    await verify(ledger, 'active', active);
    // Final source/CI/control capture catches drift during byte acceptance.
    await fence(active);
    const receipt = { candidateVersionId, parentVersionId: baseline.activeVersionId, ledgerSHA256,
      deploymentId: active.deploymentId, cutoverObservedAt: active.deployedAt,
      earliestPermittedPruningAt: new Date(Date.parse(active.deployedAt) + 48 * 60 * 60 * 1000).toISOString(),
      minimumRetentionHours: 48, automaticPruning: false, allHistoricalAssetsCarried: true,
      files: ledger.assets.length, verifiedActive: true };
    phase = 'complete'; await record('verified', receipt); return receipt;
  } catch {
    // A write, verification or durable-receipt exception is not permission for
    // another mutation or rollback. Preserve only bounded normalized evidence.
    let reconciliation = { readSucceeded: false };
    if (writesAttempted) {
      try {
        const observed = state(await adapter.readDeployment());
        reconciliation = { readSucceeded: true, activeVersionId: observed.activeVersionId,
          latestVersionId: observed.latestVersionId, deploymentId: observed.deploymentId,
          controlsUnchanged: observed.controlsSHA256 === baseline?.controlsSHA256 };
      } catch { /* retain original unknown outcome; no retry */ }
    }
    try { await record('held', { writesAttempted, ...(candidateVersionId ? { candidateVersionId } : {}), reconciliation }); }
    catch { /* original durable mutation intent must remain unresolved */ }
    throw new Error('Automatic release held; preserve journal and reconcile read-only; no retry or rollback performed');
  }
}
