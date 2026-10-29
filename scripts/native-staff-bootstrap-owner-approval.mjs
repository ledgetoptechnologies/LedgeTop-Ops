import { createHash, createPublicKey, constants, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeStaffBootstrapD1InsertColumns } from './native-staff-bootstrap-d1.mjs';
import { assertPinnedIssuerDistribution } from './native-staff-bootstrap-owner-approval-distribution-pin.mjs';

// Intentionally unconfigured in source. A separate reviewed Windows trust-config
// provisioning step must pin the exact owner, target, source, and verifier key.
// Captured cohort data or a newly generated key must never fill this pin.
export const PINNED_TRUST_CONFIG_SHA256 = '0'.repeat(64);
export const BOOTSTRAP_OWNER_APPROVAL_KIND = 'operations-native-staff-bootstrap-owner-approval-v1';
export const BOOTSTRAP_OWNER_CONSENT_PREFIX = 'APPROVE OPERATIONS STAFF BOOTSTRAP';
export const BOOTSTRAP_APPROVAL_STATE_KIND = 'operations-native-staff-bootstrap-approval-state-v1';
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_JWKS_BYTES = 128 * 1024;
const MAX_TTL_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const BOOTSTRAP_AUTHORITY_TABLES = Object.freeze([
  'staff_users', 'staff_divisions', 'permissions', 'roles', 'role_permissions', 'staff_role_assignments',
  'staff_permission_overrides', 'local_staff_role_assignments', 'native_business_areas', 'native_staff_admissions',
  'native_staff_profiles', 'native_staff_target_memberships', 'native_staff_admin_delegations',
  'native_staff_management_delegations', 'native_staff_delegation_ceilings', 'native_staff_authority_capabilities',
  'native_staff_access_reconciliation', 'native_directory_grants', 'native_directory_grant_generations',
  'native_directory_grant_history', 'native_project_grants', 'native_project_grant_generations',
  'native_directory_assignments', 'native_directory_resource_scopes', 'native_business_divisions',
  'native_staff_admin_command_fences', 'native_staff_admin_commands', 'native_staff_management_commands',
]);
const AUTHORITY_WIDE_TABLES = new Set(['native_business_areas', 'native_business_divisions',
  'native_directory_resource_scopes', 'native_staff_delegation_ceilings', 'native_staff_authority_capabilities',
  'native_staff_access_reconciliation']);
const ID_FIELD = /(?:staff|user)_id$/u;
const CLIENT_REFERENCE_COLUMNS = Object.freeze({
  native_business_areas: { id: 'business_area_ref_sha256' },
  native_business_divisions: { id: 'division_ref_sha256', business_area_id: 'business_area_ref_sha256' },
  native_directory_resource_scopes: { record_id: 'record_ref_sha256', business_area_id: 'business_area_ref_sha256',
    division_id: 'division_ref_sha256' },
  native_directory_grants: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256', resource_id: 'resource_ref_sha256' },
  native_directory_grant_history: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256', resource_id: 'resource_ref_sha256' },
  native_project_grants: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256', external_project_id: 'external_project_ref_sha256' },
  native_directory_assignments: { record_id: 'record_ref_sha256' },
  native_staff_target_memberships: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256' },
  native_staff_admin_delegations: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256' },
  native_staff_management_delegations: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256' },
  native_staff_delegation_ceilings: { business_area_id: 'business_area_ref_sha256', division_id: 'division_ref_sha256', resource_id: 'resource_ref_sha256' },
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`native_staff_bootstrap_owner_${code}`); };

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('json_invalid');
    return encoded;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('json_invalid');
  const keys = Object.keys(value).sort();
  if (Reflect.ownKeys(value).length !== keys.length) fail('json_invalid');
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { return fail(code); }
}

export function parseTrustConfig(text, expectedSha256) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 32 * 1024) fail('trust_config_invalid');
  if (!HASH.test(expectedSha256 ?? '') || sha256(text) !== expectedSha256) fail('trust_config_pin_mismatch');
  const value = parseJson(text, 'trust_config_invalid');
  const keys = ['schemaVersion', 'kind', 'target', 'source', 'access', 'signer', 'receiptDirectory'];
  if (!exactObject(value, keys) || value.schemaVersion !== 1 || value.kind !== 'operations-native-staff-bootstrap-trust-config-v1'
    || !exactObject(value.target, ['accountId', 'databaseId']) || !/^[a-f0-9]{32}$/u.test(value.target.accountId)
    || !/^[a-f0-9-]{36}$/u.test(value.target.databaseId)
    || !exactObject(value.source, ['commit', 'migrationNamesSha256']) || !/^[0-9a-f]{40}$/u.test(value.source.commit)
    || !HASH.test(value.source.migrationNamesSha256)
    || !exactObject(value.access, ['origin', 'issuer', 'audience', 'owner', 'cloudflaredExecutablePath', 'cloudflaredExecutableSha256'])
    || !exactObject(value.access.owner, ['staffId', 'accessSubject'])
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(value.access.owner.staffId)
    || typeof value.access.owner.accessSubject !== 'string' || !value.access.owner.accessSubject.trim()
    || value.access.owner.accessSubject.length > 191
    || !exactObject(value.signer, ['algorithm', 'keyId', 'publicKeyPem', 'protectedPrivateKeyPath', 'dpapiEntropy'])
    || value.signer.algorithm !== 'RSA-PSS-SHA256' || !HASH.test(value.signer.keyId)
    || typeof value.signer.publicKeyPem !== 'string' || value.signer.publicKeyPem.length > 16 * 1024
    || typeof value.signer.protectedPrivateKeyPath !== 'string' || !path.isAbsolute(value.signer.protectedPrivateKeyPath)
    || typeof value.signer.dpapiEntropy !== 'string' || value.signer.dpapiEntropy.length < 32
    || typeof value.receiptDirectory !== 'string' || !path.isAbsolute(value.receiptDirectory)) fail('trust_config_invalid');
  const origin = new URL(value.access.origin), issuer = new URL(value.access.issuer);
  if (origin.protocol !== 'https:' || origin.origin !== value.access.origin || origin.username || origin.password
    || origin.port || origin.pathname !== '/' || origin.search || origin.hash
    || issuer.protocol !== 'https:' || issuer.origin !== value.access.issuer || issuer.username || issuer.password
    || issuer.port || issuer.pathname !== '/' || issuer.search || issuer.hash
    || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.hostname === '.cloudflareaccess.com'
    || typeof value.access.audience !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.access.audience)
    || typeof value.access.cloudflaredExecutablePath !== 'string' || !path.isAbsolute(value.access.cloudflaredExecutablePath)
    || !HASH.test(value.access.cloudflaredExecutableSha256))
    fail('trust_config_invalid');
  let publicKey;
  try { publicKey = createPublicKey(value.signer.publicKeyPem); } catch { fail('trust_config_invalid'); }
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
    || sha256(publicKey.export({ type: 'spki', format: 'der' })) !== value.signer.keyId) fail('trust_config_invalid');
  return Object.freeze(value);
}

export function assertPinnedInstallerSource(config, { cwd = fileURLToPath(new URL('..', import.meta.url)), run = execFileSync,
  read = readFileSync, directory = path.join(cwd, 'apps', 'operations', 'migrations') } = {}) {
  const git = args => {
    try { return run('git', args, { cwd, encoding: args[0] === 'show' ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return fail('installer_source_unavailable'); }
  };
  const commit = config?.source?.commit;
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) fail('installer_source_pin_invalid');
  git(['cat-file', '-e', `${commit}^{commit}`]);
  const names = String(git(['ls-tree', '-r', '--name-only', commit, '--', 'apps/operations/migrations']))
    .split(/\r?\n/u).filter(name => name.endsWith('.sql')).map(name => name.slice('apps/operations/migrations/'.length))
    .filter(name => /^\d{4}_/u.test(name) && Number(name.slice(0, 4)) <= 225).sort();
  if (names.length !== 225 || names.at(-1) !== '0225_native_staff_lifecycle_bridge.sql'
    || sha256(names.join('\n')) !== config.source.migrationNamesSha256) fail('installer_migration_pin_mismatch');
  const localNames = readdirSync(directory).filter(name => name.endsWith('.sql') && /^\d{4}_/u.test(name)
    && Number(name.slice(0, 4)) <= 225).sort();
  if (canonicalJson(localNames) !== canonicalJson(names)) fail('installer_migration_tree_mismatch');
  const paths = ['scripts/native-staff-bootstrap-d1.mjs', ...names.map(name => `apps/operations/migrations/${name}`)];
  for (const relative of paths) {
    const committed = git(['show', `${commit}:${relative}`]);
    const localPath = path.join(cwd, ...relative.split('/'));
    let local;
    try { local = read(localPath); } catch { fail('installer_source_unavailable'); }
    if (!Buffer.isBuffer(committed) || !Buffer.isBuffer(local)
      || committed.toString('utf8').replace(/\r\n/gu, '\n') !== local.toString('utf8').replace(/\r\n/gu, '\n'))
      fail('installer_source_tree_mismatch');
  }
  return true;
}

function decodeJwtPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) fail('access_token_invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('access_token_invalid');
  return parseJson(bytes.toString('utf8'), 'access_token_invalid');
}

async function boundedFetch(url, init, maxBytes, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') fail('remote_endpoint_invalid');
  const response = await fetchImpl(target, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status >= 300 && response.status < 400) fail('remote_redirect_refused');
  if (!response.ok) fail('remote_request_failed');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) fail('remote_response_too_large');
  if (!response.body) fail('remote_response_invalid');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) { await response.body.cancel().catch(() => {}); fail('remote_response_too_large'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function verifyCloudflareAccessJwt(token, access, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token.length > 16_384) fail('access_token_invalid');
  const parts = token.split('.');
  if (parts.length !== 3) fail('access_token_invalid');
  const header = decodeJwtPart(parts[0]), claims = decodeJwtPart(parts[1]);
  // RFC 7519 §5.1 makes `typ` optional. When supplied, keep this verifier's
  // stricter accepted value and reject every other JOSE header parameter.
  const headerKeys = header && typeof header === 'object' && Object.hasOwn(header, 'typ')
    ? ['alg', 'kid', 'typ'] : ['alg', 'kid'];
  if (!exactObject(header, headerKeys) || header.alg !== 'RS256' || typeof header.kid !== 'string'
    || (Object.hasOwn(header, 'typ') && header.typ !== 'JWT')
    || !claims || typeof claims !== 'object' || Array.isArray(claims)) fail('access_token_invalid');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== access.issuer || !Array.isArray(audiences) || audiences.length !== 1
    || audiences[0] !== access.audience || claims.type !== 'app' || claims.sub !== access.owner.accessSubject
    || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds
    || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat < 0
    || claims.iat > seconds || claims.iat >= claims.exp
    || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds))
    || Object.hasOwn(claims, 'common_name') || Object.hasOwn(claims, 'service_token_id')
    || (Object.hasOwn(claims, 'service_token_status') && claims.service_token_status !== false)) fail('access_token_claims_invalid');
  const jwksUrl = new URL('/cdn-cgi/access/certs', access.issuer);
  const jwks = parseJson(await boundedFetch(jwksUrl, { method: 'GET', headers: { accept: 'application/json' } }, MAX_JWKS_BYTES,
    { fetchImpl }), 'jwks_invalid');
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length > 32) fail('jwks_invalid');
  const jwk = jwks.keys.find(key => key?.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA' || jwk.alg && jwk.alg !== 'RS256' || jwk.use && jwk.use !== 'sig') fail('access_signing_key_missing');
  let publicKey;
  try { publicKey = createPublicKey({ key: jwk, format: 'jwk' }); } catch { fail('jwks_invalid'); }
  const valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
  if (!valid) fail('access_token_signature_invalid');
  return Object.freeze({ issuer: claims.iss, audience: access.audience, subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null, issuedAt: claims.iat,
    expiresAt: claims.exp, assertionSha256: sha256(token) });
}

function normalizeStaffRows(rows) {
  if (!Array.isArray(rows) || rows.length > 20_000) fail('live_review_invalid');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('live_review_invalid');
    const copy = { ...row }; delete copy.last_seen_at; return copy;
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function normalizeReferenceRows(table, rows) {
  if (!Array.isArray(rows) || rows.length > 20_000) fail('live_review_invalid');
  const renamedHashes = CLIENT_REFERENCE_COLUMNS[table] ?? {};
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('live_review_invalid');
    const copy = { ...row };
    for (const [column, renamed] of Object.entries(renamedHashes)) {
      if (Object.hasOwn(copy, column)) {
        const raw = copy[column];
        delete copy[column];
        copy[renamed] = raw === null || raw === undefined ? null : sha256(canonicalJson(raw));
      }
    }
    if (table === 'staff_users') delete copy.last_seen_at;
    return copy;
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function installerSelectsRow(table, row, staffIds) {
  if (AUTHORITY_WIDE_TABLES.has(table) || ['staff_users', 'staff_divisions', 'permissions', 'roles',
    'role_permissions', 'staff_role_assignments', 'staff_permission_overrides', 'local_staff_role_assignments'].includes(table)) return true;
  return Object.entries(row).some(([column, value]) =>
    (column === 'staff_id' || column === 'user_id' || ID_FIELD.test(column) || column === 'record_id')
      && staffIds.has(value));
}

export function validateLiveOwnerReview(reviewResponse, reviewedSnapshot, config, verifiedSession) {
  if (!exactObject(reviewResponse, ['packet', 'packetSha256']) || !HASH.test(reviewResponse.packetSha256)
    || !reviewResponse.packet || reviewResponse.packet.schemaVersion !== 1
    || reviewResponse.packet.kind !== 'operations-current-staff-cohort-review-draft-v1'
    || reviewResponse.packet.ownerStaffId !== config.access.owner.staffId
    || reviewResponse.packet.status !== 'draft' || reviewResponse.packet.advisory !== true
    || reviewResponse.packet.executionAuthority !== false || reviewResponse.packet.bootstrapApproval !== false
    || reviewResponse.packet.installerClaim !== false
    || sha256(canonicalJson(reviewResponse.packet)) !== reviewResponse.packetSha256
    || verifiedSession.staffId !== config.access.owner.staffId) fail('live_review_invalid');
  const liveTables = reviewResponse.packet.tables, snapshot = parseJson(reviewedSnapshot.snapshotJson, 'snapshot_invalid');
  if (!liveTables || !snapshot.rows) fail('live_review_invalid');
  const staffIds = new Set((liveTables.staff_users ?? []).map(row => row.id));
  for (const name of BOOTSTRAP_AUTHORITY_TABLES) {
    const liveRows = liveTables[name], snapRows = snapshot.rows[name];
    if (liveRows === null && snapRows === undefined) continue;
    if (!Object.hasOwn(snapshot.rows, name)) {
      if (Array.isArray(liveRows) && liveRows.some(row => installerSelectsRow(name, row, staffIds)))
        fail(`live_authority_state_not_snapshot_pinned_${name}`);
      continue;
    }
    if (!Array.isArray(liveRows) || !Array.isArray(snapRows)) fail(`live_authority_table_mismatch_${name}`);
    const selectedLiveRows = liveRows.filter(row => installerSelectsRow(name, row, staffIds));
    if (canonicalJson(normalizeReferenceRows(name, selectedLiveRows))
      !== canonicalJson(normalizeReferenceRows(name, snapRows))) fail(`live_authority_state_mismatch_${name}`);
  }
  const owner = (reviewResponse.packet.cohort ?? []).find(person => person?.staffId === config.access.owner.staffId);
  if (!owner || owner.status !== 'active' || owner.accessSubject !== config.access.owner.accessSubject
    || owner.bridgeStatus !== 'matched' || owner.admission?.active !== 1
    || owner.admission?.bound_access_subject !== config.access.owner.accessSubject
    || owner.profile?.staff_id !== config.access.owner.staffId) fail('pinned_owner_not_current');
  const stablePacket = structuredClone(reviewResponse.packet);
  for (const row of stablePacket.tables.staff_users) delete row.last_seen_at;
  return Object.freeze({ liveCohortPacketSha256: sha256(canonicalJson(stablePacket)),
    liveCohortRawPacketSha256: reviewResponse.packetSha256,
    comparedAuthorityTables: BOOTSTRAP_AUTHORITY_TABLES.filter(name => Array.isArray(liveTables[name])).length,
    liveStaffCount: reviewResponse.packet.cohort.length,
    liveActiveStaffCount: reviewResponse.packet.cohort.filter(person => person?.status === 'active').length });
}

function artifactSnapshot(artifact, config) {
  if (!exactObject(artifact, ['canonicalPlanJson', 'bindingEvidenceJson', 'reviewedSnapshot', 'commandId'])
    || typeof artifact.canonicalPlanJson !== 'string' || typeof artifact.bindingEvidenceJson !== 'string'
    || !UUID.test(artifact.commandId) || !exactObject(artifact.reviewedSnapshot,
      ['snapshotJson', 'snapshotSha256', 'migrationNames', 'migrationNamesSha256', 'currentStaffCount', 'controlPlaneStaffIds']))
    fail('artifact_invalid');
  const snapshot = artifact.reviewedSnapshot;
  if (typeof snapshot.snapshotJson !== 'string' || Buffer.byteLength(snapshot.snapshotJson, 'utf8') > MAX_ARTIFACT_BYTES
    || sha256(snapshot.snapshotJson) !== snapshot.snapshotSha256 || !Array.isArray(snapshot.migrationNames)
    || snapshot.migrationNames.length !== 225 || snapshot.migrationNames.at(-1) !== '0225_native_staff_lifecycle_bridge.sql'
    || sha256(snapshot.migrationNames.join('\n')) !== snapshot.migrationNamesSha256
    || snapshot.migrationNamesSha256 !== config.source.migrationNamesSha256) fail('snapshot_invalid');
  const plan = parseJson(artifact.canonicalPlanJson, 'plan_invalid');
  const binding = parseJson(artifact.bindingEvidenceJson, 'binding_evidence_invalid');
  if (canonicalJson(plan) !== artifact.canonicalPlanJson || canonicalJson(binding) !== artifact.bindingEvidenceJson
    || plan.kind !== 'operations-native-staff-bootstrap-install-v1'
    || plan.reviewedSnapshotSha256 !== snapshot.snapshotSha256 || !UUID.test(plan.approvalId)
    || !Array.isArray(plan.staffCohort) || !plan.staffCohort.length || !Array.isArray(plan.rows) || !plan.rows.length
    || !Array.isArray(plan.controlPlaneStaffIds) || !plan.controlPlaneStaffIds.includes(config.access.owner.staffId))
    fail('plan_binding_invalid');
  for (const operation of plan.rows) {
    if (!operation || !Object.hasOwn(nativeStaffBootstrapD1InsertColumns, operation.table)
      || !exactObject(operation.row, nativeStaffBootstrapD1InsertColumns[operation.table])) fail('plan_row_invalid');
  }
  return Object.freeze({ snapshot, plan, binding, planSha256: sha256(artifact.canonicalPlanJson),
    bindingSha256: sha256(artifact.bindingEvidenceJson) });
}

export function ownerApprovalConsentText({ planSha256, bindingEvidenceSha256, snapshotSha256, liveCohortPacketSha256 }) {
  if (![planSha256, bindingEvidenceSha256, snapshotSha256, liveCohortPacketSha256].every(value => HASH.test(value ?? ''))) fail('hash_invalid');
  return `${BOOTSTRAP_OWNER_CONSENT_PREFIX} ${planSha256} ${bindingEvidenceSha256} ${snapshotSha256} ${liveCohortPacketSha256}`;
}

export function preparedOwnerApprovalConsentText(prepared, liveReviewProof) {
  return ownerApprovalConsentText({ planSha256: prepared.planSha256, bindingEvidenceSha256: prepared.bindingSha256,
    snapshotSha256: prepared.snapshot.snapshotSha256, liveCohortPacketSha256: liveReviewProof.liveCohortPacketSha256 });
}

export function buildOwnerApprovalReceipt({ config, artifact, liveReview, ownerClaims, now = Date.now(), authorizationChallenge }) {
  if (!HASH.test(authorizationChallenge ?? '') || ownerClaims.issuer !== config.access.issuer
    || ownerClaims.audience !== config.access.audience || ownerClaims.subject !== config.access.owner.accessSubject
    || !Number.isSafeInteger(ownerClaims.issuedAt) || ownerClaims.issuedAt < 0 || ownerClaims.issuedAt > Math.floor(now / 1000)
    || !Number.isSafeInteger(ownerClaims.expiresAt)
    || ownerClaims.expiresAt * 1000 <= now || !HASH.test(ownerClaims.assertionSha256 ?? '')) fail('owner_session_invalid');
  const prepared = artifactSnapshot(artifact, config);
  const snapshotSha256 = prepared.snapshot.snapshotSha256;
  const packetProof = validateLiveOwnerReview(liveReview, prepared.snapshot, config,
    { staffId: config.access.owner.staffId });
  const liveTables = liveReview.packet.tables;
  const previousApprovals = liveTables.native_staff_bootstrap_approvals;
  const previousReceipts = liveTables.native_staff_bootstrap_receipts;
  if (!Array.isArray(previousApprovals) || !Array.isArray(previousReceipts)
    || previousApprovals.some(row => row.approval_id === prepared.plan.approvalId)
    || previousReceipts.some(row => row.command_id === artifact.commandId
      || row.approval_id === prepared.plan.approvalId)) fail('approval_replay_detected');
  const activeLegacyById = new Map((liveTables.staff_users ?? []).map(row => [row.id, row]));
  const nativeAdmissionById = new Map((liveTables.native_staff_admissions ?? []).map(row => [row.staff_id, row]));
  const nativeProfileById = new Map((liveTables.native_staff_profiles ?? []).map(row => [row.staff_id, row]));
  const admissionRows = prepared.plan.rows.filter(item => item.table === 'native_staff_admissions');
  const profileRows = prepared.plan.rows.filter(item => item.table === 'native_staff_profiles');
  if (admissionRows.length !== profileRows.length || admissionRows.length !== prepared.plan.staffCohort.length)
    fail('plan_identity_rows_invalid');
  if (new Set(prepared.plan.staffCohort).size !== prepared.plan.staffCohort.length
    || new Set(admissionRows.map(item => item.row.staff_id)).size !== admissionRows.length
    || admissionRows.some(item => !prepared.plan.staffCohort.includes(item.row.staff_id))) fail('plan_identity_rows_invalid');
  for (const item of admissionRows) {
    const row = item.row, staff = activeLegacyById.get(row.staff_id);
    const profile = profileRows.find(candidate => candidate.row.staff_id === row.staff_id)?.row;
    if (!staff || staff.status !== 'active' || !staff.access_subject
      || staff.access_subject !== row.bound_access_subject || row.active !== 1
      || nativeAdmissionById.has(row.staff_id) || nativeProfileById.has(row.staff_id)
      || !profile || profile.staff_id !== staff.id || profile.login_email !== staff.email
      || profile.display_name !== staff.display_name || profile.version !== 1) fail('live_plan_identity_mismatch');
  }
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(Math.min(ownerClaims.expiresAt * 1000, now + MAX_TTL_MS)).toISOString();
  if (Date.parse(expiresAt) <= now) fail('owner_session_expired');
  const approvalId = prepared.plan.approvalId, commandId = artifact.commandId;
  const sessionId = randomUUID();
  const consentPhrase = ownerApprovalConsentText({ planSha256: prepared.planSha256, bindingEvidenceSha256: prepared.bindingSha256,
    snapshotSha256, liveCohortPacketSha256: packetProof.liveCohortPacketSha256 });
  const trustEnvelope = {
    schemaVersion: 1, action: 'install-operations-native-staff-bootstrap', ownerSessionId: sessionId,
    authorizationChallenge, approvalId, commandId,
    approvedOperatorStaffId: config.access.owner.staffId,
    approvedOperatorAccessSubject: config.access.owner.accessSubject,
    issuedByStaffId: config.access.owner.staffId, issuedByAccessSubject: config.access.owner.accessSubject,
    authorizedAt: issuedAt, expiresAt, reviewedSnapshotSha256: snapshotSha256,
    canonicalPlanSha256: prepared.planSha256, bindingEvidenceSha256: prepared.bindingSha256,
    consentPhrase: 'I approve this exact Operations staff cohort and native authority plan',
  };
  const payload = {
    schemaVersion: 1, kind: BOOTSTRAP_OWNER_APPROVAL_KIND,
    target: config.target, source: config.source,
    ownerAccess: { issuer: ownerClaims.issuer, audience: ownerClaims.audience,
      staffId: config.access.owner.staffId, accessSubject: ownerClaims.subject,
      assertionSha256: ownerClaims.assertionSha256, verifiedAt: issuedAt, expiresAt },
    liveCohortPacketSha256: packetProof.liveCohortPacketSha256,
    canonicalPlanSha256: prepared.planSha256, reviewedSnapshotSha256: snapshotSha256,
    bindingEvidenceSha256: prepared.bindingSha256, ownerConsentText: consentPhrase,
    trustEnvelope,
  };
  return Object.freeze({ payload, payloadJson: canonicalJson(payload), keyId: config.signer.keyId,
    algorithm: config.signer.algorithm });
}

export function verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now = Date.now(), expected } = {}) {
  const receiptKeys = ['schemaVersion', 'kind', 'algorithm', 'keyId', 'payload', 'signature'];
  if (!exactObject(receipt, receiptKeys) || receipt.schemaVersion !== 1 || receipt.kind !== BOOTSTRAP_OWNER_APPROVAL_KIND
    || receipt.algorithm !== 'RSA-PSS-SHA256' || receipt.keyId !== config.signer.keyId
    || typeof receipt.signature !== 'string' || receipt.signature.length > 4096) fail('receipt_invalid');
  const payload = receipt.payload;
  if (!exactObject(payload, ['schemaVersion', 'kind', 'target', 'source', 'ownerAccess', 'liveCohortPacketSha256',
    'canonicalPlanSha256', 'reviewedSnapshotSha256', 'bindingEvidenceSha256', 'ownerConsentText', 'trustEnvelope'])
    || payload.schemaVersion !== 1 || payload.kind !== BOOTSTRAP_OWNER_APPROVAL_KIND
    || !HASH.test(payload.liveCohortPacketSha256 ?? '') || !HASH.test(payload.canonicalPlanSha256 ?? '')
    || !HASH.test(payload.reviewedSnapshotSha256 ?? '') || !HASH.test(payload.bindingEvidenceSha256 ?? '')
    || canonicalJson(payload.target) !== canonicalJson(config.target)
    || canonicalJson(payload.source) !== canonicalJson(config.source)
    || !exactObject(payload.ownerAccess, ['issuer', 'audience', 'staffId', 'accessSubject', 'assertionSha256', 'verifiedAt', 'expiresAt'])
    || payload.ownerAccess?.staffId !== config.access.owner.staffId
    || payload.ownerAccess?.accessSubject !== config.access.owner.accessSubject
    || payload.ownerAccess?.issuer !== config.access.issuer || payload.ownerAccess?.audience !== config.access.audience)
    fail('receipt_binding_invalid');
  const envelope = payload.trustEnvelope;
  if (!exactObject(envelope, ['schemaVersion', 'action', 'ownerSessionId', 'authorizationChallenge', 'approvalId', 'commandId',
    'approvedOperatorStaffId', 'approvedOperatorAccessSubject', 'issuedByStaffId', 'issuedByAccessSubject', 'authorizedAt',
    'expiresAt', 'reviewedSnapshotSha256', 'canonicalPlanSha256', 'bindingEvidenceSha256', 'consentPhrase'])
    || envelope.schemaVersion !== 1 || envelope.action !== 'install-operations-native-staff-bootstrap'
    || typeof envelope.ownerSessionId !== 'string' || !UUID.test(envelope.ownerSessionId)
    || !HASH.test(envelope.authorizationChallenge ?? '') || !UUID.test(envelope.approvalId ?? '')
    || envelope.approvedOperatorStaffId !== config.access.owner.staffId
    || envelope.approvedOperatorAccessSubject !== config.access.owner.accessSubject
    || envelope.issuedByStaffId !== config.access.owner.staffId
    || envelope.issuedByAccessSubject !== config.access.owner.accessSubject
    || envelope.reviewedSnapshotSha256 !== payload.reviewedSnapshotSha256
    || envelope.canonicalPlanSha256 !== payload.canonicalPlanSha256
    || envelope.bindingEvidenceSha256 !== payload.bindingEvidenceSha256
    || payload.ownerAccess.verifiedAt !== envelope.authorizedAt || payload.ownerAccess.expiresAt !== envelope.expiresAt
    || !HASH.test(payload.ownerAccess.assertionSha256 ?? '')
    || !UUID.test(envelope.commandId ?? '')
    || !HASH.test(envelope.reviewedSnapshotSha256 ?? '') || !HASH.test(envelope.canonicalPlanSha256 ?? '')
    || !HASH.test(envelope.bindingEvidenceSha256 ?? '')
    || !Number.isFinite(Date.parse(envelope.authorizedAt)) || !Number.isFinite(Date.parse(envelope.expiresAt))
    || new Date(Date.parse(envelope.authorizedAt)).toISOString() !== envelope.authorizedAt
    || new Date(Date.parse(envelope.expiresAt)).toISOString() !== envelope.expiresAt
    || Date.parse(envelope.authorizedAt) > now || Date.parse(envelope.expiresAt) <= now
    || Date.parse(envelope.expiresAt) - Date.parse(envelope.authorizedAt) > MAX_TTL_MS
    || envelope.consentPhrase !== 'I approve this exact Operations staff cohort and native authority plan'
    || payload.ownerConsentText !== ownerApprovalConsentText({ planSha256: envelope.canonicalPlanSha256,
      bindingEvidenceSha256: envelope.bindingEvidenceSha256,
      snapshotSha256: envelope.reviewedSnapshotSha256, liveCohortPacketSha256: payload.liveCohortPacketSha256 }))
    fail('receipt_binding_invalid');
  if (expected) {
    if (expected.approval.approvalId !== envelope.approvalId
      || expected.approval.approvedOperatorStaffId !== envelope.approvedOperatorStaffId
      || expected.approval.approvedOperatorAccessSubject !== envelope.approvedOperatorAccessSubject
      || expected.approval.issuedByStaffId !== envelope.issuedByStaffId
      || expected.approval.issuedByAccessSubject !== envelope.issuedByAccessSubject
      || expected.approval.issuedAt !== envelope.authorizedAt || expected.approval.expiresAt !== envelope.expiresAt)
      fail('receipt_execution_mismatch_approval');
    if (expected.commandId !== envelope.commandId) fail('receipt_execution_mismatch_command');
    if (sha256(expected.canonicalPlanJson) !== envelope.canonicalPlanSha256) fail('receipt_execution_mismatch_plan');
    if (sha256(expected.bindingEvidenceJson) !== envelope.bindingEvidenceSha256) fail('receipt_execution_mismatch_binding');
    if (expected.reviewedSnapshot.snapshotSha256 !== envelope.reviewedSnapshotSha256)
      fail('receipt_execution_mismatch_snapshot');
  }
  const key = createPublicKey(config.signer.publicKeyPem);
  const signature = Buffer.from(receipt.signature, 'base64');
  const valid = verifySignature('sha256', Buffer.from(canonicalJson(payload)),
    { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
  if (!valid) fail('receipt_signature_invalid');
  return Object.freeze({ trusted: true, approvalId: envelope.approvalId, commandId: envelope.commandId,
    planSha256: envelope.canonicalPlanSha256, snapshotSha256: envelope.reviewedSnapshotSha256 });
}

function registryPaths(config) {
  const dir = config?.receiptDirectory;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('approval_registry_unavailable');
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('approval_registry_unavailable');
  return { state: path.join(dir, 'approval-state.json'), lock: path.join(dir, 'approval-state.lock') };
}

function validateRegistryState(envelope, config) {
  if (!exactObject(envelope, ['schemaVersion', 'kind', 'keyId', 'payload', 'signature'])
    || envelope.schemaVersion !== 1 || envelope.kind !== BOOTSTRAP_APPROVAL_STATE_KIND
    || envelope.keyId !== config.signer.keyId || typeof envelope.signature !== 'string'
    || !exactObject(envelope.payload, ['schemaVersion', 'sequence', 'previousStateSha256', 'entries'])
    || envelope.payload.schemaVersion !== 1 || !Number.isSafeInteger(envelope.payload.sequence)
    || envelope.payload.sequence < 0
    || !(envelope.payload.previousStateSha256 === null || HASH.test(envelope.payload.previousStateSha256))
    || !Array.isArray(envelope.payload.entries) || envelope.payload.entries.length > 10_000) fail('approval_registry_invalid');
  const seen = new Set();
  for (const entry of envelope.payload.entries) {
    if (!exactObject(entry, ['approvalId', 'commandId', 'receiptSha256', 'state', 'updatedAt'])
      || !UUID.test(entry.approvalId) || !UUID.test(entry.commandId) || !HASH.test(entry.receiptSha256)
      || !['issued', 'revoked', 'dispatching', 'consumed', 'uncertain'].includes(entry.state)
      || !Number.isFinite(Date.parse(entry.updatedAt)) || new Date(Date.parse(entry.updatedAt)).toISOString() !== entry.updatedAt
      || seen.has(entry.approvalId)) fail('approval_registry_invalid');
    seen.add(entry.approvalId);
  }
  const key = createPublicKey(config.signer.publicKeyPem);
  if (!verifySignature('sha256', Buffer.from(canonicalJson(envelope.payload)),
    { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(envelope.signature, 'base64')))
    fail('approval_registry_signature_invalid');
  return Object.freeze({ envelope, stateSha256: sha256(canonicalJson(envelope)) });
}

export function readNativeStaffBootstrapApprovalRegistry(config) {
  const { state } = registryPaths(config);
  let envelope;
  try {
    const info = lstatSync(state);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024)
      fail('approval_registry_invalid');
    envelope = parseJson(readFileSync(state, 'utf8'), 'approval_registry_invalid');
  }
  catch { fail('approval_registry_unavailable'); }
  return validateRegistryState(envelope, config);
}

function signedRegistryEnvelope(payload, config, protectedSign) {
  const signature = protectedSign(canonicalJson(payload), config);
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) fail('approval_registry_sign_failed');
  return { schemaVersion: 1, kind: BOOTSTRAP_APPROVAL_STATE_KIND, keyId: config.signer.keyId, payload, signature };
}

function persistRegistryState(config, payload, protectedSign) {
  const { state } = registryPaths(config), envelope = signedRegistryEnvelope(payload, config, protectedSign);
  const temporary = `${state}.${randomUUID()}.tmp`, bytes = `${canonicalJson(envelope)}\n`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes, { encoding: 'utf8' }); closeSync(fd); fd = undefined;
    renameSync(temporary, state);
  } catch {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    fail('approval_registry_write_failed');
  }
  return validateRegistryState(envelope, config);
}

function acquireRegistryLock(config) {
  const { lock } = registryPaths(config);
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, randomUUID(), { encoding: 'utf8' }); }
  catch { if (fd !== undefined) closeSync(fd); fail('approval_registry_locked'); }
  return () => { closeSync(fd); try { unlinkSync(lock); } catch { fail('approval_registry_lock_release_failed'); } };
}

function nextRegistryPayload(current, entries) {
  return { schemaVersion: 1, sequence: current.envelope.payload.sequence + 1,
    previousStateSha256: current.stateSha256, entries: entries.slice().sort((a, b) => a.approvalId.localeCompare(b.approvalId)) };
}

/** Separate provisioning-only operation; normal issuance refuses a missing registry. */
export function initializeNativeStaffBootstrapApprovalRegistry(config, protectedSign) {
  if (typeof protectedSign !== 'function') fail('approval_registry_signer_required');
  const release = acquireRegistryLock(config);
  try {
    const { state } = registryPaths(config);
    try { lstatSync(state); fail('approval_registry_already_initialized'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return persistRegistryState(config, { schemaVersion: 1, sequence: 0, previousStateSha256: null, entries: [] }, protectedSign);
  } finally { release(); }
}

function receiptRegistryIdentity(receipt, config) {
  const trusted = verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config });
  return { approvalId: trusted.approvalId, commandId: trusted.commandId, receiptSha256: sha256(canonicalJson(receipt)) };
}

/** Register a signed receipt before it is published to the executor. */
export function issueNativeStaffBootstrapApproval(config, receipt, protectedSign) {
  if (typeof protectedSign !== 'function') fail('approval_registry_signer_required');
  const identity = receiptRegistryIdentity(receipt, config), release = acquireRegistryLock(config);
  try {
    const current = readNativeStaffBootstrapApprovalRegistry(config);
    if (current.envelope.payload.entries.some(entry => entry.approvalId === identity.approvalId
      || entry.commandId === identity.commandId)) fail('approval_registry_replay');
    const entry = { ...identity, state: 'issued', updatedAt: new Date().toISOString() };
    return persistRegistryState(config, nextRegistryPayload(current, [...current.envelope.payload.entries, entry]), protectedSign);
  } finally { release(); }
}

/** Owner-authorized revocation; caller must collect a fresh owner session and typed consent first. */
export function revokeNativeStaffBootstrapApproval(config, receipt, protectedSign, expectedStateSha256) {
  if (typeof protectedSign !== 'function') fail('approval_registry_signer_required');
  if (!HASH.test(expectedStateSha256 ?? '')) fail('approval_registry_hash_required');
  const identity = receiptRegistryIdentity(receipt, config), release = acquireRegistryLock(config);
  try {
    const current = readNativeStaffBootstrapApprovalRegistry(config);
    if (current.stateSha256 !== expectedStateSha256) fail('approval_registry_changed_after_consent');
    const index = current.envelope.payload.entries.findIndex(entry => entry.approvalId === identity.approvalId);
    if (index < 0 || current.envelope.payload.entries[index].receiptSha256 !== identity.receiptSha256
      || current.envelope.payload.entries[index].state !== 'issued') fail('approval_registry_not_revocable');
    const entries = current.envelope.payload.entries.slice();
    entries[index] = { ...entries[index], state: 'revoked', updatedAt: new Date().toISOString() };
    return persistRegistryState(config, nextRegistryPayload(current, entries), protectedSign);
  } finally { release(); }
}

/** Caller holds this lease across final trust checks, dispatch, and durable reconciliation. */
export function acquireNativeStaffBootstrapApprovalLease(config, receipt, protectedSign) {
  if (typeof protectedSign !== 'function') fail('approval_registry_signer_required');
  const identity = receiptRegistryIdentity(receipt, config), release = acquireRegistryLock(config);
  let finished = false;
  try {
    const current = readNativeStaffBootstrapApprovalRegistry(config);
    const index = current.envelope.payload.entries.findIndex(entry => entry.approvalId === identity.approvalId);
    if (index < 0 || current.envelope.payload.entries[index].commandId !== identity.commandId
      || current.envelope.payload.entries[index].receiptSha256 !== identity.receiptSha256
      || current.envelope.payload.entries[index].state !== 'issued') fail('approval_registry_not_issuable');
    const entries = current.envelope.payload.entries.slice();
    entries[index] = { ...entries[index], state: 'dispatching', updatedAt: new Date().toISOString() };
    const dispatching = persistRegistryState(config, nextRegistryPayload(current, entries), protectedSign);
    return Object.freeze({ stateSha256: dispatching.stateSha256, finish(outcome) {
      if (finished || !['consumed', 'uncertain'].includes(outcome)) fail('approval_registry_finish_invalid');
      const latest = readNativeStaffBootstrapApprovalRegistry(config);
      const latestIndex = latest.envelope.payload.entries.findIndex(entry => entry.approvalId === identity.approvalId);
      if (latestIndex < 0 || latest.envelope.payload.entries[latestIndex].state !== 'dispatching') fail('approval_registry_state_changed');
      const finalEntries = latest.envelope.payload.entries.slice();
      finalEntries[latestIndex] = { ...finalEntries[latestIndex], state: outcome, updatedAt: new Date().toISOString() };
      persistRegistryState(config, nextRegistryPayload(latest, finalEntries), protectedSign);
      finished = true; release();
    } });
  } catch (error) { release(); throw error; }
}

export function runPinnedCloudflaredToken(config, { spawn = spawnSync, stat = lstatSync, read = readFileSync, env = process.env } = {}) {
  const executable = config?.access?.cloudflaredExecutablePath, expectedSha = config?.access?.cloudflaredExecutableSha256;
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !HASH.test(expectedSha ?? '')) fail('cloudflared_path_unpinned');
  let info, bytes;
  try { info = stat(executable); bytes = read(executable); } catch { fail('cloudflared_unavailable'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 200 * 1024 * 1024
    || sha256(bytes) !== expectedSha) fail('cloudflared_binary_pin_mismatch');
  const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
    .filter(name => typeof env[name] === 'string' && env[name].length > 0).map(name => [name, env[name]]));
  const result = spawn(executable, ['access', 'token', `-app=${config.access.origin}`], { encoding: 'utf8', env: childEnv,
    windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') fail('cloudflared_token_unavailable');
  const token = result.stdout.trim();
  if (token.length > 16_384 || token.split('.').length !== 3) fail('cloudflared_token_invalid');
  return token;
}

async function readOwnerSessionAndCohort(config, token, { fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json', 'Cf-Access-Token': token };
  const sessionUrl = new URL('/api/session', config.access.origin);
  const session = parseJson(await boundedFetch(sessionUrl, { method: 'GET', headers }, MAX_HTTP_BYTES, { fetchImpl }), 'session_invalid');
  const csrf = session?.csrfToken, staffId = session?.user?.id;
  if (staffId !== config.access.owner.staffId || typeof csrf !== 'string' || csrf.length < 32 || csrf.length > 4096)
    fail('owner_session_mismatch');
  const cohortUrl = new URL('/api/staff/current-cohort-review', config.access.origin);
  const review = parseJson(await boundedFetch(cohortUrl, { method: 'POST', headers: { ...headers,
    origin: config.access.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-csrf-token': csrf }, body: '{}' }, MAX_HTTP_BYTES, { fetchImpl }), 'live_review_invalid');
  return { staffId, review };
}

export function protectedSign(payloadJson, config) {
  if (process.platform !== 'win32') fail('dpapi_windows_required');
  const script = fileURLToPath(new URL('./native-staff-bootstrap-sign-dpapi.ps1', import.meta.url));
  const request = JSON.stringify({ privateKeyPath: config.signer.protectedPrivateKeyPath,
    dpapiEntropy: config.signer.dpapiEntropy, payloadBase64: Buffer.from(payloadJson, 'utf8').toString('base64') });
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    input: request, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') fail('protected_signer_unavailable');
  const signature = result.stdout.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) || Buffer.from(signature, 'base64').length < 256) fail('protected_signature_invalid');
  return signature;
}

function loadPrivateTrustConfig() {
  if (PINNED_TRUST_CONFIG_SHA256 === '0'.repeat(64)) fail('trust_config_pin_not_provisioned');
  const base = process.env.LOCALAPPDATA;
  if (!base) fail('trust_config_unavailable');
  const file = path.join(base, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('trust_config_unavailable');
  return parseTrustConfig(readFileSync(file, 'utf8'), PINNED_TRUST_CONFIG_SHA256);
}

function readArtifactFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) fail('artifact_invalid');
  return parseJson(readFileSync(file, 'utf8'), 'artifact_invalid');
}

async function askForApproval(consentText, config) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('interactive_terminal_required');
  process.stdout.write('Native Operations staff bootstrap review\n');
  process.stdout.write(`Target account: ${config.target.accountId}\n`);
  process.stdout.write(`Target database: ${config.target.databaseId}\n`);
  process.stdout.write(`Exact consent text: ${consentText}\n`);
  process.stdout.write('Review the private plan artifact and type the exact consent text to issue one receipt.\n');
  const readline = await import('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question('Consent: ')).trim() === consentText; }
  finally { terminal.close(); }
}

function safePlanDeltaRows(plan) {
  const publicFields = new Set(['permission', 'effect', 'scope_kind', 'authority_domain', 'capability',
    'active', 'version', 'contract_version', 'grant_allow', 'grant_deny', 'operation_create', 'operation_revoke']);
  return plan.rows.map(({ table, row }) => ({ table, fields: Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, publicFields.has(key) && (typeof value === 'string' || typeof value === 'number' || value === null)
      ? value : `sha256:${sha256(canonicalJson(value))}`])) }));
}

async function main(argv) {
  assertPinnedIssuerDistribution();
  const config = loadPrivateTrustConfig();
  assertPinnedInstallerSource(config);
  if (argv.length === 2 && argv[0] === '--revoke') {
    const receipt = readArtifactFile(path.resolve(argv[1]));
    const identity = receiptRegistryIdentity(receipt, config);
    const token = runPinnedCloudflaredToken(config), claims = await verifyCloudflareAccessJwt(token, config.access);
    const session = await readOwnerSessionAndCohort(config, token);
    if (session.staffId !== config.access.owner.staffId || claims.subject !== config.access.owner.accessSubject)
      fail('owner_session_mismatch');
    const registry = readNativeStaffBootstrapApprovalRegistry(config);
    const entry = registry.envelope.payload.entries.find(item => item.approvalId === identity.approvalId);
    if (!entry || entry.commandId !== identity.commandId || entry.receiptSha256 !== identity.receiptSha256
      || entry.state !== 'issued') fail('approval_registry_not_revocable');
    const receiptId = identity.approvalId;
    const consent = `REVOKE ${receiptId} ${registry.stateSha256}`;
    process.stdout.write(`Revocation approval ID: ${receiptId}\nCurrent state SHA-256: ${registry.stateSha256}\n`);
    process.stdout.write(`Exact revocation consent text: ${consent}\n`);
    if (!await askForApproval(consent, config)) fail('owner_consent_not_given');
    if (Date.now() >= claims.expiresAt * 1000) fail('owner_session_expired');
    assertPinnedInstallerSource(config);
    const refreshed = await readOwnerSessionAndCohort(config, token);
    if (refreshed.staffId !== config.access.owner.staffId) fail('owner_session_mismatch');
    const after = readNativeStaffBootstrapApprovalRegistry(config);
    if (after.stateSha256 !== registry.stateSha256) fail('approval_registry_changed_after_consent');
    revokeNativeStaffBootstrapApproval(config, receipt, (payload, cfg) => protectedSign(payload, cfg), registry.stateSha256);
    process.stdout.write(`Approval revoked: ${receiptId}\n`);
    return;
  }
  if (argv.length !== 2 || argv[0] !== '--artifact') fail('usage');
  const artifact = readArtifactFile(path.resolve(argv[1]));
  readNativeStaffBootstrapApprovalRegistry(config);
  const prepared = artifactSnapshot(artifact, config);
  const token = runPinnedCloudflaredToken(config);
  const ownerClaims = await verifyCloudflareAccessJwt(token, config.access);
  if (ownerClaims.subject !== config.access.owner.accessSubject) fail('owner_session_mismatch');
  const current = await readOwnerSessionAndCohort(config, token);
  if (current.staffId !== config.access.owner.staffId) fail('owner_session_mismatch');
  const live = validateLiveOwnerReview(current.review, prepared.snapshot, config, current);
  const consentText = preparedOwnerApprovalConsentText(prepared, live);
  const changesByTable = Object.fromEntries([...new Set(prepared.plan.rows.map(row => row.table))]
    .sort().map(table => [table, prepared.plan.rows.filter(row => row.table === table).length]));
  process.stdout.write(`Live cohort: ${live.liveActiveStaffCount} active of ${live.liveStaffCount}\n`);
  process.stdout.write(`Plan staff count: ${prepared.plan.staffCohort.length}\n`);
  process.stdout.write(`Insert-only plan rows: ${JSON.stringify(changesByTable)}\n`);
  process.stdout.write(`Plan row review (identity/reference values are hashed): ${canonicalJson(safePlanDeltaRows(prepared.plan))}\n`);
  process.stdout.write(`Plan SHA-256: ${prepared.planSha256}\nSnapshot SHA-256: ${prepared.snapshot.snapshotSha256}\n`);
  process.stdout.write(`Binding evidence SHA-256: ${prepared.bindingSha256}\n`);
  process.stdout.write(`Live cohort authority SHA-256: ${live.liveCohortPacketSha256}\n`);
  if (!await askForApproval(consentText, config)) fail('owner_consent_not_given');
  assertPinnedInstallerSource(config);
  if (Date.now() >= ownerClaims.expiresAt * 1000) fail('owner_session_expired');
  assertPinnedInstallerSource(config);
  const refreshed = await readOwnerSessionAndCohort(config, token);
  if (refreshed.staffId !== config.access.owner.staffId) fail('owner_session_mismatch');
  const refreshedLive = validateLiveOwnerReview(refreshed.review, prepared.snapshot, config, refreshed);
  if (refreshedLive.liveCohortPacketSha256 !== live.liveCohortPacketSha256) fail('live_state_changed_after_consent');
  if (Date.now() >= ownerClaims.expiresAt * 1000) fail('owner_session_expired');
  const challenge = Buffer.from(randomBytes(32)).toString('hex');
  const signed = buildOwnerApprovalReceipt({ config, artifact, liveReview: refreshed.review,
    ownerClaims, authorizationChallenge: challenge });
  const signature = protectedSign(signed.payloadJson, config);
  const receipt = { schemaVersion: 1, kind: BOOTSTRAP_OWNER_APPROVAL_KIND, algorithm: signed.algorithm,
    keyId: signed.keyId, payload: signed.payload, signature };
  verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now: Date.now(), expected: {
    approval: { approvalId: signed.payload.trustEnvelope.approvalId,
      approvedOperatorStaffId: signed.payload.trustEnvelope.approvedOperatorStaffId,
      approvedOperatorAccessSubject: signed.payload.trustEnvelope.approvedOperatorAccessSubject,
      issuedByStaffId: signed.payload.trustEnvelope.issuedByStaffId,
      issuedByAccessSubject: signed.payload.trustEnvelope.issuedByAccessSubject,
      issuedAt: signed.payload.trustEnvelope.authorizedAt, expiresAt: signed.payload.trustEnvelope.expiresAt },
    commandId: signed.payload.trustEnvelope.commandId, canonicalPlanJson: artifact.canonicalPlanJson,
    bindingEvidenceJson: artifact.bindingEvidenceJson, reviewedSnapshot: prepared.snapshot,
  } });
  issueNativeStaffBootstrapApproval(config, receipt, (payload, cfg) => protectedSign(payload, cfg));
  const dir = config.receiptDirectory;
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('receipt_directory_invalid');
  const receiptPath = path.join(dir, `native-staff-bootstrap-owner-approval-${signed.payload.trustEnvelope.approvalId}.json`);
  const fd = openSync(receiptPath, 'wx', 0o600);
  try { writeFileSync(fd, `${canonicalJson(receipt)}\n`, { encoding: 'utf8' }); }
  finally { closeSync(fd); }
  process.stdout.write(`Signed owner decision receipt created: ${receiptPath}\n`);
  process.stdout.write(`Receipt SHA-256: ${sha256(canonicalJson(receipt))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^native_staff_bootstrap_owner_[a-z0-9_]+$/u.test(error.message)
      ? error.message : 'native_staff_bootstrap_owner_unavailable';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
