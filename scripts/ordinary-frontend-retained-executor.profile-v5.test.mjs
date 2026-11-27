/** Canonical installed profile v5: the tracked file, its digest and exact v4 delta, plus offline
 * end-to-end retained executor runs for Operations and Client under the v5 preflight mode. Every
 * Worker, native, verifier, source and staff adapter is a local fake; no provider call is made. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, hash, canonical, validateInstallation, ordinaryFrontendPreflightDescriptor, readCanonicalInstalledProfileV5,
  CANONICAL_INSTALLED_PROFILE_V4_SHA256, CANONICAL_INSTALLED_PROFILE_V5_SHA256, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE, ORDINARY_FRONTEND_PREFLIGHT_MODE, ORDINARY_FRONTEND_PREFLIGHT_MODES,
  REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT } from './production-deploy.mjs';
import { compileOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { compileOrdinaryFrontendRetainedPlan } from './ordinary-frontend-retained-plan.mjs';
import { executeOrdinaryFrontendRetainedRelease, OPS_SOLE_ACTIVE_BASELINE_CONTRACT } from './ordinary-frontend-retained-executor.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_LOGIN_TABLES, POST0226_STAFF_PRESERVATION_CONTRACT, createPost0226StaffPreservationReview }
  from './ordinary-frontend-authority-post0226.mjs';
import { SYNTHETIC_IDS, syntheticCanonicalV4Installation } from './test-fixtures/ops-staff-directory-synthetic-installation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const clone = value => structuredClone(value);
const codepoint = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const STAFF_DIRECTORY = Object.freeze({ name: 'StaffDirectory', handlers: ['getPilotDeviceAuthority', 'isActiveStaff', 'resolvePilotUsername'] });
const V5 = ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE, V4 = ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE;
const SOURCE_COMMIT = '5'.repeat(40), EXECUTOR_COMMIT = '6'.repeat(40);
const WORKERS = { operations: 'ledgetop-ops', client: 'ledgetop-clients' };
const addStaffDirectory = script => {
  script.named_handlers = [...script.named_handlers, clone(STAFF_DIRECTORY)].sort((a, b) => a.name.localeCompare(b.name));
};

test('tracked v5 is exactly v4 plus the Ops StaffDirectory class and its label', () => {
  const v5 = readCanonicalInstalledProfileV5();
  assert.equal(hash(canonical(v5)), CANONICAL_INSTALLED_PROFILE_V5_SHA256);
  assert.equal(CANONICAL_INSTALLED_PROFILE_V5_SHA256, 'd24694b5f028b065e6416be179166f92b65874d3e4ac8f79677d904e9a6362b7');
  const v4 = JSON.parse(fs.readFileSync(path.join(HERE, 'test-fixtures/ordinary-frontend-accepted-profile-v4.test.json'), 'utf8'));
  assert.equal(hash(canonical(v4)), CANONICAL_INSTALLED_PROFILE_V4_SHA256);
  assert.equal(hash(canonical(PROFILE)), CANONICAL_INSTALLED_PROFILE_V4_SHA256, 'the tracked default profile stays v4');
  const expected = clone(v4);
  expected.profile = 'canonical-installed-v5-ops-staff-directory-offline';
  addStaffDirectory(expected.workers.operations.script);
  assert.deepEqual(v5, expected);
  assert.equal(canonical(v5), canonical(expected));
});

test('the v5 preflight mode admits only the reviewed v5 digest; v3 and v4 keep theirs', () => {
  const v5 = readCanonicalInstalledProfileV5();
  const v4 = JSON.parse(fs.readFileSync(path.join(HERE, 'test-fixtures/ordinary-frontend-accepted-profile-v4.test.json'), 'utf8'));
  assert.deepEqual([...ORDINARY_FRONTEND_PREFLIGHT_MODES], [ORDINARY_FRONTEND_PREFLIGHT_MODE, V4, V5]);
  assert.equal(REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES[V5], CANONICAL_INSTALLED_PROFILE_V5_SHA256);
  assert.equal(REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES[V4], CANONICAL_INSTALLED_PROFILE_V4_SHA256);
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(v5, V5), { mode: V5, profileSHA256: CANONICAL_INSTALLED_PROFILE_V5_SHA256 });
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(v4, V4), { mode: V4, profileSHA256: CANONICAL_INSTALLED_PROFILE_V4_SHA256 });
  assert.throws(() => ordinaryFrontendPreflightDescriptor(v4, V5), /Unreviewed ordinary frontend accepted profile/u);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(v5, V4), /Unreviewed ordinary frontend accepted profile/u);
  const drifted = clone(v5); drifted.workers.operations.script.named_handlers.find(row => row.name === 'StaffDirectory').handlers.push('listStaff');
  assert.throws(() => ordinaryFrontendPreflightDescriptor(drifted, V5), /Unreviewed ordinary frontend accepted profile/u);
});

/** Synthetic v5 installation: the synthetic v4 shape plus the same StaffDirectory delta, with the
 * Ops active version carrying the class (as the released Ops version does). */
function syntheticV5() {
  const { profile, snapshot } = syntheticCanonicalV4Installation();
  profile.profile = 'canonical-installed-v5-ops-staff-directory-offline';
  addStaffDirectory(profile.workers.operations.script);
  addStaffDirectory(snapshot.operations.version.resources.script);
  return { profile, snapshot, v4Profile: syntheticCanonicalV4Installation().profile,
    reviewedPreflightProfiles: Object.freeze({ [V5]: hash(canonical(profile)) }) };
}

test('installation checks pass under v5 with the class active and no StaffDirectory contract; v4 refuses it', () => {
  const { profile, snapshot, v4Profile, reviewedPreflightProfiles } = syntheticV5();
  for (const app of ['operations', 'client']) assert.equal(validateInstallation(snapshot, { profile, selectedApp: app,
    ordinaryFrontendPreflightMode: V5, ordinaryFrontendApp: app, reviewedPreflightProfiles }), snapshot, app);
  const v4Tables = Object.freeze({ [V4]: hash(canonical(v4Profile)) });
  assert.throws(() => validateInstallation(snapshot, { profile: v4Profile, selectedApp: 'client', ordinaryFrontendPreflightMode: V4,
    ordinaryFrontendApp: 'client', reviewedPreflightProfiles: v4Tables }), /operations: unrecognized exports/u);
  const extra = clone(snapshot); extra.operations.version.resources.script.named_handlers
    .find(row => row.name === 'StaffDirectory').handlers.push('listStaff');
  assert.throws(() => validateInstallation(extra, { profile, selectedApp: 'client', ordinaryFrontendPreflightMode: V5,
    ordinaryFrontendApp: 'client', reviewedPreflightProfiles }), /operations: unrecognized exports/u);
  assert.throws(() => validateInstallation(snapshot, { profile, selectedApp: 'operations', ordinaryFrontendPreflightMode: V5,
    ordinaryFrontendApp: 'operations', reviewedPreflightProfiles,
    opsStaffDirectoryEntrypointContract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT }), /StaffDirectory entrypoint contract is limited/u,
  'the StaffDirectory contract stays a v4-only exception');
});

function ownedTemp(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function artifact(t, app) {
  const root = ownedTemp(t, `profile-v5-${app}-`);
  const assets = path.join(root, 'assets'); fs.mkdirSync(path.join(assets, 'assets'), { recursive: true });
  const bundle = `assets/profile-v5-${app}.js`;
  const texts = { 'index.html': `<!doctype html><script type="module" src="/${bundle}"></script>`, [bundle]: `export const app = ${JSON.stringify(app)};` };
  for (const [name, body] of Object.entries(texts)) fs.writeFileSync(path.join(assets, name), body);
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const main = path.join(root, 'index.js'), map = `${main}.map`;
  fs.writeFileSync(main, `export default { fetch() { return new Response(${JSON.stringify(app)}); } };`);
  fs.writeFileSync(map, JSON.stringify({ version: 3, file: 'index.js', sources: [`${app}.ts`], sourcesContent: ['export {};'], names: [], mappings: '' }));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  const cli = path.join(root, 'synthetic-wrangler-cli.js'); fs.writeFileSync(cli, '// synthetic, never executed\n');
  const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  return { root, main, texts, cli, sourceRoot,
    release: { schemaVersion: 1, application: app, sourceCommit: SOURCE_COMMIT, frontendSHA256: hash(`${app}-synthetic-frontend`),
      main: pin(main), sourceMap: pin(map), assets: { directory: assets,
        files: Object.entries(texts).map(([name, body]) => ({ path: `/${name}`, size: Buffer.byteLength(body), sha256: hash(body) })).sort(codepoint) } } };
}
function priorLedger(before, app) {
  const bytes = new Map([['/index.html', Buffer.from(`old ${app} index`)], [`/assets/old-${app}.js`, Buffer.from(`old ${app} bundle`)]]);
  const entries = [...bytes].map(([assetPath, body]) => ({ path: assetPath, size: body.length, sha256: hash(body),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(body).slice(0, 32) })).sort(codepoint);
  const ledger = mergeAssetLedger({ previous: null, current: { entries, payloads: bytes }, workerName: WORKERS[app],
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, sourceCommit: 'c'.repeat(40), parentVersionId: before[app].version.id,
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  before[app].modern.modules.push({ name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: ledgerBytes(ledger).toString('base64') });
  return { ledger, bytes };
}
async function post0226Packet() {
  const capturedAt = Date.now(), rows = Object.fromEntries(Object.keys(POST0226_LOGIN_TABLES).map(table => [table,
    { count: table === 'staff_login_binding_control' ? 1 : 0, sha256: hash(`${table}-empty-synthetic-state`) }]));
  const tableCounts = Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(table => [table, 0]));
  tableCounts.staff_users = 1; tableCounts.staff_role_assignments = 1; tableCounts.native_staff_access_reconciliation = 1;
  const state = { schemaVersion: 1, contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit: SOURCE_COMMIT,
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    observedAt: new Date(capturedAt - 5_000).toISOString(), baseSnapshotSha256: 'a'.repeat(64), baseTableCounts: tableCounts,
    loginSchemaSha256: 'b'.repeat(64), loginRows: rows, loginRowsSha256: hash(canonical(rows)), bridgeMismatchCount: 1,
    nativeControlEnabled: 0, legacyActiveStaffCount: 1, preservationOnly: true, fullStaffCutoverReadiness: false,
    aliasLinkingAuthorized: false, schemaSha256: 'b'.repeat(64) };
  const review = await createPost0226StaffPreservationReview(state, { sourceCommit: SOURCE_COMMIT, now: capturedAt,
    reviewedAt: new Date(capturedAt).toISOString(), expiresAt: new Date(capturedAt + 15 * 60_000).toISOString() });
  return { review, observe: () => ({ ...clone(state), observedAt: new Date().toISOString() }) };
}

/** Ordinary release of `app` under v5 from the synthetic installation where Ops already carries StaffDirectory. */
async function run(t, app, { mutateCandidate = () => {}, extraOptions = {} } = {}) {
  const { profile, snapshot, reviewedPreflightProfiles } = syntheticV5();
  const a = artifact(t, app), mainBytes = fs.readFileSync(a.main), worker = WORKERS[app];
  const before = clone(snapshot);
  const { ledger: previousLedger, bytes: previousAssetBytes } = priorLedger(before, app);
  const seams = { reviewedPreflightProfiles };
  validateInstallation(before, { profile, selectedApp: app, ordinaryFrontendPreflightMode: V5, ordinaryFrontendApp: app, ...seams });
  const ordinaryPlan = compileOrdinaryFrontendReleasePlan(before, { app, release: a.release, profile, ordinaryFrontendPreflightMode: V5, ...seams });
  assert.deepEqual(ordinaryPlan.installationPreflight, { mode: V5, profileSHA256: hash(canonical(profile)) });
  assert.equal(Object.hasOwn(ordinaryPlan, 'opsStaffDirectoryEntrypointContract'), false);
  const plan = compileOrdinaryFrontendRetainedPlan(before, { ordinaryPlan, profile, previousLedger, previousAssetBytes,
    observedAt: new Date().toISOString(), ...seams });

  const candidateId = SYNTHETIC_IDS.candidate, baselineId = before[app].version.id;
  const candidateVersion = { ...clone(before[app].version), id: candidateId };
  candidateVersion.resources.script.etag = 'c'.repeat(64); candidateVersion.resources.script.last_deployed_from = 'wrangler';
  candidateVersion.resources.bindings = clone(ordinaryPlan.expectedBindings);
  mutateCandidate(candidateVersion);
  const candidateModern = { id: candidateId, assets: clone(before[app].modern.assets), modules: [
    { name: 'index.js', content_base64: mainBytes.toString('base64') },
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: plan.nativeAdditionalModule.contentBase64 }] };
  const candidateAssets = new Map(previousAssetBytes);
  for (const [name, body] of Object.entries(a.texts)) candidateAssets.set(`/${name}`, Buffer.from(body));
  if (plan.rootHtmlArchive) candidateAssets.set(plan.rootHtmlArchive.path, Buffer.from(previousAssetBytes.get(plan.rootHtmlArchive.sourcePath)));

  const active = clone(before), nativeCalls = [], verifiers = new Map();
  const reader = {
    async getCandidateVersion(workerName, versionId) {
      assert.equal(workerName, worker);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before[app].version);
      throw new Error('Unexpected candidate version GET');
    },
    async get(suffix) {
      const versionId = suffix.match(/versions\/([^?]+)/u)?.[1];
      if (suffix.includes('/workers/workers/')) return clone(versionId === candidateId ? candidateModern : before[app].modern);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before[app].version);
      throw new Error('Unexpected metadata GET');
    },
  };
  const assetVerifierProvider = {
    async createVerifier({ name, versionId }) { verifiers.set(name, versionId); },
    async fetchVerifierAsset({ name, path: assetPath, method }) {
      const versionId = verifiers.get(name), source = versionId === candidateId ? candidateAssets : previousAssetBytes;
      const entry = (versionId === candidateId ? plan.retentionLedger : previousLedger).assets.find(row => row.path === assetPath);
      const bytes = source.get(assetPath); assert.ok(Buffer.isBuffer(bytes) && entry);
      return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.size) } });
    },
    async removeVerifier(name) { verifiers.delete(name); },
    async verifierAbsent(name) { return !verifiers.has(name); },
  };
  const runNative = async (_cli, args, _journal, phase) => {
    nativeCalls.push(phase);
    if (phase === 'upload') {
      Object.assign(active[app], { latest: candidateId, latestVersion: clone(candidateVersion), latestModern: clone(candidateModern) });
      return `Worker Version ID: ${candidateId}`;
    }
    if (phase === 'namespace-stage') {
      active[app].deployment.versions = [{ version_id: baselineId, percentage: 100 }, { version_id: candidateId, percentage: 0 }];
      active[app].deployment.created_on = new Date().toISOString(); return 'staged';
    }
    if (phase === 'activate') {
      active[app].deployment.versions = [{ version_id: candidateId, percentage: 100 }];
      active[app].deployment.created_on = new Date(Date.now() - 20_000).toISOString();
      Object.assign(active[app], { version: clone(candidateVersion), modern: clone(candidateModern), latest: candidateId });
      delete active[app].latestVersion; delete active[app].latestModern; return 'activated';
    }
    throw new Error(`Unexpected native phase ${phase}`);
  };
  const staff = app === 'operations' ? await post0226Packet() : null;
  const options = { app, plan, profile, assetVerifierProvider,
    ...(staff ? { staffAuthorityContract: POST0226_STAFF_PRESERVATION_CONTRACT, post0226StaffPreservationReview: staff.review,
      readPost0226StaffPreservation: async () => staff.observe(), operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT } : {}),
    ...seams, wranglerRuntimeSHA256: hash(fs.readFileSync(a.cli)), reader, cli: a.cli,
    journalDirectory: path.join(a.root, 'journal'), artifactSourceRoot: a.sourceRoot, executorSourceRoot: path.resolve(a.root, '..'),
    sourceReader: root => path.resolve(root).toLowerCase() === path.resolve(a.sourceRoot).toLowerCase() ? SOURCE_COMMIT : EXECUTOR_COMMIT,
    captureFn: async () => clone(active), runNative, ...extraOptions };
  return { options, nativeCalls, active, candidateId, baselineId };
}

for (const app of ['operations', 'client']) test(`${app} ordinary release runs end to end under v5 with no StaffDirectory contract`, async t => {
  const h = await run(t, app);
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.candidateId, h.candidateId);
  assert.equal(result.rollbackVersionId, h.baselineId);
  assert.deepEqual(h.nativeCalls, ['upload', 'namespace-stage', 'activate']);
  assert.ok(h.active.operations.version.resources.script.named_handlers.some(row => row.name === 'StaffDirectory'));
});

test('under v5 an Ops candidate that changes StaffDirectory refuses after upload and before staging', async t => {
  const h = await run(t, 'operations', { mutateCandidate: version => {
    version.resources.script.named_handlers.find(row => row.name === 'StaffDirectory').handlers.push('listStaff');
  } });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /successor reader|named-handler|resources/u);
  assert.deepEqual(h.nativeCalls, ['upload']);
});

test('under v5 the StaffDirectory contract is refused before any write', async t => {
  const h = await run(t, 'operations', { extraOptions: { opsStaffDirectoryEntrypointContract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT } });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /StaffDirectory entrypoint contract|pinned in both release plans/u);
  assert.deepEqual(h.nativeCalls, []);
});
