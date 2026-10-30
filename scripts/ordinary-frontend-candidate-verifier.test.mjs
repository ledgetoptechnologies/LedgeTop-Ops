import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, ORDINARY_FRONTEND_PREFLIGHT_MODE, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256 } from './production-deploy.mjs';
import { verifyOrdinaryFrontendCandidate, verifyOrdinaryFrontendCandidateModules, verifyOrdinaryFrontendAssetNamespace,
  ordinaryFrontendExecutionQualification, decodeNativeModuleBytes, MAX_NATIVE_MODULE_BYTES } from './ordinary-frontend-candidate-verifier.mjs';
import { mergeAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const COMMIT = '8e8554667c7de62cf3be44b5a650697c10f7c9bf';
const BASELINE = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
const mainBytes = Buffer.from('export default {fetch(){return new Response("reviewed")}};');
const mapBytes = Buffer.from(JSON.stringify({ version: 3, sources: ['worker.ts'], sourcesContent: ['source'], names: [], mappings: '' }));

function runtimeFixture(t, app = 'operations', mainBytes = Buffer.from('export default {fetch(){return new Response("reviewed")}};'),
  mapBytes = Buffer.from(JSON.stringify({ version: 3, sources: ['worker.ts'], sourcesContent: ['source'], names: [], mappings: '' }))) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-frontend-modules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainPath = path.join(root, 'index.js'), mapPath = `${mainPath}.map`;
  fs.writeFileSync(mainPath, mainBytes); fs.writeFileSync(mapPath, mapBytes);
  const resources = { script: { handlers: ['fetch'], named_handlers: [], last_deployed_from: 'wrangler' },
    script_runtime: { compatibility_date: '2026-07-22' }, bindings: [{ name: 'ASSETS', type: 'assets' }, { name: 'OPS_DB', type: 'd1' }] };
  const before = { [app]: { version: { resources }, modern: { assets: { config: { base_path: '/' } } } } };
  const release = { main: { path: mainPath, size: mainBytes.length, sha256: hash(mainBytes) },
    sourceMap: { path: mapPath, size: mapBytes.length, sha256: hash(mapBytes) } };
  const plan = { schemaVersion: 1, application: app, offlineOnly: true, deploymentEnabled: false,
    expectedBindings: structuredClone(resources.bindings), expectedAssetsConfiguration: { config: { base_path: '/' } }, release };
  const candidate = { id: CANDIDATE, resources: structuredClone(resources) };
  const modern = { id: CANDIDATE, assets: structuredClone(plan.expectedAssetsConfiguration), modules: [
    { name: 'index.js', content_base64: mainBytes.toString('base64') },
    { name: 'index.js.map', content_base64: mapBytes.toString('base64') },
  ] };
  return { before, plan, candidate, modern };
}

function assetFixture(t, app = 'operations') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-frontend-namespace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'new'); fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const files = { 'index.html': '<script src="/assets/new.js"></script>', 'assets/new.js': 'new bundle', 'favicon.svg': '<svg/>' };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(dir, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const sourceCommit = COMMIT;
  const expected = Object.entries(files).map(([name, body]) => ({ path: `/${name}`, size: Buffer.byteLength(body), sha256: hash(body) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const worker = app === 'operations' ? 'ledgetop-ops' : 'ledgetop-clients';
  const plan = { application: app, sourceCommit, release: { assets: { directory: dir } }, browserProof: { files: expected } };
  const oldFiles = new Map([['/index.html', Buffer.from('prior index')], ['/assets/old.js', Buffer.from('old bundle')],
    ['/assets/prior.css', Buffer.from('prior css')]]);
  const priorEntries = [...oldFiles].map(([assetPath, bytes]) => ({ path: assetPath, size: bytes.length, sha256: hash(bytes),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(bytes).slice(0, 32) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const previousLedger = mergeAssetLedger({ previous: null, current: { entries: priorEntries, payloads: oldFiles }, workerName: worker,
    accountId: ACCOUNT, sourceCommit, parentVersionId: BASELINE, observedAt: '2026-10-29T12:00:00.000Z' });
  return { plan, files, oldFiles, previousLedger };
}

test('candidate modules require exact pinned main bytes, map semantics, bindings, and routing config', t => {
  for (const app of ['operations', 'client']) {
    const f = runtimeFixture(t, app);
    assert.equal(verifyOrdinaryFrontendCandidateModules(f).candidateModulesVerified, true);
    const wrongMain = structuredClone(f); wrongMain.modern.modules[0].content_base64 = Buffer.from('wrong').toString('base64');
    assert.throws(() => verifyOrdinaryFrontendCandidateModules(wrongMain), /Candidate main bytes differ/);
    const wrongMap = structuredClone(f); wrongMap.modern.modules[1].content_base64 = Buffer.from(JSON.stringify({ version: 3, sources: ['x'], sourcesContent: ['wrong'], names: [], mappings: '' })).toString('base64');
    assert.throws(() => verifyOrdinaryFrontendCandidateModules(wrongMap), /source map differs/);
    const wrongBindings = structuredClone(f); wrongBindings.candidate.resources.bindings.pop();
    assert.throws(() => verifyOrdinaryFrontendCandidateModules(wrongBindings), /resources\/bindings\/exports differ/);
  }
});

test('large native module base64 decodes within the bounded module limit', t => {
  const largeMain = Buffer.alloc(2.2 * 1024 * 1024, 0x61);
  const largeMap = Buffer.from(JSON.stringify({ version: 3, sources: ['worker.ts'],
    sourcesContent: ['m'.repeat(4.2 * 1024 * 1024)], names: [], mappings: '' }));
  const f = runtimeFixture(t, 'client', largeMain, largeMap);
  const result = verifyOrdinaryFrontendCandidateModules(f);
  assert.equal(result.pinnedMainSHA256, hash(largeMain));
  assert.equal(result.pinnedSourceMapSHA256, hash(largeMap));
  assert.equal(decodeNativeModuleBytes(Buffer.from('ok').toString('base64')).toString(), 'ok');
  assert.throws(() => decodeNativeModuleBytes('!!!!'), /malformed, noncanonical, or oversized/);
  assert.throws(() => decodeNativeModuleBytes('AB=='), /malformed, noncanonical, or oversized/);
  assert.throws(() => decodeNativeModuleBytes('AAAAAA==', 3), /base64 size invalid/);
  assert.throws(() => decodeNativeModuleBytes('AAAA', MAX_NATIVE_MODULE_BYTES + 1), /byte limit invalid/);
});

test('top-level verifier refuses a forged ready flag on the offline plan', () => {
  assert.throws(() => verifyOrdinaryFrontendCandidate({ plan: { schemaVersion: 1, application: 'operations',
    offlineOnly: true, deploymentEnabled: false, nativeExecutionQualification: { ready: true } } }),
  /pinned offline ordinary frontend plan/);
});

test('top-level verifier requires the original pinned profile explicitly, not mutated plan.beforeProfile', () => {
  const plan = { schemaVersion: 1, application: 'operations', offlineOnly: true, deploymentEnabled: false,
    nativeExecutionQualification: { ready: false }, installationPreflight: {
      mode: ORDINARY_FRONTEND_PREFLIGHT_MODE, profileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    }, beforeProfile: { untrusted: 'dynamic plan profile' } };
  assert.throws(() => verifyOrdinaryFrontendCandidate({ before: {}, plan }), /Exact installed frontend profile v3/);
});

test('candidate and namespace evidence alone never qualifies the native executor or authority', () => {
  assert.deepEqual(ordinaryFrontendExecutionQualification({ ready: true }), {
    ready: false, reason: 'executor-and-authority-qualification-required', offlinePlanRemainsNonAuthorizing: true,
  });
  assert.deepEqual(ordinaryFrontendExecutionQualification({ ready: false, reason: 'active-namespace-byte-receipt-required' }), {
    ready: false, reason: 'active-namespace-byte-receipt-required', offlinePlanRemainsNonAuthorizing: true,
  });
});

test('asset gate holds without namespace evidence and verifies complete retained old/new byte union', t => {
 for (const app of ['operations', 'client']) {
  const f = assetFixture(t, app), now = Date.parse('2026-10-30T12:00:00.000Z');
  const worker = app === 'operations' ? 'ledgetop-ops' : 'ledgetop-clients';
  const held = verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE, baselineVersionId: BASELINE,
    previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles, now });
  assert.equal(held.assetNamespaceQualification.ready, false);
  assert.equal(held.assetNamespaceQualification.reason, 'active-namespace-byte-receipt-required');
  const union = held.retainedAssetLedger.assets.map(({ path: assetPath, size, sha256, mime }) => ({ path: assetPath, size, sha256, mime }));
  const bytesByPath = new Map(f.oldFiles);
  for (const [name, body] of Object.entries(f.files)) bytesByPath.set(`/${name}`, Buffer.from(body));
  const evidence = { receipt: { schemaVersion: 1, workerName: worker, accountId: ACCOUNT, sourceCommit: COMMIT,
    activeVersionId: CANDIDATE, observedAt: new Date(now).toISOString(), cutoverAt: new Date(now - 1000).toISOString(),
    earliestPermittedPruningAt: new Date(now + 48 * 60 * 60_000).toISOString(), minimumRetentionHours: 48,
    automaticPruning: false, oldServedWithin48hPaths: ['/assets/old.js', '/assets/prior.css'], assets: union }, bytesByPath };
  const qualified = verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE, baselineVersionId: BASELINE,
    previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles, namespaceEvidence: evidence, now });
  assert.equal(qualified.assetNamespaceQualification.ready, true);
  assert.equal(qualified.assetNamespaceQualification.assetCount, 5);
  assert.equal(qualified.assetNamespaceQualification.namespaceByteEvidenceVerified, true);
  assert.equal(qualified.assetNamespaceQualification.earliestPermittedPruningAt, evidence.receipt.earliestPermittedPruningAt);
  const shortRetention = structuredClone(evidence);
  shortRetention.receipt.earliestPermittedPruningAt = new Date(now + 47 * 60 * 60_000).toISOString();
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: shortRetention, now }), /shorter than 48 hours/);
  const missingBytes = { ...evidence, bytesByPath: new Map() };
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: missingBytes, now }), /every retained old\/new asset path/);
  const emptyOldPaths = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  emptyOldPaths.receipt.oldServedWithin48hPaths = [];
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: emptyOldPaths, now }), /omits, invents, or duplicates/);
  const omitOneOldPath = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  omitOneOldPath.receipt.oldServedWithin48hPaths = ['/assets/old.js'];
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: omitOneOldPath, now }), /omits, invents, or duplicates/);
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousAssetBytes: f.oldFiles, namespaceEvidence: evidence, now }), /active asset ledger is required/);
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles, now: Number.NaN }), /Verification clock invalid/);
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    now: 8_640_000_000_000_001 }), /Verification clock invalid/);
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    accountId: '00000000000000000000000000000000', now }), /Production account identity mismatch/);
  const badMime = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  badMime.receipt.assets.find(row => row.path === '/assets/old.js').mime = 'text/plain';
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: badMime, now }), /exact retained old\/new asset union/);
  const missingOldPath = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  missingOldPath.receipt.oldServedWithin48hPaths = ['/assets/unverified.js'];
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: missingOldPath, now }), /omits, invents, or duplicates previously retained browser asset paths/);
  const staleCutover = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  staleCutover.receipt.cutoverAt = '2026-10-30T11:54:59.000Z';
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: staleCutover, now }), /stale, mismatched, or shorter than 48 hours/);
  const invalidTime = { receipt: structuredClone(evidence.receipt), bytesByPath: evidence.bytesByPath };
  invalidTime.receipt.observedAt = 'not-a-time';
  assert.throws(() => verifyOrdinaryFrontendAssetNamespace({ plan: f.plan, candidateId: CANDIDATE,
    baselineVersionId: BASELINE, previousLedger: f.previousLedger, previousAssetBytes: f.oldFiles,
    namespaceEvidence: invalidTime, now }), /stale, mismatched, or shorter than 48 hours/);
 }
});
