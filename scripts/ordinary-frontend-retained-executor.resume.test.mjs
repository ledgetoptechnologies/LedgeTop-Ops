import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertResumeControls, qualifyPriorCandidateResumeJournal, verifyExactOpsSuccessorNamedHandlerAddition } from './ordinary-frontend-retained-executor.mjs';
import { OPS_SUCCESSOR_READER_INSTALLED_CONTRACT, ORDINARY_FRONTEND_PREFLIGHT_MODE, validateInstallation } from './production-deploy.mjs';

const pins = { sourceCommit: 'a0c8fd230d46690a7090c79190e125f5a02f0f35',
  mainSHA256: 'f4cdefd633441df8db18cc5c0b192fc8faa72ebd7b1db730122bd77318164e68',
  sourceMapSHA256: '375962dbe22ed0038009d0790c1c12a33b0668010f99916b8addade0a489d08b' };
const baseline = () => ({ operations: { version: { resources: {
  script: { handlers: ['fetch'], named_handlers: [
    { name: 'OperationsPortalNativeDeliveryAuthorizationReader', handlers: ['readNativeDeliveryAuthorization'] },
    { name: 'UnrelatedEntrypoint', handlers: ['fetch'] },
  ] }, script_runtime: { compatibility_date: '2026-10-30', usage_model: 'standard' }, bindings: [
    { name: 'OPS_DB', type: 'd1', id: 'synthetic-db' },
  ],
} } } });
const expectedMethods = ['readWindowsCatalogSuccessorAuthorization', 'readWindowsDeliverySuccessorAuthorization'];
function candidateFrom(before) {
  const resources = structuredClone(before.operations.version.resources);
  resources.script.named_handlers[0].handlers.push(...expectedMethods);
  return { id: 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68', resources };
}

test('only the pinned Ops source may add exactly the two reviewed successor reader RPC methods', () => {
  const before = baseline();
  const proof = verifyExactOpsSuccessorNamedHandlerAddition(before, candidateFrom(before), pins);
  assert.deepEqual(proof.addedMethods, [...expectedMethods].sort());
  assert.equal(proof.allOtherResourcesUnchanged, true);
});

test('rejects arbitrary RPC methods, methods on another class, and changed exports/entrypoints', () => {
  const before = baseline();
  const extraMethod = candidateFrom(before); extraMethod.resources.script.named_handlers[0].handlers.push('readAnything');
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, extraMethod, pins), /named-handler delta/u);

  const wrongClass = candidateFrom(before); wrongClass.resources.script.named_handlers[1].handlers.push(...expectedMethods);
  wrongClass.resources.script.named_handlers[0].handlers = ['readNativeDeliveryAuthorization'];
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, wrongClass, pins), /named-handler delta/u);

  const otherEntrypoint = candidateFrom(before); otherEntrypoint.resources.script.handlers.push('scheduled');
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, otherEntrypoint, pins), /exports or named-handler classes/u);
});

test('rejects resource, binding, runtime, class, and source pin drift', () => {
  const before = baseline();
  const changedBinding = candidateFrom(before); changedBinding.resources.bindings.push({ name: 'EXTRA', type: 'plain_text', text: 'true' });
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, changedBinding, pins), /resources beyond/u);

  const changedRuntime = candidateFrom(before); changedRuntime.resources.script_runtime.compatibility_date = '2026-10-31';
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, changedRuntime, pins), /resources beyond/u);

  const changedClass = candidateFrom(before); changedClass.resources.script.named_handlers.push({ name: 'Extra', handlers: ['fetch'] });
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, changedClass, pins), /exports or named-handler classes/u);

  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, candidateFrom(before), { ...pins, sourceCommit: 'b'.repeat(40) }), /source, main bundle and source map/u);
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, candidateFrom(before), { ...pins, mainSHA256: 'c'.repeat(64) }), /source, main bundle and source map/u);
  assert.throws(() => verifyExactOpsSuccessorNamedHandlerAddition(before, candidateFrom(before), { ...pins, sourceMapSHA256: 'd'.repeat(64) }), /source, main bundle and source map/u);
});

function priorJournal(t, { extraStage = false, duplicateCandidate = false, consumedPidName = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-retained-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
  const baselineVersionId = 'a45943f4-e5c5-4142-9057-fb9adb5cf739';
  const ordinaryPlan = { sourceCommit: pins.sourceCommit,
    release: { main: { sha256: pins.mainSHA256 }, sourceMap: { sha256: pins.sourceMapSHA256 } },
    browserProof: { inventorySHA256: '7'.repeat(64) } };
  const pinnedPlan = { contract: 'ordinary-frontend-retained-native-module-v2', sourceCommit: pins.sourceCommit,
    ordinaryPlan, ordinaryPlanSHA256: '8'.repeat(64), retentionLedgerSHA256: '9'.repeat(64),
    retentionLedger: { assets: Array.from({ length: 512 }, () => ({})) },
    assetProviderIdentifierProvenance: { schema: 'sha256-prefix32-v1' } };
  const uploadIntent = { sequence: 1, at: '2026-10-31T00:00:00.000Z', phase: 'native-version-upload',
    sourceCommit: pins.sourceCommit, workerName: 'ledgetop-ops', parentVersionId: baselineVersionId,
    mainSHA256: pins.mainSHA256, mapSHA256: pins.sourceMapSHA256, ledgerSHA256: pinnedPlan.retentionLedgerSHA256,
    assetInventorySHA256: ordinaryPlan.browserProof.inventorySHA256, automaticRetry: false };
  const verifierName = 'ops-ui-verify-1234567890abcdef12345678', verifierPath = `/workers/scripts/${verifierName}`;
  const rows = [
    { sequence: 1, at: '2026-10-31T00:00:00.000Z', phase: 'temporary-asset-verifier-create', workerName: 'ledgetop-ops',
      verifiedVersionId: baselineVersionId, verifierName, assetCount: 471, receiptName: 'verified-prior-active-assets', automaticRetry: false },
    { sequence: 2, at: '2026-10-31T00:00:01.000Z', phase: 'temporary-verifier-create', requestId: '1', method: 'PUT',
      path: verifierPath, name: verifierName, workerName: 'ledgetop-ops',
      sourceSHA256: 'f9ff69620e2e001e53a852387323e6308f1a3063fc1c1cb2a1f7c28d938ad861', sourceCommit: pins.sourceCommit, automaticRetry: false },
    { sequence: 3, at: '2026-10-31T00:00:02.000Z', phase: 'temporary-verifier-enable', requestId: '2', method: 'POST',
      path: `${verifierPath}/subdomain`, name: verifierName, sourceCommit: pins.sourceCommit, automaticRetry: false },
    { sequence: 4, at: '2026-10-31T00:00:03.000Z', phase: 'temporary-verifier-delete', requestId: '3', method: 'DELETE',
      path: verifierPath, name: verifierName, sourceCommit: pins.sourceCommit, automaticRetry: false },
    { ...uploadIntent, sequence: 5 },
  ];
  if (extraStage) rows.push({ sequence: 6, phase: 'native-candidate-namespace-stage', automaticRetry: false });
  const cliPath = process.execPath;
  fs.writeFileSync(path.join(directory, 'journal.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(path.join(directory, 'candidate.private.json'), JSON.stringify({ candidateId, parentVersionId: baselineVersionId }));
  fs.writeFileSync(path.join(directory, 'release-plan.private.json'), JSON.stringify({ schemaVersion: 2,
    contract: pinnedPlan.contract, application: 'operations', sourceCommit: pins.sourceCommit, baselineVersionId,
    ordinaryPlanSHA256: pinnedPlan.ordinaryPlanSHA256, ledgerSHA256: pinnedPlan.retentionLedgerSHA256,
    rollbackVersionId: baselineVersionId, assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance,
    oldAssetCount: 471, retainedAssetCount: pinnedPlan.retentionLedger.assets.length }));
  fs.writeFileSync(path.join(directory, 'upload-exit.json'), JSON.stringify({ code: 0 }));
  fs.writeFileSync(path.join(directory, 'upload-intent.json'), JSON.stringify({ phase: 'upload', automaticRetry: false,
    argv: [process.execPath, '--no-warnings', cliPath, 'versions', 'upload', '--config', path.join(directory, 'wrangler.retained.private.json')] }));
  fs.writeFileSync(path.join(directory, 'upload.private.log'), `Worker Version ID: ${candidateId}${duplicateCandidate ? `\nWorker Version ID: ${candidateId}` : ''}`);
  fs.writeFileSync(path.join(directory, 'verified-prior-active-assets.private.json'), JSON.stringify({ versionId: baselineVersionId,
    assetCount: 471, totalBytes: 12345, temporaryVerifierRemoved: true, absenceVerified: true, automaticRetry: false }));
  if (consumedPidName) fs.writeFileSync(path.join(directory, consumedPidName), JSON.stringify({ pid: 1234 }));
  return { directory, candidateId, baselineVersionId, pinnedPlan, cliPath };
}

test('resume journal accepts one proven upload intent and rejects replay, ambiguity, or prior stage', t => {
  const h = priorJournal(t);
  const result = qualifyPriorCandidateResumeJournal({ candidateId: h.candidateId,
    priorJournalDirectory: h.directory, originalSnapshot: {} }, { app: 'operations', baselineVersionId: h.baselineVersionId,
    pinnedPlan: h.pinnedPlan, oldAssetCount: 471, oldAssetBytes: 12345, cliPath: h.cliPath });
  assert.equal(result.candidateId, h.candidateId);
  assert.throws(() => qualifyPriorCandidateResumeJournal({ candidateId: h.candidateId,
    priorJournalDirectory: priorJournal(t, { extraStage: true }).directory, originalSnapshot: {} }, {
    app: 'operations', baselineVersionId: h.baselineVersionId, pinnedPlan: h.pinnedPlan, oldAssetCount: 471,
    oldAssetBytes: 12345, cliPath: h.cliPath }), /baseline verifier/u);
  assert.throws(() => qualifyPriorCandidateResumeJournal({ candidateId: h.candidateId,
    priorJournalDirectory: priorJournal(t, { duplicateCandidate: true }).directory, originalSnapshot: {} }, {
    app: 'operations', baselineVersionId: h.baselineVersionId, pinnedPlan: h.pinnedPlan, oldAssetCount: 471,
    oldAssetBytes: 12345, cliPath: h.cliPath }), /ambiguous/u);
  for (const marker of ['namespace-stage-pid.json', 'activate-pid.json']) assert.throws(() =>
    qualifyPriorCandidateResumeJournal({ candidateId: h.candidateId,
      priorJournalDirectory: priorJournal(t, { consumedPidName: marker }).directory, originalSnapshot: {} }, {
      app: 'operations', baselineVersionId: h.baselineVersionId, pinnedPlan: h.pinnedPlan, oldAssetCount: 471,
      oldAssetBytes: 12345, cliPath: h.cliPath }), /consumed namespace-stage or activation intent/u,
  `resume must refuse a prior ${marker} marker`);
});

const actualPriorJournalPath = process.env.LEDGETOP_ORDINARY_FRONTEND_PRIOR_CANDIDATE_DIRECTORY;
const actualRetainedPlanPath = process.env.LEDGETOP_ORDINARY_FRONTEND_RETAINED_PLAN_PATH;
const actualRetainedSnapshotPath = process.env.LEDGETOP_ORDINARY_FRONTEND_RETAINED_SNAPSHOT_PATH;
test('actual prior Ops journal qualifies only the exact verifier cleanup and single uploaded candidate',
  { skip: !actualPriorJournalPath || !actualRetainedPlanPath || !actualRetainedSnapshotPath }, () => {
    const plan = JSON.parse(fs.readFileSync(actualRetainedPlanPath, 'utf8'));
    const originalSnapshot = JSON.parse(fs.readFileSync(actualRetainedSnapshotPath, 'utf8'));
    const candidate = JSON.parse(fs.readFileSync(path.join(actualPriorJournalPath, 'candidate.private.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(actualPriorJournalPath, 'verified-prior-active-assets.private.json'), 'utf8'));
    const command = JSON.parse(fs.readFileSync(path.join(actualPriorJournalPath, 'upload-intent.json'), 'utf8'));
    const proof = qualifyPriorCandidateResumeJournal({ priorJournalDirectory: actualPriorJournalPath,
      candidateId: candidate.candidateId, originalSnapshot }, { app: 'operations', baselineVersionId: plan.parentVersionId,
      pinnedPlan: plan, oldAssetCount: receipt.assetCount, oldAssetBytes: receipt.totalBytes, cliPath: command.argv[2] });
    assert.equal(proof.candidateId, 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68');
    assert.equal(proof.priorJournalSHA256, 'e3bab5be0b21f81d7829a2c7b89652c0ceb6fa5eada7ae6681a42bab7abafeb0');
    assert.equal(proof.priorUploadLogSHA256, '7e1fd4e65688fd72782d9ee4005780055edba4536bd73784e0d68951b0233dc1');
    assert.equal(proof.priorPlanSHA256, 'e417f6842cda4296329adc2be3c415f04da988c45aa064bd52520c090d0fc6cf');
  });

const controlsFixturePath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_PRIVATE_FIXTURE;
test('fresh resume control check accepts latest-only candidate and rejects changed modules, bindings, or staged weights',
  { skip: !controlsFixturePath }, t => {
    const fixture = JSON.parse(fs.readFileSync(controlsFixturePath, 'utf8'));
    const original = fixture.snapshot, candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
    const expectedDeploymentVersions = { operations: [
      { versionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e', percentage: 0 },
      { versionId: 'a45943f4-e5c5-4142-9057-fb9adb5cf739', percentage: 100 },
    ] };
    const current = structuredClone(original); current.operations.latest = candidateId;
    assert.doesNotThrow(() => assertResumeControls(original, current, { app: 'operations', candidateId,
      profile: fixture.profile, expectedDeploymentVersions }));

    const baselineLatest = structuredClone(current); baselineLatest.operations.latest = original.operations.latest;
    assert.throws(() => assertResumeControls(original, baselineLatest, { app: 'operations', candidateId,
      profile: fixture.profile, expectedDeploymentVersions }), /exact supplied inactive candidate/u,
    'baseline-latest is not an acceptable resume target even when validateInstallation allows the baseline');

    for (const property of ['latestVersion', 'latestModern']) {
      if (!current.operations[property]) continue;
      const mismatchedLatestMetadata = structuredClone(current);
      mismatchedLatestMetadata.operations[property].id = original.operations.latest;
      assert.throws(() => assertResumeControls(original, mismatchedLatestMetadata, { app: 'operations', candidateId,
        profile: fixture.profile, expectedDeploymentVersions }), /exact supplied inactive candidate/u,
      `${property} must identify the exact candidate when captured`);
    }

    const changedModules = structuredClone(current);
    changedModules.operations.modern.modules.push({ name: 'unexpected.js', content_base64: 'eA==' });
    assert.throws(() => assertResumeControls(original, changedModules, { app: 'operations', candidateId,
      profile: fixture.profile, expectedDeploymentVersions }), /baseline version metadata or modules/u);

    const changedBindings = structuredClone(current);
    changedBindings.operations.version.resources.bindings.push({ name: 'UNREVIEWED', type: 'plain_text', text: 'true' });
    assert.throws(() => assertResumeControls(original, changedBindings, { app: 'operations', candidateId,
      profile: fixture.profile, expectedDeploymentVersions }));

    const alreadyStaged = structuredClone(current);
    alreadyStaged.operations.deployment.versions = [
      { version_id: 'a45943f4-e5c5-4142-9057-fb9adb5cf739', percentage: 100 },
      { version_id: candidateId, percentage: 0 },
    ];
    assert.throws(() => assertResumeControls(original, alreadyStaged, { app: 'operations', candidateId,
      profile: fixture.profile, expectedDeploymentVersions }), /expected staged weights/u);
  });

test('installed successor-reader profile remains opt-in and checks the actual version runtime bytes',
  { skip: !controlsFixturePath }, () => {
    const fixture = JSON.parse(fs.readFileSync(controlsFixturePath, 'utf8'));
    const snapshot = structuredClone(fixture.snapshot), candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
    snapshot.operations.deployment.versions = [{ version_id: candidateId, percentage: 100 }];
    snapshot.operations.version.id = candidateId; snapshot.operations.modern.id = candidateId;
    snapshot.operations.latest = candidateId;
    const reader = snapshot.operations.version.resources.script.named_handlers.find(row =>
      row.name === 'OperationsPortalNativeDeliveryAuthorizationReader');
    reader.handlers.push(...expectedMethods);
    const expectedDeploymentVersions = {};
    const options = { profile: fixture.profile, selectedApp: 'operations', expectedDeploymentVersions,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'operations' };
    assert.throws(() => validateInstallation(snapshot, options), /unrecognized exports\/runtime/u,
      'strict default still rejects the additive worker entrypoint');
    assert.throws(() => validateInstallation(snapshot, { ...options,
      opsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }), /runtime bytes differ/u,
    'the explicit contract rejects an unpinned or synthetic runtime even when the method names match');
  });

const successorVersionPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_VERSION_READBACK;
const successorModernPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_MODERN_READBACK;
test('known Ops successor version is recognized read-only in Client and Sync captures without changing either target',
  { skip: !controlsFixturePath || !successorVersionPath || !successorModernPath }, () => {
    const fixture = JSON.parse(fs.readFileSync(controlsFixturePath, 'utf8'));
    const candidateVersion = JSON.parse(fs.readFileSync(successorVersionPath, 'utf8'));
    const candidateModern = JSON.parse(fs.readFileSync(successorModernPath, 'utf8'));
    const candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
    assert.equal(candidateVersion.id, candidateId); assert.equal(candidateModern.id, candidateId);
    const current = structuredClone(fixture.snapshot);
    current.operations.version = candidateVersion; current.operations.modern = candidateModern;
    current.operations.latest = candidateId;
    current.operations.deployment.versions = [{ version_id: candidateId, percentage: 100 }];
    const originalClient = structuredClone(current.client), originalSync = structuredClone(current['ops-sync']);
    const common = { profile: fixture.profile, opsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'client' };
    assert.doesNotThrow(() => validateInstallation(current, { ...common, selectedApp: 'client' }),
      'Client release capture recognizes the explicit exact installed Ops version');
    assert.deepEqual(current.client, originalClient, 'read-only Ops recognition leaves Client state byte-equivalent');
    assert.doesNotThrow(() => validateInstallation(current, { ...common, selectedApp: 'ops-sync' }),
      'Sync release capture recognizes the same explicit exact installed Ops version');
    assert.deepEqual(current['ops-sync'], originalSync, 'read-only Ops recognition leaves Sync state byte-equivalent');
    assert.throws(() => validateInstallation(current, { profile: fixture.profile, selectedApp: 'client',
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'client' }),
      /unrecognized exports\/runtime/u, 'default remains closed without the explicit installed-state selector');

    const wrongId = structuredClone(current); wrongId.operations.version.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    wrongId.operations.modern.id = wrongId.operations.version.id;
    wrongId.operations.latest = wrongId.operations.version.id;
    wrongId.operations.deployment.versions[0].version_id = wrongId.operations.version.id;
    assert.throws(() => validateInstallation(wrongId, { ...common, selectedApp: 'client' }), /reviewed candidate version/u);
    const wrongCode = structuredClone(current);
    const main = wrongCode.operations.modern.modules.find(row => row.name === 'index.js');
    main.content_base64 = Buffer.from('synthetic changed main').toString('base64');
    assert.throws(() => validateInstallation(wrongCode, { ...common, selectedApp: 'client' }), /runtime bytes differ/u);
    const wrongMethod = structuredClone(current);
    wrongMethod.operations.version.resources.script.named_handlers.find(row =>
      row.name === 'OperationsPortalNativeDeliveryAuthorizationReader').handlers.push('readAnyAuthorization');
    assert.throws(() => validateInstallation(wrongMethod, { ...common, selectedApp: 'client' }), /unrecognized exports\/runtime/u);
  });
