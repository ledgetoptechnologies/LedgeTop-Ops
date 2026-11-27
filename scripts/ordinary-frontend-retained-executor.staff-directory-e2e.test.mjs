/** Offline end-to-end run of the retained executor for ops-staff-directory-entrypoint-v1.
 * Every Worker, native, verifier, source and staff adapter is a local fake; no Cloudflare,
 * Wrangler or provider call is made. The installation, StaffDirectory pins, accepted-profile
 * digest and Wrangler digest are synthetic and reach the executor only through its offline seams. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, canonical, OPS_STAFF_DIRECTORY_ENTRYPOINT, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT,
  ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, validateInstallation } from './production-deploy.mjs';
import { compileOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { compileOrdinaryFrontendRetainedPlan } from './ordinary-frontend-retained-plan.mjs';
import { executeOrdinaryFrontendRetainedRelease, OPS_SOLE_ACTIVE_BASELINE_CONTRACT } from './ordinary-frontend-retained-executor.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_LOGIN_TABLES, POST0226_STAFF_PRESERVATION_CONTRACT, createPost0226StaffPreservationReview }
  from './ordinary-frontend-authority-post0226.mjs';
import { SYNTHETIC_IDS, syntheticCanonicalV4Installation } from './test-fixtures/ops-staff-directory-synthetic-installation.mjs';

const clone = value => structuredClone(value);
const codepoint = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const HANDLERS = ['getPilotDeviceAuthority', 'isActiveStaff', 'resolvePilotUsername'];
const SOURCE_COMMIT = '3'.repeat(40), EXECUTOR_COMMIT = '4'.repeat(40);
const WORKER = 'ledgetop-ops';

function ownedTemp(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifact(t) {
  const root = ownedTemp(t, 'ops-staff-directory-e2e-');
  const assets = path.join(root, 'assets'); fs.mkdirSync(path.join(assets, 'assets'), { recursive: true });
  const bundle = 'assets/staff-directory-e2e.js';
  const texts = { 'index.html': `<!doctype html><script type="module" src="/${bundle}"></script>`, [bundle]: 'export const ops = true;' };
  for (const [name, body] of Object.entries(texts)) fs.writeFileSync(path.join(assets, name), body);
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const main = path.join(root, 'index.js'), map = `${main}.map`;
  fs.writeFileSync(main, 'export default { fetch() { return new Response("ops"); } }; export class StaffDirectory {}');
  fs.writeFileSync(map, JSON.stringify({ version: 3, file: 'index.js', sources: ['ops.ts'], sourcesContent: ['export const ops = true;'], names: [], mappings: '' }));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  const cli = path.join(root, 'synthetic-wrangler-cli.js'); fs.writeFileSync(cli, '// synthetic, never executed\n');
  const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  return { root, main, texts, cli, sourceRoot,
    release: { schemaVersion: 1, application: 'operations', sourceCommit: SOURCE_COMMIT, frontendSHA256: hash('ops-synthetic-frontend'),
      main: pin(main), sourceMap: pin(map), assets: { directory: assets,
        files: Object.entries(texts).map(([name, body]) => ({ path: `/${name}`, size: Buffer.byteLength(body), sha256: hash(body) })).sort(codepoint) } } };
}

/** Embed a prior retained ledger in the synthetic Ops baseline, as an installed retained release would. */
function priorLedger(before) {
  const bytes = new Map([['/index.html', Buffer.from('old ops index')], ['/assets/old-ops.js', Buffer.from('old ops bundle')]]);
  const entries = [...bytes].map(([assetPath, body]) => ({ path: assetPath, size: body.length, sha256: hash(body),
    mime: assetPath.endsWith('.html') ? 'text/html' : 'text/javascript', providerHash: hash(body).slice(0, 32) })).sort(codepoint);
  const ledger = mergeAssetLedger({ previous: null, current: { entries, payloads: bytes }, workerName: WORKER,
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, sourceCommit: 'c'.repeat(40), parentVersionId: before.operations.version.id,
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  before.operations.modern.modules.push({ name: '__ops_release_ledger.json', content_type: 'text/plain',
    content_base64: ledgerBytes(ledger).toString('base64') });
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

const withStaffDirectory = (version, id) => {
  const value = { ...clone(version), id };
  value.resources.script.etag = 'c'.repeat(64);
  value.resources.script.last_deployed_from = 'wrangler';
  value.resources.script.named_handlers.push({ name: 'StaffDirectory', handlers: [...HANDLERS] });
  return value;
};

/** Ops baseline (b61e28eb-like) active alone at 100%, the held StaffDirectory upload as inactive latest,
 * a fresh compile under the contract, and the retained executor driven through every phase. */
async function run(t, { mutateCandidate = () => {} } = {}) {
  const { profile, snapshot, reviewedPreflightProfiles } = syntheticCanonicalV4Installation();
  const a = artifact(t), mainBytes = fs.readFileSync(a.main);
  const pins = Object.freeze({ ...OPS_STAFF_DIRECTORY_ENTRYPOINT, sourceCommit: SOURCE_COMMIT,
    mainSHA256: a.release.main.sha256, sourceMapSHA256: a.release.sourceMap.sha256,
    baselineVersionId: SYNTHETIC_IDS.operations, heldCandidateId: SYNTHETIC_IDS.held });
  const before = clone(snapshot);
  const { ledger: previousLedger, bytes: previousAssetBytes } = priorLedger(before);
  // The refused earlier upload: native, baseline + exactly StaffDirectory, pinned main bytes.
  Object.assign(before.operations, { latest: SYNTHETIC_IDS.held,
    latestVersion: withStaffDirectory(before.operations.version, SYNTHETIC_IDS.held),
    latestModern: { id: SYNTHETIC_IDS.held, assets: clone(before.operations.modern.assets),
      modules: [{ name: 'index.js', content_base64: mainBytes.toString('base64') }] } });

  const seams = { opsStaffDirectoryPins: pins, reviewedPreflightProfiles };
  const contract = { opsStaffDirectoryEntrypointContract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT };
  // Compile path the driver uses: capture check, release plan, retained plan.
  validateInstallation(before, { profile, selectedApp: 'operations', ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations', ...contract, ...seams });
  const ordinaryPlan = compileOrdinaryFrontendReleasePlan(before, { app: 'operations', release: a.release, profile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ...contract, ...seams });
  assert.equal(ordinaryPlan.opsStaffDirectoryEntrypointContract, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT);
  assert.equal(Object.hasOwn(ordinaryPlan, 'opsStaffDirectoryPins') || Object.hasOwn(ordinaryPlan, 'reviewedPreflightProfiles'), false);
  const plan = compileOrdinaryFrontendRetainedPlan(before, { ordinaryPlan, profile, previousLedger, previousAssetBytes,
    observedAt: new Date().toISOString(), ...contract, ...seams });

  const candidateId = SYNTHETIC_IDS.candidate, baselineId = SYNTHETIC_IDS.operations;
  const candidateVersion = withStaffDirectory(before.operations.version, candidateId);
  candidateVersion.resources.bindings = clone(ordinaryPlan.expectedBindings);
  mutateCandidate(candidateVersion);
  const candidateModern = { id: candidateId, assets: clone(before.operations.modern.assets), modules: [
    { name: 'index.js', content_base64: mainBytes.toString('base64') },
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: plan.nativeAdditionalModule.contentBase64 }] };
  const candidateAssets = new Map(previousAssetBytes);
  for (const [name, body] of Object.entries(a.texts)) candidateAssets.set(`/${name}`, Buffer.from(body));
  if (plan.rootHtmlArchive) candidateAssets.set(plan.rootHtmlArchive.path, Buffer.from(previousAssetBytes.get(plan.rootHtmlArchive.sourcePath)));

  const active = clone(before), nativeCalls = [], verifiers = new Map(), latestAtCapture = [];
  const reader = {
    async getCandidateVersion(workerName, versionId) {
      assert.equal(workerName, WORKER);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before.operations.version);
      throw new Error('Unexpected candidate version GET');
    },
    async get(suffix) {
      const versionId = suffix.match(/versions\/([^?]+)/u)?.[1];
      if (suffix.includes('/workers/workers/')) return clone(versionId === candidateId ? candidateModern : before.operations.modern);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(before.operations.version);
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
  const captureFn = async () => { latestAtCapture.push(active.operations.latest); return clone(active); };
  const runNative = async (_cli, args, _journal, phase) => {
    nativeCalls.push({ phase, args: [...args] });
    if (phase === 'upload') {
      Object.assign(active.operations, { latest: candidateId, latestVersion: clone(candidateVersion), latestModern: clone(candidateModern) });
      return `Worker Version ID: ${candidateId}`;
    }
    if (phase === 'namespace-stage') {
      active.operations.deployment.versions = [{ version_id: baselineId, percentage: 100 }, { version_id: candidateId, percentage: 0 }];
      active.operations.deployment.created_on = new Date().toISOString(); return 'staged';
    }
    if (phase === 'activate') {
      active.operations.deployment.versions = [{ version_id: candidateId, percentage: 100 }];
      active.operations.deployment.created_on = new Date(Date.now() - 20_000).toISOString();
      Object.assign(active.operations, { version: clone(candidateVersion), modern: clone(candidateModern), latest: candidateId });
      delete active.operations.latestVersion; delete active.operations.latestModern; return 'activated';
    }
    throw new Error(`Unexpected native phase ${phase}`);
  };
  const staff = await post0226Packet();
  const options = { app: 'operations', plan, profile, assetVerifierProvider,
    staffAuthorityContract: POST0226_STAFF_PRESERVATION_CONTRACT, post0226StaffPreservationReview: staff.review,
    readPost0226StaffPreservation: async () => staff.observe(),
    operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT, ...contract, ...seams,
    wranglerRuntimeSHA256: hash(fs.readFileSync(a.cli)), reader, cli: a.cli,
    journalDirectory: path.join(a.root, 'journal'), artifactSourceRoot: a.sourceRoot, executorSourceRoot: path.resolve(a.root, '..'),
    sourceReader: root => path.resolve(root).toLowerCase() === path.resolve(a.sourceRoot).toLowerCase() ? SOURCE_COMMIT : EXECUTOR_COMMIT,
    captureFn, runNative };
  return { options, nativeCalls, latestAtCapture, candidateId, active, plan, verifiers, journal: options.journalDirectory, pins };
}

test('fresh StaffDirectory Ops release runs end to end over the held inactive latest without throwing', async t => {
  const h = await run(t);
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.uploaded, true);
  assert.equal(result.candidateId, h.candidateId); assert.equal(result.rollbackVersionId, SYNTHETIC_IDS.operations);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
  assert.ok(h.latestAtCapture.includes(SYNTHETIC_IDS.held), 'pre-upload captures saw the held latest');
  assert.equal(h.latestAtCapture.at(-1), h.candidateId, 'after upload the new candidate is latest as usual');
  assert.equal(h.verifiers.size, 0);
  const inactive = JSON.parse(fs.readFileSync(path.join(h.journal, 'verified-inactive-candidate.private.json'), 'utf8'));
  assert.equal(inactive.namedHandlerProof.contract, OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT);
  assert.deepEqual(inactive.namedHandlerProof.addedHandlers, HANDLERS);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.journal, 'verified-active.private.json'), 'utf8')).candidateId, h.candidateId);
});

test('a candidate with an extra StaffDirectory method refuses after upload and before staging or activation', async t => {
  const h = await run(t, { mutateCandidate: version => {
    version.resources.script.named_handlers.find(row => row.name === 'StaffDirectory').handlers.push('listStaff');
  } });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /StaffDirectory handlers differ from the exact reviewed three/u);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload']);
  assert.equal(h.active.operations.version.id, SYNTHETIC_IDS.operations, 'baseline stays active');
});

test('without the contract the same fresh release refuses before any write', async t => {
  const h = await run(t);
  const { opsStaffDirectoryEntrypointContract: _omit, ...options } = h.options;
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(options), /pinned in both release plans/u);
  assert.deepEqual(h.nativeCalls, []);
});

test('the production StaffDirectory pins never admit the synthetic installation', async t => {
  const h = await run(t);
  const { opsStaffDirectoryPins: _omit, ...options } = h.options;
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(options), /StaffDirectory entrypoint contract requires/u);
  assert.deepEqual(h.nativeCalls, []);
});

test('offline seams default to the reviewed production values', async () => {
  const { REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256, CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendPreflightDescriptor, ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
    CANONICAL_INSTALLED_PROFILE_V5_SHA256 } = await import('./production-deploy.mjs');
  assert.ok(Object.isFrozen(REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES));
  assert.deepEqual({ ...REVIEWED_ORDINARY_FRONTEND_PREFLIGHT_PROFILES }, {
    [ORDINARY_FRONTEND_PREFLIGHT_MODE]: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
    [ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE]: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    [ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE]: CANONICAL_INSTALLED_PROFILE_V5_SHA256 });
  const { profile, snapshot, reviewedPreflightProfiles } = syntheticCanonicalV4Installation();
  assert.throws(() => ordinaryFrontendPreflightDescriptor(profile, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE),
    /Unreviewed ordinary frontend accepted profile/u, 'the synthetic profile is never a reviewed production profile');
  assert.throws(() => validateInstallation(snapshot, { profile, selectedApp: 'operations',
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ordinaryFrontendApp: 'operations' }),
  /Unreviewed ordinary frontend accepted profile/u);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(profile, ORDINARY_FRONTEND_PREFLIGHT_MODE, reviewedPreflightProfiles),
    /Unreviewed ordinary frontend preflight mode/u, 'a seam table only covers the modes it names');
  assert.equal(ordinaryFrontendPreflightDescriptor(profile, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, reviewedPreflightProfiles).mode,
    ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE);
});
