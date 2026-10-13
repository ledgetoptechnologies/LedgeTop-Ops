import { parseOperationsPortalWorkspaceFolderPrefix } from "@ltds/shared/operations-portal-workspace-publication";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MATCH_METHODS = new Set(["manual", "unique_rule", "project_alpha"]);
const encoder = new TextEncoder();

export type OperationsPortalSharedProjectFolderAssociation = Readonly<{
  opsFolderProjectId: string;
  opsDivisionId: string;
  baseR2Prefix: string;
  baseMatchMethod: "manual" | "unique_rule" | "project_alpha";
  baseConfirmedBy: string;
  baseConfirmedAt: string;
}>;

export type OperationsPortalSharedProjectFolder = Readonly<{
  targetId: string;
  externalProjectId: string;
  projectName: string;
  projectVersion: number;
  association: OperationsPortalSharedProjectFolderAssociation | null;
}>;

export type LookupOperationsPortalSharedProjectFolder = Readonly<{
  targetId: string;
  externalProjectId: string;
}>;

export type ConfirmOperationsPortalSharedProjectFolder = LookupOperationsPortalSharedProjectFolder & Readonly<{
  expectedProjectVersion: number;
  expectedAssociation: OperationsPortalSharedProjectFolderAssociation | null;
  opsDivisionId: string;
  baseR2Prefix: string;
}>;

type ProjectFolderRow = Readonly<{
  target_id: string;
  external_project_id: string;
  name: string;
  current_version: number;
  project_id: string | null;
  division_id: string | null;
  r2_prefix: string | null;
  match_method: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
}>;

type AssociationRow = Readonly<{
  project_id: string;
  division_id: string;
  r2_prefix: string;
  match_method: string;
  confirmed_by: string;
  confirmed_at: string;
}>;

function fail(reason: "denied" | "conflict" | "invalid"): never {
  throw new Error(`operations_portal_shared_project_folder_${reason}`);
}

function opaque(value: unknown, maximum = 191): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum || /\p{C}/u.test(value)) return false;
  try {
    const bytes = encoder.encode(value);
    return bytes.byteLength <= maximum * 4 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function actorValid(actor: AuthenticatedNativeStaffWithAdmissionVersion): boolean {
  try {
    const expires = Date.parse(actor?.verifiedUntil);
    return !!actor && actor.identity?.kind === "native" && opaque(actor.identity.staffId)
      && opaque(actor.identity.verifiedAccessSubject) && typeof actor.identity.email === "string"
      && actor.identity.email === actor.identity.email.trim().toLowerCase() && actor.identity.email.length <= 254
      && positiveInteger(actor.identity.profileVersion) && positiveInteger(actor.admissionVersion)
      && Number.isFinite(expires) && new Date(expires).toISOString() === actor.verifiedUntil && expires > Date.now();
  } catch {
    return false;
  }
}

function associationValid(value: OperationsPortalSharedProjectFolderAssociation | null): boolean {
  return value === null || !!value && opaque(value.opsFolderProjectId) && opaque(value.opsDivisionId)
    && parseOperationsPortalWorkspaceFolderPrefix(value.baseR2Prefix) !== null
    && MATCH_METHODS.has(value.baseMatchMethod) && opaque(value.baseConfirmedBy)
    && opaque(value.baseConfirmedAt, 64);
}

function inputValid(input: LookupOperationsPortalSharedProjectFolder): boolean {
  return !!input && typeof input.targetId === "string" && UUID.test(input.targetId) && opaque(input.externalProjectId);
}

function association(row: ProjectFolderRow | AssociationRow): OperationsPortalSharedProjectFolderAssociation | null {
  if (row.project_id === null || row.division_id === null || row.r2_prefix === null || row.match_method === null
    || row.confirmed_by === null || row.confirmed_at === null || !MATCH_METHODS.has(row.match_method)) return null;
  return Object.freeze({ opsFolderProjectId: row.project_id, opsDivisionId: row.division_id,
    baseR2Prefix: row.r2_prefix, baseMatchMethod: row.match_method as OperationsPortalSharedProjectFolderAssociation["baseMatchMethod"],
    baseConfirmedBy: row.confirmed_by, baseConfirmedAt: row.confirmed_at });
}

function result(row: ProjectFolderRow): OperationsPortalSharedProjectFolder {
  return Object.freeze({ targetId: row.target_id, externalProjectId: row.external_project_id,
    projectName: row.name, projectVersion: row.current_version, association: association(row) });
}

const ROOT_OWNERSHIP_SQL = `((workspace.root_kind='organization'
    AND (project.organization_record_id IS NOT NULL OR project.client_record_id IS NOT NULL)
    AND (project.organization_record_id IS NULL OR project.organization_record_id=workspace.root_record_id)
    AND (project.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=project.client_record_id
        AND relationship.organization_record_id=workspace.root_record_id)))
  OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
    AND project.client_record_id=workspace.root_record_id
    AND EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=workspace.root_record_id AND relationship.organization_record_id IS NULL)))`;

const CURRENT_ACTOR_SQL = `admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
  AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
    AND role.role_id='role-owner' AND role.scope='global')`;

const PORTAL_AUTHORITY_SQL = `EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
      AND permission.record_id=workspace.root_record_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
      AND permission.record_id=workspace.root_record_id)`;

const LOOKUP_SQL = `SELECT workspace.target_id,project.external_project_id,project.name,project.current_version,
    folder.project_id,folder.division_id,folder.r2_prefix,folder.match_method,folder.confirmed_by,folder.confirmed_at
  FROM operations_portal_workspace_reservation_heads workspace
  JOIN operations_shared_projects project ON project.external_project_id=?
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
    AND revision.version=project.current_version
  JOIN native_staff_admissions admission ON admission.staff_id=?
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation>=1
  LEFT JOIN project_folders folder ON folder.project_id=project.external_project_id
  WHERE workspace.target_id=? AND workspace.state='active' AND ${CURRENT_ACTOR_SQL}
    AND ${ROOT_OWNERSHIP_SQL} AND ${PORTAL_AUTHORITY_SQL}
    AND ((folder.project_id IS NULL
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='projects.view'
            AND permission.effect='allow' AND permission.scope='global')
        AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='projects.view'
            AND permission.effect='deny' AND permission.scope='global'))
      OR (folder.project_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='projects.view'
            AND permission.effect='allow' AND (permission.scope='global'
              OR (permission.scope='division' AND permission.division_id=folder.division_id)))
        AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='projects.view'
            AND permission.effect='deny' AND (permission.scope='global'
              OR (permission.scope='division' AND permission.division_id=folder.division_id)))
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='delivery.browse'
            AND permission.effect='allow' AND (permission.scope='global'
              OR (permission.scope='division' AND permission.division_id=folder.division_id)))
        AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
          WHERE permission.staff_id=admission.staff_id AND permission.permission_key='delivery.browse'
            AND permission.effect='deny' AND (permission.scope='global'
              OR (permission.scope='division' AND permission.division_id=folder.division_id)))))`;

export async function lookupOperationsPortalSharedProjectFolder(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: LookupOperationsPortalSharedProjectFolder,
): Promise<OperationsPortalSharedProjectFolder> {
  if (!actorValid(actor)) fail("denied");
  if (!inputValid(input)) fail("invalid");
  const db = database.withSession("first-primary");
  const row = await db.prepare(LOOKUP_SQL).bind(input.externalProjectId, actor.identity.staffId, actor.identity.email,
    actor.identity.profileVersion, input.targetId, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.verifiedUntil)
    .first<ProjectFolderRow>();
  if (!row) fail("denied");
  return result(row);
}

const MUTATION_AUTHORITY_SQL = `SELECT 1
  FROM operations_portal_workspace_reservation_heads workspace
  JOIN operations_shared_projects project ON project.external_project_id=? AND project.current_version=?
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
    AND revision.version=project.current_version
  JOIN divisions destination ON destination.id=? AND destination.active=1
  JOIN native_staff_admissions admission ON admission.staff_id=?
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation>=1
  WHERE workspace.target_id=? AND workspace.state='active' AND ${CURRENT_ACTOR_SQL}
    AND ${ROOT_OWNERSHIP_SQL} AND ${PORTAL_AUTHORITY_SQL}
    AND (SELECT count(DISTINCT permission.permission_key)
      FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
        AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
        AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=destination.id)))=3
    AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
        AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
        AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=destination.id)))`;

function mutationAuthorityBindings(actor: AuthenticatedNativeStaffWithAdmissionVersion,
  input: ConfirmOperationsPortalSharedProjectFolder): unknown[] {
  return [input.externalProjectId, input.expectedProjectVersion, input.opsDivisionId,
    actor.identity.staffId, actor.identity.email, actor.identity.profileVersion, input.targetId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.verifiedUntil];
}

function sameAssociation(left: OperationsPortalSharedProjectFolderAssociation | null,
  right: OperationsPortalSharedProjectFolderAssociation | null): boolean {
  return left === null || right === null ? left === right
    : left.opsFolderProjectId === right.opsFolderProjectId && left.opsDivisionId === right.opsDivisionId
      && left.baseR2Prefix === right.baseR2Prefix && left.baseMatchMethod === right.baseMatchMethod
      && left.baseConfirmedBy === right.baseConfirmedBy && left.baseConfirmedAt === right.baseConfirmedAt;
}

function desiredAlreadyConfirmed(current: OperationsPortalSharedProjectFolderAssociation | null,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: ConfirmOperationsPortalSharedProjectFolder): boolean {
  return current?.opsFolderProjectId === input.externalProjectId && current.opsDivisionId === input.opsDivisionId
    && current.baseR2Prefix === input.baseR2Prefix && current.baseMatchMethod === "manual"
    && current.baseConfirmedBy === actor.identity.staffId;
}

async function confirmationContext(database: D1DatabaseSession, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  input: ConfirmOperationsPortalSharedProjectFolder): Promise<ProjectFolderRow | null> {
  return database.prepare(`SELECT workspace.target_id,project.external_project_id,project.name,project.current_version,
      folder.project_id,folder.division_id,folder.r2_prefix,folder.match_method,folder.confirmed_by,folder.confirmed_at
    FROM operations_portal_workspace_reservation_heads workspace
    JOIN operations_shared_projects project ON project.external_project_id=? AND project.current_version=?
    JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
      AND revision.version=project.current_version
    JOIN divisions destination ON destination.id=? AND destination.active=1
    JOIN native_staff_admissions admission ON admission.staff_id=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=? AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation>=1
    LEFT JOIN project_folders folder ON folder.project_id=project.external_project_id
    WHERE workspace.target_id=? AND workspace.state='active' AND ${CURRENT_ACTOR_SQL}
      AND ${ROOT_OWNERSHIP_SQL} AND ${PORTAL_AUTHORITY_SQL}
      AND (SELECT count(DISTINCT permission.permission_key)
        FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=destination.id)))=3
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=destination.id)))
      AND (folder.project_id IS NULL OR (folder.division_id=destination.id AND folder.r2_prefix=?)
        OR ((SELECT count(DISTINCT permission.permission_key)
            FROM operations_portal_workspace_effective_permissions permission
            WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
              AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
              AND (permission.scope='global'
                OR (permission.scope='division' AND permission.division_id=folder.division_id)))=3
          AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
            WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
              AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
              AND (permission.scope='global'
                OR (permission.scope='division' AND permission.division_id=folder.division_id)))))`)
    .bind(input.externalProjectId, input.expectedProjectVersion, input.opsDivisionId,
      actor.identity.staffId, actor.identity.email, actor.identity.profileVersion, input.targetId,
      actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.verifiedUntil,
      input.baseR2Prefix).first<ProjectFolderRow>();
}

export async function confirmOperationsPortalSharedProjectFolder(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, input: ConfirmOperationsPortalSharedProjectFolder,
): Promise<OperationsPortalSharedProjectFolder> {
  if (!actorValid(actor)) fail("denied");
  if (!inputValid(input) || !positiveInteger(input.expectedProjectVersion)
    || !associationValid(input.expectedAssociation) || !opaque(input.opsDivisionId)
    || parseOperationsPortalWorkspaceFolderPrefix(input.baseR2Prefix) === null) fail("invalid");
  const db = database.withSession("first-primary");
  const context = await confirmationContext(db, actor, input);
  if (!context) fail("denied");
  const current = association(context);
  if (desiredAlreadyConfirmed(current, actor, input)) return result(context);
  if (!sameAssociation(current, input.expectedAssociation)) fail("conflict");

  try {
    let written: AssociationRow | null;
    if (current === null) {
      written = await db.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
        SELECT ?,?,?,'manual',? WHERE NOT EXISTS(SELECT 1 FROM project_folders WHERE project_id=?)
          AND EXISTS(${MUTATION_AUTHORITY_SQL})
        RETURNING project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at`)
        .bind(input.externalProjectId, input.opsDivisionId, input.baseR2Prefix, actor.identity.staffId,
          input.externalProjectId, ...mutationAuthorityBindings(actor, input)).first<AssociationRow>();
    } else {
      written = await db.prepare(`UPDATE project_folders AS folder
        SET division_id=?,r2_prefix=?,match_method='manual',confirmed_by=?,
          confirmed_at=CASE
            WHEN julianday('now')>julianday(folder.confirmed_at,'+0.001 seconds')
              THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ',folder.confirmed_at,'+0.001 seconds')
          END
        WHERE folder.project_id=? AND folder.division_id=? AND folder.r2_prefix=? AND folder.match_method=?
          AND folder.confirmed_by=? AND folder.confirmed_at=?
          AND ((folder.division_id=? AND folder.r2_prefix=?)
            OR ((SELECT count(DISTINCT permission.permission_key)
                FROM operations_portal_workspace_effective_permissions permission
                WHERE permission.staff_id=? AND permission.effect='allow'
                  AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
                  AND (permission.scope='global'
                    OR (permission.scope='division' AND permission.division_id=folder.division_id)))
                  =3
              AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
                WHERE permission.staff_id=? AND permission.effect='deny'
                  AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.revoke')
                  AND (permission.scope='global'
                    OR (permission.scope='division' AND permission.division_id=folder.division_id)))))
          AND EXISTS(${MUTATION_AUTHORITY_SQL})
        RETURNING project_id,division_id,r2_prefix,match_method,confirmed_by,confirmed_at`)
        .bind(input.opsDivisionId, input.baseR2Prefix, actor.identity.staffId, input.externalProjectId,
          current.opsDivisionId, current.baseR2Prefix, current.baseMatchMethod, current.baseConfirmedBy,
          current.baseConfirmedAt, input.opsDivisionId, input.baseR2Prefix, actor.identity.staffId,
          actor.identity.staffId, ...mutationAuthorityBindings(actor, input)).first<AssociationRow>();
    }
    if (!written) fail("conflict");
    return Object.freeze({ targetId: context.target_id, externalProjectId: context.external_project_id,
      projectName: context.name, projectVersion: context.current_version, association: association(written) });
  } catch (error) {
    if (error instanceof Error && error.message === "operations_portal_shared_project_folder_conflict") throw error;
    fail("conflict");
  }
}
