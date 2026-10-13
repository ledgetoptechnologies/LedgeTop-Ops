import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
type Owner = AuthenticatedNativeStaffWithAdmissionVersion;
type Proof = { staff_id: string; access_subject: string; email: string; admission_version: number;
  profile_version: number; grant_generation: number };
type Command = { operation_id: string; command_sha256: string; operation_fingerprint: string;
  action: "delivery.grant" | "delivery.revoke"; authority_id: string; expected_revision: number;
  resulting_revision: number; target_id: string; root_record_id: string; ops_division_id: string };
type Stored = { invocation_id: string; operation_id: string; request_fingerprint: string;
  state: "authorized" | "claimed"; invoked_by_staff_id: string; invoked_access_subject: string;
  invoked_admission_version: number; invoked_profile_version: number; invoked_grant_generation: number };

export type ReserveOperationsPortalNativeDeliveryRecoveryInvocationInput = Readonly<{
  invocationId: string; operationId: string; authorityId: string; expectedRevision: number;
  reason: string; owner: Owner;
}>;
export type OperationsPortalNativeDeliveryRecoveryInvocation = Readonly<{
  invocationId: string; operationId: string; authorityId: string; expectedRevision: number;
  state: "authorized" | "claimed"; replayed: boolean;
}>;

function denied(): never { throw new Error("operations_portal_native_delivery_recovery_invocation_denied"); }
function actorValid(owner: Owner) {
  try {
    const until = Date.parse(owner.verifiedUntil);
    return owner.identity.kind === "native" && owner.identity.staffId.length > 0
      && owner.identity.verifiedAccessSubject.length > 0 && owner.identity.email.length > 0
      && Number.isSafeInteger(owner.admissionVersion) && owner.admissionVersion >= 1
      && Number.isSafeInteger(owner.identity.profileVersion) && owner.identity.profileVersion >= 1
      && Number.isFinite(until) && until > Date.now() && new Date(until).toISOString() === owner.verifiedUntil;
  } catch { return false; }
}
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function proof(database: Pick<D1Database, "prepare">, owner: Owner): Promise<Proof | null> {
  if (!actorValid(owner)) return null;
  return database.prepare(`SELECT admission.staff_id,admission.bound_access_subject access_subject,
      profile.login_email email,admission.version admission_version,profile.version profile_version,
      generation.generation grant_generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=?`).bind(owner.identity.staffId,
      owner.identity.verifiedAccessSubject, owner.admissionVersion, owner.identity.email,
      owner.identity.profileVersion).first<Proof>();
}
function canonical(input: ReserveOperationsPortalNativeDeliveryRecoveryInvocationInput) {
  return JSON.stringify({ protocol: "operations-portal-native-delivery-recovery", protocolVersion: 1,
    invocationId: input.invocationId, operationId: input.operationId, authorityId: input.authorityId,
    expectedRevision: input.expectedRevision, reason: input.reason });
}
function exactReplay(row: Stored, input: ReserveOperationsPortalNativeDeliveryRecoveryInvocationInput,
  current: Proof, fingerprint: string) {
  return row.operation_id === input.operationId && row.request_fingerprint === fingerprint
    && row.invoked_by_staff_id === current.staff_id && row.invoked_access_subject === current.access_subject
    && row.invoked_admission_version === current.admission_version
    && row.invoked_profile_version === current.profile_version
    && row.invoked_grant_generation === current.grant_generation;
}

export async function reserveOperationsPortalNativeDeliveryRecoveryInvocation(database: D1Database,
  input: ReserveOperationsPortalNativeDeliveryRecoveryInvocationInput,
): Promise<OperationsPortalNativeDeliveryRecoveryInvocation> {
  if (!UUID.test(input.invocationId) || !UUID.test(input.operationId) || !UUID.test(input.authorityId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || typeof input.reason !== "string" || input.reason !== input.reason.trim()
    || input.reason.length < 1 || input.reason.length > 500 || /\p{C}/u.test(input.reason)) denied();
  const db = database.withSession("first-primary"), current = await proof(db, input.owner); if (!current) denied();
  const requestFingerprint = await sha256(canonical(input));
  const prior = await db.prepare(`SELECT invocation_id,operation_id,request_fingerprint,state,invoked_by_staff_id,
      invoked_access_subject,invoked_admission_version,invoked_profile_version,invoked_grant_generation
    FROM operations_portal_native_delivery_recovery_invocations WHERE invocation_id=?`)
    .bind(input.invocationId).first<Stored>();
  if (prior) {
    if (!exactReplay(prior, input, current, requestFingerprint)) denied();
    return { invocationId: prior.invocation_id, operationId: prior.operation_id, authorityId: input.authorityId,
      expectedRevision: input.expectedRevision, state: prior.state, replayed: true };
  }
  const command = await db.prepare(`SELECT operation_id,command_sha256,operation_fingerprint,action,authority_id,
      expected_revision,resulting_revision,target_id,root_record_id,ops_division_id
    FROM operations_portal_native_delivery_authority_commands WHERE operation_id=? AND authority_id=?
      AND resulting_revision=?`).bind(input.operationId, input.authorityId, input.expectedRevision).first<Command>();
  if (!command || !HASH.test(command.command_sha256) || !HASH.test(command.operation_fingerprint)) denied();
  try {
    await db.prepare(`INSERT INTO operations_portal_native_delivery_recovery_invocations
      (invocation_id,operation_id,action,request_fingerprint,command_sha256,operation_fingerprint,command_action,
       authority_id,expected_revision,resulting_revision,target_id,root_record_id,ops_division_id,
       invoked_by_staff_id,invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
       invoked_grant_generation,invoked_verified_until,reason)
      VALUES(?,?,'recover',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.invocationId, input.operationId,
        requestFingerprint, command.command_sha256, command.operation_fingerprint, command.action,
        command.authority_id, command.expected_revision, command.resulting_revision, command.target_id,
        command.root_record_id, command.ops_division_id, current.staff_id, current.access_subject, current.email,
        current.admission_version, current.profile_version, current.grant_generation, input.owner.verifiedUntil,
        input.reason).run();
  } catch { denied(); }
  const committed = await db.prepare(`SELECT invocation_id,operation_id,request_fingerprint,state,invoked_by_staff_id,
      invoked_access_subject,invoked_admission_version,invoked_profile_version,invoked_grant_generation
    FROM operations_portal_native_delivery_recovery_invocations WHERE invocation_id=?`)
    .bind(input.invocationId).first<Stored>();
  if (!committed || committed.state !== "authorized"
    || !exactReplay(committed, input, current, requestFingerprint)) denied();
  return { invocationId: input.invocationId, operationId: input.operationId, authorityId: input.authorityId,
    expectedRevision: input.expectedRevision, state: "authorized", replayed: false };
}

export async function claimOperationsPortalNativeDeliveryRecoveryInvocation(database: D1DatabaseSession,
  input: Readonly<{ invocationId: string; operationId: string; claimToken: string }>,
): Promise<boolean> {
  if (!UUID.test(input.invocationId) || !UUID.test(input.operationId) || !UUID.test(input.claimToken)) return false;
  try {
    await database.batch([
      database.prepare(`UPDATE operations_portal_native_delivery_authority_outbox SET state='dispatching',
          claim_token=?,claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),
          attempt_count=attempt_count+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND (state IN ('pending','retry')
          OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
          AND EXISTS(SELECT 1 FROM operations_portal_native_delivery_recovery_invocations invocation
            WHERE invocation.invocation_id=? AND invocation.operation_id=? AND invocation.state='authorized')`)
        .bind(input.claimToken, input.operationId, input.invocationId, input.operationId),
      database.prepare(`UPDATE operations_portal_native_delivery_recovery_invocations
        SET state='claimed',claim_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE invocation_id=? AND operation_id=? AND state='authorized'`)
        .bind(input.claimToken, input.invocationId, input.operationId),
    ]);
  } catch { return false; }
  return Boolean(await database.prepare(`SELECT 1 FROM operations_portal_native_delivery_recovery_invocation_audit audit
    JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=audit.operation_id
    WHERE audit.invocation_id=? AND audit.operation_id=? AND audit.claim_token=?
      AND outbox.state='dispatching' AND outbox.claim_token=audit.claim_token`)
    .bind(input.invocationId, input.operationId, input.claimToken).first());
}

/** Recheck the claimed current invoker immediately before the private RPC. */
export async function currentOperationsPortalNativeDeliveryRecoveryInvocation(database: D1DatabaseSession,
  invocationId: string, operationId: string, claimToken: string): Promise<boolean> {
  if (!UUID.test(invocationId) || !UUID.test(operationId) || !UUID.test(claimToken)) return false;
  return Boolean(await database.prepare(`SELECT 1
    FROM operations_portal_native_delivery_recovery_invocation_audit audit
    JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=audit.operation_id
      AND command.command_sha256=audit.command_sha256 AND command.operation_fingerprint=audit.operation_fingerprint
      AND command.action=audit.command_action AND command.authority_id=audit.authority_id
      AND command.expected_revision=audit.expected_revision AND command.resulting_revision=audit.resulting_revision
      AND command.target_id=audit.target_id AND command.root_record_id=audit.root_record_id
      AND command.ops_division_id=audit.ops_division_id
    JOIN operations_portal_native_delivery_authorizations original ON original.operation_id=command.operation_id
    JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
      AND head.latest_operation_id=command.operation_id AND head.revision=command.resulting_revision
      AND head.state=CASE command.action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END
    JOIN native_staff_admissions admission ON admission.staff_id=audit.invoked_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=audit.invoked_access_subject
      AND admission.version=audit.invoked_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      AND profile.login_email=audit.invoked_email AND profile.version=audit.invoked_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=audit.invoked_grant_generation
    JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
      AND outbox.state='dispatching' AND outbox.claim_token=audit.claim_token
      AND outbox.request_fingerprint=command.command_sha256
      AND outbox.canonical_wire_json=command.canonical_command_json
    WHERE audit.invocation_id=? AND audit.operation_id=? AND audit.claim_token=?
      AND audit.invoked_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND role.division_id=command.ops_division_id)))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.record_id=command.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.record_id=command.root_record_id)
      AND (SELECT count(DISTINCT permission.permission_key)
        FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse',
            CASE command.action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
          AND (permission.scope='global' OR (permission.scope='division'
            AND permission.division_id=command.ops_division_id)))=3
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse',
            CASE command.action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
          AND (permission.scope='global' OR (permission.scope='division'
            AND permission.division_id=command.ops_division_id)))`)
    .bind(invocationId, operationId, claimToken).first());
}
