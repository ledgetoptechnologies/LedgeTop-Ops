import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, validateInstallation, ORDINARY_FRONTEND_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT,
  OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } from './production-deploy.mjs';
import { compileCanonicalBrowserRetirementTransition, normalizeCanonicalBrowserRetirementPoststate,
  validateCanonicalBrowserRetirementTarget } from './ordinary-frontend-canonical-browser-retirement.mjs';
import { compileOrdinaryFrontendReleasePlan, validateOrdinaryFrontendReleasePlan }
  from './ordinary-frontend-release-plan.mjs';
import { verifyOrdinaryFrontendCandidateModules } from './ordinary-frontend-candidate-verifier.mjs';
import { compileOrdinaryFrontendRetainedPlan, validateOrdinaryFrontendRetainedPlan }
  from './ordinary-frontend-retained-plan.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE, nativeDeliveryDeploymentEnabled,
  nativeDeliveryRequestOriginAllowed } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profilePath = process.env.LEDGETOP_CANONICAL_RETIREMENT_PROFILE
  ?? 'C:/Users/fstor/.codex/artifacts/production-ops-retained-preparation-20261031/profile.private.json';
const snapshotPath = process.env.LEDGETOP_CANONICAL_RETIREMENT_SNAPSHOT
  ?? 'C:/Projects/Ledge Top Operations/_artifacts/production-release-readback-20261104/snapshot.private.json';
const equal = (a, b) => canonical(a) === canonical(b);
const clone = value => structuredClone(value);
const selectorFor = app => app === 'operations'
  ? OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT : OPS_SUCCESSOR_READER_INSTALLED_CONTRACT;

function privateFixture(t) {
  if (!fs.existsSync(profilePath) || !fs.existsSync(snapshotPath)) {
    t.skip('Private exact accepted-profile/readback fixtures are not installed in this environment');
    return null;
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  for (const app of ['operations', 'client']) validateInstallation(snapshot, { profile, selectedApp: app,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
    opsSuccessorReaderContract: selectorFor(app) });
  return { profile, snapshot };
}

function releaseFixture(t, app) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-browser-retirement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets'); fs.mkdirSync(path.join(assets, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const files = { '/index.html': '<link rel="icon" href="/favicon.svg"><script type="module" src="/assets/app.js"></script>',
    '/assets/app.js': 'globalThis.reviewed=true;', '/favicon.svg': '<svg/>', '/apple-touch-icon.png': 'fixture-icon' };
  const inventory = [];
  for (const [assetPath, body] of Object.entries(files)) {
    const target = path.join(assets, assetPath.slice(1)); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body); inventory.push({ path: assetPath, size: Buffer.byteLength(body), sha256: hash(body) });
  }
  const main = path.join(directory, 'index.js'), sourceMap = `${main}.map`;
  fs.writeFileSync(main, 'export default {fetch(){return new Response("reviewed")}};');
  fs.writeFileSync(sourceMap, JSON.stringify({ version: 3, sources: ['worker.ts'], sourcesContent: ['worker source'], names: [], mappings: '' }));
  const pin = file => ({ path: file, size: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) });
  return { schemaVersion: 1, application: app, sourceCommit: '8e8554667c7de62cf3be44b5a650697c10f7c9bf',
    frontendSHA256: '3e745973ad87e592304188819ec0f4fbc692697bb6350c636b94f7d21d7f33c9',
    main: pin(main), sourceMap: pin(sourceMap), assets: { directory: assets, files: inventory } };
}

function retainedFixture(snapshot, app) {
  const copy = clone(snapshot), workerName = app === 'operations' ? 'ledgetop-ops' : 'ledgetop-clients';
  const bytes = new Map([['/index.html', Buffer.from('prior root')], ['/assets/prior.js', Buffer.from('prior bundle')]]);
  const entries = [...bytes].map(([assetPath, body]) => ({ path: assetPath, size: body.length, sha256: hash(body),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(body).slice(0, 32) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const ledger = mergeAssetLedger({ previous: null, current: { entries, payloads: bytes }, workerName,
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, sourceCommit: 'c'.repeat(40),
    parentVersionId: copy[app].version.id, observedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  copy[app].modern.modules = [...(copy[app].modern.modules ?? []).filter(row => row.name !== '__ops_release_ledger.json'),
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: ledgerBytes(ledger).toString('base64') }];
  return { snapshot: copy, previousLedger: ledger, previousAssetBytes: bytes, workerName };
}

function afterCanonicalClient(snapshot) {
  const after = clone(snapshot), clientId = after.client.version.id;
  const clientTransition = compileCanonicalBrowserRetirementTransition(snapshot, { app: 'client',
    profile: JSON.parse(fs.readFileSync(profilePath, 'utf8')) });
  for (const [name, value] of Object.entries(clientTransition.targetScalars)) for (const bindings of [
    after.client.version.resources.bindings, after.client.settings.bindings,
  ]) bindings.find(row => row.name === name).text = value;
  return { snapshot: after, clientId };
}

test('canonical-browser-retirement-v1 pins only exact existing scalars and stays within the 128-slot ceiling', t => {
  const fixture = privateFixture(t); if (!fixture) return;
  const { profile, snapshot } = fixture, unchanged = clone(snapshot), profileBefore = clone(profile);
  const clientPredecessor = afterCanonicalClient(snapshot);
  const ops = compileCanonicalBrowserRetirementTransition(clientPredecessor.snapshot, { app: 'operations', profile,
    clientVersionId: clientPredecessor.clientId });
  const client = compileCanonicalBrowserRetirementTransition(snapshot, { app: 'client', profile });
  assert.deepEqual(Object.keys(ops.changes), ['OPERATIONS_ORIGINS']);
  assert.equal(ops.changes.OPERATIONS_ORIGINS, 'https://ops.ledgetop.app');
  assert.deepEqual(Object.keys(client.changes).sort(), ['CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE',
    'CLIENT_PORTAL_ORIGINS', 'CLIENT_PORTAL_RETIRED_ORIGINS'].sort());
  assert.equal(client.targetScalars.CLIENT_PORTAL_ORIGINS, 'https://portal.ledgetop.app');
  assert.equal(client.targetScalars.CLIENT_PORTAL_RETIRED_ORIGINS,
    'https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com,https://client.ledgetopdroneservices.com');
  assert.equal(snapshot.client.version.resources.bindings.find(row => row.name === 'CANONICAL_BROWSER_NAVIGATION_ENABLED').text, 'true');
  assert.equal(ops.effectiveTextSecretBudget, 128);
  assert.equal(client.effectiveTextSecretBudget, 92);
  const targetEnv = { ENVIRONMENT: 'production', EXPECTED_HOST: 'delivery.ledgetop.app',
    PUBLIC_BASE_URL: 'https://delivery.ledgetop.app', PUBLIC_SHARE_ORIGIN: 'https://delivery.ledgetop.app',
    CLIENT_PORTAL_ORIGIN: 'https://portal.ledgetop.app', CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app',
    CLIENT_PORTAL_RETIRED_ORIGINS: client.targetScalars.CLIENT_PORTAL_RETIRED_ORIGINS,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: client.targetScalars.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE,
    CANONICAL_BROWSER_NAVIGATION_ENABLED: 'true' };
  assert.equal(targetEnv.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE, NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE);
  assert.equal(nativeDeliveryDeploymentEnabled(targetEnv), true);
  assert.equal(nativeDeliveryRequestOriginAllowed(targetEnv, 'https://portal.ledgetop.app/share/example'), true);
  for (const retiredOrigin of ['https://portal.ledgetopdroneservices.com', 'https://portal.ledgetoptechnologies.com',
    'https://client.ledgetopdroneservices.com'])
    assert.equal(nativeDeliveryRequestOriginAllowed(targetEnv, `${retiredOrigin}/share/example`), false);
  const forgedProfile = clone(profile); forgedProfile.frontendSHA256 = 'f'.repeat(64);
  assert.throws(() => compileCanonicalBrowserRetirementTransition(snapshot, { app: 'client', profile: forgedProfile,
    predecessorProfileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256 }), /exact accepted v3 predecessor profile/u);
  assert.equal(ops.expectedBindings.length, snapshot.operations.version.resources.bindings.length);
  assert.equal(client.expectedBindings.length, snapshot.client.version.resources.bindings.length);
  assert.deepEqual(profile, profileBefore); assert.deepEqual(snapshot, unchanged);
});

test('poststate normalization accepts the exact target, exposes unrelated drift, and rejects scalar or candidate-binding drift', t => {
  const fixture = privateFixture(t); if (!fixture) return;
  const { profile, snapshot } = fixture;
  for (const app of ['operations', 'client']) {
    const baseline = app === 'operations' ? afterCanonicalClient(snapshot) : { snapshot, clientId: undefined };
    const transition = compileCanonicalBrowserRetirementTransition(baseline.snapshot, { app, profile,
      ...(app === 'operations' ? { clientVersionId: baseline.clientId } : {}) });
    const candidate = clone(baseline.snapshot);
    for (const [name, value] of Object.entries(transition.targetScalars)) {
      for (const bindings of [candidate[app].version.resources.bindings, candidate[app].settings.bindings]) {
        const row = bindings.find(binding => binding.name === name);
        assert.ok(row); row.text = value;
      }
    }
    candidate[app].version.id = '99999999-9999-4999-8999-999999999999';
    const normalized = normalizeCanonicalBrowserRetirementPoststate(candidate, baseline.snapshot, transition);
    assert.equal(normalized[app].version.id, candidate[app].version.id);
    for (const [name, value] of Object.entries(transition.sourceScalars)) {
      assert.equal(normalized[app].version.resources.bindings.find(row => row.name === name).text, value);
      assert.equal(normalized[app].settings.bindings.find(row => row.name === name).text, value);
    }
    assert.throws(() => validateCanonicalBrowserRetirementTarget(transition,
      transition.expectedBindings.map(row => row.name === Object.keys(transition.targetScalars)[0] ? { ...row, text: 'unreviewed' } : row)),
    /exact finite transition/u);

    const wrongTarget = clone(candidate);
    const targetName = Object.keys(transition.targetScalars)[0];
    wrongTarget[app].settings.bindings.find(row => row.name === targetName).text = 'https://unreviewed.invalid';
    assert.throws(() => normalizeCanonicalBrowserRetirementPoststate(wrongTarget, baseline.snapshot, transition), /unexpected scalar/u);
    if (app === 'operations') {
      const partialClient = clone(candidate);
      partialClient.client.settings.bindings.find(row => row.name === 'CLIENT_PORTAL_ORIGINS').text = 'https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com';
      assert.throws(() => normalizeCanonicalBrowserRetirementPoststate(partialClient, baseline.snapshot, transition), /Client predecessor tuple changed/u);
    }

    const unrelatedDrift = clone(candidate);
    unrelatedDrift[app].version.id = baseline.snapshot[app].version.id;
    const unrelatedName = app === 'operations' ? 'PUBLIC_BASE_URL' : 'PUBLIC_SHARE_ORIGIN';
    unrelatedDrift[app].version.resources.bindings.find(row => row.name === unrelatedName).text = 'https://unreviewed.invalid';
    unrelatedDrift[app].settings.bindings.find(row => row.name === unrelatedName).text = 'https://unreviewed.invalid';
    const visible = normalizeCanonicalBrowserRetirementPoststate(unrelatedDrift, baseline.snapshot, transition);
    assert.equal(visible[app].version.resources.bindings.find(row => row.name === unrelatedName).text, 'https://unreviewed.invalid');
    assert.throws(() => validateInstallation(visible, { profile, selectedApp: app,
      ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: app,
      opsSuccessorReaderContract: selectorFor(app) }), /scalar configuration changed/u);
  }
});

test('ordinary retained plan pins before state, finite after bindings, and exact Ops successor selectors', t => {
  const fixture = privateFixture(t); if (!fixture) return;
  const { profile, snapshot } = fixture;
  for (const app of ['operations', 'client']) {
    const predecessor = app === 'operations' ? afterCanonicalClient(snapshot) : { snapshot, clientId: undefined };
    const options = app === 'operations'
      ? { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT }
      : { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT };
    const release = releaseFixture(t, app);
    const retained = retainedFixture(predecessor.snapshot, app);
    const planOptions = { app, release, profile, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
      canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1',
      ...(app === 'operations' ? { canonicalBrowserRetirementClientVersionId: predecessor.clientId } : {}), ...options };
    const plan = compileOrdinaryFrontendReleasePlan(retained.snapshot, planOptions);
    assert.equal(plan.installationPreflight.profileSHA256, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256);
    assert.equal(plan.canonicalBrowserRetirementSelector, 'canonical-browser-retirement-v1');
    assert.equal(plan.expectedBindings.length, snapshot[app].version.resources.bindings.length);
    assert.deepEqual(plan.config.unsafe.bindings.filter(row => row.type === 'plain_text').map(({ name, text }) => ({ name, text })).sort((a, b) => a.name.localeCompare(b.name)),
      Object.entries(plan.canonicalBrowserRetirementTransition.changes).map(([name, text]) => ({ name, text })).sort((a, b) => a.name.localeCompare(b.name)));
    assert.deepEqual(plan.config.unsafe.bindings.filter(row => row.type === 'inherit').map(row => row.name),
      snapshot[app].version.resources.bindings.filter(row => row.name !== 'ASSETS'
        && !Object.hasOwn(plan.canonicalBrowserRetirementTransition.changes, row.name)).map(row => row.name));
    assert.equal(plan.expectedProfile.workers[app].plainNames.length, profile.workers[app].plainNames.length);
    assert.equal(validateOrdinaryFrontendReleasePlan(retained.snapshot, plan, planOptions), plan);
    const retainedOptions = { ordinaryPlan: plan, profile, previousLedger: retained.previousLedger,
      previousAssetBytes: retained.previousAssetBytes, observedAt: new Date().toISOString(),
      canonicalBrowserRetirementSelector: plan.canonicalBrowserRetirementSelector,
      ...(app === 'operations' ? { canonicalBrowserRetirementClientVersionId: predecessor.clientId } : {}), ...options };
    const retainedPlan = compileOrdinaryFrontendRetainedPlan(retained.snapshot, retainedOptions);
    assert.equal(retainedPlan.parentVersionId, snapshot[app].version.id);
    assert.equal(retainedPlan.canonicalBrowserRetirementSelector, 'canonical-browser-retirement-v1');
    assert.equal(validateOrdinaryFrontendRetainedPlan(retained.snapshot, retainedPlan, retainedOptions), retainedPlan);
    const candidateId = '99999999-9999-4999-8999-999999999999';
    const candidate = { id: candidateId, resources: clone(snapshot[app].version.resources) };
    candidate.resources.bindings = clone(plan.expectedBindings);
    candidate.resources.script.last_deployed_from = 'wrangler';
    const modern = { id: candidateId, assets: clone(snapshot[app].modern.assets), modules: [
      { name: 'index.js', content_base64: fs.readFileSync(release.main.path).toString('base64') },
      { name: 'index.js.map', content_base64: fs.readFileSync(release.sourceMap.path).toString('base64') },
    ] };
    assert.equal(verifyOrdinaryFrontendCandidateModules({ before: retained.snapshot, plan, candidate, modern }).candidateModulesVerified, true);
    const driftedCandidate = clone(candidate);
    driftedCandidate.resources.bindings.find(row => row.name === Object.keys(plan.canonicalBrowserRetirementTransition.changes)[0]).text = 'https://unreviewed.invalid';
    assert.throws(() => verifyOrdinaryFrontendCandidateModules({ before: retained.snapshot, plan, candidate: driftedCandidate, modern }), /Candidate resources\/bindings\/exports differ/u);
    assert.throws(() => validateOrdinaryFrontendReleasePlan(retained.snapshot, plan, { ...planOptions,
      canonicalBrowserRetirementSelector: undefined }), /release plan changed|original production scalar/u);
    if (app === 'operations') {
      const unrelatedClientDrift = clone(retained.snapshot);
      unrelatedClientDrift.client.version.resources.bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text = 'https://drift.invalid';
      unrelatedClientDrift.client.settings.bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text = 'https://drift.invalid';
      assert.throws(() => compileOrdinaryFrontendReleasePlan(unrelatedClientDrift, planOptions), /scalar configuration changed/u);
      assert.throws(() => compileOrdinaryFrontendReleasePlan(retained.snapshot, { ...planOptions,
        canonicalBrowserRetirementClientVersionId: '88888888-8888-4888-8888-888888888888' }), /exact active Client candidate/u);
    }
  }
});

test('production entry explicitly forwards both installed Ops selector and canonical retirement pins', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/ordinary-frontend-retained-executor.mjs'), 'utf8');
  assert.match(source, /export async function executeOrdinaryFrontendRetainedProduction\(\{[\s\S]*?installedOpsSuccessorReaderContract,[\s\S]*?canonicalBrowserRetirementSelector, canonicalBrowserRetirementClientVersionId/u);
  assert.match(source, /return executeOrdinaryFrontendRetainedRelease\(\{[\s\S]*?installedOpsSuccessorReaderContract,[\s\S]*?canonicalBrowserRetirementSelector,[\s\S]*?canonicalBrowserRetirementClientVersionId/u);
});
