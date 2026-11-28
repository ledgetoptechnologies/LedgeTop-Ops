// Synthetic held-run custody and live state for the v5 owned-inactive supersession. Mints a genuine in-memory
// allowance only through the real verifiers; nothing here is production data.
import { createHash } from 'node:crypto';
import { canonical } from '../production-deploy.mjs';
import { verifyJournalOwnedInactiveCustody, verifyOwnedInactiveLiveState,
  OWNED_INACTIVE_V5_WORKFLOW_PATH } from '../production-auto-owned-inactive-v5.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const JOBS = { 'ledgetop-clients': ['release-client', 'Run exact-main CI-fenced Client release', 'client'],
  'ledgetop-ops': ['release-operations', 'Run exact-main CI-fenced Operations release', 'operations'] };

export const STAGED_DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000600';
export function mintOwnedInactiveV5Allowance({ workerName, parentVersionId, supersededVersionId, newSourceCommit,
  oldSourceCommit = 'a'.repeat(40), staged = false }) {
  const [jobName, stepName, app] = JOBS[workerName];
  const module = Buffer.from('export default {}'), ledger = Buffer.from('{"ledger":true}');
  const releaseId = sha(`${workerName}\n${oldSourceCommit}`), runId = 9001, artifactId = 7001, digest = 'd'.repeat(64);
  const request = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const phases = [['temporary-verifier-create', 'PUT'], ['asset-session', 'POST'], ['worker-version-upload', 'POST'],
    ...(staged ? [['stage-zero-percent', 'POST'], ['temporary-verifier-create', 'PUT'], ['temporary-verifier-enable', 'POST']] : [])];
  const intents = phases.map(([phase, method], i) => ({ automaticRetry: false, hashes: [], method, phase, requestId: request(i + 1),
    sequence: i + 1, workerName, ...(phase.startsWith('temporary-verifier-') ? { temporaryWorkerName: 'ops-ui-verify-0123456789abcdef01234567' } : {}),
    ...(phase === 'worker-version-upload' ? { parentVersionId,
      modules: { '__ops_release_ledger.json': sha(ledger), 'index.js': sha(module), 'index.js.map': '7'.repeat(64) } } : {}),
    ...(phase === 'stage-zero-percent' ? { parentVersionId, candidateVersionId: supersededVersionId,
      versions: [{ percentage: 100, versionId: parentVersionId }, { percentage: 0, versionId: supersededVersionId }] } : {}) }));
  // A staged held run's last write (the verifier enable) was never acknowledged.
  const responses = intents.filter(intent => !(staged && intent.phase === 'temporary-verifier-enable')).map(intent => ({ ciphertextBytes: 1, ciphertextFile: `responses/${intent.requestId}.sealed.json`,
    ciphertextSha256: 'f'.repeat(64), errorCodes: [], providerAcknowledged: true, requestId: intent.requestId, responseBytes: 1,
    responseSha256: '9'.repeat(64), status: 200 }));
  const op = { artifact: { artifactId, digestSha256: digest, name: `production-auto-${releaseId}`, releaseStepConclusion: 'failure',
    runAttempt: 1, runId, uploadStepConclusion: 'success' }, ci: { runAttempt: 1, runId: 8001 }, createdAt: '2026-11-27T23:17:52.650Z',
    intents, releaseId, releaseKind: 'retained-assets', responses, sourceCommit: oldSourceCommit, state: 'held',
    updatedAt: '2026-11-27T23:26:44.476Z', workerName, workflow: { runAttempt: 1, runId },
    runtime: { ledgerSha256: sha(ledger), moduleSha256: sha(module), profileSha256: '4'.repeat(64) },
    receipts: [
      { controlsSHA256: '5'.repeat(64), ownedUploadTagBaseline: null, parentVersionId, phase: 'prepare', status: 'started', writesAttempted: false },
      { ledgerSHA256: sha(ledger), phase: 'prepare', status: 'prepared' },
      ...(staged ? [{ candidateVersionId: supersededVersionId, phase: 'candidate-readback', status: 'inactive-verified' },
        { candidateVersionId: supersededVersionId, deploymentId: STAGED_DEPLOYMENT_ID, phase: 'stage-zero', status: 'zero-percent-verified' }] : []),
      { candidateVersionId: supersededVersionId, failureCode: staged ? 'release_candidate_assets_failed' : 'release_candidate_readback_failed',
        phase: staged ? 'candidate-assets' : 'candidate-readback', status: 'held', writesAttempted: true }] };
  const document = { operations: [op], schemaVersion: 1, sequence: 1, workerName };
  const custody = verifyJournalOwnedInactiveCustody({ workerName, latestVersionId: supersededVersionId, sourceCommit: newSourceCommit,
    journalHead: 'c'.repeat(40), journalBytes: Buffer.from(canonical(document) + '\n', 'utf8'),
    run: { id: runId, run_attempt: 1, path: OWNED_INACTIVE_V5_WORKFLOW_PATH, event: 'workflow_run', head_branch: 'main',
      head_sha: oldSourceCommit, status: 'completed', conclusion: 'failure' },
    jobs: { total_count: 1, jobs: [{ name: jobName, conclusion: 'failure', steps: [{ name: stepName, conclusion: 'failure' },
      { name: 'Upload only sealed provider responses', conclusion: 'success' },
      { name: 'Bind encrypted artifact id and digest to the durable journal', conclusion: 'success' }] }] },
    artifact: { id: artifactId, name: op.artifact.name, expired: false, digest: `sha256:${digest}`,
      workflow_run: { id: runId, head_branch: 'main', head_sha: oldSourceCommit } } });
  const resources = { bindings: [{ name: 'ASSETS', type: 'assets' }],
    script: { etag: 'p', last_deployed_from: 'wrangler' }, script_runtime: { compatibility_date: '2026-01-01' } };
  const annotations = { 'workers/tag': `auto-${oldSourceCommit.slice(0, 12)}`,
    'workers/message': `Retained assets release ${oldSourceCommit.slice(0, 12)}`, 'workers/triggered_by': 'version_upload' };
  const snapshot = { [app]: {
    deployment: staged
      ? { id: STAGED_DEPLOYMENT_ID, created_on: '2026-11-27T23:24:00.000000Z', versions: [{ version_id: parentVersionId, percentage: 100 },
        { version_id: supersededVersionId, percentage: 0 }] }
      : { id: request(500), created_on: '2026-11-27T17:30:36.136610Z', versions: [{ version_id: parentVersionId, percentage: 100 }] },
    latest: supersededVersionId, version: { id: parentVersionId, resources: structuredClone(resources) },
    modern: { id: parentVersionId, assets: { config: {} } },
    latestVersion: { id: supersededVersionId, annotations: structuredClone(annotations),
      resources: { ...structuredClone(resources), script: { etag: 'c', last_deployed_from: 'api' } } },
    latestModern: { id: supersededVersionId, assets: { config: {} }, modules: [
      { name: 'index.js', content_base64: module.toString('base64') },
      { name: '__ops_release_ledger.json', content_base64: ledger.toString('base64') }] },
    settings: { annotations: structuredClone(annotations) } } };
  return verifyOwnedInactiveLiveState(custody, { snapshot, projectedControlsSHA256: '5'.repeat(64) });
}
