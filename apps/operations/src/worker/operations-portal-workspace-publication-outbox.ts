import {
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL,
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS,
  canonicalOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspaceSnapshot,
  parseOperationsPortalWorkspacePublicationRpcResponse,
  verifyOperationsPortalWorkspacePublication,
  type OperationsPortalDirectoryRecord,
  type OperationsPortalFolderReservation,
  type OperationsPortalProject,
  type OperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REASON = 500;
const RPC_TIMEOUT_MS = 15_000;
type Plain = Record<string, unknown>;
type PublicationDatabase = Pick<D1Database, "prepare" | "batch">;

export type ReserveOperationsPortalWorkspacePublicationInput = Readonly<{
  operationId: string; publicationId: string; targetId: string; snapshotId: string; checkpointId: string;
  expectedRevision: number; reason: string;
}>;
export type OperationsPortalWorkspacePublicationReservation = Readonly<{
  operationId: string; targetId: string; publicationRevision: number; sourceSequence: number;
  snapshotId: string; snapshotSha256: string; state: "pending" | "retry" | "dispatching" | "acknowledged" | "dead" | "superseded";
  replayed: boolean;
}>;
export interface OperationsPortalWorkspacePublicationBinding {
  publishWorkspace(input: OperationsPortalWorkspacePublication): Promise<unknown>;
  getPublicationStatus(input: OperationsPortalWorkspacePublication): Promise<unknown>;
}
export type DispatchOperationsPortalWorkspacePublicationInput = Readonly<{
  db: D1Database; binding: OperationsPortalWorkspacePublicationBinding; operationId: string;
}>;
export type OperationsPortalWorkspacePublicationDispatchResult = Readonly<{
  operationId: string; status: "acknowledged" | "retry" | "dead" | "superseded";
  replayed?: boolean;
}>;

type ActorProof = { staff_id: string; access_subject: string; email: string; admission_version: number;
  profile_version: number; grant_generation: number };
type Workspace = { target_id: string; revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string };
type DirectoryRow = { record_id: string; record_kind: "organization" | "client"; current_version: number;
  parent_record_id: string | null; relationship_version: number | null; display_name: string };
type ProjectRow = { external_project_id: string; current_version: number; name: string;
  lifecycle: OperationsPortalProject["lifecycle"]; planned_start: string | null; planned_end: string | null;
  completed_at: string | null; archived: number; archived_at: string | null; overdue_warning: number;
  organization_record_id: string | null; client_record_id: string | null };
type FolderRow = { reservation_id: string; revision: number; external_project_id: string; ops_folder_project_id: string;
  ops_division_id: string; client_folder_binding_id: string; selected_r2_prefix: string; base_r2_prefix: string;
  base_match_method: string; base_confirmed_by: string; base_confirmed_at: string };
type StoredCommand = { operation_id: string; publication_id: string; target_id: string; expected_revision: number;
  resulting_revision: number; snapshot_id: string; checkpoint_id: string; source_sequence: number; snapshot_sha256: string;
  operation_fingerprint: string; canonical_publication_json: string; authorized_by_staff_id: string;
  authorized_access_subject: string; reason: string; state: OperationsPortalWorkspacePublicationReservation["state"];
  attempt_count: number; remote_attempted: number; last_error_code: string | null };
type Receipt = { operationId: string; publicationId: string; requestFingerprint: string; targetId: string;
  resultingRevision: string; sourceSequence: string; snapshotId: string; snapshotSha256: string; replayed: boolean };

const fail = (code: string): never => { throw new Error(`operations_portal_workspace_publication_${code}`); };
function exact(value: unknown, keys: readonly string[]): Plain | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function normalize(input: unknown): ReserveOperationsPortalWorkspacePublicationInput | null {
  const value = exact(input, ["operationId", "publicationId", "targetId", "snapshotId", "checkpointId", "expectedRevision", "reason"]);
  if (!value || typeof value.operationId !== "string" || typeof value.publicationId !== "string"
    || typeof value.targetId !== "string" || typeof value.snapshotId !== "string"
    || typeof value.checkpointId !== "string" || !UUID.test(value.operationId) || !UUID.test(value.publicationId)
    || !UUID.test(value.targetId) || !UUID.test(value.snapshotId) || !UUID.test(value.checkpointId)
    || new Set([value.operationId, value.publicationId, value.targetId, value.snapshotId, value.checkpointId]).size !== 5
    || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || typeof value.reason !== "string" || value.reason.length > MAX_REASON
    || value.reason.trim().length < 1 || value.reason.trim().length > MAX_REASON
    || value.reason.includes("\0")) return null;
  return { operationId: value.operationId, publicationId: value.publicationId, targetId: value.targetId,
    snapshotId: value.snapshotId, checkpointId: value.checkpointId, expectedRevision: value.expectedRevision,
    reason: value.reason };
}
function actorValid(actor: AuthenticatedNativeStaffWithAdmissionVersion): boolean {
  try {
    if (!actor || typeof actor !== "object" || !actor.identity || actor.identity.kind !== "native"
      || typeof actor.identity.staffId !== "string" || !actor.identity.staffId
      || typeof actor.identity.verifiedAccessSubject !== "string" || !actor.identity.verifiedAccessSubject
      || typeof actor.identity.email !== "string" || !actor.identity.email
      || !Number.isSafeInteger(actor.identity.profileVersion) || actor.identity.profileVersion < 1
      || !Number.isSafeInteger(actor.admissionVersion) || actor.admissionVersion < 1
      || typeof actor.verifiedUntil !== "string") return false;
    const time = new Date(actor.verifiedUntil).getTime();
    return Number.isFinite(time) && time > Date.now() && new Date(time).toISOString() === actor.verifiedUntil;
  } catch { return false; }
}
async function currentProof(db: PublicationDatabase, actor: AuthenticatedNativeStaffWithAdmissionVersion): Promise<ActorProof | null> {
  if (!actorValid(actor)) return null;
  return db.prepare(`SELECT admission.staff_id,admission.bound_access_subject access_subject,profile.login_email email,
      admission.version admission_version,profile.version profile_version,generation.generation grant_generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.version=? AND profile.login_email=?`)
    .bind(actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.profileVersion, actor.identity.email).first<ActorProof>();
}
async function currentlyAuthorized(db: PublicationDatabase, proof: ActorProof, targetId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 authorized
    FROM operations_portal_workspace_reservation_heads workspace
    WHERE workspace.target_id=? AND workspace.state='active'
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=?
        AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=? AND permission.record_id=workspace.root_record_id AND permission.effect='allow')
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=? AND permission.record_id=workspace.root_record_id AND permission.effect='deny')
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=? AND permission.permission_key='projects.view'
          AND permission.effect='allow' AND permission.scope='global')
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=? AND permission.permission_key='projects.view'
          AND permission.effect='deny' AND permission.scope='global')
      AND NOT EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
        WHERE folder.target_id=workspace.target_id AND folder.state='active' AND
          ((SELECT count(DISTINCT permission.permission_key)
            FROM operations_portal_workspace_effective_permissions permission
            WHERE permission.staff_id=? AND permission.effect='allow'
              AND permission.permission_key IN ('projects.view','delivery.browse')
              AND (permission.scope='global' OR (permission.scope='division'
                AND permission.division_id=folder.ops_division_id)))<>2
          OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
            WHERE permission.staff_id=? AND permission.effect='deny'
              AND permission.permission_key IN ('projects.view','delivery.browse')
              AND (permission.scope='global' OR (permission.scope='division'
                AND permission.division_id=folder.ops_division_id)))))`)
    .bind(targetId, proof.staff_id, proof.staff_id, proof.staff_id, proof.staff_id, proof.staff_id,
      proof.staff_id, proof.staff_id)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function stored(db: PublicationDatabase, operationId: string): Promise<StoredCommand | null> {
  return db.prepare(`SELECT command.operation_id,command.publication_id,command.target_id,command.expected_revision,
      command.resulting_revision,command.snapshot_id,command.checkpoint_id,command.source_sequence,command.snapshot_sha256,
      command.operation_fingerprint,command.canonical_publication_json,command.authorized_by_staff_id,
      command.authorized_access_subject,command.reason,outbox.state,outbox.attempt_count,outbox.remote_attempted,
      outbox.last_error_code
    FROM operations_portal_workspace_publication_commands command
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(operationId).first<StoredCommand>();
}
function reservation(row: StoredCommand, replayed: boolean): OperationsPortalWorkspacePublicationReservation {
  return { operationId: row.operation_id, targetId: row.target_id, publicationRevision: row.resulting_revision,
    sourceSequence: row.source_sequence, snapshotId: row.snapshot_id, snapshotSha256: row.snapshot_sha256,
    state: row.state, replayed };
}
function exactReplay(row: StoredCommand, request: ReserveOperationsPortalWorkspacePublicationInput, proof: ActorProof) {
  return row.publication_id === request.publicationId && row.target_id === request.targetId
    && row.snapshot_id === request.snapshotId && row.checkpoint_id === request.checkpointId
    && row.expected_revision === request.expectedRevision && row.reason === request.reason
    && row.authorized_by_staff_id === proof.staff_id && row.authorized_access_subject === proof.access_subject;
}

async function topology(db: PublicationDatabase, targetId: string) {
  const workspace = await db.prepare(`SELECT target_id,revision,client_authority_id,workspace_id,root_kind,root_record_id
    FROM operations_portal_workspace_reservation_heads WHERE target_id=? AND state='active'`).bind(targetId).first<Workspace>();
  if (!workspace) return fail("target_not_active");
  const projectOwnershipSql = workspace.root_kind === "organization"
    ? `(project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
      AND (project.organization_record_id IS NULL OR project.organization_record_id=?)
      AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
        WHERE relation.client_record_id=project.client_record_id AND relation.organization_record_id=?))`
    : `project.organization_record_id IS NULL AND project.client_record_id=?`;
  const projectOwnershipBindings = workspace.root_kind === "organization"
    ? [workspace.root_record_id, workspace.root_record_id]
    : [workspace.root_record_id];
  const counts = await db.prepare(`SELECT
      CASE WHEN ?='organization' THEN 1+(SELECT count(*) FROM operations_directory_client_organizations relation
        WHERE relation.organization_record_id=?) ELSE 1 END directory_count,
      (SELECT count(*) FROM operations_portal_folder_reservation_heads folder
        WHERE folder.target_id=? AND folder.state='active') folder_count,
      (SELECT count(*) FROM operations_shared_projects project WHERE ${projectOwnershipSql}) project_count`)
    .bind(workspace.root_kind, workspace.root_record_id, targetId, ...projectOwnershipBindings)
    .first<{ directory_count: number; folder_count: number; project_count: number }>();
  if (!counts || counts.directory_count > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.directoryRecords
    || counts.folder_count > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.folderReservations
    || counts.project_count > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects) return fail("topology_too_large");
  const directorySql = workspace.root_kind === "organization"
    ? `SELECT record.record_id,record.record_kind,record.current_version,relation.organization_record_id parent_record_id,
        relation.relationship_version,json_extract(revision.profile_json,'$.name') display_name
      FROM operations_directory_records record
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      LEFT JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id
      WHERE record.record_id=? OR (record.record_kind='client' AND relation.organization_record_id=?) ORDER BY record.record_id`
    : `SELECT record.record_id,record.record_kind,record.current_version,relation.organization_record_id parent_record_id,
        relation.relationship_version,json_extract(revision.profile_json,'$.name') display_name
      FROM operations_directory_records record
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id
      WHERE record.record_id=? AND record.record_kind='client' AND relation.organization_record_id IS NULL ORDER BY record.record_id`;
  const directoryResult = workspace.root_kind === "organization"
    ? await db.prepare(directorySql).bind(workspace.root_record_id, workspace.root_record_id).all<DirectoryRow>()
    : await db.prepare(directorySql).bind(workspace.root_record_id).all<DirectoryRow>();
  const folders = (await db.prepare(`SELECT folder.reservation_id,folder.revision,folder.external_project_id,
      folder.ops_folder_project_id,folder.ops_division_id,folder.client_folder_binding_id,folder.selected_r2_prefix,
      folder.base_r2_prefix,folder.base_match_method,folder.base_confirmed_by,folder.base_confirmed_at
    FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=? AND folder.state='active' ORDER BY folder.external_project_id,folder.reservation_id`)
    .bind(targetId).all<FolderRow>()).results;
  const projects = (await db.prepare(`SELECT project.external_project_id,project.current_version,project.name,
      project.lifecycle,project.planned_start,project.planned_end,project.completed_at,project.archived,project.archived_at,
      project.overdue_warning,project.organization_record_id,project.client_record_id
    FROM operations_shared_projects project
    JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
      AND revision.version=project.current_version
    WHERE ${projectOwnershipSql} ORDER BY project.external_project_id
    LIMIT ${OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects + 1}`)
    .bind(...projectOwnershipBindings).all<ProjectRow>()).results;
  if (directoryResult.results.length !== counts.directory_count || folders.length !== counts.folder_count
    || projects.length !== counts.project_count) {
    if (projects.length > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects) return fail("topology_too_large");
    return fail("topology_drift");
  }
  const projectIds = new Set(projects.map(row => row.external_project_id));
  if (folders.some(folder => !projectIds.has(folder.external_project_id))) return fail("topology_drift");
  const directoryRecords: OperationsPortalDirectoryRecord[] = directoryResult.results.map(row => ({ recordId: row.record_id,
    kind: row.record_kind, version: String(row.current_version), parentRecordId: row.parent_record_id,
    relationshipVersion: row.relationship_version === null ? null : String(row.relationship_version),
    displayName: row.display_name, externalFences: [] }));
  const projectRecords: OperationsPortalProject[] = projects.map(row => ({ externalProjectId: row.external_project_id,
    version: String(row.current_version), name: row.name, lifecycle: row.lifecycle, plannedStart: row.planned_start,
    plannedEnd: row.planned_end, completedAt: row.completed_at, archived: row.archived === 1,
    archivedAt: row.archived_at, overdueWarning: row.overdue_warning === 1, published: true,
    organizationRecordId: row.organization_record_id, clientRecordId: row.client_record_id, externalFence: null }));
  const folderRecords: OperationsPortalFolderReservation[] = folders.map(row => ({ reservationId: row.reservation_id,
    externalProjectId: row.external_project_id, opsFolderProjectId: row.ops_folder_project_id, divisionId: row.ops_division_id,
    clientFolderBindingId: row.client_folder_binding_id, bindingVersion: String(row.revision), r2Prefix: row.selected_r2_prefix,
    state: "active" }));
  return { workspace, directoryRows: directoryResult.results, projectRows: projects, folderRows: folders,
    directoryRecords, projectRecords, folderRecords };
}

export async function reserveOperationsPortalWorkspacePublication(db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: ReserveOperationsPortalWorkspacePublicationInput,
): Promise<OperationsPortalWorkspacePublicationReservation> {
  const primary = db.withSession("first-primary");
  const request = normalize(input), proof = await currentProof(primary, actor);
  if (!request || !proof) return fail("denied");
  if (!await currentlyAuthorized(primary, proof, request.targetId)) return fail("denied");
  const replay = await stored(primary, request.operationId);
  if (replay) {
    if (!exactReplay(replay, request, proof)) return fail("replay_mismatch");
    return reservation(replay, true);
  }
  const source = await topology(primary, request.targetId);
  const resulting = request.expectedRevision + 1, observedAt = new Date().toISOString();
  const base: OperationsPortalWorkspacePublication = {
    protocol: OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL, protocolVersion: 1, action: "publish",
    publicationId: request.publicationId, operationId: request.operationId, expectedRevision: String(request.expectedRevision),
    resultingRevision: String(resulting), target: { targetId: source.workspace.target_id,
      targetRevision: String(source.workspace.revision), clientAuthorityId: source.workspace.client_authority_id,
      workspaceId: source.workspace.workspace_id, rootKind: source.workspace.root_kind, rootRecordId: source.workspace.root_record_id },
    snapshot: { snapshotId: request.snapshotId, checkpointId: request.checkpointId, sourceSequence: String(resulting),
      complete: true, counts: { directoryRecords: source.directoryRecords.length, projects: source.projectRecords.length,
        folderReservations: source.folderRecords.length, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64), directoryRecords: source.directoryRecords, projects: source.projectRecords,
      folderReservations: source.folderRecords, recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: proof.staff_id, verifiedAccessSubject: proof.access_subject,
      admissionVersion: String(proof.admission_version), profileVersion: String(proof.profile_version),
      grantGeneration: String(proof.grant_generation), verifiedUntil: actor.verifiedUntil }, observedAt,
  };
  const snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(base);
  const publication = await verifyOperationsPortalWorkspacePublication({ ...base,
    snapshot: { ...base.snapshot, snapshotSha256 } });
  if (!publication) return fail("invalid_snapshot");
  const canonical = canonicalOperationsPortalWorkspacePublication(publication);
  const fingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  const checkpoint = primary.prepare(`INSERT INTO operations_portal_workspace_publication_checkpoints
    (checkpoint_id,target_id,target_revision,directory_record_count,project_count,folder_reservation_count,
      directory_sha256,project_sha256,folder_sha256,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(request.checkpointId, request.targetId, source.workspace.revision, source.directoryRecords.length,
      source.projectRecords.length, source.folderRecords.length, await digest(source.directoryRecords),
      await digest(source.projectRecords), await digest(source.folderRecords), observedAt);
  const directorySourcesJson = JSON.stringify(source.directoryRows), projectSourcesJson = JSON.stringify(source.projectRows);
  const folderSourcesJson = JSON.stringify(source.folderRows);
  try {
    await primary.batch([checkpoint,
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_directory_sources
        (checkpoint_id,record_id,record_kind,record_version,parent_record_id,relationship_version,display_name)
        SELECT ?,json_extract(value,'$.record_id'),json_extract(value,'$.record_kind'),json_extract(value,'$.current_version'),
          json_extract(value,'$.parent_record_id'),json_extract(value,'$.relationship_version'),json_extract(value,'$.display_name')
        FROM json_each(?)`).bind(request.checkpointId, directorySourcesJson),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_project_sources
        (checkpoint_id,external_project_id,project_version,name,lifecycle,planned_start,planned_end,completed_at,archived,
          archived_at,overdue_warning,published,organization_record_id,client_record_id)
        SELECT ?,json_extract(value,'$.external_project_id'),json_extract(value,'$.current_version'),json_extract(value,'$.name'),
          json_extract(value,'$.lifecycle'),json_extract(value,'$.planned_start'),json_extract(value,'$.planned_end'),
          json_extract(value,'$.completed_at'),json_extract(value,'$.archived'),json_extract(value,'$.archived_at'),
          json_extract(value,'$.overdue_warning'),1,json_extract(value,'$.organization_record_id'),json_extract(value,'$.client_record_id')
        FROM json_each(?)`).bind(request.checkpointId, projectSourcesJson),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_folder_sources
        (checkpoint_id,reservation_id,external_project_id,ops_folder_project_id,division_id,client_folder_binding_id,
          binding_version,r2_prefix,base_r2_prefix,base_match_method,base_confirmed_by,base_confirmed_at)
        SELECT ?,json_extract(value,'$.reservation_id'),json_extract(value,'$.external_project_id'),
          json_extract(value,'$.ops_folder_project_id'),json_extract(value,'$.ops_division_id'),
          json_extract(value,'$.client_folder_binding_id'),json_extract(value,'$.revision'),
          json_extract(value,'$.selected_r2_prefix'),json_extract(value,'$.base_r2_prefix'),
          json_extract(value,'$.base_match_method'),json_extract(value,'$.base_confirmed_by'),json_extract(value,'$.base_confirmed_at')
        FROM json_each(?)`).bind(request.checkpointId, folderSourcesJson),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
        (snapshot_id,checkpoint_id,target_id,source_sequence,snapshot_sha256,snapshot_json) VALUES(?,?,?,?,?,?)`)
        .bind(request.snapshotId, request.checkpointId, request.targetId, resulting, snapshotSha256,
          JSON.stringify(publication.snapshot)),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_commands
        (operation_id,publication_id,operation_fingerprint,canonical_publication_json,target_id,target_revision,
          client_authority_id,workspace_id,root_kind,root_record_id,expected_revision,resulting_revision,snapshot_id,
          checkpoint_id,source_sequence,snapshot_sha256,authorized_by_staff_id,authorized_access_subject,authorized_email,
          authorized_admission_version,authorized_profile_version,authorized_grant_generation,authorized_verified_until,
          reason,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(request.operationId,
          request.publicationId, fingerprint, canonical, request.targetId, source.workspace.revision,
          source.workspace.client_authority_id, source.workspace.workspace_id, source.workspace.root_kind,
          source.workspace.root_record_id, request.expectedRevision, resulting, request.snapshotId, request.checkpointId,
          resulting, snapshotSha256, proof.staff_id, proof.access_subject, proof.email, proof.admission_version,
          proof.profile_version, proof.grant_generation, actor.verifiedUntil, request.reason, observedAt),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_audit
        (operation_id,action,authorized_by_staff_id,authorized_grant_generation)
        VALUES(?,'workspace.snapshot.enqueued',?,?)`).bind(request.operationId, proof.staff_id, proof.grant_generation),
      primary.prepare(`INSERT INTO operations_portal_workspace_publication_outbox(operation_id,target_id,checkpoint_id)
        VALUES(?,?,?)`).bind(request.operationId, request.targetId, request.checkpointId),
    ]);
  } catch {
    const raced = await stored(primary, request.operationId);
    if (raced) {
      if (!exactReplay(raced, request, proof)) return fail("replay_mismatch");
      return reservation(raced, true);
    }
    return fail("conflict");
  }
  const committed = await stored(primary, request.operationId);
  if (!committed) return fail("commit_unverified");
  return reservation(committed, false);
}

function receiptEnvelope(value: unknown, publication: OperationsPortalWorkspacePublication,
  fingerprint: string): Receipt | null {
  try {
    const envelope = exact(value, ["ok", "receipt"]); if (!envelope || envelope.ok !== true) return null;
    const row = exact(envelope.receipt, ["operationId", "publicationId", "requestFingerprint", "targetId",
      "resultingRevision", "sourceSequence", "snapshotId", "snapshotSha256", "replayed"]);
    if (!row || row.operationId !== publication.operationId || row.publicationId !== publication.publicationId
      || row.requestFingerprint !== fingerprint || row.targetId !== publication.target.targetId
      || row.resultingRevision !== publication.resultingRevision || row.sourceSequence !== publication.snapshot.sourceSequence
      || row.snapshotId !== publication.snapshot.snapshotId || row.snapshotSha256 !== publication.snapshot.snapshotSha256
      || typeof row.replayed !== "boolean") return null;
    return row as Receipt;
  } catch { return null; }
}
function failureEnvelope(value: unknown): { code: string; retryable: boolean } | null {
  const result = exact(value, ["ok", "protocol", "protocolVersion", "code", "retryable"]);
  if (!result || result.ok !== false || result.protocol !== OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL
    || result.protocolVersion !== 1 || typeof result.code !== "string" || typeof result.retryable !== "boolean") return null;
  return { code: result.code, retryable: result.retryable };
}
class RpcTimeout extends Error {}
async function boundedRpc<T>(call: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new RpcTimeout("rpc-timeout")), RPC_TIMEOUT_MS);
    })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
async function finishFailure(db: PublicationDatabase, operationId: string, claim: string, retry: boolean,
  errorCode = retry ? "temporarily-unavailable" : "client-conflict") {
  const result = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state=?,last_error_code=?,claim_token=NULL,
    claim_until=NULL,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(retry ? "retry" : "dead", errorCode,
      operationId, claim).run();
  return result.meta.changes;
}
async function confirmedState(db: PublicationDatabase, operationId: string,
  requested: "retry" | "dead" | "superseded", changes: number,
): Promise<OperationsPortalWorkspacePublicationDispatchResult> {
  if (changes === 1) return { operationId, status: requested };
  const current = await stored(db, operationId);
  if (current?.state === "acknowledged") return { operationId, status: "acknowledged", replayed: true };
  if (current?.state === requested) return { operationId, status: requested };
  return fail("claim_conflict");
}

export async function dispatchOperationsPortalWorkspacePublication(
  input: DispatchOperationsPortalWorkspacePublicationInput,
): Promise<OperationsPortalWorkspacePublicationDispatchResult> {
  if (!input || typeof input !== "object" || typeof input.operationId !== "string"
    || !UUID.test(input.operationId)) return fail("invalid_dispatch");
  const db = input.db.withSession("first-primary");
  const prior = await stored(db, input.operationId); if (!prior) return fail("not_found");
  if (prior.state === "acknowledged") return { operationId: prior.operation_id, status: "acknowledged", replayed: true };
  if (prior.state === "dead" || prior.state === "superseded") return { operationId: prior.operation_id, status: prior.state };
  if (prior.state !== "dispatching") {
    const current = await db.prepare(`SELECT 1 ok FROM operations_portal_workspace_publication_current_checkpoints
      WHERE checkpoint_id=?`).bind(prior.checkpoint_id).first("ok");
    if (!current && prior.remote_attempted === 0) {
      const changed = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='superseded',
        last_error_code='source-drift',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state IN ('pending','retry') AND remote_attempted=0`).bind(prior.operation_id).run();
      return confirmedState(db, prior.operation_id, "superseded", changed.meta.changes);
    }
    const live = await db.prepare(`SELECT 1 ok FROM operations_portal_workspace_publication_live_commands
      WHERE operation_id=?`).bind(prior.operation_id).first("ok");
    if (!live && prior.remote_attempted === 0) {
      const changed = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='superseded',
        last_error_code='authority-not-current',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state IN ('pending','retry') AND remote_attempted=0`).bind(prior.operation_id).run();
      return confirmedState(db, prior.operation_id, "superseded", changed.meta.changes);
    }
  }
  const claim = crypto.randomUUID(), until = new Date(Date.now() + 60_000).toISOString();
  const claimed = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',
      attempt_count=attempt_count+1,claim_token=?,claim_until=?,last_error_code=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=?
      AND ((state IN ('pending','retry') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))`)
    .bind(claim, until, prior.operation_id).run();
  if (claimed.meta.changes !== 1) return fail("claim_conflict");
  let parsed: unknown;
  try { parsed = JSON.parse(prior.canonical_publication_json); }
  catch {
    const changed = await finishFailure(db, prior.operation_id, claim, prior.remote_attempted === 1,
      prior.remote_attempted === 1 ? "rpc-outcome-ambiguous" : "invalid-command");
    return confirmedState(db, prior.operation_id, prior.remote_attempted === 1 ? "retry" : "dead", changed);
  }
  const publication = await verifyOperationsPortalWorkspacePublication(parsed);
  if (!publication || await sha256OperationsPortalWorkspacePublication(publication) !== prior.operation_fingerprint) {
    const changed = await finishFailure(db, prior.operation_id, claim, prior.remote_attempted === 1,
      prior.remote_attempted === 1 ? "rpc-outcome-ambiguous" : "invalid-command");
    return confirmedState(db, prior.operation_id, prior.remote_attempted === 1 ? "retry" : "dead", changed);
  }
  let response: unknown;
  if (prior.remote_attempted === 1) {
    try {
      response = parseOperationsPortalWorkspacePublicationRpcResponse(
        await boundedRpc(() => input.binding.getPublicationStatus(publication)));
    } catch {
      const changed = await finishFailure(db, prior.operation_id, claim, true, "rpc-outcome-ambiguous");
      return confirmedState(db, prior.operation_id, "retry", changed);
    }
    if (!receiptEnvelope(response, publication, prior.operation_fingerprint)) {
      const statusFailure = failureEnvelope(response);
      if (statusFailure?.code === "not-found") {
        const current = await db.prepare(`SELECT 1 ok
          FROM operations_portal_workspace_publication_current_checkpoints WHERE checkpoint_id=?`)
          .bind(prior.checkpoint_id).first("ok");
        const live = await db.prepare(`SELECT 1 ok FROM operations_portal_workspace_publication_live_commands
          WHERE operation_id=?`).bind(prior.operation_id).first("ok");
        if (!current || !live) {
          // Any prior attempt may have reached Client even if its marker was
          // lost to a crash. Keep the single-flight fence until Client yields
          // an exact receipt or a future protocol supplies a cancellation tombstone.
          const changed = await finishFailure(db, prior.operation_id, claim, true, "rpc-outcome-ambiguous");
          return confirmedState(db, prior.operation_id, "retry", changed);
        }
        response = undefined;
      } else {
        const changed = await finishFailure(db, prior.operation_id, claim, true, "rpc-outcome-ambiguous");
        return confirmedState(db, prior.operation_id, "retry", changed);
      }
    }
  }
  if (response === undefined) {
    if (prior.remote_attempted === 0) {
      const current = await db.prepare(`SELECT 1 ok FROM operations_portal_workspace_publication_current_checkpoints
        WHERE checkpoint_id=?`).bind(prior.checkpoint_id).first("ok");
      const live = await db.prepare(`SELECT 1 ok FROM operations_portal_workspace_publication_live_commands
        WHERE operation_id=?`).bind(prior.operation_id).first("ok");
      if (!current || !live) {
        const code = !current ? "source-drift" : "authority-not-current";
        const changed = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='superseded',
          last_error_code=?,claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE operation_id=? AND state='dispatching' AND claim_token=? AND remote_attempted=0`)
          .bind(code, prior.operation_id, claim).run();
        return confirmedState(db, prior.operation_id, "superseded", changed.meta.changes);
      }
      try {
        const marked = await db.prepare(`UPDATE operations_portal_workspace_publication_outbox
          SET remote_attempted=1,last_error_code='rpc-outcome-ambiguous',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE operation_id=? AND state='dispatching' AND claim_token=? AND remote_attempted=0`)
          .bind(prior.operation_id, claim).run();
        if (marked.meta.changes !== 1) return fail("claim_conflict");
      } catch {
        const changed = await finishFailure(db, prior.operation_id, claim, true, "source-or-authority-race");
        return confirmedState(db, prior.operation_id, "retry", changed);
      }
    }
    try {
      response = parseOperationsPortalWorkspacePublicationRpcResponse(
        await boundedRpc(() => input.binding.publishWorkspace(publication)));
    } catch {
      // A rejected service-binding promise does not prove the remote invocation
      // stopped. Treat every thrown publish outcome as ambiguous, including a
      // local timer, and reconcile through Client status before any resend.
      const changed = await finishFailure(db, prior.operation_id, claim, true, "rpc-outcome-ambiguous");
      return confirmedState(db, prior.operation_id, "retry", changed);
    }
  }
  const clientReceipt = receiptEnvelope(response, publication, prior.operation_fingerprint);
  if (!clientReceipt) {
    const changed = await finishFailure(db, prior.operation_id, claim, true, "rpc-outcome-ambiguous");
    return confirmedState(db, prior.operation_id, "retry", changed);
  }
  const head = prior.expected_revision === 0
    ? db.prepare(`INSERT INTO operations_portal_workspace_publication_heads
        (target_id,publication_revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
          source_sequence,snapshot_id,checkpoint_id,snapshot_sha256,latest_operation_id)
        SELECT command.target_id,command.resulting_revision,command.target_revision,command.client_authority_id,
          command.workspace_id,command.root_kind,command.root_record_id,command.source_sequence,command.snapshot_id,
          command.checkpoint_id,command.snapshot_sha256,command.operation_id
        FROM operations_portal_workspace_publication_commands command WHERE command.operation_id=?`)
      .bind(prior.operation_id)
    : db.prepare(`UPDATE operations_portal_workspace_publication_heads SET publication_revision=?,source_sequence=?,
        snapshot_id=?,checkpoint_id=?,snapshot_sha256=?,latest_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE target_id=? AND publication_revision=?`).bind(prior.resulting_revision, prior.source_sequence,
        prior.snapshot_id, prior.checkpoint_id, prior.snapshot_sha256, prior.operation_id, prior.target_id, prior.expected_revision);
  try {
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_workspace_publication_receipts
        (operation_id,publication_id,operation_fingerprint,target_id,resulting_revision,source_sequence,snapshot_id,
          snapshot_sha256,acknowledged_claim_token) VALUES(?,?,?,?,?,?,?,?,?)`).bind(prior.operation_id,
          prior.publication_id, prior.operation_fingerprint, prior.target_id, prior.resulting_revision,
          prior.source_sequence, prior.snapshot_id, prior.snapshot_sha256, claim),
      head,
      db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='acknowledged',
        acknowledged_claim_token=?,claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(claim, prior.operation_id, claim),
    ]);
  } catch { return fail("receipt_conflict"); }
  return { operationId: prior.operation_id, status: "acknowledged", replayed: clientReceipt.replayed };
}
