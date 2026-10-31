import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import { hashStagingNativeInquiryPilotV2PlanFile, stagingNativeInquiryPilotV2PlanConstants }
  from './staging-native-inquiry-pilot-v2-plan.mjs';
import { createStagingNativeInquiryPilotV2Uploader, isOutsideStagingNativeInquiryPilotV2Repository,
  projectStagingNativeInquiryPilotV2MaterializationEvidence,
  validateStagingNativeInquiryPilotV2CandidateReadback, validateStagingNativeInquiryPilotV2ManifestPaths,
  validateStagingNativeInquiryPilotV2UploadBuckets }
  from './staging-native-inquiry-pilot-v2-upload.mjs';

const { current, gates, sourceCommits } = stagingNativeInquiryPilotV2PlanConstants;
const CANDIDATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha = value => createHash('sha256').update(value).digest('hex');
const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('outside-repository guard accepts parent evidence paths and rejects worktree paths', () => {
  assert.equal(isOutsideStagingNativeInquiryPilotV2Repository(path.resolve(worktreeRoot, '..', 'private-evidence.json')), true);
  assert.equal(isOutsideStagingNativeInquiryPilotV2Repository(path.join(worktreeRoot, 'scripts', 'inside.json')), false);
  assert.equal(isOutsideStagingNativeInquiryPilotV2Repository(worktreeRoot), false);
});

test('manifest path order follows localeCompare for mixed-case names and hash paths', () => {
  const rows = [
    '/_ui/operations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.js',
    '/_ui/operations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Index.js',
    '/_ui/operations/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/icon.svg',
  ].sort((a, b) => a.localeCompare(b));
  assert.equal(rows[0] > rows[1], true, 'fixture must distinguish localeCompare from binary ordering');
  assert.equal(validateStagingNativeInquiryPilotV2ManifestPaths(rows), true);
  assert.throws(() => validateStagingNativeInquiryPilotV2ManifestPaths(rows.slice().reverse()));
});

test('asset evidence explicitly projects the manifest/root pair and keeps coverage separate', () => {
  const manifestFile = { path: 'C:/evidence/manifest.json', sha256: 'a'.repeat(64) };
  const coverageEvidenceFile = { path: 'C:/evidence/coverage.json', sha256: 'b'.repeat(64) };
  const projected = projectStagingNativeInquiryPilotV2MaterializationEvidence({ manifestFile,
    filesRoot: 'C:/evidence/assets', coverageEvidenceFile });
  assert.deepEqual(projected, { manifestFile, filesRoot: 'C:/evidence/assets' });
  assert.deepEqual(Object.keys(projected).sort(), ['filesRoot','manifestFile']);
});

test('Cloudflare cached asset sessions may return empty or partial buckets, while unknown and duplicate hashes fail', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  const uploads = new Map([[a, {}], [b, {}], [c, {}]]);
  assert.deepEqual(validateStagingNativeInquiryPilotV2UploadBuckets([], uploads), { buckets: [], requestedUploadCount: 0 });
  assert.deepEqual(validateStagingNativeInquiryPilotV2UploadBuckets([[a],[c,b]], uploads),
    { buckets: [[a],[c,b]], requestedUploadCount: 3 });
  assert.deepEqual(validateStagingNativeInquiryPilotV2UploadBuckets([[a]], uploads),
    { buckets: [[a]], requestedUploadCount: 1 });
  assert.throws(() => validateStagingNativeInquiryPilotV2UploadBuckets([[a,'d'.repeat(32)]], uploads));
  assert.throws(() => validateStagingNativeInquiryPilotV2UploadBuckets([[a],[a]], uploads));
});

function fixture(application = 'client') {
  const workerName = current[application].workerName, baselineVersionId = current[application].activeVersionId;
  const mainModule = application === 'operations' ? 'staging-native-authority-entrypoint.js' : 'index.js';
  const mainBytes = Buffer.from(`export default { fetch(){ return new Response('ok') } }`);
  const mapBytes = Buffer.from('{"version":3,"sources":[]}');
  const gateRows = gates[application].map(name => ({ name, type: 'plain_text', text: 'true' }));
  const inherited = [
    { name: 'EXAMPLE_SERVICE', type: 'inherit', version_id: baselineVersionId },
    { name: 'NOTIFICATION_EMAIL', type: 'inherit', version_id: baselineVersionId },
  ];
  const resolved = { name: 'EXAMPLE_SERVICE', type: 'service', service: 'example-worker', entrypoint: 'Example' };
  const resolvedEmail = { name: 'NOTIFICATION_EMAIL', type: 'send_email', allowed_sender_addresses: ['notice@example.invalid'] };
  return {
    schemaVersion: 2, contract: 'staging-native-inquiry-pilot-config-only-v2',
    purpose: 'staging-native-inquiry-pilot-configuration-only-v2', application, step: application === 'client' ? 1 : 2,
    accountId: STAGING_ACCOUNT_ID, workerName, sourceCommit: sourceCommits[application], sourceProfiles: sourceCommits,
    baselineVersionId, currentActiveVersionId: baselineVersionId, currentLatestVersionId: baselineVersionId,
    basePlanContract: application === 'client' ? 'staging-backend-only-current-profile-v4' : 'staging-backend-only-owner-review-profile-v5',
    basePlanSchemaVersion: application === 'client' ? 4 : 5, basePlanSHA256: 'b'.repeat(64),
    controlsSHA256: '1'.repeat(64), baselineControlsSHA256: '2'.repeat(64),
    controlsObservedAt: '2026-10-31T12:00:00.000Z', baselineControlsObservedAt: '2026-10-31T12:00:00.000Z',
    databaseSchemaSHA256: 'c'.repeat(64),
    mainModuleSHA256: sha(mainBytes), sourceMapSHA256: sha(mapBytes),
    installedCodeMatchesQualifiedBuild: true, installedRuntimeAndBindingsMatchBase: true, schemaMatchesBase: true,
    preservedBindings: ['EXAMPLE_SERVICE','NOTIFICATION_EMAIL'], expectedResolvedBindings: [resolved, resolvedEmail].map(row => ({
      name: row.name, type: row.type, projectionSHA256: sha(canonical(row)) })).sort((a, b) => a.name.localeCompare(b.name)),
    configurationDelta: gates[application].map(name => ({ name, type: 'plain_text', text: 'true' })),
    clientPilotContext: application === 'client' ? null : { receiptSHA256: 'd'.repeat(64), candidateVersionId: CANDIDATE,
      deploymentId: CANDIDATE,
      planSHA256: 'e'.repeat(64), baselineControlsSHA256: 'f'.repeat(64), controlsSHA256: 'a'.repeat(64) },
    held: true, offlineOnly: true, deploymentEnabled: false, executionAllowed: false,
    holdReasons: ['held','coverage','runtime','review'],
    futureExecutionPrerequisites: ['controls','assets','coverage','proof'],
    noIdentityOrCapabilityGrant: true, noMigrationConfig: true, noOpsSyncUpdate: true,
    noFileOrFinancePermission: true, noNotificationCreation: true,
    assetUploadRecipe: { protocol: 'workers-static-assets-upload-v1', completionJwtRequired: true,
      completionJwtMemoryOnly: true, completionJwtPersisted: false, providerManifestBytesPersisted: false,
      requiresReviewedRetainedReleaseCoverageEvidence: true, uploadAssetSetAllowed: false,
      assetsConfig: { base_path: '/' } },
    versionCreateTemplate: { account_id: STAGING_ACCOUNT_ID, main_module: mainModule, deploy: false,
      bindings: [...inherited, ...gateRows], modules: [
        { name: mainModule, content_type: 'application/javascript', content_base64: mainBytes.toString('base64') },
        { name: `${mainModule}.map`, content_type: 'application/source-map', content_base64: mapBytes.toString('base64') },
      ], compatibility_date: '2026-10-01', compatibility_flags: [], exports: {} },
  };
}

function validReadback(plan) {
  const candidateParams = structuredClone(plan.versionCreateTemplate);
  candidateParams.bindings.push({ name: 'ASSETS', type: 'assets' });
  candidateParams.assets = { config: plan.assetUploadRecipe.assetsConfig, jwt: 'test-jwt-held-in-memory' };
  candidateParams.deploy = false; candidateParams.bindings_inherit = 'strict';
  const resolvedBindings = [
    { name: 'EXAMPLE_SERVICE', type: 'service', service: 'example-worker', entrypoint: 'Example' },
    { name: 'NOTIFICATION_EMAIL', type: 'send_email', allowed_sender_addresses: ['notice@example.invalid'] },
    ...gates[plan.application].map(name => ({ name, type: 'plain_text', textSHA256: sha(JSON.stringify('true')) })),
    { name: 'ASSETS', type: 'assets' },
  ];
  const main = candidateParams.modules[0], bytes = Buffer.from(main.content_base64, 'base64');
  return { candidateParams, readback: { latestVersionId: CANDIDATE,
    deployment: [{ versionId: plan.baselineVersionId, percentage: 100 }],
    candidate: { id: CANDIDATE, mainModule: main.name,
      modules: [{ name: main.name, bytes: bytes.length, sha256: sha(bytes), content_type: main.content_type }],
      resolvedBindings, assetsConfig: candidateParams.assets.config, compatibilityDate: candidateParams.compatibility_date,
      compatibilityFlags: candidateParams.compatibility_flags, exports: candidateParams.exports } } };
}

test('v2 candidate readback accepts the exact inactive configuration candidate', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  assert.equal(validateStagingNativeInquiryPilotV2CandidateReadback({ readback, candidateVersionId: CANDIDATE,
    plan, candidateParams }), true);
});

test('v2 candidate readback refuses any nonzero candidate traffic', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  readback.deployment.push({ versionId: CANDIDATE, percentage: 1 });
  assert.throws(() => validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }));
});

test('v2 candidate readback accepts an explicitly observed zero-weight row', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  readback.deployment.push({ versionId: CANDIDATE, percentage: 0 });
  assert.equal(validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }), true);
});

test('v2 candidate readback refuses a changed resolved inherited binding', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  readback.candidate.resolvedBindings[0].service = 'unexpected-worker';
  assert.throws(() => validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }));
});

test('v2 candidate readback refuses changed notification sender restrictions', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  readback.candidate.resolvedBindings.find(row => row.name === 'NOTIFICATION_EMAIL').allowed_sender_addresses = ['unexpected@example.invalid'];
  assert.throws(() => validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }));
});

test('v2 candidate readback refuses a changed source module byte hash', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  readback.candidate.modules[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }));
});

test('v2 candidate readback refuses a plan with any extra configuration flag', () => {
  const plan = fixture(), { readback, candidateParams } = validReadback(plan);
  plan.configurationDelta.push({ name: 'NATIVE_STAFF_MASTER_ENABLED', type: 'plain_text', text: 'true' });
  assert.throws(() => validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
    candidateVersionId: CANDIDATE, plan, candidateParams }));
});

test('uploader factory fails closed without injected provider, readback and journal ports', () => {
  assert.throws(() => createStagingNativeInquiryPilotV2Uploader({}));
});

test('canonical plan hash uses the same serialization contract as the plan builder', () => {
  const plan = fixture();
  assert.match(hashStagingNativeInquiryPilotV2PlanFile(plan), /^[a-f0-9]{64}$/u);
});
