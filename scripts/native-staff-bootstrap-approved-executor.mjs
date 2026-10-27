import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireNativeStaffBootstrapApprovalLease, assertPinnedInstallerSource, canonicalJson, protectedSign,
  readNativeStaffBootstrapApprovalRegistry, runPinnedCloudflaredToken, verifyCloudflareAccessJwt,
  verifyNativeStaffBootstrapOwnerApprovalReceipt,
} from './native-staff-bootstrap-owner-approval.mjs';
import { loadPinnedNativeStaffBootstrapExecutorConfig } from './native-staff-bootstrap-approved-executor-config.mjs';
import { assertPinnedIssuerDistribution } from './native-staff-bootstrap-owner-approval-distribution-pin.mjs';
import { executeNativeStaffBootstrapD1, nativeStaffBootstrapD1InsertColumns, prepareNativeStaffBootstrapD1,
  readNativeStaffBootstrapSnapshot } from './native-staff-bootstrap-d1.mjs';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BATCH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WRANGLER_SHA256 = 'a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd';
const sha = value => createHash('sha256').update(value).digest('hex');
const stop = code => { throw new Error(`native_staff_bootstrap_executor_${code}`); };

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function parseArtifact(artifact) {
  if (!exactObject(artifact, ['canonicalPlanJson', 'bindingEvidenceJson', 'reviewedSnapshot', 'commandId'])
    || typeof artifact.canonicalPlanJson !== 'string' || typeof artifact.bindingEvidenceJson !== 'string'
    || !UUID.test(artifact.commandId ?? '') || !artifact.reviewedSnapshot
    || !/^[0-9a-f]{64}$/u.test(artifact.reviewedSnapshot.snapshotSha256 ?? '')
    || typeof artifact.reviewedSnapshot.snapshotJson !== 'string'
    || sha(artifact.reviewedSnapshot.snapshotJson) !== artifact.reviewedSnapshot.snapshotSha256) stop('artifact_invalid');
  let plan, binding;
  try { plan = JSON.parse(artifact.canonicalPlanJson); binding = JSON.parse(artifact.bindingEvidenceJson); }
  catch { stop('artifact_invalid'); }
  if (canonicalJson(plan) !== artifact.canonicalPlanJson || canonicalJson(binding) !== artifact.bindingEvidenceJson
    || !UUID.test(plan.approvalId ?? '') || plan.reviewedSnapshotSha256 !== artifact.reviewedSnapshot.snapshotSha256
    || !Array.isArray(plan.rows) || !plan.rows.length) stop('artifact_invalid');
  return { artifact, plan, planSha256: sha(artifact.canonicalPlanJson), bindingSha256: sha(artifact.bindingEvidenceJson) };
}

function signedExecutionInput(artifact, receipt, config, now) {
  const parsed = parseArtifact(artifact);
  const envelope = receipt?.payload?.trustEnvelope;
  if (!envelope || envelope.approvalId !== parsed.plan.approvalId || envelope.commandId !== artifact.commandId) stop('receipt_artifact_mismatch');
  const approval = {
    approvalId: envelope.approvalId,
    approvedOperatorStaffId: envelope.approvedOperatorStaffId,
    approvedOperatorAccessSubject: envelope.approvedOperatorAccessSubject,
    issuedByStaffId: envelope.issuedByStaffId,
    issuedByAccessSubject: envelope.issuedByAccessSubject,
    issuedAt: envelope.authorizedAt,
    expiresAt: envelope.expiresAt,
  };
  const expected = { approval, commandId: artifact.commandId, canonicalPlanJson: artifact.canonicalPlanJson,
    bindingEvidenceJson: artifact.bindingEvidenceJson, reviewedSnapshot: artifact.reviewedSnapshot };
  verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now, expected });
  return { ...parsed, approval, commandId: artifact.commandId, trustEnvelope: envelope };
}

function ownerIsBound(snapshot, config) {
  let parsed;
  try { parsed = JSON.parse(snapshot.snapshotJson); } catch { return false; }
  const ownerId = config.access.owner.staffId, subject = config.access.owner.accessSubject;
  const row = (table, key, value) => Array.isArray(parsed?.rows?.[table])
    ? parsed.rows[table].find(item => item?.[key] === value) : null;
  const user = row('staff_users', 'id', ownerId);
  const admission = row('native_staff_admissions', 'staff_id', ownerId);
  const profile = row('native_staff_profiles', 'staff_id', ownerId);
  return Boolean(user && user.status === 'active' && user.access_subject === subject
    && admission?.active === 1 && admission.bound_access_subject === subject
    && profile?.staff_id === ownerId && Number.isSafeInteger(profile.version) && profile.version > 0
    && Array.isArray(snapshot.controlPlaneStaffIds) && snapshot.controlPlaneStaffIds.includes(ownerId));
}

async function boundedBody(response) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) stop('response_too_large');
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) stop('response_too_large');
    return value;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); stop('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks, size).toString('utf8');
}

function normalizedD1Results(payload, expectedCount) {
  if (payload?.success !== true || !Array.isArray(payload.result) || payload.result.length !== expectedCount
    || payload.result.some(item => item?.success !== true || !Array.isArray(item.results))) stop('d1_batch_outcome_uncertain');
  return payload.result.map(item => ({ success: true, results: item.results }));
}

/** Fixed-target REST transport. It never retries and binds every SQL request to the configured D1 UUID. */
export function createApprovedExecutorD1Provider({ config, getBearerToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!config?.target || !/^[a-f0-9]{32}$/u.test(config.target.accountId ?? '') || !UUID.test(config.target.databaseId ?? '')
    || typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) stop('provider_configuration_invalid');
  let verifiedMetadata = false;

  async function request(method, route, body) {
    const bearer = await getBearerToken();
    if (typeof bearer !== 'string' || bearer.length < 20 || bearer.length > 16_384) stop('provider_auth_unavailable');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_ROOT}/accounts/${config.target.accountId}/${route}`, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response || response.redirected || response.status >= 300 && response.status < 400) stop('provider_redirect_refused');
      if (!response.ok) stop('provider_http_failure');
      let payload;
      try { payload = JSON.parse(await boundedBody(response)); } catch (error) {
        if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_executor_')) throw error;
        stop('provider_response_invalid');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) stop('provider_response_invalid');
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_executor_')) throw error;
      stop('provider_request_uncertain');
    } finally { clearTimeout(timer); }
  }

  async function assertTarget() {
    const payload = await request('GET', `d1/database/${encodeURIComponent(config.target.databaseId)}`);
    if (payload.result?.uuid !== config.target.databaseId || typeof payload.result?.name !== 'string'
      || payload.result.name.length < 1 || payload.result.name.length > 128) stop('provider_target_mismatch');
    verifiedMetadata = true;
    return Object.freeze({ databaseId: payload.result.uuid, name: payload.result.name });
  }

  async function query(batch) {
    if (!verifiedMetadata || !Array.isArray(batch) || batch.length < 1 || batch.length > MAX_BATCH
      || batch.some(item => !item || typeof item.sql !== 'string' || item.sql.length < 1 || item.sql.length > 1_000_000
        || !Array.isArray(item.params) || item.params.some(value => value !== null && typeof value !== 'string'
          && !(typeof value === 'number' && Number.isFinite(value))))) stop('provider_batch_invalid');
    const body = { batch: batch.map(item => ({ sql: item.sql, params: [...item.params] })) };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 16 * 1024 * 1024) stop('provider_batch_too_large');
    const payload = await request('POST', `d1/database/${encodeURIComponent(config.target.databaseId)}/query`, body);
    return normalizedD1Results(payload, batch.length);
  }

  return Object.freeze({ assertTarget, query,
    prepare(sql) {
      if (typeof sql !== 'string') stop('provider_sql_invalid');
      const params = [];
      const statement = { sql, params, bind(...values) { params.splice(0, params.length, ...values); return statement; },
        async all() { const [result] = await query([{ sql, params }]); return { success: result.success, results: result.results }; },
        async first() { const result = await statement.all(); return result.results[0] ?? null; },
        async run() { const [result] = await query([{ sql, params }]); return result; } };
      return statement;
    },
    async batch(statements) {
      if (!Array.isArray(statements)) stop('provider_batch_invalid');
      const batch = statements.map(statement => ({ sql: statement?.sql, params: statement?.params ?? [] }));
      return query(batch);
    },
  });
}

async function fetchCurrentOwnerSession(config, token, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const verified = await verifyCloudflareAccessJwt(token, config.access, { now, fetchImpl });
  if (verified.subject !== config.access.owner.accessSubject) stop('access_owner_mismatch');
  let response;
  try {
    response = await fetchImpl(new URL('/api/session', config.access.origin), {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'Cf-Access-Token': token },
    });
  } catch { stop('access_session_unavailable'); }
  if (!response || response.redirected || response.status >= 300 && response.status < 400 || response.status !== 200
    || !/application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) stop('access_session_rejected');
  let session;
  try { session = JSON.parse(await boundedBody(response)); } catch { stop('access_session_invalid'); }
  if (session?.user?.id !== config.access.owner.staffId || typeof session.csrfToken !== 'string'
    || session.csrfToken.length < 32 || session.csrfToken.length > 4096) stop('access_session_owner_mismatch');
  return Object.freeze({ claims: verified, staffId: session.user.id });
}

function receiptTrustVerifier(receipt, config, artifact, session, dispatchingStateSha256) {
  return async input => {
    try {
      if (dispatchingStateSha256) {
        const registry = readNativeStaffBootstrapApprovalRegistry(config);
        const entry = registry.envelope.payload.entries.find(item => item.approvalId === receipt.payload.trustEnvelope.approvalId);
        if (registry.stateSha256 !== dispatchingStateSha256 || !entry || entry.commandId !== artifact.commandId
          || entry.receiptSha256 !== sha(canonicalJson(receipt)) || entry.state !== 'dispatching') return false;
      }
      const checked = verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now: Date.now(), expected: {
        approval: input.approval, commandId: input.commandId, canonicalPlanJson: input.canonicalPlanJson,
        bindingEvidenceJson: input.bindingEvidenceJson, reviewedSnapshot: input.reviewedSnapshot,
      } });
      return checked.approvalId === receipt.payload.trustEnvelope.approvalId
        && checked.commandId === artifact.commandId && session.staffId === config.access.owner.staffId
        && Date.now() < session.claims.expiresAt * 1000;
    } catch { return false; }
  };
}

function executionDigest({ config, artifact, receipt, database }) {
  return sha(canonicalJson({ schemaVersion: 1, target: config.target, source: config.source,
    commandId: artifact.commandId, approvalId: receipt.payload.trustEnvelope.approvalId,
    receiptSha256: sha(canonicalJson(receipt)), artifactSha256: sha(canonicalJson(artifact)),
    databaseId: database.databaseId, databaseName: database.name }));
}

/**
 * Shared execution core for the pinned CLI and synthetic tests. Access JWTs,
 * signatures, registry entries and installer trust are always verified here;
 * callers cannot inject the installer trust callback.
 */
export async function runNativeStaffBootstrapApprovedExecutor({ artifact, receipt, mode = 'preview',
  preparedSha256, getAccessToken, getBearerToken, fetchImpl = globalThis.fetch, now = Date.now(),
  } = {}) {
  if (!['preview', 'execute'].includes(mode) || typeof getAccessToken !== 'function'
    || typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function') stop('arguments_invalid');
  assertPinnedIssuerDistribution();
  const config = loadPinnedNativeStaffBootstrapExecutorConfig();
  assertPinnedInstallerSource(config);
  const signed = signedExecutionInput(artifact, receipt, config, now);
  const registry = readNativeStaffBootstrapApprovalRegistry(config);
  const registered = registry.envelope.payload.entries.find(entry => entry.approvalId === signed.approval.approvalId);
  if (!registered || registered.commandId !== signed.commandId || registered.receiptSha256 !== sha(canonicalJson(receipt))
    || registered.state !== 'issued') stop('approval_not_issued');
  const provider = createApprovedExecutorD1Provider({ config, getBearerToken, fetchImpl });
  const database = await provider.assertTarget();
  const initialSession = await fetchCurrentOwnerSession(config, await getAccessToken(), { fetchImpl, now });
  const initialDb = await readNativeStaffBootstrapSnapshot(provider, signed.plan.staffCohort);
  if (initialDb.snapshotSha256 !== artifact.reviewedSnapshot.snapshotSha256 || !ownerIsBound(initialDb, config))
    stop('current_owner_or_snapshot_changed');
  const initialVerifyTrust = receiptTrustVerifier(receipt, config, artifact, initialSession);
  await prepareNativeStaffBootstrapD1({ approval: signed.approval,
    canonicalPlanJson: artifact.canonicalPlanJson, bindingEvidenceJson: artifact.bindingEvidenceJson,
    reviewedSnapshot: artifact.reviewedSnapshot, commandId: artifact.commandId, trustEnvelope: signed.trustEnvelope },
    { verifyTrust: initialVerifyTrust });
  const digest = executionDigest({ config, artifact, receipt, database });
  if (mode === 'preview') return Object.freeze({ mode, preparedSha256: digest, databaseId: database.databaseId,
    databaseName: database.name, snapshotSha256: initialDb.snapshotSha256, ownerStaffId: initialSession.staffId,
    planSha256: signed.planSha256, rowCount: signed.plan.rows.length });
  if (!/^[0-9a-f]{64}$/u.test(preparedSha256 ?? '') || preparedSha256 !== digest) stop('prepared_digest_mismatch');

  const lease = acquireNativeStaffBootstrapApprovalLease(config, receipt, (payload, cfg) => protectedSign(payload, cfg));
  let dispatchStarted = false, finished = false;
  const finish = outcome => { if (!finished) { lease.finish(outcome); finished = true; } };
  try {
    // Refresh Access acceptance and full D1 state after acquiring the one-shot
    // local lease, before any mutating D1 management request.
    const freshSession = await fetchCurrentOwnerSession(config, await getAccessToken(), { fetchImpl, now: Date.now() });
    if (freshSession.staffId !== initialSession.staffId) stop('current_owner_changed');
    const freshDb = await readNativeStaffBootstrapSnapshot(provider, signed.plan.staffCohort);
    if (freshDb.snapshotSha256 !== artifact.reviewedSnapshot.snapshotSha256 || !ownerIsBound(freshDb, config))
      stop('current_owner_or_snapshot_changed');
    const verifyTrust = receiptTrustVerifier(receipt, config, artifact, freshSession, lease.stateSha256);
    const prepared = await prepareNativeStaffBootstrapD1({ approval: signed.approval,
      canonicalPlanJson: artifact.canonicalPlanJson, bindingEvidenceJson: artifact.bindingEvidenceJson,
      reviewedSnapshot: artifact.reviewedSnapshot, commandId: artifact.commandId, trustEnvelope: signed.trustEnvelope }, { verifyTrust });
    const result = await executeNativeStaffBootstrapD1(provider, prepared, { verifyTrust,
      submitManagementBatch: async request => {
        if (dispatchStarted) stop('duplicate_mutation_dispatch_refused');
        dispatchStarted = true;
        return provider.query(request.batch);
      } });
    const durable = await readNativeStaffBootstrapSnapshot(provider, signed.plan.staffCohort);
    if (!durableInstallMatches(durable, signed)) stop('durable_result_not_observed');
    finish('consumed');
    return Object.freeze({ mode, outcome: 'consumed', approvalId: result.approvalId, commandId: result.commandId,
      insertedRowCount: result.insertedRowCount, staffCount: result.staffCount, beforeSnapshotSha256: artifact.reviewedSnapshot.snapshotSha256,
      afterSnapshotSha256: durable.snapshotSha256 });
  } catch (error) {
    if (dispatchStarted) {
      // Never replay. Installer confirmation may fail after a committed atomic
      // batch, so only read state and conservatively consume or mark uncertain.
      try {
        const after = await readNativeStaffBootstrapSnapshot(provider, signed.plan.staffCohort);
        finish(durableInstallMatches(after, signed) ? 'consumed' : 'uncertain');
      } catch { finish('uncertain'); }
    } else finish('uncertain');
    throw error;
  }
}

function durableInstallMatches(snapshot, signed) {
  let parsed;
  try { parsed = JSON.parse(snapshot.snapshotJson); } catch { return false; }
  const rows = parsed?.rows;
  const approval = rows?.native_staff_bootstrap_approvals?.find(row => row?.approval_id === signed.approval.approvalId);
  const receipt = rows?.native_staff_bootstrap_receipts?.find(row => row?.command_id === signed.commandId);
  if (!approval || !receipt || approval.canonical_plan_json !== signed.artifact.canonicalPlanJson
    || approval.canonical_plan_sha256 !== signed.planSha256
    || approval.approved_operator_staff_id !== signed.approval.approvedOperatorStaffId
    || approval.approved_operator_access_subject !== signed.approval.approvedOperatorAccessSubject
    || approval.issued_by_staff_id !== signed.approval.issuedByStaffId
    || approval.issued_by_access_subject !== signed.approval.issuedByAccessSubject
    || approval.issued_at !== signed.approval.issuedAt || approval.expires_at !== signed.approval.expiresAt
    || approval.independent_binding_verification_json !== signed.artifact.bindingEvidenceJson
    || approval.independent_binding_verification_sha256 !== signed.bindingSha256 || approval.revoked_at !== null
    || receipt.approval_id !== signed.approval.approvalId || receipt.operator_staff_id !== signed.approval.approvedOperatorStaffId
    || receipt.operator_access_subject !== signed.approval.approvedOperatorAccessSubject
    || receipt.canonical_plan_json !== signed.artifact.canonicalPlanJson || receipt.canonical_plan_sha256 !== signed.planSha256
    || receipt.independent_binding_verification_json !== signed.artifact.bindingEvidenceJson
    || receipt.independent_binding_verification_sha256 !== signed.bindingSha256) return false;
  const expectedResult = { schemaVersion: 1, approvalId: signed.approval.approvalId, commandId: signed.commandId,
    canonicalPlanSha256: signed.planSha256, bindingEvidenceSha256: signed.bindingSha256,
    installedStaffCount: signed.plan.staffCohort.length, insertedRowCount: signed.plan.rows.length };
  const expectedResultJson = canonicalJson(expectedResult);
  if (receipt.result_json !== expectedResultJson || receipt.result_sha256 !== sha(expectedResultJson)) return false;
  for (const item of signed.plan.rows) {
    const columns = nativeStaffBootstrapD1InsertColumns[item.table];
    const key = Object.keys(item.row)[0];
    const expected = columns && rows?.[item.table]?.some(actual => Object.entries(item.row).every(([name, value]) => actual?.[name] === value)
      && columns.every(name => Object.hasOwn(item.row, name)) && item.row[key] === actual?.[key]);
    if (!expected) return false;
  }
  return true;
}

function readPrivateFile(file, maxBytes) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) stop('input_file_invalid');
  return readFileSync(file, 'utf8');
}

async function wranglerBearerToken() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = path.join(root, 'apps', 'operations', 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
  if (sha(readFileSync(cli)) !== WRANGLER_SHA256) stop('wrangler_runtime_pin_mismatch');
  const env = {};
  for (const key of ['SystemRoot','WINDIR','PATH','COMSPEC','USERPROFILE','APPDATA','LOCALAPPDATA','HOME','TEMP','TMP'])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { CI: 'true', NO_COLOR: '1', WRANGLER_LOG: 'log', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_WRITE_LOGS: 'false', CLOUDFLARE_API_BASE_URL: API_ROOT });
  return new Promise((resolve, reject) => {
    let child, output = [], size = 0, done = false;
    const timer = setTimeout(() => fail(), 45_000);
    const fail = () => { if (done) return; done = true; clearTimeout(timer); try { child?.kill(); } catch {} reject(Error('native_staff_bootstrap_executor_provider_auth_unavailable')); };
    try { child = spawn(process.execPath, [cli, 'auth', 'token', '--json'], { cwd: root, env, shell: false, windowsHide: true,
      stdio: ['ignore','pipe','ignore'] }); } catch { fail(); return; }
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 24_576) fail(); else output.push(Buffer.from(chunk)); });
    child.stderr.on('data', () => {});
    child.on('error', fail);
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      try {
        if (code !== 0) throw Error();
        const value = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!value || !['oauth','api_token'].includes(value.type) || typeof value.token !== 'string'
          || value.token.length < 20 || value.token.length > 16_384 || !/^[\x21-\x7e]+$/u.test(value.token)) throw Error();
        resolve(value.token);
      } catch { reject(Error('native_staff_bootstrap_executor_provider_auth_unavailable')); }
    });
  });
}

async function main(argv) {
  assertPinnedIssuerDistribution();
  const execute = argv[0] === '--execute';
  const args = execute ? argv.slice(1) : argv;
  if (args.length !== (execute ? 4 : 2) || args[0] !== '--artifact' || (execute && args[2] !== '--prepared-sha256')) stop('usage');
  const config = loadPinnedNativeStaffBootstrapExecutorConfig();
  assertPinnedInstallerSource(config);
  const artifact = JSON.parse(readPrivateFile(path.resolve(args[1]), 16 * 1024 * 1024));
  let plan;
  try { plan = JSON.parse(artifact.canonicalPlanJson); } catch { stop('artifact_invalid'); }
  if (!UUID.test(plan?.approvalId ?? '')) stop('artifact_invalid');
  const receiptPath = path.join(config.receiptDirectory, `native-staff-bootstrap-owner-approval-${plan?.approvalId ?? ''}.json`);
  let receipt;
  try { receipt = JSON.parse(readPrivateFile(receiptPath, 16 * 1024 * 1024)); } catch { stop('receipt_unavailable'); }
  const result = await runNativeStaffBootstrapApprovedExecutor({ artifact, receipt, mode: execute ? 'execute' : 'preview',
    preparedSha256: execute ? args[3] : undefined, getAccessToken: () => runPinnedCloudflaredToken(config),
    getBearerToken: wranglerBearerToken });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^native_staff_bootstrap_executor_[a-z0-9_]+$/u.test(error.message)
      ? error.message : 'native_staff_bootstrap_executor_unavailable';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  });
}
