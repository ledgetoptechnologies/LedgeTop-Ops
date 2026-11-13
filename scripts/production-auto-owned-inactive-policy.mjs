/**
 * Immutable, one-case custody validator for the retained inactive Client
 * candidate. This module proves old public journal/artifact/run custody only.
 * Its receipt is not a write admission, source approval, or provider authority.
 */
import { createHash } from 'node:crypto';
import { canonical } from './production-deploy.mjs';

const fail = () => { throw Error('owned_inactive_custody_refused'); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const INTENT_PHASES = Object.freeze([
  'temporary-verifier-create', 'temporary-verifier-enable', 'temporary-verifier-delete',
  'asset-session', 'asset-bucket', 'worker-version-upload',
]);
const INTENT_METHODS = Object.freeze(['PUT', 'POST', 'DELETE', 'POST', 'POST', 'POST']);
const ACK_STATUSES = Object.freeze([200, 200, 200, 200, 201, 200]);
const verifiedReceipts = new WeakSet();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const OWNED_INACTIVE_CLIENT_POLICY = deepFreeze({
  schemaVersion: 1,
  accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
  workerName: 'ledgetop-clients',
  oldSourceCommit: '77fa5ea24df4a04e3189d2aeed25cae46982f8a2',
  oldReleaseId: 'a6fd307619205f73f81ad7063cf33222c76dd2d32f09152e9e49741f00a7ceaf',
  journalHead: 'f5b9108fd270973d09725b7b1dc83335e6ef03cf',
  journalSequence: 54,
  journalDocumentSha256: 'f27f19d4bd266b2976165fe65057b5908a1071454ef4477ec2a0aab09be3c3ec',
  oldOperationSha256: '20c5c5796960dafc1dc1fad9a414b98633e01f186bc4ed6213c8ff2d0da2e220',
  parentVersionId: '7ebfd9ba-e293-482d-84f9-08d1c6901b88',
  priorInactiveCandidateVersionId: '2f973a9a-53d4-4752-9a85-589a064e57de',
  oldCiRunId: 43359972034,
  oldReleaseRunId: 43361574725,
  oldRunAttempt: 1,
  workflowPath: '.github/workflows/production-auto-release.yml',
  artifactId: 14009090605,
  artifactName: 'production-auto-a6fd307619205f73f81ad7063cf33222c76dd2d32f09152e9e49741f00a7ceaf',
  artifactSha256: '9ccc8b52efe9dcb05a4e64213eb7ba07efe3a8b777e9917f4aa9da31d0ec7c45',
  artifactSize: 43089,
  controlsSha256: 'ebb76dd4da3c21232bfa0a0603368435baa9a27b46488ded33be001809225ef7',
  priorCandidateEffectiveControlsSha256: '54d9d7ceb8554bf4a3a5daf1f16a4e9d561725651941cb84ac0035b27c11746b',
  moduleSha256: '610face8fd6635b0b235996fa9cc9e8d267f2ed139105edd88ded195d31186e0',
  ledgerSha256: 'cfed41fc7828a574079240122de6015b2101ff69c7ca7978b77f252266e40346',
  runtimeProfileSha256: '4c2583eba7387b076ac7bea51fa23d5fa1d2d60ce7a1e72dde493f0c7c934981',
  maxJournalBytes: 4 * 1024 * 1024,
  maxJobs: 8,
  maxStepsPerJob: 128,
  intentPhases: INTENT_PHASES,
  intentMethods: INTENT_METHODS,
  acknowledgedStatuses: ACK_STATUSES,
  clientJobName: 'release-client',
  operationsJobName: 'release-operations',
  syncJobName: 'release-sync',
  clientReleaseStep: 'Run exact-main CI-fenced Client release',
  artifactUploadStep: 'Upload only sealed provider responses',
  artifactBindStep: 'Bind encrypted artifact id and digest to the durable journal',
});

export function ownedInactivePolicySHA256() {
  return sha256(Buffer.from(canonical(OWNED_INACTIVE_CLIENT_POLICY), 'utf8'));
}

function plainRecord(value, maxKeys = 64) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxKeys || keys.some(key => typeof key !== 'string')) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) fail();
  }
  return value;
}

function boundedArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength
      || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) fail();
  }
  return value;
}

function requireExactKeys(value, keys) {
  plainRecord(value, keys.length);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}

function verifyJournal(journalHead, journalBytes) {
  const p = OWNED_INACTIVE_CLIENT_POLICY;
  if (journalHead !== p.journalHead || !Buffer.isBuffer(journalBytes) || journalBytes.length === 0
      || journalBytes.length > p.maxJournalBytes) fail();
  let document;
  try { document = JSON.parse(journalBytes.toString('utf8')); } catch { fail(); }
  requireExactKeys(document, ['schemaVersion', 'workerName', 'sequence', 'operations']);
  if (document.schemaVersion !== 1 || document.workerName !== p.workerName || document.sequence !== p.journalSequence
      || !Buffer.from(canonical(document) + '\n', 'utf8').equals(journalBytes)
      || sha256(Buffer.from(canonical(document) + '\n', 'utf8')) !== p.journalDocumentSha256) fail();
  const operations = boundedArray(document.operations, 5);
  if (operations.length !== 5) fail();
  const selected = operations.filter(row => row?.releaseId === p.oldReleaseId);
  if (selected.length !== 1) fail();
  const operation = selected[0];
  if (sha256(Buffer.from(canonical(operation), 'utf8')) !== p.oldOperationSha256
      || operation.state !== 'held' || operation.releaseKind !== 'retained-assets'
      || operation.workerName !== p.workerName || operation.sourceCommit !== p.oldSourceCommit
      || operation.releaseId !== p.oldReleaseId) fail();
  requireExactKeys(operation.workflow, ['runId', 'runAttempt']);
  requireExactKeys(operation.ci, ['runId', 'runAttempt']);
  if (operation.workflow.runId !== p.oldReleaseRunId || operation.workflow.runAttempt !== p.oldRunAttempt
      || operation.ci.runId !== p.oldCiRunId || operation.ci.runAttempt !== p.oldRunAttempt) fail();
  requireExactKeys(operation.artifact, ['artifactId', 'digestSha256', 'name', 'releaseStepConclusion', 'runAttempt', 'runId', 'uploadStepConclusion']);
  if (operation.artifact.artifactId !== p.artifactId || operation.artifact.digestSha256 !== p.artifactSha256
      || operation.artifact.name !== p.artifactName || operation.artifact.runId !== p.oldReleaseRunId
      || operation.artifact.runAttempt !== p.oldRunAttempt || operation.artifact.releaseStepConclusion !== 'failure'
      || operation.artifact.uploadStepConclusion !== 'success') fail();
  requireExactKeys(operation.runtime, ['ledgerSha256', 'moduleSha256', 'profileSha256']);
  if (operation.runtime.ledgerSha256 !== p.ledgerSha256 || operation.runtime.moduleSha256 !== p.moduleSha256
      || operation.runtime.profileSha256 !== p.runtimeProfileSha256) fail();
  const receipts = boundedArray(operation.receipts, 3);
  if (receipts.length !== 3) fail();
  const [started, prepared, held] = receipts;
  if (started?.phase !== 'prepare' || started.status !== 'started' || started.writesAttempted !== false
      || started.parentVersionId !== p.parentVersionId || started.controlsSHA256 !== p.controlsSha256
      || prepared?.phase !== 'prepare' || prepared.status !== 'prepared' || prepared.automaticPruning !== false
      || prepared.minimumRetentionHours !== 48 || prepared.ledgerSHA256 !== p.ledgerSha256
      || held?.phase !== 'candidate-readback' || held.status !== 'held' || held.writesAttempted !== true
      || held.candidateVersionId !== p.priorInactiveCandidateVersionId
      || held.failureCode !== 'release_candidate_readback_failed' || held.reconciliationCode !== 'read_failed'
      || held.reconciliation?.readSucceeded !== false) fail();
  const intents = boundedArray(operation.intents, 6), responses = boundedArray(operation.responses, 6);
  if (intents.length !== p.intentPhases.length || responses.length !== intents.length) fail();
  const ids = new Set();
  for (let index = 0; index < intents.length; index++) {
    const intent = plainRecord(intents[index], 20), response = plainRecord(responses[index], 16);
    if (intent.sequence !== index + 1 || intent.phase !== p.intentPhases[index] || intent.method !== p.intentMethods[index]
        || intent.workerName !== p.workerName || intent.automaticRetry !== false || !UUID.test(intent.requestId ?? '')
        || ids.has(intent.requestId) || response.requestId !== intent.requestId || response.providerAcknowledged !== true
        || response.status !== p.acknowledgedStatuses[index] || !Array.isArray(response.errorCodes)
        || response.errorCodes.length !== 0 || !SHA.test(response.responseSha256 ?? '')
        || !SHA.test(response.ciphertextSha256 ?? '') || !Number.isSafeInteger(response.responseBytes)
        || response.responseBytes < 0 || !Number.isSafeInteger(response.ciphertextBytes) || response.ciphertextBytes <= 0
        || response.ciphertextFile !== `responses/${intent.requestId}.sealed.json`) fail();
    ids.add(intent.requestId);
  }
  if (intents.some(row => row.phase === 'stage-zero-percent' || row.phase === 'activate-candidate')) fail();
  const helper = intents.slice(0, 3);
  if (!helper.every(row => row.temporaryWorkerName === helper[0].temporaryWorkerName)
      || !/^ops-ui-verify-[a-f0-9]{24}$/u.test(helper[0].temporaryWorkerName ?? '')
      || !SHA.test(helper[0].sourceSHA256 ?? '') || helper[0].sourceSHA256 !== helper[2].sourceSHA256) fail();
  if (intents[3].hashes?.length !== 208 || !Array.isArray(intents[4].hashes) || intents[4].hashes.length !== 1
      || intents[5].parentVersionId !== p.parentVersionId
      || canonical(intents[5].modules) !== canonical({
        '__ops_release_ledger.json': p.ledgerSha256, 'index.js': p.moduleSha256,
        'index.js.map': '3efc43c92ecbdc1dd6660c77110cc1b2f73177479cc46485315a5ae0a1cd81e8',
      })) fail();
  return operation;
}

function verifyArtifact(artifact) {
  const p = OWNED_INACTIVE_CLIENT_POLICY;
  plainRecord(artifact);
  if (artifact.id !== p.artifactId || artifact.name !== p.artifactName || artifact.expired !== false
      || artifact.digest !== `sha256:${p.artifactSha256}` || artifact.size_in_bytes !== p.artifactSize) fail();
  plainRecord(artifact.workflow_run);
  if (artifact.workflow_run.id !== p.oldReleaseRunId || artifact.workflow_run.head_branch !== 'main') fail();
}

function verifyRun(run) {
  const p = OWNED_INACTIVE_CLIENT_POLICY;
  plainRecord(run);
  if (run.id !== p.oldReleaseRunId || run.path !== p.workflowPath || run.run_attempt !== p.oldRunAttempt
      || run.event !== 'workflow_run' || run.head_branch !== 'main' || run.head_sha !== p.oldSourceCommit
      || run.status !== 'completed' || run.conclusion !== 'failure') fail();
}

function jobSteps(job, maxSteps) {
  plainRecord(job, 64);
  if (typeof job.name !== 'string' || job.name.length === 0 || job.name.length > 128
      || typeof job.conclusion !== 'string' || !['success', 'failure', 'skipped', 'cancelled', 'neutral'].includes(job.conclusion)) fail();
  const steps = boundedArray(job.steps, maxSteps);
  const names = new Set();
  for (const stepValue of steps) {
    const step = plainRecord(stepValue, 64);
    if (typeof step.name !== 'string' || step.name.length === 0 || step.name.length > 200
        || typeof step.conclusion !== 'string' || !['success', 'failure', 'skipped', 'cancelled', 'neutral'].includes(step.conclusion)) fail();
    if (names.has(step.name)) fail();
    names.add(step.name);
  }
  return steps;
}

function verifyJobs(jobs) {
  const p = OWNED_INACTIVE_CLIENT_POLICY;
  plainRecord(jobs, 16);
  if (jobs.total_count !== 3) fail();
  const rows = boundedArray(jobs.jobs, p.maxJobs);
  if (rows.length !== 3) fail();
  const byName = new Map();
  for (const value of rows) {
    const job = plainRecord(value, 64);
    if (typeof job.name !== 'string' || byName.has(job.name)) fail();
    const steps = jobSteps(job, p.maxStepsPerJob);
    byName.set(job.name, { job, steps });
  }
  if (byName.size !== 3 || !byName.has(p.clientJobName) || !byName.has(p.operationsJobName) || !byName.has(p.syncJobName)) fail();
  const client = byName.get(p.clientJobName);
  if (client.job.conclusion !== 'failure'
      || client.steps.filter(step => step.name === p.clientReleaseStep && step.conclusion === 'failure').length !== 1
      || client.steps.filter(step => step.name === p.artifactUploadStep && step.conclusion === 'success').length !== 1
      || client.steps.filter(step => step.name === p.artifactBindStep && step.conclusion === 'success').length !== 1
      || byName.get(p.operationsJobName).job.conclusion !== 'skipped'
      || byName.get(p.syncJobName).job.conclusion !== 'skipped') fail();
}

/** Validate one immutable old custody record. This does not authorize writes. */
export function verifyPinnedOwnedInactiveCustody(input) {
  try {
    requireExactKeys(input, ['journalHead', 'journalBytes', 'artifact', 'run', 'jobs']);
    const operation = verifyJournal(input.journalHead, input.journalBytes);
    verifyArtifact(input.artifact);
    verifyRun(input.run);
    verifyJobs(input.jobs);
    if (operation.artifact.artifactId !== input.artifact.id || operation.artifact.digestSha256 !== input.artifact.digest.slice(7)) fail();
    const receipt = deepFreeze({
      schemaVersion: 1,
      policySHA256: ownedInactivePolicySHA256(),
      journalHead: OWNED_INACTIVE_CLIENT_POLICY.journalHead,
      journalDocumentSHA256: OWNED_INACTIVE_CLIENT_POLICY.journalDocumentSha256,
      operationSHA256: OWNED_INACTIVE_CLIENT_POLICY.oldOperationSha256,
      artifactDigestSha256: OWNED_INACTIVE_CLIENT_POLICY.artifactSha256,
      priorCandidateVersionId: OWNED_INACTIVE_CLIENT_POLICY.priorInactiveCandidateVersionId,
      parentVersionId: OWNED_INACTIVE_CLIENT_POLICY.parentVersionId,
    });
    verifiedReceipts.add(receipt);
    return receipt;
  } catch {
    throw Error('owned_inactive_custody_refused');
  }
}

/** True only for the exact frozen object returned by the verifier in this module instance. */
export function isVerifiedPinnedOwnedInactiveCustody(value) {
  return Boolean(value && typeof value === 'object' && verifiedReceipts.has(value));
}
