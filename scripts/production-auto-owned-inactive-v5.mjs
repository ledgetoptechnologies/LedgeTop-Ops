/**
 * Journal-derived owned-inactive supersession for the v5 lanes.
 *
 * A held automatic release can leave its own uploaded version as the Worker's newest (latest) version while the
 * live deployment still serves the parent alone. Under the strict latest check that blocks every later release.
 * This module lets the next main release supersede that version only when all of the following are proven:
 *
 * Custody (verifyJournalOwnedInactiveCustody, from the durable journal and the GitHub API, read-only):
 * - the journal's newest operation for this Worker is a held retained-assets release whose final held receipt names
 *   exactly this latest version as its candidate, and no other operation names it;
 * - that operation's own version upload was acknowledged (200, no error codes) on top of its recorded parent, with
 *   the module and ledger hashes it recorded; every write intent before it was acknowledged; nothing after it except
 *   one stage-zero intent that has no response at all (recorded but never acknowledged);
 * - the release run is the real production-auto-release workflow on main for that source commit, completed with
 *   failure, its Worker job failed at the release step and still uploaded and bound its sealed artifact, and the
 *   artifact the journal bound is that run's unexpired artifact with the same digest.
 *
 * Live state (verifyOwnedInactiveLiveState, against the run's own complete capture):
 * - the parent recorded at the start of the held run is still the only deployed version, at 100%, and the live
 *   deployment was created before the held run started, so none of its stage/activate requests landed;
 * - the latest version carries that run's exact upload annotations, was uploaded through the API, has the parent's
 *   exact protected resources (bindings, compatibility) and asset config, and its index.js and release ledger have
 *   the recorded hashes;
 * - with that run's upload tag projected back to the tag it started from, the protected controls equal the
 *   controls it recorded at its start.
 *
 * The resulting allowance is an in-memory brand only: it is never parsed from JSON, an environment variable or a
 * file. Anything not owned this way still refuses. It never authorizes deploying the superseded version.
 */
import { createHash } from 'node:crypto';
import { canonical, scriptRuntimeShape } from './production-deploy.mjs';
import { assertOwnedUploadAnnotations } from './production-auto-upload-tag.mjs';

const fail = () => { throw Error('owned_inactive_v5_custody_refused'); };
const need = condition => { if (!condition) fail(); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024, MAX_JOBS = 8, MAX_STEPS = 128;
export const OWNED_INACTIVE_V5_WORKFLOW_PATH = '.github/workflows/production-auto-release.yml';
const WORKERS = Object.freeze({
  'ledgetop-clients': Object.freeze({ app: 'client', job: 'release-client', step: 'Run exact-main CI-fenced Client release' }),
  'ledgetop-ops': Object.freeze({ app: 'operations', job: 'release-operations', step: 'Run exact-main CI-fenced Operations release' }),
});
const OTHER_JOBS = Object.freeze(['release-client', 'release-operations', 'release-sync']);
const UPLOAD_STEP = 'Upload only sealed provider responses';
const BIND_STEP = 'Bind encrypted artifact id and digest to the durable journal';
// Write intents a held run may have acknowledged before and including its version upload.
const PRE_UPLOAD_PHASES = new Set(['temporary-verifier-create', 'temporary-verifier-enable', 'temporary-verifier-delete',
  'asset-session', 'asset-bucket']);
const HELD_FAILURES = new Set(['release_candidate_readback_failed', 'release_stage_zero_failed']);

const custodies = new WeakMap(), allowances = new WeakMap();

function plain(value, maxKeys = 64) {
  need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(keys.length <= maxKeys && keys.every(key => typeof key === 'string'));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && Object.hasOwn(descriptor, 'value'));
  }
  return value;
}
function list(value, max) {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) need(Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, 'value'));
  return value;
}
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function selectHeldOperation(document, workerName, latestVersionId) {
  const operations = list(document.operations, 4096);
  need(operations.length > 0);
  const named = operations.filter(op => plain(op).receipts !== undefined
    && list(op.receipts, 64).some(row => plain(row).candidateVersionId === latestVersionId));
  need(named.length === 1);
  const op = named[0];
  // The held run must be this Worker's newest journal operation that recorded any write intent. Later operations
  // are allowed only if they never attempted a write (no intents; every receipt writesAttempted !== true), e.g. a
  // later run that held before preparing; anything that may have written after it refuses.
  need(iso(op.updatedAt) && operations.filter(row => row.updatedAt === op.updatedAt).length === 1);
  for (const row of operations) {
    // Every operation's timestamps must parse before comparing; an unparsable date would otherwise skip a row.
    need(iso(row.createdAt) && iso(row.updatedAt));
    if (row === op || !(Date.parse(row.updatedAt) > Date.parse(op.updatedAt) || Date.parse(row.createdAt) > Date.parse(op.createdAt))) continue;
    need(list(row.intents, 512).length === 0 && list(row.responses, 512).length === 0
      && list(row.receipts, 64).every(receipt => plain(receipt).writesAttempted !== true));
  }
  need(op.workerName === workerName && op.releaseKind === 'retained-assets' && op.state === 'held'
    && COMMIT.test(op.sourceCommit ?? '') && SHA.test(op.releaseId ?? '')
    && op.releaseId === sha256(`${workerName}\n${op.sourceCommit}`) && iso(op.createdAt) && iso(op.updatedAt));
  return op;
}

function verifyReceipts(op, latestVersionId) {
  const receipts = list(op.receipts, 64);
  const statuses = receipts.map(row => plain(row).status);
  need(receipts.length >= 3 && statuses[0] === 'started' && statuses[1] === 'prepared' && statuses.at(-1) === 'held'
    && statuses.slice(2, -1).every(status => status === 'inactive-verified') && statuses.length <= 4);
  const [started, prepared] = receipts, held = receipts.at(-1);
  need(started.phase === 'prepare' && started.writesAttempted === false && UUID.test(started.parentVersionId ?? '')
    && SHA.test(started.controlsSHA256 ?? '') && Object.hasOwn(started, 'ownedUploadTagBaseline')
    && (started.ownedUploadTagBaseline === null || /^auto-[a-f0-9]{12}$/u.test(started.ownedUploadTagBaseline)));
  need(prepared.phase === 'prepare' && prepared.ledgerSHA256 === op.runtime?.ledgerSha256);
  for (const row of receipts.slice(2, -1)) need(row.candidateVersionId === latestVersionId);
  need(held.writesAttempted === true && held.candidateVersionId === latestVersionId && HELD_FAILURES.has(held.failureCode));
  return { parentVersionId: started.parentVersionId, controlsSHA256: started.controlsSHA256,
    ownedUploadTagBaseline: started.ownedUploadTagBaseline };
}

function verifyIntents(op, parentVersionId) {
  const intents = list(op.intents, 512), responses = list(op.responses, 512);
  const byRequest = new Map();
  for (const value of responses) {
    const response = plain(value);
    need(UUID.test(response.requestId ?? '') && !byRequest.has(response.requestId)); byRequest.set(response.requestId, response);
  }
  const acknowledged = intent => {
    const response = byRequest.get(intent.requestId);
    return response && response.providerAcknowledged === true && [200, 201, 202].includes(response.status)
      && Array.isArray(response.errorCodes) && response.errorCodes.length === 0;
  };
  const uploads = intents.map((value, index) => [plain(value), index]).filter(([intent]) => intent.phase === 'worker-version-upload');
  need(uploads.length === 1);
  const [upload, uploadIndex] = uploads[0];
  const ids = new Set();
  intents.forEach((intent, index) => {
    need(intent.sequence === index + 1 && intent.workerName === op.workerName && intent.automaticRetry === false
      && UUID.test(intent.requestId ?? '') && !ids.has(intent.requestId));
    ids.add(intent.requestId);
    if (index < uploadIndex) need(PRE_UPLOAD_PHASES.has(intent.phase) && acknowledged(intent));
  });
  need(acknowledged(upload) && byRequest.get(upload.requestId).status === 200 && upload.method === 'POST'
    && upload.parentVersionId === parentVersionId && plain(upload.modules, 8)
    && upload.modules['index.js'] === op.runtime.moduleSha256
    && upload.modules['__ops_release_ledger.json'] === op.runtime.ledgerSha256);
  const after = intents.slice(uploadIndex + 1);
  // At most the one stage-zero intent may follow, and it was never acknowledged: no response row at all.
  need(after.length <= 1 && after.every(intent => intent.phase === 'stage-zero-percent' && !byRequest.has(intent.requestId)
    && intent.parentVersionId === parentVersionId));
  // Every response belongs to an intent; nothing else was recorded as acknowledged.
  need([...byRequest.keys()].every(id => ids.has(id)));
}

function verifyRun(op, run, jobs, artifact, worker) {
  plain(run);
  need(run.id === op.workflow.runId && run.run_attempt === op.workflow.runAttempt && run.path === OWNED_INACTIVE_V5_WORKFLOW_PATH
    && run.event === 'workflow_run' && run.head_branch === 'main' && run.head_sha === op.sourceCommit
    && run.status === 'completed' && run.conclusion === 'failure');
  plain(jobs, 16);
  const rows = list(jobs.jobs, MAX_JOBS);
  need(jobs.total_count === rows.length);
  const byName = new Map();
  for (const value of rows) {
    const job = plain(value);
    need(typeof job.name === 'string' && OTHER_JOBS.includes(job.name) && !byName.has(job.name));
    const steps = list(job.steps, MAX_STEPS).map(step => plain(step));
    need(new Set(steps.map(step => step.name)).size === steps.length);
    byName.set(job.name, { job, steps });
  }
  const own = byName.get(worker.job);
  need(own && own.job.conclusion === 'failure'
    && own.steps.filter(step => step.name === worker.step && step.conclusion === 'failure').length === 1
    && own.steps.filter(step => step.name === UPLOAD_STEP && step.conclusion === 'success').length === 1
    && own.steps.filter(step => step.name === BIND_STEP && step.conclusion === 'success').length === 1);
  for (const [name, { job }] of byName) if (name !== worker.job) need(job.conclusion === 'skipped');
  plain(op.artifact);
  need(op.artifact.runId === op.workflow.runId && op.artifact.runAttempt === op.workflow.runAttempt
    && op.artifact.releaseStepConclusion === 'failure' && op.artifact.uploadStepConclusion === 'success'
    && SHA.test(op.artifact.digestSha256 ?? '') && op.artifact.name === `production-auto-${op.releaseId}`);
  plain(artifact);
  need(artifact.id === op.artifact.artifactId && artifact.name === op.artifact.name && artifact.expired === false
    && artifact.digest === `sha256:${op.artifact.digestSha256}`);
  plain(artifact.workflow_run);
  need(artifact.workflow_run.id === op.workflow.runId && artifact.workflow_run.head_branch === 'main'
    && artifact.workflow_run.head_sha === op.sourceCommit);
}

/** Read-only custody proof for one held run's inactive upload. Grants nothing by itself. */
export function verifyJournalOwnedInactiveCustody({ workerName, latestVersionId, sourceCommit, journalHead, journalBytes,
  run, jobs, artifact } = {}) {
  try {
    const worker = WORKERS[workerName];
    need(worker && UUID.test(latestVersionId ?? '') && COMMIT.test(sourceCommit ?? '') && COMMIT.test(journalHead ?? '')
      && Buffer.isBuffer(journalBytes) && journalBytes.length > 0 && journalBytes.length <= MAX_JOURNAL_BYTES);
    let document;
    try { document = JSON.parse(journalBytes.toString('utf8')); } catch { fail(); }
    plain(document, 4);
    need(document.schemaVersion === 1 && document.workerName === workerName
      && Buffer.from(canonical(document) + '\n', 'utf8').equals(journalBytes));
    const op = selectHeldOperation(document, workerName, latestVersionId);
    // A held commit is superseded by a newer main release, never re-run over itself.
    need(op.sourceCommit !== sourceCommit);
    plain(op.runtime); plain(op.workflow); plain(op.ci);
    need(SHA.test(op.runtime.moduleSha256 ?? '') && SHA.test(op.runtime.ledgerSha256 ?? '')
      && Number.isSafeInteger(op.workflow.runId) && op.workflow.runId > 0
      && Number.isSafeInteger(op.workflow.runAttempt) && op.workflow.runAttempt > 0);
    const started = verifyReceipts(op, latestVersionId);
    verifyIntents(op, started.parentVersionId);
    verifyRun(op, run, jobs, artifact, worker);
    const custody = deepFreeze({ schemaVersion: 1, kind: 'owned-inactive-v5-custody', workerName, app: worker.app,
      journalHead, journalDocumentSHA256: sha256(journalBytes), operationSHA256: sha256(Buffer.from(canonical(op), 'utf8')),
      oldReleaseId: op.releaseId, oldSourceCommit: op.sourceCommit, oldWorkflowRunId: op.workflow.runId,
      oldCreatedAt: op.createdAt, artifactDigestSHA256: op.artifact.digestSha256,
      parentVersionId: started.parentVersionId, candidateVersionId: latestVersionId,
      controlsSHA256: started.controlsSHA256, ownedUploadTagBaseline: started.ownedUploadTagBaseline,
      moduleSHA256: op.runtime.moduleSha256, ledgerSHA256: op.runtime.ledgerSha256, newSourceCommit: sourceCommit });
    custodies.set(custody, true);
    return custody;
  } catch { throw Error('owned_inactive_v5_custody_refused'); }
}

export function isOwnedInactiveV5Custody(value) { return Boolean(value && typeof value === 'object' && custodies.has(value)); }

function moduleHash(modern, name, expected) {
  const rows = list(modern?.modules, 64).filter(row => row?.name === name);
  need(rows.length === 1 && typeof rows[0].content_base64 === 'string' && rows[0].content_base64.length > 0
    && rows[0].content_base64.length <= 32 * 1024 * 1024);
  const bytes = Buffer.from(rows[0].content_base64, 'base64');
  need(bytes.toString('base64') === rows[0].content_base64 && sha256(bytes) === expected);
}
function protectedResources(resources) {
  const copy = structuredClone(resources);
  need(copy?.script && typeof copy.script === 'object');
  delete copy.script.etag; delete copy.script.last_deployed_from;
  copy.script_runtime = scriptRuntimeShape(copy.script_runtime); return copy;
}

/**
 * Checks the live state of the custody's Worker inside the run's own complete capture. `projectedControlsSHA256`
 * is the run's protected-controls digest computed with the held run's upload tag projected back to the tag it
 * started from (see projectOwnedUploadTagSettings). Returns the in-memory allowance brand.
 */
export function verifyOwnedInactiveLiveState(custody, { snapshot, projectedControlsSHA256 } = {}) {
  try {
    need(isOwnedInactiveV5Custody(custody) && SHA.test(projectedControlsSHA256 ?? ''));
    const state = snapshot?.[custody.app];
    const parent = custody.parentVersionId, candidate = custody.candidateVersionId;
    need(state?.version?.id === parent && state.modern?.id === parent && state.latest === candidate
      && state.latestVersion?.id === candidate && state.latestModern?.id === candidate
      && canonical(state.deployment?.versions) === canonical([{ version_id: parent, percentage: 100 }])
      && iso(new Date(Date.parse(state.deployment?.created_on)).toISOString())
      && Date.parse(state.deployment.created_on) < Date.parse(custody.oldCreatedAt));
    assertOwnedUploadAnnotations(state, { workerName: custody.workerName, sourceCommit: custody.oldSourceCommit,
      candidateVersionId: candidate });
    need(state.latestVersion.resources?.script?.last_deployed_from === 'api'
      && canonical(protectedResources(state.latestVersion.resources)) === canonical(protectedResources(state.version.resources))
      && canonical(state.latestModern.assets?.config ?? null) === canonical(state.modern.assets?.config ?? null));
    moduleHash(state.latestModern, 'index.js', custody.moduleSHA256);
    moduleHash(state.latestModern, '__ops_release_ledger.json', custody.ledgerSHA256);
    need(projectedControlsSHA256 === custody.controlsSHA256);
    const allowance = deepFreeze({ schemaVersion: 1, kind: 'owned-inactive-v5-allowance', workerName: custody.workerName,
      app: custody.app, parentVersionId: parent, supersededVersionId: candidate, supersededReleaseId: custody.oldReleaseId,
      newSourceCommit: custody.newSourceCommit });
    allowances.set(allowance, custody);
    return allowance;
  } catch { throw Error('owned_inactive_v5_custody_refused'); }
}

export function isOwnedInactiveV5Allowance(value) { return Boolean(value && typeof value === 'object' && allowances.has(value)); }

/** The coordinator's initial state: the parent alone at 100% and exactly the superseded version as latest. */
export function ownedInactiveV5BaselineAllowed(allowance, { workerName, sourceCommit, baseline }) {
  try {
    return isOwnedInactiveV5Allowance(allowance) && allowance.workerName === workerName
      && allowance.newSourceCommit === sourceCommit && baseline?.activeVersionId === allowance.parentVersionId
      && baseline.latestVersionId === allowance.supersededVersionId
      && canonical(baseline.versions) === canonical([{ versionId: allowance.parentVersionId, percentage: 100 }]);
  } catch { return false; }
}

/** The provider's pre-upload state check for the one superseding version upload. */
export function ownedInactiveV5ProviderParentAllowed(allowance, { workerName, parentVersionId, state }) {
  try {
    return isOwnedInactiveV5Allowance(allowance) && allowance.workerName === workerName
      && parentVersionId === allowance.parentVersionId && state?.version?.id === allowance.parentVersionId
      && state.latest === allowance.supersededVersionId
      && canonical(state.deployment?.versions) === canonical([{ version_id: allowance.parentVersionId, percentage: 100 }]);
  } catch { return false; }
}
