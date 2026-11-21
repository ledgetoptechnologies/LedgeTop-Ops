import type { AuthenticatedNativeStaffWithAdmissionVersion } from './native-staff-auth';
import { isNativeAccessSubject } from './native-access-subject';
import type { EmployeeReadAuthority } from './employee-read-authority';
import { recheckEmployeeReadAuthority } from './employee-read-authority';
import { canonicalEmployeeReadPath, type EmployeeReadSelection } from './employee-read-transport';
import { assertCurrentStaffLogin, snapshotStaffLoginProof } from './staff-login-bindings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAFF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length <= 160 && value.trim().length > 0 && value === value.trim() && !/\p{C}/u.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const names = Reflect.ownKeys(value);
  return names.length === keys.length && names.every(name => typeof name === 'string' && keys.includes(name)
    && Object.getOwnPropertyDescriptor(value, name)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, name)!, 'value'));
};
/** Write grants expire within 30 days (also enforced in D1 by 0245). */
export const WRITE_GRANT_MAX_SECONDS = 30 * 86400;
const WRITE_KINDS = new Set(['register-exclusive-root', 'grant-write']);
export class EmployeeProvisioningError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string) { super(code); }
}
export type EmployeeReadCommand = Readonly<Record<string, string | number>> & Readonly<{ commandId: string; kind: string }>;
export type EmployeeReadCommandReceipt = Readonly<{ schemaVersion: 1; commandId: string; kind: string; rootId: string; grantId: string | null; generation: number }>;

/** Strict command fields are deliberately separate from generic filesystem paths or arbitrary URLs. */
export function parseEmployeeReadCommand(value: unknown): EmployeeReadCommand {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new EmployeeProvisioningError(400, 'invalid-command');
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) throw new EmployeeProvisioningError(400, 'invalid-command');
  const kind = kindDescriptor.value;
  const fields: Record<string, readonly string[]> = {
    'register-root': ['commandId', 'kind', 'rootId', 'gatewayId', 'rootFingerprint', 'displayName'],
    'advance-root': ['commandId', 'kind', 'rootId', 'expectedGeneration', 'rootFingerprint', 'displayName', 'status'],
    'grant-read': ['commandId', 'kind', 'rootId', 'rootGeneration', 'rootFingerprint', 'grantId', 'targetStaffId', 'targetAccessSubject', 'targetAdmissionVersion', 'expiresAt'],
    'deny-read': ['commandId', 'kind', 'rootId', 'rootGeneration', 'rootFingerprint', 'grantId', 'targetStaffId', 'targetAccessSubject', 'targetAdmissionVersion', 'expiresAt'],
    'revoke-grant': ['commandId', 'kind', 'grantId', 'expectedGeneration'],
    // Staff Files write access (0245): stored in ops_employee_files_write_commands.
    'register-exclusive-root': ['commandId', 'kind', 'rootId', 'gatewayId', 'rootFingerprint', 'displayName'],
    'grant-write': ['commandId', 'kind', 'rootId', 'rootGeneration', 'rootFingerprint', 'grantId', 'targetStaffId', 'targetAccessSubject', 'targetAdmissionVersion', 'expiresAt'],
  };
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind) || !exact(value, fields[kind]!)) throw new EmployeeProvisioningError(400, 'invalid-command');
  const command = Object.freeze(Object.fromEntries(fields[kind]!.map(key => [key, value[key]])));
  if (!uuid(command.commandId) || (kind !== 'revoke-grant' && !uuid(command.rootId))
    || (['register-root', 'register-exclusive-root'].includes(kind) && (!uuid(command.gatewayId) || !sha(command.rootFingerprint) || !label(command.displayName)))
    || (kind === 'advance-root' && (!positive(command.expectedGeneration) || !sha(command.rootFingerprint) || !label(command.displayName)
      || typeof command.status !== 'string' || !['active', 'disabled'].includes(command.status)))
    || (['grant-read', 'deny-read', 'grant-write'].includes(kind) && (!uuid(command.grantId) || !positive(command.rootGeneration) || !sha(command.rootFingerprint)
      || typeof command.targetStaffId !== 'string' || !STAFF.test(command.targetStaffId) || !isNativeAccessSubject(command.targetAccessSubject)
      || !positive(command.targetAdmissionVersion) || !positive(command.expiresAt) || command.expiresAt > 253402300799))
    || (kind === 'revoke-grant' && (!uuid(command.grantId) || !positive(command.expectedGeneration)))) throw new EmployeeProvisioningError(400, 'invalid-command');
  return command as EmployeeReadCommand;
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function actorSnapshot(authenticated: AuthenticatedNativeStaffWithAdmissionVersion) {
  const fields = authenticated && typeof authenticated === 'object' && Object.hasOwn(authenticated, 'verifiedLogin')
    ? ['identity', 'admissionVersion', 'verifiedUntil', 'verifiedLogin'] : ['identity', 'admissionVersion', 'verifiedUntil'];
  if (!exact(authenticated, fields)
    || !exact(authenticated.identity, ['kind', 'staffId', 'verifiedAccessSubject', 'email', 'displayName', 'profileVersion'])) throw new EmployeeProvisioningError(403, 'denied');
  const identity = authenticated.identity;
  if (identity.kind !== 'native' || typeof identity.staffId !== 'string' || !STAFF.test(identity.staffId) || !isNativeAccessSubject(identity.verifiedAccessSubject)
    || !positive(authenticated.admissionVersion) || !positive(identity.profileVersion)
    || typeof identity.email !== 'string' || identity.email !== identity.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+$/u.test(identity.email)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(authenticated.verifiedUntil)
    || !Number.isFinite(Date.parse(authenticated.verifiedUntil)) || Date.parse(authenticated.verifiedUntil) <= Date.now()) throw new EmployeeProvisioningError(403, 'denied');
  const login = Object.hasOwn(authenticated, 'verifiedLogin') ? snapshotStaffLoginProof(authenticated.verifiedLogin) : undefined;
  if (login !== undefined && (!login || login.kind !== 'alternate' || login.staffId !== identity.staffId
    || login.canonicalEmail !== identity.email || login.canonicalSubject !== identity.verifiedAccessSubject
    || login.expiresAt * 1000 < Date.parse(authenticated.verifiedUntil))) throw new EmployeeProvisioningError(403, 'denied');
  return Object.freeze({ staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion, verifiedUntil: authenticated.verifiedUntil,
    ...(login ? { verifiedLogin: login } : {}) });
}

export async function provisionEmployeeRead(database: D1Database, authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  value: unknown, options: Readonly<{ gatewayIds: readonly string[] }>): Promise<EmployeeReadCommandReceipt> {
  const actor = actorSnapshot(authenticated), command = parseEmployeeReadCommand(value);
  // Contract (1, error table): a write grant beyond 30 days is a 409 conflict, the same answer D1 gives (0245 trigger).
  if (command.kind === 'grant-write' && Number(command.expiresAt) > Math.floor(Date.now() / 1000) + WRITE_GRANT_MAX_SECONDS)
    throw new EmployeeProvisioningError(409, 'conflict');
  if (actor.verifiedLogin && !await assertCurrentStaffLogin(database, actor.verifiedLogin)) throw new EmployeeProvisioningError(403, 'denied');
  const gateways = [...options.gatewayIds];
  if (!gateways.length || gateways.length > 100 || !gateways.every(uuid)) throw new EmployeeProvisioningError(503, 'unavailable');
  const session = database.withSession('first-primary');
  const manager = await session.prepare(MANAGER_SQL)
    .bind(actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.email, actor.verifiedUntil).first();
  if (!manager) throw new EmployeeProvisioningError(403, 'denied');
  let rootId = command.rootId as string | undefined, gatewayId = command.gatewayId as string | undefined;
  if (command.kind === 'revoke-grant') {
    const row = await session.prepare('SELECT root_id rootId FROM ops_employee_read_grants WHERE grant_id=?').bind(command.grantId).first<{ rootId: string }>();
    if (!row || !uuid(row.rootId)) throw new EmployeeProvisioningError(409, 'conflict');
    rootId = row.rootId;
  }
  if (command.kind !== 'register-root' && command.kind !== 'register-exclusive-root') {
    const row = await session.prepare('SELECT gateway_id gatewayId FROM ops_employee_read_roots WHERE root_id=?').bind(rootId!).first<{ gatewayId: string }>();
    if (!row) throw new EmployeeProvisioningError(409, 'conflict');
    gatewayId = row.gatewayId;
  }
  if (!gatewayId || !gateways.includes(gatewayId)) throw new EmployeeProvisioningError(403, 'denied');
  const payload = JSON.stringify(command);
  const requestHash = await digest(JSON.stringify(['employee-read-command-v1', actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, gatewayId, command]));
  const generation = ['advance-root', 'revoke-grant'].includes(command.kind) ? Number(command.expectedGeneration) + 1 : 1;
  if (actor.verifiedLogin && !await assertCurrentStaffLogin(database, actor.verifiedLogin)) throw new EmployeeProvisioningError(403, 'denied');
  const write = WRITE_KINDS.has(command.kind);
  const table = write ? 'ops_employee_files_write_commands' : 'ops_employee_read_commands';
  try {
    const results = await session.batch([
      session.prepare(`INSERT INTO ${table}(command_id,request_sha256,action,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
        actor_email,verified_until,root_id,configured_gateway_id,grant_id,result_generation,payload_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`).bind(command.commandId, requestHash, command.kind, actor.staffId,
        actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.email, actor.verifiedUntil, rootId!, gatewayId,
        command.grantId ?? null, generation, payload),
      // The single receipt resolver, read inside the same batch (atomic with the insert and its authority triggers).
      receiptStatement(session, command.commandId),
    ]);
    const row = results[1]?.results[0] as ReceiptRow | undefined;
    // The stored request hash must be this request's: a different request under the same id never yields a receipt.
    if (!results.every(result => result.success) || !row || row.requestHash !== requestHash) throw new EmployeeProvisioningError(503, 'unavailable');
    return decodeReceipt(row);
  } catch (error) {
    if (error instanceof EmployeeProvisioningError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('employee administration denied')) throw new EmployeeProvisioningError(403, 'denied');
    if (write && message.includes('replay conflict')) throw new EmployeeProvisioningError(409, 'command-conflict');
    if (message.includes('conflict') || message.includes('employee write grant requires') || message.includes('exclusive root'))
      throw new EmployeeProvisioningError(409, 'conflict');
    throw new EmployeeProvisioningError(503, 'unavailable');
  }
}

/** Audit is authorization-critical: the insert trigger rechecks exact current proof in the write transaction. */
const MANAGER_SQL = `SELECT 1 ok FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=? AND p.version=? AND p.login_email=?
      AND s.status='active' AND s.access_subject=a.bound_access_subject AND julianday(?)>julianday('now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=a.staff_id AND r.scope='global' AND r.role_id IN ('role-owner','role-admin'))
      AND (EXISTS(SELECT 1 FROM staff_role_assignments r JOIN role_permissions rp ON rp.role_id=r.role_id WHERE r.staff_id=a.staff_id AND r.scope='global' AND rp.permission_key='employee.files.manage')
        OR EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.scope='global' AND o.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.effect='deny')`;

type ReceiptRow = { commandId: string; kind: string; rootId: string; grantId: string | null; generation: number; requestHash: string };
/** The one receipt resolver: a single statement over both command tables (ids are unique across them, enforced in D1). */
function receiptStatement(session: D1DatabaseSession, commandId: string): D1PreparedStatement {
  return session.prepare(`SELECT command_id commandId,action kind,root_id rootId,grant_id grantId,result_generation generation,request_sha256 requestHash
      FROM ops_employee_read_commands WHERE command_id=?1
    UNION ALL SELECT command_id,action,root_id,grant_id,result_generation,request_sha256 FROM ops_employee_files_write_commands WHERE command_id=?1`).bind(commandId);
}
function decodeReceipt(row: ReceiptRow): EmployeeReadCommandReceipt {
  return Object.freeze({ schemaVersion: 1, commandId: row.commandId, kind: row.kind, rootId: row.rootId, grantId: row.grantId, generation: row.generation });
}
/** Replay lookup by id (no request to compare): the same statement and decoder as the live path. */
export async function resolveEmployeeFilesCommandReceipt(database: D1Database, commandId: string): Promise<EmployeeReadCommandReceipt | null> {
  if (!uuid(commandId)) return null;
  const rows = await receiptStatement(database.withSession('first-primary'), commandId).all<ReceiptRow>();
  if (!rows.success || rows.results.length > 1) throw new EmployeeProvisioningError(503, 'unavailable');
  return rows.results[0] ? decodeReceipt(rows.results[0]) : null;
}

export type EmployeeFilesAccessListing = Readonly<{
  schemaVersion: 1; canManage: boolean;
  target: Readonly<{ staffId: string; accessSubject: string | null; admissionVersion: number | null; grantable: boolean }> | null;
  roots: readonly Readonly<{ rootId: string; name: string; gatewayId: string; rootGeneration: number; rootFingerprint: string; exclusive: boolean; status: string }>[];
  grants: readonly Readonly<{ grantId: string; rootId: string; rootGeneration: number; effect: string; rights: string; expiresAt: number; generation: number; active: boolean }>[];
}>;

/** Read-only view for the Ops Team screen: one staff member's Files grants, under the same manager fence as the commands.
 * A caller that is not a manager gets canManage=false and no data. Only roots on the configured gateways are shown. */
export async function listEmployeeFilesAccess(database: D1Database, authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  targetStaffId: string, options: Readonly<{ gatewayIds: readonly string[] }>): Promise<EmployeeFilesAccessListing> {
  const actor = actorSnapshot(authenticated);
  if (typeof targetStaffId !== 'string' || !STAFF.test(targetStaffId)) throw new EmployeeProvisioningError(400, 'invalid-command');
  const gateways = [...options.gatewayIds];
  if (!gateways.length || gateways.length > 100 || !gateways.every(uuid)) throw new EmployeeProvisioningError(503, 'unavailable');
  if (actor.verifiedLogin && !await assertCurrentStaffLogin(database, actor.verifiedLogin)) throw new EmployeeProvisioningError(403, 'denied');
  const session = database.withSession('first-primary');
  const manager = await session.prepare(MANAGER_SQL)
    .bind(actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.email, actor.verifiedUntil).first();
  if (!manager) return Object.freeze({ schemaVersion: 1, canManage: false, target: null, roots: [], grants: [] });
  const staff = await session.prepare('SELECT id FROM staff_users WHERE id=?').bind(targetStaffId).first<{ id: string }>();
  if (!staff) throw new EmployeeProvisioningError(404, 'not-found');
  const admission = await session.prepare(`SELECT a.bound_access_subject subject,a.version version FROM native_staff_admissions a
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    WHERE a.staff_id=? AND a.active=1 AND s.status='active' AND s.access_subject=a.bound_access_subject`).bind(targetStaffId).first<{ subject: string; version: number }>();
  const marks = gateways.map(() => '?').join(',');
  const roots = await session.prepare(`SELECT root_id rootId,display_name name,gateway_id gatewayId,root_generation rootGeneration,
    root_fingerprint rootFingerprint,exclusive,status FROM ops_employee_read_roots WHERE gateway_id IN (${marks}) ORDER BY display_name,root_id LIMIT 500`)
    .bind(...gateways).all<{ rootId: string; name: string; gatewayId: string; rootGeneration: number; rootFingerprint: string; exclusive: number; status: string }>();
  const grants = await session.prepare(`SELECT g.grant_id grantId,g.root_id rootId,g.root_generation rootGeneration,g.effect effect,g.rights rights,
    g.expires_at expiresAt,g.grant_generation generation,g.active active FROM ops_employee_read_grants g JOIN ops_employee_read_roots r ON r.root_id=g.root_id
    WHERE g.staff_id=? AND r.gateway_id IN (${marks}) ORDER BY g.created_at,g.grant_id LIMIT 1000`)
    .bind(targetStaffId, ...gateways).all<{ grantId: string; rootId: string; rootGeneration: number; effect: string; rights: string; expiresAt: number; generation: number; active: number }>();
  if (!roots.success || !grants.success) throw new EmployeeProvisioningError(503, 'unavailable');
  return Object.freeze({ schemaVersion: 1, canManage: true,
    target: Object.freeze({ staffId: targetStaffId, accessSubject: admission?.subject ?? null, admissionVersion: admission?.version ?? null, grantable: !!admission }),
    roots: roots.results.map(root => Object.freeze({ ...root, exclusive: root.exclusive === 1 })),
    grants: grants.results.map(grant => Object.freeze({ ...grant, active: grant.active === 1 })) });
}

export async function recordEmployeeContentStart(database: D1Database, value: EmployeeReadAuthority, selection: EmployeeReadSelection): Promise<void> {
  const proof = Object.freeze({ ...value });
  const selected = Object.freeze({ operation: selection.operation, path: selection.path, expectedSha256: selection.expectedSha256,
    snapshotId: selection.snapshotId ?? null, cursor: selection.cursor ?? null,
    range: selection.range === null ? null : Object.freeze({ ...selection.range }) });
  if (selected.operation !== 'content' || !canonicalEmployeeReadPath(selected.path, false) || !uuid(selected.snapshotId) || !sha(selected.expectedSha256)
    || selected.cursor !== null || (selected.range !== null && (!Number.isSafeInteger(selected.range.start) || !Number.isSafeInteger(selected.range.end)
      || selected.range.start < 0 || selected.range.end < selected.range.start || selected.range.end >= 1099511627776))) throw Error('employee-content-audit-denied');
  if (!await recheckEmployeeReadAuthority(database, proof)) throw Error('employee-content-audit-denied');
  const pathHash = await digest(selected.path);
  try {
    const result = await database.withSession('first-primary').prepare(`INSERT INTO ops_employee_read_content_starts(event_id,gateway_id,root_id,root_generation,root_fingerprint,
      staff_id,access_subject,admission_version,profile_version,grant_id,grant_generation,snapshot_id,sha256,path_sha256,range_start,range_end,verified_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), proof.gatewayId, proof.rootId, proof.rootGeneration, proof.rootFingerprint,
      proof.staffId, proof.accessSubject, proof.admissionVersion, proof.profileVersion, proof.grantId, proof.grantGeneration,
      selected.snapshotId, selected.expectedSha256, pathHash, selected.range?.start ?? null, selected.range?.end ?? null, proof.verifiedUntil).run();
    if (!result.success || result.meta.changes !== 1) throw Error();
  } catch { throw Error('employee-content-audit-denied'); }
}
