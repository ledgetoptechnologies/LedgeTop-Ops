import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'write-image-attestation.mjs');
const commit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const baseEnv = {
  ...process.env,
  GITHUB_REPOSITORY: 'ledgetoptechnologies/LedgeTop-Ops',
  GITHUB_SHA: commit,
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW: 'Viewer image',
  GITHUB_WORKFLOW_REF: `ledgetoptechnologies/LedgeTop-Ops/.github/workflows/publish-viewer.yml@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: commit,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SERVER_URL: 'https://github.com',
  IMAGE_NAME: 'ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer',
  IMAGE_DIGEST: digest,
  PUBLISHED_IMAGE: `ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@${digest}`,
  EXPECTED_REVISION: commit,
  VIEWER_SCHEMA_VERSION: '21',
  EXPECTED_SCHEMA_VERSION: '21',
  EXPECTED_OBJ2TILES_VERSION: '1.6.2',
  EXPECTED_POTREE_VERSION: '1.8.2',
};

function run(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-attestation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'viewer-image-attestation.json');
  const result = spawnSync(process.execPath, [script, output], {
    cwd: root,
    env: { ...baseEnv, ...overrides },
    encoding: 'utf8',
  });
  return { ...result, output };
}

test('release attestation binds the exact source workflow run schema tools and digest', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(result.output, 'utf8'));
  assert.equal(record.attestationSchemaVersion, 1);
  assert.equal(record.commit, commit);
  assert.equal(record.digest, digest);
  assert.equal(record.digestQualifiedImage, baseEnv.PUBLISHED_IMAGE);
  assert.deepEqual(record.run, {
    id: '123456789',
    attempt: 2,
    url: 'https://github.com/ledgetoptechnologies/LedgeTop-Ops/actions/runs/123456789',
    workflow: 'Viewer image',
    workflowRef: baseEnv.GITHUB_WORKFLOW_REF,
    workflowSha: commit,
    ref: 'refs/heads/main',
  });
  assert.equal(record.viewerSchemaVersion, 21);
  assert.deepEqual(record.components, { obj2Tiles: '1.6.2', potree: '1.8.2', classicEptPatchVerified: true });
  assert.ok(Object.values(record.verification).every((value) => value === 'passed' || value === '568:568'));
});

test('release attestation rejects invalid digest revision schema and run evidence', (t) => {
  for (const overrides of [
    { IMAGE_DIGEST: 'sha256:short' },
    { EXPECTED_REVISION: 'c'.repeat(40) },
    { VIEWER_SCHEMA_VERSION: '20' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_WORKFLOW_SHA: 'not-a-sha' },
  ]) {
    const result = run(t, overrides);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(result.output), false);
  }
});
