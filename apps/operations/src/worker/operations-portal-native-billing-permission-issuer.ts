import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

type Scope = Readonly<{ kind: "global"; resourceId: null } | { kind: "resource"; resourceId: string }>;
export type NativeBillingPermissionChange = Readonly<{
  operationId: string;
  expectedGeneration: number;
  action: "issue";
  grantId: string;
  staffId: string;
  effect: "allow" | "deny";
  scope: Scope;
}> | Readonly<{
  operationId: string;
  expectedGeneration: number;
  action: "revoke";
  grantId: string;
}>;

export type NativeBillingPermissionChangeResult = Readonly<{
  status: "applied" | "replayed";
  operationId: string;
  grantId: string;
  generation: number;
}> | Readonly<{ status: "conflict"; reason: "request" | "generation" | "authority" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;

function validInput(value: NativeBillingPermissionChange): boolean {
  if (!UUID.test(value.operationId) || !UUID.test(value.grantId)
    || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 0
    || value.expectedGeneration >= Number.MAX_SAFE_INTEGER) return false;
  if (value.action === "revoke") return true;
  return ID.test(value.staffId) && (value.effect === "allow" || value.effect === "deny")
    && (value.scope.kind === "global" ? value.scope.resourceId === null
      : value.scope.kind === "resource" && typeof value.scope.resourceId === "string" && ID.test(value.scope.resourceId));
}

function canonicalRequest(actor: AuthenticatedNativeStaffWithAdmissionVersion, input: NativeBillingPermissionChange): string {
  return JSON.stringify(input.action === "issue" ? {
    protocol: "operations-portal-native-billing-permission-management", protocolVersion: 1,
    operationId: input.operationId, action: input.action, grantId: input.grantId,
    expectedGeneration: String(input.expectedGeneration), staffId: input.staffId, effect: input.effect,
    scope: { kind: input.scope.kind, resourceId: input.scope.resourceId }, actorStaffId: actor.identity.staffId,
  } : {
    protocol: "operations-portal-native-billing-permission-management", protocolVersion: 1,
    operationId: input.operationId, action: input.action, grantId: input.grantId,
    expectedGeneration: String(input.expectedGeneration), actorStaffId: actor.identity.staffId,
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function currentManager(db: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 ok FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN staff_users staff ON staff.id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
     AND admission.version=? AND profile.version=? AND staff.status='active' AND staff.access_subject=?
     AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
       AND role.role_id='role-owner' AND role.scope='global')
     AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
       AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow'
       AND grant_row.active=1 AND grant_row.scope_kind='global')
     AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=admission.staff_id
       AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
       AND deny.scope_kind='global')`).bind(actor.identity.staffId, actor.identity.verifiedAccessSubject,
    actor.admissionVersion, actor.identity.profileVersion, actor.identity.verifiedAccessSubject,
    actor.verifiedUntil).first());
}

export async function manageOperationsPortalNativeBillingPermission(
  db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion,
  input: NativeBillingPermissionChange,
): Promise<NativeBillingPermissionChangeResult> {
  if (!validInput(input)) return { status: "conflict", reason: "request" };
  const requestFingerprint = await sha256(canonicalRequest(actor, input));
  const prior = await db.prepare(`SELECT request_fingerprint,grant_id,resulting_generation
    FROM operations_portal_native_billing_permission_commands WHERE operation_id=?`).bind(input.operationId)
    .first<{ request_fingerprint: string; grant_id: string; resulting_generation: number }>();
  if (prior) {
    if (prior.request_fingerprint !== requestFingerprint || prior.grant_id !== input.grantId)
      return { status: "conflict", reason: "request" };
    if (!await currentManager(db, actor)) return { status: "conflict", reason: "authority" };
    return { status: "replayed", operationId: input.operationId, grantId: input.grantId,
      generation: prior.resulting_generation };
  }
  if (!await currentManager(db, actor)) return { status: "conflict", reason: "authority" };

  let staffId: string, effect: "allow" | "deny", scopeKind: "global" | "resource", resourceId: string | null;
  if (input.action === "issue") {
    ({ staffId, effect } = input); scopeKind = input.scope.kind; resourceId = input.scope.resourceId;
  } else {
    const grant = await db.prepare(`SELECT staff_id,effect,scope_kind,resource_id
      FROM operations_portal_native_billing_permissions WHERE grant_id=?
       AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations revoked
         WHERE revoked.grant_id=operations_portal_native_billing_permissions.grant_id)`).bind(input.grantId)
      .first<{ staff_id: string; effect: "allow" | "deny"; scope_kind: "global" | "resource"; resource_id: string | null }>();
    if (!grant) return { status: "conflict", reason: "request" };
    staffId = grant.staff_id; effect = grant.effect; scopeKind = grant.scope_kind; resourceId = grant.resource_id;
  }
  const resultingGeneration = input.expectedGeneration + 1;
  const observedAt = new Date().toISOString();
  const command = db.prepare(`INSERT INTO operations_portal_native_billing_permission_commands
    (operation_id,request_fingerprint,action,grant_id,staff_id,effect,scope_kind,resource_id,expected_generation,
     resulting_generation,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
     actor_verified_until,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(input.operationId,requestFingerprint,input.action,input.grantId,staffId,effect,scopeKind,resourceId,
      input.expectedGeneration,resultingGeneration,actor.identity.staffId,actor.identity.verifiedAccessSubject,
      actor.admissionVersion,actor.identity.profileVersion,actor.verifiedUntil,observedAt);
  const materialized = input.action === "issue"
    ? db.prepare(`INSERT INTO operations_portal_native_billing_permissions
        (grant_id,issue_operation_id,staff_id,effect,scope_kind,resource_id,issued_generation) VALUES(?,?,?,?,?,?,?)`)
      .bind(input.grantId,input.operationId,staffId,effect,scopeKind,resourceId,resultingGeneration)
    : db.prepare(`INSERT INTO operations_portal_native_billing_permission_revocations
        (grant_id,revoke_operation_id,revoked_generation) VALUES(?,?,?)`)
      .bind(input.grantId,input.operationId,resultingGeneration);
  try {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO operations_portal_native_billing_permission_generations(staff_id,generation)
        VALUES(?,0)`).bind(staffId),
      command,
      materialized,
      db.prepare(`UPDATE operations_portal_native_billing_permission_generations
        SET generation=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=? AND generation=?`)
        .bind(resultingGeneration,staffId,input.expectedGeneration),
    ]);
    return { status: "applied", operationId: input.operationId, grantId: input.grantId, generation: resultingGeneration };
  } catch {
    const winner = await db.prepare(`SELECT request_fingerprint,grant_id,resulting_generation
      FROM operations_portal_native_billing_permission_commands WHERE operation_id=?`).bind(input.operationId)
      .first<{ request_fingerprint: string; grant_id: string; resulting_generation: number }>();
    if (winner?.request_fingerprint === requestFingerprint && winner.grant_id === input.grantId) {
      if (!await currentManager(db, actor)) return { status: "conflict", reason: "authority" };
      return { status: "replayed", operationId: input.operationId, grantId: input.grantId,
        generation: winner.resulting_generation };
    }
    return { status: "conflict", reason: winner ? "request" : "generation" };
  }
}
