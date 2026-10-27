import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeProductionAutoArtifact, readProductionAutoArtifact } from './production-auto-journal-artifact.mjs';

const sourceCommit = 'a'.repeat(40), digest = 'b'.repeat(64), workerName = 'ledgetop-clients';
const releaseId = createHash('sha256').update(`${workerName}\n${sourceCommit}`).digest('hex');
const name = `production-auto-${releaseId}`;
function artifact(overrides = {}) { return { id: 7, name, expired: false, size_in_bytes: 1234, digest: `sha256:${digest}`,
  workflow_run: { id: 99, head_branch: 'main', head_sha: 'd'.repeat(40) }, ...overrides }; }
const fetchFor = row => async (url, init) => {
  assert.equal(url, 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/artifacts/7');
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
  return new Response(JSON.stringify(row), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('artifact metadata binds exact release source, run, name, digest, and source branch', async () => {
  const result = await readProductionAutoArtifact({ id: 7, token: 'x'.repeat(32), sourceCommit, workerName, runId: 99, name, digest, fetchImpl: fetchFor(artifact()) });
  assert.deepEqual(result, { id: 7, name, sizeBytes: 1234, digestSha256: digest });
  for (const change of [
    { id: 8 }, { name: 'other' }, { expired: true }, { size_in_bytes: 0 }, { digest: 'sha256:' + 'e'.repeat(64) },
    { workflow_run: { id: 100, head_branch: 'main', head_sha: sourceCommit } },
    { workflow_run: { id: 99, head_branch: 'feature', head_sha: sourceCommit } },
  ]) await assert.rejects(readProductionAutoArtifact({ id: 7, token: 'x'.repeat(32), sourceCommit, workerName, runId: 99, name, digest, fetchImpl: fetchFor(artifact(change)) }));
  await assert.rejects(readProductionAutoArtifact({ id: 7, token: 'x'.repeat(32), sourceCommit, workerName, runId: 99,
    name: 'production-auto-' + '0'.repeat(64), digest, fetchImpl: fetchFor(artifact()) }));
});

test('artifact completion binds the exact worker/source and verified run before one journal attachment', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'auto-artifact-event-'));
  try {
    const eventPath = path.join(dir, 'event.json'), workflowRunId = 124, attempt = 2;
    writeFileSync(eventPath, JSON.stringify({ workflow_run: { name: 'CI', path: '.github/workflows/ci.yml@main', event: 'push',
      status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: sourceCommit, run_attempt: 1, id: 99,
      repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' }, head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' } } }), { flag: 'wx' });
    const env = { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', PRODUCTION_AUTO_WORKER: workerName,
      GITHUB_TOKEN: 'g'.repeat(32), GITHUB_RUN_ID: String(workflowRunId), GITHUB_RUN_ATTEMPT: String(attempt),
      GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath,
      AUTO_ARTIFACT_ID: '7', AUTO_ARTIFACT_DIGEST: digest, AUTO_UPLOAD_CONCLUSION: 'success', AUTO_RELEASE_CONCLUSION: 'success' };
    const recipient = { fixture: 'recipient' }; let ciConfig, journalConfig, attachment;
    const result = await completeProductionAutoArtifact({ env, fetchImpl: fetchFor(artifact({ workflow_run: { id: workflowRunId, head_branch: 'main', head_sha: sourceCommit } })), recipientLoader: () => recipient,
      ciFactory: options => { ciConfig = options; return { verify: async commit => ({ sourceCommit: commit, passed: true, runId: 99, runAttempt: 1 }) }; },
      journalFactory: options => { journalConfig = options; return { attachArtifact: async value => { attachment = value; } }; } });
    assert.deepEqual(result, { attached: true, artifactId: 7, digestSha256: digest });
    assert.equal(ciConfig.token, env.GITHUB_TOKEN);
    assert.equal(journalConfig.workerName, workerName);
    assert.equal(journalConfig.sourceCommit, sourceCommit);
    assert.equal(journalConfig.ciRunId, 99); assert.equal(journalConfig.ciRunAttempt, 1);
    assert.equal(journalConfig.workflowRunId, workflowRunId); assert.equal(journalConfig.workflowRunAttempt, attempt);
    assert.equal(journalConfig.recipient, recipient);
    assert.deepEqual(attachment, { artifactId: 7, artifactDigest: digest, runId: workflowRunId, runAttempt: attempt,
      name, status: 'success', releaseStatus: 'success' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
