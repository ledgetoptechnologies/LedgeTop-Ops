import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REASON = 500;
type Db = Pick<D1Database, "prepare" | "batch">;
export type OperationsPortalWorkspacePublicationInvocationAction = "publish" | "recover" | "cancel";
export type ReserveOperationsPortalWorkspacePublicationInvocationInput = Readonly<{
  invocationId: string; operationId: string; action: OperationsPortalWorkspacePublicationInvocationAction; reason: string;
}>;
export type OperationsPortalWorkspacePublicationInvocation = Readonly<{
  invocationId: string; operationId: string; action: OperationsPortalWorkspacePublicationInvocationAction;
  state: "authorized" | "claimed"; replayed: boolean;
}>;
export type ClaimOperationsPortalWorkspacePublicationInvocationInput = Readonly<{
  db: Db; invocationId: string; operationId: string; action: OperationsPortalWorkspacePublicationInvocationAction;
  claimToken: string; claimUntil: string; lastErrorCode: string | null;
}>;

type Command = { operation_id: string; operation_fingerprint: string; target_id: string; target_revision: number;
  client_authority_id: string; workspace_id: string; root_kind: "organization" | "standalone_client";
  root_record_id: string; snapshot_id: string; checkpoint_id: string; snapshot_sha256: string };
type Proof = { staff_id: string; access_subject: string; email: string; admission_version: number;
  profile_version: number; grant_generation: number };
type Stored = { invocation_id: string; operation_id: string; action: OperationsPortalWorkspacePublicationInvocationAction;
  state: "authorized" | "claimed"; invoked_by_staff_id: string; invoked_access_subject: string;
  invoked_admission_version: number; invoked_profile_version: number; invoked_grant_generation: number; reason: string };

const fail = (code: string): never => { throw new Error(`operations_portal_workspace_publication_invocation_${code}`); };
function actorValid(actor: AuthenticatedNativeStaffWithAdmissionVersion): boolean {
  try {
    const until = Date.parse(actor.verifiedUntil);
    return actor.identity.kind === "native" && actor.identity.staffId.length > 0
      && actor.identity.verifiedAccessSubject.length > 0 && actor.identity.email.length > 0
      && Number.isSafeInteger(actor.admissionVersion) && actor.admissionVersion >= 1
      && Number.isSafeInteger(actor.identity.profileVersion) && actor.identity.profileVersion >= 1
      && Number.isFinite(until) && until > Date.now() && new Date(until).toISOString() === actor.verifiedUntil;
  } catch { return false; }
}
async function proof(db: Db, actor: AuthenticatedNativeStaffWithAdmissionVersion): Promise<Proof | null> {
  if (!actorValid(actor)) return null;
  return db.prepare(`SELECT admission.staff_id,admission.bound_access_subject access_subject,profile.login_email email,
      admission.version admission_version,profile.version profile_version,generation.generation grant_generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=?`).bind(actor.identity.staffId,
      actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.email,
      actor.identity.profileVersion).first<Proof>();
}
async function stored(db: Db, invocationId: string): Promise<Stored | null> {
  return db.prepare(`SELECT invocation_id,operation_id,action,state,invoked_by_staff_id,invoked_access_subject,
      invoked_admission_version,invoked_profile_version,invoked_grant_generation,reason
    FROM operations_portal_workspace_publication_invocations WHERE invocation_id=?`)
    .bind(invocationId).first<Stored>();
}
function exactReplay(row: Stored, request: ReserveOperationsPortalWorkspacePublicationInvocationInput, current: Proof) {
  return row.operation_id === request.operationId && row.action === request.action
    && row.invoked_by_staff_id === current.staff_id && row.invoked_access_subject === current.access_subject
    && row.invoked_admission_version === current.admission_version
    && row.invoked_profile_version === current.profile_version
    && row.invoked_grant_generation === current.grant_generation && row.reason === request.reason;
}

export async function reserveOperationsPortalWorkspacePublicationInvocation(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion,
  input: ReserveOperationsPortalWorkspacePublicationInvocationInput,
): Promise<OperationsPortalWorkspacePublicationInvocation> {
  if (!input || typeof input !== "object" || !UUID.test(input.invocationId) || !UUID.test(input.operationId)
    || !(["publish", "recover", "cancel"] as const).includes(input.action)
    || typeof input.reason !== "string" || input.reason.includes("\0") || input.reason.length > MAX_REASON
    || input.reason.trim().length < 1 || input.reason.trim().length > MAX_REASON) return fail("denied");
  const db = database.withSession("first-primary");
  const current = await proof(db, actor); if (!current) return fail("denied");
  const prior = await stored(db, input.invocationId);
  if (prior) {
    if (!exactReplay(prior, input, current)) return fail("replay_mismatch");
    return { invocationId: prior.invocation_id, operationId: prior.operation_id, action: prior.action,
      state: prior.state, replayed: true };
  }
  const command = await db.prepare(`SELECT operation_id,operation_fingerprint,target_id,target_revision,
      client_authority_id,workspace_id,root_kind,root_record_id,snapshot_id,checkpoint_id,snapshot_sha256
    FROM operations_portal_workspace_publication_commands WHERE operation_id=?`).bind(input.operationId).first<Command>();
  if (!command) return fail("denied");
  try {
    await db.prepare(`INSERT INTO operations_portal_workspace_publication_invocations
      (invocation_id,operation_id,action,operation_fingerprint,target_id,target_revision,client_authority_id,
        workspace_id,root_kind,root_record_id,snapshot_id,checkpoint_id,snapshot_sha256,invoked_by_staff_id,
        invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
        invoked_grant_generation,invoked_verified_until,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.invocationId, input.operationId, input.action,
        command.operation_fingerprint, command.target_id, command.target_revision, command.client_authority_id,
        command.workspace_id, command.root_kind, command.root_record_id, command.snapshot_id, command.checkpoint_id,
        command.snapshot_sha256, current.staff_id, current.access_subject, current.email, current.admission_version,
        current.profile_version, current.grant_generation, actor.verifiedUntil, input.reason).run();
  } catch { return fail("denied"); }
  const committed = await stored(db, input.invocationId);
  if (!committed || !exactReplay(committed, input, current) || committed.state !== "authorized") return fail("commit_unverified");
  return { invocationId: committed.invocation_id, operationId: committed.operation_id, action: committed.action,
    state: committed.state, replayed: false };
}

/** Atomically consumes a human authorization, claims its exact outbox row, and appends the immutable audit. */
export async function claimOperationsPortalWorkspacePublicationInvocation(
  input: ClaimOperationsPortalWorkspacePublicationInvocationInput,
): Promise<void> {
  if (!input || !UUID.test(input.invocationId) || !UUID.test(input.operationId) || !UUID.test(input.claimToken)
    || !(["publish", "recover", "cancel"] as const).includes(input.action)
    || Number.isNaN(Date.parse(input.claimUntil)) || new Date(Date.parse(input.claimUntil)).toISOString() !== input.claimUntil)
    return fail("claim_denied");
  const remoteFence = input.action === "publish" ? "" : "AND remote_attempted=1";
  const dueState = input.action === "publish"
    ? `((state IN ('pending','retry') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
    : `((state='retry' AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
  try {
    await input.db.batch([
      input.db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',
        attempt_count=attempt_count+1,claim_token=?,claim_until=?,last_error_code=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=? ${remoteFence} AND ${dueState}
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_invocations invocation
          WHERE invocation.invocation_id=? AND invocation.operation_id=? AND invocation.action=?
            AND invocation.state='authorized')`).bind(input.claimToken, input.claimUntil, input.lastErrorCode,
        input.operationId, input.invocationId, input.operationId, input.action),
      input.db.prepare(`UPDATE operations_portal_workspace_publication_invocations
        SET state='claimed',claim_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE invocation_id=? AND operation_id=? AND action=? AND state='authorized'`)
        .bind(input.claimToken, input.invocationId, input.operationId, input.action),
      input.db.prepare(`INSERT INTO operations_portal_workspace_publication_invocation_audit
        (invocation_id,operation_id,action,operation_fingerprint,target_id,target_revision,client_authority_id,
          workspace_id,root_kind,root_record_id,snapshot_id,checkpoint_id,snapshot_sha256,invoked_by_staff_id,
          invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
          invoked_grant_generation,invoked_verified_until,claim_token,claimed_at)
        SELECT invocation_id,operation_id,action,operation_fingerprint,target_id,target_revision,client_authority_id,
          workspace_id,root_kind,root_record_id,snapshot_id,checkpoint_id,snapshot_sha256,invoked_by_staff_id,
          invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
          invoked_grant_generation,invoked_verified_until,claim_token,claimed_at
        FROM operations_portal_workspace_publication_invocations WHERE invocation_id=? AND operation_id=?
          AND action=? AND state='claimed' AND claim_token=?`)
        .bind(input.invocationId, input.operationId, input.action, input.claimToken),
    ]);
  } catch { return fail("claim_denied"); }
  const exact = await input.db.prepare(`SELECT 1 exact FROM operations_portal_workspace_publication_invocation_audit audit
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=audit.operation_id
    WHERE audit.invocation_id=? AND audit.operation_id=? AND audit.action=? AND audit.claim_token=?
      AND outbox.state='dispatching' AND outbox.claim_token=audit.claim_token`)
    .bind(input.invocationId, input.operationId, input.action, input.claimToken).first("exact");
  if (exact !== 1) return fail("claim_denied");
}
