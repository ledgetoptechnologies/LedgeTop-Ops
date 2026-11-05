import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseProductionAutoPredecessorHandoff, validateProductionAutoPredecessorProof } from './production-auto-predecessor.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceCommit = 'a'.repeat(40);
const triggerRun = { sourceCommit, runId: 101, runAttempt: 2 };
const env = { PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success', PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: sourceCommit,
  PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: hash(`ledgetop-clients\n${sourceCommit}`), GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1' };

test('Ops predecessor handoff requires exact successful source and safe workflow identities', () => {
  const expected = parseProductionAutoPredecessorHandoff(env, { workerName: 'ledgetop-ops', sourceCommit, triggerRun });
  assert.deepEqual(expected, { workerName: 'ledgetop-clients', releaseKind: 'retained-assets', sourceCommit,
    releaseId: env.PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID, ciRunId: 101, ciRunAttempt: 2, workflowRunId: 789, workflowRunAttempt: 1 });
  for (const mutate of [
    value => { value.PRODUCTION_AUTO_PREDECESSOR_COMPLETION = 'failure'; },
    value => { value.PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA = 'b'.repeat(40); },
    value => { value.PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID = 'f'.repeat(64); },
    value => { delete value.PRODUCTION_AUTO_PREDECESSOR_COMPLETION; },
    value => { value.GITHUB_RUN_ID = '9007199254740992'; },
    value => { value.GITHUB_RUN_ATTEMPT = '1e0'; },
    value => { value.PRODUCTION_AUTO_PREDECESSOR_EXTRA = 'unexpected'; },
  ]) {
    const invalid = structuredClone(env); mutate(invalid);
    assert.throws(() => parseProductionAutoPredecessorHandoff(invalid, { workerName: 'ledgetop-ops', sourceCommit, triggerRun }));
  }
  assert.throws(() => parseProductionAutoPredecessorHandoff(env, { workerName: 'ledgetop-ops-sync',
    sourceCommit, triggerRun: { ...triggerRun, sourceCommit: 'b'.repeat(40) } }));
});

test('Sync predecessor proof rechecks journal, artifact and CI binding fields after the read', () => {
  const expected = parseProductionAutoPredecessorHandoff({ ...env,
    PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: hash(`ledgetop-ops\n${sourceCommit}`) },
  { workerName: 'ledgetop-ops-sync', sourceCommit, triggerRun });
  const proof = { workerName: 'ledgetop-ops', releaseKind: 'retained-assets', sourceCommit,
    releaseId: expected.releaseId, ci: { runId: 101, runAttempt: 2 }, workflow: { runId: 789, runAttempt: 1 },
    runtime: { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: '3'.repeat(64) },
    artifact: { artifactId: 12, digestSha256: '4'.repeat(64), name: `production-auto-${expected.releaseId}`,
      runId: 789, runAttempt: 1, uploadStepConclusion: 'success', releaseStepConclusion: 'success' },
    finalReceipt: { status: 'verified', sourceCommit, workerName: 'ledgetop-ops', verifiedActive: true,
      moduleSHA256: '2'.repeat(64), ledgerSHA256: '3'.repeat(64), controlsSHA256: '5'.repeat(64),
      minimumRetentionHours: 48, automaticPruning: false, allHistoricalAssetsCarried: true,
      parentVersionId: '33333333-3333-4333-8333-333333333333',
      candidateVersionId: '11111111-1111-4111-8111-111111111111', deploymentId: '22222222-2222-4222-8222-222222222222' } };
  assert.equal(validateProductionAutoPredecessorProof(proof, expected), proof);
  for (const mutate of [
    value => { value.artifact = null; },
    value => { value.ci.runAttempt += 1; },
    value => { value.artifact.digestSha256 = 'not-a-digest'; },
    value => { value.finalReceipt.ledgerSHA256 = '6'.repeat(64); },
    value => { value.finalReceipt.candidateVersionId = 'not-a-version'; },
  ]) {
    const invalid = structuredClone(proof); mutate(invalid);
    assert.throws(() => validateProductionAutoPredecessorProof(invalid, expected));
  }
});
