import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();
type Owner = AuthenticatedNativeStaffWithAdmissionVersion;
type WorkspaceRow = { target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; ownership_epoch: number;
  state: "provisioning" | "active" | "revoking" | "revoked"; creation_operation_id: string;
  revoked_operation_id: string | null };
type CleanupRow = { operation_id: string; target_id: string; expected_ownership_epoch: number;
  resulting_ownership_epoch: number; request_sha256: string; request_fingerprint: string; canonical_wire_json: string };
type RecoveryCommand = WorkspaceRow & { operation_id: string; request_fingerprint: string };
type RecoveryInvocation = { invocation_id: string; operation_id: string; state: "authorized" | "claimed";
  invoked_by_staff_id: string; invoked_access_subject: string; invoked_admission_version: number;
  invoked_profile_version: number; invoked_grant_generation: number };
export type RevokeOperationsPortalNativeWorkspaceAuthorityInput = Readonly<{
  operationId: string; targetId: string; expectedOwnershipEpoch: number; reason: string; owner: Owner;
}>;
export type ReserveOperationsPortalNativeWorkspaceCleanupRecoveryInput = Readonly<{
  invocationId: string; operationId: string; owner: Owner;
}>;

function denied(): never { throw new Error("operations_portal_native_workspace_cleanup_denied"); }
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function instant(value: unknown, future = false): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && (!future || parsed > Date.now());
}
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function generation(database: Pick<D1Database, "prepare">, owner: Owner) {
  if (!instant(owner.verifiedUntil, true)) denied();
  const value = await database.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(owner.identity.staffId).first<number>("generation");
  if (!Number.isSafeInteger(value) || value === null || value < 1) denied();
  return value;
}
async function workspace(database: Pick<D1Database, "prepare">, targetId: string) {
  return database.prepare(`SELECT target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
      ownership_epoch,state,creation_operation_id,revoked_operation_id
    FROM operations_portal_native_workspace_authority_heads WHERE target_id=?`).bind(targetId).first<WorkspaceRow>();
}
async function ownerAuthorizedForRoot(database: Pick<D1Database, "prepare">, row: WorkspaceRow, owner: Owner,
  grantGeneration: number) {
  return Boolean(await database.prepare(`SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=?)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=?)`)
    .bind(owner.identity.email, owner.identity.profileVersion, grantGeneration, owner.identity.staffId,
      owner.identity.verifiedAccessSubject, owner.admissionVersion, row.root_record_id, row.root_record_id,
      row.root_record_id).first());
}
function requestDocument(input: RevokeOperationsPortalNativeWorkspaceAuthorityInput) {
  return JSON.stringify({ action: "workspace.revoke", operationId: input.operationId, targetId: input.targetId,
    expectedOwnershipEpoch: input.expectedOwnershipEpoch, reason: input.reason });
}
function wireDocument(operationId: string, row: WorkspaceRow, resultingOwnershipEpoch: number, owner: Owner,
  grantGeneration: number, observedAt: string) {
  return JSON.stringify({ protocol: "operations-portal-native-authority", protocolVersion: 1, permissionSchemaVersion: 3,
    action: "workspace.revoke", operationId,
    target: { targetId: row.target_id, targetRevision: String(row.target_revision),
      clientAuthorityId: row.client_authority_id, workspaceId: row.workspace_id,
      rootKind: row.root_kind, rootRecordId: row.root_record_id },
    recipient: null,
    expected: { ownershipEpoch: String(row.ownership_epoch), grantRevision: null },
    resulting: { ownershipEpoch: String(resultingOwnershipEpoch), grantRevision: null },
    permissions: [], expiresAt: null, publication: null,
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: String(owner.admissionVersion), profileVersion: String(owner.identity.profileVersion),
      grantGeneration: String(grantGeneration), verifiedUntil: owner.verifiedUntil }, observedAt });
}
function result(row: WorkspaceRow, operationId: string | null, replayed: boolean) {
  return Object.freeze({ operationId, targetId: row.target_id, state: row.state,
    ownershipEpoch: row.ownership_epoch, replayed });
}

export async function readOperationsPortalNativeWorkspaceCleanupForOwner(database: D1Database,
  targetId: string, owner: Owner) {
  if (!UUID.test(targetId)) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, owner);
  const row = await workspace(session, targetId);
  if (!row || row.state === "provisioning" || !await ownerAuthorizedForRoot(session, row, owner, grantGeneration)) denied();
  return Object.freeze({ targetId: row.target_id, state: row.state, ownershipEpoch: row.ownership_epoch,
    recoveryOperationId: row.state === "revoking" || row.state === "revoked" ? row.revoked_operation_id : null });
}

/** Creates a one-use, currently authorized handoff for retrying the exact
 * immutable cleanup wire after its original actor proof has aged out or the
 * bounded automatic retry budget is exhausted. */
export async function reserveOperationsPortalNativeWorkspaceCleanupRecovery(database: D1Database,
  input: ReserveOperationsPortalNativeWorkspaceCleanupRecoveryInput) {
  if (!UUID.test(input.invocationId) || !UUID.test(input.operationId)) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, input.owner);
  const command = await session.prepare(`SELECT command.operation_id,command.request_fingerprint,
      workspace.target_id,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,
      workspace.root_kind,workspace.root_record_id,workspace.ownership_epoch,workspace.state,
      workspace.creation_operation_id,workspace.revoked_operation_id
    FROM operations_portal_native_workspace_cleanup_commands command
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
      AND workspace.state='revoking' AND workspace.revoked_operation_id=command.operation_id
    JOIN operations_portal_native_workspace_cleanup_outbox outbox ON outbox.operation_id=command.operation_id
      AND outbox.state<>'acknowledged'
    WHERE command.operation_id=?`).bind(input.operationId).first<RecoveryCommand>();
  if (!command || !await ownerAuthorizedForRoot(session, command, input.owner, grantGeneration)) denied();
  const prior = await session.prepare(`SELECT invocation_id,operation_id,state,invoked_by_staff_id,
      invoked_access_subject,invoked_admission_version,invoked_profile_version,invoked_grant_generation
    FROM operations_portal_native_workspace_cleanup_invocations WHERE invocation_id=?`)
    .bind(input.invocationId).first<RecoveryInvocation>();
  if (prior) {
    if (prior.operation_id !== input.operationId || prior.invoked_by_staff_id !== input.owner.identity.staffId
      || prior.invoked_access_subject !== input.owner.identity.verifiedAccessSubject
      || prior.invoked_admission_version !== input.owner.admissionVersion
      || prior.invoked_profile_version !== input.owner.identity.profileVersion
      || prior.invoked_grant_generation !== grantGeneration) denied();
    return Object.freeze({ invocationId: prior.invocation_id, operationId: prior.operation_id,
      state: prior.state, replayed: true as const });
  }
  try {
    await session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_invocations
      (invocation_id,operation_id,request_fingerprint,target_id,root_record_id,invoked_by_staff_id,
       invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
       invoked_grant_generation,invoked_verified_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.invocationId, command.operation_id, command.request_fingerprint,
        command.target_id, command.root_record_id, input.owner.identity.staffId,
        input.owner.identity.verifiedAccessSubject, input.owner.identity.email, input.owner.admissionVersion,
        input.owner.identity.profileVersion, grantGeneration, input.owner.verifiedUntil).run();
  } catch { denied(); }
  return Object.freeze({ invocationId: input.invocationId, operationId: input.operationId,
    state: "authorized" as const, replayed: false as const });
}

export async function revokeOperationsPortalNativeWorkspaceAuthority(database: D1Database,
  input: RevokeOperationsPortalNativeWorkspaceAuthorityInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.targetId)
    || !Number.isSafeInteger(input.expectedOwnershipEpoch) || input.expectedOwnershipEpoch < 1
    || !bounded(input.reason, 500)) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, input.owner);
  const row = await workspace(session, input.targetId);
  if (!row || !await ownerAuthorizedForRoot(session, row, input.owner, grantGeneration)) denied();
  // The idempotency identity is the exact business request. Actor proof is
  // frozen in the first command, while every retry independently revalidates
  // the caller's current authority. A renewed Access deadline or refreshed
  // admission/profile/grant generation therefore cannot strand recovery.
  const requestSha256 = await sha256(requestDocument(input));
  const prior = await session.prepare(`SELECT operation_id,target_id,expected_ownership_epoch,resulting_ownership_epoch,
      request_sha256,request_fingerprint,canonical_wire_json
    FROM operations_portal_native_workspace_cleanup_commands WHERE operation_id=?`).bind(input.operationId).first<CleanupRow>();
  if (prior) {
    if (prior.target_id !== input.targetId || prior.expected_ownership_epoch !== input.expectedOwnershipEpoch
      || prior.request_sha256 !== requestSha256 || await sha256(prior.canonical_wire_json) !== prior.request_fingerprint) denied();
    const current = await workspace(session, input.targetId);
    if (!current || current.revoked_operation_id !== input.operationId) denied();
    return result(current, input.operationId, true);
  }
  if (row.state !== "active" || row.ownership_epoch !== input.expectedOwnershipEpoch) denied();
  const observedAt = new Date().toISOString(), resultingOwnershipEpoch = row.ownership_epoch + 1;
  const wire = wireDocument(input.operationId, row, resultingOwnershipEpoch, input.owner, grantGeneration, observedAt);
  const fingerprint = await sha256(wire);
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_commands
        (operation_id,request_sha256,request_fingerprint,canonical_wire_json,target_id,target_revision,
         client_authority_id,workspace_id,root_kind,root_record_id,creation_operation_id,expected_ownership_epoch,
         resulting_ownership_epoch,authorized_by_staff_id,authorized_access_subject,authorized_admission_version,
         authorized_profile_version,authorized_grant_generation,authorized_verified_until,reason,observed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.operationId, requestSha256, fingerprint, wire,
          row.target_id, row.target_revision, row.client_authority_id, row.workspace_id, row.root_kind, row.root_record_id,
          row.creation_operation_id, row.ownership_epoch, resultingOwnershipEpoch, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.admissionVersion, input.owner.identity.profileVersion,
          grantGeneration, input.owner.verifiedUntil, input.reason, observedAt),
      session.prepare(`UPDATE operations_portal_native_workspace_authority_heads SET state='revoking',ownership_epoch=?,
        revoked_by_staff_id=?,revoked_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE target_id=? AND state='active' AND ownership_epoch=?`).bind(resultingOwnershipEpoch,
          input.owner.identity.staffId, input.operationId, row.target_id, row.ownership_epoch),
      session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_outbox
        (operation_id,request_fingerprint,canonical_wire_json) VALUES(?,?,?)`)
        .bind(input.operationId, fingerprint, wire),
    ]);
  } catch { denied(); }
  const current = await workspace(session, input.targetId);
  if (!current || current.state !== "revoking" || current.revoked_operation_id !== input.operationId) denied();
  return result(current, input.operationId, false);
}

export async function finalizeOperationsPortalNativeWorkspaceCleanup(database: D1Database, operationId: string) {
  if (!UUID.test(operationId)) denied();
  const session = database.withSession("first-primary");
  const command = await session.prepare(`SELECT target_id,resulting_ownership_epoch
    FROM operations_portal_native_workspace_cleanup_commands WHERE operation_id=?`).bind(operationId)
    .first<{ target_id: string; resulting_ownership_epoch: number }>();
  if (!command) denied();
  const prior = await session.prepare(`SELECT 1 FROM operations_portal_native_workspace_cleanup_finalizations
    WHERE operation_id=?`).bind(operationId).first();
  if (prior) { const current = await workspace(session, command.target_id); if (!current) denied();
    return result(current, operationId, true); }
  const row = await workspace(session, command.target_id);
  if (!row || row.state !== "revoking" || row.revoked_operation_id !== operationId
    || row.ownership_epoch !== command.resulting_ownership_epoch) denied();
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_workspace_cleanup_finalizations
        (operation_id,target_id,prior_state,resulting_state,ownership_epoch) VALUES(?,?,'revoking','revoked',?)`)
        .bind(operationId, row.target_id, row.ownership_epoch),
      session.prepare(`UPDATE operations_portal_native_workspace_authority_heads SET state='revoked',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE target_id=? AND state='revoking'
          AND ownership_epoch=? AND revoked_operation_id=?`).bind(row.target_id, row.ownership_epoch, operationId),
    ]);
  } catch { denied(); }
  const current = await workspace(session, row.target_id); if (!current) denied();
  return result(current, operationId, false);
}
