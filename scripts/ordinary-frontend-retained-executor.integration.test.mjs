/** Private, opt-in state-machine rehearsal. The sanitized control fixture and
 * Ops packet bytes stay outside Git. All native/provider adapters below are
 * synthetic; this test is not production namespace or staff-consent evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, canonical, validateInstallation, ordinaryFrontendPreflightDescriptor, ORDINARY_FRONTEND_PREFLIGHT_MODE,
  OPS_SUCCESSOR_READER_INSTALLED_CONTRACT, OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } from './production-deploy.mjs';
import { compileOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { compileOrdinaryFrontendRetainedPlan } from './ordinary-frontend-retained-plan.mjs';
import { compileCanonicalBrowserRetirementTransition } from './ordinary-frontend-canonical-browser-retirement.mjs';
import { compileCanonicalInstalledProfileV4, validateCanonicalInstalledProfileV4 } from './canonical-installed-profile-v4.mjs';
import { executeOrdinaryFrontendRetainedRelease, validateProductionAuthorityPacketSelection } from './ordinary-frontend-retained-executor.mjs';
import { mergeAssetLedger, ledgerBytes } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { prepareOpsLegacyLedgerBootstrap, completeOpsLegacyLedgerBootstrap } from './ordinary-frontend-ops-ledger-bootstrap.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_CONTRACT } from './ordinary-frontend-authority.mjs';
import { ORDINARY_FRONTEND_AUTHORITY_TABLES } from './ordinary-frontend-authority-reader.mjs';
import { POST0226_LOGIN_TABLES, POST0226_STAFF_PRESERVATION_CONTRACT, createPost0226StaffPreservationReview }
  from './ordinary-frontend-authority-post0226.mjs';

const fixturePath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_PRIVATE_FIXTURE;
const opsBytePathsPath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_BYTE_PATHS;
const opsSuccessorSnapshotPath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_SUCCESSOR_SNAPSHOT;
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

test('production authority selection requires one Operations packet and zero Client packets', () => {
  assert.equal(validateProductionAuthorityPacketSelection({ app:'client' }), true);
  assert.throws(() => validateProductionAuthorityPacketSelection({ app:'client', review:{ synthetic:true } }), /Client release cannot select/u);
  assert.throws(() => validateProductionAuthorityPacketSelection({ app:'operations' }), /exactly one/u);
  assert.throws(() => validateProductionAuthorityPacketSelection({ app:'operations', review:{ synthetic:true }, post0226Review:{ synthetic:true } }), /exactly one/u);
  assert.equal(validateProductionAuthorityPacketSelection({ app:'operations', post0226Review:{ synthetic:true } }), true);
});
const moduleMap = bytes => ({ name: 'index.js.map', content_base64: bytes.toString('base64') });

function assetFiles(t, app) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `retained-executor-${app}-`));
  const ownedRoot = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
  assert.ok(ownedRoot.startsWith(`${tempRoot}${path.sep}`)
    && path.basename(ownedRoot).startsWith(`retained-executor-${app}-`));
  t.after(() => {
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot !== ownedRoot || !resolvedRoot.startsWith(`${tempRoot}${path.sep}`)
      || !path.basename(resolvedRoot).startsWith(`retained-executor-${app}-`))
      throw new Error('Synthetic retained executor temporary root changed; refusing recursive cleanup');
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });
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

function syntheticCanonicalClientPredecessor(snapshot, profile, versionId) {
  const before = clone(snapshot);
  const transition = compileCanonicalBrowserRetirementTransition(snapshot, { app:'client', profile });
  for (const [name, value] of Object.entries(transition.targetScalars)) for (const bindings of [
    before.client.version.resources.bindings, before.client.settings.bindings,
  ]) bindings.find(row => row.name === name).text = value;
  before.client.version.id = versionId;
  before.client.modern.id = versionId;
  before.client.latest = versionId;
  delete before.client.latestVersion; delete before.client.latestModern;
  before.client.deployment.versions = before.client.deployment.versions.map(row => ({ ...row, version_id:versionId }));
  return before;
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

function syntheticFrontendAuthority(sourceCommit) {
  const tables = Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(name => [name, []]));
  tables.staff_users = [{ id: 'staff:legacy', email: 'legacy@example.test', display_name: 'Legacy', access_subject: null, status: 'active' }];
  tables.staff_role_assignments = [{ id: 'assignment:legacy', staff_id: 'staff:legacy', role_id: 'role-owner',
    scope: 'global', division_id: null, scope_key: 'global', created_by: 'staff:legacy', created_at: '2026-10-01 00:00:00' }];
  tables.native_staff_access_reconciliation = [{ singleton: 1, enabled: 0, generation: 0, applied_generation: 0,
    lease_id: null, lease_until: null, attempt_generation: null, attempts: 0, last_attempt_at: null,
    last_success_at: null, last_error: null }];
  const snapshot = { schemaSha256: 'b'.repeat(64), bridgeMismatchCount: 1,
    nativeStaffCohort: [{ staffId: 'staff:legacy', email: 'legacy@example.test', accessSubject: null, displayName: 'Legacy',
      legacyStatus: 'active', bridgeStatus: 'not_admitted', nativeActive: null, admissionVersion: null, profileVersion: null }],
    controlPlane: [], nativeControlCandidates: [], tables };
  const reviewedAt = Date.now();
  const review = { schemaVersion: 1, contract: ORDINARY_FRONTEND_AUTHORITY_CONTRACT, application: 'operations',
    sourceCommit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId, databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    reviewedAt: new Date(reviewedAt).toISOString(), expiresAt: new Date(reviewedAt + 15 * 60_000).toISOString(),
    snapshotObservedAt: new Date(reviewedAt - 5_000).toISOString(), snapshotSha256: hash(canonical(snapshot)), snapshot };
  return { review, observation: () => ({ schemaVersion: 1, accountId: review.accountId, databaseId: review.databaseId,
    observedAt: new Date().toISOString(), snapshot: clone(snapshot) }) };
}

async function syntheticPost0226StaffPreservation(sourceCommit) {
  const capturedAt = Date.now(), rows = Object.fromEntries(Object.keys(POST0226_LOGIN_TABLES).map(table => [table,
    { count:table === 'staff_login_binding_control' ? 1 : 0, sha256:hash(`${table}-empty-synthetic-state`) }]));
  const tableCounts = Object.fromEntries(Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES).map(table => [table, 0]));
  tableCounts.staff_users = 1; tableCounts.staff_role_assignments = 1; tableCounts.native_staff_access_reconciliation = 1;
  const state = { schemaVersion:1, contract:POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit,
    accountId:NATIVE_STAFF_PRODUCTION_TARGET.accountId, databaseId:NATIVE_STAFF_PRODUCTION_TARGET.databaseId,
    observedAt:new Date(capturedAt-5_000).toISOString(), baseSnapshotSha256:'a'.repeat(64), baseTableCounts:tableCounts,
    loginSchemaSha256:'b'.repeat(64), loginRows:rows, loginRowsSha256:hash(canonical(rows)), bridgeMismatchCount:1,
    nativeControlEnabled:0, legacyActiveStaffCount:1, preservationOnly:true, fullStaffCutoverReadiness:false,
    aliasLinkingAuthorized:false, schemaSha256:'b'.repeat(64) };
  const review = await createPost0226StaffPreservationReview(state, { sourceCommit, now:capturedAt,
    reviewedAt:new Date(capturedAt).toISOString(), expiresAt:new Date(capturedAt+15*60_000).toISOString() });
  return { review, observation:() => ({ ...clone(state), observedAt:new Date().toISOString() }) };
}

async function harness(t, fixture, app, { failCandidateAssets = false, failStaff = false,
  frontendAuthority = false, driftFrontendAuthorityAt = 0, post0226Authority = false, driftPost0226At = 0,
  opsSuccessorPromotion = false, canonicalBrowserRetirement = false, canonicalBrowserRetirementClientVersionId,
  canonicalClientDrift, snapshotOverride, candidateId: candidateIdOverride } = {}) {
  const before = clone(snapshotOverride ?? fixture.snapshot), artifact = assetFiles(t, app), sourceCommit = fixture.artifactSourceCommit;
  assert.ok(HEX40.test(sourceCommit)); artifact.release.sourceCommit = sourceCommit;
  const expectedDeploymentVersions = opsSuccessorPromotion || canonicalBrowserRetirement
    ? undefined : { operations: clone(FIXED_OPS_WEIGHTS) };
  let previousLedger, previousAssetBytes, ordinaryPlan, retainedPlan;
  if (failStaff && app === 'operations') {
    ordinaryPlan = { application: app, sourceCommit, expectedDeploymentVersions, baselineSHA256: hash(canonical(before)),
      installationPreflight: ordinaryFrontendPreflightDescriptor(fixture.profile, ORDINARY_FRONTEND_PREFLIGHT_MODE) };
    retainedPlan = { schemaVersion: 2, contract: 'ordinary-frontend-retained-native-module-v2', sourceCommit,
      ordinaryPlan, retentionLedger: { observedAt: new Date().toISOString() } };
    previousAssetBytes = new Map();
  } else if (app === 'operations' && opsSuccessorPromotion) {
    ({ ledger: previousLedger, bytes: previousAssetBytes } = syntheticClientPrior(before, app));
  } else if (app === 'operations') {
    const context = prepareOpsLegacyLedgerBootstrap(before);
    assert.ok(context && context.previousAssetRows.length === 471);
    previousAssetBytes = loadOpsPriorAssets(context);
    previousLedger = completeOpsLegacyLedgerBootstrap(context, { verifiedAssets: previousAssetBytes, verifiedVersionId: context.activeVersionId });
  } else ({ ledger: previousLedger, bytes: previousAssetBytes } = syntheticClientPrior(before, app));
  if (!(failStaff && app === 'operations')) {
    ordinaryPlan = compileOrdinaryFrontendReleasePlan(before, { app, release: artifact.release, profile: fixture.profile,
      expectedDeploymentVersions, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
      ...(opsSuccessorPromotion ? { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } : {}),
      ...(canonicalBrowserRetirement ? { canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1',
        ...(app === 'client' ? { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }
          : { canonicalBrowserRetirementClientVersionId }) } : {}) });
    retainedPlan = compileOrdinaryFrontendRetainedPlan(before, { ordinaryPlan, profile: fixture.profile,
      previousLedger, previousAssetBytes, observedAt: new Date().toISOString(),
      ...(opsSuccessorPromotion ? { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } : {}),
      ...(canonicalBrowserRetirement ? { canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1',
        ...(app === 'client' ? { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }
          : { canonicalBrowserRetirementClientVersionId }) } : {}) });
  }
  const targetWorker = appWorker(app), baselineId = before[app].version.id;
  const candidateId = candidateIdOverride ?? (app === 'operations' ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888');
  const candidateVersion = { ...clone(before[app].version), id: candidateId };
  candidateVersion.resources.bindings = clone(ordinaryPlan.expectedBindings ?? candidateVersion.resources.bindings);
  candidateVersion.resources.script.last_deployed_from = 'wrangler';
  const candidateModern = { id: candidateId, assets: clone(before[app].modern.assets), modules: [
    { name: 'index.js', content_base64: fs.readFileSync(artifact.main).toString('base64') },
    { name: '__ops_release_ledger.json', content_type: 'text/plain', content_base64: retainedPlan.nativeAdditionalModule?.contentBase64 ?? '' },
  ] };
  const candidateAssets = new Map(previousAssetBytes);
  for (const [name, body] of Object.entries(artifact.texts)) candidateAssets.set(`/${name}`, Buffer.from(body));
  if (retainedPlan.rootHtmlArchive) {
    const archivedRoot = previousAssetBytes.get(retainedPlan.rootHtmlArchive.sourcePath);
    assert.ok(Buffer.isBuffer(archivedRoot));
    candidateAssets.set(retainedPlan.rootHtmlArchive.path, Buffer.from(archivedRoot));
  }
  const active = clone(before), nativeCalls = [], providerEvents = [], staffPhases = [], verifierVersions = new Map(), controlObservations = [];
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
  const captureFn = async () => {
    const state = clone(active), latestCandidate = state[app].latestVersion;
    if (canonicalBrowserRetirement) {
      const names = Object.keys(ordinaryPlan.canonicalBrowserRetirementTransition.targetScalars);
      const scalars = rows => Object.fromEntries(names.map(name => [name, rows.find(row => row.name === name)?.text]));
      controlObservations.push({ phase: nativeCalls.at(-1)?.phase ?? 'before-upload',
        activeVersionId: state[app].version.id, activeScalars: scalars(state[app].version.resources.bindings),
        settingsScalars: scalars(state[app].settings.bindings), latestVersionId: latestCandidate?.id ?? null,
        latestScalars: latestCandidate ? scalars(latestCandidate.resources.bindings) : null,
        ...(app === 'operations' ? { clientRetirement: {
          versionId:state.client.version.id, modernId:state.client.modern.id, latest:state.client.latest,
          deploymentVersions:clone(state.client.deployment.versions),
          versionScalars:Object.fromEntries(Object.keys(ordinaryPlan.canonicalBrowserRetirementTransition.clientRetirement.targetScalars)
            .map(name => [name,state.client.version.resources.bindings.find(row => row.name === name)?.text])),
          settingsScalars:Object.fromEntries(Object.keys(ordinaryPlan.canonicalBrowserRetirementTransition.clientRetirement.targetScalars)
            .map(name => [name,state.client.settings.bindings.find(row => row.name === name)?.text])),
          publicShare:state.client.settings.bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN')?.text,
        } } : {}) });
    }
    return state;
  };
  const runNative = async (cli, args, journal, phase) => {
    nativeCalls.push({ phase, args: [...args] });
    if (phase === 'upload') {
      active[app].latest = candidateId; active[app].latestVersion = clone(candidateVersion); active[app].latestModern = clone(candidateModern);
      if (canonicalBrowserRetirement) for (const [name, value] of Object.entries(ordinaryPlan.canonicalBrowserRetirementTransition.targetScalars)) {
        const row = active[app].settings.bindings.find(binding => binding.name === name); assert.ok(row); row.text = value;
      }
      if (canonicalClientDrift === 'version') {
        const changed = '99999999-9999-4999-8999-999999999999';
        active.client.version.id = changed; active.client.modern.id = changed; active.client.latest = changed;
        active.client.deployment.versions = active.client.deployment.versions.map(row => ({ ...row, version_id:changed }));
      } else if (canonicalClientDrift === 'target') {
        for (const bindings of [active.client.version.resources.bindings, active.client.settings.bindings])
          bindings.find(row => row.name === 'CLIENT_PORTAL_ORIGINS').text = 'https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com';
      } else if (canonicalClientDrift === 'unrelated') {
        for (const bindings of [active.client.version.resources.bindings, active.client.settings.bindings])
          bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text = 'https://drift.invalid';
      }
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
  const frontendPacket = frontendAuthority ? syntheticFrontendAuthority(sourceCommit) : null;
  const post0226Packet = post0226Authority ? await syntheticPost0226StaffPreservation(sourceCommit) : null;
  const post0226AuthorityPhases = [], post0226ReaderCalls = [];
  const frontendAuthorityPhases = [], options = { app, plan: retainedPlan, profile: fixture.profile, expectedDeploymentVersions,
    ...(opsSuccessorPromotion ? { opsSuccessorReaderPromotionContract: OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT } : {}),
    ...(canonicalBrowserRetirement ? { canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1',
      ...(app === 'client' ? { installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT }
        : { canonicalBrowserRetirementClientVersionId }) } : {}),
    assetVerifierProvider, ...(post0226Authority ? { staffAuthorityContract:POST0226_STAFF_PRESERVATION_CONTRACT,
      post0226StaffPreservationReview:post0226Packet.review } : frontendAuthority
      ? { staffAuthorityContract: ORDINARY_FRONTEND_AUTHORITY_CONTRACT, frontendAuthorityReview: frontendPacket.review }
      : { staffCutoverReview: { synthetic: true } }), reader, cli: fixture.cliPath,
    journalDirectory, artifactSourceRoot: fixture.artifactSourceRoot, executorSourceRoot, sourceReader,
    captureFn, runNative, now: () => Date.now(),
    readFrontendAuthority: async () => {
      frontendAuthorityPhases.push(frontendAuthorityPhases.length + 1);
      const observation = frontendPacket?.observation();
      if (driftFrontendAuthorityAt === frontendAuthorityPhases.length) observation.snapshot.tables.staff_role_assignments.push({
        id: 'assignment:unexpected', staff_id: 'staff:legacy', role_id: 'role-admin', scope: 'global',
        division_id: null, scope_key: 'global', created_by: 'staff:legacy', created_at: '2026-10-30 00:00:00' });
      return observation;
    },
    readPost0226StaffPreservation: async args => {
      post0226ReaderCalls.push(clone(args));
      post0226AuthorityPhases.push(post0226AuthorityPhases.length + 1);
      const observation = post0226Packet?.observation();
      if (driftPost0226At === post0226AuthorityPhases.length) {
        observation.baseSnapshotSha256 = 'c'.repeat(64);
        observation.baseTableCounts.roles += 1;
        observation.loginRowsSha256 = 'd'.repeat(64);
        observation.nativeControlEnabled = 1;
      }
      return observation;
    },
    readStaffCutover: async () => { staffPhases.push(staffPhases.length + 1); if (failStaff) throw new Error('synthetic held staff readiness'); return staffReadiness(sourceCommit); } };
  return { options, before, active, ordinaryPlan, retainedPlan, previousLedger, previousAssetBytes,
    candidateAssets, candidateId, nativeCalls, providerEvents, staffPhases, frontendAuthorityPhases, post0226AuthorityPhases,
    post0226ReaderCalls, journalDirectory, controlObservations };
}

test('private sanitized fixture: full Client state machine preserves exact Ops 0/100 weights', { skip: !fixturePath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = await harness(t, fixture, 'client');
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.candidateModulesVerified, true);
  assert.equal(result.nativeExecutionQualification.ready, false);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
  assert.deepEqual(h.nativeCalls[1].args.slice(2, 4), [`${h.before.client.version.id}@100%`, `${h.candidateId}@0%`]);
  for (const phase of h.nativeCalls) assert.deepEqual(h.active.operations.deployment.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage }))
    .sort((a, b) => a.versionId.localeCompare(b.versionId)), [...FIXED_OPS_WEIGHTS].sort((a, b) => a.versionId.localeCompare(b.versionId)));
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
  const archive = h.retainedPlan.rootHtmlArchive;
  assert.ok(archive && archive.path.startsWith('/_ui/client/'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-candidate-root-html-archive.private.json'), 'utf8')),
    { candidateId: h.candidateId, path: archive.path, transportPath: archive.transportPath, size: archive.size,
      sha256: archive.sha256, mime: archive.mime, verified: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active-root-html-archive.private.json'), 'utf8')),
    { candidateId: h.candidateId, path: archive.path, transportPath: archive.transportPath, size: archive.size,
      sha256: archive.sha256, mime: archive.mime, verified: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active.private.json'), 'utf8')).rootHtmlArchive.path, archive.path);
  assert.equal(h.nativeCalls.some(row => row.phase === 'rollback'), false);
});

test('private sanitized fixture: canonical Client retirement keeps old active version while settings and inactive candidate use the full canonical tuple',
  { skip: !fixturePath || !opsSuccessorSnapshotPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const currentOps = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    const h = await harness(t, fixture, 'client', { canonicalBrowserRetirement: true, snapshotOverride: currentOps });
    const transition = h.ordinaryPlan.canonicalBrowserRetirementTransition;
    assert.equal(transition.selector, 'canonical-browser-retirement-v1');
    assert.equal(h.before.operations.version.id, 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68');
    assert.deepEqual(h.before.operations.deployment.versions, [
      { version_id: 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68', percentage: 100 },
    ]);
    assert.deepEqual(transition.changes.CLIENT_PORTAL_ORIGINS, 'https://portal.ledgetop.app');
    assert.equal(h.retainedPlan.parentVersionId, h.before.client.version.id);
    const source = transition.sourceScalars, target = transition.targetScalars;
    const result = await executeOrdinaryFrontendRetainedRelease(h.options);
    assert.equal(result.activated, true);
    assert.equal(result.candidateModulesVerified, true);
    assert.equal(result.rollbackVersionId, h.before.client.version.id);
    assert.deepEqual(h.before.client.version.resources.bindings.find(row => row.name === 'CLIENT_PORTAL_ORIGINS').text,
      source.CLIENT_PORTAL_ORIGINS, 'pinned rollback version remains the exact predecessor');
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
    const splitCaptures = h.controlObservations.filter(row => ['upload', 'namespace-stage'].includes(row.phase));
    assert.equal(splitCaptures.length, 3, 'inactive, staged, and preactivation controls were captured');
    for (const capture of splitCaptures) {
      assert.equal(capture.activeVersionId, h.before.client.version.id);
      assert.deepEqual(capture.activeScalars, source, 'active Worker version keeps every predecessor scalar before activation');
      assert.deepEqual(capture.settingsScalars, target, 'Worker settings expose the exact complete target during staging');
      assert.deepEqual(capture.latestScalars, target, 'inactive candidate exposes the exact complete target tuple');
      assert.equal(capture.latestVersionId, h.candidateId);
    }
    const activeCaptures = h.controlObservations.filter(row => row.phase === 'activate');
    assert.equal(activeCaptures.length, 2, 'postactivation and namespace verification controls were captured');
    for (const capture of activeCaptures) {
      assert.equal(capture.activeVersionId, h.candidateId);
      assert.deepEqual(capture.activeScalars, target);
      assert.deepEqual(capture.settingsScalars, target);
    }
  });

test('private worker-control fixture: canonical Ops retirement preserves exact preceding Client version, tuple, settings split, and rollback',
  { skip: !fixturePath || !opsSuccessorSnapshotPath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const currentOps = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    const clientVersionId = '33333333-3333-4333-8333-333333333333';
    const afterClient = syntheticCanonicalClientPredecessor(currentOps, fixture.profile, clientVersionId);
    const h = await harness(t, fixture, 'operations', { canonicalBrowserRetirement:true, opsSuccessorPromotion:true,
      canonicalBrowserRetirementClientVersionId:clientVersionId, snapshotOverride:afterClient, post0226Authority:true });
    const transition = h.ordinaryPlan.canonicalBrowserRetirementTransition;
    assert.equal(transition.clientRetirement.versionId, clientVersionId);
    assert.equal(h.ordinaryPlan.opsSuccessorReaderPromotionContract, OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT);
    assert.deepEqual(h.before.operations.deployment.versions, [
      { version_id:'fc9bc572-0b87-4857-8b8a-b0e0f7582c68', percentage:100 },
    ]);
    const source = transition.sourceScalars, target = transition.targetScalars;
    const result = await executeOrdinaryFrontendRetainedRelease(h.options);
    assert.equal(result.activated, true);
    assert.equal(result.rollbackVersionId, h.before.operations.version.id);
    assert.equal(result.activeNamespaceBytesVerified, true);
    assert.equal(h.post0226AuthorityPhases.length, 8);
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage','activate']);
    const splitCaptures = h.controlObservations.filter(row => ['upload','namespace-stage'].includes(row.phase));
    assert.equal(splitCaptures.length, 3, 'inactive, staged, and preactivation checkpoints are all observed');
    for (const capture of splitCaptures) {
      assert.equal(capture.activeVersionId, h.before.operations.version.id);
      assert.deepEqual(capture.activeScalars, source, 'active Ops version keeps the predecessor scalar until activation');
      assert.deepEqual(capture.settingsScalars, target, 'Ops settings use the exact canonical scalar before activation');
      assert.deepEqual(capture.latestScalars, target, 'inactive Ops candidate uses the exact canonical scalar');
      assert.equal(capture.latestVersionId, h.candidateId);
      assert.equal(capture.clientRetirement.versionId, clientVersionId);
      assert.equal(capture.clientRetirement.modernId, clientVersionId);
      assert.equal(capture.clientRetirement.latest, clientVersionId);
      assert.deepEqual(capture.clientRetirement.deploymentVersions, [{ version_id:clientVersionId, percentage:100 }]);
      assert.deepEqual(capture.clientRetirement.versionScalars, transition.clientRetirement.targetScalars);
      assert.deepEqual(capture.clientRetirement.settingsScalars, transition.clientRetirement.targetScalars);
      assert.equal(capture.clientRetirement.publicShare,
        h.before.client.settings.bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text);
    }
    const activeCaptures = h.controlObservations.filter(row => row.phase === 'activate');
    assert.equal(activeCaptures.length, 2, 'postactivation and postnamespace checkpoints are observed');
    for (const capture of activeCaptures) {
      assert.equal(capture.activeVersionId, h.candidateId);
      assert.deepEqual(capture.activeScalars, target);
      assert.deepEqual(capture.settingsScalars, target);
      assert.equal(capture.clientRetirement.versionId, clientVersionId);
      assert.deepEqual(capture.clientRetirement.versionScalars, transition.clientRetirement.targetScalars);
      assert.deepEqual(capture.clientRetirement.settingsScalars, transition.clientRetirement.targetScalars);
    }
    assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
    assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
    const activeReceipt = JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active.private.json'), 'utf8'));
    assert.equal(activeReceipt.rollbackVersionId, h.before.operations.version.id);
    assert.equal(activeReceipt.assetCount, h.retainedPlan.retentionLedger.assets.length);
    assert.deepEqual(activeReceipt.oldServedWithin48hPaths, h.previousLedger.assets
      .filter(row => row.path !== '/index.html').map(row => row.path).sort());
    assert.equal(activeReceipt.automaticPruning, false);
    assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.cutoverAt) + 48 * 60 * 60_000);
    assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.namespaceObservedAt) + 48 * 60 * 60_000);
  });

test('private canonical transition receipts compile an offline-only installed v4 profile and reject final-capture drift',
  { skip: !fixturePath || !opsSuccessorSnapshotPath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const currentOps = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    const clientCandidateId = '33333333-3333-4333-8333-333333333333';
    const client = await harness(t, fixture, 'client', { canonicalBrowserRetirement:true,
      candidateId:clientCandidateId, snapshotOverride:currentOps });
    await executeOrdinaryFrontendRetainedRelease(client.options);
    const operations = await harness(t, fixture, 'operations', { canonicalBrowserRetirement:true,
      opsSuccessorPromotion:true, canonicalBrowserRetirementClientVersionId:clientCandidateId,
      snapshotOverride:client.active, post0226Authority:true });
    await executeOrdinaryFrontendRetainedRelease(operations.options);
    const readReceipt = h => JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active.private.json'), 'utf8'));
    const finalObservedAt = new Date().toISOString();
    const args = { predecessorProfile:fixture.profile, expectedSourceCommit:fixture.artifactSourceCommit,
      client:{ predecessor:client.before,
        retainedPlan:client.retainedPlan, receipt:readReceipt(client), previousLedger:client.previousLedger,
        previousAssetBytes:client.previousAssetBytes, observedAt:client.retainedPlan.retentionLedger.observedAt },
      operations:{ predecessor:operations.before,
        retainedPlan:operations.retainedPlan, receipt:readReceipt(operations), previousLedger:operations.previousLedger,
        previousAssetBytes:operations.previousAssetBytes, observedAt:operations.retainedPlan.retentionLedger.observedAt },
      finalCaptureEvidence:{ snapshot:operations.active, observedAt:finalObservedAt,
        sha256:hash(canonical(operations.active)) }, now:Date.now() };
    const compiled = compileCanonicalInstalledProfileV4(args);
    assert.equal(compiled.provenance.offlineOnly, true);
    assert.equal(compiled.provenance.activationEnabled, false);
    assert.equal(compiled.profile.schemaVersion, 4);
    assert.equal(compiled.profile.installedFrontendSHA256.client, client.retainedPlan.ordinaryPlan.release.frontendSHA256);
    assert.equal(compiled.profile.installedFrontendSHA256.operations, operations.retainedPlan.ordinaryPlan.release.frontendSHA256);
    assert.equal(validateCanonicalInstalledProfileV4(args, compiled).profileSHA256, compiled.profileSHA256);
    assert.equal(compiled.provenance.predecessorProfileSHA256,
      '6073b977db48843d9eaecba74cb3863815b92dff87afd4c6f144b5e1dbad48fe');
    for (const [worker, receipt] of [['client', readReceipt(client)], ['operations', readReceipt(operations)]])
      assert.equal(compiled.provenance[worker].candidateId, receipt.candidateId);

    const recapture = snapshot => ({ snapshot, observedAt:new Date().toISOString(), sha256:hash(canonical(snapshot)) });
    const changedCapture = clone(args.finalCaptureEvidence.snapshot);
    changedCapture.client.settings.bindings.find(row => row.name === 'CLIENT_PORTAL_ORIGINS').text = 'https://unreviewed.invalid';
    const changed = { ...args, now:Date.now(), finalCaptureEvidence:recapture(changedCapture) };
    assert.throws(() => compileCanonicalInstalledProfileV4(changed), /Canonical v4 client target scalar differs|Canonical browser poststate has unexpected scalar/u);
    const unrelatedCapture = clone(args.finalCaptureEvidence.snapshot);
    unrelatedCapture.client.settings.bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text = 'https://drift.invalid';
    const unrelated = { ...args, now:Date.now(), finalCaptureEvidence:recapture(unrelatedCapture) };
    assert.throws(() => compileCanonicalInstalledProfileV4(unrelated), /settings\/version bindings differ|scalar configuration changed|unrecognized production settings/u);
    const splitCapture = clone(args.finalCaptureEvidence.snapshot);
    splitCapture.operations.latest = '44444444-4444-4444-8444-444444444444';
    const split = { ...args, now:Date.now(), finalCaptureEvidence:recapture(splitCapture) };
    assert.throws(() => compileCanonicalInstalledProfileV4(split), /sole active latest version/u);
    const schemaDrift = { ...args, client:{ ...args.client, retainedPlan:{ ...args.client.retainedPlan, schemaVersion:3 } }, operations:args.operations,
      finalCaptureEvidence:args.finalCaptureEvidence };
    assert.throws(() => compileCanonicalInstalledProfileV4(schemaDrift), /Canonical v4 client transition plans are incomplete/u);
    const sourceDrift = { ...args, operations:{ ...args.operations, retainedPlan:{ ...args.operations.retainedPlan,
      sourceCommit:'0'.repeat(40) } } };
    assert.throws(() => compileCanonicalInstalledProfileV4(sourceDrift), /source lineage differs/u);
    const uuidDrift = { ...args, client:{ ...args.client, receipt:{ ...args.client.receipt,
      candidateId:'44444444-4444-4444-8444-444444444444' } } };
    assert.throws(() => compileCanonicalInstalledProfileV4(uuidDrift), /exact preceding Client candidate|rollbackVersionId/u);
    const oldClientReceipt = { ...args, client:{ ...args.client, receipt:{ ...args.client.receipt } } };
    const oldClient = oldClientReceipt.client.receipt;
    oldClient.cutoverAt = new Date(Date.parse(oldClient.cutoverAt) - 15 * 60_000).toISOString();
    oldClient.namespaceObservedAt = new Date(Date.parse(oldClient.namespaceObservedAt) - 15 * 60_000).toISOString();
    assert.doesNotThrow(() => compileCanonicalInstalledProfileV4(oldClientReceipt),
      'historical Client retention evidence remains valid while the final full capture stays fresh');
    const staleCapture = { ...args, finalCaptureEvidence:{ ...args.finalCaptureEvidence,
      observedAt:new Date(Date.now() - 6 * 60_000).toISOString() } };
    assert.throws(() => compileCanonicalInstalledProfileV4(staleCapture), /final capture is stale|digest does not match/u);
    const mismatchedCapture = { ...args, finalCaptureEvidence:{ ...args.finalCaptureEvidence,
      sha256:'0'.repeat(64) } };
    assert.throws(() => compileCanonicalInstalledProfileV4(mismatchedCapture), /digest does not match/u);
    const forgedOutput = clone(compiled); forgedOutput.provenance.activationEnabled = true;
    assert.throws(() => validateCanonicalInstalledProfileV4(args, forgedOutput), /offline-only and non-activating/u);
  });

test('private worker-control fixture: Client retirement identity or scalar drift holds Ops before namespace stage',
  { skip: !fixturePath || !opsSuccessorSnapshotPath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const currentOps = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    const clientVersionId = '44444444-4444-4444-8444-444444444444';
    for (const [drift, reason] of [
      ['version', /Client retirement candidate identity changed/u],
      ['target', /Canonical Client predecessor tuple changed during Operations release/u],
      ['unrelated', /client: (?:settings\/version bindings differ|original production scalar configuration changed)/u],
    ]) {
      const afterClient = syntheticCanonicalClientPredecessor(currentOps, fixture.profile, clientVersionId);
      const h = await harness(t, fixture, 'operations', { canonicalBrowserRetirement:true, opsSuccessorPromotion:true,
        canonicalBrowserRetirementClientVersionId:clientVersionId, canonicalClientDrift:drift,
        snapshotOverride:afterClient, post0226Authority:true });
      await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), reason, `${drift} drift must hold before the next native mutation`);
      assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload'], `${drift} drift cannot stage or activate, and upload is not retried`);
      assert.equal(h.nativeCalls.some(row => row.phase === 'namespace-stage' || row.phase === 'activate'), false);
      assert.equal(h.providerEvents.filter(row => row[0] === 'create').length,
        h.providerEvents.filter(row => row[0] === 'remove').length, 'temporary asset verifier is cleaned after a held release');
      assert.equal(h.post0226AuthorityPhases.length, 2, 'staff state was qualified before upload and before dispatch only');
    }
  });

test('private sanitized fixture: full Ops state machine qualifies staff around every mutation and handles fractional cutover', { skip: !fixturePath || !opsBytePathsPath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = await harness(t, fixture, 'operations');
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true); assert.equal(result.nativeExecutionQualification.ready, false);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload', 'namespace-stage', 'activate']);
  assert.deepEqual(h.nativeCalls[1].args.slice(2, 4), [`${h.before.operations.version.id}@100%`, `${h.candidateId}@0%`]);
  assert.equal(h.nativeCalls[1].args.some(arg => arg === `${FIXED_OPS_WEIGHTS[0].versionId}@0%`), false,
    'only the pinned old zero-percent row is deliberately dropped during exact namespace staging');
  assert.equal(h.staffPhases.length >= 5, true);
  const activeReceipt = JSON.parse(fs.readFileSync(path.join(h.journalDirectory, 'verified-active.private.json'), 'utf8'));
  assert.equal(activeReceipt.rootHtmlArchive.path, h.retainedPlan.rootHtmlArchive.path);
  assert.equal(activeReceipt.providerCutoverAt.endsWith('601424Z'), true);
  assert.equal(activeReceipt.cutoverAt.endsWith('Z') && activeReceipt.cutoverAt.length === 24, true);
  assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.cutoverAt) + 48 * 60 * 60_000);
  assert.ok(Date.parse(activeReceipt.earliestPermittedPruningAt) >= Date.parse(activeReceipt.namespaceObservedAt) + 48 * 60 * 60_000);
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
});

test('private sanitized fixture: explicit frontend-only contract checks every Ops phase without native cutover reads', { skip: !fixturePath || !opsBytePathsPath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const h = await harness(t, fixture, 'operations', { frontendAuthority: true });
  const result = await executeOrdinaryFrontendRetainedRelease(h.options);
  assert.equal(result.activated, true);
  assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage','activate']);
  assert.equal(h.frontendAuthorityPhases.length, 8);
  assert.deepEqual(h.staffPhases, [], 'frontend-only authority never reads native cutover readiness');
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
});

test('private sanitized fixture: separate post-0226 preservation contract accepts sequential unchanged reads through activation',
  { skip: !fixturePath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const h = await harness(t, fixture, 'operations', { post0226Authority:true });
    const result = await executeOrdinaryFrontendRetainedRelease(h.options);
    assert.equal(result.activated, true);
    assert.equal(h.post0226AuthorityPhases.length, 8);
    assert.equal(h.post0226ReaderCalls.every(args => !Object.hasOwn(args, 'review')), true,
      'executor receives a raw observation and validates it against the separate post-0226 review');
    assert.deepEqual(h.staffPhases, [], 'post-0226 preservation does not invoke native cutover readiness');
    assert.deepEqual(h.frontendAuthorityPhases, [], 'post-0226 review is not passed through the pre-0226 reader');
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage','activate']);
  });

test('private captured fc9 baseline: Operations promotion keeps sole-100 prestate, post-0226 authority and strict staging',
  { skip: !fixturePath || !opsSuccessorSnapshotPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    assert.deepEqual(Object.keys(snapshot).sort(), ['client','operations','ops-sync']);
    assert.equal(snapshot.operations.version.id, 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68');
    assert.deepEqual(snapshot.operations.deployment.versions, [
      { version_id: 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68', percentage: 100 },
    ]);
    const h = await harness(t, fixture, 'operations', { opsSuccessorPromotion:true, snapshotOverride:snapshot, post0226Authority:true });
    assert.equal(h.ordinaryPlan.expectedDeploymentVersions, undefined,
      'the new contract uses the validator pinned sole-active fc9 state, not caller-supplied weights');
    assert.equal(h.ordinaryPlan.opsSuccessorReaderPromotionContract, OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT);
    assert.throws(() => compileOrdinaryFrontendReleasePlan(snapshot, { app:'operations', release:h.ordinaryPlan.release,
      profile:fixture.profile, expectedDeploymentVersions:{ operations:clone(FIXED_OPS_WEIGHTS) },
      ordinaryFrontendPreflightMode:ORDINARY_FRONTEND_PREFLIGHT_MODE,
      opsSuccessorReaderPromotionContract:OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT }), /sole-active-version capture/u);
    assert.throws(() => compileOrdinaryFrontendReleasePlan(snapshot, { app:'client',
      release:{ ...h.ordinaryPlan.release, application:'client' }, profile:fixture.profile,
      ordinaryFrontendPreflightMode:ORDINARY_FRONTEND_PREFLIGHT_MODE,
      opsSuccessorReaderPromotionContract:OPS_SUCCESSOR_READER_OPERATIONS_PROMOTION_CONTRACT }), /Operations successor-reader promotion requires its exact contract/u);
    const result = await executeOrdinaryFrontendRetainedRelease(h.options);
    assert.equal(result.activated, true);
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage','activate']);
    assert.deepEqual(h.nativeCalls[1].args.slice(2, 4), [
      'fc9bc572-0b87-4857-8b8a-b0e0f7582c68@100%', `${h.candidateId}@0%`,
    ]);
    assert.deepEqual(h.active.operations.deployment.versions, [{ version_id:h.candidateId, percentage:100 }]);
    assert.equal(h.post0226AuthorityPhases.length, 8);
    assert.deepEqual(h.staffPhases, []);
    assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 3);
    assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 3);
  });

test('private captured fc9 baseline: post-0226 drift prevents successor promotion activation',
  { skip: !fixturePath || !opsSuccessorSnapshotPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(opsSuccessorSnapshotPath, 'utf8'));
    const h = await harness(t, fixture, 'operations', { opsSuccessorPromotion:true, snapshotOverride:snapshot,
      post0226Authority:true, driftPost0226At:5 });
    await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /reviewed_staff_login_or_authority_state_changed/u);
    assert.equal(h.post0226AuthorityPhases.length, 5);
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage']);
    assert.equal(h.nativeCalls.some(row => row.phase === 'activate'), false);
    assert.equal(h.providerEvents.filter(row => row[0] === 'create').length,
      h.providerEvents.filter(row => row[0] === 'remove').length, 'temporary asset verifiers are removed after the held release');
  });

test('private sanitized fixture: post-0226 role/profile/login drift holds before activation without retry',
  { skip: !fixturePath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const h = await harness(t, fixture, 'operations', { post0226Authority:true, driftPost0226At:5 });
    await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /reviewed_staff_login_or_authority_state_changed/u);
    assert.equal(h.post0226AuthorityPhases.length, 5);
    assert.deepEqual(h.nativeCalls.map(row => row.phase), ['upload','namespace-stage']);
    assert.equal(h.nativeCalls.some(row => row.phase === 'activate'), false);
    assert.equal(h.staffPhases.length, 0);
  });

test('post-0226 contract rejects mixed authority packets and Client selection before any mutation',
  { skip: !fixturePath || !opsBytePathsPath }, async t => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const ops = await harness(t, fixture, 'operations', { post0226Authority:true });
    ops.options.staffCutoverReview = { synthetic:true };
    await assert.rejects(executeOrdinaryFrontendRetainedRelease(ops.options), /Post-0226 frontend release requires only its separate preservation review/u);
    assert.deepEqual(ops.nativeCalls, []); assert.deepEqual(ops.providerEvents, []);
    assert.equal(fs.existsSync(ops.journalDirectory), false);

    const client = await harness(t, fixture, 'client', { post0226Authority:true });
    await assert.rejects(executeOrdinaryFrontendRetainedRelease(client.options), /Client release cannot select an Operations-only authority contract/u);
    assert.deepEqual(client.nativeCalls, []); assert.deepEqual(client.providerEvents, []);
    assert.equal(fs.existsSync(client.journalDirectory), false);
  });

test('private sanitized fixture: reviewed authority drift holds before the next native version mutation', { skip: !fixturePath || !opsBytePathsPath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const h = await harness(t, fixture, 'operations', { frontendAuthority: true, driftFrontendAuthorityAt: 2 });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /reviewed_staff_or_control_state_changed/u);
  assert.equal(h.frontendAuthorityPhases.length, 2);
  assert.deepEqual(h.staffPhases, [], 'frontend-only drift does not fall back to native cutover readiness');
  assert.deepEqual(h.nativeCalls, [], 'no Worker version upload/deploy is dispatched after authority drift');
  assert.equal(h.providerEvents.filter(row => row[0] === 'create').length, 1);
  assert.equal(h.providerEvents.filter(row => row[0] === 'remove').length, 1);
  assert.equal(fs.readFileSync(path.join(h.journalDirectory, 'journal.jsonl'), 'utf8').includes('native-version-upload'), false);
});

test('private sanitized fixture: ambiguous Client asset failure after one upload and namespace stage does not activate or retry', { skip: !fixturePath }, async t => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = await harness(t, fixture, 'client', { failCandidateAssets: true });
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
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')), h = await harness(t, fixture, 'operations', { failStaff: true });
  await assert.rejects(executeOrdinaryFrontendRetainedRelease(h.options), /synthetic held staff readiness/);
  assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.providerEvents, []);
  assert.equal(fs.existsSync(h.journalDirectory), false);
});
