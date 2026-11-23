import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonical, hash, PROFILE, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ordinaryFrontendPreflightDescriptor,
  validateInstallation } from './production-deploy.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { POST0226_STAFF_PRESERVATION_CONTRACT } from './ordinary-frontend-authority-post0226.mjs';
import { executeOrdinaryFrontendRetainedRelease } from './ordinary-frontend-retained-executor.mjs';
import { compileOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { OPS_SOLE_ACTIVE_RELEASE_INPUTS_CONTRACT, createOpsSoleActiveReleaseWitness, describeOpsSoleActiveReleaseInputs,
  opsSoleActiveReleaseInputsBytes, parseOpsSoleActiveReleaseInputs, heldOpsSyncCompanionReceipt,
  assertHeldOpsSyncCompanion, assertHeldOpsSyncCompanionMap } from './ops-sync-companion-witness.mjs';

// Synthetic captures only: no production identifiers, values or credentials.
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./test-fixtures/ops-sole-active-release-captures.json', import.meta.url), 'utf8'));
const { sourceCommit, ids } = FIXTURE;
const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
const heldJournalBytes = Buffer.from(FIXTURE.heldSyncJournal, 'utf8');
const immutableMapEvidenceBytes = Buffer.from(`${JSON.stringify(FIXTURE.heldSyncMapProjection)}\n`, 'utf8');
const refused = /Exact held Ops Sync companion evidence refused/u;
const capture = name => structuredClone(FIXTURE.captures[name]);
const evidenceFor = snapshot => snapshot['ops-sync'].latest === snapshot['ops-sync'].version.id
  ? {} : { heldJournalBytes, immutableMapEvidenceBytes };

/** Release-time flow: read-only capture -> inputs file -> reviewed digest -> witness. */
function reviewedInputs(snapshot, edit) {
  const inputs = describeOpsSoleActiveReleaseInputs(snapshot, { sourceCommit, ...evidenceFor(snapshot) });
  edit?.(inputs);
  const inputsBytes = opsSoleActiveReleaseInputsBytes(inputs);
  return { inputs, inputsBytes, reviewedInputsSHA256: hash(inputsBytes) };
}
function witnessFor(liveSnapshot, { reviewedFrom = liveSnapshot, edit, ...overrides } = {}) {
  const { inputsBytes, reviewedInputsSHA256 } = reviewedInputs(reviewedFrom, edit);
  return createOpsSoleActiveReleaseWitness({ accountId, sourceCommit, snapshot: liveSnapshot, inputsBytes,
    reviewedInputsSHA256, ...evidenceFor(reviewedFrom), ...overrides });
}

test('single active: a sole 100% Operations version with a held Sync version is accepted from reviewed inputs', () => {
  const live = capture('singleActiveHeldSync');
  const { inputs, inputsBytes, reviewedInputsSHA256 } = reviewedInputs(live);
  assert.equal(inputs.contract, OPS_SOLE_ACTIVE_RELEASE_INPUTS_CONTRACT);
  assert.deepEqual(inputs.operations, { deploymentId: ids.OPS_DEP, versionId: ids.OPS });
  assert.equal(inputs.opsSync.activeVersionId, ids.SYNC);
  assert.equal(inputs.opsSync.latestVersionId, ids.SYNC_HELD);
  assert.equal(inputs.opsSync.activeLastDeployedFrom, 'wrangler');
  assert.equal(inputs.opsSync.latestLastDeployedFrom, 'api');
  assert.deepEqual(Object.keys(inputs.opsSync.stateSHA256).sort(),
    ['deployment', 'latestModern', 'latestVersion', 'modern', 'schedules', 'settings', 'version']);
  assert.equal(inputs.opsSync.held.journalSHA256, hash(heldJournalBytes));
  // The file is canonical JSON, so the reviewer and the executor hash the same bytes.
  assert.equal(inputsBytes.toString('utf8'), `${canonical(JSON.parse(inputsBytes))}\n`);
  assert.deepEqual(parseOpsSoleActiveReleaseInputs(inputsBytes, reviewedInputsSHA256), inputs);

  const witness = createOpsSoleActiveReleaseWitness({ accountId, sourceCommit, snapshot: live, inputsBytes,
    reviewedInputsSHA256, heldJournalBytes, immutableMapEvidenceBytes });
  const receipt = heldOpsSyncCompanionReceipt(witness, sourceCommit);
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual({ ...receipt, evidenceSHA256: undefined }, {
    contract: 'ops-sole-active-release-witness-v1', sourceCommit, accountId, inputsSHA256: reviewedInputsSHA256,
    opsBaselineVersionId: ids.OPS, opsDeploymentId: ids.OPS_DEP, syncDeploymentId: ids.SYNC_DEP,
    syncActiveVersionId: ids.SYNC, syncHeldVersionId: ids.SYNC_HELD, evidenceSHA256: undefined });
  assert.match(receipt.evidenceSHA256, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => assertHeldOpsSyncCompanion(witness, live));
  assert.doesNotThrow(() => assertHeldOpsSyncCompanionMap(witness, structuredClone(FIXTURE.heldSyncMapProjection)));
  // Later fences see Operations move to the candidate; only Sync is re-checked there.
  const staged = structuredClone(live);
  staged.operations.latest = '0a5e0009-0000-4000-8000-000000000009';
  assert.doesNotThrow(() => assertHeldOpsSyncCompanion(witness, staged));
});

test('single active: Sync with no inactive version needs no held evidence and has no map to check', () => {
  const live = capture('singleActivePlainSync');
  const { inputs } = reviewedInputs(live);
  assert.equal(inputs.opsSync.latestVersionId, inputs.opsSync.activeVersionId);
  assert.equal(inputs.opsSync.latestLastDeployedFrom, null);
  assert.equal(inputs.opsSync.held, null);
  assert.deepEqual(Object.keys(inputs.opsSync.stateSHA256).sort(), ['deployment', 'modern', 'schedules', 'settings', 'version']);
  const witness = witnessFor(live);
  assert.equal(heldOpsSyncCompanionReceipt(witness, sourceCommit).syncHeldVersionId, null);
  assert.doesNotThrow(() => assertHeldOpsSyncCompanion(witness, live));
  assert.throws(() => assertHeldOpsSyncCompanionMap(witness, FIXTURE.heldSyncMapProjection), /no held Ops Sync version/u);
  assert.throws(() => witnessFor(live, { heldJournalBytes, immutableMapEvidenceBytes }), /held evidence was supplied/u);
});

test('0/100 split: the sole-active inputs refuse a two-version Operations deployment', () => {
  const split = capture('opsSplit0100');
  assert.deepEqual(split.operations.deployment.versions.map(row => row.percentage), [0, 100]);
  assert.throws(() => describeOpsSoleActiveReleaseInputs(split, { sourceCommit, heldJournalBytes, immutableMapEvidenceBytes }),
    /not a single active Operations version/u);
  // Inputs reviewed while Operations was sole-active do not cover a later 0/100 split.
  assert.throws(() => witnessFor(split, { reviewedFrom: capture('singleActiveHeldSync') }),
    /live Operations is not a single active version/u);
  // A sole row that is not at 100% is refused too.
  const partial = capture('singleActiveHeldSync');
  partial.operations.deployment.versions[0].percentage = 99;
  assert.throws(() => witnessFor(partial, { reviewedFrom: capture('singleActiveHeldSync') }),
    /active version differs from inputs/u);
});

test('0/100 split: the witness cannot be combined with expected weights in the plan or the executor', async t => {
  // With the witness, the plan compiler forbids expected weights before reading the capture.
  const live = capture('singleActiveHeldSync'), witness = witnessFor(live);
  const release = { application: 'operations', sourceCommit };
  assert.throws(() => compileOrdinaryFrontendReleasePlan(live, { app: 'operations', release, profile: PROFILE,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, heldOpsSyncCompanionWitness: witness,
    reviewedCompanionExecutorCommit: 'e'.repeat(40),
    expectedDeploymentVersions: { operations: [{ versionId: ids.OPS_OLD, percentage: 0 }, { versionId: ids.OPS, percentage: 100 }] } }),
  /requires its exact sole-active Operations baseline/u);
  // The executor refuses the same pairing before any adapter, capture or native command.
  const h = executorHarness(t, witness);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options,
    expectedDeploymentVersions: { operations: [{ versionId: ids.OPS_OLD, percentage: 0 }, { versionId: ids.OPS, percentage: 100 }] } }),
  /requires the pinned sole-active Operations baseline/u);
  assert.deepEqual(h.calls, []);
});

const mismatches = [
  ['Operations active version', s => { s.operations.deployment.versions[0].version_id = ids.OPS_OLD; },
    /live Operations active version differs/u],
  ['Operations deployment', s => { s.operations.deployment.id = '0a5ed009-0000-4000-8000-000000000009'; },
    /live Operations deployment differs/u],
  ['Operations runtime', s => { s.operations.modern.id = ids.OPS_OLD; }, /version, runtime or latest differs/u],
  ['Operations inactive latest', s => { s.operations.latest = ids.OPS_OLD; }, /version, runtime or latest differs/u],
  ['Sync deployment', s => { s['ops-sync'].deployment.id = '5c0ed009-0000-4000-8000-000000000009'; },
    /live Ops Sync deployment differs/u],
  ['Sync active version', s => { s['ops-sync'].deployment.versions[0].version_id = ids.SYNC_HELD; },
    /live Ops Sync active version differs/u],
  ['Sync weights', s => { s['ops-sync'].deployment.versions[0].percentage = 0; }, /live Ops Sync active version differs/u],
  ['Sync latest released', s => { s['ops-sync'].latest = ids.SYNC; delete s['ops-sync'].latestVersion;
    delete s['ops-sync'].latestModern; }, /capture shape differs/u],
  ['Sync held upload source', s => { s['ops-sync'].latestVersion.resources.script.last_deployed_from = 'wrangler'; },
    /live held Ops Sync version differs/u],
  ['Sync active upload source', s => { s['ops-sync'].version.resources.script.last_deployed_from = 'api'; },
    /active upload source differs/u],
  ['Sync settings', s => { s['ops-sync'].settings.annotations['workers/message'] = 'changed'; }, /live Ops Sync settings differs/u],
  ['Sync schedules', s => { s['ops-sync'].schedules.schedules.push({ cron: '0 * * * *' }); }, /live Ops Sync schedules differs/u],
  ['Sync runtime modules', s => { s['ops-sync'].modern.modules[0].content_base64 = 'Y2hhbmdlZA=='; }, /live Ops Sync modern differs/u],
  ['Sync held modules', s => { s['ops-sync'].latestModern.modules = []; }, /live Ops Sync latestModern differs/u],
  ['Sync extra field', s => { s['ops-sync'].unreviewed = true; }, /capture shape differs/u],
];

test('mismatch: every live readback difference from the reviewed inputs is refused at creation and at each fence', () => {
  const reviewed = capture('singleActiveHeldSync'), witness = witnessFor(reviewed);
  for (const [name, mutate, message] of mismatches) {
    const live = capture('singleActiveHeldSync');
    mutate(live);
    assert.throws(() => witnessFor(live, { reviewedFrom: reviewed }), message, `creation: ${name}`);
    if (!name.startsWith('Operations')) assert.throws(() => assertHeldOpsSyncCompanion(witness, live), message, `fence: ${name}`);
  }
  const map = structuredClone(FIXTURE.heldSyncMapProjection);
  map.modules[1].content_base64 = Buffer.from('changed map').toString('base64');
  assert.throws(() => assertHeldOpsSyncCompanionMap(witness, map), /modules or source maps differ/u);
  assert.throws(() => assertHeldOpsSyncCompanionMap(witness, { ...FIXTURE.heldSyncMapProjection, id: ids.SYNC }),
    /modules or source maps differ/u);
});

test('mismatch: inputs must be the exact reviewed bytes, for this account, source and evidence', () => {
  const live = capture('singleActiveHeldSync');
  const { inputs, inputsBytes, reviewedInputsSHA256 } = reviewedInputs(live);
  const create = overrides => createOpsSoleActiveReleaseWitness({ accountId, sourceCommit, snapshot: live, inputsBytes,
    reviewedInputsSHA256, heldJournalBytes, immutableMapEvidenceBytes, ...overrides });
  assert.doesNotThrow(() => create({}));
  assert.throws(() => create({ reviewedInputsSHA256: 'f'.repeat(64) }), /differ from the independently reviewed SHA-256/u);
  assert.throws(() => create({ inputsBytes: Buffer.concat([inputsBytes, Buffer.from(' ')]) }), /independently reviewed/u);
  assert.throws(() => create({ inputsBytes: JSON.stringify(inputs) }), /reviewed file bytes/u);
  assert.throws(() => create({ sourceCommit: '0'.repeat(40) }), /release source differs/u);
  assert.throws(() => create({ accountId: '0'.repeat(32) }), /release source differs/u);
  assert.throws(() => create({ heldJournalBytes: Buffer.from('forged journal') }), /held Sync journal bytes differ/u);
  assert.throws(() => create({ heldJournalBytes: undefined }), /held Sync journal bytes differ/u);
  assert.throws(() => create({ immutableMapEvidenceBytes: Buffer.from('{}') }), /immutable Sync map evidence bytes differ/u);
  const rewritten = edit => { const r = reviewedInputs(live, edit);
    return () => create({ ...r, ...(r.inputs.opsSync.held ? {} : { heldJournalBytes: undefined, immutableMapEvidenceBytes: undefined }) }); };
  assert.throws(rewritten(i => { i.accountId = '0'.repeat(32); }), /another account/u);
  assert.throws(rewritten(i => { i.contract = 'team-663-held-ops-sync-companion-v1'; }), /unknown inputs contract/u);
  assert.throws(rewritten(i => { i.ready = true; }), /unknown inputs contract or fields/u);
  assert.throws(rewritten(i => { i.operations.versionId = 'latest'; }), /Operations inputs malformed/u);
  assert.throws(rewritten(i => { i.opsSync.held = null; }), /needs its reviewed evidence digests/u);
  assert.throws(rewritten(i => { delete i.opsSync.stateSHA256.latestModern; }), /state digests malformed/u);
  assert.throws(rewritten(i => { i.opsSync.held.immutableMapProjectionSHA256 = 'a'.repeat(64); }),
    /does not project to the reviewed held Sync version/u);
  // Hand-edited ids are refused against the live capture even when reviewed.
  assert.throws(rewritten(i => { i.operations.versionId = ids.OPS_OLD; }), /live Operations active version differs/u);
  assert.throws(rewritten(i => { i.opsSync.latestVersionId = ids.SYNC; i.opsSync.held = null;
    i.opsSync.latestLastDeployedFrom = null; delete i.opsSync.stateSHA256.latestVersion;
    delete i.opsSync.stateSHA256.latestModern; }), /capture shape differs/u);
});

test('mismatch: forged, foreign-source and expired witnesses are refused', t => {
  const live = capture('singleActiveHeldSync');
  assert.throws(() => heldOpsSyncCompanionReceipt(Object.freeze({}), sourceCommit), /was not issued/u);
  assert.throws(() => assertHeldOpsSyncCompanion({}, live), /was not issued/u);
  const witness = witnessFor(live);
  assert.throws(() => heldOpsSyncCompanionReceipt(witness, '0'.repeat(40)), /another release source/u);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fresh = witnessFor(live);
  t.mock.timers.tick(15 * 60_000 - 1);
  assert.doesNotThrow(() => heldOpsSyncCompanionReceipt(fresh, sourceCommit));
  t.mock.timers.tick(1);
  assert.throws(() => heldOpsSyncCompanionReceipt(fresh, sourceCommit), /expired/u);
  assert.throws(() => assertHeldOpsSyncCompanion(fresh, live), /expired/u);
});

test('mismatch: installation recognition refuses a capture that differs from the witness before profile checks', () => {
  const reviewed = capture('singleActiveHeldSync'), witness = witnessFor(reviewed), live = capture('singleActiveHeldSync');
  live['ops-sync'].settings.annotations['workers/message'] = 'changed';
  const options = { profile: PROFILE, selectedApp: 'operations', ordinaryFrontendApp: 'operations',
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, heldOpsSyncCompanionWitness: witness };
  assert.throws(() => validateInstallation(live, options), /live Ops Sync settings differs/u);
  assert.throws(() => validateInstallation(reviewed, { ...options, selectedApp: 'client', ordinaryFrontendApp: 'client' }),
    /limited to canonical Operations release/u);
});

function executorHarness(t, witness, ordinaryOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-sole-active-executor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], unexpected = name => () => { calls.push(name); throw Error(`unexpected ${name}`); };
  const ordinaryPlan = { application: 'operations', sourceCommit,
    installationPreflight: ordinaryFrontendPreflightDescriptor(PROFILE, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE),
    heldOpsSyncCompanion: heldOpsSyncCompanionReceipt(witness, sourceCommit),
    reviewedCompanionExecutorCommit: 'e'.repeat(40), ...ordinaryOverrides };
  const options = { app: 'operations', profile: PROFILE, reader: { get: unexpected('reader') },
    plan: { schemaVersion: 2, contract: 'ordinary-frontend-retained-native-module-v2', sourceCommit, ordinaryPlan },
    staffAuthorityContract: POST0226_STAFF_PRESERVATION_CONTRACT, heldOpsSyncCompanionWitness: witness,
    reviewedCompanionExecutorCommit: 'e'.repeat(40),
    assetVerifierProvider: { createVerifier: unexpected('createVerifier'), fetchVerifierAsset: unexpected('fetchVerifierAsset'),
      removeVerifier: unexpected('removeVerifier'), verifierAbsent: unexpected('verifierAbsent') },
    artifactSourceRoot: path.join(root, 'artifact'), executorSourceRoot: path.join(root, 'executor'),
    journalDirectory: path.join(root, 'journal'), runNative: unexpected('runNative'), captureFn: unexpected('capture'),
    readStaffCutover: unexpected('readStaffCutover'),
    sourceReader: dir => dir.endsWith('artifact') ? sourceCommit : 'e'.repeat(40) };
  return { options, calls };
}

test('mismatch: the executor refuses a witness whose reviewed inputs differ from the plan, before any adapter', async t => {
  const live = capture('singleActiveHeldSync');
  const planned = witnessFor(live);
  const other = witnessFor(capture('singleActivePlainSync'));
  const h = executorHarness(t, planned);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options, heldOpsSyncCompanionWitness: other }),
    /witness differs from the reviewed plan/u);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options, heldOpsSyncCompanionWitness: undefined }),
    /witness differs from the reviewed plan/u);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options, heldOpsSyncCompanionWitness: Object.freeze({}) }),
    refused);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options, staffAuthorityContract: 'native-staff-cutover-v1' }),
    /restricted to a new canonical Operations preservation release/u);
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ ...h.options, reviewedCompanionExecutorCommit: 'd'.repeat(40) }),
    /reviewed Team executor checkout differs/u);
  assert.deepEqual(h.calls, []);
});
