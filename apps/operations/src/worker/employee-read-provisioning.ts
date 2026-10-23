import type { AuthenticatedNativeStaffWithAdmissionVersion } from './native-staff-auth';
import { isNativeAccessSubject } from './native-access-subject';
import type { EmployeeReadAuthority } from './employee-read-authority';
import { recheckEmployeeReadAuthority } from './employee-read-authority';
import { canonicalEmployeeReadPath, type EmployeeReadSelection } from './employee-read-transport';

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
export class EmployeeProvisioningError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, readonly code: string) { super(code); }
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
  };
  if (typeof kind !== 'string' || !Object.hasOwn(fields, kind) || !exact(value, fields[kind]!)) throw new EmployeeProvisioningError(400, 'invalid-command');
  const command = Object.freeze(Object.fromEntries(fields[kind]!.map(key => [key, value[key]])));
  if (!uuid(command.commandId) || (kind !== 'revoke-grant' && !uuid(command.rootId))
    || (kind === 'register-root' && (!uuid(command.gatewayId) || !sha(command.rootFingerprint) || !label(command.displayName)))
    || (kind === 'advance-root' && (!positive(command.expectedGeneration) || !sha(command.rootFingerprint) || !label(command.displayName)
      || typeof command.status !== 'string' || !['active', 'disabled'].includes(command.status)))
    || (['grant-read', 'deny-read'].includes(kind) && (!uuid(command.grantId) || !positive(command.rootGeneration) || !sha(command.rootFingerprint)
      || typeof command.targetStaffId !== 'string' || !STAFF.test(command.targetStaffId) || !isNativeAccessSubject(command.targetAccessSubject)
      || !positive(command.targetAdmissionVersion) || !positive(command.expiresAt) || command.expiresAt > 253402300799))
    || (kind === 'revoke-grant' && (!uuid(command.grantId) || !positive(command.expectedGeneration)))) throw new EmployeeProvisioningError(400, 'invalid-command');
  return command as EmployeeReadCommand;
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function actorSnapshot(authenticated: AuthenticatedNativeStaffWithAdmissionVersion) {
  if (!exact(authenticated, ['identity', 'admissionVersion', 'verifiedUntil'])
    || !exact(authenticated.identity, ['kind', 'staffId', 'verifiedAccessSubject', 'email', 'displayName', 'profileVersion'])) throw new EmployeeProvisioningError(403, 'denied');
  const identity = authenticated.identity;
  if (identity.kind !== 'native' || typeof identity.staffId !== 'string' || !STAFF.test(identity.staffId) || !isNativeAccessSubject(identity.verifiedAccessSubject)
    || !positive(authenticated.admissionVersion) || !positive(identity.profileVersion)
    || typeof identity.email !== 'string' || identity.email !== identity.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+$/u.test(identity.email)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(authenticated.verifiedUntil)
    || !Number.isFinite(Date.parse(authenticated.verifiedUntil)) || Date.parse(authenticated.verifiedUntil) <= Date.now()) throw new EmployeeProvisioningError(403, 'denied');
  return Object.freeze({ staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion, verifiedUntil: authenticated.verifiedUntil });
}

export async function provisionEmployeeRead(database: D1Database, authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  value: unknown, options: Readonly<{ gatewayIds: readonly string[] }>): Promise<EmployeeReadCommandReceipt> {
  const actor = actorSnapshot(authenticated), command = parseEmployeeReadCommand(value);
  const gateways = [...options.gatewayIds];
  if (!gateways.length || gateways.length > 100 || !gateways.every(uuid)) throw new EmployeeProvisioningError(503, 'unavailable');
  const session = database.withSession('first-primary');
  const manager = await session.prepare(`SELECT 1 ok FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=? AND p.version=? AND p.login_email=?
      AND s.status='active' AND s.access_subject=a.bound_access_subject AND julianday(?)>julianday('now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=a.staff_id AND r.scope='global' AND r.role_id IN ('role-owner','role-admin'))
      AND (EXISTS(SELECT 1 FROM staff_role_assignments r JOIN role_permissions rp ON rp.role_id=r.role_id WHERE r.staff_id=a.staff_id AND r.scope='global' AND rp.permission_key='employee.files.manage')
        OR EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.scope='global' AND o.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.effect='deny')`)
    .bind(actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.email, actor.verifiedUntil).first();
  if (!manager) throw new EmployeeProvisioningError(403, 'denied');
  let rootId = command.rootId as string | undefined, gatewayId = command.gatewayId as string | undefined;
  if (command.kind === 'revoke-grant') {
    const row = await session.prepare('SELECT root_id rootId FROM ops_employee_read_grants WHERE grant_id=?').bind(command.grantId).first<{ rootId: string }>();
    if (!row || !uuid(row.rootId)) throw new EmployeeProvisioningError(409, 'conflict');
    rootId = row.rootId;
  }
  if (command.kind !== 'register-root') {
    const row = await session.prepare('SELECT gateway_id gatewayId FROM ops_employee_read_roots WHERE root_id=?').bind(rootId!).first<{ gatewayId: string }>();
    if (!row) throw new EmployeeProvisioningError(409, 'conflict');
    gatewayId = row.gatewayId;
  }
  if (!gatewayId || !gateways.includes(gatewayId)) throw new EmployeeProvisioningError(403, 'denied');
  const payload = JSON.stringify(command);
  const requestHash = await digest(JSON.stringify(['employee-read-command-v1', actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, gatewayId, command]));
  const generation = ['advance-root', 'revoke-grant'].includes(command.kind) ? Number(command.expectedGeneration) + 1 : 1;
  try {
    const results = await session.batch([
      session.prepare(`INSERT INTO ops_employee_read_commands(command_id,request_sha256,action,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
        actor_email,verified_until,root_id,configured_gateway_id,grant_id,result_generation,payload_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`).bind(command.commandId, requestHash, command.kind, actor.staffId,
        actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.email, actor.verifiedUntil, rootId!, gatewayId,
        command.grantId ?? null, generation, payload),
      session.prepare('SELECT command_id commandId,action kind,root_id rootId,grant_id grantId,result_generation generation,request_sha256 requestHash FROM ops_employee_read_commands WHERE command_id=?').bind(command.commandId),
    ]);
    const receipt = results[1]?.results[0] as { commandId: string; kind: string; rootId: string; grantId: string | null; generation: number; requestHash: string } | undefined;
    if (!results.every(result => result.success) || !receipt || receipt.requestHash !== requestHash) throw new EmployeeProvisioningError(503, 'unavailable');
    return Object.freeze({ schemaVersion: 1, commandId: receipt.commandId, kind: receipt.kind, rootId: receipt.rootId, grantId: receipt.grantId, generation: receipt.generation });
  } catch (error) {
    if (error instanceof EmployeeProvisioningError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('employee administration denied')) throw new EmployeeProvisioningError(403, 'denied');
    if (message.includes('conflict')) throw new EmployeeProvisioningError(409, 'conflict');
    throw new EmployeeProvisioningError(503, 'unavailable');
  }
}

/** Audit is authorization-critical: the insert trigger rechecks exact current proof in the write transaction. */
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
