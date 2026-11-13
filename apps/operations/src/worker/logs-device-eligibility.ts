import { prepareAclGrantRead } from './acl';
import { prepareStaffLoginSnapshot } from './staff-login-bindings';
import type { AuthenticatedNativeStaffWithAdmissionVersion } from './native-staff-auth';
import type { GrantRow } from './types';
import { evaluateLogsDeviceAuthority, type LogsDeviceAuthority } from './logs-device-authority';

export class LogsDeviceEligibilityError extends Error {
  constructor(readonly code: 'logs_device_eligibility_invalid' | 'logs_device_eligibility_denied' | 'logs_device_eligibility_not_found' | 'logs_device_eligibility_conflict' | 'logs_device_eligibility_unavailable', readonly status: 400 | 403 | 404 | 409 | 503) { super(code); }
}
const fail = (code: LogsDeviceEligibilityError['code'], status: LogsDeviceEligibilityError['status']): never => { throw new LogsDeviceEligibilityError(code, status); };
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TABLES = ['staff_logs_device_eligibility', 'staff_logs_device_eligibility_commands'];
const TRIGGERS = ['staff_logs_device_command_authorize', 'staff_logs_device_command_apply',
  'staff_logs_device_commands_no_update', 'staff_logs_device_commands_no_delete',
  'staff_logs_device_eligibility_insert', 'staff_logs_device_eligibility_update', 'staff_logs_device_eligibility_no_delete'];

/** A missing feature is unconfigured. A partial/broken schema is an error, not
 * an empty grant list; configured database failures are never swallowed. */
export async function logsDeviceEligibilityReady(database: D1Database): Promise<boolean> {
  const db = database.withSession('first-primary');
  const tables = await db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${TABLES.map(() => '?').join(',')})`).bind(...TABLES).all<{name: string}>();
  if (tables.results.length === 0) return false;
  if (tables.results.length !== TABLES.length) return fail('logs_device_eligibility_unavailable', 503);
  const guards = await db.prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN (${TRIGGERS.map(() => '?').join(',')})`).bind(...TRIGGERS).all<{name: string}>();
  if (guards.results.length !== TRIGGERS.length) return fail('logs_device_eligibility_unavailable', 503);
  return true;
}

type TargetRow = {
  id: string; status: string; username: string | null;
  native_active: number | null; native_version: number | null; identity_matches: number;
  effect: 'allow' | 'deny' | null; revision: number | null; grant_admission_version: number | null;
};
const TARGET_FROM_SQL = `SELECT s.id,s.status,u.username,a.active native_active,a.version native_version,
  CASE WHEN s.email=p.login_email COLLATE BINARY AND s.access_subject=a.bound_access_subject THEN 1 ELSE 0 END identity_matches,
  g.effect,g.revision,g.admission_version grant_admission_version
  FROM staff_users s LEFT JOIN native_staff_admissions a ON a.staff_id=s.id
  LEFT JOIN native_staff_profiles p ON p.staff_id=s.id
  LEFT JOIN staff_usernames u ON u.staff_id=s.id
  LEFT JOIN staff_logs_device_eligibility g ON g.staff_id=s.id`;
const TARGET_SQL = `${TARGET_FROM_SQL} WHERE s.id=?`;
function authority(row: TargetRow | null): LogsDeviceAuthority {
  return evaluateLogsDeviceAuthority({ staffActive: row?.status === 'active', nativeAdmissionActive: row?.native_active === 1,
    identityMatches: row?.identity_matches === 1, nativeAdmissionVersion: row?.native_version ?? null,
    grantAdmissionVersion: row?.grant_admission_version ?? null, effect: row?.effect ?? null, revision: row?.revision ?? null });
}

/** Private Logs directory read: no email, name, roles or PA identity returned. */
export async function getPilotDeviceAuthority(database: D1Database, staffId: unknown): Promise<LogsDeviceAuthority> {
  if (typeof staffId !== 'string' || !ID.test(staffId)) return { eligible: false, revision: null };
  if (!await logsDeviceEligibilityReady(database)) return { eligible: false, revision: null };
  return authority(await database.withSession('first-primary').prepare(TARGET_SQL).bind(staffId).first<TargetRow>());
}

export async function resolveEligibleLogsUsername(database: D1Database, username: string): Promise<{staffId: string; eligibilityRevision: number} | null> {
  if (!await logsDeviceEligibilityReady(database)) return null;
  const rows = await database.withSession('first-primary').prepare(`${TARGET_FROM_SQL} WHERE u.username=? LIMIT 2`).bind(username).all<TargetRow>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0]!, current = authority(row);
  return current.eligible && current.revision !== null ? { staffId: row.id, eligibilityRevision: current.revision } : null;
}

export type LogsDeviceEligibilityView = {
  staffId: string; username: string | null; effect: 'allow' | 'deny' | null;
  revision: number; admissionVersion: number; eligible: boolean;
};
function view(row: TargetRow): LogsDeviceEligibilityView {
  if (row.revision !== null && (!Number.isSafeInteger(row.revision) || row.revision < 1)
    || row.effect !== null && !['allow', 'deny'].includes(row.effect)) return fail('logs_device_eligibility_unavailable', 503);
  return { staffId: row.id, username: row.username, effect: row.effect, revision: row.revision ?? 0,
    admissionVersion: row.native_version!, eligible: authority(row).eligible };
}
function alive(actor: AuthenticatedNativeStaffWithAdmissionVersion) {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.now() >= Date.parse(actor.verifiedUntil)) return fail('logs_device_eligibility_denied', 403);
}

/** Read permission, native identity and target from one primary transaction.
 * A role name alone never substitutes for explicit global roles.manage. */
export async function readLogsDeviceEligibility(database: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion, targetStaffId: string): Promise<LogsDeviceEligibilityView> {
  if (!ID.test(targetStaffId)) return fail('logs_device_eligibility_invalid', 400);
  alive(actor);
  if (!await logsDeviceEligibilityReady(database)) return fail('logs_device_eligibility_unavailable', 503);
  const db = database.withSession('first-primary');
  const statements = [prepareAclGrantRead(db, actor.identity.staffId),
    db.prepare(`SELECT s.project_alpha_user_id FROM staff_users s
      JOIN native_staff_admissions a ON a.staff_id=s.id JOIN native_staff_profiles p ON p.staff_id=s.id
      WHERE s.id=? AND s.status='active' AND s.email=? COLLATE BINARY AND s.access_subject=?
        AND a.active=1 AND a.version=? AND a.bound_access_subject=s.access_subject
        AND p.version=? AND p.login_email=s.email COLLATE BINARY`)
      .bind(actor.identity.staffId, actor.identity.email, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion),
    db.prepare(TARGET_SQL).bind(targetStaffId)];
  const login = actor.verifiedLogin ? await prepareStaffLoginSnapshot(database, db, actor.verifiedLogin) : null;
  if (actor.verifiedLogin && !login) return fail('logs_device_eligibility_denied', 403);
  if (login) statements.push(...login.statements);
  const results = await db.batch(statements);
  alive(actor);
  if (results.some(result => !result.success)) return fail('logs_device_eligibility_unavailable', 503);
  const grants = results[0]!.results as GrantRow[];
  const management = grants.filter(grant => grant.permission === 'roles.manage' && grant.scope === 'global');
  const identities = results[1]!.results as Array<{project_alpha_user_id: string | null}>;
  if (identities.length !== 1 || !management.some(grant => grant.effect === 'allow')
    || management.some(grant => grant.source === 'override' && grant.effect === 'deny')
    || login && !login.verify(results.slice(3), identities[0]!.project_alpha_user_id, Math.floor(Date.now() / 1000)))
    return fail('logs_device_eligibility_denied', 403);
  const rows = results[2]!.results as TargetRow[];
  const target = rows[0];
  if (rows.length !== 1 || !target || !Number.isSafeInteger(target.native_version) || target.native_version! < 1
    || target.identity_matches !== 1 || !['active', 'inactive'].includes(target.status)) return fail('logs_device_eligibility_not_found', 404);
  return view(target);
}

export type LogsDeviceEligibilityCommand = { commandId: string; expectedRevision: number; effect: 'allow' | 'deny'; reason: string };
type ReceiptRow = { command_id: string; request_sha256: string; target_staff_id: string; result_revision: number; effect: 'allow' | 'deny' };
function receipt(row: ReceiptRow, replayed: boolean) {
  return { commandId: row.command_id, staffId: row.target_staff_id, revision: row.result_revision, effect: row.effect, replayed };
}

/** Only the fenced immutable command is inserted. Migration0243 performs the
 * grant mutation atomically after checking fresh actor/target/ACL versions. */
export async function setLogsDeviceEligibility(database: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  targetStaffId: string, command: LogsDeviceEligibilityCommand, audit: D1PreparedStatement) {
  if (!command || !UUID.test(command.commandId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0
    || command.expectedRevision >= Number.MAX_SAFE_INTEGER || !['allow', 'deny'].includes(command.effect)
    || typeof command.reason !== 'string' || command.reason.trim().length < 1 || command.reason.length > 500 || /\p{C}/u.test(command.reason))
    return fail('logs_device_eligibility_invalid', 400);
  // Snapshot request scalars before any await; caller cannot mutate a request
  // after hashing it and apply different permission values.
  const input = Object.freeze({ commandId: command.commandId, expectedRevision: command.expectedRevision, effect: command.effect, reason: command.reason.trim() });
  const target = await readLogsDeviceEligibility(database, actor, targetStaffId);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    'logs-device-eligibility-v1', actor.identity.staffId, actor.identity.verifiedAccessSubject, targetStaffId, input.expectedRevision, input.effect, input.reason,
  ]))))).map(value => value.toString(16).padStart(2, '0')).join('');
  const prior = await database.withSession('first-primary').prepare('SELECT command_id,request_sha256,target_staff_id,result_revision,effect FROM staff_logs_device_eligibility_commands WHERE command_id=?').bind(input.commandId).first<ReceiptRow>();
  if (prior) {
    if (prior.request_sha256 !== hash) return fail('logs_device_eligibility_conflict', 409);
    await readLogsDeviceEligibility(database, actor, targetStaffId);
    return receipt(prior, true);
  }
  if (target.revision !== input.expectedRevision) return fail('logs_device_eligibility_conflict', 409);
  alive(actor);
  try {
    await database.batch([database.prepare(`INSERT INTO staff_logs_device_eligibility_commands
      (command_id,request_sha256,actor_staff_id,actor_subject,actor_email,actor_admission_version,actor_profile_version,
       actor_verified_until_ms,actor_login_json,target_staff_id,target_admission_version,expected_revision,result_revision,effect,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId, hash, actor.identity.staffId, actor.identity.verifiedAccessSubject,
        actor.identity.email, actor.admissionVersion, actor.identity.profileVersion, Date.parse(actor.verifiedUntil),
        actor.verifiedLogin ? JSON.stringify(actor.verifiedLogin) : null, targetStaffId, target.admissionVersion,
        input.expectedRevision, input.expectedRevision + 1, input.effect, input.reason), audit]);
  } catch (error) {
    // Same-command racing retry may have committed once. Reauthorize before
    // returning its retained receipt; never issue a second mutation or audit.
    const raced = await database.withSession('first-primary').prepare('SELECT command_id,request_sha256,target_staff_id,result_revision,effect FROM staff_logs_device_eligibility_commands WHERE command_id=?').bind(input.commandId).first<ReceiptRow>();
    const current = await readLogsDeviceEligibility(database, actor, targetStaffId);
    if (raced?.request_sha256 === hash) return receipt(raced, true);
    if (raced || current.revision !== input.expectedRevision || error instanceof Error && /logs_device_eligibility_conflict|UNIQUE constraint failed/.test(error.message)) return fail('logs_device_eligibility_conflict', 409);
    if (error instanceof Error && /logs_device_eligibility_denied/.test(error.message)) return fail('logs_device_eligibility_denied', 403);
    return fail('logs_device_eligibility_unavailable', 503);
  }
  return { commandId: input.commandId, staffId: targetStaffId, revision: input.expectedRevision + 1, effect: input.effect, replayed: false };
}
