import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import type { Env } from "../types";
import type { ClientPortalSession, VerifiedClientPrincipal } from "./types";
import {
  createClientPortalFileHandle, decodeClientPortalFileHandle, decodeProjectFolderHandle,
  encodeProjectFolderHandle,
} from "./repository";
import {
  authorizeEffectiveWorkspaceProject, authorizeEffectiveWorkspaceRoot,
  resolveEffectivePortalWorkspaceContext, type EffectivePortalWorkspaceContext,
  portalHierarchyV2Enabled,
  type PortalAuthorizationEnv,
} from "./workspace-v2";
import { authorizeAuthenticatedDeliveryGrant, listAuthorizedAuthenticatedDeliveryPrefixes } from "./authenticated-delivery-grants";
import type { FeedbackRecord, FeedbackSourceOwner } from "./feedback-store";
import { projectAccessTermsReady } from './project-access-terms';
import { projectAccessReadColumns } from './project-access-read';
export type { FeedbackSourceOwner } from "./feedback-store";

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const feedbackTargetInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: opaqueId }).strict(),
  z.object({ kind: z.literal("folder"), projectId: opaqueId, folderId: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("file"), projectId: opaqueId.nullable(), fileId: z.string().min(1).max(4096) }).strict(),
]);
export type FeedbackTargetInput = z.infer<typeof feedbackTargetInputSchema>;
export interface FeedbackTargetContext {
  accountId: string; workspaceId: string | null; identityId: string; workspaceIdentityId: string | null;
  issuer: string; subject: string;
}
/** Interpret original snapshots without rewriting their immutable JSON or fingerprints. */
export function feedbackSourceOwnerSource(owner: FeedbackSourceOwner, kind: "account" | "project"): string | null | undefined {
  const row = owner[kind];
  if (!row) return null;
  if (owner.version === 2) {
    const source = row.projectAlphaSourceId;
    return source === null || (typeof source === "string" && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) ? source : undefined;
  }
  if (owner.version !== undefined || row.projectAlphaSourceId !== undefined) return undefined;
  // Versionless snapshots were authored before any secondary Delivery source existed.
  return (kind === "account" ? owner.account.projectAlphaClientId || owner.account.projectAlphaOrganizationId
    : owner.project?.projectAlphaProjectId) ? PRIMARY_ALPHA_SOURCE_ID : null;
}
export interface CanonicalFeedbackTarget {
  kind: FeedbackTargetInput["kind"]; projectId: string | null; associationId: string | null;
  relativePath: string | null; storageKey: string | null; label: string; projectName: string | null;
  sourceOwner: FeedbackSourceOwner;
}
export interface FeedbackAuthorizationGuard { sql: string; bindings: (string | number | null)[] }
export interface ResolvedFeedbackTarget {
  context: FeedbackTargetContext; target: CanonicalFeedbackTarget; guard: FeedbackAuthorizationGuard; available: boolean;
}
interface TargetRow {
  project_id: string | null; project_name: string | null; pa_project_id: string | null; source_updated_at: string | null;
  pa_client_id: string | null; pa_org_id: string | null; account_source_id: string | null; project_source_id: string | null;
  association_id: string | null; prefix: string | null; storage_key: string | null;
  etag: string | null; size: number | null; uploaded_at: string | null;
  target_live: number;
}
interface ProofPart { sql: string; maxRows: number; minRows?: number }
export type FeedbackAuthorizationEnv = PortalAuthorizationEnv & Pick<Env, "AUTHENTICATED_DELIVERY_GRANTS_ENABLED">;
const input = "input AS (SELECT json(?) v)";
const field = (name: string) => `(SELECT json_extract(v,'$.${name}') FROM input)`;
const account = field("accountId"), identity = field("identityId"), workspace = field("workspaceId");
const globalIdentity = field("workspaceIdentityId"), project = field("projectId"), association = field("associationId");
const key = field("storageKey"), binding = field("bindingId");
const notDeleted = (file: string) => `NOT EXISTS (SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
  AND (tombstone.physical_key=${file} OR (tombstone.tombstone_kind='prefix' AND substr(${file},1,length(tombstone.physical_key))=tombstone.physical_key)))`;
const localSelect = `SELECT account.project_alpha_client_id pa_client_id,account.project_alpha_organization_id pa_org_id,
  account.project_alpha_source_id account_source_id,project.project_alpha_source_id project_source_id,
  project.id project_id,project.project_name,project.project_alpha_project_id pa_project_id,project.source_updated_at,
  association.id association_id,association.r2_prefix prefix,file.r2_key storage_key,file.etag,file.size,file.uploaded_at,
  CASE WHEN ${field("kind")}='file' THEN file.r2_key IS NOT NULL AND ${notDeleted("file.r2_key")}
    WHEN ${field("kind")}='folder' THEN ${field("relativePath")}='' OR EXISTS(SELECT 1 FROM file_index child
      WHERE substr(child.r2_key,1,length(association.r2_prefix || ${field("relativePath")}))=association.r2_prefix || ${field("relativePath")}
        AND ${notDeleted("child.r2_key")}) ELSE 1 END target_live
 FROM client_accounts account
 JOIN client_identity_links identity ON identity.id=${identity} AND identity.account_id=account.id AND identity.revoked_at IS NULL
 JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id AND member.revoked_at IS NULL
 LEFT JOIN projects project ON project.id=${project} AND project.active=1
 LEFT JOIN client_project_grants grant_record ON grant_record.account_id=account.id AND grant_record.project_id=project.id AND grant_record.revoked_at IS NULL
 LEFT JOIN client_folder_associations association ON association.account_id=account.id AND association.revoked_at IS NULL
   AND ${field("kind")}<>'project'
   AND ((${project} IS NULL AND association.scope_type='client' AND association.project_id IS NULL)
     OR (${project} IS NOT NULL AND association.scope_type='project' AND association.project_id=${project}))
   AND (${association} IS NULL OR association.id=${association})
 LEFT JOIN file_index file ON file.r2_key=${key} AND substr(file.r2_key,1,length(association.r2_prefix))=association.r2_prefix
 WHERE account.id=${account} AND account.status='active'
   AND (${project} IS NULL OR (project.id IS NOT NULL AND grant_record.project_id IS NOT NULL AND
     (member.role='manager' OR EXISTS(SELECT 1 FROM client_member_project_grants mg WHERE mg.account_id=account.id
       AND mg.identity_id=identity.id AND mg.project_id=project.id AND mg.revoked_at IS NULL))))
   AND (${workspace} IS NOT NULL OR (identity.issuer=${field("issuer")} AND identity.subject=${field("subject")}))
   AND (${field("kind")}='project' OR association.id IS NOT NULL)
   AND (${workspace} IS NULL OR ${field("kind")}='project' OR association.r2_prefix IN (SELECT value FROM json_each(${field("authorizedPrefixes")})))
   AND (${field("allowMissing")}=1 OR ${key} IS NULL OR (file.r2_key IS NOT NULL AND ${notDeleted("file.r2_key")}))
   AND (${field("allowMissing")}=1 OR ${field("kind")}<>'folder' OR ${field("relativePath")}='' OR EXISTS(SELECT 1 FROM file_index child
     WHERE substr(child.r2_key,1,length(association.r2_prefix || ${field("relativePath")}))=association.r2_prefix || ${field("relativePath")}
       AND ${notDeleted("child.r2_key")}))`;

function rowsProof(select: string, columns: string[], maxRows = 200, ctes = input): ProofPart {
  return { sql: `WITH ${ctes} SELECT json_group_array(json_array(${columns.join(",")})) FROM (${select} LIMIT ${maxRows + 1})`, maxRows };
}
function deny(): never { throw new HTTPException(404, { message: "Feedback target not found" }); }
function changed(): never { throw new HTTPException(409, { message: "Feedback target or access changed. Refresh and try again." }); }

// These are explicit, bounded observations of policy inputs, not an alternate
// authorization engine. Existing resource resolvers decide access. Re-running
// these expressions in the INSERT detects additions (including new denies),
// removals, source changes and time-based validity changes in the transaction.
function proofParts(native: boolean,termsReady=false): ProofPart[] {
  const parts: ProofPart[] = [rowsProof(`${localSelect} ORDER BY association.id`, [
    "pa_client_id", "pa_org_id", "account_source_id", "project_source_id", "project_id", "project_name", "pa_project_id", "source_updated_at", "association_id", "prefix", "storage_key", "etag", "size", "uploaded_at", "target_live",
  ], 1), rowsProof(`SELECT member.role,member.can_view_billing,identity.issuer,identity.subject,identity.email FROM client_account_members member
    JOIN client_identity_links identity ON identity.id=member.identity_id
    WHERE member.account_id=${account} AND member.identity_id=${identity} AND member.revoked_at IS NULL AND identity.revoked_at IS NULL`,
    ["role", "can_view_billing", "issuer", "subject", "email"], 1)];
  if (!native) return parts;
  parts.push(rowsProof(`SELECT i.id,i.issuer,i.subject,i.verified_email,i.status,i.revoked_at,w.root_type,w.pa_organization_public_id,w.pa_client_public_id,
    w.legacy_account_id,w.status workspace_status,m.status membership_status,m.revoked_at membership_revoked,m.source_type,m.source_version,
    CASE WHEN m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now') THEN 1 ELSE 0 END membership_live,
    checkpoint.active_generation_id,checkpoint.source_sequence,g.status generation_status,g.complete,contract.schema_version
    FROM portal_v2_identities i JOIN portal_v2_workspace_memberships m ON m.identity_id=i.id AND m.workspace_id=${workspace}
    JOIN portal_v2_workspaces w ON w.id=m.workspace_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
    LEFT JOIN portal_v2_directory_generations g ON g.workspace_id=w.id AND g.id=checkpoint.active_generation_id
    LEFT JOIN portal_v2_directory_generation_contracts contract ON contract.workspace_id=w.id AND contract.generation_id=g.id
    WHERE i.id=${globalIdentity}`, ["id", "issuer", "subject", "verified_email", "status", "revoked_at", "root_type", "pa_organization_public_id", "pa_client_public_id", "legacy_account_id", "workspace_status", "membership_status", "membership_revoked", "source_type", "source_version", "membership_live", "active_generation_id", "source_sequence", "generation_status", "complete", "schema_version"], 1));
  for (const table of ["portal_v2_legacy_member_bridges", "portal_v2_identity_eligibility_legacy_bridges"]) {
    parts.push(rowsProof(`SELECT legacy_account_id,legacy_identity_id,status,revoked_at FROM ${table}
      WHERE workspace_id=${workspace} AND identity_id=${globalIdentity}`, ["legacy_account_id", "legacy_identity_id", "status", "revoked_at"], 1));
  }
  parts.push(rowsProof(`SELECT principal_public_id,principal_source_version,verified_email FROM portal_v2_identity_eligibility_bindings
    WHERE workspace_id=${workspace} AND identity_id=${globalIdentity} ORDER BY principal_public_id`, ["principal_public_id", "principal_source_version", "verified_email"]));
  parts.push(rowsProof(`SELECT id,match_type,issuer,subject,normalized_email FROM portal_v2_identity_eligibility_blocks
    WHERE status='active' AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND ((match_type='issuer_subject' AND issuer=${field("issuer")} AND subject=${field("subject")})
        OR (match_type='email' AND lower(trim(normalized_email))=lower(trim(${field("email")})))) ORDER BY id`, ["id", "match_type", "issuer", "subject", "normalized_email"]));
  for (const capability of ["workspace.view", "delivery.view", "request.create"]) {
    parts.push(rowsProof(`SELECT id,effect,scope_type,scope_public_id,entitlement_version,source_version,${projectAccessReadColumns('entitlement',termsReady)} FROM portal_v2_entitlements entitlement
      WHERE workspace_id=${workspace} AND identity_id=${globalIdentity} AND capability='${capability}'
        AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) ORDER BY id`,
      ["id", "effect", "scope_type", "scope_public_id", "entitlement_version", "source_version","access_terms_id","terms_project_id","terms_live"]));
  }
  parts.push(rowsProof(`SELECT id,workspace_id,scope_type,scope_public_id FROM portal_v2_identity_denials
    WHERE identity_id=${globalIdentity} AND (workspace_id=${workspace} OR scope_type='global')
      AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) ORDER BY id`, ["id", "workspace_id", "scope_type", "scope_public_id"]));
  parts.push(rowsProof(`SELECT id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status,revoked_at
    FROM portal_v2_folder_bindings WHERE workspace_id=${workspace} AND id=${binding}`,
    ["id", "owner_scope_type", "owner_public_id", "r2_prefix", "source_type", "source_version", "status", "revoked_at"], 1));
  for (const table of ["portal_v2_authenticated_delivery_grants", "project_alpha_delivery_portal_grants"]) {
    parts.push(rowsProof(`SELECT id,binding_source_version,audience_type,audience_public_id,audience_source_version,grant_version,
      ${projectAccessReadColumns('grant_record',termsReady&&table==='portal_v2_authenticated_delivery_grants')}
      FROM ${table} grant_record WHERE workspace_id=${workspace} AND folder_binding_id=${binding} AND status='active'
        AND revoked_at IS NULL AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) ORDER BY id`,
      ["id", "binding_source_version", "audience_type", "audience_public_id", "audience_source_version", "grant_version","access_terms_id","terms_project_id","terms_live"], 100));
  }
  parts.push(rowsProof(`SELECT r.grant_id,r.principal_public_id,r.identity_id,r.principal_source_version
    FROM portal_v2_authenticated_delivery_grant_recipients r JOIN portal_v2_authenticated_delivery_grants g ON g.id=r.grant_id
    WHERE r.workspace_id=${workspace} AND r.identity_id=${globalIdentity} AND g.folder_binding_id=${binding} ORDER BY r.grant_id`,
    ["grant_id", "principal_public_id", "identity_id", "principal_source_version"], 100));
  parts.push(rowsProof(`SELECT p.public_id,p.identity_id,p.email_hint,p.source_version,p.status FROM pa_portal_principals p
    WHERE p.workspace_id=${workspace} AND (p.identity_id=${globalIdentity} OR p.public_id IN (
      SELECT principal_public_id FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=${workspace} AND identity_id=${globalIdentity}
      UNION SELECT audience_public_id FROM portal_v2_authenticated_delivery_grants WHERE workspace_id=${workspace} AND folder_binding_id=${binding} AND audience_type='principal'
      UNION SELECT audience_public_id FROM project_alpha_delivery_portal_grants WHERE workspace_id=${workspace} AND folder_binding_id=${binding}
    )) ORDER BY p.public_id`, ["public_id", "identity_id", "email_hint", "source_version", "status"]));
  const ancestry = `RECURSIVE ${input}, generation AS (SELECT active_generation_id id FROM portal_v2_directory_checkpoints WHERE workspace_id=${workspace}),
    ancestors(entity_type,public_id) AS (
      SELECT entity_type,public_id FROM portal_v2_directory_entities WHERE workspace_id=${workspace} AND generation_id=(SELECT id FROM generation)
        AND ((entity_type=${field("rootType")} AND public_id=${field("rootPublicId")})
          OR (entity_type='project' AND public_id=${field("projectPublicId")})
          OR (entity_type=${field("bindingOwnerType")} AND public_id=${field("bindingOwnerId")}))
      UNION SELECT parent.entity_type,parent.public_id FROM ancestors child
        JOIN portal_v2_directory_entities entity ON entity.workspace_id=${workspace} AND entity.generation_id=(SELECT id FROM generation)
          AND entity.entity_type=child.entity_type AND entity.public_id=child.public_id
        JOIN portal_v2_directory_entities parent ON parent.workspace_id=entity.workspace_id AND parent.generation_id=entity.generation_id
          AND parent.public_id=entity.parent_public_id
      UNION SELECT edge.from_type,edge.from_public_id FROM ancestors child
        JOIN portal_v2_directory_relations edge ON edge.workspace_id=${workspace} AND edge.generation_id=(SELECT id FROM generation)
          AND edge.to_type=child.entity_type AND edge.to_public_id=child.public_id AND edge.active=1
      LIMIT 201
    )`;
  parts.push(rowsProof(`SELECT e.entity_type,e.public_id,e.parent_public_id,e.source_version,e.active,
    lifecycle.lifecycle_status,lifecycle.completed_at,
    CASE WHEN lifecycle.lifecycle_status='active' OR datetime(lifecycle.completed_at,'+30 days')>datetime('now') THEN 1 ELSE 0 END retained
    FROM ancestors JOIN portal_v2_directory_entities e ON e.workspace_id=${workspace} AND e.generation_id=(SELECT id FROM generation)
      AND e.entity_type=ancestors.entity_type AND e.public_id=ancestors.public_id
    LEFT JOIN portal_v2_project_lifecycle lifecycle ON lifecycle.workspace_id=e.workspace_id AND lifecycle.generation_id=e.generation_id
      AND e.entity_type='project' AND lifecycle.project_public_id=e.public_id ORDER BY e.entity_type,e.public_id`,
    ["entity_type", "public_id", "parent_public_id", "source_version", "active", "lifecycle_status", "completed_at", "retained"], 200, ancestry));
  parts.push(rowsProof(`SELECT r.public_id,r.relation_type,r.from_type,r.from_public_id,r.to_type,r.to_public_id,r.source_version,r.active
    FROM portal_v2_directory_relations r JOIN ancestors ON ancestors.entity_type=r.to_type AND ancestors.public_id=r.to_public_id
    WHERE r.workspace_id=${workspace} AND r.generation_id=(SELECT id FROM generation) ORDER BY r.public_id`,
    ["public_id", "relation_type", "from_type", "from_public_id", "to_type", "to_public_id", "source_version", "active"], 200, ancestry));
  return parts;
}

async function capture(database: D1DatabaseSession, parts: ProofPart[], values: string): Promise<string[]> {
  const result = await database.prepare(`SELECT ${parts.map((part,index) => `(${part.sql}) p${index}`).join(",")}`)
    .bind(...parts.map(() => values)).first<Record<string, string>>();
  return parts.map((_part, index) => {
    const proof = result?.[`p${index}`];
    if (typeof proof !== "string" || proof.length > 128_000) throw new HTTPException(503, { message: "Feedback access cannot be verified" });
    const rows: unknown = JSON.parse(proof);
    if (!Array.isArray(rows) || rows.length > parts[index]!.maxRows) throw new HTTPException(503, { message: "Feedback access cannot be verified" });
    if (rows.length < (parts[index]!.minRows ?? 0)) deny();
    return proof;
  });
}

export async function resolveClientFeedbackTarget(
  env: Env, principal: VerifiedClientPrincipal, session: ClientPortalSession,
  selected: EffectivePortalWorkspaceContext | null, requested: FeedbackTargetInput,
): Promise<ResolvedFeedbackTarget> {
  return resolveClientTarget(env,principal,session,selected,requested,true);
}

/** Metadata is an existing resource read, not a feedback submission. Missing
 * staff-routing metadata must never hide an otherwise authorized file preview.
 * This purpose is selected only by the metadata handler, never request input. */
export async function resolveClientFeedbackFileMetadata(
  env: Env, principal: VerifiedClientPrincipal, session: ClientPortalSession,
  selected: EffectivePortalWorkspaceContext | null, requested: Extract<FeedbackTargetInput,{kind:"file"}>,
): Promise<ResolvedFeedbackTarget> {
  return resolveClientTarget(env,principal,session,selected,requested,false);
}

async function resolveClientTarget(
  env: Env, principal: VerifiedClientPrincipal, session: ClientPortalSession,
  selected: EffectivePortalWorkspaceContext | null, requested: FeedbackTargetInput, requireStaffMapping: boolean,
): Promise<ResolvedFeedbackTarget> {
  const parsed = feedbackTargetInputSchema.safeParse(requested);
  if (!parsed.success) deny();
  const targetInput = parsed.data;
  const folder = targetInput.kind === "folder" ? await decodeProjectFolderHandle(env, targetInput.folderId) : null;
  const storageKey = targetInput.kind === "file" ? await decodeClientPortalFileHandle(env, targetInput.fileId) : null;
  if ((targetInput.kind === "folder" && !folder) || (targetInput.kind === "file" && !storageKey)) deny();
  return resolveCanonicalTarget(env,principal,session,selected,targetInput,folder,storageKey,undefined,requireStaffMapping);
}

async function resolveCanonicalTarget(
  env: FeedbackAuthorizationEnv, principal: VerifiedClientPrincipal, session: ClientPortalSession,
  selected: EffectivePortalWorkspaceContext | null, targetInput: { kind: FeedbackTargetInput["kind"]; projectId: string | null },
  folder: { associationId: string; relativePath: string } | null, storageKey: string | null, stored?: CanonicalFeedbackTarget,
  requireStaffMapping = true,
): Promise<ResolvedFeedbackTarget> {
  if (portalHierarchyV2Enabled(env) !== Boolean(selected)) deny();
  // Match repository.deliveryGrantPrefixes: legacy media is available only
  // before explicit native grants are enabled; native media requires them.
  if (targetInput.kind !== "project" && (env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true") !== Boolean(selected)) deny();
  const context: FeedbackTargetContext = { accountId: session.accountId, identityId: session.identityId,
    workspaceId: selected?.workspaceId ?? null, workspaceIdentityId: selected?.identityId ?? null,
    issuer: principal.issuer, subject: principal.subject };
  const database = env.DELIVERY_DB.withSession("first-primary");
  const values = { ...context, email: principal.email, kind: targetInput.kind, projectId: targetInput.projectId,
    associationId: stored?.associationId ?? folder?.associationId ?? null, relativePath: folder?.relativePath ?? null, storageKey, allowMissing: stored ? 1 : 0,
    bindingId: null as string | null, bindingOwnerType: null as string | null, bindingOwnerId: null as string | null,
    rootType: selected?.rootType ?? null, rootPublicId: selected?.rootPublicId ?? null, projectPublicId: null as string | null,
    authorizedPrefixes: selected && targetInput.kind !== "project"
      ? [...await listAuthorizedAuthenticatedDeliveryPrefixes(env, principal, selected.workspaceId)] : [] };
  // A project does not depend on an arbitrary folder association. For files,
  // choose the same longest authorized containing association as the browser.
  const candidates = await database.prepare(`WITH ${input} ${localSelect}
    ORDER BY length(association.r2_prefix) DESC,association.id LIMIT 2`).bind(JSON.stringify(values)).all<TargetRow>();
  const source = candidates.results[0];
  if (!source) deny();
  if (candidates.results[1] && candidates.results[1].prefix?.length === source.prefix?.length) deny();
  // The staff workflow requires an explicit PA owner and, for project-scoped
  // targets, an explicit PA project. Do not accept structurally unroutable
  // reports that the authorized staff queue could never show.
  if (requireStaffMapping && !stored && (source.account_source_id !== PRIMARY_ALPHA_SOURCE_ID ||
    (targetInput.projectId !== null && source.project_source_id !== PRIMARY_ALPHA_SOURCE_ID) || (!source.pa_client_id?.trim() && !source.pa_org_id?.trim()) ||
    (targetInput.projectId !== null && !source.pa_project_id?.trim()))) {
    throw new HTTPException(503, { res: Response.json({ code: "feedback_target_unavailable",
      error: "Feedback is not available for this item until its client and project connection is configured." }, { status: 503 }) });
  }
  values.associationId = targetInput.kind === "project" ? null : source.association_id;
  values.projectPublicId = source.pa_project_id;
  const bindingRow = selected && source.prefix && targetInput.kind !== "project"
    ? await database.prepare(`SELECT id,owner_scope_type,owner_public_id FROM portal_v2_folder_bindings
      WHERE workspace_id=? AND r2_prefix=? AND status='active' AND revoked_at IS NULL`)
      .bind(selected.workspaceId, source.prefix).first<{ id: string; owner_scope_type: string; owner_public_id: string }>() : null;
  if (selected && targetInput.kind !== "project" && !bindingRow) deny();
  if (bindingRow) { values.bindingId = bindingRow.id; values.bindingOwnerType = bindingRow.owner_scope_type; values.bindingOwnerId = bindingRow.owner_public_id; }
  const serialized = JSON.stringify(values);
  const parts = proofParts(Boolean(selected),Boolean(selected)&&await projectAccessTermsReady(database));
  parts[0]!.minRows = 1;
  parts[1]!.minRows = 1;
  if (selected) parts[2]!.minRows = 1;
  const generation = selected ? await database.prepare(`SELECT active_generation_id,source_sequence FROM portal_v2_directory_checkpoints WHERE workspace_id=?`)
    .bind(selected.workspaceId).first<{ active_generation_id: string; source_sequence: number }>() : null;
  if (selected && !generation) deny();
  const before = await capture(database, parts, serialized);
  const readEnv: FeedbackAuthorizationEnv = { ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" };
  if (selected) {
    const current = await resolveEffectivePortalWorkspaceContext(readEnv, principal, selected.workspaceId);
    if (!current || current.identityId !== context.workspaceIdentityId || current.legacyAccountId !== context.accountId || current.legacyIdentityId !== context.identityId
      || current.rootType !== selected.rootType || current.rootPublicId !== selected.rootPublicId) deny();
    const delivery = targetInput.projectId
      ? await authorizeEffectiveWorkspaceProject(readEnv, principal, current, "delivery.view", targetInput.projectId)
      : await authorizeEffectiveWorkspaceRoot(readEnv, principal, current, "delivery.view");
    const visibleProject = targetInput.kind === "project" && targetInput.projectId &&
      await authorizeEffectiveWorkspaceProject(readEnv, principal, current, "request.create", targetInput.projectId);
    if (!delivery && !visibleProject) deny();
    if (bindingRow && !(await authorizeAuthenticatedDeliveryGrant(readEnv, principal, current.workspaceId, bindingRow.id))) deny();
  }
  const after = await capture(database, parts, serialized);
  if (JSON.stringify(before) !== JSON.stringify(after)) changed();
  const currentSource = await database.prepare(`WITH ${input} ${localSelect}
    ORDER BY length(association.r2_prefix) DESC,association.id LIMIT 1`).bind(serialized).first<TargetRow>();
  if (JSON.stringify(currentSource) !== JSON.stringify(source)) changed();
  if (selected) {
    const currentGeneration = await database.prepare(`SELECT active_generation_id,source_sequence FROM portal_v2_directory_checkpoints WHERE workspace_id=?`)
      .bind(selected.workspaceId).first<{ active_generation_id: string; source_sequence: number }>();
    if (JSON.stringify(currentGeneration) !== JSON.stringify(generation)) changed();
  }
  const target: CanonicalFeedbackTarget = {
    kind: targetInput.kind, projectId: targetInput.projectId,
    associationId: targetInput.kind === "project" ? null : source.association_id,
    relativePath: folder?.relativePath ?? null, storageKey,
    label: targetInput.kind === "project" ? source.project_name ?? "Project" :
      (targetInput.kind === "file" ? storageKey : `${source.prefix}${folder?.relativePath ?? ""}`)?.split("/").filter(Boolean).at(-1) ?? "Folder",
    projectName: source.project_name?.slice(0, 160) ?? null,
    sourceOwner: {
      version: 2,
      account: { projectAlphaClientId: source.pa_client_id, projectAlphaOrganizationId: source.pa_org_id, projectAlphaSourceId: source.account_source_id },
      project: source.project_id ? { projectAlphaProjectId: source.pa_project_id, sourceUpdatedAt: source.source_updated_at, projectAlphaSourceId: source.project_source_id } : null,
      workspace: selected && generation ? { rootType: selected.rootType, rootPublicId: selected.rootPublicId, generationId: generation.active_generation_id, sourceSequence: generation.source_sequence } : null,
      association: targetInput.kind === "project" || !source.prefix ? null : { prefix: source.prefix },
      file: source.etag !== null && source.size !== null && source.uploaded_at !== null ? { etag: source.etag, size: source.size, uploadedAt: source.uploaded_at } : null,
    },
  };
  target.label = target.label.slice(0, 160);
  let available = source.target_live === 1;
  if (stored) {
    if (feedbackSourceOwnerSource(stored.sourceOwner,"account") !== source.account_source_id ||
      feedbackSourceOwnerSource(stored.sourceOwner,"project") !== (source.project_id ? source.project_source_id : null)) deny();
    const ownerKey = (value: CanonicalFeedbackTarget) => JSON.stringify([
      value.kind,value.projectId,value.associationId,value.relativePath,value.storageKey,
      value.sourceOwner.account.projectAlphaClientId,value.sourceOwner.account.projectAlphaOrganizationId,
      value.sourceOwner.project?.projectAlphaProjectId ?? null,
      value.sourceOwner.workspace?.rootType ?? null,value.sourceOwner.workspace?.rootPublicId ?? null,value.sourceOwner.association?.prefix ?? null,
    ]);
    if (ownerKey(stored) !== ownerKey(target)) deny();
    if (stored.kind === "file" && JSON.stringify(stored.sourceOwner.file) !== JSON.stringify(target.sourceOwner.file)) available = false;
  }
  return { context, target: stored ?? target, available, guard: { sql: parts.map(part => `(${part.sql}) IS ?`).join(" AND "),
    bindings: parts.flatMap((_part, index) => [serialized, after[index]!]) } };
}

/** Stored creator identity is re-resolved, never replaced by a matching email. */
export async function reauthorizeFeedbackRecipient(env: FeedbackAuthorizationEnv, record: FeedbackRecord): Promise<{
  authorization: ResolvedFeedbackTarget; email: string | null;
} | null> {
  const original = record.context;
  const readEnv: FeedbackAuthorizationEnv = { ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" };
  const database = env.DELIVERY_DB.withSession("first-primary");
  const person = original.workspaceIdentityId
    ? await database.prepare(`SELECT issuer,subject,verified_email email FROM portal_v2_identities
      WHERE id=? AND issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
      .bind(original.workspaceIdentityId,original.issuer,original.subject).first<{ issuer: string; subject: string; email: string | null }>()
    : await database.prepare(`SELECT issuer,subject,email FROM client_identity_links
      WHERE id=? AND account_id=? AND issuer=? AND subject=? AND revoked_at IS NULL`)
      .bind(original.identityId,original.accountId,original.issuer,original.subject).first<{ issuer: string; subject: string; email: string | null }>();
  if (!person) return null;
  const principal = { issuer: person.issuer, subject: person.subject, email: person.email ?? "" };
  const selected = original.workspaceId ? await resolveEffectivePortalWorkspaceContext(readEnv,principal,original.workspaceId) : null;
  if (original.workspaceId && !selected) return null;
  const local = selected ? null : await database.prepare(`SELECT a.display_name,m.role,m.can_view_billing FROM client_accounts a
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=? AND m.revoked_at IS NULL
    WHERE a.id=? AND a.status='active'`).bind(original.identityId,original.accountId)
    .first<{ display_name: string; role: "manager" | "member"; can_view_billing: number }>();
  const session: ClientPortalSession | null = selected ? {
    accountId: selected.legacyAccountId, identityId: selected.legacyIdentityId, workspaceId: selected.workspaceId,
    principalIssuer: principal.issuer, principalSubject: principal.subject, displayName: selected.displayName,
    role: selected.role, canViewBilling: selected.canViewBilling,
  } : local ? { accountId: original.accountId, identityId: original.identityId, displayName: local.display_name,
    role: local.role, canViewBilling: local.can_view_billing === 1, principalIssuer: principal.issuer, principalSubject: principal.subject } : null;
  if (!session || session.accountId !== original.accountId || session.identityId !== original.identityId ||
    (selected?.identityId ?? null) !== original.workspaceIdentityId) return null;
  try {
    const target = record.target;
    const authorization = await resolveCanonicalTarget(readEnv,principal,session,selected,target,
      target.kind === "folder" && target.associationId && target.relativePath !== null
        ? { associationId: target.associationId, relativePath: target.relativePath } : null,
      target.storageKey,target);
    const emailSql = original.workspaceIdentityId
      ? "SELECT verified_email FROM portal_v2_identities WHERE id=? AND issuer=? AND subject=? AND status='active' AND revoked_at IS NULL"
      : "SELECT email FROM client_identity_links WHERE id=? AND issuer=? AND subject=? AND revoked_at IS NULL";
    const emailBindings = [original.workspaceIdentityId ?? original.identityId,original.issuer,original.subject];
    const emailRow = await database.prepare(`SELECT (${emailSql}) email`).bind(...emailBindings).first<{email:string|null}>();
    if (!emailRow || emailRow.email !== person.email) return null;
    authorization.guard = { sql: `(${authorization.guard.sql}) AND (${emailSql}) IS ?`,
      bindings: [...authorization.guard.bindings,...emailBindings,emailRow.email] };
    if (!(await database.prepare(`SELECT 1 ok WHERE ${authorization.guard.sql}`).bind(...authorization.guard.bindings).first("ok"))) return null;
    return { authorization, email: emailRow.email };
  } catch (error) {
    if (error instanceof HTTPException && [403,404,409].includes(error.status)) return null;
    throw error;
  }
}

export async function clientFeedbackTargetActionPath(env: Env, resolved: ResolvedFeedbackTarget): Promise<string | null> {
  if (!resolved.available) return null;
  const target = await feedbackTargetInputFromCanonical(env,resolved.target);
  const query = new URLSearchParams();
  if (resolved.context.workspaceId) query.set("workspace",resolved.context.workspaceId);
  if (target.kind === "folder") query.set("folder",target.folderId);
  if (target.kind === "file") query.set("file",target.fileId);
  if (target.projectId && target.kind !== "project") query.set("tab","files");
  const path = target.projectId ? `/portal/projects/${encodeURIComponent(target.projectId)}` : "/portal/deliveries";
  return `${path}${query.size ? `?${query}` : ""}`;
}

export async function feedbackTargetInputFromCanonical(env: Env, target: CanonicalFeedbackTarget): Promise<FeedbackTargetInput> {
  if (target.kind === "project" && target.projectId) return { kind: "project", projectId: target.projectId };
  if (target.kind === "folder" && target.projectId && target.associationId && target.relativePath !== null)
    return { kind: "folder", projectId: target.projectId, folderId: await encodeProjectFolderHandle(env, target.associationId, target.relativePath) };
  if (target.kind === "file" && target.storageKey)
    return { kind: "file", projectId: target.projectId, fileId: await createClientPortalFileHandle(env, target.storageKey) };
  return deny();
}
