import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { parseOperationsPortalWorkspaceFolderPrefix } from "@ltds/shared/operations-portal-workspace-publication";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SAFE = 9_007_199_254_740_991;
const encoder = new TextEncoder();

type Db = Pick<D1Database, "prepare" | "batch">;
type Action = "workspace.reserve" | "workspace.revoke" | "folder.reserve" | "folder.revoke";
type RootKind = "organization" | "standalone_client";
type Proof = Readonly<{ staffId: string; accessSubject: string; email: string; admissionVersion: number;
  profileVersion: number; grantGeneration: number; verifiedUntil: string }>;
type Resource = Readonly<{ targetId: string; clientAuthorityId: string; workspaceId: string; rootKind: RootKind;
  rootRecordId: string; rootRecordVersion: number; relationshipVersion: number | null; reservationId: string | null;
  workspaceRevision: number | null; externalProjectId: string | null; projectVersion: number | null;
  opsFolderProjectId: string | null; opsDivisionId: string | null; baseR2Prefix: string | null;
  baseMatchMethod: string | null; baseConfirmedBy: string | null; baseConfirmedAt: string | null;
  clientFolderBindingId: string | null; selectedR2Prefix: string | null }>;

export type ReserveOperationsPortalWorkspace = Readonly<{ operationId: string; targetId: string;
  clientAuthorityId: string; workspaceId: string; rootKind: RootKind; rootRecordId: string;
  rootRecordVersion: number; relationshipVersion: number | null; expectedRevision: 0; reason: string }>;
export type RevokeOperationsPortalWorkspace = Readonly<{ operationId: string; targetId: string;
  expectedRevision: number; reason: string }>;
export type ReserveOperationsPortalFolder = Readonly<{ operationId: string; targetId: string; reservationId: string;
  expectedRevision: 0; expectedWorkspaceRevision: number; externalProjectId: string; projectVersion: number;
  opsFolderProjectId: string; opsDivisionId: string; baseR2Prefix: string; baseMatchMethod: string;
  baseConfirmedBy: string; baseConfirmedAt: string; clientFolderBindingId: string; selectedR2Prefix: string; reason: string }>;
export type RevokeOperationsPortalFolder = Readonly<{ operationId: string; targetId: string; reservationId: string;
  expectedRevision: number; reason: string }>;
export type OperationsPortalWorkspaceReservationResult = Readonly<{ operationId: string; action: Action;
  targetId: string; reservationId: string | null; revision: number; state: "active" | "revoked"; replayed: boolean }>;

type WorkspaceRow = Resource & Readonly<{ revision: number; state: "active" | "revoked" }>;
type FolderRow = Resource & Readonly<{ revision: number; state: "active" | "revoked" }>;

function denied(): never { throw new Error("operations_portal_workspace_reservation_denied"); }
function integer(value: unknown, zero = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1) && Number(value) <= MAX_SAFE;
}
function opaque(value: unknown, maximum = 200): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum || /\p{C}/u.test(value)) return false;
  try { const bytes = encoder.encode(value); return bytes.byteLength <= maximum * 4
    && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value; } catch { return false; }
}
function reason(value: unknown): value is string { return typeof value === "string" && value === value.trim()
  && value.length > 0 && value.length <= 500 && !/\p{C}/u.test(value); }
function prefix(value: unknown): value is string { return parseOperationsPortalWorkspaceFolderPrefix(value) !== null; }
function actorValid(actor: AuthenticatedNativeStaffWithAdmissionVersion): boolean {
  let verifiedUntil = Number.NaN;
  try { verifiedUntil = typeof actor?.verifiedUntil === "string" ? Date.parse(actor.verifiedUntil) : Number.NaN; }
  catch { return false; }
  return !!actor && actor.identity?.kind === "native" && opaque(actor.identity.staffId, 191)
    && opaque(actor.identity.verifiedAccessSubject, 191) && typeof actor.identity.email === "string"
    && actor.identity.email === actor.identity.email.trim().toLowerCase() && actor.identity.email.length <= 254
    && integer(actor.identity.profileVersion) && integer(actor.admissionVersion)
    && typeof actor.verifiedUntil === "string" && Number.isFinite(verifiedUntil)
    && new Date(verifiedUntil).toISOString() === actor.verifiedUntil && verifiedUntil > Date.now();
}
async function proof(db: Db, actor: AuthenticatedNativeStaffWithAdmissionVersion): Promise<Proof> {
  if (!actorValid(actor)) denied();
  const row = await db.prepare(`SELECT generation.generation FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=?`).bind(actor.identity.staffId, actor.identity.verifiedAccessSubject,
      actor.admissionVersion, actor.identity.email, actor.identity.profileVersion).first<{ generation: number }>();
  if (!row || !integer(row.generation) || Date.parse(actor.verifiedUntil) <= Date.now()) denied();
  return Object.freeze({ staffId: actor.identity.staffId, accessSubject: actor.identity.verifiedAccessSubject,
    email: actor.identity.email, admissionVersion: actor.admissionVersion, profileVersion: actor.identity.profileVersion,
    grantGeneration: row.generation, verifiedUntil: actor.verifiedUntil });
}
function canonical(value: Record<string, unknown>): string { return JSON.stringify(value); }
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function fingerprint(actor: AuthenticatedNativeStaffWithAdmissionVersion, action: Action, request: Record<string, unknown>) {
  const material = canonical({ action, actor: { staffId: actor.identity.staffId,
    accessSubject: actor.identity.verifiedAccessSubject }, request });
  return { hash: await sha256(material) };
}
function auditJson(action: Action, request: Record<string, unknown>, authority: Proof): string {
  return canonical({ action, actor: authority, request });
}
function commandStatement(db: Db, operationId: string, operationFingerprint: string, canonicalJson: string,
  action: Action, expectedRevision: number, resource: Resource, authority: Proof, commandReason: string) {
  return db.prepare(`INSERT INTO operations_portal_workspace_reservation_commands(
    operation_id,operation_fingerprint,canonical_command_json,action,target_id,expected_revision,resulting_revision,
    client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,reservation_id,
    workspace_revision,external_project_id,project_version,ops_folder_project_id,ops_division_id,base_r2_prefix,
    base_match_method,base_confirmed_by,base_confirmed_at,client_folder_binding_id,selected_r2_prefix,
    authorized_by_staff_id,authorized_access_subject,authorized_email,authorized_admission_version,
    authorized_profile_version,authorized_grant_generation,authorized_verified_until,reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(operationId, operationFingerprint,
      canonicalJson, action, resource.targetId, expectedRevision, expectedRevision + 1, resource.clientAuthorityId,
      resource.workspaceId, resource.rootKind, resource.rootRecordId, resource.rootRecordVersion,
      resource.relationshipVersion, resource.reservationId, resource.workspaceRevision, resource.externalProjectId,
      resource.projectVersion, resource.opsFolderProjectId, resource.opsDivisionId, resource.baseR2Prefix,
      resource.baseMatchMethod, resource.baseConfirmedBy, resource.baseConfirmedAt, resource.clientFolderBindingId,
      resource.selectedR2Prefix, authority.staffId, authority.accessSubject, authority.email,
      authority.admissionVersion, authority.profileVersion, authority.grantGeneration, authority.verifiedUntil, commandReason);
}
async function replayAuthority(db: Db, operationId: string, authority: Proof): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM operations_portal_workspace_reservation_commands command
    JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    WHERE command.operation_id=? AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments trusted
        WHERE trusted.staff_id=admission.staff_id AND trusted.role_id='role-owner' AND trusted.scope='global')
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.record_id=command.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.record_id=command.root_record_id)
      AND (command.action LIKE 'workspace.%' OR (
        (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
            AND (permission.permission_key IN ('projects.view','delivery.browse')
              OR (command.action='folder.reserve' AND permission.permission_key='delivery.share.create')
              OR (command.action='folder.revoke' AND permission.permission_key='delivery.share.revoke'))
            AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))=3
        AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
            AND (permission.permission_key IN ('projects.view','delivery.browse')
              OR (command.action='folder.reserve' AND permission.permission_key='delivery.share.create')
              OR (command.action='folder.revoke' AND permission.permission_key='delivery.share.revoke'))
            AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))))`)
    .bind(authority.staffId, authority.accessSubject, authority.admissionVersion, authority.email,
      authority.profileVersion, authority.grantGeneration, operationId, authority.verifiedUntil).first());
}
async function replay(db: Db, operationId: string, hash: string, action: Action,
  authority: Proof): Promise<OperationsPortalWorkspaceReservationResult | null> {
  const command = await db.prepare(`SELECT operation_fingerprint fingerprint,target_id targetId,reservation_id reservationId,
      resulting_revision revision FROM operations_portal_workspace_reservation_commands WHERE operation_id=? AND action=?`)
    .bind(operationId, action).first<{ fingerprint: string; targetId: string; reservationId: string | null; revision: number }>();
  if (!command) return null;
  if (command.fingerprint !== hash || !await replayAuthority(db, operationId, authority)) denied();
  const committed = action.startsWith("workspace")
    ? await db.prepare(`SELECT 1 FROM operations_portal_workspace_reservation_heads WHERE target_id=?
        AND ${action === "workspace.reserve" ? "creation_operation_id" : "revoked_operation_id"}=?`).bind(command.targetId, operationId).first()
    : await db.prepare(`SELECT 1 FROM operations_portal_folder_reservation_heads WHERE reservation_id=?
        AND ${action === "folder.reserve" ? "creation_operation_id" : "revoked_operation_id"}=?`).bind(command.reservationId, operationId).first();
  if (!committed) denied();
  return Object.freeze({ operationId, action, targetId: command.targetId, reservationId: command.reservationId,
    revision: command.revision, state: action.endsWith("reserve") ? "active" : "revoked", replayed: true });
}
function result(operationId: string, action: Action, targetId: string, reservationId: string | null,
  revision: number): OperationsPortalWorkspaceReservationResult {
  return Object.freeze({ operationId, action, targetId, reservationId, revision,
    state: action.endsWith("reserve") ? "active" : "revoked", replayed: false });
}
function workspaceResource(row: { target_id: string; client_authority_id: string; workspace_id: string; root_kind: RootKind;
  root_record_id: string; root_record_version: number; relationship_version: number | null }): Resource {
  return { targetId: row.target_id, clientAuthorityId: row.client_authority_id, workspaceId: row.workspace_id,
    rootKind: row.root_kind, rootRecordId: row.root_record_id, rootRecordVersion: row.root_record_version,
    relationshipVersion: row.relationship_version, reservationId: null, workspaceRevision: null, externalProjectId: null,
    projectVersion: null, opsFolderProjectId: null, opsDivisionId: null, baseR2Prefix: null, baseMatchMethod: null,
    baseConfirmedBy: null, baseConfirmedAt: null, clientFolderBindingId: null, selectedR2Prefix: null };
}

export async function reserveOperationsPortalWorkspace(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: ReserveOperationsPortalWorkspace,
): Promise<OperationsPortalWorkspaceReservationResult> {
  const db = database.withSession("first-primary");
  if (!input || !UUID.test(input.operationId) || !UUID.test(input.targetId) || !UUID.test(input.clientAuthorityId)
    || !opaque(input.workspaceId) || !opaque(input.rootRecordId, 191) || !integer(input.rootRecordVersion)
    || (input.rootKind !== "organization" && input.rootKind !== "standalone_client")
    || input.expectedRevision !== 0 || !reason(input.reason)
    || (input.rootKind === "organization" && input.relationshipVersion !== null)
    || (input.rootKind === "standalone_client" && !integer(input.relationshipVersion))) denied();
  const request = { operationId: input.operationId, targetId: input.targetId, clientAuthorityId: input.clientAuthorityId,
    workspaceId: input.workspaceId, rootKind: input.rootKind, rootRecordId: input.rootRecordId,
    rootRecordVersion: input.rootRecordVersion, relationshipVersion: input.relationshipVersion,
    expectedRevision: input.expectedRevision, reason: input.reason };
  const authority = await proof(db, actor), identity = await fingerprint(actor, "workspace.reserve", request);
  const prior = await replay(db, input.operationId, identity.hash, "workspace.reserve", authority); if (prior) return prior;
  const resource: Resource = { ...request, reservationId: null,
    workspaceRevision: null, externalProjectId: null, projectVersion: null, opsFolderProjectId: null,
    opsDivisionId: null, baseR2Prefix: null, baseMatchMethod: null, baseConfirmedBy: null, baseConfirmedAt: null,
    clientFolderBindingId: null, selectedR2Prefix: null };
  try { await db.batch([
    commandStatement(db, input.operationId, identity.hash, auditJson("workspace.reserve", request, authority),
      "workspace.reserve", 0, resource, authority, input.reason),
    db.prepare(`INSERT INTO operations_portal_workspace_reservation_heads(target_id,revision,state,latest_operation_id,
      client_authority_id,workspace_id,root_kind,root_record_id,root_record_version,relationship_version,
      creation_operation_id,created_by_staff_id,created_access_subject,created_admission_version,
      created_profile_version,created_grant_generation) VALUES(?,1,'active',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(input.targetId, input.operationId, input.clientAuthorityId, input.workspaceId, input.rootKind,
        input.rootRecordId, input.rootRecordVersion, input.relationshipVersion, input.operationId, authority.staffId,
        authority.accessSubject, authority.admissionVersion, authority.profileVersion, authority.grantGeneration),
  ]); } catch { denied(); }
  return result(input.operationId, "workspace.reserve", input.targetId, null, 1);
}

export async function revokeOperationsPortalWorkspace(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: RevokeOperationsPortalWorkspace,
): Promise<OperationsPortalWorkspaceReservationResult> {
  const db = database.withSession("first-primary");
  if (!input || !UUID.test(input.operationId) || !UUID.test(input.targetId) || !integer(input.expectedRevision) || !reason(input.reason)) denied();
  const request = { operationId: input.operationId, targetId: input.targetId, expectedRevision: input.expectedRevision, reason: input.reason };
  const authority = await proof(db, actor), identity = await fingerprint(actor, "workspace.revoke", request);
  const prior = await replay(db, input.operationId, identity.hash, "workspace.revoke", authority); if (prior) return prior;
  const row = await db.prepare(`SELECT target_id,client_authority_id,workspace_id,root_kind,root_record_id,
    root_record_version,relationship_version FROM operations_portal_workspace_reservation_heads
    WHERE target_id=? AND state='active' AND revision=?`).bind(input.targetId, input.expectedRevision).first<{
      target_id: string; client_authority_id: string; workspace_id: string; root_kind: RootKind; root_record_id: string;
      root_record_version: number; relationship_version: number | null }>();
  if (!row) denied(); const resource = workspaceResource(row);
  try { await db.batch([
    commandStatement(db, input.operationId, identity.hash, auditJson("workspace.revoke", request, authority),
      "workspace.revoke", input.expectedRevision,
      resource, authority, input.reason),
    db.prepare(`UPDATE operations_portal_workspace_reservation_heads SET revision=revision+1,state='revoked',
      latest_operation_id=?,revoked_by_staff_id=?,revoked_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE target_id=? AND state='active' AND revision=?`).bind(input.operationId, authority.staffId, input.operationId,
        input.targetId, input.expectedRevision),
  ]); } catch { denied(); }
  return result(input.operationId, "workspace.revoke", input.targetId, null, input.expectedRevision + 1);
}

async function workspace(db: Db, targetId: string, revision: number): Promise<WorkspaceRow | null> {
  const row = await db.prepare(`SELECT target_id,client_authority_id,workspace_id,root_kind,root_record_id,
    root_record_version,relationship_version,revision,state FROM operations_portal_workspace_reservation_heads
    WHERE target_id=? AND state='active' AND revision=?`).bind(targetId, revision).first<{
      target_id: string; client_authority_id: string; workspace_id: string; root_kind: RootKind; root_record_id: string;
      root_record_version: number; relationship_version: number | null; revision: number; state: "active" }>();
  return row ? { ...workspaceResource(row), revision: row.revision, state: row.state } : null;
}

export async function reserveOperationsPortalFolder(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: ReserveOperationsPortalFolder,
): Promise<OperationsPortalWorkspaceReservationResult> {
  const db = database.withSession("first-primary");
  if (!input || !UUID.test(input.operationId) || !UUID.test(input.targetId) || !UUID.test(input.reservationId)
    || input.expectedRevision !== 0 || !integer(input.expectedWorkspaceRevision) || !opaque(input.externalProjectId, 191)
    || !integer(input.projectVersion) || !opaque(input.opsFolderProjectId, 191) || !opaque(input.opsDivisionId, 191)
    || !prefix(input.baseR2Prefix) || !prefix(input.selectedR2Prefix) || !input.selectedR2Prefix.startsWith(input.baseR2Prefix)
    || !opaque(input.baseMatchMethod, 40) || !opaque(input.baseConfirmedBy, 191) || !opaque(input.baseConfirmedAt, 64)
    || !opaque(input.clientFolderBindingId) || !reason(input.reason)) denied();
  const request = { operationId: input.operationId, targetId: input.targetId, reservationId: input.reservationId,
    expectedRevision: input.expectedRevision, expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    externalProjectId: input.externalProjectId, projectVersion: input.projectVersion,
    opsFolderProjectId: input.opsFolderProjectId, opsDivisionId: input.opsDivisionId,
    baseR2Prefix: input.baseR2Prefix, baseMatchMethod: input.baseMatchMethod, baseConfirmedBy: input.baseConfirmedBy,
    baseConfirmedAt: input.baseConfirmedAt, clientFolderBindingId: input.clientFolderBindingId,
    selectedR2Prefix: input.selectedR2Prefix, reason: input.reason };
  const authority = await proof(db, actor), identity = await fingerprint(actor, "folder.reserve", request);
  const prior = await replay(db, input.operationId, identity.hash, "folder.reserve", authority); if (prior) return prior;
  const root = await workspace(db, input.targetId, input.expectedWorkspaceRevision); if (!root) denied();
  const resource: Resource = { ...root, reservationId: input.reservationId,
    workspaceRevision: input.expectedWorkspaceRevision, externalProjectId: input.externalProjectId,
    projectVersion: input.projectVersion, opsFolderProjectId: input.opsFolderProjectId,
    opsDivisionId: input.opsDivisionId, baseR2Prefix: input.baseR2Prefix, baseMatchMethod: input.baseMatchMethod,
    baseConfirmedBy: input.baseConfirmedBy, baseConfirmedAt: input.baseConfirmedAt,
    clientFolderBindingId: input.clientFolderBindingId, selectedR2Prefix: input.selectedR2Prefix };
  try { await db.batch([
    commandStatement(db, input.operationId, identity.hash, auditJson("folder.reserve", request, authority),
      "folder.reserve", 0, resource, authority, input.reason),
    db.prepare(`INSERT INTO operations_portal_folder_reservation_heads(reservation_id,target_id,revision,state,
      latest_operation_id,pinned_workspace_revision,external_project_id,project_version,ops_folder_project_id,
      ops_division_id,base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at,client_folder_binding_id,
      selected_r2_prefix,creation_operation_id,created_by_staff_id,created_access_subject,created_admission_version,
      created_profile_version,created_grant_generation) VALUES(?,?,1,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(input.reservationId, input.targetId, input.operationId, input.expectedWorkspaceRevision,
        input.externalProjectId, input.projectVersion, input.opsFolderProjectId, input.opsDivisionId, input.baseR2Prefix,
        input.baseMatchMethod, input.baseConfirmedBy, input.baseConfirmedAt, input.clientFolderBindingId,
        input.selectedR2Prefix, input.operationId, authority.staffId, authority.accessSubject, authority.admissionVersion,
        authority.profileVersion, authority.grantGeneration),
  ]); } catch { denied(); }
  return result(input.operationId, "folder.reserve", input.targetId, input.reservationId, 1);
}

export async function revokeOperationsPortalFolder(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: RevokeOperationsPortalFolder,
): Promise<OperationsPortalWorkspaceReservationResult> {
  const db = database.withSession("first-primary");
  if (!input || !UUID.test(input.operationId) || !UUID.test(input.targetId) || !UUID.test(input.reservationId)
    || !integer(input.expectedRevision) || !reason(input.reason)) denied();
  const request = { operationId: input.operationId, targetId: input.targetId, reservationId: input.reservationId,
    expectedRevision: input.expectedRevision, reason: input.reason };
  const authority = await proof(db, actor), identity = await fingerprint(actor, "folder.revoke", request);
  const prior = await replay(db, input.operationId, identity.hash, "folder.revoke", authority); if (prior) return prior;
  const row = await db.prepare(`SELECT folder.reservation_id,folder.target_id,folder.revision,folder.state,
      folder.pinned_workspace_revision workspaceRevision,folder.external_project_id externalProjectId,
      folder.project_version projectVersion,folder.ops_folder_project_id opsFolderProjectId,
      folder.ops_division_id opsDivisionId,folder.base_r2_prefix baseR2Prefix,folder.base_match_method baseMatchMethod,
      folder.base_confirmed_by baseConfirmedBy,folder.base_confirmed_at baseConfirmedAt,
      folder.client_folder_binding_id clientFolderBindingId,folder.selected_r2_prefix selectedR2Prefix,
      workspace.client_authority_id clientAuthorityId,workspace.workspace_id workspaceId,workspace.root_kind rootKind,
      workspace.root_record_id rootRecordId,workspace.root_record_version rootRecordVersion,
      workspace.relationship_version relationshipVersion
    FROM operations_portal_folder_reservation_heads folder
    JOIN operations_portal_workspace_reservation_heads workspace ON workspace.target_id=folder.target_id
    WHERE folder.reservation_id=? AND folder.target_id=? AND folder.state='active' AND folder.revision=?
      AND workspace.state='active' AND workspace.revision=folder.pinned_workspace_revision`)
    .bind(input.reservationId, input.targetId, input.expectedRevision).first<FolderRow>();
  if (!row) denied();
  const resource: Resource = { targetId: input.targetId, clientAuthorityId: row.clientAuthorityId,
    workspaceId: row.workspaceId, rootKind: row.rootKind, rootRecordId: row.rootRecordId,
    rootRecordVersion: row.rootRecordVersion, relationshipVersion: row.relationshipVersion,
    reservationId: input.reservationId, workspaceRevision: row.workspaceRevision,
    externalProjectId: row.externalProjectId, projectVersion: row.projectVersion,
    opsFolderProjectId: row.opsFolderProjectId, opsDivisionId: row.opsDivisionId, baseR2Prefix: row.baseR2Prefix,
    baseMatchMethod: row.baseMatchMethod, baseConfirmedBy: row.baseConfirmedBy, baseConfirmedAt: row.baseConfirmedAt,
    clientFolderBindingId: row.clientFolderBindingId, selectedR2Prefix: row.selectedR2Prefix };
  try { await db.batch([
    commandStatement(db, input.operationId, identity.hash, auditJson("folder.revoke", request, authority),
      "folder.revoke", input.expectedRevision,
      resource, authority, input.reason),
    db.prepare(`UPDATE operations_portal_folder_reservation_heads SET revision=revision+1,state='revoked',
      latest_operation_id=?,revoked_by_staff_id=?,revoked_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE reservation_id=? AND target_id=? AND state='active' AND revision=?`)
      .bind(input.operationId, authority.staffId, input.operationId, input.reservationId, input.targetId, input.expectedRevision),
  ]); } catch { denied(); }
  return result(input.operationId, "folder.revoke", input.targetId, input.reservationId, input.expectedRevision + 1);
}
