import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeProductionAutoArtifact, readProductionAutoArtifact, readOwnedInactiveArtifactCompletion } from './production-auto-journal-artifact.mjs';
import { ownedInactiveExpectedAdmissionDigest } from './production-auto-owned-inactive-admission.mjs';
import { ownedInactiveNewIdentity } from './test-fixtures/owned-inactive-custody-input.mjs';

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

test('artifact recovery uses originating outputs and binds source, CI and workflow attempts', () => {
  const identity = ownedInactiveNewIdentity();
  const trigger = { sourceCommit: identity.sourceCommit, runId: identity.ciRunId, runAttempt: identity.ciRunAttempt };
  const env = { PRODUCTION_AUTO_WORKER: identity.workerName,
    GITHUB_RUN_ID: String(identity.workflowRunId), GITHUB_RUN_ATTEMPT: String(identity.workflowRunAttempt),
    AUTO_OWNED_INACTIVE_SUPERSESSION: 'true', AUTO_OWNED_INACTIVE_JOURNAL_HEAD: 'c'.repeat(40),
    AUTO_OWNED_INACTIVE_ADMISSION_SHA256: ownedInactiveExpectedAdmissionDigest(identity) };
  assert.deepEqual(readOwnedInactiveArtifactCompletion(env, trigger), {
    expectedJournalHead: env.AUTO_OWNED_INACTIVE_JOURNAL_HEAD, admissionSHA256: env.AUTO_OWNED_INACTIVE_ADMISSION_SHA256 });
  assert.equal(readOwnedInactiveArtifactCompletion({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'true' }, trigger), null,
    'a later mutable repository selector cannot enable completion');
  assert.deepEqual(readOwnedInactiveArtifactCompletion({ ...env, PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'false' }, trigger),
    readOwnedInactiveArtifactCompletion(env, trigger), 'a later selector cannot disable this originating run');
  for (const patch of [ { AUTO_OWNED_INACTIVE_SUPERSESSION: 'false' }, { AUTO_OWNED_INACTIVE_SUPERSESSION: 'TRUE' },
    { AUTO_OWNED_INACTIVE_JOURNAL_HEAD: '' }, { AUTO_OWNED_INACTIVE_ADMISSION_SHA256: '0'.repeat(64) },
    { PRODUCTION_AUTO_WORKER: 'ledgetop-ops' }, { PRODUCTION_AUTO_WORKER: 'ledgetop-ops-sync' },
    { GITHUB_RUN_ID: '201' }, { GITHUB_RUN_ATTEMPT: '2' } ])
    assert.throws(() => readOwnedInactiveArtifactCompletion({ ...env, ...patch }, trigger), /artifact_owned_inactive_completion_invalid/u);
  for (const patch of [{ sourceCommit: 'b'.repeat(40) }, { runId: 101 }, { runAttempt: 2 }])
    assert.throws(() => readOwnedInactiveArtifactCompletion(env, { ...trigger, ...patch }), /artifact_owned_inactive_completion_invalid/u);
});

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

test('artifact reader accepts the dotted opaque token in its Authorization header', async () => {
  const token = `ghs_${'A'.repeat(260)}.${'B'.repeat(180)}.${'C'.repeat(80)}`;
  let authorization;
  const result = await readProductionAutoArtifact({ id: 7, token, sourceCommit, workerName, runId: 99, name, digest,
    fetchImpl: async (_url, init) => { authorization = init.headers.Authorization; return Response.json(artifact()); } });
  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(result.id, 7);
});

test('Sync completion uses the same strict artifact binding and backend journal without Cloudflare calls', async () => {
  const syncWorker = 'ledgetop-ops-sync';
  const syncRelease = createHash('sha256').update(`${syncWorker}\n${sourceCommit}`).digest('hex');
  const syncName = `production-auto-${syncRelease}`;
  const env = { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', PRODUCTION_AUTO_WORKER: syncWorker,
    GITHUB_TOKEN: 'x'.repeat(32), GITHUB_RUN_ID: '124', GITHUB_RUN_ATTEMPT: '1',
    AUTO_ARTIFACT_ID: '7', AUTO_ARTIFACT_DIGEST: digest, AUTO_UPLOAD_CONCLUSION: 'success', AUTO_RELEASE_CONCLUSION: 'success' };
  let journalOptions, attachment, calls = 0;
  const result = await completeProductionAutoArtifact({ env, recipientLoader: () => ({ fixture: true }),
    triggerReader: () => ({ sourceCommit, runId: 99, runAttempt: 1 }),
    ciFactory: () => ({ verify: async () => ({ sourceCommit, passed: true, runId: 99, runAttempt: 1 }) }),
    fetchImpl: async (url, init) => { calls++; return fetchFor(artifact({ name: syncName,
      workflow_run: { id: 124, head_branch: 'main', head_sha: sourceCommit } }))(url, init); },
    journalFactory: options => { journalOptions = options; return { attachArtifact: async value => { attachment = value; } }; } });
  assert.equal(result.attached, true); assert.equal(calls, 1);
  assert.equal(journalOptions.workerName, syncWorker); assert.equal(journalOptions.releaseKind, 'backend-sync');
  assert.equal(attachment.name, syncName); assert.equal(attachment.artifactDigest, digest);
  await assert.rejects(readProductionAutoArtifact({ id: 7, token: env.GITHUB_TOKEN, sourceCommit,
    workerName: 'foreign-worker', runId: 124, name: syncName, digest,
    fetchImpl: async () => { calls++; throw Error('must not send'); } }), /artifact_id_invalid/u);
  assert.equal(calls, 1);
});

test('artifact completion binds the exact worker/source and verified run before one journal attachment', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'auto-artifact-event-'));
  try {
    const eventPath = path.join(dir, 'event.json'), workflowRunId = 124, attempt = 2;
    writeFileSync(eventPath, JSON.stringify({ workflow_run: { name: 'CI', path: '.github/workflows/ci.yml@main', event: 'push',
      status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: sourceCommit, run_attempt: 1, id: 99,
      repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' }, head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' } } }), { flag: 'wx' });
    const env = { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', PRODUCTION_AUTO_WORKER: workerName,
      GITHUB_TOKEN: `ghs_${'A'.repeat(260)}.${'B'.repeat(180)}.${'C'.repeat(80)}`, GITHUB_RUN_ID: String(workflowRunId), GITHUB_RUN_ATTEMPT: String(attempt),
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
