import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {projectActiveRoleModules, validateRoleAwareCandidateSnapshot} from './staging-native-inquiry-pilot-v2-role-aware-readback.mjs';

const P = 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031';
const CLIENT_PLAN_FILE = `${P}/native-inquiry-pilot-v2-real-assets-local-v3-cached-20261031/client.held.json`;
const CLIENT_PLAN_SHA256 = 'd511657e9c053625096056dbbaa05f8cd8fe67903777e3ce93fa6f2ffa3323f9';
const CLIENT_PRE_FILE = `${P}/native-inquiry-client-v2-live-candidate-attempt2-20261031/pre-candidate-controls.private.json`;
const CLIENT_PRE_SHA256 = '4fce0ac3a045e516f5a06fd62da1b103e51acd41eaf9b421586a47f627b84e9e';
const CLIENT_READBACK_FILE = `${P}/native-inquiry-client-v2-live-candidate-attempt2-reconcile-v3-20261031/independent-readback.private.json`;
const CLIENT_READBACK_SHA256 = '7a249721075260b4a0357506ef06b10d44858710179f18432eab48025704ee7d';
const ACTIVATED_CONTROLS_FILE = `${P}/native-inquiry-client-v2-activation-20261031/after-controls.private.json`;
const ACTIVATED_CONTROLS_SHA256 = '05cc774472eb335606e54c411a8f69be0ddb88d19c96c2a096406393e3d4eb51';
const CLIENT_BASELINE = '2e8dd07c-3ccc-47ea-91ce-6e896b42313d';
const CLIENT_CANDIDATE = '650c0cec-63fb-407f-8bf3-5a19a0e95aa6';
const OPS_BASELINE = '49d03b5c-b104-4f00-974c-334f2ea576f1';
const SYNC_BASELINE = '470134b4-ef95-4702-98f3-110e4f4cbbb0';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function readJson(file, expectedSHA256) {
  const bytes = fs.readFileSync(file);
  assert.equal(sha(bytes), expectedSHA256, 'fixture digest differs from its fixed local pin');
  return JSON.parse(bytes.toString('utf8'));
}

const clientPlanBytes = fs.readFileSync(CLIENT_PLAN_FILE);
assert.equal(sha(clientPlanBytes), CLIENT_PLAN_SHA256);
const clientPlan = JSON.parse(clientPlanBytes.toString('utf8'));
const clientPre = readJson(CLIENT_PRE_FILE, CLIENT_PRE_SHA256);
const clientActual = readJson(CLIENT_READBACK_FILE, CLIENT_READBACK_SHA256);
const activatedControls = readJson(ACTIVATED_CONTROLS_FILE, ACTIVATED_CONTROLS_SHA256);

function clientCase(overrides = {}) {
  return {
    application: 'client', plan: clientPlan, planSHA256: CLIENT_PLAN_SHA256,
    preControls: clientPre, preControlsSHA256: CLIENT_PRE_SHA256,
    candidateVersionId: CLIENT_CANDIDATE,
    views: structuredClone(clientActual.views), schema: structuredClone(clientActual.schema),
    candidate: structuredClone(clientActual.candidate),
    candidateAnnotations: structuredClone(clientActual.views.client.settings.annotations),
    candidateVersionBindings: structuredClone(clientActual.candidate.resolvedBindings),
    phase: clientActual.phase, now: Date.parse(clientActual.at),
    ...overrides,
  };
}

test('accepts actual Client candidate with baseline active runtime and candidate latest settings', async () => {
  const input = clientCase();
  const activeBindings = input.preControls.workers.client.settings.bindings;
  const latestBindings = input.views.client.settings.bindings;
  assert.equal(input.views.client.activeVersionId, CLIENT_BASELINE);
  assert.equal(input.views.client.latestVersionId, CLIENT_CANDIDATE);
  assert.notDeepEqual(latestBindings, activeBindings, 'fixture must retain distinct latest settings and active bindings');
  assert.notDeepEqual(latestBindings, input.views.client.version.resources.bindings,
    'fixture must reproduce the selected-settings/active-runtime mismatch');

  const result = await validateRoleAwareCandidateSnapshot(input);
  assert.deepEqual(Object.keys(result).sort(), ['controls','readback','verification']);
  assert.deepEqual(Object.keys(result.readback).sort(), ['candidate','deployment','latestVersionId']);
  assert.deepEqual(Object.keys(result.readback.candidate).sort(), [
    'assetsConfig','compatibilityDate','compatibilityFlags','exports','id','mainModule','modules','resolvedBindings',
  ]);
  assert.equal(result.readback.latestVersionId, CLIENT_CANDIDATE);
  assert.equal(result.verification.phase, 'inactive');
  assert.equal(result.verification.readbackVerified, true);
  assert.equal(result.controls.workers.client.activeVersionId, CLIENT_BASELINE);
  assert.equal(result.controls.workers.client.latestVersionId, CLIENT_CANDIDATE);
  assert.equal(result.controls.resourceWrites, 0);
  assert.equal(result.controls.applicationRowsRead, 0);
});

test('active role module metadata matches actual pre-controls using pinned Client main bytes', () => {
  const plannedMainModules = clientPlan.versionCreateTemplate.modules
    .filter(module => module.content_type !== 'application/source-map');
  assert.deepEqual(projectActiveRoleModules(plannedMainModules), clientPre.workers.client.modern.modules);
  assert.deepEqual(Object.keys(clientPre.workers.client.modern.modules[0]).sort(), ['bytes','contentType','name','sha256']);
  assert.ok(clientPlan.versionCreateTemplate.modules.some(module => module.content_type === 'application/source-map'),
    'fixture must include a source map omitted by the active module capture');
  assert.deepEqual(Object.keys(clientActual.candidate.modules[0]).sort(), ['bytes','content_type','name','sha256'],
    'candidate DTO retains its separate uploader schema');
});

test('rejects Client candidate readback when traffic, active runtime, or settings drift', async t => {
  const cases = [
    ['candidate traffic is nonzero', input => { input.views.client.deployment.versions.push({version_id: CLIENT_CANDIDATE, percentage: 1}); }],
    ['active runtime changes', input => { input.views.client.modern.compatibility_date = '2099-01-01'; }],
    ['non-binding settings change', input => { input.views.client.settings.usage_model = 'unreviewed'; }],
    ['candidate annotations change', input => { input.candidateAnnotations['workers/triggered_by'] = ''; }],
    ['candidate gate binding changes', input => {
      input.candidate.resolvedBindings.find(row => row.name === 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED').textSHA256 = '0'.repeat(64);
    }],
    ['schema changes', input => { input.schema.OPS_DB.results[0].push({id: 999, name: 'unexpected'}); }],
    ['non-selected Ops state changes', input => { input.views.operations.latestVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const input = clientCase(); mutate(input);
      await assert.rejects(() => validateRoleAwareCandidateSnapshot(input));
    });
  }
});

test('Ops inspection rejects a Client change from its fresh post-activation pre-upload capture', async () => {
  const opsPlan = structuredClone(clientPlan);
  opsPlan.application = 'operations';
  opsPlan.workerName = 'ledgetop-ops-staging';
  opsPlan.sourceCommit = '4ee6cbe84265d07e2998b795f2a130763e95d4db';
  opsPlan.baselineVersionId = OPS_BASELINE;
  opsPlan.currentActiveVersionId = OPS_BASELINE;
  opsPlan.currentLatestVersionId = OPS_BASELINE;
  opsPlan.configurationDelta = [
    {name: 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED', type: 'plain_text', text: 'true'},
    {name: 'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', type: 'plain_text', text: 'true'},
  ];
  const candidateVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const preControls = structuredClone(activatedControls);
  assert.equal(preControls.workers.client.activeVersionId, CLIENT_CANDIDATE);
  assert.equal(preControls.workers.operations.activeVersionId, OPS_BASELINE);
  assert.equal(preControls.workers.sync.activeVersionId, SYNC_BASELINE);
  const views = structuredClone(preControls.workers);
  views.operations.latestVersionId = candidateVersionId;
  views.operations.deployment.versions.push({version_id: candidateVersionId, percentage: 0});
  views.client.latestVersionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  await assert.rejects(() => validateRoleAwareCandidateSnapshot({
    application: 'operations', plan: opsPlan, planSHA256: 'c'.repeat(64),
    preControls, preControlsSHA256: ACTIVATED_CONTROLS_SHA256, candidateVersionId,
    views, schema: structuredClone(preControls.schema), candidate: {}, candidateAnnotations: {},
    candidateVersionBindings: [], phase: 'zero', now: Date.parse(preControls.observedAt) + 1000,
  }), /client non-selected role changed/u);
});
