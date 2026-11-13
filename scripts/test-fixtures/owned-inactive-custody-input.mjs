// Public custody metadata only. Never place compiled production bytes here.
import fs from 'node:fs';
import { canonical } from '../production-deploy.mjs';
import { OWNED_INACTIVE_CLIENT_POLICY as policy } from '../production-auto-owned-inactive-policy.mjs';

export function ownedInactiveCustodyInput() {
  const document = JSON.parse(fs.readFileSync(new URL('./owned-inactive-client-held-20261112.json', import.meta.url)));
  return { journalHead: policy.journalHead, journalBytes: Buffer.from(canonical(document) + '\n'),
    artifact: { id: policy.artifactId, name: policy.artifactName, expired: false,
      digest: `sha256:${policy.artifactSha256}`, size_in_bytes: policy.artifactSize,
      workflow_run: { id: policy.oldReleaseRunId, head_branch: 'main' } },
    run: { id: policy.oldReleaseRunId, path: policy.workflowPath, run_attempt: policy.oldRunAttempt,
      event: 'workflow_run', head_branch: 'main', head_sha: policy.oldSourceCommit,
      status: 'completed', conclusion: 'failure' },
    jobs: { total_count: 3, jobs: [
      { name: policy.clientJobName, conclusion: 'failure', steps: [
        { name: policy.clientReleaseStep, conclusion: 'failure' },
        { name: policy.artifactUploadStep, conclusion: 'success' },
        { name: policy.artifactBindStep, conclusion: 'success' } ] },
      { name: policy.operationsJobName, conclusion: 'skipped', steps: [] },
      { name: policy.syncJobName, conclusion: 'skipped', steps: [] } ] } };
}

export function ownedInactiveNewIdentity() {
  return { accountId: policy.accountId, workerName: policy.workerName, sourceCommit: 'a'.repeat(40),
    ciRunId: 100, ciRunAttempt: 1, workflowRunId: 200, workflowRunAttempt: 1 };
}

export function ownedInactiveNewCI(identity = ownedInactiveNewIdentity()) {
  return { passed: true, sourceCommit: identity.sourceCommit, runId: identity.ciRunId, runAttempt: identity.ciRunAttempt };
}
