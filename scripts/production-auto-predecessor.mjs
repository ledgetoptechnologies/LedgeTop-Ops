import { createHash } from 'node:crypto';

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const need = (condition, code = 'runtime_predecessor_invalid') => { if (!condition) throw Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');

export function parseProductionAutoPredecessorHandoff(env, { workerName, sourceCommit, triggerRun }) {
  need(env && ['ledgetop-ops', 'ledgetop-ops-sync'].includes(workerName)
    && COMMIT.test(sourceCommit ?? '') && triggerRun?.sourceCommit === sourceCommit
    && Number.isSafeInteger(triggerRun.runId) && triggerRun.runId > 0
    && Number.isSafeInteger(triggerRun.runAttempt) && triggerRun.runAttempt > 0,
  'runtime_predecessor_context_invalid');
  const completion = env.PRODUCTION_AUTO_PREDECESSOR_COMPLETION;
  const predecessorSource = env.PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA;
  const releaseId = env.PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID;
  const predecessorKeys = Object.keys(env).filter(key => key.startsWith('PRODUCTION_AUTO_PREDECESSOR_')).sort();
  need(JSON.stringify(predecessorKeys) === JSON.stringify(['PRODUCTION_AUTO_PREDECESSOR_COMPLETION',
    'PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID', 'PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA']),
  'runtime_predecessor_handoff_invalid');
  const predecessorWorker = workerName === 'ledgetop-ops' ? 'ledgetop-clients' : 'ledgetop-ops';
  const expectedReleaseId = hash(`${predecessorWorker}\n${sourceCommit}`);
  need(completion === 'success' && predecessorSource === sourceCommit && releaseId === expectedReleaseId
    && SHA.test(releaseId), 'runtime_predecessor_handoff_invalid');
  const workflowRunId = env.GITHUB_RUN_ID, workflowRunAttempt = env.GITHUB_RUN_ATTEMPT;
  need(/^[1-9][0-9]*$/u.test(workflowRunId ?? '') && /^[1-9][0-9]*$/u.test(workflowRunAttempt ?? ''),
    'runtime_predecessor_workflow_identity_invalid');
  const parsedRunId = Number(workflowRunId), parsedRunAttempt = Number(workflowRunAttempt);
  need(Number.isSafeInteger(parsedRunId) && Number.isSafeInteger(parsedRunAttempt), 'runtime_predecessor_workflow_identity_invalid');
  return Object.freeze({ workerName: predecessorWorker, releaseKind: 'retained-assets', sourceCommit,
    releaseId, ciRunId: triggerRun.runId, ciRunAttempt: triggerRun.runAttempt,
    workflowRunId: parsedRunId, workflowRunAttempt: parsedRunAttempt });
}

export function validateProductionAutoPredecessorProof(proof, expected) {
  need(proof && proof.workerName === expected.workerName && proof.releaseKind === expected.releaseKind
    && proof.sourceCommit === expected.sourceCommit && proof.releaseId === expected.releaseId
    && proof.ci?.runId === expected.ciRunId && proof.ci?.runAttempt === expected.ciRunAttempt
    && proof.workflow?.runId === expected.workflowRunId && proof.workflow?.runAttempt === expected.workflowRunAttempt
    && proof.artifact?.runId === expected.workflowRunId && proof.artifact?.runAttempt === expected.workflowRunAttempt
    && Number.isSafeInteger(proof.artifact?.artifactId) && proof.artifact.artifactId > 0
    && SHA.test(proof.artifact?.digestSha256 ?? '')
    && proof.artifact?.name === `production-auto-${expected.releaseId}`
    && proof.artifact?.uploadStepConclusion === 'success' && proof.artifact?.releaseStepConclusion === 'success'
    && proof.finalReceipt?.status === 'verified' && proof.finalReceipt?.verifiedActive === true
    && proof.finalReceipt?.sourceCommit === expected.sourceCommit
    && proof.finalReceipt?.workerName === expected.workerName
    && proof.finalReceipt?.ledgerSHA256 === proof.runtime?.ledgerSha256
    && SHA.test(proof.runtime?.profileSha256 ?? '') && SHA.test(proof.runtime?.moduleSha256 ?? '')
    && SHA.test(proof.runtime?.ledgerSha256 ?? '')
    && proof.finalReceipt?.minimumRetentionHours === 48 && proof.finalReceipt?.automaticPruning === false
    && proof.finalReceipt?.allHistoricalAssetsCarried === true
    && UUID.test(proof.finalReceipt?.parentVersionId ?? '')
    && proof.finalReceipt?.moduleSHA256 === proof.runtime.moduleSha256
    && proof.finalReceipt?.controlsSHA256 && SHA.test(proof.finalReceipt.controlsSHA256)
    && UUID.test(proof.finalReceipt?.candidateVersionId ?? '') && UUID.test(proof.finalReceipt?.deploymentId ?? ''),
  'runtime_predecessor_proof_invalid');
  return proof;
}

export function validateLiveProductionAutoPredecessor({ proof, snapshot, app, controlsSHA256 }) {
  const receipt = proof?.finalReceipt, state = snapshot?.[app];
  const rows = state?.deployment?.versions;
  need(receipt && state?.version?.id === receipt.candidateVersionId
    && state?.modern?.id === receipt.candidateVersionId && state?.latest === receipt.candidateVersionId
    && state?.deployment?.id === receipt.deploymentId && Array.isArray(rows) && rows.length === 1
    && rows[0]?.version_id === receipt.candidateVersionId && rows[0]?.percentage === 100
    && controlsSHA256 === receipt.controlsSHA256,
  'runtime_predecessor_live_state_drift');
  const moduleRows = state.modern.modules?.filter(row => row?.name === 'index.js') ?? [];
  need(moduleRows.length === 1 && typeof moduleRows[0].content_base64 === 'string', 'runtime_predecessor_module_missing');
  const moduleBytes = Buffer.from(moduleRows[0].content_base64, 'base64');
  need(moduleBytes.length > 0 && moduleBytes.toString('base64') === moduleRows[0].content_base64
    && hash(moduleBytes) === proof.runtime.moduleSha256,
  'runtime_predecessor_module_drift');
  return true;
}
