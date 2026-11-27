/** ops-staff-directory-entrypoint-v1: synthetic, offline-only checks. No Cloudflare, Wrangler or
 * provider call is made; the reviewed production pins are asserted separately and every other test
 * injects synthetic pins bound to synthetic bytes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, hash, canonical, validateInstallation, verifyCandidate, isHeldOpsStaffDirectoryInactiveLatest,
  OPS_STAFF_DIRECTORY_ENTRYPOINT, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT,
  OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_PREFLIGHT_MODE } from './production-deploy.mjs';
import { OPS_SOLE_ACTIVE_BASELINE_CONTRACT, qualifyOpsCandidateNamedHandlers, qualifyPriorCandidateResumeJournal,
  selectOperationsBaselineMode, selectOpsStaffDirectoryEntrypoint, verifyExactOpsStaffDirectoryEntrypointAddition }
  from './ordinary-frontend-retained-executor.mjs';
import { verifyOrdinaryFrontendCandidateModules } from './ordinary-frontend-candidate-verifier.mjs';
import { POST0226_STAFF_PRESERVATION_CONTRACT } from './ordinary-frontend-authority-post0226.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => structuredClone(value);
const ids = { operations: '11111111-1111-4111-8111-111111111111', client: '22222222-2222-4222-8222-222222222222',
  'ops-sync': '33333333-3333-4333-8333-333333333333' };
const NEW = '44444444-4444-4444-8444-444444444444';
const HELD = '55555555-5555-4555-8555-555555555555';
const HANDLERS = ['getPilotDeviceAuthority', 'isActiveStaff', 'resolvePilotUsername'];
const MAIN = Buffer.from('export default { fetch() {} }; export class StaffDirectory {}');
const MAP = { version: 3, file: 'index.js', sources: ['fixture.ts'], sourcesContent: ['export const fixture = true;'], names: [], mappings: 'AAAA' };
const MAP_BYTES = Buffer.from(JSON.stringify(MAP));
const pins = Object.freeze({ ...OPS_STAFF_DIRECTORY_ENTRYPOINT, mainSHA256: hash(MAIN), sourceMapSHA256: hash(MAP_BYTES),
  baselineVersionId: ids.operations, heldCandidateId: HELD });
const ordinaryPlanFor = p => ({ sourceCommit: p.sourceCommit, release: { main: { sha256: p.mainSHA256 }, sourceMap: { sha256: p.sourceMapSHA256 } } });

/** Same synthetic installation as production-deploy.test.mjs (strict default preflight). */
function fixture() {
  const profile = clone(PROFILE), snapshot = {};
  profile.onboardingAdminOrigin = undefined;
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'wrangler.jsonc'))).vars;
    if (app === 'client' && !spec.plainNames.includes('CLIENT_PORTAL_OPS_INQUIRIES_ENABLED')) {
      spec.plainNames = [...spec.plainNames, 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED'].sort();
      spec.plainValueSHA256.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED = hash('false');
    }
    const vars = Object.fromEntries(spec.plainNames.map(name => [name, defaults[name] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, {
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'false', DELIVERY_BASE_URL: 'https://portal.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]', CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true',
    });
    if (app === 'client') Object.assign(vars, { CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true',
      CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: 'false', CLIENT_VIEWER_ENABLED: 'false' });
    for (const key of Object.keys(spec.plainValueSHA256)) spec.plainValueSHA256[key] = hash(vars[key]);
    const bindings = [...clone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const resources = { script: { ...clone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' }, script_runtime: clone(spec.runtime), bindings };
    snapshot[app] = {
      latest: ids[app], deployment: { id: ids[app], versions: [{ version_id: ids[app], percentage: 100 }], strategy: 'percentage' },
      version: { id: ids[app], resources }, settings: { ...clone(spec.settings), annotations: { 'workers/message': 'fixture' }, bindings: clone(bindings) },
      modern: { id: ids[app], assets: app === 'ops-sync' ? undefined : { config: { base_path: '/' } },
        modules: [{ name: 'index.js', content_base64: Buffer.from('old').toString('base64') }] },
      schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'original-timestamp' })) },
    };
    spec.assetsSHA256 = hash(canonical(snapshot[app].modern.assets ?? null));
  }
  return { profile, snapshot };
}
function candidateFrom(before, id, mutate = () => {}) {
  const resources = clone(before.operations.version.resources);
  resources.script.etag = 'c'.repeat(64);
  resources.script.named_handlers.push({ name: 'StaffDirectory', handlers: [...HANDLERS] });
  const candidate = { id, resources };
  const modern = { id, assets: clone(before.operations.modern.assets), modules: [
    { name: 'index.js', content_base64: MAIN.toString('base64') },
    { name: 'index.js.map', content_base64: MAP_BYTES.toString('base64') }] };
  mutate(candidate, modern);
  return { candidate, modern };
}
function activated(before, candidate, modern) {
  const after = clone(before);
  Object.assign(after.operations, { latest: candidate.id, version: clone(candidate), modern: clone(modern),
    deployment: { ...after.operations.deployment, versions: [{ version_id: candidate.id, percentage: 100 }] } });
  return after;
}
const opsClass = (candidate, name) => candidate.resources.script.named_handlers.find(row => row.name === name);
const otherClass = candidate => candidate.resources.script.named_handlers.find(row => row.name !== 'StaffDirectory');
const DRIFT = {
  'extra method': c => { opsClass(c, 'StaffDirectory').handlers.push('listStaff'); },
  'missing method': c => { opsClass(c, 'StaffDirectory').handlers.pop(); },
  'renamed method': c => { opsClass(c, 'StaffDirectory').handlers[0] = 'getPilotDeviceAuthorityV2'; },
  'other class added': c => { c.resources.script.named_handlers.push({ name: 'StaffDirectoryAdmin', handlers: ['isActiveStaff'] }); },
  'existing class changed': c => { otherClass(c).handlers.push('unreviewedMethod'); },
  'existing class removed': c => { c.resources.script.named_handlers.splice(c.resources.script.named_handlers.indexOf(otherClass(c)), 1); },
  'class renamed': c => { opsClass(c, 'StaffDirectory').name = 'StaffDirectoryV2'; },
  'top-level handler changed': c => { c.resources.script.handlers.push('tail'); },
  'binding changed': c => { c.resources.bindings.push({ name: 'UNREVIEWED_FLAG', type: 'plain_text', text: 'true' }); },
  'runtime changed': c => { c.resources.script_runtime = { ...c.resources.script_runtime, compatibility_date: '2099-01-01' }; },
};

test('reviewed production pins are exactly the StaffDirectory build and carry no fresh candidate id', () => {
  assert.equal(OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT, 'ops-staff-directory-entrypoint-v1');
  assert.deepEqual({ ...OPS_STAFF_DIRECTORY_ENTRYPOINT, handlers: [...OPS_STAFF_DIRECTORY_ENTRYPOINT.handlers] }, {
    contract: 'ops-staff-directory-entrypoint-v1',
    sourceCommit: '331791ed56af4f2af24efc2a3003048a2d487ace',
    mainSHA256: 'c5007a88247f801f1f51ba5950d6371c9e2f554e63df7aca564584849c206333',
    sourceMapSHA256: '7865a50c3505c94be61a8fc3c3c1ef437797d2b45b11af70dc0d7955c0298e23',
    className: 'StaffDirectory', handlers: HANDLERS,
    baselineVersionId: 'b61e28eb-02c4-49b6-8bb0-c83aa6777c7d',
    heldCandidateId: '65650d92-00fe-40ff-8946-7df9ec8a407e',
    priorVerifierSourceSHA256: 'e6bdbe06ef1655d50c9960b7f8b28a0860e4d32259705199c54bde9c6425e09f' });
  assert.ok(Object.isFrozen(OPS_STAFF_DIRECTORY_ENTRYPOINT) && Object.isFrozen(OPS_STAFF_DIRECTORY_ENTRYPOINT.handlers));
});

test('executor verifier accepts only the exact StaffDirectory addition at the production pins', () => {
  const { snapshot: before } = fixture();
  const { candidate } = candidateFrom(before, NEW);
  const evidence = ordinaryPlanFor(OPS_STAFF_DIRECTORY_ENTRYPOINT);
  const proof = verifyExactOpsStaffDirectoryEntrypointAddition(before, candidate,
    { sourceCommit: evidence.sourceCommit, mainSHA256: evidence.release.main.sha256, sourceMapSHA256: evidence.release.sourceMap.sha256 });
  assert.equal(proof.contract, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT);
  assert.deepEqual(proof.addedHandlers, HANDLERS);
  assert.equal(proof.allOtherResourcesUnchanged, true);
  for (const [name, mutate] of Object.entries(DRIFT)) {
    const { candidate: drifted } = candidateFrom(before, NEW, mutate);
    assert.throws(() => verifyExactOpsStaffDirectoryEntrypointAddition(before, drifted, {
      sourceCommit: evidence.sourceCommit, mainSHA256: evidence.release.main.sha256, sourceMapSHA256: evidence.release.sourceMap.sha256 }),
    /StaffDirectory|beyond/u, name);
  }
  const good = { sourceCommit: evidence.sourceCommit, mainSHA256: evidence.release.main.sha256, sourceMapSHA256: evidence.release.sourceMap.sha256 };
  for (const wrong of [{ sourceCommit: 'b'.repeat(40) }, { mainSHA256: 'c'.repeat(64) }, { sourceMapSHA256: 'd'.repeat(64) }])
    assert.throws(() => verifyExactOpsStaffDirectoryEntrypointAddition(before, candidate, { ...good, ...wrong }),
      /pinned to the reviewed source, main bundle and source map/u);
  assert.throws(() => verifyExactOpsStaffDirectoryEntrypointAddition(before, clone(before.operations.version), good),
    /beyond the one reviewed StaffDirectory class/u, 'an unchanged candidate does not satisfy the selected contract');
});

test('exact addition passes candidate, module and post-activation installation checks end to end; rollback still validates', t => {
  const { profile, snapshot: before } = fixture();
  const { candidate, modern } = candidateFrom(before, NEW);
  const named = qualifyOpsCandidateNamedHandlers({ app: 'operations', before, candidate, ordinaryPlan: ordinaryPlanFor(pins),
    staffDirectory: { resume: false }, pins });
  assert.equal(named.kind, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT);
  assert.equal(named.moduleOptions.opsSuccessorReaderContract, undefined, 'the two contracts never combine');
  assert.deepEqual(verifyCandidate(before, 'operations', candidate, modern, MAIN, MAP, named.moduleOptions),
    { returnedSourceMapSemanticsVerified: true, providerDidNotExposeSourceMap: false });
  assert.throws(() => verifyCandidate(before, 'operations', candidate, modern, MAIN, MAP), /resources\/bindings\/exports differ/u,
    'without the contract the added class is refused as before');

  // Ordinary module verifier with the pinned plan files.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-staff-directory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'index.js'), MAIN); fs.writeFileSync(path.join(directory, 'index.js.map'), MAP_BYTES);
  const plan = { schemaVersion: 1, application: 'operations', offlineOnly: true, deploymentEnabled: false, sourceCommit: pins.sourceCommit,
    release: { main: { path: path.join(directory, 'index.js'), size: MAIN.length, sha256: hash(MAIN) },
      sourceMap: { path: path.join(directory, 'index.js.map'), size: MAP_BYTES.length, sha256: hash(MAP_BYTES) } },
    expectedBindings: clone(candidate.resources.bindings), expectedAssetsConfiguration: clone(modern.assets) };
  assert.equal(verifyOrdinaryFrontendCandidateModules({ before, plan, candidate, modern, ...named.moduleOptions }).candidateModulesVerified, true);
  assert.throws(() => verifyOrdinaryFrontendCandidateModules({ before, plan, candidate, modern,
    opsStaffDirectoryContract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT }), /plan differs from exact reviewed source bundle/u,
  'the production pins never match a synthetic plan');
  for (const [name, mutate] of Object.entries(DRIFT)) {
    const drifted = candidateFrom(before, NEW, mutate);
    assert.throws(() => verifyCandidate(before, 'operations', drifted.candidate, drifted.modern, MAIN, MAP, named.moduleOptions),
      /StaffDirectory candidate changed resources/u, name);
  }
  assert.throws(() => verifyCandidate(before, 'operations', candidate, modern, Buffer.from('other'), MAP, named.moduleOptions),
    /not the pinned reviewed runtime/u);

  // Inactive and staged phases: Ops selected with the candidate as latest only.
  const inactive = clone(before); inactive.operations.latest = NEW;
  assert.equal(validateInstallation(inactive, { profile, selectedApp: 'operations', allowLatest: { operations: NEW } }), inactive);

  // Post-activation: the executor re-verifies every later read and validates the installation.
  const after = activated(before, candidate, modern);
  named.verify(after.operations.version);
  const options = { profile, selectedApp: 'operations', ...named.installationOptions(NEW) };
  assert.equal(validateInstallation(after, options), after);
  assert.throws(() => validateInstallation(after, { profile, selectedApp: 'operations' }), /operations: unrecognized exports\/runtime\/resources/u,
    'before this change the activated candidate made the post-activation check throw');
  assert.throws(() => validateInstallation(after, { ...options, opsStaffDirectoryCandidateId: HELD }), /exact active candidate/u);
  const wrongBytes = clone(after); wrongBytes.operations.modern.modules[0].content_base64 = Buffer.from('x').toString('base64');
  assert.throws(() => validateInstallation(wrongBytes, options), /runtime bytes differ/u);
  for (const [name, mutate] of Object.entries(DRIFT)) {
    if (name === 'binding changed') continue; // settings/version binding equality refuses it separately below
    const drifted = candidateFrom(before, NEW, mutate);
    assert.throws(() => validateInstallation(activated(before, drifted.candidate, drifted.modern), options), undefined, name);
  }
  const bindingDrift = candidateFrom(before, NEW, DRIFT['binding changed']);
  assert.throws(() => validateInstallation(activated(before, bindingDrift.candidate, bindingDrift.modern), options), /bindings differ/u);

  // Contract scope.
  for (const extra of [{ opsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }, { selectedApp: 'client' },
    { opsStaffDirectoryContract: 'ops-staff-directory-entrypoint-v2' }, { opsStaffDirectoryCandidateId: undefined },
    { ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'operations' }])
    assert.throws(() => validateInstallation(after, { ...options, ...extra }),
      /StaffDirectory entrypoint contract is limited|Unreviewed ordinary frontend accepted profile/u, JSON.stringify(extra));
  assert.throws(() => validateInstallation(before, { profile, selectedApp: 'operations', opsStaffDirectoryCandidateId: NEW }),
    /requires its exact contract/u);

  // Rollback: the exact baseline still validates by itself, and the contract never applies to it.
  assert.equal(validateInstallation(clone(before), { profile, selectedApp: 'operations' }).operations.version.id, ids.operations);
  assert.throws(() => validateInstallation(clone(before), options), /exact active candidate/u);
});

test('named-handler dispatch keeps the successor exception separate and refuses unselected class additions', () => {
  const { snapshot: before } = fixture();
  const { candidate } = candidateFrom(before, NEW);
  assert.throws(() => qualifyOpsCandidateNamedHandlers({ app: 'operations', before, candidate, ordinaryPlan: ordinaryPlanFor(pins), pins }),
    /successor reader exception is pinned|successor/u, 'without the StaffDirectory selector the old refusal stands');
  const unchanged = { id: NEW, resources: clone(before.operations.version.resources) };
  const none = qualifyOpsCandidateNamedHandlers({ app: 'operations', before, candidate: unchanged, ordinaryPlan: ordinaryPlanFor(pins), pins });
  assert.equal(none.proof, null); assert.equal(none.installationOptions, null);
  assert.throws(() => qualifyOpsCandidateNamedHandlers({ app: 'client', before, candidate, ordinaryPlan: ordinaryPlanFor(pins),
    staffDirectory: { resume: false }, pins }), /Operations-only/u);
});

test('the explicit selector requires the pinned build, canonical v4, sole-active baseline and post-0226 authority', () => {
  const real = ordinaryPlanFor(OPS_STAFF_DIRECTORY_ENTRYPOINT);
  const exact = { app: 'operations', contract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT, ordinaryPlan: real,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT, staffAuthorityContract: POST0226_STAFF_PRESERVATION_CONTRACT };
  assert.deepEqual({ ...selectOpsStaffDirectoryEntrypoint(exact) }, { resume: false });
  for (const change of [
    { app: 'client' }, { contract: 'ops-staff-directory-entrypoint-v2' },
    { ordinaryPlan: { ...real, sourceCommit: 'b'.repeat(40) } },
    { ordinaryPlan: { ...real, release: { ...real.release, main: { sha256: 'c'.repeat(64) } } } },
    { ordinaryPlan: { ...real, release: { ...real.release, sourceMap: { sha256: 'd'.repeat(64) } } } },
    { ordinaryPlan: { ...real, installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT } },
    { ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE }, { operationsBaselineContract: undefined },
    { staffAuthorityContract: 'native-staff-cutover-v1' },
    { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT },
    { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT },
    { canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1' },
    { expectedDeploymentVersions: { operations: [] } },
  ]) assert.throws(() => selectOpsStaffDirectoryEntrypoint({ ...exact, ...change }), /StaffDirectory entrypoint contract requires/u,
    JSON.stringify(change));
  assert.throws(() => selectOpsStaffDirectoryEntrypoint({ ...exact, contract: undefined }), /requires its explicit entrypoint contract/u);
  assert.equal(selectOpsStaffDirectoryEntrypoint({ ...exact, contract: undefined, ordinaryPlan: ordinaryPlanFor(pins) }), null);
  assert.equal(selectOpsStaffDirectoryEntrypoint({ ...exact, app: 'client', contract: undefined }), null);
  assert.deepEqual({ ...selectOpsStaffDirectoryEntrypoint({ ...exact,
    resumeCandidate: { candidateId: OPS_STAFF_DIRECTORY_ENTRYPOINT.heldCandidateId } }) }, { resume: true });
  assert.throws(() => selectOpsStaffDirectoryEntrypoint({ ...exact, resumeCandidate: { candidateId: NEW } }),
    /limited to the exact held uploaded candidate/u);
  assert.equal(selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT,
    resumeCandidate: { candidateId: HELD }, opsStaffDirectoryResume: true }), 'sole-active');
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT,
    resumeCandidate: { candidateId: HELD } }), /excludes pinned staged weights/u);
});

function heldLatest() {
  const { profile, snapshot } = fixture();
  const { candidate, modern } = candidateFrom(snapshot, HELD);
  Object.assign(snapshot.operations, { latest: HELD, latestVersion: candidate, latestModern: modern });
  return { profile, snapshot };
}
test('an unselected Ops inactive latest is admitted only as the exact held StaffDirectory upload', () => {
  const { profile, snapshot } = heldLatest();
  assert.throws(() => validateInstallation(snapshot, { profile, selectedApp: 'client' }), /Unselected rolling version changed/u,
    'the production pins never match synthetic ids; this is also the refusal before this change');
  assert.equal(validateInstallation(snapshot, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }), snapshot);
  assert.equal(validateInstallation(snapshot, { profile, selectedApp: 'ops-sync', opsStaffDirectoryPins: pins }), snapshot);
  assert.throws(() => validateInstallation(snapshot, { profile, selectedApp: 'operations', opsStaffDirectoryPins: pins }),
    /Latest must equal the selected sole active version/u, 'never when Ops itself is selected');
  assert.throws(() => validateInstallation(snapshot, { profile, opsStaffDirectoryPins: pins }), /Latest must equal/u);
  const mutations = {
    ...Object.fromEntries(Object.entries(DRIFT).map(([name, mutate]) => [name, s => mutate(s.latestVersion)])),
    'main bytes': s => { s.latestModern.modules[0].content_base64 = Buffer.from('other').toString('base64'); },
    'api upload': s => { s.latestVersion.resources.script.last_deployed_from = 'api'; },
    'assets changed': s => { s.latestModern.assets = { config: { base_path: '/other' } }; },
    'other latest id': s => { s.latest = NEW; s.latestVersion.id = NEW; s.latestModern.id = NEW; },
    'other active baseline': s => { s.deployment.versions[0].version_id = NEW; s.version.id = NEW; s.modern.id = NEW; },
    'staged': s => { s.deployment.versions = [{ version_id: ids.operations, percentage: 100 }, { version_id: HELD, percentage: 0 }]; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const s = clone(snapshot.operations); mutate(s);
    assert.equal(isHeldOpsStaffDirectoryInactiveLatest('operations', s, pins), false, name);
  }
  assert.equal(isHeldOpsStaffDirectoryInactiveLatest('client', snapshot.operations, pins), false);
  const changed = clone(snapshot); changed.operations.latestVersion.resources.script.named_handlers.at(-1).handlers.push('extra');
  assert.throws(() => validateInstallation(changed, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }),
    /Unselected rolling version changed/u);
});

test('the activated held StaffDirectory version is recognized for later Client releases only by exact id and bytes', () => {
  const { profile, snapshot: before } = fixture();
  const { candidate, modern } = candidateFrom(before, HELD);
  const after = activated(before, candidate, modern);
  assert.throws(() => validateInstallation(after, { profile, selectedApp: 'client' }), /operations: unrecognized exports/u);
  assert.equal(validateInstallation(after, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }), after);
  assert.equal(validateInstallation(after, { profile, selectedApp: 'ops-sync', opsStaffDirectoryPins: pins }), after);
  assert.equal(validateInstallation(after, { profile, opsStaffDirectoryPins: pins }), after);
  assert.throws(() => validateInstallation(after, { profile, selectedApp: 'operations', opsStaffDirectoryPins: pins }),
    /operations: unrecognized exports/u, 'never as the baseline of another Ops release without a reviewed profile');
  const wrongBytes = clone(after); wrongBytes.operations.modern.modules[0].content_base64 = Buffer.from('x').toString('base64');
  assert.throws(() => validateInstallation(wrongBytes, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }), /runtime bytes differ/u);
  const extra = clone(after); opsClass(extra.operations.version, 'StaffDirectory').handlers.push('listStaff');
  assert.throws(() => validateInstallation(extra, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }), /unrecognized exports/u);
  const otherId = activated(before, candidateFrom(before, NEW).candidate, candidateFrom(before, NEW).modern);
  assert.throws(() => validateInstallation(otherId, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins }), /unrecognized exports/u);
  assert.throws(() => validateInstallation(after, { profile, selectedApp: 'client', opsStaffDirectoryPins: pins,
    opsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }), /successor reader/u);
});

function heldJournal(t, { a0Shape = false, verifierSHA256 = pins.priorVerifierSourceSHA256, candidateId = HELD } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-staff-directory-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baselineVersionId = pins.baselineVersionId, sourceCommit = pins.sourceCommit;
  const ordinaryPlan = { ...ordinaryPlanFor(pins), browserProof: { inventorySHA256: '7'.repeat(64) } };
  const pinnedPlan = { contract: 'ordinary-frontend-retained-native-module-v2', sourceCommit, ordinaryPlan,
    ordinaryPlanSHA256: '8'.repeat(64), retentionLedgerSHA256: '9'.repeat(64), retentionLedger: { assets: Array.from({ length: 12 }, () => ({})) },
    assetProviderIdentifierProvenance: { schema: 'sha256-prefix32-v1' } };
  const verifierName = 'ops-ui-verify-1234567890abcdef12345678', verifierPath = `/workers/scripts/${verifierName}`;
  const worker = a0Shape ? {} : { workerName: 'ledgetop-ops' };
  const rows = [
    { sequence: 1, at: '2026-11-27T00:00:00.000Z', phase: 'temporary-asset-verifier-create', workerName: 'ledgetop-ops',
      verifiedVersionId: baselineVersionId, verifierName, assetCount: 10, receiptName: 'verified-prior-active-assets', automaticRetry: false },
    { sequence: 2, at: '2026-11-27T00:00:01.000Z', phase: 'temporary-verifier-create', requestId: '1', method: 'PUT', path: verifierPath,
      name: verifierName, workerName: 'ledgetop-ops', sourceSHA256: verifierSHA256, sourceCommit, automaticRetry: false },
    { sequence: 3, at: '2026-11-27T00:00:02.000Z', phase: 'temporary-verifier-enable', requestId: '2', method: 'POST',
      path: `${verifierPath}/subdomain`, name: verifierName, ...worker, sourceCommit, automaticRetry: false },
    { sequence: 4, at: '2026-11-27T00:00:03.000Z', phase: 'temporary-verifier-delete', requestId: '3', method: 'DELETE', path: verifierPath,
      name: verifierName, ...worker, ...(a0Shape ? {} : { sourceSHA256: verifierSHA256 }), sourceCommit, automaticRetry: false },
    { sequence: 5, at: '2026-11-27T00:00:04.000Z', phase: 'native-version-upload', sourceCommit, workerName: 'ledgetop-ops',
      parentVersionId: baselineVersionId, mainSHA256: pins.mainSHA256, mapSHA256: pins.sourceMapSHA256,
      ledgerSHA256: pinnedPlan.retentionLedgerSHA256, assetInventorySHA256: ordinaryPlan.browserProof.inventorySHA256, automaticRetry: false },
  ];
  fs.writeFileSync(path.join(directory, 'journal.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(path.join(directory, 'candidate.private.json'), JSON.stringify({ candidateId, parentVersionId: baselineVersionId }));
  fs.writeFileSync(path.join(directory, 'release-plan.private.json'), JSON.stringify({ schemaVersion: 2, contract: pinnedPlan.contract,
    application: 'operations', sourceCommit, baselineVersionId, ordinaryPlanSHA256: pinnedPlan.ordinaryPlanSHA256,
    ledgerSHA256: pinnedPlan.retentionLedgerSHA256, rollbackVersionId: baselineVersionId,
    assetProviderIdentifierProvenance: pinnedPlan.assetProviderIdentifierProvenance, oldAssetCount: 10, retainedAssetCount: 12 }));
  fs.writeFileSync(path.join(directory, 'upload-exit.json'), JSON.stringify({ code: 0 }));
  fs.writeFileSync(path.join(directory, 'upload-intent.json'), JSON.stringify({ phase: 'upload', automaticRetry: false,
    argv: [process.execPath, '--no-warnings', process.execPath, 'versions', 'upload', '--config', path.join(directory, 'wrangler.retained.private.json')] }));
  fs.writeFileSync(path.join(directory, 'upload.private.log'), `Worker Version ID: ${candidateId}`);
  fs.writeFileSync(path.join(directory, 'upload-pid.json'), JSON.stringify({ pid: 1 }));
  fs.writeFileSync(path.join(directory, 'staff-before-upload.private.json'), JSON.stringify({ synthetic: true }));
  fs.writeFileSync(path.join(directory, 'verified-prior-active-assets.private.json'), JSON.stringify({ versionId: baselineVersionId,
    assetCount: 10, totalBytes: 999, temporaryVerifierRemoved: true, absenceVerified: true, automaticRetry: false }));
  return { directory, pinnedPlan, resume: { candidateId: HELD, priorJournalDirectory: directory, originalSnapshot: {} } };
}
test('resume journal accepts only the held StaffDirectory upload shape, verifier source and ids', t => {
  const options = h => ({ app: 'operations', baselineVersionId: pins.baselineVersionId, pinnedPlan: h.pinnedPlan,
    oldAssetCount: 10, oldAssetBytes: 999, cliPath: process.execPath, staffDirectoryPins: pins });
  const h = heldJournal(t);
  assert.equal(qualifyPriorCandidateResumeJournal(h.resume, options(h)).candidateId, HELD);
  assert.throws(() => qualifyPriorCandidateResumeJournal(h.resume, { ...options(h), staffDirectoryPins: null }), /baseline verifier/u,
    'the a0 journal rule does not accept the StaffDirectory upload');
  const a0 = heldJournal(t, { a0Shape: true });
  assert.throws(() => qualifyPriorCandidateResumeJournal(a0.resume, options(a0)), /baseline verifier/u);
  const otherVerifier = heldJournal(t, { verifierSHA256: 'e'.repeat(64) });
  assert.throws(() => qualifyPriorCandidateResumeJournal(otherVerifier.resume, options(otherVerifier)), /baseline verifier/u);
  assert.throws(() => qualifyPriorCandidateResumeJournal({ ...h.resume, candidateId: NEW }, options(h)), /exact held candidate/u);
  assert.throws(() => qualifyPriorCandidateResumeJournal(h.resume, { ...options(h), baselineVersionId: NEW }), /exact held candidate/u);
  const otherCandidate = heldJournal(t, { candidateId: NEW });
  assert.throws(() => qualifyPriorCandidateResumeJournal(otherCandidate.resume, options(otherCandidate)), /do not match the supplied candidate/u);
  assert.throws(() => qualifyPriorCandidateResumeJournal(h.resume, { ...options(h),
    pinnedPlan: { ...h.pinnedPlan, sourceCommit: 'b'.repeat(40) } }), /exact held candidate, baseline and pinned build/u);
});
