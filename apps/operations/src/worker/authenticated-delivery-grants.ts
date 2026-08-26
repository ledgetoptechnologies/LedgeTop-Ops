import { HTTPException } from "hono/http-exception";
import { requirePermission } from "./acl";
import { normalizePrefix, resolveDivisionAssociation } from "./delivery";
import type { Env, StaffPrincipal } from "./types";

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SEARCH_LIMIT = 20;
const RECIPIENT_LIMIT = 200;
export type AuthenticatedGrantAudienceType = "organization" | "department" | "client" | "project" | "principal";

interface BindingContext {
  id: string;
  workspaceId: string;
  sourceVersion: string;
  ownerType: Exclude<AuthenticatedGrantAudienceType, "principal">;
  ownerPublicId: string;
  prefix: string;
  generationId: string;
  divisionId: string;
}

interface Recipient {
  principalPublicId: string;
  identityId: string;
  sourceVersion: string;
}

export interface AuthenticatedDeliveryGrantView {
  id: string;
  grantId: string;
  version: number;
  workspaceId: string;
  folderBindingId: string;
  audience: { type: AuthenticatedGrantAudienceType; publicId: string };
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  recipientCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedDeliveryGrantListItem extends AuthenticatedDeliveryGrantView {
  workspaceLabel: string;
  audienceLabel: string;
  dynamicAudience: boolean;
}

function deliveryDb(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

export function authenticatedDeliveryGrantsEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true" &&
    env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true";
}

function requireEnabled(env: Env): void {
  if (!authenticatedDeliveryGrantsEnabled(env)) throw new HTTPException(404, { message: "Not found" });
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now() + 5 * 60_000 || parsed > Date.now() + 366 * 24 * 60 * 60 * 1000)
    throw new HTTPException(400, { message: "Grant expiry must be between five minutes and one year from now" });
  return new Date(parsed).toISOString();
}

async function bindingContext(env: Env, bindingId: string): Promise<BindingContext> {
  if (!OPAQUE.test(bindingId)) throw new HTTPException(404, { message: "Folder binding not found" });
  const row = await deliveryDb(env).prepare(`SELECT binding.id,binding.workspace_id,binding.owner_scope_type,
      binding.owner_public_id,binding.r2_prefix,binding.source_version,checkpoint.active_generation_id
    FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
      AND (workspace.legacy_account_id IS NULL OR EXISTS (SELECT 1 FROM client_accounts account
        WHERE account.id=workspace.legacy_account_id AND (account.project_alpha_source_id IS NULL OR account.project_alpha_source_id='project-alpha:primary')))
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=binding.workspace_id
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner
      ON owner.workspace_id=binding.workspace_id AND owner.generation_id=checkpoint.active_generation_id
      AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id AND owner.active=1
    WHERE binding.id=? AND binding.status='active' AND binding.revoked_at IS NULL
      AND binding.source_version IS NOT NULL`).bind(bindingId).first<{
      id: string; workspace_id: string; owner_scope_type: BindingContext["ownerType"];
      owner_public_id: string; r2_prefix: string; source_version: string; active_generation_id: string;
    }>();
  if (!row) throw new HTTPException(404, { message: "Folder binding not found" });
  const prefix = normalizePrefix(row.r2_prefix);
  const candidates = await env.OPS_DB.withSession("first-primary").prepare(`SELECT project_folders.division_id,project_folders.r2_prefix
    FROM project_folders JOIN pa_projects ON pa_projects.id=project_folders.project_id AND pa_projects.active=1 AND pa_projects.projection_source_id='project-alpha:primary'
    WHERE substr(?,1,length(project_folders.r2_prefix))=project_folders.r2_prefix
    ORDER BY length(project_folders.r2_prefix) DESC LIMIT 51`).bind(prefix)
    .all<{ division_id: string; r2_prefix: string }>();
  if (candidates.results.length > 50) throw new HTTPException(409, { message: "Folder association is too broad" });
  const matching = candidates.results.filter(candidate => prefix.startsWith(normalizePrefix(candidate.r2_prefix)));
  if (!matching.length) throw new HTTPException(404, { message: "Folder binding not found" });
  const longest = Math.max(...matching.map(candidate => normalizePrefix(candidate.r2_prefix).length));
  const divisionId = resolveDivisionAssociation(prefix, matching.filter(candidate => normalizePrefix(candidate.r2_prefix).length === longest));
  if (!divisionId) throw new HTTPException(409, { message: "Folder binding association is ambiguous" });
  return { id: row.id, workspaceId: row.workspace_id, sourceVersion: row.source_version,
    ownerType: row.owner_scope_type, ownerPublicId: row.owner_public_id, prefix,
    generationId: row.active_generation_id, divisionId };
}

async function bindingIdForFolderKey(env: Env, folderKey: string): Promise<string> {
  const prefix = normalizePrefix(folderKey);
  const rows = await deliveryDb(env).prepare(`SELECT id,r2_prefix
    FROM portal_v2_folder_bindings
    WHERE status='active' AND revoked_at IS NULL AND r2_prefix IN (?,?)
    ORDER BY updated_at DESC,id LIMIT 2`).bind(prefix, prefix.slice(0, -1)).all<{ id: string; r2_prefix: string }>();
  const matches = rows.results.filter(row => normalizePrefix(row.r2_prefix) === prefix);
  if (matches.length !== 1) throw new HTTPException(404, { message: "This folder is not bound to a client workspace" });
  return matches[0]!.id;
}

function ancestrySql(): string {
  return `WITH RECURSIVE ancestry(entity_type,public_id,source_version,depth) AS (
    SELECT entity_type,public_id,source_version,0 FROM portal_v2_directory_entities
      WHERE workspace_id=? AND generation_id=? AND entity_type=? AND public_id=? AND active=1
    UNION
    SELECT parent.entity_type,parent.public_id,parent.source_version,ancestry.depth+1
      FROM ancestry JOIN portal_v2_directory_entities child
        ON child.workspace_id=? AND child.generation_id=? AND child.entity_type=ancestry.entity_type
        AND child.public_id=ancestry.public_id AND child.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=child.workspace_id AND parent.generation_id=child.generation_id
        AND parent.public_id=child.parent_public_id AND parent.active=1
      WHERE ancestry.depth<12
    UNION
    SELECT parent.entity_type,parent.public_id,parent.source_version,ancestry.depth+1
      FROM ancestry JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=? AND relation.generation_id=? AND relation.to_type=ancestry.entity_type
        AND relation.to_public_id=ancestry.public_id AND relation.active=1 AND relation.relation_type='contains'
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ancestry.depth<12
  )`;
}

function ancestryBindings(context: BindingContext): unknown[] {
  return [context.workspaceId, context.generationId, context.ownerType, context.ownerPublicId,
    context.workspaceId, context.generationId, context.workspaceId, context.generationId];
}

async function audience(env: Env, context: BindingContext, type: AuthenticatedGrantAudienceType, publicId: string): Promise<{ sourceVersion: string; displayName: string }> {
  const db = deliveryDb(env);
  if (type === "principal") {
    const row = await db.prepare(`SELECT principal.source_version,principal.display_name
      FROM pa_portal_principals principal JOIN portal_v2_identities identity
        ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      WHERE principal.workspace_id=? AND principal.public_id=? AND principal.status='active'`)
      .bind(context.workspaceId, publicId).first<{ source_version: string; display_name: string }>();
    if (!row) throw new HTTPException(404, { message: "Grant audience not found" });
    return { sourceVersion: row.source_version, displayName: row.display_name };
  }
  const row = await db.prepare(`${ancestrySql()} SELECT source_version,display_name FROM (
      SELECT ancestry.source_version,entity.display_name FROM ancestry JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=? AND entity.generation_id=? AND entity.entity_type=ancestry.entity_type
        AND entity.public_id=ancestry.public_id
      WHERE ancestry.entity_type=? AND ancestry.public_id=? LIMIT 1
    )`).bind(...ancestryBindings(context), context.workspaceId, context.generationId, type, publicId)
    .first<{ source_version: string; display_name: string }>();
  if (!row) throw new HTTPException(404, { message: "Grant audience is outside this folder workspace" });
  return { sourceVersion: row.source_version, displayName: row.display_name };
}

async function recipients(env: Env, context: BindingContext, type: AuthenticatedGrantAudienceType, publicId: string): Promise<Recipient[]> {
  // Group grants are deliberately dynamic. Current verified membership,
  // entitlement, hierarchy, source versions and denials are intersected on
  // every portal request, so newly authorized group members do not require a
  // staff rewrite and removed members cannot survive in a stale snapshot.
  // Only an exact-principal grant snapshots a principal/identity binding.
  if (type !== "principal") return [];
  const db = deliveryDb(env);
  const principals = await db.prepare(`SELECT principal.public_id,principal.identity_id,principal.source_version
    FROM pa_portal_principals principal
    JOIN portal_v2_identities identity ON identity.id=principal.identity_id
      AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspace_memberships membership
      ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    WHERE principal.workspace_id=? AND principal.status='active'
      AND principal.public_id=?
    ORDER BY principal.public_id LIMIT 201`).bind(context.workspaceId, publicId)
    .all<{ public_id: string; identity_id: string; source_version: string }>();
  if (principals.results.length > RECIPIENT_LIMIT) throw new HTTPException(409, { message: "Grant audience is too large" });
  const authorized: Recipient[] = [];
  for (const principal of principals.results) {
    const effective = await db.prepare(`${ancestrySql()} SELECT 1 ok
      WHERE EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=? AND allow_record.identity_id=?
          AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL
          AND datetime(allow_record.valid_from)<=datetime('now')
          AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
          AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?) OR
            EXISTS (SELECT 1 FROM ancestry WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
        WHERE deny_record.workspace_id=? AND deny_record.identity_id=?
          AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
          AND deny_record.status='active' AND deny_record.revoked_at IS NULL
          AND datetime(deny_record.valid_from)<=datetime('now')
          AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
          AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?) OR
            EXISTS (SELECT 1 FROM ancestry WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
      AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
        WHERE active_denial.identity_id=? AND active_denial.status='active' AND active_denial.revoked_at IS NULL
          AND datetime(active_denial.valid_from)<=datetime('now')
          AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
          AND (active_denial.scope_type='global' OR (active_denial.workspace_id=? AND
            ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?) OR
             EXISTS (SELECT 1 FROM ancestry WHERE entity_type=active_denial.scope_type AND public_id=active_denial.scope_public_id))))))`)
      .bind(...ancestryBindings(context), context.workspaceId, principal.identity_id, context.workspaceId,
        context.workspaceId, principal.identity_id, context.workspaceId,
        env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", principal.identity_id,
        context.workspaceId, context.workspaceId).first("ok");
    if (effective !== null) authorized.push({ principalPublicId: principal.public_id,
      identityId: principal.identity_id, sourceVersion: principal.source_version });
  }
  if (authorized[0]?.principalPublicId !== publicId)
    throw new HTTPException(404, { message: "Grant audience is not currently authorized for this folder" });
  if (!authorized.length) throw new HTTPException(409, { message: "Grant audience has no currently authorized verified identities" });
  return authorized;
}

export async function searchAuthenticatedDeliveryGrantAudiences(env: Env, principal: StaffPrincipal, bindingId: string, queryValue: string) {
  requireEnabled(env);
  const context = await bindingContext(env, bindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const query = queryValue.trim().toLowerCase();
  if (query.length < 2 || query.length > 100) throw new HTTPException(400, { message: "Audience search is invalid" });
  const like = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const db = deliveryDb(env);
  const [entities, principals] = await Promise.all([
    db.prepare(`${ancestrySql()} SELECT ancestry.entity_type,ancestry.public_id,entity.display_name
      FROM ancestry JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=? AND entity.generation_id=? AND entity.entity_type=ancestry.entity_type
        AND entity.public_id=ancestry.public_id
      WHERE ancestry.entity_type IN ('organization','department','client','project')
        AND lower(entity.display_name) LIKE ? ESCAPE '\\'
      ORDER BY ancestry.depth,lower(entity.display_name),ancestry.public_id LIMIT ?`)
      .bind(...ancestryBindings(context), context.workspaceId, context.generationId, like, SEARCH_LIMIT)
      .all<{ entity_type: Exclude<AuthenticatedGrantAudienceType, "principal">; public_id: string; display_name: string }>(),
    db.prepare(`${ancestrySql()} SELECT principal.public_id,principal.display_name,identity.verified_email
      FROM pa_portal_principals principal JOIN portal_v2_identities identity
        ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      WHERE principal.workspace_id=? AND principal.status='active'
        AND (lower(principal.display_name) LIKE ? ESCAPE '\\' OR lower(identity.verified_email) LIKE ? ESCAPE '\\')
        AND EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
          WHERE allow_record.workspace_id=? AND allow_record.identity_id=identity.id
            AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
            AND allow_record.status='active' AND allow_record.revoked_at IS NULL
            AND datetime(allow_record.valid_from)<=datetime('now')
            AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
            AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?) OR
              EXISTS (SELECT 1 FROM ancestry WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
        AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
          WHERE deny_record.workspace_id=? AND deny_record.identity_id=identity.id
            AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
            AND deny_record.status='active' AND deny_record.revoked_at IS NULL
            AND datetime(deny_record.valid_from)<=datetime('now')
            AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
            AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?) OR
              EXISTS (SELECT 1 FROM ancestry WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
        AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
          WHERE active_denial.identity_id=identity.id AND active_denial.status='active'
            AND active_denial.revoked_at IS NULL AND datetime(active_denial.valid_from)<=datetime('now')
            AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
            AND (active_denial.scope_type='global' OR (active_denial.workspace_id=? AND
              ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?) OR
               EXISTS (SELECT 1 FROM ancestry WHERE entity_type=active_denial.scope_type AND public_id=active_denial.scope_public_id))))))
      ORDER BY lower(principal.display_name),principal.public_id LIMIT ?`)
      .bind(...ancestryBindings(context), context.workspaceId, like, like,
        context.workspaceId, context.workspaceId, context.workspaceId, context.workspaceId,
        env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", context.workspaceId, context.workspaceId,
        SEARCH_LIMIT).all<{ public_id: string; display_name: string; verified_email: string | null }>(),
  ]);
  return { audiences: [...entities.results.map(row => ({ type: row.entity_type, publicId: row.public_id, displayName: row.display_name })),
    ...principals.results.map(row => ({ type: "principal" as const, publicId: row.public_id,
      displayName: row.display_name, email: row.verified_email }))].slice(0, SEARCH_LIMIT) };
}

export async function listAuthenticatedDeliveryGrants(
  env: Env,
  principal: StaffPrincipal,
  folderKey: string,
): Promise<{ folderBindingId: string; grants: AuthenticatedDeliveryGrantListItem[] }> {
  requireEnabled(env);
  const folderBindingId = await bindingIdForFolderKey(env, folderKey);
  const context = await bindingContext(env, folderBindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const rows = await deliveryDb(env).prepare(`SELECT grant_record.id,grant_record.logical_grant_id,
      grant_record.grant_version,grant_record.workspace_id,grant_record.folder_binding_id,
      grant_record.audience_type,grant_record.audience_public_id,
      CASE WHEN grant_record.status='active' AND grant_record.expires_at IS NOT NULL
        AND datetime(grant_record.expires_at)<=datetime('now') THEN 'expired' ELSE grant_record.status END status,
      grant_record.expires_at,grant_record.created_at,grant_record.updated_at,
      workspace.display_name workspace_label,
      COALESCE(principal.display_name,entity.display_name,'Authorized client audience') audience_label,
      COUNT(recipient.identity_id) recipient_count
    FROM portal_v2_authenticated_delivery_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
    LEFT JOIN pa_portal_principals principal
      ON grant_record.audience_type='principal' AND principal.workspace_id=grant_record.workspace_id
      AND principal.public_id=grant_record.audience_public_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=grant_record.workspace_id
    LEFT JOIN portal_v2_directory_entities entity
      ON grant_record.audience_type<>'principal' AND entity.workspace_id=grant_record.workspace_id
      AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=grant_record.audience_type AND entity.public_id=grant_record.audience_public_id
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
    WHERE grant_record.folder_binding_id=?
    GROUP BY grant_record.id
    ORDER BY grant_record.updated_at DESC,grant_record.id DESC LIMIT 101`)
    .bind(folderBindingId).all<{
      id: string; logical_grant_id: string; grant_version: number; workspace_id: string;
      folder_binding_id: string; audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: AuthenticatedDeliveryGrantView["status"]; expires_at: string | null; created_at: string;
      updated_at: string; workspace_label: string; audience_label: string; recipient_count: number;
    }>();
  if (rows.results.length > 100)
    throw new HTTPException(409, { message: "This folder has too many grant records to manage safely" });
  return { folderBindingId, grants: rows.results.map(row => ({
    id: row.id, grantId: row.logical_grant_id, version: row.grant_version,
    workspaceId: row.workspace_id, folderBindingId: row.folder_binding_id,
    audience: { type: row.audience_type, publicId: row.audience_public_id }, status: row.status,
    expiresAt: row.expires_at, recipientCount: row.recipient_count, createdAt: row.created_at,
    updatedAt: row.updated_at, workspaceLabel: row.workspace_label, audienceLabel: row.audience_label,
    dynamicAudience: row.audience_type !== "principal",
  })) };
}

async function grantView(db: D1Database, id: string): Promise<AuthenticatedDeliveryGrantView | null> {
  const row = await db.prepare(`SELECT grant_record.id,grant_record.logical_grant_id,grant_record.grant_version,
      grant_record.workspace_id,grant_record.folder_binding_id,grant_record.audience_type,
      grant_record.audience_public_id,
      CASE WHEN grant_record.status='active' AND grant_record.expires_at IS NOT NULL
        AND datetime(grant_record.expires_at)<=datetime('now') THEN 'expired'
        ELSE grant_record.status END status,
      grant_record.expires_at,
      grant_record.created_at,grant_record.updated_at,COUNT(recipient.identity_id) recipient_count
    FROM portal_v2_authenticated_delivery_grants grant_record
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
    WHERE grant_record.id=? GROUP BY grant_record.id`).bind(id).first<{
      id: string; logical_grant_id: string; grant_version: number; workspace_id: string;
      folder_binding_id: string; audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: AuthenticatedDeliveryGrantView["status"]; expires_at: string | null;
      created_at: string; updated_at: string; recipient_count: number;
    }>();
  return row ? { id: row.id, grantId: row.logical_grant_id, version: row.grant_version,
    workspaceId: row.workspace_id, folderBindingId: row.folder_binding_id,
    audience: { type: row.audience_type, publicId: row.audience_public_id }, status: row.status,
    expiresAt: row.expires_at, recipientCount: row.recipient_count, createdAt: row.created_at,
    updatedAt: row.updated_at } : null;
}

async function replay(env: Env, principal: StaffPrincipal, key: string, action: string, fingerprint: string): Promise<AuthenticatedDeliveryGrantView | null> {
  const row = await deliveryDb(env).prepare(`SELECT action,request_fingerprint,grant_id
    FROM portal_v2_authenticated_delivery_grant_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(principal.id, key).first<{ action: string; request_fingerprint: string; grant_id: string }>();
  if (!row) return null;
  if (row.action !== action || row.request_fingerprint !== fingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for a different grant request" });
  return grantView(deliveryDb(env), row.grant_id);
}

async function insertGrant(env: Env, principal: StaffPrincipal, context: BindingContext,
  input: { logicalGrantId: string; version: number; audienceType: AuthenticatedGrantAudienceType;
    audiencePublicId: string; reasonCode: string; expiresAt: string | null; action: "grant.create" | "grant.restore";
    auditAction: "grant.created" | "grant.restored"; idempotencyKey: string; fingerprint: string },
): Promise<AuthenticatedDeliveryGrantView> {
  const selected = await audience(env, context, input.audienceType, input.audiencePublicId);
  const selectedRecipients = await recipients(env, context, input.audienceType, input.audiencePublicId);
  const id = crypto.randomUUID();
  const db = deliveryDb(env);
  await db.batch([
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
      (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
       audience_type,audience_public_id,audience_source_version,reason_code,expires_at,created_by_staff_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, input.logicalGrantId, input.version, context.workspaceId,
      context.id, context.sourceVersion, input.audienceType, input.audiencePublicId, selected.sourceVersion,
      input.reasonCode, input.expiresAt, principal.id),
    ...selectedRecipients.map(recipient => db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
      (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES (?,?,?,?,?)`)
      .bind(id, context.workspaceId, recipient.principalPublicId, recipient.identityId, recipient.sourceVersion)),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,logical_grant_id,grant_version)
      VALUES (?,?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, input.action, input.fingerprint,
      id, input.logicalGrantId, input.version),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit
      (id,logical_grant_id,grant_id,grant_version,workspace_id,action,actor_staff_id,details_json)
      VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), input.logicalGrantId, id, input.version,
      context.workspaceId, input.auditAction, principal.id, JSON.stringify({ folderBindingId: context.id,
        audienceType: input.audienceType, audiencePublicId: input.audiencePublicId,
        recipientCount: selectedRecipients.length, reasonCode: input.reasonCode })),
  ]);
  return (await grantView(db, id))!;
}

export async function createAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal, input: {
  folderBindingId: string; audienceType: AuthenticatedGrantAudienceType; audiencePublicId: string;
  reasonCode: string; expiresAt?: string | null;
}, idempotencyKey: string): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireEnabled(env);
  if (!IDEMPOTENCY.test(idempotencyKey) || !OPAQUE.test(input.audiencePublicId) || !REASON.test(input.reasonCode))
    throw new HTTPException(400, { message: "Authenticated grant request is invalid" });
  const context = await bindingContext(env, input.folderBindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const expiresAt = normalizedExpiry(input.expiresAt);
  const normalized = { ...input, expiresAt };
  const fingerprint = await hash(JSON.stringify(normalized));
  const prior = await replay(env, principal, idempotencyKey, "grant.create", fingerprint);
  if (prior) return { grant: prior, replayed: true };
  const logicalGrantId = crypto.randomUUID();
  try {
    return { grant: await insertGrant(env, principal, context, { logicalGrantId, version: 1,
      audienceType: input.audienceType, audiencePublicId: input.audiencePublicId,
      reasonCode: input.reasonCode, expiresAt, action: "grant.create", auditAction: "grant.created",
      idempotencyKey, fingerprint }), replayed: false };
  } catch (error) {
    const raced = await replay(env, principal, idempotencyKey, "grant.create", fingerprint);
    if (raced) return { grant: raced, replayed: true };
    throw error;
  }
}

export async function revokeAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal,
  logicalGrantId: string, expectedVersion: number, reasonCode: string, idempotencyKey: string,
): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireEnabled(env);
  if (!OPAQUE.test(logicalGrantId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !REASON.test(reasonCode) || !IDEMPOTENCY.test(idempotencyKey))
    throw new HTTPException(400, { message: "Grant revocation request is invalid" });
  const fingerprint = await hash(JSON.stringify({ logicalGrantId, expectedVersion, reasonCode }));
  const prior = await replay(env, principal, idempotencyKey, "grant.revoke", fingerprint);
  if (prior) return { grant: prior, replayed: true };
  const db = deliveryDb(env);
  const current = await db.prepare(`SELECT id,folder_binding_id FROM portal_v2_authenticated_delivery_grants
    WHERE logical_grant_id=? AND grant_version=? AND status='active' AND revoked_at IS NULL
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`)
    .bind(logicalGrantId, expectedVersion).first<{ id: string; folder_binding_id: string }>();
  if (!current) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const context = await bindingContext(env, current.folder_binding_id);
  await requirePermission(env, principal, "delivery.share.revoke", { divisionId: context.divisionId }, true);
  const results = await db.batch([
    db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),
      revoked_by_staff_id=?,revoke_reason_code=?,updated_at=datetime('now')
      WHERE id=? AND grant_version=? AND status='active' AND revoked_at IS NULL`)
      .bind(principal.id, reasonCode, current.id, expectedVersion),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,logical_grant_id,grant_version)
      SELECT ?,?,'grant.revoke',?,?,?,? WHERE changes()=1`)
      .bind(principal.id, idempotencyKey, fingerprint, current.id, logicalGrantId, expectedVersion),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit
      (id,logical_grant_id,grant_id,grant_version,workspace_id,action,actor_staff_id,details_json)
      SELECT ?,logical_grant_id,id,grant_version,workspace_id,'grant.revoked',?,?
      FROM portal_v2_authenticated_delivery_grants grant_record
      WHERE grant_record.id=? AND grant_record.status='revoked'
        AND EXISTS (SELECT 1 FROM portal_v2_authenticated_delivery_grant_mutations mutation
          WHERE mutation.actor_staff_id=? AND mutation.idempotency_key=?
            AND mutation.action='grant.revoke' AND mutation.grant_id=grant_record.id)`)
      .bind(crypto.randomUUID(), principal.id, JSON.stringify({ reasonCode }), current.id,
        principal.id, idempotencyKey),
  ]);
  if (results[0]?.meta.changes !== 1) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  return { grant: (await grantView(db, current.id))!, replayed: false };
}

export async function restoreAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal,
  logicalGrantId: string, expectedVersion: number, reasonCode: string, expiresAtValue: string | null | undefined,
  idempotencyKey: string,
): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireEnabled(env);
  if (!OPAQUE.test(logicalGrantId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !REASON.test(reasonCode) || !IDEMPOTENCY.test(idempotencyKey))
    throw new HTTPException(400, { message: "Grant restoration request is invalid" });
  const expiresAt = normalizedExpiry(expiresAtValue);
  const fingerprint = await hash(JSON.stringify({ logicalGrantId, expectedVersion, reasonCode, expiresAt }));
  const prior = await replay(env, principal, idempotencyKey, "grant.restore", fingerprint);
  if (prior) return { grant: prior, replayed: true };
  const db = deliveryDb(env);
  const latest = await db.prepare(`SELECT id,folder_binding_id,audience_type,audience_public_id,status,
      CASE WHEN status='active' AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now') THEN 1 ELSE 0 END is_elapsed
    FROM portal_v2_authenticated_delivery_grants WHERE logical_grant_id=? AND grant_version=?
      AND (status IN ('revoked','expired') OR
        (status='active' AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now')))
      ORDER BY grant_version DESC LIMIT 1`)
    .bind(logicalGrantId, expectedVersion).first<{ id: string; folder_binding_id: string;
      audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: "active" | "revoked" | "expired"; is_elapsed: number }>();
  if (!latest) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const newer = await db.prepare("SELECT 1 ok FROM portal_v2_authenticated_delivery_grants WHERE logical_grant_id=? AND grant_version>?")
    .bind(logicalGrantId, expectedVersion).first("ok");
  if (newer !== null) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const context = await bindingContext(env, latest.folder_binding_id);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  try {
    if (latest.status === "active" && latest.is_elapsed === 1) {
      const expired = await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants
        SET status='expired',updated_at=datetime('now')
        WHERE id=? AND status='active' AND expires_at IS NOT NULL
          AND datetime(expires_at)<=datetime('now')`).bind(latest.id).run();
      if (expired.meta.changes !== 1)
        throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
    }
    return { grant: await insertGrant(env, principal, context, { logicalGrantId,
      version: expectedVersion + 1, audienceType: latest.audience_type,
      audiencePublicId: latest.audience_public_id, reasonCode, expiresAt,
      action: "grant.restore", auditAction: "grant.restored", idempotencyKey, fingerprint }), replayed: false };
  } catch (error) {
    const raced = await replay(env, principal, idempotencyKey, "grant.restore", fingerprint);
    if (raced) return { grant: raced, replayed: true };
    throw error;
  }
}
