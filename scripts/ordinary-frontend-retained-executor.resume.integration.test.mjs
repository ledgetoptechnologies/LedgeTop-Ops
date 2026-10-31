/** Offline-only rehearsal of the already-uploaded Ops candidate. All Worker,
 * asset-verifier, source-reader and staff adapters are local fakes; this test
 * never calls Cloudflare, Wrangler, the SDK, or a provider endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOrdinaryFrontendRetainedRelease } from './ordinary-frontend-retained-executor.mjs';
import { canonical, hash, ORDINARY_FRONTEND_PREFLIGHT_MODE } from './production-deploy.mjs';
import { prepareOpsLegacyLedgerBootstrap, completeOpsLegacyLedgerBootstrap } from './ordinary-frontend-ops-ledger-bootstrap.mjs';
import { collectFrontendAssets, mergeAssetLedger, preserveRootHtmlArchive } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const fixturePath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_PRIVATE_FIXTURE;
const planPath = process.env.LEDGETOP_ORDINARY_FRONTEND_RETAINED_PLAN_PATH;
const snapshotPath = process.env.LEDGETOP_ORDINARY_FRONTEND_RETAINED_SNAPSHOT_PATH;
const priorJournalDirectory = process.env.LEDGETOP_ORDINARY_FRONTEND_PRIOR_CANDIDATE_DIRECTORY;
const bytePathsPath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_BYTE_PATHS;
const sourceRoot = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_SOURCE_ROOT;
const versionReadbackPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_VERSION_READBACK;
const modernReadbackPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_MODERN_READBACK;
const candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
const baselineId = 'a45943f4-e5c5-4142-9057-fb9adb5cf739';
const FIXED_OPS_WEIGHTS = [
  { versionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e', percentage: 0 },
  { versionId: baselineId, percentage: 100 },
];
const assetRoot = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_OPS_ASSET_ROOT
  ?? 'C:/Users/fstor/.codex/artifacts/ui-retained-packets-b0c99cdd-20261028-v3/operations-packet/assets';
const codepoint = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const clone = value => structuredClone(value);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function previousAssets(context) {
  assert.ok(fs.existsSync(bytePathsPath), 'exact prior Ops byte sidecar must be supplied');
  const sidecar = readJson(bytePathsPath), root = fs.realpathSync(assetRoot), result = new Map();
  assert.equal(sidecar.schemaVersion, 1);
  assert.deepEqual([...sidecar.rows].sort(codepoint).map(({ path: p, size, sha256, mime }) => ({ path: p, size, sha256, mime })),
    context.previousAssetRows);
  for (const row of sidecar.rows) {
    const file = path.resolve(row.file), real = fs.realpathSync(file), stat = fs.statSync(real), bytes = fs.readFileSync(real);
    assert.ok(real.startsWith(`${root}${path.sep}`) && !fs.lstatSync(real).isSymbolicLink());
    assert.equal(stat.nlink, 1); assert.equal(bytes.length, row.size); assert.equal(hash(bytes), row.sha256);
    result.set(row.path, bytes);
  }
  return result;
}
function readiness(sourceCommit) {
  return { schemaVersion: 2, sourceCommit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId, reviewSha256: '1'.repeat(64), cohortSha256: '2'.repeat(64),
    controlPlaneSha256: '3'.repeat(64), observedAt: new Date().toISOString(), staffCount: 1, generation: 1 };
}

test('resume existing Ops candidate: old bytes → one stage0 → candidate bytes → one activation → active bytes, no upload', {
  skip: !fixturePath || !planPath || !snapshotPath || !priorJournalDirectory || !bytePathsPath || !sourceRoot
    || !versionReadbackPath || !modernReadbackPath,
}, async t => {
  const controls = readJson(fixturePath), plan = readJson(planPath), original = readJson(snapshotPath);
  const candidateVersion = readJson(versionReadbackPath), candidateModern = readJson(modernReadbackPath);
  assert.equal(plan.application, 'operations'); assert.equal(plan.parentVersionId, baselineId);
  assert.equal(candidateVersion.id, candidateId); assert.equal(candidateModern.id, candidateId);
  assert.equal(Date.now() - Date.parse(plan.retentionLedger.observedAt) > 5 * 60_000, true,
    'resume uses the original stale observation instead of fabricating a new plan time');

  const bootstrap = prepareOpsLegacyLedgerBootstrap(original);
  assert.ok(bootstrap && bootstrap.previousAssetRows.length === 471);
  const previousAssetBytes = previousAssets(bootstrap);
  const previousLedger = completeOpsLegacyLedgerBootstrap(bootstrap, { verifiedAssets: previousAssetBytes, verifiedVersionId: baselineId });
  const currentAssets = collectFrontendAssets(plan.ordinaryPlan.release.assets.directory);
  const retained = preserveRootHtmlArchive({ application: 'operations', previous: previousLedger,
    previousAssetBytes, current: currentAssets });
  const reconstructed = mergeAssetLedger({ previous: previousLedger, current: retained.current,
    workerName: plan.workerName, accountId: plan.accountId, sourceCommit: plan.sourceCommit,
    parentVersionId: baselineId, observedAt: plan.retentionLedger.observedAt });
  assert.deepEqual(reconstructed, plan.retentionLedger);
  const candidateAssetBytes = retained.current.payloads;
  assert.equal(candidateAssetBytes.size, plan.retentionLedger.assets.length);

  const active = clone(original);
  active.operations.latest = candidateId;
  active.operations.latestVersion = clone(candidateVersion);
  active.operations.latestModern = clone(candidateModern);
  const verifierVersions = new Map(), providerEvents = [], nativeCalls = [], staffPhases = [];
  const reader = {
    async getCandidateVersion(workerName, versionId) {
      assert.equal(workerName, 'ledgetop-ops');
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(original.operations.version);
      throw new Error('Unexpected candidate-version GET');
    },
    async get(suffix) {
      const versionId = suffix.match(/versions\/([^?]+)/u)?.[1];
      if (suffix.includes('/workers/workers/')) return clone(versionId === candidateId ? candidateModern : original.operations.modern);
      if (versionId === candidateId) return clone(candidateVersion);
      if (versionId === baselineId) return clone(original.operations.version);
      throw new Error('Unexpected metadata GET');
    },
  };
  const assetVerifierProvider = {
    async createVerifier({ name, workerName, versionId }) {
      assert.equal(workerName, 'ledgetop-ops'); verifierVersions.set(name, versionId); providerEvents.push(['create', versionId]);
    },
    async fetchVerifierAsset({ name, path: assetPath, method }) {
      const versionId = verifierVersions.get(name);
      const source = versionId === candidateId ? candidateAssetBytes : previousAssetBytes;
      const entries = versionId === candidateId ? plan.retentionLedger.assets : previousLedger.assets;
      const bytes = source.get(assetPath), entry = entries.find(row => row.path === assetPath);
      assert.ok(Buffer.isBuffer(bytes) && entry);
      return new Response(method === 'HEAD' ? null : bytes, { status: 200,
        headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.size) } });
    },
    async removeVerifier(name) { providerEvents.push(['remove', verifierVersions.get(name)]); verifierVersions.delete(name); },
    async verifierAbsent(name) { return !verifierVersions.has(name); },
  };
  const captureFn = async () => clone(active);
  const runNative = async (_cli, args, _journal, phase) => {
    nativeCalls.push({ phase, args: [...args] });
    if (phase === 'upload') throw new Error('Resume must never replay the consumed upload');
    if (phase === 'namespace-stage') {
      assert.deepEqual(providerEvents.filter(row => row[0] === 'create').map(row => row[1]), [baselineId],
        'only old active bytes are verified before staging the inactive candidate');
      assert.deepEqual(providerEvents.filter(row => row[0] === 'remove').map(row => row[1]), [baselineId],
        'the old-byte verifier is removed before stage0');
      active.operations.deployment.versions = [{ version_id: baselineId, percentage: 100 },
        { version_id: candidateId, percentage: 0 }];
      active.operations.deployment.created_on = new Date().toISOString(); return 'staged';
    }
    if (phase === 'activate') {
      assert.deepEqual(providerEvents.filter(row => row[0] === 'create').map(row => row[1]), [baselineId, candidateId],
        'candidate union bytes are verified only after stage0 and before activation');
      assert.deepEqual(providerEvents.filter(row => row[0] === 'remove').map(row => row[1]), [baselineId, candidateId],
        'both prior byte verifiers are cleaned up before activation');
      active.operations.deployment.versions = [{ version_id: candidateId, percentage: 100 }];
      active.operations.deployment.created_on = new Date().toISOString();
      active.operations.version = clone(candidateVersion); active.operations.modern = clone(candidateModern);
      active.operations.latest = candidateId; delete active.operations.latestVersion; delete active.operations.latestModern;
      return 'activated';
    }
    throw new Error(`Unexpected native phase ${phase}`);
  };
  const sourceCommit = plan.sourceCommit, executorCommit = controls.executorSourceCommit;
  const artifactSourceRoot = sourceRoot, executorSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceReader = root => path.resolve(root).toLowerCase() === path.resolve(artifactSourceRoot).toLowerCase()
    ? sourceCommit : executorCommit;
  const journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-retained-resume-integration-'));
  t.after(() => fs.rmSync(journalDirectory, { recursive: true, force: true }));
  fs.rmdirSync(journalDirectory);
  const cliPath = readJson(path.join(priorJournalDirectory, 'upload-intent.json')).argv[2];
  const expectedDeploymentVersions = { operations: clone(FIXED_OPS_WEIGHTS) };
  const phases = [];
  const result = await executeOrdinaryFrontendRetainedRelease({ app: 'operations', plan, profile: controls.profile,
    expectedDeploymentVersions, assetVerifierProvider, staffCutoverReview: { syntheticPrivatePacket: true },
    reader, cli: cliPath, journalDirectory, artifactSourceRoot, executorSourceRoot, sourceReader,
    resumeCandidate: { candidateId, priorJournalDirectory, originalSnapshot: original },
    captureFn, runNative, readStaffCutover: async () => { phases.push(phases.length + 1); return readiness(sourceCommit); } });

  assert.deepEqual(nativeCalls.map(row => row.phase), ['namespace-stage', 'activate']);
  assert.deepEqual(nativeCalls[0].args.slice(2, 4), [`${baselineId}@100%`, `${candidateId}@0%`]);
  assert.deepEqual(nativeCalls[1].args.slice(2, 3), [`${candidateId}@100%`]);
  assert.equal(result.candidateId, candidateId); assert.equal(result.uploaded, false); assert.equal(result.resumedPriorUpload, true);
  assert.equal(fs.readFileSync(path.join(journalDirectory, 'journal.jsonl'), 'utf8').includes('native-version-upload'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory, 'resume-candidate.private.json'), 'utf8')).uploadReplayed, false);
  assert.equal(phases.length >= 6, true, 'staff readiness is repeatedly checked around the release');
  assert.equal(providerEvents.filter(row => row[0] === 'create').length, 3);
  assert.equal(providerEvents.filter(row => row[0] === 'remove').length, 3);
  assert.equal(verifierVersions.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(journalDirectory, 'verified-active.private.json'), 'utf8')).candidateId, candidateId);
  assert.equal(Date.parse(result.earliestPermittedPruningAt) >= Date.now() + 48 * 60 * 60_000 - 30_000, true);
});
