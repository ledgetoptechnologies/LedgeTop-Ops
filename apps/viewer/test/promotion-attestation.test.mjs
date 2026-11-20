import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPromotionAttestation } from '../scripts/verify-promotion-attestation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'ledgetoptechnologies/LedgeTop-Ops';
const image = 'ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer';
const commit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const runId = '123456789';
const expected = { repository, commit, digest, runId, image };

function record() {
  return {
    attestationSchemaVersion: 1,
    repository,
    commit,
    image,
    digest,
    digestQualifiedImage: `${image}@${digest}`,
    run: {
      id: runId,
      attempt: 1,
      url: `https://github.com/${repository}/actions/runs/${runId}`,
      workflow: 'Publish Operations Viewer image',
      workflowRef: `${repository}/.github/workflows/publish-viewer.yml@refs/heads/main`,
      workflowSha: commit,
      ref: 'refs/heads/main',
    },
    viewerSchemaVersion: 48,
    components: { obj2Tiles: '1.6.2', potree: '1.8.2', classicEptPatchVerified: true },
    verification: {
      repositoryChecks: 'passed',
      pullByDigest: 'passed',
      runtimeUser: '568:568',
      revisionLabel: 'passed',
      sourceStamp: 'passed',
      runtimeSchema: 'passed',
      obj2TilesRuntime: 'passed',
      potreeRuntime: 'passed',
    },
  };
}

test('promotion accepts only the exact verified main candidate', () => {
  assert.deepEqual(verifyPromotionAttestation(record(), expected), { commit, digest, viewerSchemaVersion: 48 });
});

test('promotion rejects mismatched, non-main or unverified candidates', () => {
  const mutate = change => { const value = record(); change(value); return value; };
  for (const [label, value, overrides] of [
    ['other commit', record(), { commit: 'c'.repeat(40) }],
    ['other digest', record(), { digest: `sha256:${'d'.repeat(64)}` }],
    ['other run', record(), { runId: '1' }],
    ['other repository', record(), { repository: 'someone/fork' }],
    ['other image', record(), { image: 'ghcr.io/example/other' }],
    ['short commit', record(), { commit: 'a'.repeat(7) }],
    ['bad digest', record(), { digest: 'latest' }],
    ['branch build', mutate(r => { r.run.ref = 'refs/heads/feature'; }), {}],
    ['other workflow', mutate(r => { r.run.workflowRef = `${repository}/.github/workflows/other.yml@refs/heads/main`; }), {}],
    ['workflow revision', mutate(r => { r.run.workflowSha = 'e'.repeat(40); }), {}],
    ['qualified image', mutate(r => { r.digestQualifiedImage = `${image}:latest`; }), {}],
    ['schema', mutate(r => { r.attestationSchemaVersion = 2; }), {}],
    ['viewer schema', mutate(r => { r.viewerSchemaVersion = 0; }), {}],
    ['failed gate', mutate(r => { r.verification.potreeRuntime = 'failed'; }), {}],
    ['runtime user', mutate(r => { r.verification.runtimeUser = '0:0'; }), {}],
    ['missing gate', mutate(r => { delete r.verification.sourceStamp; }), {}],
    ['extra gate', mutate(r => { r.verification.skipped = 'passed'; }), {}],
    ['not an object', [], {}],
  ]) {
    assert.throws(() => verifyPromotionAttestation(value, { ...expected, ...overrides }), /promotion refused/, label);
  }
});

test('promotion verifier command prints the schema for the run summary and fails closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-promotion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'viewer-image-attestation.json');
  fs.writeFileSync(file, JSON.stringify(record()));
  const env = { ...process.env, GITHUB_REPOSITORY: repository, PROMOTE_COMMIT: commit, PROMOTE_DIGEST: digest, CANDIDATE_RUN_ID: runId, IMAGE_NAME: image };
  const script = path.join(root, 'scripts', 'verify-promotion-attestation.mjs');
  assert.equal(childProcess.execFileSync(process.execPath, [script, file], { env, encoding: 'utf8' }), 'schema-version=48\n');
  const refused = childProcess.spawnSync(process.execPath, [script, file], { env: { ...env, PROMOTE_DIGEST: `sha256:${'f'.repeat(64)}` }, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /promotion refused: attestation digest mismatch/);
});
