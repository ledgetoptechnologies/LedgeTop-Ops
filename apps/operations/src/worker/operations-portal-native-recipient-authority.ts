import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
export { readOperationsPortalNativeWorkspaceCleanupForOwner, reserveOperationsPortalNativeWorkspaceCleanupRecovery,
  revokeOperationsPortalNativeWorkspaceAuthority }
  from "./operations-portal-native-workspace-cleanup";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
type Owner = AuthenticatedNativeStaffWithAdmissionVersion;
type Principal = Readonly<{ issuer: string; subject: string }>;
type TargetAcknowledgement = Readonly<{ targetId: string; targetRevision: number; clientRecordId: string }>;
type IntentState = "issued" | "pending" | "confirming" | "active" | "revoking" | "revoked" | "cancelled";
type IntentRow = {
  intent_id: string; target_id: string; target_revision: number; target_client_record_id: string;
  target_relationship_version: number; token_sha256: string; state: IntentState; revision: number;
  access_issuer: string | null; access_subject: string | null; recipient_verified_until: string | null;
  recipient_binding_id: string | null; grant_operation_id: string | null; revoke_operation_id: string | null;
  expires_at: string; recipient_label: string | null;
};
type OperationRow = { action: string; request_sha256: string; resulting_revision: number; resulting_state: IntentState };
type TargetContext = { target_id: string; revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; relationship_version: number };
type WorkspaceHead = { target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; ownership_epoch: number;
  state: "provisioning" | "active" | "revoking" | "revoked" };
type RecipientHead = { recipient_binding_id: string; ownership_epoch: number; grant_revision: number; state: "active" | "revoked" };

export type OperationsPortalNativeRecipientReview = Readonly<{
  intentId: string; revision: number; state: IntentState;
  target: Readonly<{ targetId: string; targetRevision: number; clientRecordId: string }>;
  principal: Principal | null; recipientBindingId: string | null; expiresAt: string;
}>;
export type IssueOperationsPortalNativeRecipientInput = Readonly<{
  operationId: string; targetId: string; targetClientRecordId: string; expiresAt: string; owner: Owner;
}>;
export type RedeemOperationsPortalNativeRecipientInput = Readonly<{
  operationId: string; intentId: string; opaqueToken: string; principal: Principal; verifiedUntil: string;
  acknowledgedTarget: TargetAcknowledgement; recipientLabel: string;
}>;
export type OwnerOperationsPortalNativeRecipientInput = Readonly<{
  operationId: string; intentId: string; expectedRevision: number; owner: Owner;
}>;

function bounded(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !value.includes("\0");
}
function presentationLabel(value: unknown, intentId: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    && value.trim() === value && !/\p{C}/u.test(value) ? value : `Recipient ${intentId.slice(0, 8)}`;
}
function instant(value: unknown, future = false): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && (!future || parsed > Date.now());
}
function accessIssuer(value: unknown): value is string {
  if (!bounded(value)) return false;
  try { const url = new URL(value); return url.origin === value && url.protocol === "https:"
    && !url.port && url.hostname.endsWith(".cloudflareaccess.com"); } catch { return false; }
}
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function opaqueToken() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
const operationDocument = (action: string, operationId: string, intentId: string,
  request: Record<string, unknown>, actor: Record<string, unknown> | null) =>
  JSON.stringify({ action, operationId, intentId, request, actor });
function actorDocument(owner: Owner, grantGeneration: number) {
  return { staffId: owner.identity.staffId, accessSubject: owner.identity.verifiedAccessSubject,
    email: owner.identity.email, admissionVersion: owner.admissionVersion,
    profileVersion: owner.identity.profileVersion, grantGeneration, verifiedUntil: owner.verifiedUntil };
}
function review(row: IntentRow, state = row.state, revision = row.revision): OperationsPortalNativeRecipientReview {
  return Object.freeze({ intentId: row.intent_id, revision, state,
    target: Object.freeze({ targetId: row.target_id, targetRevision: row.target_revision,
      clientRecordId: row.target_client_record_id }),
    principal: row.access_issuer && row.access_subject
      ? Object.freeze({ issuer: row.access_issuer, subject: row.access_subject }) : null,
    recipientBindingId: row.recipient_binding_id, expiresAt: row.expires_at });
}
function denied(): never { throw new Error("operations_portal_native_recipient_denied"); }
async function generation(database: Pick<D1Database, "prepare">, owner: Owner) {
  if (!instant(owner.verifiedUntil, true)) denied();
  const value = await database.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(owner.identity.staffId).first<number>("generation");
  if (!Number.isSafeInteger(value) || value === null || value < 1) denied();
  return value;
}
async function ownerAuthorized(database: Pick<D1Database, "prepare">, targetId: string, owner: Owner, grantGeneration: number) {
  return Boolean(await database.prepare(`SELECT 1 FROM operations_portal_workspace_reservation_heads target
    JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    WHERE target.target_id=? AND target.state='active'
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=target.root_record_id AND scope.active=1
                AND scope.division_id=role.division_id))) )
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=target.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=target.root_record_id)`)
    .bind(owner.identity.staffId, owner.identity.verifiedAccessSubject, owner.admissionVersion, owner.identity.email,
      owner.identity.profileVersion, grantGeneration, targetId).first());
}
async function ownerAuthorizedForHistoricalRoot(database: Pick<D1Database, "prepare">, rootRecordId: string,
  owner: Owner, grantGeneration: number) {
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
      owner.identity.verifiedAccessSubject, owner.admissionVersion, rootRecordId, rootRecordId, rootRecordId).first());
}
async function workspaceHead(database: Pick<D1Database, "prepare">, targetId: string) {
  return database.prepare(`SELECT target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
      ownership_epoch,state FROM operations_portal_native_workspace_authority_heads WHERE target_id=?`)
    .bind(targetId).first<WorkspaceHead>();
}
function historicalTarget(workspace: WorkspaceHead, row: IntentRow): TargetContext {
  return { target_id: workspace.target_id, revision: workspace.target_revision,
    client_authority_id: workspace.client_authority_id, workspace_id: workspace.workspace_id,
    root_kind: workspace.root_kind, root_record_id: workspace.root_record_id,
    relationship_version: row.target_relationship_version };
}
async function targetContext(database: Pick<D1Database, "prepare">, targetId: string, clientRecordId: string) {
  return database.prepare(`SELECT target.target_id,target.revision,target.client_authority_id,target.workspace_id,
      target.root_kind,target.root_record_id,relation.relationship_version
    FROM operations_portal_workspace_reservation_heads target
    JOIN operations_directory_records client ON client.record_id=? AND client.record_kind='client'
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=client.record_id
    WHERE target.target_id=? AND target.state='active'
      AND ((target.root_kind='organization' AND relation.organization_record_id=target.root_record_id)
        OR (target.root_kind='standalone_client' AND client.record_id=target.root_record_id
          AND relation.organization_record_id IS NULL))`).bind(clientRecordId, targetId).first<TargetContext>();
}
async function pinnedContext(database: Pick<D1Database, "prepare">, row: IntentRow) {
  const context = await targetContext(database, row.target_id, row.target_client_record_id);
  return context && context.revision === row.target_revision
    && context.relationship_version === row.target_relationship_version ? context : null;
}
async function intent(database: Pick<D1Database, "prepare">, intentId: string) {
  return database.prepare(`SELECT intent.*,label.display_label recipient_label
    FROM operations_portal_native_recipient_intents intent
    LEFT JOIN operations_portal_native_recipient_labels label ON label.intent_id=intent.intent_id
    WHERE intent.intent_id=?`)
    .bind(intentId).first<IntentRow>();
}
async function exactReplay(database: Pick<D1Database, "prepare">, operationId: string, intentId: string,
  action: string, requestSha256: string) {
  const operation = await database.prepare(`SELECT action,request_sha256,resulting_revision,resulting_state
    FROM operations_portal_native_recipient_operations operation
    JOIN operations_portal_native_recipient_operation_commits committed ON committed.operation_id=operation.operation_id
      AND committed.intent_id=operation.intent_id
    WHERE operation.operation_id=? AND operation.intent_id=?`).bind(operationId, intentId).first<OperationRow>();
  if (!operation || operation.action !== action || operation.request_sha256 !== requestSha256) denied();
  const row = await intent(database, intentId); if (!row) denied();
  return { row, operation };
}
async function exactReplayIfPresent(database: Pick<D1Database, "prepare">, operationId: string, intentId: string,
  action: string, requestSha256: string) {
  const exists = await database.prepare("SELECT 1 FROM operations_portal_native_recipient_operations WHERE operation_id=?")
    .bind(operationId).first();
  return exists ? exactReplay(database, operationId, intentId, action, requestSha256) : null;
}

export async function issueOperationsPortalNativeRecipientIntent(database: D1Database,
  input: IssueOperationsPortalNativeRecipientInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.targetId) || !bounded(input.targetClientRecordId, 191)
    || !instant(input.expiresAt, true) || Date.parse(input.expiresAt) > Date.now() + 7 * 86_400_000) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, input.owner);
  if (!await ownerAuthorized(session, input.targetId, input.owner, grantGeneration)) denied();
  const target = await targetContext(session, input.targetId, input.targetClientRecordId); if (!target) denied();
  const intentId = crypto.randomUUID(), token = opaqueToken(), tokenSha256 = await sha256(token);
  const request = { expectedRevision: 0, targetId: target.target_id, targetRevision: target.revision,
    targetClientRecordId: input.targetClientRecordId, targetRelationshipVersion: target.relationship_version,
    expiresAt: input.expiresAt };
  const actor = actorDocument(input.owner, grantGeneration);
  const canonical = operationDocument("issue", input.operationId, intentId, request, actor);
  const digest = await sha256(canonical);
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_recipient_intents
        (intent_id,target_id,target_revision,target_client_record_id,target_relationship_version,token_sha256,state,revision,
         issued_by_staff_id,issued_access_subject,issued_email,issued_admission_version,issued_profile_version,
         issued_grant_generation,expires_at) VALUES(?,?,?,?,?,?,'issued',1,?,?,?,?,?,?,?)`)
        .bind(intentId, target.target_id, target.revision, input.targetClientRecordId, target.relationship_version,
          tokenSha256, input.owner.identity.staffId, input.owner.identity.verifiedAccessSubject, input.owner.identity.email,
          input.owner.admissionVersion, input.owner.identity.profileVersion, grantGeneration, input.expiresAt),
      session.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json,
         actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,
         actor_grant_generation,actor_verified_until) VALUES(?,?,'issue',0,1,'issued',?,?,?,?,?,?,?,?,?)`)
        .bind(input.operationId, intentId, digest, canonical, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.identity.email, input.owner.admissionVersion,
          input.owner.identity.profileVersion, grantGeneration, input.owner.verifiedUntil),
      session.prepare("INSERT INTO operations_portal_native_recipient_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(input.operationId, intentId),
    ]);
    const row = await intent(session, intentId); if (!row) denied();
    return Object.freeze({ review: review(row), opaqueToken: token, replayed: false as const });
  } catch {
    // Issue replay cannot recover the one-time plaintext. It returns only the
    // exact durable review, and only while the caller is currently authorized.
    const operation = await session.prepare(`SELECT operation.intent_id,operation.request_sha256
      FROM operations_portal_native_recipient_operations operation
      JOIN operations_portal_native_recipient_operation_commits committed ON committed.operation_id=operation.operation_id
      WHERE operation.operation_id=? AND operation.action='issue'`).bind(input.operationId)
      .first<{ intent_id: string; request_sha256: string }>();
    if (!operation) denied();
    const row = await intent(session, operation.intent_id); if (!row || !await pinnedContext(session, row)
      || !await ownerAuthorized(session, row.target_id, input.owner, grantGeneration)) denied();
    const historicalRequest = { expectedRevision: 0, targetId: row.target_id, targetRevision: row.target_revision,
      targetClientRecordId: row.target_client_record_id, targetRelationshipVersion: row.target_relationship_version,
      expiresAt: row.expires_at };
    const historical = operationDocument("issue", input.operationId, row.intent_id, historicalRequest, actor);
    if (operation.request_sha256 !== await sha256(historical) || input.targetId !== row.target_id
      || input.targetClientRecordId !== row.target_client_record_id || input.expiresAt !== row.expires_at) denied();
    return Object.freeze({ review: review(row, "issued", 1), opaqueToken: null, replayed: true as const });
  }
}

export async function inspectOperationsPortalNativeRecipientIntent(database: D1Database, intentId: string, token: string) {
  if (!UUID.test(intentId) || !TOKEN.test(token)) denied();
  const tokenSha = await sha256(token);
  const row = await database.withSession("first-primary").prepare(`SELECT intent.*
    FROM operations_portal_native_recipient_intents intent
    JOIN operations_portal_workspace_reservation_heads target ON target.target_id=intent.target_id
      AND target.revision=intent.target_revision AND target.state='active'
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=intent.target_client_record_id
      AND relation.relationship_version=intent.target_relationship_version
    WHERE intent.intent_id=? AND intent.token_sha256=? AND intent.state='issued'
      AND intent.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND ((target.root_kind='organization' AND relation.organization_record_id=target.root_record_id)
        OR (target.root_kind='standalone_client' AND intent.target_client_record_id=target.root_record_id
          AND relation.organization_record_id IS NULL))`).bind(intentId, tokenSha).first<IntentRow>();
  if (!row) denied(); return review(row);
}

export async function redeemOperationsPortalNativeRecipientIntent(database: D1Database,
  input: RedeemOperationsPortalNativeRecipientInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.intentId) || !TOKEN.test(input.opaqueToken)
    || !accessIssuer(input.principal.issuer) || !bounded(input.principal.subject)
    || !bounded(input.recipientLabel, 160) || /\p{C}/u.test(input.recipientLabel)
    || !instant(input.verifiedUntil, true) || !UUID.test(input.acknowledgedTarget.targetId)
    || !Number.isSafeInteger(input.acknowledgedTarget.targetRevision) || input.acknowledgedTarget.targetRevision < 1
    || !bounded(input.acknowledgedTarget.clientRecordId, 191)) denied();
  const session = database.withSession("first-primary"), row = await intent(session, input.intentId); if (!row) denied();
  const tokenSha256 = await sha256(input.opaqueToken);
  const request = { expectedRevision: 1, targetId: input.acknowledgedTarget.targetId,
    targetRevision: input.acknowledgedTarget.targetRevision,
    targetClientRecordId: input.acknowledgedTarget.clientRecordId,
    targetRelationshipVersion: row.target_relationship_version, tokenSha256,
    issuer: input.principal.issuer, subject: input.principal.subject, recipientLabel: input.recipientLabel,
    verifiedUntil: input.verifiedUntil };
  const canonical = operationDocument("redeem", input.operationId, input.intentId, request, null), digest = await sha256(canonical);
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json)
        VALUES(?,?,'redeem',1,2,'pending',?,?)`).bind(input.operationId, input.intentId, digest, canonical),
      session.prepare(`UPDATE operations_portal_native_recipient_intents SET state='pending',revision=2,access_issuer=?,access_subject=?,
        recipient_verified_until=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE intent_id=? AND state='issued' AND revision=1 AND token_sha256=? AND target_id=? AND target_revision=?
          AND target_client_record_id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .bind(input.principal.issuer, input.principal.subject, input.verifiedUntil, input.intentId, tokenSha256,
          input.acknowledgedTarget.targetId, input.acknowledgedTarget.targetRevision,
          input.acknowledgedTarget.clientRecordId, input.verifiedUntil),
      session.prepare("INSERT INTO operations_portal_native_recipient_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(input.operationId, input.intentId),
      session.prepare(`INSERT INTO operations_portal_native_recipient_labels
        (intent_id,redeem_operation_id,access_issuer,access_subject,display_label,label_source)
        VALUES(?,?,?,?,?,'access.email')`).bind(input.intentId, input.operationId, input.principal.issuer,
          input.principal.subject, input.recipientLabel),
    ]);
    const current = await intent(session, input.intentId); if (!current) denied();
    return Object.freeze({ review: review(current), replayed: false as const });
  } catch {
    const replay = await exactReplay(session, input.operationId, input.intentId, "redeem", digest);
    if (replay.row.state === "cancelled" || !await pinnedContext(session, replay.row)) denied();
    return Object.freeze({ review: review(replay.row, replay.operation.resulting_state,
      replay.operation.resulting_revision), replayed: true as const });
  }
}

async function ownerPreparation(database: D1Database, action: "cancel" | "confirm" | "revoke",
  input: OwnerOperationsPortalNativeRecipientInput) {
  if (!UUID.test(input.operationId) || !UUID.test(input.intentId) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, input.owner);
  const row = await intent(session, input.intentId); if (!row) denied();
  if (action === "revoke") {
    const workspace = await workspaceHead(session, row.target_id);
    if (!workspace || workspace.state !== "active"
      || !await ownerAuthorizedForHistoricalRoot(session, workspace.root_record_id, input.owner, grantGeneration)) denied();
  } else if (!await pinnedContext(session, row)
    || !await ownerAuthorized(session, row.target_id, input.owner, grantGeneration)) denied();
  const actor = actorDocument(input.owner, grantGeneration), request = { expectedRevision: input.expectedRevision };
  const canonical = operationDocument(action, input.operationId, input.intentId, request, actor);
  const businessRequest = JSON.stringify({ action, operationId: input.operationId, intentId: input.intentId, request });
  return { session, grantGeneration, row, actor, canonical, digest: await sha256(businessRequest) };
}

export async function cancelOperationsPortalNativeRecipientIntent(database: D1Database,
  input: OwnerOperationsPortalNativeRecipientInput) {
  const prepared = await ownerPreparation(database, "cancel", input), { session, row } = prepared;
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json,
         actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,'cancel',?,?,'cancelled',?,?,?,?,?,?,?,?,?)`).bind(input.operationId, input.intentId,
          input.expectedRevision, input.expectedRevision + 1, prepared.digest, prepared.canonical, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.identity.email, input.owner.admissionVersion,
          input.owner.identity.profileVersion, prepared.grantGeneration, input.owner.verifiedUntil),
      session.prepare(`UPDATE operations_portal_native_recipient_intents SET state='cancelled',revision=revision+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND revision=? AND state IN ('issued','pending')`)
        .bind(input.intentId, input.expectedRevision),
      session.prepare("INSERT INTO operations_portal_native_recipient_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(input.operationId, input.intentId),
    ]);
    const current = await intent(session, input.intentId); if (!current) denied();
    return Object.freeze({ review: review(current), replayed: false as const });
  } catch {
    const replay = await exactReplay(session, input.operationId, input.intentId, "cancel", prepared.digest);
    return Object.freeze({ review: review(replay.row, replay.operation.resulting_state,
      replay.operation.resulting_revision), replayed: true as const });
  }
}

function authorizationDocument(action: "recipient.grant" | "recipient.revoke", operationId: string,
  target: TargetContext, row: IntentRow, bindingId: string, expectedOwnershipEpoch: number,
  resultingOwnershipEpoch: number, expectedGrantRevision: number, resultingGrantRevision: number,
  owner: Owner, grantGeneration: number, observedAt: string) {
  return JSON.stringify({ action, operationId,
    target: { targetId: target.target_id, targetRevision: target.revision, clientAuthorityId: target.client_authority_id,
      workspaceId: target.workspace_id, rootKind: target.root_kind, rootRecordId: target.root_record_id },
    recipient: { recipientBindingId: bindingId, enrollmentIntentId: row.intent_id,
      targetClientRecordId: row.target_client_record_id, issuer: row.access_issuer, subject: row.access_subject },
    expected: { ownershipEpoch: expectedOwnershipEpoch, grantRevision: expectedGrantRevision },
    resulting: { ownershipEpoch: resultingOwnershipEpoch, grantRevision: resultingGrantRevision },
    permissionSchemaVersion: 3,
    permissions: action === "recipient.grant" ? ["operations.service_home.read"] : [], expiresAt: null,
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: owner.admissionVersion, profileVersion: owner.identity.profileVersion,
      grantGeneration, verifiedUntil: owner.verifiedUntil }, observedAt });
}

export async function confirmOperationsPortalNativeRecipientIntent(database: D1Database,
  input: OwnerOperationsPortalNativeRecipientInput) {
  const prepared = await ownerPreparation(database, "confirm", input), { session, row } = prepared;
  const prior = await exactReplayIfPresent(session, input.operationId, input.intentId, "confirm", prepared.digest);
  if (prior) return Object.freeze({ review: review(prior.row), authorityOperationId: input.operationId,
    replayed: true as const });
  if (row.state !== "pending" || row.revision !== input.expectedRevision || !row.access_issuer || !row.access_subject
    || !instant(row.recipient_verified_until, true) || Date.parse(row.expires_at) <= Date.now()) denied();
  const target = await pinnedContext(session, row); if (!target) denied();
  const workspace = await workspaceHead(session, row.target_id);
  if (workspace && workspace.state !== "active") denied();
  const expectedEpoch = workspace?.ownership_epoch ?? 0, resultingEpoch = workspace?.ownership_epoch ?? 1;
  const bindingId = crypto.randomUUID(), observedAt = new Date().toISOString();
  const authorization = authorizationDocument("recipient.grant", input.operationId, target, row, bindingId,
    expectedEpoch, resultingEpoch, 0, 1, input.owner, prepared.grantGeneration, observedAt);
  const authorizationFingerprint = await sha256(authorization);
  const commonCommand = [input.operationId, authorizationFingerprint, authorization, row.target_id, row.target_revision,
    target.client_authority_id, target.workspace_id, target.root_kind, target.root_record_id, bindingId, row.intent_id,
    row.target_client_record_id, row.access_issuer, row.access_subject, expectedEpoch, resultingEpoch,
    input.owner.identity.staffId, input.owner.identity.verifiedAccessSubject, input.owner.admissionVersion,
    input.owner.identity.profileVersion, prepared.grantGeneration, input.owner.verifiedUntil, observedAt] as const;
  try {
    const statements = [
      session.prepare(`INSERT INTO client_onboarding_recipient_identity_bindings
        (binding_id,target_client_record_id,access_issuer,access_subject,status,expires_at)
        VALUES(?,?,?,?,'active',NULL)`).bind(bindingId, row.target_client_record_id, row.access_issuer, row.access_subject),
      session.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json,
         actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,'confirm',?,?,'confirming',?,?,?,?,?,?,?,?,?)`).bind(input.operationId, input.intentId,
          input.expectedRevision, input.expectedRevision + 1, prepared.digest, prepared.canonical,
          input.owner.identity.staffId, input.owner.identity.verifiedAccessSubject, input.owner.identity.email,
          input.owner.admissionVersion, input.owner.identity.profileVersion, prepared.grantGeneration, input.owner.verifiedUntil),
      session.prepare(`INSERT INTO operations_portal_native_authority_commands
        (operation_id,authorization_fingerprint,canonical_authorization_json,action,target_id,target_revision,
         client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,
         target_client_record_id,issuer,subject,expected_ownership_epoch,resulting_ownership_epoch,
         expected_grant_revision,resulting_grant_revision,permission_schema_version,permissions_json,expires_at,
         authorized_by_staff_id,authorized_access_subject,authorized_admission_version,authorized_profile_version,
         authorized_grant_generation,authorized_verified_until,observed_at)
        VALUES(?,?,?,'recipient.grant',?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,3,'["operations.service_home.read"]',NULL,?,?,?,?,?,?,?)`)
        .bind(...commonCommand),
      ...(workspace ? [] : [session.prepare(`INSERT INTO operations_portal_native_workspace_authority_heads
        (target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,ownership_epoch,state,
         creation_operation_id,latest_operation_id,created_by_staff_id,created_access_subject,created_admission_version,
         created_profile_version,created_grant_generation) VALUES(?,?,?,?,?,?,1,'provisioning',?,?,?,?,?,?,?)`)
        .bind(row.target_id, row.target_revision, target.client_authority_id, target.workspace_id, target.root_kind,
          target.root_record_id, input.operationId, input.operationId, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.admissionVersion, input.owner.identity.profileVersion,
          prepared.grantGeneration)]),
      session.prepare(`INSERT INTO operations_portal_native_recipient_authority_heads
        (recipient_binding_id,enrollment_intent_id,target_id,target_client_record_id,issuer,subject,ownership_epoch,
         grant_revision,state,permission_schema_version,permissions_json,expires_at,creation_operation_id,latest_operation_id,
         created_by_staff_id,created_access_subject,created_admission_version,created_profile_version,created_grant_generation)
        VALUES(?,?,?,?,?,?,?,1,'active',3,'["operations.service_home.read"]',NULL,?,?,?,?,?,?,?)`)
        .bind(bindingId, row.intent_id, row.target_id, row.target_client_record_id, row.access_issuer, row.access_subject,
          resultingEpoch, input.operationId, input.operationId, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.admissionVersion, input.owner.identity.profileVersion,
          prepared.grantGeneration),
      session.prepare(`UPDATE operations_portal_native_recipient_intents SET state='confirming',revision=revision+1,
        recipient_binding_id=?,grant_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE intent_id=? AND state='pending' AND revision=? AND recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(bindingId, input.operationId, input.intentId, input.expectedRevision),
      session.prepare("INSERT INTO operations_portal_native_recipient_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(input.operationId, input.intentId),
    ];
    await session.batch(statements);
    const current = await intent(session, input.intentId); if (!current) denied();
    return Object.freeze({ review: review(current), authorityOperationId: input.operationId, replayed: false as const });
  } catch {
    const replay = await exactReplay(session, input.operationId, input.intentId, "confirm", prepared.digest);
    return Object.freeze({ review: review(replay.row, replay.operation.resulting_state,
      replay.operation.resulting_revision), authorityOperationId: input.operationId, replayed: true as const });
  }
}

export async function revokeOperationsPortalNativeRecipient(database: D1Database,
  input: OwnerOperationsPortalNativeRecipientInput) {
  const prepared = await ownerPreparation(database, "revoke", input), { session, row } = prepared;
  const prior = await exactReplayIfPresent(session, input.operationId, input.intentId, "revoke", prepared.digest);
  if (prior) return Object.freeze({ review: review(prior.row), authorityOperationId: input.operationId,
    replayed: true as const });
  if (row.state !== "active" || row.revision !== input.expectedRevision || !row.recipient_binding_id
    || !row.access_issuer || !row.access_subject) denied();
  const workspace = await workspaceHead(session, row.target_id);
  const target = workspace ? historicalTarget(workspace, row) : null; if (!target) denied();
  const head = await session.prepare(`SELECT recipient_binding_id,ownership_epoch,grant_revision,state
    FROM operations_portal_native_recipient_authority_heads WHERE recipient_binding_id=?`)
    .bind(row.recipient_binding_id).first<RecipientHead>();
  if (!workspace || workspace.state !== "active" || !head || head.state !== "active"
    || head.ownership_epoch !== workspace.ownership_epoch) denied();
  const observedAt = new Date().toISOString();
  const authorization = authorizationDocument("recipient.revoke", input.operationId, target, row, row.recipient_binding_id,
    workspace.ownership_epoch, workspace.ownership_epoch, head.grant_revision, head.grant_revision + 1,
    input.owner, prepared.grantGeneration, observedAt);
  const authorizationFingerprint = await sha256(authorization);
  try {
    await session.batch([
      session.prepare(`INSERT INTO operations_portal_native_recipient_operations
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_sha256,canonical_request_json,
         actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,'revoke',?,?,'revoking',?,?,?,?,?,?,?,?,?)`).bind(input.operationId, input.intentId,
          input.expectedRevision, input.expectedRevision + 1, prepared.digest, prepared.canonical,
          input.owner.identity.staffId, input.owner.identity.verifiedAccessSubject, input.owner.identity.email,
          input.owner.admissionVersion, input.owner.identity.profileVersion, prepared.grantGeneration, input.owner.verifiedUntil),
      session.prepare(`INSERT INTO operations_portal_native_authority_commands
        (operation_id,authorization_fingerprint,canonical_authorization_json,action,target_id,target_revision,
         client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,
         target_client_record_id,issuer,subject,expected_ownership_epoch,resulting_ownership_epoch,
         expected_grant_revision,resulting_grant_revision,permission_schema_version,permissions_json,expires_at,
         authorized_by_staff_id,authorized_access_subject,authorized_admission_version,authorized_profile_version,
         authorized_grant_generation,authorized_verified_until,observed_at)
        VALUES(?,?,?,'recipient.revoke',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,3,'[]',NULL,?,?,?,?,?,?,?)`)
        .bind(input.operationId, authorizationFingerprint, authorization, row.target_id, row.target_revision,
          target.client_authority_id, target.workspace_id, target.root_kind, target.root_record_id, row.recipient_binding_id,
          row.intent_id, row.target_client_record_id, row.access_issuer, row.access_subject, workspace.ownership_epoch,
          workspace.ownership_epoch, head.grant_revision, head.grant_revision + 1, input.owner.identity.staffId,
          input.owner.identity.verifiedAccessSubject, input.owner.admissionVersion, input.owner.identity.profileVersion,
          prepared.grantGeneration, input.owner.verifiedUntil, observedAt),
      session.prepare(`UPDATE operations_portal_native_recipient_authority_heads SET state='revoked',grant_revision=?,
        permissions_json='[]',latest_operation_id=?,revoked_by_staff_id=?,revoked_operation_id=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE recipient_binding_id=? AND state='active' AND grant_revision=? AND ownership_epoch=?`)
        .bind(head.grant_revision + 1, input.operationId, input.owner.identity.staffId, input.operationId,
          row.recipient_binding_id, head.grant_revision, workspace.ownership_epoch),
      session.prepare(`UPDATE operations_portal_native_recipient_intents SET state='revoking',revision=revision+1,
        revoke_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE intent_id=? AND state='active' AND revision=?`).bind(input.operationId, input.intentId, input.expectedRevision),
      session.prepare("INSERT INTO operations_portal_native_recipient_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(input.operationId, input.intentId),
    ]);
    const current = await intent(session, input.intentId); if (!current) denied();
    return Object.freeze({ review: review(current), authorityOperationId: input.operationId, replayed: false as const });
  } catch {
    const replay = await exactReplay(session, input.operationId, input.intentId, "revoke", prepared.digest);
    return Object.freeze({ review: review(replay.row, replay.operation.resulting_state,
      replay.operation.resulting_revision), authorityOperationId: input.operationId, replayed: true as const });
  }
}

/** Finalization accepts no remote result. It reads the durable, SQL-closed
 * acknowledged receipt already recorded by the private transport. */
export async function finalizeOperationsPortalNativeRecipientTransport(database: D1Database,
  input: Readonly<{ intentId: string; transportOperationId: string }>) {
  if (!UUID.test(input.intentId) || !UUID.test(input.transportOperationId)) denied();
  const session = database.withSession("first-primary");
  const prior = await session.prepare(`SELECT resulting_state,resulting_revision FROM operations_portal_native_authority_finalizations
    WHERE operation_id=? AND intent_id=?`).bind(input.transportOperationId, input.intentId)
    .first<{ resulting_state: "active" | "revoked"; resulting_revision: number }>();
  if (prior) { const row = await intent(session, input.intentId); if (!row) denied();
    return Object.freeze({ review: review(row, prior.resulting_state, prior.resulting_revision), replayed: true as const }); }
  const row = await intent(session, input.intentId); if (!row || (row.state !== "confirming" && row.state !== "revoking")
    || (row.state === "confirming" ? row.grant_operation_id : row.revoke_operation_id) !== input.transportOperationId) denied();
  const resultingState = row.state === "confirming" ? "active" : "revoked";
  const statements = [
    session.prepare(`INSERT INTO operations_portal_native_authority_finalizations
      (operation_id,intent_id,prior_state,prior_revision,resulting_state,resulting_revision)
      VALUES(?,?,?,?,?,?)`).bind(input.transportOperationId, input.intentId, row.state, row.revision,
        resultingState, row.revision + 1),
    ...(row.state === "confirming" ? [session.prepare(`UPDATE operations_portal_native_workspace_authority_heads
      SET state='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE target_id=? AND state='provisioning' AND creation_operation_id=?`)
      .bind(row.target_id, input.transportOperationId)] : [
      session.prepare(`UPDATE client_onboarding_recipient_identity_bindings SET status='revoked',
        revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE binding_id=? AND status='active'`).bind(row.recipient_binding_id),
    ]),
    session.prepare(`UPDATE operations_portal_native_recipient_intents SET state=?,revision=revision+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND state=? AND revision=?`)
      .bind(resultingState, input.intentId, row.state, row.revision),
  ];
  try { await session.batch(statements); }
  catch { denied(); }
  const current = await intent(session, input.intentId); if (!current) denied();
  return Object.freeze({ review: review(current), replayed: false as const });
}

export async function readOperationsPortalNativeRecipientIntent(database: D1Database, intentId: string) {
  if (!UUID.test(intentId)) return null; const row = await intent(database.withSession("first-primary"), intentId);
  return row ? review(row) : null;
}

/** Owner-facing review path. Unlike the internal transport helper above, this
 * revalidates the caller's live Access/admission/profile/grant-generation and
 * deny-winning exact-root management scope on every read. */
export async function readOperationsPortalNativeRecipientIntentForOwner(
  database: D1Database, intentId: string, owner: Owner,
) {
  if (!UUID.test(intentId)) denied();
  const session = database.withSession("first-primary"), grantGeneration = await generation(session, owner);
  const row = await intent(session, intentId);
  if (!row) denied();
  if (row.state === "active" || row.state === "revoking" || row.state === "revoked") {
    const workspace = await workspaceHead(session, row.target_id);
    if (!workspace || !await ownerAuthorizedForHistoricalRoot(session, workspace.root_record_id, owner, grantGeneration)) denied();
  } else if (!await pinnedContext(session, row)
    || !await ownerAuthorized(session, row.target_id, owner, grantGeneration)) denied();
  const recoveryOperationId = row.state === "confirming" || row.state === "active" ? row.grant_operation_id
    : row.state === "revoking" || row.state === "revoked" ? row.revoke_operation_id : null;
  return Object.freeze({ ...review(row), recipientLabel: presentationLabel(row.recipient_label, row.intent_id),
    recoveryOperationId });
}

export async function readOperationsPortalNativeAuthorityCommand(database: D1Database, operationId: string) {
  if (!UUID.test(operationId)) return null;
  return database.withSession("first-primary").prepare(`SELECT * FROM operations_portal_native_authority_commands
    WHERE operation_id=?`).bind(operationId).first<Record<string, unknown>>();
}

/** Effective home heads only. Confirming grants are intentionally absent until
 * an exact durable Client receipt has finalized the intent and umbrella. */
export async function listCurrentOperationsPortalNativeRecipientHeads(database: D1Database, targetId: string) {
  if (!UUID.test(targetId)) return [];
  const result = await database.withSession("first-primary").prepare(`SELECT head.recipient_binding_id recipientBindingId,
      head.enrollment_intent_id enrollmentIntentId,head.target_client_record_id targetClientRecordId,
      workspace.target_id targetId,workspace.target_revision targetRevision,workspace.client_authority_id clientAuthorityId,
      workspace.workspace_id workspaceId,head.issuer,head.subject,head.ownership_epoch ownershipEpoch,
      head.grant_revision grantRevision,head.state,head.latest_operation_id lastOperationId,
      head.permission_schema_version permissionSchemaVersion,head.permissions_json permissionsJson,head.expires_at expiresAt
    FROM operations_portal_native_recipient_authority_heads head
    JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=head.enrollment_intent_id
      AND intent.state='active' AND intent.recipient_binding_id=head.recipient_binding_id
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=head.target_id
      AND workspace.state='active' AND workspace.ownership_epoch=head.ownership_epoch
    JOIN operations_portal_workspace_reservation_heads target ON target.target_id=workspace.target_id
      AND target.state='active' AND target.revision=workspace.target_revision
    JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=head.recipient_binding_id
      AND binding.status='active' AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=head.target_client_record_id
      AND relation.relationship_version=intent.target_relationship_version
    WHERE head.target_id=? AND head.state='active'
      AND (head.expires_at IS NULL OR head.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND ((workspace.root_kind='organization' AND relation.organization_record_id=workspace.root_record_id)
        OR (workspace.root_kind='standalone_client' AND head.target_client_record_id=workspace.root_record_id
          AND relation.organization_record_id IS NULL))
    ORDER BY head.recipient_binding_id LIMIT 1001`).bind(targetId).all<Record<string, unknown>>();
  if (!result.success || result.results.length > 1000) return [];
  return result.results.map(row => Object.freeze(row));
}
