import { prepareAclAdministratorRead, prepareAclGrantRead } from "./acl";
import { prepareStaffLoginSnapshot } from "./staff-login-bindings";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import type { GrantRow } from "./types";
import { STAFF_OPERATIONS_ACCESS_CATALOG, STAFF_OPERATIONS_ACCESS_POLICY } from "./staff-operations-access-policy";

export type StaffOperationsAccessErrorCode = "staff_operations_access_invalid" | "staff_operations_access_denied"
  | "staff_operations_access_not_found" | "permission_not_grantable" | "command_conflict" | "state_mismatch"
  | "not_command_managed" | "not_editable" | "schema_incomplete" | "staff_operations_access_unavailable"
  /** This command id already committed, but the caller may not see its receipt now. Never "not changed". */
  | "receipt_exists_reauthorize";
export type StaffOperationsAccessReason = "self" | "protected_owner" | "not_native_hire" | "target_identity_mismatch"
  | "actor_not_administrator" | "actor_lacks_roles_manage" | "actor_denied" | "actor_lacks_permission"
  | "target_denied" | "inherited" | "target_inactive" | "not_command_managed";
export class StaffOperationsAccessError extends Error {
  constructor(readonly code: StaffOperationsAccessErrorCode, readonly status: 400 | 403 | 404 | 409 | 503,
    readonly reason?: StaffOperationsAccessReason) { super(code); }
}
const fail = (code: StaffOperationsAccessErrorCode, status: StaffOperationsAccessError["status"],
  reason?: StaffOperationsAccessReason): never => { throw new StaffOperationsAccessError(code, status, reason); };

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_REASONS = new Set<StaffOperationsAccessReason>(["actor_not_administrator", "actor_lacks_roles_manage",
  "actor_denied", "actor_lacks_permission"]);

/** Every object migration 0244 creates. The route serves only when all exist
 * with the exact reviewed SQL text and catalog rows. */
export const STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS = Object.freeze([
  "staff_operations_access_catalog",
  "staff_operations_access_catalog_no_delete",
  "staff_operations_access_catalog_no_insert",
  "staff_operations_access_catalog_no_update",
  "staff_operations_access_command_apply",
  "staff_operations_access_command_authorize",
  "staff_operations_access_commands",
  "staff_operations_access_commands_no_delete",
  "staff_operations_access_commands_no_update",
  "staff_operations_access_commands_override",
  "staff_operations_access_native_hires",
  "staff_operations_access_override_delete_guard",
  "staff_operations_access_override_insert_guard",
  "staff_operations_access_override_update_guard",
  "staff_operations_access_state",
  "staff_operations_access_state_insert",
  "staff_operations_access_state_no_delete",
  "staff_operations_access_state_update",
  "staff_operations_access_targets",
] as const);
/** sha256 of the normalized 0244 object SQL plus the seeded catalog rows.
 * Release note: a later ALTER TABLE ... RENAME of any table 0244 references
 * rewrites this stored SQL; such a migration must recompute this digest, or the
 * route fails closed with 503. A mounted test recomputes it from a database
 * migrated by the real chain. */
export const STAFF_OPERATIONS_ACCESS_SCHEMA_SHA256 = "07280c5df3cd4b07ba61ea44ddffda5324f730bec6b64927fde0fecbb5e53b3a";

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
type CatalogRow = { permission: string; requires_explicit_actor_allow: number };
const PROBE_SQL = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS.map(() => "?").join(",")}) ORDER BY name`;
const CATALOG_SQL = "SELECT permission,requires_explicit_actor_allow FROM staff_operations_access_catalog ORDER BY permission";
// Write-time check: the same objects with the same total SQL length as the
// digest-verified snapshot (SQL cannot recompute the SHA-256 itself).
const GUARD_SQL = `SELECT CASE WHEN (SELECT count(*)||':'||total(length(sql)) FROM sqlite_schema WHERE name IN (${STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS.map(() => "?").join(",")}))=? THEN 1 ELSE json('') END ok`;

/** Comments and whitespace do not change behaviour; anything else does. */
export function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
}
async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function staffOperationsAccessSchemaDigest(objects: readonly SchemaRow[], catalog: readonly CatalogRow[]): Promise<string> {
  return sha256(JSON.stringify([
    objects.map(row => [row.type, row.name, row.tbl_name, normalizeSchemaSql(row.sql ?? "")]),
    catalog.map(row => [row.permission, row.requires_explicit_actor_allow]),
  ]));
}
async function verifySchema(objects: unknown[], catalog: unknown[]): Promise<void> {
  if (objects.length !== STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS.length
    || await staffOperationsAccessSchemaDigest(objects as SchemaRow[], catalog as CatalogRow[]) !== STAFF_OPERATIONS_ACCESS_SCHEMA_SHA256)
    fail("schema_incomplete", 503);
}

/** Fail-closed activation. Runs before any authentication, authorization or
 * data read: no 0244 object → 404; a partial or altered 0244 → 503. Returns
 * the first-primary session that the request's other reads must use. */
export async function openStaffOperationsAccess(database: D1Database): Promise<D1DatabaseSession> {
  const session = database.withSession("first-primary");
  let objects: SchemaRow[];
  try { objects = (await session.prepare(PROBE_SQL).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS).all<SchemaRow>()).results; }
  catch { return fail("staff_operations_access_unavailable", 503); }
  if (objects.length === 0) return fail("staff_operations_access_not_found", 404);
  if (objects.length !== STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS.length) return fail("schema_incomplete", 503);
  let results: D1Result[];
  try { results = await session.batch([session.prepare(PROBE_SQL).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS), session.prepare(CATALOG_SQL)]); }
  catch { return fail("schema_incomplete", 503); }
  await verifySchema(results[0]!.results, results[1]!.results);
  return session;
}

type TargetRow = { id: string; status: string; hire_id: string | null; admission_version: number | null;
  admission_active: number | null; identity_current: number | null; protected_owner: number | null; revision: number };
type OverrideRow = { id: string; permission_key: string; effect: "allow" | "deny"; scope: string; created_by: string };
type CommandRow = { override_id: string; operation: "grant" | "revoke"; actor_staff_id: string };

export type StaffOperationsAccessPermissionView = Readonly<{
  permission: string; state: "none" | "allow" | "deny" | "inherited";
  operation: "grant" | "revoke" | null; editable: boolean; reason: StaffOperationsAccessReason | null;
}>;
export type StaffOperationsAccessView = Readonly<{
  staffId: string; targetAdmissionVersion: number | null; revision: number;
  targetEditable: boolean; targetReason: StaffOperationsAccessReason | null;
  permissions: readonly StaffOperationsAccessPermissionView[];
}>;
type Snapshot = { view: StaffOperationsAccessView; ceiling: Map<string, StaffOperationsAccessReason | null>; schemaShape?: string };

function alive(actor: AuthenticatedNativeStaffWithAdmissionVersion) {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.now() >= Date.parse(actor.verifiedUntil))
    fail("staff_operations_access_denied", 403);
}
const overrideId = (staffId: string, permission: string) => `native-ops-access:${staffId}:${permission}`;

/** The same decision as the 0244 authorize trigger, evaluated on one snapshot. */
function evaluate(actorId: string, actorGrants: GrantRow[], target: TargetRow, overrides: OverrideRow[],
  roleAllows: Set<string>, latest: Map<string, CommandRow>, catalog: CatalogRow[]): Snapshot {
  const targetReason: StaffOperationsAccessReason | null = target.id === actorId ? "self"
    : target.hire_id === null ? "not_native_hire"
      : target.protected_owner !== 0 ? "protected_owner"
        : target.identity_current !== 1 ? "target_identity_mismatch" : null;
  const ceiling = new Map<string, StaffOperationsAccessReason | null>();
  const permissions = catalog.map(({ permission, requires_explicit_actor_allow: explicit }) => {
    const own = actorGrants.filter(grant => grant.permission === permission);
    const actorReason: StaffOperationsAccessReason | null = own.some(grant => grant.source === "override" && grant.effect === "deny")
      ? "actor_denied"
      : own.some(grant => grant.effect === "allow" && grant.scope === "global" && (explicit === 0 || grant.source === "override"))
        ? null : "actor_lacks_permission";
    ceiling.set(permission, actorReason);
    const rows = overrides.filter(row => row.permission_key === permission);
    const allow = rows.find(row => row.effect === "allow" && row.scope === "global");
    let state: StaffOperationsAccessPermissionView["state"], operation: "grant" | "revoke" | null = null;
    let reason: StaffOperationsAccessReason | null = null;
    if (rows.some(row => row.effect === "deny")) { state = "deny"; reason = "target_denied"; }
    else if (allow) {
      state = "allow";
      const last = latest.get(allow.id);
      if (allow.id === overrideId(target.id, permission) && last?.operation === "grant" && last.actor_staff_id === allow.created_by)
        operation = "revoke";
      else reason = "not_command_managed";
    } else if (roleAllows.has(permission)) { state = "inherited"; reason = "inherited"; }
    else { state = "none"; operation = "grant"; if (target.admission_active !== 1) reason = "target_inactive"; }
    if (targetReason) reason = targetReason;
    // REVIEW DEFAULT (fixed, as in the 0244 trigger): grant and revoke both need the ceiling.
    if (!reason && operation) reason = actorReason;
    return Object.freeze({ permission, state, operation, editable: operation !== null && reason === null, reason });
  });
  return { ceiling, view: Object.freeze({ staffId: target.id, targetAdmissionVersion: target.admission_version,
    revision: target.revision, targetEditable: targetReason === null, targetReason, permissions: Object.freeze(permissions) }) };
}

async function snapshot(database: D1Database, session: D1DatabaseSession,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, targetStaffId: string): Promise<Snapshot> {
  alive(actor);
  const actorId = actor.identity.staffId;
  const statements = [
    session.prepare(PROBE_SQL).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS),
    session.prepare(CATALOG_SQL),
    prepareAclGrantRead(session, actorId),
    prepareAclAdministratorRead(session, actorId),
    session.prepare(`SELECT s.project_alpha_user_id FROM staff_users s
      JOIN native_staff_admissions a ON a.staff_id=s.id JOIN native_staff_profiles p ON p.staff_id=s.id
      WHERE s.id=? AND s.status='active' AND s.email=? COLLATE BINARY AND s.access_subject=?
        AND a.active=1 AND a.version=? AND a.bound_access_subject=s.access_subject
        AND p.version=? AND p.login_email=s.email COLLATE BINARY`)
      .bind(actorId, actor.identity.email, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion),
    session.prepare(`SELECT s.id,s.status,t.staff_id hire_id,t.admission_version,t.admission_active,t.identity_current,t.protected_owner,
      coalesce((SELECT st.revision FROM staff_operations_access_state st WHERE st.staff_id=s.id),0) revision
      FROM staff_users s LEFT JOIN staff_operations_access_targets t ON t.staff_id=s.id WHERE s.id=?`).bind(targetStaffId),
    session.prepare("SELECT id,permission_key,effect,scope,created_by FROM staff_permission_overrides WHERE staff_id=?").bind(targetStaffId),
    session.prepare(`SELECT rp.permission_key permission FROM staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id
        WHERE a.staff_id=? AND a.scope='global'
      UNION SELECT rp.permission_key permission FROM local_staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id
        WHERE a.staff_id=? AND a.scope='global'`).bind(targetStaffId, targetStaffId),
    session.prepare("SELECT override_id,operation,actor_staff_id FROM staff_operations_access_commands WHERE target_staff_id=? ORDER BY result_revision")
      .bind(targetStaffId),
  ];
  const fixed = statements.length;
  const login = actor.verifiedLogin ? await prepareStaffLoginSnapshot(database, session, actor.verifiedLogin) : null;
  if (actor.verifiedLogin && !login) return fail("staff_operations_access_denied", 403);
  if (login) statements.push(...login.statements);
  let results: D1Result[];
  try { results = await session.batch(statements); }
  catch { return fail("staff_operations_access_unavailable", 503); }
  alive(actor);
  if (results.some(result => !result.success)) return fail("staff_operations_access_unavailable", 503);
  await verifySchema(results[0]!.results, results[1]!.results);
  const grants = results[2]!.results as GrantRow[];
  const identities = results[4]!.results as Array<{ project_alpha_user_id: string | null }>;
  if (identities.length !== 1 || login && !login.verify(results.slice(fixed), identities[0]!.project_alpha_user_id, Math.floor(Date.now() / 1000)))
    return fail("staff_operations_access_denied", 403);
  // REVIEW DEFAULT gate: global owner/admin AND global roles.manage, no roles.manage deny at any scope.
  if (results[3]!.results.length !== 1) return fail("staff_operations_access_denied", 403, "actor_not_administrator");
  const management = grants.filter(grant => grant.permission === STAFF_OPERATIONS_ACCESS_POLICY.managementPermission);
  if (management.some(grant => grant.source === "override" && grant.effect === "deny"))
    return fail("staff_operations_access_denied", 403, "actor_denied");
  if (!management.some(grant => grant.effect === "allow" && grant.scope === "global"))
    return fail("staff_operations_access_denied", 403, "actor_lacks_roles_manage");
  const targets = results[5]!.results as TargetRow[];
  const target = targets[0];
  if (targets.length !== 1 || !target || !["active", "inactive"].includes(target.status)
    || !Number.isSafeInteger(target.revision) || target.revision < 0) return fail("staff_operations_access_not_found", 404);
  const latest = new Map<string, CommandRow>();
  for (const row of results[8]!.results as CommandRow[]) latest.set(row.override_id, row);
  const objects = results[0]!.results as SchemaRow[];
  return { ...evaluate(actorId, grants, target, results[6]!.results as OverrideRow[],
    new Set((results[7]!.results as Array<{ permission: string }>).map(row => row.permission)), latest,
    results[1]!.results as CatalogRow[]),
  schemaShape: `${objects.length}:${objects.reduce((sum, row) => sum + (row.sql?.length ?? 0), 0)}.0` };
}

/** GET: current authority, current target state, one snapshot. */
export async function readStaffOperationsAccess(database: D1Database, session: D1DatabaseSession,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, targetStaffId: string): Promise<StaffOperationsAccessView> {
  if (!ID.test(targetStaffId)) return fail("staff_operations_access_invalid", 400);
  return (await snapshot(database, session, actor, targetStaffId)).view;
}

export type StaffOperationsAccessCommand = Readonly<{ commandId: string; permission: string; operation: "grant" | "revoke";
  expectedRevision: number; expectedAdmissionVersion: number; reason: string }>;
export type StaffOperationsAccessReceipt = Readonly<{ commandId: string; staffId: string; permission: string;
  operation: "grant" | "revoke"; revision: number; replayed: boolean }>;
type ReceiptRow = { command_id: string; request_sha256: string; target_staff_id: string; permission: string;
  operation: "grant" | "revoke"; result_revision: number };
const RECEIPT_SQL = "SELECT command_id,request_sha256,target_staff_id,permission,operation,result_revision FROM staff_operations_access_commands WHERE command_id=?";
const receipt = (row: ReceiptRow, replayed: boolean): StaffOperationsAccessReceipt => Object.freeze({ commandId: row.command_id,
  staffId: row.target_staff_id, permission: row.permission, operation: row.operation, revision: row.result_revision, replayed });

function refuse(entry: StaffOperationsAccessPermissionView | undefined): never {
  const reason = entry?.reason ?? null;
  if (reason && ACTOR_REASONS.has(reason)) return fail("staff_operations_access_denied", 403, reason);
  if (reason === "not_command_managed") return fail("not_command_managed", 409, reason);
  if (reason) return fail("not_editable", 409, reason);
  return fail("state_mismatch", 409);
}
/** A stored receipt is served only while the actor would still be allowed to
 * issue that command now; otherwise 403 and the receipt stays stored. */
function replayAllowed(current: Snapshot, row: ReceiptRow): boolean {
  if (current.view.targetReason !== null) return false;
  return current.ceiling.get(row.permission) === null;
}

export function validStaffOperationsAccessCommand(command: StaffOperationsAccessCommand): boolean {
  return !!command && UUID.test(command.commandId) && typeof command.permission === "string" && command.permission.length <= 191
    && (command.operation === "grant" || command.operation === "revoke")
    && Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0 && command.expectedRevision < Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(command.expectedAdmissionVersion) && command.expectedAdmissionVersion >= 1
    && typeof command.reason === "string" && command.reason.trim().length >= 1 && command.reason.length <= 500 && !/\p{C}/u.test(command.reason);
}

/** POST: only the immutable command (and its audit) is inserted. Migration
 * 0244's triggers authorize on live rows and apply the override atomically. */
export async function changeStaffOperationsAccess(database: D1Database, session: D1DatabaseSession,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, targetStaffId: string, command: StaffOperationsAccessCommand,
  audit: D1PreparedStatement): Promise<StaffOperationsAccessReceipt> {
  if (!ID.test(targetStaffId) || !validStaffOperationsAccessCommand(command)) return fail("staff_operations_access_invalid", 400);
  // Snapshot request scalars before any await.
  const input = Object.freeze({ commandId: command.commandId, permission: command.permission, operation: command.operation,
    expectedRevision: command.expectedRevision, expectedAdmissionVersion: command.expectedAdmissionVersion, reason: command.reason.trim() });
  const current = await snapshot(database, session, actor, targetStaffId);
  const entry = current.view.permissions.find(item => item.permission === input.permission);
  if (!entry) return fail("permission_not_grantable", 400);
  const hash = await sha256(JSON.stringify(["staff-operations-access-v1", actor.identity.staffId, actor.identity.verifiedAccessSubject,
    actor.admissionVersion, actor.identity.profileVersion, targetStaffId, input.permission, input.operation,
    input.expectedRevision, input.expectedAdmissionVersion, input.reason]));
  const prior = await session.prepare(RECEIPT_SQL).bind(input.commandId).first<ReceiptRow>();
  if (prior) {
    if (prior.request_sha256 !== hash) return fail("command_conflict", 409);
    if (!replayAllowed(current, prior)) return fail("receipt_exists_reauthorize", 409);
    return receipt(prior, true);
  }
  if (current.view.targetReason) return refuse(entry);
  if (current.view.revision !== input.expectedRevision || current.view.targetAdmissionVersion !== input.expectedAdmissionVersion)
    return fail("state_mismatch", 409);
  if (!entry.editable) return refuse(entry);
  if (entry.operation !== input.operation) return fail("state_mismatch", 409);
  alive(actor);
  try {
    await database.batch([
      database.prepare(GUARD_SQL).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS, current.schemaShape!),
      database.prepare(`INSERT INTO staff_operations_access_commands
        (command_id,request_sha256,actor_staff_id,actor_subject,actor_email,actor_admission_version,actor_profile_version,
         actor_verified_until_ms,actor_login_json,target_staff_id,target_admission_version,permission,operation,override_id,
         expected_revision,result_revision,reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId, hash, actor.identity.staffId,
        actor.identity.verifiedAccessSubject, actor.identity.email, actor.admissionVersion, actor.identity.profileVersion,
        Date.parse(actor.verifiedUntil), actor.verifiedLogin ? JSON.stringify(actor.verifiedLogin) : null, targetStaffId,
        input.expectedAdmissionVersion, input.permission, input.operation, overrideId(targetStaffId, input.permission),
        input.expectedRevision, input.expectedRevision + 1, input.reason),
      audit,
    ]);
  } catch (error) {
    // A same-command retry may have committed once: reauthorize, then return
    // its receipt. Never issue a second mutation or audit.
    const raced = await database.withSession("first-primary").prepare(RECEIPT_SQL).bind(input.commandId).first<ReceiptRow>();
    const committed = raced?.request_sha256 === hash;
    let after: Snapshot;
    try { after = await snapshot(database, database.withSession("first-primary"), actor, targetStaffId); }
    catch (cause) {
      // This very command committed: never report it as refused or unchanged.
      if (committed) return fail("receipt_exists_reauthorize", 409);
      if (cause instanceof StaffOperationsAccessError) throw cause;
      return fail("staff_operations_access_unavailable", 503);
    }
    if (committed) {
      if (!replayAllowed(after, raced!)) return fail("receipt_exists_reauthorize", 409);
      return receipt(raced!, true);
    }
    if (raced) return fail("command_conflict", 409);
    const now = after.view.permissions.find(item => item.permission === input.permission);
    if (after.view.revision !== input.expectedRevision || after.view.targetAdmissionVersion !== input.expectedAdmissionVersion)
      return fail("state_mismatch", 409);
    if (after.view.targetReason || !now?.editable) return refuse(now);
    if (error instanceof Error && /staff_operations_access_denied/.test(error.message)) return fail("staff_operations_access_denied", 403);
    return fail("staff_operations_access_unavailable", 503);
  }
  return Object.freeze({ commandId: input.commandId, staffId: targetStaffId, permission: input.permission,
    operation: input.operation, revision: input.expectedRevision + 1, replayed: false });
}
