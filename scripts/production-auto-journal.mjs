/**
 * Durable, credential-free release journal for the automatic retained-asset
 * release path. The journal is a fast-forward-only commit chain on one fixed
 * GitHub ref per Worker. Provider responses are sealed to a separately pinned
 * operator public key before being written to the run's artifact directory;
 * plaintext bodies never enter the public Git journal or workflow logs.
 *
 * The public recipient is pinned in source. Its presence permits encryption
 * only; separate release policy, authority, readiness, and credential gates
 * still control whether any production operation can proceed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, publicEncrypt, randomBytes, constants, createPublicKey } from 'node:crypto';
import { PRODUCTION_AUTO_JOURNAL_RECIPIENT } from './production-auto-private-recipient.mjs';
import { isProviderUtcTimestamp, minimumRetainedUntil } from './production-auto-time.mjs';
import { PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS, PRODUCTION_AUTO_MAX_INTENTS_PER_RELEASE } from './production-auto-limits.mjs';

const REPO = 'ledgetoptechnologies/LedgeTop-Ops';
const API = `https://api.github.com/repos/${REPO}`;
const JOURNAL_PATH = 'production-auto-journal.json';
const WORKERS = new Set(['ledgetop-ops', 'ledgetop-clients', 'ledgetop-ops-sync']);
const RELEASE_KINDS = new Set(['retained-assets', 'backend-sync']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u, COMMIT = /^[0-9a-f]{40}$/u;
const RETAINED_PHASES = new Set(['asset-session','asset-bucket','worker-version-upload','stage-zero-percent','activate-candidate',
  'temporary-verifier-create','temporary-verifier-enable','temporary-verifier-delete']);
const SYNC_PHASES = new Set(['sync-version-upload','sync-activate-candidate']);
const PHASES = new Set([...RETAINED_PHASES, ...SYNC_PHASES]);
const METHODS = new Set(['POST','PUT','DELETE']);
const MAX_RESPONSE = 32 * 1024 * 1024, MAX_GITHUB_BODY = 8 * 1024 * 1024, MAX_STATE = 4 * 1024 * 1024;
const MAX_PRIVATE_ARTIFACT = 256 * 1024 * 1024;
const MAX_OPERATIONS = 2048, MAX_INTENTS_PER_RELEASE = PRODUCTION_AUTO_MAX_INTENTS_PER_RELEASE;
const hash = value => createHash('sha256').update(value).digest('hex');
const need = condition => { if (!condition) throw new Error('production_auto_journal_refused_no_retry'); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value); need(encoded !== undefined); return encoded;
  }
  need(Object.getPrototypeOf(value) === Object.prototype);
  const keys = Object.keys(value).sort(); need(Reflect.ownKeys(value).length === keys.length);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function checkedRecipient(value) {
  need(exact(value, ['schemaVersion','keyIdSha256','publicKeyPem']) && value.schemaVersion === 1
    && SHA.test(value.keyIdSha256) && value.keyIdSha256 !== '0'.repeat(64)
    && typeof value.publicKeyPem === 'string' && value.publicKeyPem.length > 128 && value.publicKeyPem.length <= 16 * 1024);
  let publicKey;
  try { publicKey = createPublicKey(value.publicKeyPem); } catch { need(false); }
  need(publicKey.asymmetricKeyType === 'rsa' && (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072
    && hash(publicKey.export({ type: 'spki', format: 'der' })) === value.keyIdSha256);
  return publicKey;
}

/** Testable cryptographic primitive; production callers only pass the pinned
 * recipient loaded by the CLI. AAD binds the ciphertext to its release and
 * request identity so a sealed body cannot be swapped between journal rows. */
export function sealProductionProviderResponse(plaintext, context, recipient) {
  need(Buffer.isBuffer(plaintext) && plaintext.length <= MAX_RESPONSE
    && exact(context, ['releaseId','requestId','method','pathSha256','status'])
    && SHA.test(context.releaseId) && UUID.test(context.requestId) && METHODS.has(context.method)
    && SHA.test(context.pathSha256) && (context.status === null || Number.isInteger(context.status) && context.status >= 100 && context.status <= 599));
  const publicKey = checkedRecipient(recipient), keyId = recipient.keyIdSha256;
  const dataKey = randomBytes(32), nonce = randomBytes(12), aad = Buffer.from(canonical({ schemaVersion: 1, algorithm: 'RSA-OAEP-256+A256GCM', keyId, context }));
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, dataKey);
  dataKey.fill(0);
  const envelope = { schemaVersion: 1, algorithm: 'RSA-OAEP-256+A256GCM', keyIdSha256: keyId,
    context: structuredClone(context), nonce: nonce.toString('base64'), wrappedKey: wrappedKey.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  const bytes = Buffer.from(canonical(envelope) + '\n', 'utf8');
  need(bytes.length <= 48 * 1024 * 1024);
  return Object.freeze({ bytes, sha256: hash(bytes), plaintextSha256: hash(plaintext) });
}

export function loadPinnedProductionAutoRecipient() {
  // No environment override: the public key and fingerprint move together in
  // a reviewed source change; mismatches fail closed in checkedRecipient.
  const pinned = PRODUCTION_AUTO_JOURNAL_RECIPIENT;
  checkedRecipient(pinned);
  return Object.freeze({
    schemaVersion: pinned.schemaVersion,
    keyIdSha256: pinned.keyIdSha256,
    publicKeyPem: pinned.publicKeyPem,
  });
}

function safeRuntime(value) {
  need(exact(value, ['profileSha256','moduleSha256','ledgerSha256'])
    && [value.profileSha256,value.moduleSha256].every(item => SHA.test(item))
    && (value.ledgerSha256 === null || SHA.test(value.ledgerSha256)));
  return { profileSha256: value.profileSha256, moduleSha256: value.moduleSha256, ledgerSha256: value.ledgerSha256 };
}

function intentProjection(value) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value')));
  const isProviderRequest = UUID.test(value.requestId ?? '');
  need(isProviderRequest && PHASES.has(value.phase) && value.automaticRetry === false);
  const requestId = value.requestId;
  need(UUID.test(requestId));
  const method = value.method ?? 'POST'; need(METHODS.has(method));
  let pathValue = value.path;
  if (pathValue === undefined) {
    const phasePath = { 'asset-session': '/workers/scripts/{worker}/assets-upload-session', 'asset-bucket': '/workers/assets/upload?base64=true' };
    pathValue = phasePath[value.phase];
  }
  need(typeof pathValue === 'string' && pathValue.length <= 512 && pathValue.startsWith('/workers/')
    && !pathValue.includes('..') && !pathValue.includes('//') && !/[?#].*token=/iu.test(pathValue));
  const hashes = value.hashes ?? [];
  need(Array.isArray(hashes) && hashes.length <= 20_000 && hashes.every(item => /^[a-f0-9]{32}$/u.test(item)));
  const intent = { requestId, method, phase: value.phase, pathSha256: hash(pathValue), hashes: [...hashes].sort(), automaticRetry: false };
  if (value.workerName !== undefined) { need(WORKERS.has(value.workerName)); intent.workerName = value.workerName; }
  if (value.parentVersionId !== undefined) { need(UUID.test(value.parentVersionId)); intent.parentVersionId = value.parentVersionId; }
  if (value.candidateVersionId !== undefined) { need(UUID.test(value.candidateVersionId)); intent.candidateVersionId = value.candidateVersionId; }
  if (value.modules !== undefined) {
    const moduleKeys = value.phase === 'sync-version-upload' ? ['index.js','index.js.map']
      : ['index.js','index.js.map','__ops_release_ledger.json'];
    need(exact(value.modules, moduleKeys)
      && Object.values(value.modules).every(item => SHA.test(item)));
    intent.modules = structuredClone(value.modules);
  }
  if (value.name !== undefined) { need(/^ops-ui-verify-[a-f0-9]{24}$/u.test(value.name)); intent.temporaryWorkerName = value.name; }
  if (value.versions !== undefined) {
    need(Array.isArray(value.versions) && value.versions.length >= 1 && value.versions.length <= 2
      && value.versions.every(row => UUID.test(row.version_id) && Number.isInteger(row.percentage) && row.percentage >= 0 && row.percentage <= 100));
    intent.versions = value.versions.map(row => ({ versionId: row.version_id, percentage: row.percentage }));
  }
  if (value.sourceSHA256 !== undefined) { need(SHA.test(value.sourceSHA256)); intent.sourceSHA256 = value.sourceSHA256; }
  if (value.coordinatorFence !== undefined) {
    const fence = value.coordinatorFence;
    need(fence === null || exact(fence, ['sourceCommit','workerName','phase','hashes','parentVersionId','candidateVersionId'])
      && fence.sourceCommit === value.sourceCommit && fence.workerName === value.workerName
      && typeof fence.phase === 'string' && fence.phase.length <= 32 && Array.isArray(fence.hashes)
      && fence.hashes.length <= 20_000 && fence.hashes.every(item => /^[a-f0-9]{32}$/u.test(item))
      && UUID.test(fence.parentVersionId) && (fence.candidateVersionId === undefined || UUID.test(fence.candidateVersionId)));
    intent.coordinatorFence = fence === null ? null : structuredClone(fence);
  }
  return intent;
}

function responseProjection(value, intent, releaseId, recipient, responseDirectory) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && UUID.test(value.requestId ?? '')
    && value.requestId === intent.requestId && value.method === intent.method && typeof value.path === 'string'
    && value.path.length <= 512 && hash(value.path) === intent.pathSha256
    && (value.status === null || Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)
    && (value.rawResponse === undefined || Buffer.isBuffer(value.rawResponse))
    && (value.errorCodes === undefined || Array.isArray(value.errorCodes) && value.errorCodes.length <= 32
      && value.errorCodes.every(code => Number.isSafeInteger(code))));
  const raw = value.rawResponse ?? Buffer.alloc(0); need(raw.length <= MAX_RESPONSE);
  let providerSuccess = intent.phase === 'temporary-verifier-delete' && intent.method === 'DELETE' && value.status === 404;
  let errorCodes = value.errorCodes ?? [];
  if (raw.length) {
    try {
      const body = JSON.parse(raw.toString('utf8'));
      if (Array.isArray(body?.errors)) errorCodes = body.errors.slice(0, 32).map(error => error?.code).filter(Number.isSafeInteger);
      providerSuccess ||= [200,201,202].includes(value.status) && body?.success === true
        && body.result !== undefined && (body.errors == null || Array.isArray(body.errors) && body.errors.length === 0);
    } catch { /* malformed response is retained only as encrypted bytes */ }
  }
  const context = { releaseId, requestId: intent.requestId, method: intent.method,
    pathSha256: intent.pathSha256, status: value.status };
  let sealed = null;
  if (raw.length) sealed = sealProductionProviderResponse(raw, context, recipient);
  const filename = sealed ? `${intent.requestId}.sealed.json` : null;
  if (sealed) writeSealedFile(path.join(responseDirectory, 'responses'), filename, sealed.bytes);
  return { requestId: intent.requestId, status: value.status, providerAcknowledged: providerSuccess,
    errorCodes: errorCodes.slice(0,32), responseSha256: hash(raw), responseBytes: raw.length,
    ...(value.incomplete === true ? { incomplete: true } : {}),
    ...(sealed ? { ciphertextFile: `responses/${filename}`, ciphertextSha256: sealed.sha256, ciphertextBytes: sealed.bytes.length } : {}) };
}

function writeSealedFile(directory, filename, bytes) {
  need(typeof directory === 'string' && path.isAbsolute(directory) && /^[0-9a-f-]{36}\.sealed\.json$/u.test(filename));
  const absolute = path.resolve(directory), components = [];
  for (let current = absolute;; current = path.dirname(current)) { components.unshift(current); if (path.dirname(current) === current) break; }
  for (const current of components) {
    let componentStat;
    try { componentStat = fs.lstatSync(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw Error('production_auto_response_directory_failed');
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (createError) {
        if (createError?.code !== 'EEXIST') throw Error('production_auto_response_directory_failed');
      }
      componentStat = fs.lstatSync(current);
    }
    need(componentStat.isDirectory() && !componentStat.isSymbolicLink());
  }
  const dirStat = fs.lstatSync(directory); need(dirStat.isDirectory() && !dirStat.isSymbolicLink());
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const prior = path.join(directory, entry.name), stat = fs.lstatSync(prior);
    need(entry.isFile() && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    total += stat.size; need(total <= MAX_PRIVATE_ARTIFACT);
  }
  need(total + bytes.length <= MAX_PRIVATE_ARTIFACT);
  const target = path.join(directory, filename), temporary = path.join(directory, `.${filename}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
    const st = fs.lstatSync(target); need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size === bytes.length);
  } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(temporary); } catch {} throw Error('production_auto_response_seal_write_failed'); }
}

function safeReceipt(value, workerName, sourceCommit, releaseKind) {
  need(value && value.schemaVersion === 1 && value.workerName === workerName && value.sourceCommit === sourceCommit
    && ['started','prepared','inactive-verified','zero-percent-verified','candidate-assets-verified','verified','held'].includes(value.status)
    && typeof value.phase === 'string' && value.phase.length <= 32);
  if (value.status === 'prepared') need(releaseKind === 'backend-sync'
    ? SHA.test(value.moduleSHA256 ?? '') && value.ledgerSHA256 === undefined
    : SHA.test(value.ledgerSHA256 ?? '') && value.moduleSHA256 === undefined);
  const out = { status: value.status, phase: value.phase };
  const copySha = key => { if (value[key] !== undefined) { need(SHA.test(value[key])); out[key] = value[key]; } };
  const copyUuid = key => { if (value[key] !== undefined) { need(UUID.test(value[key])); out[key] = value[key]; } };
  for (const key of ['controlsSHA256','ledgerSHA256']) copySha(key);
  if (value.moduleSHA256 !== undefined) { need(releaseKind === 'backend-sync' && SHA.test(value.moduleSHA256)); out.moduleSHA256 = value.moduleSHA256; }
  for (const key of ['parentVersionId','candidateVersionId','deploymentId']) copyUuid(key);
  if (value.files !== undefined) { need(Number.isSafeInteger(value.files) && value.files >= 0 && value.files <= 20_000); out.files = value.files; }
  if (value.minimumRetentionHours !== undefined) { need(value.minimumRetentionHours === 48); out.minimumRetentionHours = 48; }
  if (value.automaticPruning !== undefined) { need(value.automaticPruning === false); out.automaticPruning = false; }
  if (value.allHistoricalAssetsCarried !== undefined) { need(value.allHistoricalAssetsCarried === true); out.allHistoricalAssetsCarried = true; }
  if (value.verifiedActive !== undefined) { need(value.verifiedActive === true); out.verifiedActive = true; }
  if (value.writesAttempted !== undefined) { need(typeof value.writesAttempted === 'boolean'); out.writesAttempted = value.writesAttempted; }
  if (value.failureCode !== undefined) {
    need(['release_initial_failed','release_prepare_failed','release_upload_failed','release_candidate_readback_failed',
      'release_stage_zero_failed','release_candidate_assets_failed','release_activate_failed','release_active_assets_failed',
      'release_complete_failed','release_sync_prepare_failed','release_sync_upload_failed',
      'release_sync_candidate_readback_failed','release_sync_activate_failed','release_sync_verify_failed'].includes(value.failureCode));
    out.failureCode = value.failureCode;
  }
  if (value.reconciliationCode !== undefined) {
    need(['not_attempted','read_succeeded','read_failed'].includes(value.reconciliationCode));
    out.reconciliationCode = value.reconciliationCode;
  }
  for (const key of ['cutoverObservedAt','earliestPermittedPruningAt']) if (value[key] !== undefined) {
    const valid = key === 'cutoverObservedAt' ? isProviderUtcTimestamp(value[key])
      : typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])) && new Date(value[key]).toISOString() === value[key];
    need(valid); out[key] = value[key];
  }
  if (value.reconciliation !== undefined) {
    const r = value.reconciliation; need(exact(r, ['readSucceeded']) || r && Object.getPrototypeOf(r) === Object.prototype);
    const projected = { readSucceeded: r.readSucceeded === true };
    for (const key of ['activeVersionId','latestVersionId','deploymentId']) if (r[key] !== undefined) { need(UUID.test(r[key])); projected[key] = r[key]; }
    if (r.controlsUnchanged !== undefined) { need(typeof r.controlsUnchanged === 'boolean'); projected.controlsUnchanged = r.controlsUnchanged; }
    out.reconciliation = projected;
  }
  return out;
}

function parseJsonResponse(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw Error('production_auto_journal_api_refused_no_retry'); } }
function storedOperation(op) {
  need(exact(op, ['releaseId','workerName','sourceCommit','releaseKind','runtime','ci','workflow','state','createdAt','updatedAt','intents','receipts','responses','artifact'])
    && SHA.test(op.releaseId) && WORKERS.has(op.workerName) && COMMIT.test(op.sourceCommit)
    && RELEASE_KINDS.has(op.releaseKind) && (op.workerName === 'ledgetop-ops-sync'
      ? op.releaseKind === 'backend-sync' : op.releaseKind === 'retained-assets')
    && ['in_progress','held','verified-pending-artifact','verified'].includes(op.state)
    && Number.isFinite(Date.parse(op.createdAt)) && new Date(op.createdAt).toISOString() === op.createdAt
    && Number.isFinite(Date.parse(op.updatedAt)) && new Date(op.updatedAt).toISOString() === op.updatedAt);
  safeRuntime(op.runtime);
  need(exact(op.ci, ['runId','runAttempt']) && Number.isSafeInteger(op.ci.runId) && op.ci.runId > 0
    && Number.isSafeInteger(op.ci.runAttempt) && op.ci.runAttempt > 0
    && exact(op.workflow, ['runId','runAttempt']) && Number.isSafeInteger(op.workflow.runId) && op.workflow.runId > 0
    && Number.isSafeInteger(op.workflow.runAttempt) && op.workflow.runAttempt > 0
    && Array.isArray(op.intents) && op.intents.length <= MAX_INTENTS_PER_RELEASE
    && Array.isArray(op.receipts) && op.receipts.length <= 64 && Array.isArray(op.responses) && op.responses.length <= MAX_INTENTS_PER_RELEASE);
  const ids = new Set();
  for (let i = 0; i < op.intents.length; i++) {
    const row = op.intents[i], allowed = ['sequence','requestId','method','phase','pathSha256','hashes','automaticRetry','workerName','parentVersionId',
      'candidateVersionId','modules','temporaryWorkerName','versions','sourceSHA256','coordinatorFence','intentRecordedAt'];
    need(row && Object.getPrototypeOf(row) === Object.prototype && Object.keys(row).every(key => allowed.includes(key))
      && row.sequence === i + 1 && UUID.test(row.requestId ?? '') && !ids.has(row.requestId)
      && METHODS.has(row.method) && (op.releaseKind === 'backend-sync' ? SYNC_PHASES : RETAINED_PHASES).has(row.phase)
      && SHA.test(row.pathSha256) && row.automaticRetry === false
      && Array.isArray(row.hashes) && row.hashes.length <= 20_000 && row.hashes.every(item => /^[a-f0-9]{32}$/u.test(item))
      && Number.isFinite(Date.parse(row.intentRecordedAt)) && new Date(row.intentRecordedAt).toISOString() === row.intentRecordedAt);
    if (row.modules !== undefined) need(op.releaseKind === 'backend-sync'
      ? exact(row.modules, ['index.js','index.js.map']) && Object.values(row.modules).every(item => SHA.test(item))
      : exact(row.modules, ['index.js','index.js.map','__ops_release_ledger.json']) && Object.values(row.modules).every(item => SHA.test(item)));
    if (op.releaseKind === 'backend-sync') {
      if (row.phase === 'sync-version-upload') need(i === 0 && row.method === 'POST' && row.workerName === op.workerName
        && UUID.test(row.parentVersionId ?? '') && row.candidateVersionId === undefined
        && exact(row.modules, ['index.js','index.js.map']) && row.versions === undefined);
      else need(i === 1 && row.phase === 'sync-activate-candidate' && row.method === 'POST'
        && row.workerName === op.workerName && UUID.test(row.parentVersionId ?? '')
        && UUID.test(row.candidateVersionId ?? '') && row.parentVersionId !== row.candidateVersionId
        && Array.isArray(row.versions) && row.versions.length === 1
        && row.versions[0].versionId === row.candidateVersionId && row.versions[0].percentage === 100);
    }
    ids.add(row.requestId);
  }
  const responseIds = new Set();
  for (const row of op.responses) {
    need(row && Object.getPrototypeOf(row) === Object.prototype
      && Object.keys(row).every(key => ['requestId','status','providerAcknowledged','errorCodes','responseSha256','responseBytes','incomplete','ciphertextFile','ciphertextSha256','ciphertextBytes'].includes(key))
      && ids.has(row.requestId) && !responseIds.has(row.requestId) && (row.status === null || Number.isInteger(row.status) && row.status >= 100 && row.status <= 599)
      && typeof row.providerAcknowledged === 'boolean' && Array.isArray(row.errorCodes) && row.errorCodes.length <= 32
      && row.errorCodes.every(Number.isSafeInteger) && SHA.test(row.responseSha256)
      && Number.isSafeInteger(row.responseBytes) && row.responseBytes >= 0 && row.responseBytes <= MAX_RESPONSE);
    if (row.ciphertextFile !== undefined) need(row.ciphertextFile === `responses/${row.requestId}.sealed.json`
      && SHA.test(row.ciphertextSha256) && Number.isSafeInteger(row.ciphertextBytes) && row.ciphertextBytes > 0 && row.ciphertextBytes <= 48 * 1024 * 1024);
    responseIds.add(row.requestId);
  }
  for (const row of op.receipts) need(row && Object.getPrototypeOf(row) === Object.prototype
    && Object.keys(row).every(key => ['status','phase','controlsSHA256','ledgerSHA256','moduleSHA256','parentVersionId','candidateVersionId','deploymentId','files',
      'minimumRetentionHours','automaticPruning','allHistoricalAssetsCarried','verifiedActive','writesAttempted','cutoverObservedAt',
      'earliestPermittedPruningAt','reconciliation','failureCode','reconciliationCode','recordedAt'].includes(key))
    && ['started','prepared','inactive-verified','zero-percent-verified','candidate-assets-verified','verified','held'].includes(row.status)
    && Number.isFinite(Date.parse(row.recordedAt)) && new Date(row.recordedAt).toISOString() === row.recordedAt);
  for (const row of op.receipts) {
    if (row.failureCode !== undefined) need(['release_initial_failed','release_prepare_failed','release_upload_failed',
      'release_candidate_readback_failed','release_stage_zero_failed','release_candidate_assets_failed',
      'release_activate_failed','release_active_assets_failed','release_complete_failed','release_sync_prepare_failed',
      'release_sync_upload_failed','release_sync_candidate_readback_failed','release_sync_activate_failed',
      'release_sync_verify_failed'].includes(row.failureCode));
    if (row.reconciliationCode !== undefined) need(['not_attempted','read_succeeded','read_failed'].includes(row.reconciliationCode));
    if (row.status === 'held') need(row.failureCode !== undefined && row.reconciliationCode !== undefined
      && typeof row.writesAttempted === 'boolean');
  }
  if (op.releaseKind === 'backend-sync') {
    const statuses = op.receipts.map(row => row.status);
    const progress = statuses.filter(status => status !== 'held'), allowedProgress = ['started','prepared','inactive-verified','verified'];
    need(op.receipts.every(row => ['started','prepared','inactive-verified','verified','held'].includes(row.status))
      && progress.every((status, index) => status === allowedProgress[index])
      && statuses.filter(status => status === 'held').length <= 1
      && (!statuses.includes('held') || statuses.at(-1) === 'held')
      && op.receipts.filter(row => row.status === 'prepared').every(row => row.moduleSHA256 === op.runtime.moduleSha256)
      && op.receipts.filter(row => row.status === 'inactive-verified').every(row => row.moduleSHA256 === op.runtime.moduleSha256)
      && op.receipts.filter(row => row.status === 'verified').every(row => row.moduleSHA256 === op.runtime.moduleSha256
        && row.verifiedActive === true && UUID.test(row.candidateVersionId ?? '') && UUID.test(row.deploymentId ?? '')));
    need(op.workerName === 'ledgetop-ops-sync' && op.runtime.ledgerSha256 === null
      && op.receipts.every(row => row.ledgerSHA256 === undefined)
      && op.receipts.filter(row => row.status === 'prepared').length <= 1
      && op.receipts.filter(row => row.moduleSHA256 !== undefined).every(row => row.moduleSHA256 === op.runtime.moduleSha256)
      && (!['verified-pending-artifact','verified'].includes(op.state)
        || op.receipts.some(row => row.status === 'prepared' && row.moduleSHA256 === op.runtime.moduleSha256)));
  } else if (op.runtime.ledgerSha256 === null) need(!op.receipts.some(row => row.status === 'prepared' || row.status === 'verified')
    && !['verified-pending-artifact','verified'].includes(op.state));
  else {
    const prepared = op.receipts.filter(row => row.status === 'prepared');
    need(prepared.length <= 1 && (!prepared.length || prepared[0].ledgerSHA256 === op.runtime.ledgerSha256)
      && (!['verified-pending-artifact','verified'].includes(op.state) || prepared.length === 1));
  }
  if (op.artifact !== null) need(exact(op.artifact, ['artifactId','digestSha256','name','runId','runAttempt','uploadStepConclusion','releaseStepConclusion'])
    && Number.isSafeInteger(op.artifact.artifactId) && op.artifact.artifactId > 0 && SHA.test(op.artifact.digestSha256)
    && op.artifact.name === `production-auto-${op.releaseId}` && op.artifact.runId === op.workflow.runId
    && op.artifact.runAttempt === op.workflow.runAttempt && ['success','failure','cancelled'].includes(op.artifact.uploadStepConclusion)
    && ['success','failure','cancelled'].includes(op.artifact.releaseStepConclusion));
}

/** Evidence that the durable release journal itself proves every required
 * provider write was acknowledged and the final receipt chain is complete. */
function verifiedOperationEvidence(op) {
  const expectedStatuses = op.releaseKind === 'backend-sync'
    ? ['started','prepared','inactive-verified','verified']
    : ['started','prepared','inactive-verified','zero-percent-verified','candidate-assets-verified','verified'];
  const expectedPhases = op.releaseKind === 'backend-sync'
    ? ['sync-prepare','sync-prepare','sync-candidate-readback','sync-verify']
    : ['prepare','prepare','candidate-readback','stage-zero','candidate-assets','complete'];
  if (JSON.stringify(op.receipts.map(row => row.status)) !== JSON.stringify(expectedStatuses)
    || JSON.stringify(op.receipts.map(row => row.phase)) !== JSON.stringify(expectedPhases)) return false;
  const final = op.receipts.at(-1);
  if (op.releaseKind === 'backend-sync') {
    if (op.workerName !== 'ledgetop-ops-sync' || op.intents.length !== 2
      || op.intents[0].phase !== 'sync-version-upload' || op.intents[1].phase !== 'sync-activate-candidate'
      || final.verifiedActive !== true || final.moduleSHA256 !== op.runtime.moduleSha256
      || !UUID.test(final.candidateVersionId ?? '') || !UUID.test(final.deploymentId ?? '')) return false;
  } else {
    const required = ['asset-session','worker-version-upload','stage-zero-percent','activate-candidate'];
    const counts = new Map();
    for (const intent of op.intents) counts.set(intent.phase, (counts.get(intent.phase) ?? 0) + 1);
    const verifierIntents = op.intents.filter(intent => intent.phase.startsWith('temporary-verifier-'));
    const lifecycle = new Map();
    for (const intent of verifierIntents) {
      const name = intent.temporaryWorkerName;
      if (!name || !['temporary-verifier-create','temporary-verifier-enable','temporary-verifier-delete'].includes(intent.phase)) return false;
      const phases = lifecycle.get(name) ?? [];
      phases.push(intent.phase);
      lifecycle.set(name, phases);
    }
    if (!['ledgetop-clients','ledgetop-ops'].includes(op.workerName) || op.intents.length === 0
      || required.some(phase => counts.get(phase) !== 1)
      || counts.get('asset-bucket') > PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS
      || lifecycle.size !== 3 || [...lifecycle.values()].some(phases => JSON.stringify(phases)
        !== JSON.stringify(['temporary-verifier-create','temporary-verifier-enable','temporary-verifier-delete']))
      || counts.get('temporary-verifier-create') !== 3 || counts.get('temporary-verifier-enable') !== 3
      || counts.get('temporary-verifier-delete') !== 3
      || final.verifiedActive !== true || final.ledgerSHA256 !== op.runtime.ledgerSha256
      || !SHA.test(final.ledgerSHA256 ?? '') || !UUID.test(final.candidateVersionId ?? '')
      || !UUID.test(final.deploymentId ?? '') || final.minimumRetentionHours !== 48
      || final.automaticPruning !== false || final.allHistoricalAssetsCarried !== true
      || !isProviderUtcTimestamp(final.cutoverObservedAt)
      || !Number.isFinite(Date.parse(final.earliestPermittedPruningAt ?? ''))
      || Date.parse(final.earliestPermittedPruningAt) < Date.parse(minimumRetainedUntil(final.cutoverObservedAt, 48))) return false;
    const phases = op.intents.map(intent => intent.phase);
    const index = phase => phases.indexOf(phase);
    const verifierCreateIndexes = phases.flatMap((phase, i) => phase === 'temporary-verifier-create' ? [i] : []);
    const bucketIndexes = phases.flatMap((phase, i) => phase === 'asset-bucket' ? [i] : []);
    const findIntent = phase => op.intents.find(intent => intent.phase === phase);
    const session = findIntent('asset-session'), upload = findIntent('worker-version-upload');
    const stage = findIntent('stage-zero-percent'), activation = findIntent('activate-candidate');
    const responseById = new Map(op.responses.map(response => [response.requestId, response]));
    const correctWriteMethods = op.intents.every(intent => {
      const expectedMethod = intent.phase === 'temporary-verifier-create' ? 'PUT'
        : intent.phase === 'temporary-verifier-delete' ? 'DELETE' : 'POST';
      const response = responseById.get(intent.requestId);
      return intent.method === expectedMethod && response?.providerAcknowledged === true
        && [200,201,202].includes(response.status);
    });
    const parent = stage?.parentVersionId, candidate = stage?.candidateVersionId;
    if (!(verifierCreateIndexes[0] < index('asset-session')
      && index('asset-session') < index('worker-version-upload')
      && index('worker-version-upload') < index('stage-zero-percent')
      && index('stage-zero-percent') < verifierCreateIndexes[1]
      && verifierCreateIndexes[1] < index('activate-candidate')
      && index('activate-candidate') < verifierCreateIndexes[2])
      || (bucketIndexes.length && (bucketIndexes[0] <= index('asset-session')
        || bucketIndexes.at(-1) >= index('worker-version-upload')))
      || !correctWriteMethods
      || !session.hashes.length || !Array.isArray(upload.hashes)
      || !UUID.test(parent ?? '') || !UUID.test(candidate ?? '') || parent === candidate
      || stage.workerName !== op.workerName || activation.workerName !== op.workerName
      || activation.parentVersionId !== parent || activation.candidateVersionId !== candidate
      || !Array.isArray(stage.versions) || stage.versions.length !== 2
      || !stage.versions.some(row => row.versionId === parent && row.percentage === 100)
      || !stage.versions.some(row => row.versionId === candidate && row.percentage === 0)
      || !Array.isArray(activation.versions) || activation.versions.length !== 1
      || activation.versions[0].versionId !== candidate || activation.versions[0].percentage !== 100
      ) return false;
  }
  return op.intents.every(intent => op.responses.some(response => response.requestId === intent.requestId
    && response.providerAcknowledged === true));
}

/** GitHub Git-data journal. All non-GET requests are single-shot. A timeout or
 * ref conflict is followed only by a read of the exact ref; if the commit did
 * not land, the release stops before the corresponding Cloudflare request. */
export class ProductionAutoJournal {
  #token; #fetch; #runtime; #recipient; #responseDirectory; #identity; #document = null; #head = null; #tree = null;
  #committedBytes = null; #claimed = false; #readBusy = false; #writeBusy = false; #writeUncertain = false;
  constructor({ token, workerName, releaseKind = workerName === 'ledgetop-ops-sync' ? 'backend-sync' : 'retained-assets',
    sourceCommit, ciRunId, ciRunAttempt, workflowRunId, workflowRunAttempt, runtime, recipient, responseDirectory,
    fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
    need(typeof token === 'string' && /^[A-Za-z0-9_\-]{20,1024}$/u.test(token) && WORKERS.has(workerName)
      && COMMIT.test(sourceCommit ?? '') && Number.isSafeInteger(ciRunId) && ciRunId > 0
      && Number.isSafeInteger(ciRunAttempt) && ciRunAttempt > 0 && Number.isSafeInteger(workflowRunId) && workflowRunId > 0
      && Number.isSafeInteger(workflowRunAttempt) && workflowRunAttempt > 0 && typeof fetchImpl === 'function'
      && typeof now === 'function' && typeof responseDirectory === 'string' && path.isAbsolute(responseDirectory)
      && RELEASE_KINDS.has(releaseKind) && (workerName === 'ledgetop-ops-sync'
        ? releaseKind === 'backend-sync' : releaseKind === 'retained-assets'));
    this.#token = token; this.#fetch = fetchImpl; this.#identity = { workerName, releaseKind, sourceCommit, ciRunId, ciRunAttempt, workflowRunId, workflowRunAttempt };
    this.#runtime = runtime === undefined ? null : safeRuntime(runtime); this.#recipient = recipient; checkedRecipient(recipient);
    this.#responseDirectory = responseDirectory; this.now = now;
    this.releaseId = hash(`${workerName}\n${sourceCommit}`);
  }
  #beginWrite() {
    need(!this.#readBusy && !this.#writeBusy && !this.#writeUncertain);
    this.#writeBusy = true;
    let released = false;
    return () => { if (!released) { released = true; this.#writeBusy = false; } };
  }
  #beginRead() {
    // Read-only reconciliation remains available after an uncertain CAS, but
    // a read may not race a local writer because #load refreshes shared cache.
    need(!this.#readBusy && !this.#writeBusy);
    this.#readBusy = true;
    let released = false;
    return () => { if (!released) { released = true; this.#readBusy = false; } };
  }
  async #request(suffix, method = 'GET', body = undefined, allow404 = false) {
    need(typeof suffix === 'string' && suffix.startsWith('/') && suffix.length <= 512 && !suffix.includes('..') && !suffix.includes('//')
      && /^(?:GET|POST|PATCH)$/u.test(method));
    const controller = new AbortController(); let response, reader, timer;
    const abort = () => { controller.abort(); try { void reader?.cancel().catch(() => {}); } catch {} };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort(); reject(Error('timeout')); }, 30_000); });
    const op = (async () => {
      response = await this.#fetch(API + suffix, { method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      need(response instanceof Response && !response.redirected && !response.headers.has('Location')
        && (allow404 && response.status === 404 || [200,201].includes(response.status)));
      if (response.status === 404) return null;
      const length = response.headers.get('Content-Length'); need(length === null || /^\d+$/u.test(length) && Number(length) <= MAX_GITHUB_BODY);
      reader = response.body?.getReader(); need(reader); const chunks = []; let size = 0;
      for (;;) { const row = await reader.read(); need(!controller.signal.aborted); if (row.done) break;
        size += row.value.byteLength; need(size <= MAX_GITHUB_BODY); chunks.push(Buffer.from(row.value)); }
      return parseJsonResponse(Buffer.concat(chunks, size));
    })();
    try { return await Promise.race([op, timeout]); } catch { abort(); throw Error('production_auto_journal_api_refused_no_retry'); }
    finally { clearTimeout(timer); try { reader?.releaseLock(); } catch {} }
  }
  #ref() { return `/git/ref/heads/ltds-production-auto-journal-${this.#identity.workerName}`; }
  #updateRef() { return `/git/refs/heads/ltds-production-auto-journal-${this.#identity.workerName}`; }
  async #readHead() {
    const value = await this.#request(this.#ref(), 'GET', undefined, true);
    if (value === null) return null;
    need(value.ref === `refs/heads/ltds-production-auto-journal-${this.#identity.workerName}` && COMMIT.test(value.object?.sha ?? ''));
    return value.object.sha;
  }
  async #readDocument(head) {
    const commit = await this.#request(`/git/commits/${head}`); need(COMMIT.test(commit.sha ?? '') && commit.sha === head && COMMIT.test(commit.tree?.sha ?? ''));
    const tree = await this.#request(`/git/trees/${commit.tree.sha}`); need(Array.isArray(tree.tree) && tree.truncated !== true);
    const blob = tree.tree.find(row => row.path === JOURNAL_PATH); need(blob?.type === 'blob' && COMMIT.test(blob.sha));
    const raw = await this.#request(`/git/blobs/${blob.sha}`); need(raw.encoding === 'base64' && typeof raw.content === 'string'
      && Number.isSafeInteger(raw.size) && raw.size > 0 && raw.size <= MAX_STATE);
    const encoded = raw.content.replace(/\s+/gu, ''), bytes = Buffer.from(encoded, 'base64');
    need(bytes.length === raw.size && bytes.length <= MAX_STATE && bytes.toString('base64') === encoded);
    const value = parseJsonResponse(bytes);
    this.#validateDocument(value, bytes);
    return { document: value, bytes: Buffer.from(bytes), treeSha: commit.tree.sha };
  }
  #validateDocument(value, bytes) {
    need(exact(value, ['schemaVersion','workerName','sequence','operations']) && value.schemaVersion === 1 && value.workerName === this.#identity.workerName
      && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && Array.isArray(value.operations)
      && value.operations.length > 0 && value.operations.length <= MAX_OPERATIONS && Buffer.from(canonical(value)+'\n').equals(bytes));
    const releases = new Set();
    for (const op of value.operations) {
      storedOperation(op);
      need(op.workerName === value.workerName && op.releaseId === hash(`${op.workerName}\n${op.sourceCommit}`) && !releases.has(op.releaseId));
      releases.add(op.releaseId);
    }
    return value;
  }
  async #commitDocument(document, expectedHead) {
    const bytes = Buffer.from(canonical(document)+'\n'); need(bytes.length <= MAX_STATE);
    this.#validateDocument(document, bytes);
    let baseTree;
    if (expectedHead) {
      need(this.#head === expectedHead && COMMIT.test(this.#tree ?? '')
        && this.#committedBytes?.equals(Buffer.from(canonical(this.#document) + '\n')));
      baseTree = this.#tree;
    } else {
      need(this.#head === null && this.#document === null && this.#tree === null && this.#committedBytes === null);
      const parent = await this.#request(`/git/commits/${this.#identity.sourceCommit}`);
      need(parent.sha === this.#identity.sourceCommit && COMMIT.test(parent.tree?.sha ?? '')); baseTree = parent.tree.sha;
    }
    const blob = await this.#request('/git/blobs', 'POST', { content: bytes.toString('base64'), encoding: 'base64' });
    need(COMMIT.test(blob.sha ?? ''));
    const tree = await this.#request('/git/trees', 'POST', { base_tree: baseTree, tree: [{ path: JOURNAL_PATH, mode: '100644', type: 'blob', sha: blob.sha }] });
    need(COMMIT.test(tree.sha ?? ''));
    const commit = await this.#request('/git/commits', 'POST', { message: 'Record guarded production frontend release state', tree: tree.sha,
      parents: [expectedHead ?? this.#identity.sourceCommit] });
    need(COMMIT.test(commit.sha ?? ''));
    let refAcknowledged = false;
    if (!expectedHead) {
      try {
        const created = await this.#request('/git/refs', 'POST', { ref: `refs/heads/ltds-production-auto-journal-${this.#identity.workerName}`, sha: commit.sha });
        need(created.object?.sha === commit.sha);
        refAcknowledged = true;
      } catch {
        let observed;
        try { observed = await this.#readHead(); }
        catch { this.#writeUncertain = true; throw Error('production_auto_journal_claim_uncertain_no_cloudflare_request'); }
        if (observed !== commit.sha) { this.#writeUncertain = true; throw Error('production_auto_journal_claim_uncertain_no_cloudflare_request'); }
      }
    } else {
      try {
        const updated = await this.#request(this.#updateRef(), 'PATCH', { sha: commit.sha, force: false });
        need(updated.object?.sha === commit.sha);
        refAcknowledged = true;
      } catch {
        let observed;
        try { observed = await this.#readHead(); }
        catch { this.#writeUncertain = true; throw Error('production_auto_journal_cas_uncertain_no_cloudflare_request'); }
        if (observed !== commit.sha) { this.#writeUncertain = true; throw Error('production_auto_journal_cas_uncertain_no_cloudflare_request'); }
      }
    }

    need(refAcknowledged || this.#head === null || this.#head === expectedHead);
    this.#head = commit.sha; this.#tree = tree.sha; this.#committedBytes = Buffer.from(bytes); this.#document = structuredClone(document);
  }
  async #load() {
    const head = await this.#readHead();
    if (head === null) {
      this.#head = null; this.#document = null; this.#tree = null; this.#committedBytes = null;
      return null;
    }
    const loaded = await this.#readDocument(head);
    this.#head = head; this.#document = structuredClone(loaded.document); this.#tree = loaded.treeSha;
    this.#committedBytes = Buffer.from(loaded.bytes); return structuredClone(loaded.document);
  }
  /** Read and validate one completed predecessor using only the bounded GitHub
   * journal GET path. This method never claims, writes, or changes the ref. */
  async readVerifiedPredecessor(value) {
    const release = this.#beginRead();
    return this.#readVerifiedPredecessor(value).finally(release);
  }
  async #readVerifiedPredecessor({ sourceCommit, releaseId, releaseKind, ciRunId, ciRunAttempt, workflowRunId, workflowRunAttempt } = {}) {
    need(this.#runtime === null && COMMIT.test(sourceCommit ?? '') && SHA.test(releaseId ?? '')
      && releaseId === hash(`${this.#identity.workerName}\n${sourceCommit}`)
      && RELEASE_KINDS.has(releaseKind) && releaseKind === this.#identity.releaseKind
      && Number.isSafeInteger(ciRunId) && ciRunId > 0 && Number.isSafeInteger(ciRunAttempt) && ciRunAttempt > 0
      && Number.isSafeInteger(workflowRunId) && workflowRunId > 0
      && Number.isSafeInteger(workflowRunAttempt) && workflowRunAttempt > 0);
    const document = await this.#load();
    need(document !== null);
    const matches = document.operations.filter(row => row.releaseId === releaseId);
    need(matches.length === 1);
    const op = matches[0];
    need(op.workerName === this.#identity.workerName && op.sourceCommit === sourceCommit
      && op.releaseKind === releaseKind
      && op.releaseId === hash(`${op.workerName}\n${op.sourceCommit}`)
      && op.ci.runId === ciRunId && op.ci.runAttempt === ciRunAttempt
      && op.workflow.runId === workflowRunId && op.workflow.runAttempt === workflowRunAttempt
      && op.state === 'verified' && op.artifact !== null
      && op.artifact.runId === workflowRunId && op.artifact.runAttempt === workflowRunAttempt
      && op.artifact.name === `production-auto-${releaseId}`
      && op.artifact.uploadStepConclusion === 'success' && op.artifact.releaseStepConclusion === 'success'
      && verifiedOperationEvidence(op));
    const final = op.receipts.at(-1);
    const started = op.receipts[0];
    return Object.freeze({ workerName: op.workerName, releaseKind: op.releaseKind, sourceCommit: op.sourceCommit,
      releaseId: op.releaseId, ci: Object.freeze({ ...op.ci }), workflow: Object.freeze({ ...op.workflow }),
      runtime: Object.freeze({ ...op.runtime }), startedReceipt: Object.freeze({ ...started }),
      artifact: Object.freeze({ artifactId: op.artifact.artifactId,
        digestSha256: op.artifact.digestSha256, name: op.artifact.name, runId: op.artifact.runId,
        runAttempt: op.artifact.runAttempt, uploadStepConclusion: op.artifact.uploadStepConclusion,
        releaseStepConclusion: op.artifact.releaseStepConclusion }), finalReceipt: Object.freeze({ ...final }) });
  }
  async #persist(next) {
    need(this.#document && this.#claimed && this.#head && COMMIT.test(this.#tree ?? '')
      && Buffer.isBuffer(this.#committedBytes)
      && this.#committedBytes.equals(Buffer.from(canonical(this.#document) + '\n')));
    const old = structuredClone(this.#document);
    old.sequence += 1;
    const index = old.operations.findIndex(row => row.releaseId === this.releaseId);
    need(index >= 0);
    const op = old.operations[index];
    const candidateLedgerBind = op.runtime.ledgerSha256 === null && SHA.test(next.operation.runtime?.ledgerSha256 ?? '')
      && next.operation.runtime.ledgerSha256 !== op.runtime.ledgerSha256
      && !op.receipts.some(row => row.status === 'prepared')
      && next.operation.receipts.at(-1)?.status === 'prepared'
      && next.operation.receipts.at(-1)?.ledgerSHA256 === next.operation.runtime.ledgerSha256;
    need(op.workerName === this.#identity.workerName && op.releaseKind === this.#identity.releaseKind && op.sourceCommit === this.#identity.sourceCommit
      && (canonical(op.runtime) === canonical(this.#runtime) || candidateLedgerBind) && op.ci.runId === this.#identity.ciRunId
      && op.ci.runAttempt === this.#identity.ciRunAttempt && op.workflow.runId === this.#identity.workflowRunId
      && op.workflow.runAttempt === this.#identity.workflowRunAttempt && ['in_progress','held','verified-pending-artifact','verified'].includes(op.state));
    old.operations[index] = structuredClone(next.operation);
    await this.#commitDocument(old, this.#head);
    if (candidateLedgerBind) this.#runtime = safeRuntime(next.operation.runtime);
  }
  #currentOperation() { return this.#document?.operations.find(row => row.releaseId === this.releaseId) ?? null; }
  async recordIntent(value) {
    const release = this.#beginWrite();
    return this.#recordIntent(value).finally(release);
  }
  async #recordIntent(value) {
    need(this.#runtime !== null);
    const projected = intentProjection(value); need((projected.workerName === undefined || projected.workerName === this.#identity.workerName)
      && (this.#identity.releaseKind === 'backend-sync' ? SYNC_PHASES : RETAINED_PHASES).has(projected.phase));
    if (this.#claimed) need(this.#document && this.#head && this.#committedBytes
      && this.#committedBytes.equals(Buffer.from(canonical(this.#document) + '\n')));
    const old = this.#claimed
      ? structuredClone(this.#document)
      : await this.#load();
    if (!old || !old.operations.some(row => row.releaseId === this.releaseId)) {
      need(this.#identity.releaseKind !== 'backend-sync');
      // A release identity is one-shot across workflow reruns. A distinct
      // exact source commit can append a new operation to the same worker
      // journal; the Git ref update is the cross-run CAS claim.
      need(!old || old.operations.length < MAX_OPERATIONS);
      const operation = { releaseId: this.releaseId, workerName: this.#identity.workerName, releaseKind: this.#identity.releaseKind,
        sourceCommit: this.#identity.sourceCommit,
        runtime: this.#runtime, ci: { runId: this.#identity.ciRunId, runAttempt: this.#identity.ciRunAttempt },
        workflow: { runId: this.#identity.workflowRunId, runAttempt: this.#identity.workflowRunAttempt }, state: 'in_progress',
        createdAt: this.now(), updatedAt: this.now(), intents: [], receipts: [], responses: [], artifact: null };
      operation.intents.push({ sequence: 1, ...projected, intentRecordedAt: operation.createdAt });
      if (old) {
        old.sequence += 1; old.operations.push(operation);
        await this.#commitDocument(old, this.#head);
      } else {
        await this.#commitDocument({ schemaVersion: 1, workerName: this.#identity.workerName, sequence: 1, operations: [operation] }, null);
      }
      this.#claimed = true;
      this.#emitOutput(this.releaseId);
      return;
    }
    need(this.#claimed); // A restarted or duplicate run never resumes after a prior durable intent.
    const operation = old.operations.find(row => row.releaseId === this.releaseId);
    need(operation && operation.workerName === this.#identity.workerName && operation.releaseKind === this.#identity.releaseKind
      && operation.sourceCommit === this.#identity.sourceCommit
      && canonical(operation.runtime) === canonical(this.#runtime) && operation.state === 'in_progress'
      && operation.intents.length < MAX_INTENTS_PER_RELEASE);
    if (this.#identity.releaseKind === 'backend-sync') {
      const nextPhase = operation.intents.length === 0 ? 'sync-version-upload'
        : operation.intents.length === 1 ? 'sync-activate-candidate' : null;
      need(operation.receipts[0]?.status === 'started' && projected.phase === nextPhase
        && (projected.phase !== 'sync-activate-candidate' || operation.receipts.some(row => row.status === 'inactive-verified')));
      if (projected.phase === 'sync-activate-candidate') {
        need(projected.candidateVersionId === operation.receipts.find(row => row.status === 'inactive-verified')?.candidateVersionId
          && projected.parentVersionId === operation.receipts[0]?.parentVersionId);
      }
    }
    const last = operation.intents.at(-1), response = last && operation.responses.find(row => row.requestId === last.requestId);
    need(!last || response?.providerAcknowledged === true);
    operation.intents.push({ sequence: operation.intents.length + 1, ...projected, intentRecordedAt: this.now() });
    operation.updatedAt = this.now();
    await this.#persist({ operation });
  }
  #emitOutput(releaseId) {
    const output = process.env.GITHUB_OUTPUT; if (!output) return;
    need(path.isAbsolute(output));
    const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
    try { const st = fs.fstatSync(fd); need(st.isFile() && st.nlink === 1); fs.writeFileSync(fd, `release_id=${releaseId}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  async persistResponse(value) {
    const release = this.#beginWrite();
    return this.#persistResponse(value).finally(release);
  }
  async #persistResponse(value) {
    need(this.#claimed);
    const op = this.#currentOperation(), intent = op?.intents.at(-1); need(op && intent && intent.requestId === value?.requestId
      && !op.responses.some(row => row.requestId === value.requestId));
    const result = responseProjection(value, intent, this.releaseId, this.#recipient, this.#responseDirectory);
    const next = structuredClone(op); next.responses.push(result); next.updatedAt = this.now();
    await this.#persist({ operation: next });
  }
  async receipt(value) {
    const release = this.#beginWrite();
    return this.#receipt(value).finally(release);
  }
  async #receipt(value) {
    const projected = safeReceipt(value, this.#identity.workerName, this.#identity.sourceCommit, this.#identity.releaseKind);
    if (this.#identity.releaseKind === 'backend-sync') {
      const existing = this.#currentOperation()?.receipts ?? [];
      const progress = existing.map(row => row.status).filter(status => status !== 'held');
      const expected = progress.length === 0 ? 'started' : progress.length === 1 ? 'prepared'
        : progress.length === 2 ? 'inactive-verified' : progress.length === 3 ? 'verified' : null;
      need(projected.status === 'held' || projected.status === expected);
      need(!existing.some(row => row.status === 'held' || row.status === 'verified'));
    }
    if (!this.#claimed) {
      need(this.#runtime !== null);
      const old = await this.#load();
      need(!old || !old.operations.some(row => row.releaseId === this.releaseId));
      const now = this.now(), operation = { releaseId: this.releaseId, workerName: this.#identity.workerName,
        releaseKind: this.#identity.releaseKind,
        sourceCommit: this.#identity.sourceCommit, runtime: this.#runtime,
        ci: { runId: this.#identity.ciRunId, runAttempt: this.#identity.ciRunAttempt },
        workflow: { runId: this.#identity.workflowRunId, runAttempt: this.#identity.workflowRunAttempt },
        state: projected.status === 'held' ? 'held' : projected.status === 'verified' ? 'verified-pending-artifact' : 'in_progress',
        createdAt: now, updatedAt: now, intents: [], receipts: [{ ...projected, recordedAt: now }], responses: [], artifact: null };
      if (old) {
        need(old.operations.length < MAX_OPERATIONS); old.sequence += 1; old.operations.push(operation);
        await this.#commitDocument(old, this.#head);
      } else {
        await this.#commitDocument({ schemaVersion: 1, workerName: this.#identity.workerName, sequence: 1, operations: [operation] }, null);
      }
      this.#claimed = true; this.#emitOutput(this.releaseId); return;
    }
    const current = this.#currentOperation(); need(current);
    const op = structuredClone(current);
    if (projected.status === 'prepared' && this.#identity.releaseKind === 'retained-assets' && this.#runtime?.ledgerSha256 === null) {
      need(SHA.test(projected.ledgerSHA256 ?? '') && op.runtime.ledgerSha256 === null);
      op.runtime = safeRuntime({ ...this.#runtime, ledgerSha256: projected.ledgerSHA256 });
    } else if (projected.status === 'prepared' && this.#identity.releaseKind === 'retained-assets') need(projected.ledgerSHA256 === this.#runtime?.ledgerSha256);
    else if (projected.status === 'prepared') need(projected.moduleSHA256 === this.#runtime?.moduleSha256);
    if (projected.status === 'held') op.state = 'held';
    if (projected.status === 'verified') op.state = 'verified-pending-artifact';
    op.receipts.push({ ...projected, recordedAt: this.now() }); need(op.receipts.length <= 64);
    op.updatedAt = this.now(); await this.#persist({ operation: op });
  }
  async attachArtifact(value) {
    const release = this.#beginWrite();
    return this.#attachArtifact(value).finally(release);
  }
  async #attachArtifact({ artifactId, artifactDigest, runId, runAttempt, name, status, releaseStatus }) {
    need(Number.isSafeInteger(artifactId) && artifactId > 0 && SHA.test(artifactDigest)
      && runId === this.#identity.workflowRunId && runAttempt === this.#identity.workflowRunAttempt
      && name === `production-auto-${this.releaseId}` && ['success','failure','cancelled'].includes(status)
      && ['success','failure','cancelled'].includes(releaseStatus));
    if (!this.#document) await this.#load();
    // Artifact completion is a journal-only operation in a separate
    // workflow_run job. It must bind to an existing durable release and may
    // never create a release or authorize provider calls.
    if (!this.#claimed) {
      const existing = this.#currentOperation();
      need(existing && existing.workflow.runId === runId && existing.workflow.runAttempt === runAttempt && !existing.artifact);
      if (this.#runtime === null) this.#runtime = safeRuntime(existing.runtime);
      this.#claimed = true;
    }
    const current = this.#currentOperation();
    need(current && current.workflow.runId === runId && current.workflow.runAttempt === runAttempt && current.state !== 'verified');
    const op = structuredClone(current);
    need(!op.artifact);
    op.artifact = { artifactId, digestSha256: artifactDigest, name, runId, runAttempt,
      uploadStepConclusion: status, releaseStepConclusion: releaseStatus };
    if (op.state === 'verified-pending-artifact' && status === 'success' && releaseStatus === 'success'
      && verifiedOperationEvidence(op)) op.state = 'verified';
    else op.state = 'held';
    op.updatedAt = this.now(); await this.#persist({ operation: op });
  }
  snapshot() { return this.#document ? structuredClone(this.#document) : null; }
}

/** Read-only convenience entry point for the workflow handoff. */
export async function readVerifiedProductionAutoPredecessor({ token, workerName, releaseKind, sourceCommit, releaseId,
  ciRunId, ciRunAttempt, workflowRunId, workflowRunAttempt, fetchImpl = fetch } = {}) {
  const journal = new ProductionAutoJournal({ token, workerName, releaseKind, sourceCommit, ciRunId, ciRunAttempt,
    workflowRunId, workflowRunAttempt, recipient: PRODUCTION_AUTO_JOURNAL_RECIPIENT,
    responseDirectory: process.cwd(), fetchImpl });
  return journal.readVerifiedPredecessor({ sourceCommit, releaseId, releaseKind, ciRunId, ciRunAttempt, workflowRunId, workflowRunAttempt });
}
