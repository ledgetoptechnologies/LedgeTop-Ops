/** Private, opt-in state-machine rehearsal. The sanitized control fixture and
 * Ops packet bytes stay outside Git. All native/provider adapters below are
 * synthetic; this test is not production namespace or staff-consent evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, canonical, validateInstallation, ORDINARY_FRONTEND_PREFLIGHT_MODE } from './production-deploy.mjs';
import { compileOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { compileOrdinaryFrontendRetainedPlan } from './ordinary-frontend-retained-plan.mjs';
import { executeOrdinaryFrontendRetainedRelease } from './ordinary-frontend-retained-executor.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { prepareOpsLegacyLedgerBootstrap, completeOpsLegacyLedgerBootstrap } from './ordinary-frontend-ops-ledger-bootstrap.mjs';

const fixturePath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_PRIVATE_FIXTURE;
const opsBytePathsPath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_BYTE_PATHS;
const opsAssetRoot = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_ASSET_ROOT
  ?? 'C:/Users/fstor/.codex/artifacts/ui-retained-packets-b0c99cdd-20261028-v3/operations-packet/assets';
const HEX40 = /^[a-f0-9]{40}$/u;
const FIXED_OPS_WEIGHTS = [
  { versionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e', percentage: 0 },
  { versionId: 'a45943f4-e5c5-4142-9057-fb9adb5cf739', percentage: 100 },
];
const clone = value => structuredClone(value);
const codepoint = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const appWorker = app => app === 'operations' ? 'ledgetop-ops' : 'ledgetop-clients';
const moduleMap = bytes => ({ name: 'index.js.map', content_base64: bytes.toString('base64') });

function assetFiles(t, app) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `retained-executor-${app}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets'); fs.mkdirSync(path.join(assets, 'assets'), { recursive: true });
  const bundlePath = `assets/executor-${app}-${process.pid}-${Date.now()}.js`;
  const texts = { 'index.html': `<!doctype html><script type="module" src="/${bundlePath}"></script>`,
    [bundlePath]: `export const surface=${JSON.stringify(app)};` };
  for (const [name, body] of Object.entries(texts)) fs.writeFileSync(path.join(assets, name), body);
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const main = path.join(root, 'index.js'), map = `${main}.map`;
  fs.writeFileSync(main, `export default {fetch(){return new Response(${JSON.stringify(app)})}};`);
  const mapValue = { version: 3, file: 'index.js', sources: [`${app}.ts`], sourcesContent: [`export const ${app}=true;`], names: [], mappings: '' };
  fs.writeFileSync(map, JSON.stringify(mapValue));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  return { root, assets, main, map, mapValue, texts,
    release: { schemaVersion: 1, application: app, sourceCommit: null, frontendSHA256: hash(`${app}-synthetic-frontend`),
      main: pin(main), sourceMap: pin(map), assets: { directory: assets,
      files: Object.entries(texts).map(([name, body]) => ({ path: `/${name}`, size: Buffer.byteLength(body), sha256: hash(body) }))
        .sort(codepoint) } } };
}

function syntheticClientPrior(before, app) {
  const workerName = appWorker(app), accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const bytes = new Map([['/index.html', Buffer.from('old client index')], ['/assets/old-client.js', Buffer.from('old client bundle')]]);
  const entries = [...bytes].map(([assetPath, body]) => ({ path: assetPath, size: body.length, sha256: hash(body),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(body).slice(0, 32) })).sort(codepoint);
  const sourceCommit = 'c'.repeat(40), parentVersionId = before[app].version.id;
  const ledger = mergeAssetLedger({ previous: null, current: { entries, payloads: bytes }, workerName, accountId,
    sourceCommit, parentVersionId, observedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  before[app].modern.modules = before[app].modern.modules.filter(row => row.name !== '__ops_release_ledger.json');
  before[app].modern.modules.push({ name: '__ops_release_ledger.json', content_type: 'text/plain',
    content_base64: ledgerBytes(ledger).toString('base64') });
  return { ledger, bytes };
}

function loadOpsPriorAssets(context) {
  assert.ok(opsBytePathsPath && fs.existsSync(opsBytePathsPath), 'Ops private byte-path sidecar must be supplied for the full happy path');
  const sidecar = JSON.parse(fs.readFileSync(opsBytePathsPath, 'utf8'));
  assert.equal(sidecar.schemaVersion, 1);
  assert.equal(sidecar.packetSHA256, 'fec34761336801fe672132c07b9d219f0325185de245a28e2713b1b7ebd9e0ae');
  const rows = sidecar.rows;
  assert.ok(Array.isArray(rows) && rows.length === context.previousAssetRows.length);
  assert.equal(sidecar.totalBytes, context.previousAssetRows.reduce((sum, row) => sum + row.size, 0));
  const root = fs.realpathSync(opsAssetRoot), result = new Map();
  const sorted = [...rows].sort(codepoint);
  assert.deepEqual(sorted.map(({ path, size, sha256, mime }) => ({ path, size, sha256, mime })), context.previousAssetRows);
  for (const row of sorted) {
    const file = path.resolve(row.file), real = fs.realpathSync(file);
    assert.ok(real.startsWith(`${root}${path.sep}`) && !fs.lstatSync(real).isSymbolicLink());
    const stat = fs.statSync(real), bytes = fs.readFileSync(real);
    assert.equal(stat.nlink, 1); assert.equal(bytes.length, row.size); assert.equal(hash(bytes), row.sha256);
    result.set(row.path, bytes);
  }
  return result;
}

function staffReadiness(sourceCommit) {
  return { schemaVersion: 2, sourceCommit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId, reviewSha256: '1'.repeat(64), cohortSha256: '2'.repeat(64),
    controlPlaneSha256: '3'.repeat(64), observedAt: new Date().toISOString(), staffCount: 1, generation: 1 };
}

function harness(t, fixture, app, { failCandidateAssets = false, failStaff = false } = {}) {
  const before = clone(fixture.snapshot), artifact = assetFiles(t, app), sourceCommit = fixture.artifactSourceCommit;
  assert.ok(HEX40.test(sourceCommit)); artifact.release.sourceCommit = sourceCommit;
  const operationsExpected = { operations: clone(FIXED_OPS_WEIGHTS) };
  const expectedDeploymentVersions = operationsExpected;
  let previousLedger, previousAssetBytes, ordinaryPlan, retainedPlan;
  if (failStaff && app === 'operations') {
    ordinaryPlan = { application: app, sourceCommit, expectedDeploymentVersions, baselineSHA256: hash(canonical(before)) };
    retainedPlan = { schemaVersion: 2, contract: 'ordinary-frontend-retained-native-module-v2', sourceCommit,
      ordinaryPlan, retentionLedger: { observedAt: new Date().toISOString() } };
    previousAssetBytes = new Map();
  } else if (app === 'operations') {
    const context = prepareOpsLegacyLedgerBootstrap(before);
    assert.ok(context && context.previousAssetRows.length === 471);
    previousAssetBytes = loadOpsPriorAssets(context);
    previousLedger = completeOpsLegacyLedgerBootstrap(context, { verifiedAssets: previousAssetBytes, verifiedVersionId: context.activeVersionId });
  } else ({ ledger: previousLedger, bytes: previousAssetBytes } = syntheticClientPrior(before, app));
  if (!(failStaff && app === 'operations')) {
    ordinaryPlan = compileOrdinaryFrontendReleasePlan(before, { app, release: artifact.release, profile: fixture.profile,
      expectedDeploymentVersions, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE });
    retainedPlan = compileOrdinaryFrontendRetainedPlan(before, { ordinaryPlan, profile: fixture.profile,
      previousLedger, previousAssetBytes, observedAt: new Date().toISOString() });
  }
  const targetWorker = appWorker(app), baselineId = before[app].version.id;
  const candidateId = app === 'operations' ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888';
  const candidateVersion = { ...clone(before[app].version), id: candidateId };
  candidateVersion.resources.script.last_deployed_from = 'wrangler';
  const candidateModern = { id: candidateId, assets: clone(before[app].modern.assets), modules: [
    { name: 'index.js', content_base64: fs.readFileSync(artifact.main).toString('base64') },
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: retainedPlan.nativeAdditionalModule?.contentBase64 ?? '' },
  ] };
  const candidateAssets = new Map(previousAssetBytes);
  for (const [name, body] of Object.entries(artifact.texts)) candidateAssets.set(`/${name}`, Buffer.from(body));
  const active = clone(before), nativeCalls = [], providerEvents = [], staffPhases = [], verifierVersions = new Map();
  const reader = {
    async getCandidateVersion(workerName, versionId) {
      assert.equal(workerName, targetWorker);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before[app].version);
      throw new Error('Unexpected candidate version GET');
    },
    async get(suffix) {
      const versionId = suffix.match(/versions\/([^?]+)/)?.[1];
      if (suffix.includes('/workers/workers/')) return clone(versionId === candidateId ? candidateModern : before[app].modern);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before[app].version);
      throw new Error('Unexpected metadata GET');
    },
  };
  const assetVerifierProvider = {
    async createVerifier({ name, versionId }) { providerEvents.push(['create', versionId]); verifierVersions.set(name, versionId); },
    async fetchVerifierAsset({ name, path: assetPath, method }) {
      const versionId = verifierVersions.get(name), source = versionId === candidateId ? candidateAssets : previousAssetBytes;
      if (failCandidateAssets && versionId === candidateId) throw new Error('synthetic candidate asset failure');
      const bytes = source.get(assetPath), entry = (versionId === candidateId ? retainedPlan.retentionLedger : previousLedger).assets.find(row => row.path === assetPath);
      assert.ok(Buffer.isBuffer(bytes) && entry);
      return new Response(method === 'HEAD' ? null : bytes, { status: 200,
        headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.size) } });
    },
    async removeVerifier(name) { providerEvents.push(['remove', verifierVersions.get(name)]); verifierVersions.delete(name); },
    async verifierAbsent(name) { return !verifierVersions.has(name); },
  };
  const captureFn = async () => clone(active);
  const runNative = async (cli, args, journal, phase) => {
    nativeCalls.push({ phase, args: [...args] });
    if (phase === 'upload') {
      active[app].latest = candidateId; active[app].latestVersion = clone(candidateVersion); active[app].latestModern = clone(candidateModern);
      return `Worker Version ID: ${candidateId}`;
    }
    if (phase === 'namespace-stage') {
      active[app].deployment.versions = [{ version_id: baselineId, percentage: 100 }, { version_id: candidateId, percentage: 0 }];
      active[app].deployment.created_on = new Date().toISOString(); return 'staged';
    }
    if (phase === 'activate') {
      active[app].deployment.versions = [{ version_id: candidateId, percentage: 100 }];
      active[app].deployment.created_on = new Date(Date.now() - 20_000).toISOString().replace(/\.(\d{3})Z$/u, (_all, ms) => `.${ms}601424Z`);
      active[app].version = clone(candidateVersion); active[app].modern = clone(candidateModern); active[app].latest = candidateId;
      delete active[app].latestVersion; delete active[app].latestModern; return 'activated';
    }
    throw new Error('Unexpected native phase');
  };
  const journalDirectory = path.join(artifact.root, 'journal');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const executorSourceRoot = root;
  const sourceReader = sourceRoot => path.resolve(sourceRoot).toLowerCase() === path.resolve(fixture.artifactSourceRoot).toLowerCase()
    ? fixture.artifactSourceCommit : fixture.executorSourceCommit;
  const options = { app, plan: retainedPlan, profile: fixture.profile, expectedDeploymentVersions,
    assetVerifierProvider, staffCutoverReview: { synthetic: true }, reader, cli: fixture.cliPath,
    journalDirectory, artifactSourceRoot: fixture.artifactSourceRoot, executorSourceRoot, sourceReader,
    captureFn, runNative, now: () => Date.now(),
    readStaffCutover: async () => { staffPhases.push(staffPhases.length + 1); if (failStaff) throw new Error('synthetic held staff readiness'); return staffReadiness(sourceCommit); } };
  return { options, before, active, ordinaryPlan, retainedPlan, previousLedger, previousAssetBytes,
    candidateAssets, candidateId, nativeCalls, providerEvents, staffPhases, journalDirectory };
}

test('private sanitized fixture: full Client state machine preserves exact Ops 0/100 weights', { skip: !fixturePath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = harness(t, fixture, 'client');
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.candidateModulesVerified, true);
  assert.equal(result.nativeExecutionQualification.ready, false);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
  assert.deepEqual(h.nativeCalls[1].args.slice(2, 4), [`${h.before.client.version.id}@100%`, `${h.candidateId}@0%`]);
  for (const phase of h.nativeCalls) assert.deepEqual(h.active.operations.deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage }))
    .sort((a, b) => a.versionId.localeCompare(b.versionId)), [...FIXED_OPS_WEIGHTS].sort((a, b) => a.versionId.localeCompare(b.versionId)));
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
  assert.equal(h.nativeCalls.some(row => row.phase === 'rollback'), false);
});

test('private sanitized fixture: full Ops state machine qualifies staff around every mutation and handles fractional cutover', { skip: !fixturePath || !opsBytePathsPath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = harness(t, fixture, 'operations');
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.nativeExecutionQualification.ready, false);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
  assert.deepEqual(h.nativeCalls[1].args.slice(2, 4), [`${h.before.operations.version.id}@100%`, `${h.candidateId}@0%`]);
  assert.equal(h.nativeCalls[1].args.some(arg => arg === `${FIXED_OPS_WEIGHTS[0].versionId}@0%`), false,
    'only the pinned old zero-percent row is deliberately dropped during exact namespace staging');
  assert.equal(h.staffPhases.length >= 5, true);
  const activeReceipt = JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active.private.json'), 'utf8'));
  assert.equal(activeReceipt.providerCutoverAt.endsWith('601424Z'), true);
  assert.equal(activeReceipt.cutoverAt.endsWith('Z') && activeReceipt.cutoverAt.length === 24, true);
  assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.cutoverAt) + 48 * 60 * 60_000);
  assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.namespaceObservedAt) + 48 * 60 * 60_000);
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
});

test('private sanitized fixture: ambiguous Client asset failure after one upload and namespace stage does not activate or retry', { skip: !fixturePath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = harness(t, fixture, 'client', { failCandidateAssets: true });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /static_asset_verification_refused/);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage']);
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 2);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 2);
  const journal = fs.readFileSync(path.join(h.journalDirectory, 'journal.jsonl'), 'utf8');
  assert.equal(journal.includes('native-version-upload'), true);
  assert.equal(journal.includes('native-candidate-namespace-stage'), true);
  assert.equal(journal.includes('native-version-activate'), false);
});

test('private sanitized fixture: Ops staff hold stops before baseline verifier writes and upload', { skip: !fixturePath || !opsBytePathsPath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = harness(t, fixture, 'operations', { failStaff: true });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /synthetic held staff readiness/);
  assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.providerEvents, []);
  assert.equal(fs.existsSync(h.journalDirectory), false);
});
