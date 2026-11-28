import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from './production-deploy.mjs';
import { verifyJournalOwnedInactiveCustody, verifyOwnedInactiveLiveState, isOwnedInactiveV5Custody,
  isOwnedInactiveV5Allowance, ownedInactiveV5BaselineAllowed, ownedInactiveV5ProviderParentAllowed,
  OWNED_INACTIVE_V5_WORKFLOW_PATH } from './production-auto-owned-inactive-v5.mjs';
import { isProductionAutoHoldCode } from './production-auto-hold-codes.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), HEAD = 'c'.repeat(40);
const PARENT = '11111111-1111-4111-8111-111111111111', CANDIDATE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MODULE = Buffer.from('export default {}'), LEDGER = Buffer.from('{"ledger":true}');
const RUN = 9001, ARTIFACT = 7001, DIGEST = 'd'.repeat(64);
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REFUSED = { message: 'owned_inactive_v5_custody_refused' };

function heldOperation({ worker = 'ledgetop-clients', source = OLD, stageZero = true } = {}) {
  const releaseId = sha(`${worker}\n${source}`);
  const intents = [], responses = [];
  const add = (phase, method, extra = {}, status = 200) => {
    const requestId = uuid(intents.length + 1);
    intents.push({ automaticRetry: false, hashes: [], intentRecordedAt: '2026-11-27T23:20:00.000Z', method, pathSha256: 'e'.repeat(64),
      phase, requestId, sequence: intents.length + 1, workerName: worker, ...extra });
    if (status !== null) responses.push({ ciphertextBytes: 1000, ciphertextFile: `responses/${requestId}.sealed.json`,
      ciphertextSha256: 'f'.repeat(64), errorCodes: [], providerAcknowledged: true, requestId, responseBytes: 100,
      responseSha256: '9'.repeat(64), status });
  };
  add('temporary-verifier-create', 'PUT', { temporaryWorkerName: 'ops-ui-verify-0123456789abcdef01234567', sourceSHA256: '8'.repeat(64) });
  add('temporary-verifier-enable', 'POST', { temporaryWorkerName: 'ops-ui-verify-0123456789abcdef01234567' });
  add('temporary-verifier-delete', 'DELETE', { temporaryWorkerName: 'ops-ui-verify-0123456789abcdef01234567', sourceSHA256: '8'.repeat(64) });
  add('asset-session', 'POST');
  add('asset-bucket', 'POST', {}, 201);
  add('worker-version-upload', 'POST', { parentVersionId: PARENT,
    modules: { '__ops_release_ledger.json': sha(LEDGER), 'index.js': sha(MODULE), 'index.js.map': '7'.repeat(64) } });
  if (stageZero) add('stage-zero-percent', 'POST', { candidateVersionId: CANDIDATE, parentVersionId: PARENT,
    versions: [{ percentage: 100, versionId: PARENT }, { percentage: 0, versionId: CANDIDATE }] }, null);
  return {
    artifact: { artifactId: ARTIFACT, digestSha256: DIGEST, name: `production-auto-${releaseId}`, releaseStepConclusion: 'failure',
      runAttempt: 1, runId: RUN, uploadStepConclusion: 'success' },
    ci: { runAttempt: 1, runId: 8001 }, createdAt: '2026-11-27T23:17:52.650Z', intents, releaseId, releaseKind: 'retained-assets',
    receipts: [
      { controlsSHA256: '5'.repeat(64), ownedUploadTagBaseline: 'auto-4a1c05e6f1ff', parentVersionId: PARENT, phase: 'prepare',
        recordedAt: '2026-11-27T23:17:52.650Z', status: 'started', writesAttempted: false },
      { automaticPruning: false, files: 3, ledgerSHA256: sha(LEDGER), minimumRetentionHours: 48, phase: 'prepare',
        recordedAt: '2026-11-27T23:20:50.563Z', status: 'prepared' },
      { candidateVersionId: CANDIDATE, ledgerSHA256: sha(LEDGER), phase: 'candidate-readback', recordedAt: '2026-11-27T23:25:41.174Z',
        status: 'inactive-verified' },
      { candidateVersionId: CANDIDATE, failureCode: 'release_stage_zero_failed', phase: 'stage-zero',
        reconciliation: { readSucceeded: false }, reconciliationCode: 'read_failed', recordedAt: '2026-11-27T23:26:37.150Z',
        status: 'held', writesAttempted: true },
    ],
    responses, runtime: { ledgerSha256: sha(LEDGER), moduleSha256: sha(MODULE), profileSha256: '4'.repeat(64) },
    sourceCommit: source, state: 'held', updatedAt: '2026-11-27T23:26:44.476Z', workerName: worker,
    workflow: { runAttempt: 1, runId: RUN },
  };
}
function olderVerified(worker = 'ledgetop-clients') {
  const op = heldOperation({ worker, source: '9'.repeat(40), stageZero: false });
  return { ...op, state: 'verified', createdAt: '2026-11-13T10:24:00.496Z', updatedAt: '2026-11-13T10:37:06.057Z',
    receipts: op.receipts.slice(0, 2), workflow: { runAttempt: 2, runId: 100 } };
}
const bytesOf = document => Buffer.from(canonical(document) + '\n', 'utf8');
function input(mutate = () => {}) {
  const document = { operations: [olderVerified(), heldOperation()], schemaVersion: 1, sequence: 150, workerName: 'ledgetop-clients' };
  const run = { id: RUN, run_attempt: 1, path: OWNED_INACTIVE_V5_WORKFLOW_PATH, event: 'workflow_run', head_branch: 'main',
    head_sha: OLD, status: 'completed', conclusion: 'failure' };
  const step = (name, conclusion) => ({ name, conclusion, number: 1 });
  const jobs = { total_count: 3, jobs: [
    { name: 'release-client', conclusion: 'failure', steps: [step('Set up job', 'success'),
      step('Run exact-main CI-fenced Client release', 'failure'), step('Upload only sealed provider responses', 'success'),
      step('Bind encrypted artifact id and digest to the durable journal', 'success')] },
    { name: 'release-operations', conclusion: 'skipped', steps: [] },
    { name: 'release-sync', conclusion: 'skipped', steps: [] }] };
  const artifact = { id: ARTIFACT, name: document.operations[1].artifact.name, expired: false, digest: `sha256:${DIGEST}`,
    workflow_run: { id: RUN, head_branch: 'main', head_sha: OLD } };
  const value = { workerName: 'ledgetop-clients', latestVersionId: CANDIDATE, sourceCommit: NEW, journalHead: HEAD,
    document, run, jobs, artifact };
  mutate(value);
  const { document: doc, ...rest } = value;
  return { ...rest, journalBytes: rest.journalBytes ?? bytesOf(doc) };
}
const held = value => value.document.operations[1];

test('a held run\'s own inactive upload yields custody; the hold code is registered', () => {
  const custody = verifyJournalOwnedInactiveCustody(input());
  assert.ok(isOwnedInactiveV5Custody(custody) && Object.isFrozen(custody));
  assert.equal(custody.parentVersionId, PARENT); assert.equal(custody.candidateVersionId, CANDIDATE);
  assert.equal(custody.ownedUploadTagBaseline, 'auto-4a1c05e6f1ff'); assert.equal(custody.oldSourceCommit, OLD);
  assert.equal(isOwnedInactiveV5Custody(JSON.parse(JSON.stringify(custody))), false, 'a copy is not custody');
  assert.ok(isProductionAutoHoldCode('owned_inactive_v5_custody_refused'));
  // A later run that held before writing anything does not block supersession.
  assert.ok(verifyJournalOwnedInactiveCustody(input(v => { const later = heldOperation({ source: '8'.repeat(40), stageZero: false });
    later.createdAt = '2026-11-28T00:00:00.000Z'; later.updatedAt = '2026-11-28T00:01:00.000Z';
    later.receipts = [later.receipts[0], { ...later.receipts[3], candidateVersionId: undefined, writesAttempted: false,
      failureCode: 'release_initial_failed', phase: 'initial' }].map(row => JSON.parse(JSON.stringify(row)));
    later.intents = []; later.responses = []; v.document.operations.push(later); })));
  // A run that held at candidate readback (no stage-zero intent at all) is the same case.
  assert.ok(verifyJournalOwnedInactiveCustody(input(v => { const op = held(v); op.intents.pop();
    op.receipts = [op.receipts[0], op.receipts[1], { ...op.receipts[3], failureCode: 'release_candidate_readback_failed', phase: 'candidate-readback' }]; })));
});

test('custody refuses anything the journal and the held run do not prove', () => {
  const cases = {
    'a different latest version': v => { v.latestVersionId = OTHER; },
    'the same source commit re-run over itself': v => { v.sourceCommit = OLD; },
    'non-canonical journal bytes': v => { v.journalBytes = Buffer.from(JSON.stringify(v.document)); },
    'another Worker\'s journal': v => { v.workerName = 'ledgetop-ops'; },
    'not the newest operation': v => { v.document.operations[0].updatedAt = '2026-11-28T00:00:00.000Z'; },
    'a second operation naming the version': v => { v.document.operations[0].receipts.push({ ...held(v).receipts[2] }); },
    'a verified (not held) operation': v => { held(v).state = 'verified'; },
    'a zero-percent stage that was verified': v => { held(v).receipts.splice(3, 0, { ...held(v).receipts[2], status: 'zero-percent-verified' }); },
    'an acknowledged stage-zero request': v => { const op = held(v); const id = op.intents.at(-1).requestId;
      op.responses.push({ ...op.responses[0], requestId: id, ciphertextFile: `responses/${id}.sealed.json` }); },
    'an activation intent': v => { const op = held(v); op.intents.push({ ...op.intents.at(-1), phase: 'activate-candidate',
      requestId: uuid(99), sequence: op.intents.length + 1 }); },
    'an unacknowledged version upload': v => { const op = held(v); op.responses = op.responses.filter(r => r.requestId !== op.intents[5].requestId); },
    'an upload with provider error codes': v => { const op = held(v); op.responses[5].errorCodes = [10021]; },
    'an upload over a different parent': v => { held(v).intents[5].parentVersionId = OTHER; },
    'an upload whose module hash differs from the run': v => { held(v).intents[5].modules['index.js'] = '0'.repeat(64); },
    'an unacknowledged earlier write': v => { held(v).responses[3].providerAcknowledged = false; },
    'two intents after the upload': v => { const op = held(v); op.intents.push({ ...op.intents.at(-1), requestId: uuid(98),
      sequence: op.intents.length + 1 }); },
    'a stage-zero intent over another parent': v => { held(v).intents.at(-1).parentVersionId = OTHER; },
    'an unknown write before the upload': v => { held(v).intents[3].phase = 'temporary-verifier-rename'; },
    'a response that belongs to no intent': v => { const op = held(v);
      op.responses.push({ ...op.responses[0], requestId: uuid(97), ciphertextFile: `responses/${uuid(97)}.sealed.json` }); },
    'a later write hidden behind an unparsable date': v => { const later = heldOperation({ source: '8'.repeat(40), stageZero: false });
      later.createdAt = 'tomorrow'; later.updatedAt = 'tomorrow';
      later.receipts = later.receipts.slice(0, 2); later.intents = later.intents.slice(0, 1); later.responses = later.responses.slice(0, 1);
      v.document.operations.push(later); },
    'two operations updated at the same time': v => { v.document.operations[0].updatedAt = held(v).updatedAt; },
    'a later operation that recorded a write': v => { const later = heldOperation({ source: '8'.repeat(40), stageZero: false });
      later.createdAt = '2026-11-28T00:00:00.000Z'; later.updatedAt = '2026-11-28T00:05:00.000Z';
      later.receipts = later.receipts.slice(0, 2); later.intents = later.intents.slice(0, 1); later.responses = later.responses.slice(0, 1);
      v.document.operations.push(later); },
    'a held receipt for another candidate': v => { held(v).receipts[3].candidateVersionId = OTHER; },
    'a held receipt that never attempted writes': v => { held(v).receipts[3].writesAttempted = false; },
    'an unknown failure code': v => { held(v).receipts[3].failureCode = 'release_activate_failed'; },
    'a run that succeeded': v => { v.run.conclusion = 'success'; },
    'another workflow': v => { v.run.path = '.github/workflows/production-auto-diagnostic.yml'; },
    'another branch': v => { v.run.head_branch = 'feature'; },
    'another head commit': v => { v.run.head_sha = NEW; },
    'a re-run attempt': v => { v.run.run_attempt = 2; },
    'a release step that did not fail': v => { v.jobs.jobs[0].steps[1].conclusion = 'success'; },
    'an artifact that was never bound': v => { v.jobs.jobs[0].steps[3].conclusion = 'failure'; },
    'a later job that ran': v => { v.jobs.jobs[1].conclusion = 'failure'; },
    'an unknown job': v => { v.jobs.jobs.push({ name: 'helper', conclusion: 'success', steps: [] }); v.jobs.total_count = 4; },
    'an expired artifact': v => { v.artifact.expired = true; },
    'another artifact digest': v => { v.artifact.digest = `sha256:${'0'.repeat(64)}`; },
    'an artifact from another run': v => { v.artifact.workflow_run.id = RUN + 1; },
    'an accessor in the run': v => { Object.defineProperty(v.run, 'conclusion', { get: () => 'failure', enumerable: true }); },
  };
  for (const [why, mutate] of Object.entries(cases))
    assert.throws(() => verifyJournalOwnedInactiveCustody(input(mutate)), REFUSED, why);
});

function liveSnapshot(mutate = () => {}) {
  const resources = { bindings: [{ name: 'ASSETS', type: 'assets' }, { name: 'DB', type: 'd1', id: 'x' }],
    script: { etag: 'parent-etag', last_deployed_from: 'wrangler', handlers: ['fetch'] },
    script_runtime: { compatibility_date: '2026-01-01', compatibility_flags: ['nodejs_compat'], usage_model: 'standard' } };
  const annotations = { 'workers/tag': `auto-${OLD.slice(0, 12)}`, 'workers/message': `Retained assets release ${OLD.slice(0, 12)}`,
    'workers/triggered_by': 'version_upload' };
  const modules = [{ name: 'index.js', content_base64: MODULE.toString('base64') },
    { name: '__ops_release_ledger.json', content_base64: LEDGER.toString('base64') }];
  const assets = { config: { not_found_handling: 'single-page-application' } };
  const client = {
    deployment: { id: uuid(500), created_on: '2026-11-27T17:30:36.136610Z', versions: [{ version_id: PARENT, percentage: 100 }] },
    latest: CANDIDATE, version: { id: PARENT, resources: structuredClone(resources) }, modern: { id: PARENT, assets: structuredClone(assets) },
    latestVersion: { id: CANDIDATE, annotations: structuredClone(annotations),
      resources: { ...structuredClone(resources), script: { ...resources.script, etag: 'candidate-etag', last_deployed_from: 'api' } } },
    latestModern: { id: CANDIDATE, modules, assets: structuredClone(assets) },
    settings: { annotations: structuredClone(annotations), bindings: [] }, schedules: { schedules: [] },
  };
  const snapshot = { client };
  mutate(snapshot.client);
  return snapshot;
}

test('the live state yields a single-use allowance only for the exact superseded upload over the same parent', () => {
  const custody = verifyJournalOwnedInactiveCustody(input());
  const allowance = verifyOwnedInactiveLiveState(custody, { snapshot: liveSnapshot(), projectedControlsSHA256: '5'.repeat(64) });
  assert.ok(isOwnedInactiveV5Allowance(allowance) && Object.isFrozen(allowance));
  assert.equal(isOwnedInactiveV5Allowance(structuredClone(allowance)), false, 'a copy is not an allowance');
  const baseline = { activeVersionId: PARENT, latestVersionId: CANDIDATE, versions: [{ versionId: PARENT, percentage: 100 }] };
  assert.equal(ownedInactiveV5BaselineAllowed(allowance, { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline }), true);
  for (const [why, args] of Object.entries({
    'another Worker': { workerName: 'ledgetop-ops', sourceCommit: NEW, baseline },
    'another source': { workerName: 'ledgetop-clients', sourceCommit: OLD, baseline },
    'another latest': { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline: { ...baseline, latestVersionId: OTHER } },
    'a split deployment': { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline: { ...baseline,
      versions: [{ versionId: PARENT, percentage: 90 }, { versionId: CANDIDATE, percentage: 10 }] } },
  })) assert.equal(ownedInactiveV5BaselineAllowed(allowance, args), false, why);
  assert.equal(ownedInactiveV5BaselineAllowed(structuredClone(allowance), { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline }), false);
  const state = liveSnapshot().client;
  assert.equal(ownedInactiveV5ProviderParentAllowed(allowance, { workerName: 'ledgetop-clients', parentVersionId: PARENT, state }), true);
  assert.equal(ownedInactiveV5ProviderParentAllowed(allowance, { workerName: 'ledgetop-clients', parentVersionId: OTHER, state }), false);
  assert.equal(ownedInactiveV5ProviderParentAllowed(allowance, { workerName: 'ledgetop-clients', parentVersionId: PARENT,
    state: { ...state, latest: OTHER } }), false);
  assert.equal(ownedInactiveV5ProviderParentAllowed(null, { workerName: 'ledgetop-clients', parentVersionId: PARENT, state }), false);
});

test('the live state refuses anything that is not exactly the held run\'s untouched upload', () => {
  const custody = verifyJournalOwnedInactiveCustody(input());
  const cases = {
    'a deployment made after the held run started': s => { s.deployment.created_on = '2026-11-27T23:26:20.000000Z'; },
    'a split deployment': s => { s.deployment.versions = [{ version_id: PARENT, percentage: 100 }, { version_id: CANDIDATE, percentage: 0 }]; },
    'another active version': s => { s.version.id = OTHER; s.modern.id = OTHER; s.deployment.versions[0].version_id = OTHER; },
    'another latest version': s => { s.latest = OTHER; },
    'a mismatched latest module read': s => { s.latestModern.id = OTHER; },
    'a missing deployment timestamp': s => { delete s.deployment.created_on; },
    'an unparseable deployment timestamp': s => { s.deployment.created_on = 'yesterday'; },
    'a changed binding on the upload': s => { s.latestVersion.resources.bindings.push({ name: 'EXTRA', type: 'kv_namespace', namespace_id: 'y' }); },
    'a changed compatibility date': s => { s.latestVersion.resources.script_runtime.compatibility_date = '2026-02-01'; },
    'a native (wrangler) upload': s => { s.latestVersion.resources.script.last_deployed_from = 'wrangler'; },
    'another asset config': s => { s.latestModern.assets = { config: { not_found_handling: 'none' } }; },
    'another module': s => { s.latestModern.modules[0].content_base64 = Buffer.from('other').toString('base64'); },
    'another ledger': s => { s.latestModern.modules[1].content_base64 = Buffer.from('{}').toString('base64'); },
    'a foreign upload tag': s => { s.latestVersion.annotations['workers/tag'] = 'auto-000000000000'; },
    'a hand-written message': s => { s.latestVersion.annotations['workers/message'] = 'manual'; },
  };
  for (const [why, mutate] of Object.entries(cases))
    assert.throws(() => verifyOwnedInactiveLiveState(custody, { snapshot: liveSnapshot(mutate), projectedControlsSHA256: '5'.repeat(64) }), REFUSED, why);
  assert.throws(() => verifyOwnedInactiveLiveState(custody, { snapshot: liveSnapshot(), projectedControlsSHA256: '6'.repeat(64) }),
    REFUSED, 'changed protected controls');
  assert.throws(() => verifyOwnedInactiveLiveState(structuredClone(custody), { snapshot: liveSnapshot(), projectedControlsSHA256: '5'.repeat(64) }),
    REFUSED, 'a copied custody grants nothing');
});

// A held run that verified its own zero-percent stage and then failed while proving the candidate's bytes.
const STAGE_DEPLOYMENT = '44444444-4444-4444-8444-444444444444';
function staged(v) {
  const op = held(v);
  const stage = op.intents[6];
  op.responses.push({ ...op.responses[0], requestId: stage.requestId, ciphertextFile: `responses/${stage.requestId}.sealed.json`, status: 200 });
  const verifier = (n, phase, method, acked) => {
    const requestId = uuid(80 + n);
    op.intents.push({ ...op.intents[0], phase, method, requestId, sequence: op.intents.length + 1 });
    if (acked) op.responses.push({ ...op.responses[0], requestId, ciphertextFile: `responses/${requestId}.sealed.json` });
  };
  verifier(1, 'temporary-verifier-create', 'PUT', true);
  verifier(2, 'temporary-verifier-enable', 'POST', false);
  op.receipts.splice(3, 0, { candidateVersionId: CANDIDATE, deploymentId: STAGE_DEPLOYMENT, phase: 'stage-zero',
    recordedAt: '2026-11-27T23:26:00.000Z', status: 'zero-percent-verified' });
  Object.assign(op.receipts.at(-1), { failureCode: 'release_candidate_assets_failed', phase: 'candidate-assets',
    reconciliation: { readSucceeded: true }, reconciliationCode: 'read_succeeded' });
}
const stagedLive = (mutate = () => {}) => liveSnapshot(s => {
  s.deployment = { id: STAGE_DEPLOYMENT, created_on: '2026-11-27T23:26:00.000000Z',
    versions: [{ version_id: PARENT, percentage: 100 }, { version_id: CANDIDATE, percentage: 0 }] };
  mutate(s);
});

test('a held run\'s own verified zero-percent stage is superseded only from exactly that recorded deployment', () => {
  const custody = verifyJournalOwnedInactiveCustody(input(staged));
  assert.equal(custody.stagedDeploymentId, STAGE_DEPLOYMENT);
  const allowance = verifyOwnedInactiveLiveState(custody, { snapshot: stagedLive(), projectedControlsSHA256: '5'.repeat(64) });
  assert.equal(allowance.stagedDeploymentId, STAGE_DEPLOYMENT);
  const baseline = { activeVersionId: PARENT, latestVersionId: CANDIDATE, deploymentId: STAGE_DEPLOYMENT,
    versions: [{ versionId: CANDIDATE, percentage: 0 }, { versionId: PARENT, percentage: 100 }] };
  assert.equal(ownedInactiveV5BaselineAllowed(allowance, { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline }), true);
  for (const [why, changed] of Object.entries({
    'another deployment id': { ...baseline, deploymentId: OTHER },
    'the parent alone': { ...baseline, versions: [{ versionId: PARENT, percentage: 100 }] },
    'the candidate live': { ...baseline, versions: [{ versionId: PARENT, percentage: 0 }, { versionId: CANDIDATE, percentage: 100 }] },
    'a partial rollout': { ...baseline, versions: [{ versionId: PARENT, percentage: 90 }, { versionId: CANDIDATE, percentage: 10 }] },
  })) assert.equal(ownedInactiveV5BaselineAllowed(allowance, { workerName: 'ledgetop-clients', sourceCommit: NEW, baseline: changed }), false, why);
  const state = stagedLive().client;
  assert.equal(ownedInactiveV5ProviderParentAllowed(allowance, { workerName: 'ledgetop-clients', parentVersionId: PARENT, state }), true);
  assert.equal(ownedInactiveV5ProviderParentAllowed(allowance, { workerName: 'ledgetop-clients', parentVersionId: PARENT,
    state: { ...state, deployment: { ...state.deployment, id: OTHER } } }), false);
  // A parent-only custody never covers a staged deployment, and a staged custody never covers the parent alone.
  assert.throws(() => verifyOwnedInactiveLiveState(verifyJournalOwnedInactiveCustody(input()),
    { snapshot: stagedLive(), projectedControlsSHA256: '5'.repeat(64) }), REFUSED);
  assert.throws(() => verifyOwnedInactiveLiveState(custody, { snapshot: liveSnapshot(), projectedControlsSHA256: '5'.repeat(64) }), REFUSED);
});

test('a staged held run refuses anything beyond its own stage and asset verifier', () => {
  const cases = {
    'an unacknowledged stage': v => { const op = held(v); op.responses = op.responses.filter(r => r.requestId !== op.intents[6].requestId); },
    'a stage of other weights': v => { held(v).intents[6].versions = [{ percentage: 90, versionId: PARENT }, { percentage: 10, versionId: CANDIDATE }]; },
    'a stage of another candidate': v => { held(v).intents[6].candidateVersionId = OTHER; },
    'an activation after the stage': v => { const op = held(v); op.intents.push({ ...op.intents[6], phase: 'activate-candidate',
      requestId: uuid(90), sequence: op.intents.length + 1 }); },
    'an asset write after the stage': v => { const op = held(v); op.intents.push({ ...op.intents[3], requestId: uuid(91), sequence: op.intents.length + 1 }); },
    'four verifier writes': v => { const op = held(v); op.intents.push({ ...op.intents[0], phase: 'temporary-verifier-delete', requestId: uuid(92),
      sequence: op.intents.length + 1 }, { ...op.intents[0], requestId: uuid(93), sequence: op.intents.length + 2 }); },
    'a stage receipt without its deployment': v => { delete held(v).receipts[3].deploymentId; },
    'candidate assets that were verified': v => { held(v).receipts.splice(4, 0, { candidateVersionId: CANDIDATE, phase: 'candidate-assets',
      status: 'candidate-assets-verified' }); },
    'a held stage-zero failure after a verified stage': v => { held(v).receipts.at(-1).failureCode = 'release_stage_zero_failed'; },
  };
  for (const [why, mutate] of Object.entries(cases))
    assert.throws(() => verifyJournalOwnedInactiveCustody(input(v => { staged(v); mutate(v); })), REFUSED, why);
  const custody = verifyJournalOwnedInactiveCustody(input(staged));
  for (const [why, mutate] of Object.entries({
    'another deployment id': s => { s.deployment.id = OTHER; },
    'other weights': s => { s.deployment.versions = [{ version_id: PARENT, percentage: 90 }, { version_id: CANDIDATE, percentage: 10 }]; },
    'the candidate live': s => { s.deployment.versions = [{ version_id: CANDIDATE, percentage: 100 }, { version_id: PARENT, percentage: 0 }]; },
  })) assert.throws(() => verifyOwnedInactiveLiveState(custody, { snapshot: stagedLive(mutate), projectedControlsSHA256: '5'.repeat(64) }),
    REFUSED, why);
});
