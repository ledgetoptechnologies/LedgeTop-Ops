import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from './production-deploy.mjs';
import { PROFILE } from './production-deploy.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { retainedNativeConfig, stageOrdinaryFrontendRetainedModules,
  verifyOrdinaryFrontendRetainedCandidateModules } from './ordinary-frontend-retained-plan.mjs';
import { readInstalledRetainedAssetLedger, readOrdinaryFrontendNamespaceAssets } from './ordinary-frontend-retained-executor.mjs';

const BASELINE = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const COMMIT = '8e8554667c7de62cf3be44b5a650697c10f7c9bf';
const ACCOUNT = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
const MAP = Buffer.from(JSON.stringify({ version: 3, sources: ['worker.ts'], sourcesContent: ['source'], names: [], mappings: '' }));

function testPlan(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-retained-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'index.js'), map = `${main}.map`, assets = path.join(root, 'assets');
  fs.mkdirSync(assets); fs.writeFileSync(main, 'export default {fetch(){return new Response("ok")}};'); fs.writeFileSync(map, MAP);
  for (const [name, text] of Object.entries({ 'index.html': '<script src="/app.js"></script>', 'app.js': 'current', 'favicon.svg': '<svg/>' })) fs.writeFileSync(path.join(assets, name), text);
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const mainBytes = fs.readFileSync(main), mapBytes = fs.readFileSync(map);
  const resources = { script: { handlers: ['fetch'], named_handlers: [], last_deployed_from: 'wrangler' },
    script_runtime: { compatibility_date: '2026-07-22' }, bindings: [{ name: 'ASSETS', type: 'assets' }] };
  const before = { operations: { version: { id: BASELINE, resources }, modern: { id: BASELINE,
    assets: { config: { base_path: '/', html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: [] } } } } };
  const sourceCommit = COMMIT, workerName = 'ledgetop-ops';
  const old = new Map([['/index.html', Buffer.from('old index')], ['/assets/previous.js', Buffer.from('old bundle')]]);
  const oldEntries = [...old].map(([assetPath, bytes]) => ({ path: assetPath, size: bytes.length, sha256: hash(bytes),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(bytes).slice(0, 32) }));
  oldEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const previousLedger = mergeAssetLedger({ previous: null, current: { entries: oldEntries, payloads: old }, workerName,
    accountId: ACCOUNT, sourceCommit, parentVersionId: BASELINE, observedAt: '2026-10-29T12:00:00.000Z' });
  const currentEntries = Object.entries({ 'index.html': '<script src="/app.js"></script>', 'app.js': 'current', 'favicon.svg': '<svg/>' })
    .map(([name, text]) => ({ path: `/${name}`, size: Buffer.byteLength(text), sha256: hash(text), mime: name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'image/svg+xml', providerHash: hash(text).slice(0, 32) }));
  currentEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const all = new Map(old); for (const [name, text] of Object.entries({ 'index.html': '<script src="/app.js"></script>', 'app.js': 'current', 'favicon.svg': '<svg/>' })) all.set(`/${name}`, Buffer.from(text));
  const retentionLedger = mergeAssetLedger({ previous: previousLedger, current: { entries: currentEntries, payloads: all }, workerName,
    accountId: ACCOUNT, sourceCommit, parentVersionId: BASELINE, observedAt: '2026-10-30T12:00:00.000Z' });
  const bytes = ledgerBytes(retentionLedger);
  const ordinaryPlan = { schemaVersion: 1, application: 'operations', sourceCommit, offlineOnly: true, deploymentEnabled: false,
    release: { main: { path: main, size: mainBytes.length, sha256: hash(mainBytes) }, sourceMap: { path: map, size: mapBytes.length, sha256: hash(mapBytes) }, assets: { directory: assets } },
    config: { main, find_additional_modules: false, rules: [], assets: { directory: assets, binding: 'ASSETS' } },
    expectedBindings: resources.bindings, expectedAssetsConfiguration: before.operations.modern.assets,
  };
  const plan = { schemaVersion: 2, contract: 'ordinary-frontend-retained-native-module-v2', application: 'operations', workerName, accountId: ACCOUNT,
    sourceCommit, parentVersionId: BASELINE, ordinaryPlan, ordinaryPlanSHA256: 'a'.repeat(64), retentionLedger,
    retentionLedgerSHA256: hash(bytes), nativeAdditionalModule: { name: '__ops_release_ledger.json', type: 'Text', mime: 'text/plain',
      size: bytes.length, sha256: hash(bytes), contentBase64: bytes.toString('base64') },
    additionalModuleRule: { type: 'Text', globs: ['__ops_release_ledger.json'], fallthrough: false } };
  return { root, mainBytes, mapBytes, before, ordinaryPlan, plan, bytes };
}

test('Wrangler v2 config narrowly discovers only the pinned retained ledger module', t => {
  const f = testPlan(t), staged = stageOrdinaryFrontendRetainedModules(f.plan, path.join(f.root, 'stage'));
  const config = retainedNativeConfig(f.plan, staged);
  assert.equal(config.main, staged.main); assert.equal(config.find_additional_modules, true);
  assert.equal(config.base_dir, staged.directory); assert.equal(config.assets.directory, f.ordinaryPlan.release.assets.directory);
  assert.deepEqual(config.rules, [{ type: 'Text', globs: ['__ops_release_ledger.json'], fallthrough: false }]);
  assert.deepEqual(fs.readdirSync(staged.directory).sort(), ['__ops_release_ledger.json', 'index.js', 'index.js.map']);
  assert.deepEqual(fs.readFileSync(staged.ledger), f.bytes);
});

test('retained candidate verifier accepts exact runtime pair plus canonical ledger and rejects drift', t => {
  const f = testPlan(t), candidate = { id: CANDIDATE, resources: structuredClone(f.before.operations.version.resources) };
  const modern = { id: CANDIDATE, assets: structuredClone(f.ordinaryPlan.expectedAssetsConfiguration), modules: [
    { name: 'index.js', content_base64: f.mainBytes.toString('base64') },
    { name: 'index.js.map', content_base64: f.mapBytes.toString('base64') },
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: f.bytes.toString('base64') },
  ] };
  const proof = verifyOrdinaryFrontendRetainedCandidateModules({ before: f.before, plan: f.plan, candidate, modern });
  assert.equal(proof.candidateModulesVerified, true); assert.equal(proof.retainedLedgerModuleVerified, true);
  assert.equal(proof.retainedLedgerSHA256, hash(f.bytes));
  const changed = structuredClone(modern); changed.modules[2].content_base64 = Buffer.from('{"schemaVersion":1}').toString('base64');
  assert.throws(() => verifyOrdinaryFrontendRetainedCandidateModules({ before: f.before, plan: f.plan, candidate, modern: changed }), /bytes or MIME differ/);
  const extra = structuredClone(modern); extra.modules.push({ name: 'extra.txt', content_base64: 'eA==' });
  assert.throws(() => verifyOrdinaryFrontendRetainedCandidateModules({ before: f.before, plan: f.plan, candidate, modern: extra }), /three-module/);
});

test('active namespace reader pins exact public origins, special index routes, and all old/new bytes', async () => {
  const indexBytes = Buffer.from('<h1>ok</h1>'), bundleBytes = Buffer.from('export {}');
  const rows = [
    { path: '/index.html', size: indexBytes.length, sha256: hash(indexBytes), mime: 'text/html' },
    { path: '/assets/a.js', size: bundleBytes.length, sha256: hash(bundleBytes), mime: 'text/javascript' },
  ];
  const calls = [], bodies = new Map([['/portal', indexBytes], ['/assets/a.js', bundleBytes]]);
  const verified = await readOrdinaryFrontendNamespaceAssets({ workerName: 'ledgetop-clients', origin: 'https://portal.ledgetop.app', entries: rows,
    fetchImpl: async (url, init) => {
      calls.push([new URL(url).pathname, init.method]); const bytes = bodies.get(new URL(url).pathname);
      return new Response(init.method === 'HEAD' ? null : bytes, { status: 200, headers: { 'Content-Type': rows.find(row => row.path === (new URL(url).pathname === '/portal' ? '/index.html' : new URL(url).pathname)).mime } });
    } });
  assert.deepEqual(calls, [['/portal', 'HEAD'], ['/portal', 'GET'], ['/assets/a.js', 'HEAD'], ['/assets/a.js', 'GET']]);
  assert.deepEqual(verified, new Map([['/index.html', indexBytes], ['/assets/a.js', bundleBytes]]));
  await assert.rejects(readOrdinaryFrontendNamespaceAssets({ workerName: 'ledgetop-clients', origin: 'https://unreviewed.example', entries: rows,
    fetchImpl: async () => { throw Error('must not be called'); } }), /Namespace inventory/);
});

test('installed ledger is bound to active version bytes while preserving its historical parent lineage', t => {
  const f = testPlan(t), bytes = f.bytes, encoded = bytes.toString('base64');
  const installed = structuredClone(f.plan.retentionLedger);
  assert.equal(installed.parentVersionId, BASELINE);
  const snapshot = { operations: { version: { id: CANDIDATE }, modern: { id: CANDIDATE,
    modules: [{ name: '__ops_release_ledger.json', content_base64: encoded }] },
    deployment: { versions: [{ version_id: CANDIDATE, percentage: 100 }] } } };
  assert.deepEqual(readInstalledRetainedAssetLedger(snapshot, { app: 'operations', workerName: 'ledgetop-ops' }), installed);
  const absent = structuredClone(snapshot); absent.operations.modern.modules = [];
  assert.throws(() => readInstalledRetainedAssetLedger(absent, { app: 'operations', workerName: 'ledgetop-ops' }), /Previously installed retained ledger is required/);
  const changed = structuredClone(snapshot); changed.operations.modern.modules[0].content_base64 = Buffer.from(' ').toString('base64');
  assert.throws(() => readInstalledRetainedAssetLedger(changed, { app: 'operations', workerName: 'ledgetop-ops' }), /canonical|encoding|JSON/);
  const wrongVersion = structuredClone(snapshot); wrongVersion.operations.modern.id = BASELINE;
  assert.throws(() => readInstalledRetainedAssetLedger(wrongVersion, { app: 'operations', workerName: 'ledgetop-ops' }), /captured production version/);
});

test('executor refuses before capture or native mutation unless the original accepted profile is supplied', async () => {
  const calls = { source: 0, capture: 0, native: 0 };
  const { executeOrdinaryFrontendRetainedRelease } = await import('./ordinary-frontend-retained-executor.mjs');
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ app: 'client', plan: { schemaVersion: 2,
    contract: 'ordinary-frontend-retained-native-module-v2', ordinaryPlan: { application: 'client' } }, profile: PROFILE,
    reader: {}, cli: 'C:/unused/wrangler.js', journalDirectory: path.join(os.tmpdir(), 'held-no-profile'),
    sourceReader: () => { calls.source++; return COMMIT; }, captureFn: async () => { calls.capture++; return {}; },
    runNative: async () => { calls.native++; return 'Worker Version ID: 22222222-2222-4222-8222-222222222222'; } }),
  /Original exact installed profile v3 is required/);
  assert.deepEqual(calls, { source: 0, capture: 0, native: 0 });
});
