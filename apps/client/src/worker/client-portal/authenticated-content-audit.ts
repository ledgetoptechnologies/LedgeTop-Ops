import { d1TablesPresent } from "../schema-readiness";
import { hmac, sha256 } from "../security";
import type { Env } from "../types";
import { authenticatedDeliveryChangeAuthoritySql } from "@ltds/shared/authenticated-delivery-authority";

const TABLES = [
  "portal_authenticated_content_history_state",
  "portal_authenticated_content_events",
  "portal_authenticated_content_retention_control",
] as const;
const SCHEMA_OBJECTS = [
  "idx_portal_authenticated_content_legacy_timeline",
  "idx_portal_authenticated_content_native_timeline",
  "portal_authenticated_content_events_immutable_update",
  "portal_authenticated_content_events_retention_delete_guard",
  "portal_authenticated_content_history_state_immutable_delete",
  "portal_authenticated_content_history_state_immutable_update",
] as const;
const WINDOW_MS = 10 * 60 * 1000;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type AuditEnv = Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_CONTENT_AUDIT_ENABLED" | "CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET">
  & Partial<Pick<Env,"CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED"|"CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED">>;
type ContentAction = "file.preview_requested" | "file.download_requested";

interface CommonContentStart {
  identityId: string;
  action: ContentAction;
  storageKey: string;
  contentVersion: string;
}

export interface LegacyContentStart extends CommonContentStart {
  authorityMode: "legacy_delivery";
  sourceId: string;
  workspaceId?: string | null;
  accountId: string;
  projectId?: string | null;
  associationId: string;
}

export interface NativeContentStart extends CommonContentStart {
  authorityMode: "native_delivery";
  sourceId: string;
  workspaceId: string;
  projectPublicId?: string | null;
  folderBindingId: string;
  grantId: string;
  grantVersion: number;
  grantSource: "staff" | "project_alpha_delivery";
  bindingSourceVersion: string;
  ownerScopeType: "organization" | "department" | "client" | "project";
  ownerPublicId: string;
}

/** The existing native_delivery ledger stores workspace/global-identity/grant
 * coordinates, including v2 grants accessed from a legacy-compatible shell.
 * No legacy account/association is fabricated for this exact-grant path. */
export interface AuthenticatedDeliveryContentStart extends Omit<NativeContentStart,"grantSource"> {
  grantSource: "authenticated_delivery";
  recipientEventId: string;
  batchId: string;
}

export type AuthenticatedContentStart = LegacyContentStart | NativeContentStart | AuthenticatedDeliveryContentStart;

export class AuthenticatedContentAuditUnavailableError extends Error {
  readonly code = "AUTHENTICATED_CONTENT_AUDIT_UNAVAILABLE";

  constructor(readonly reason: "disabled" | "schema_missing" | "schema_incomplete" | "state_invalid" | "configuration_invalid") {
    super(`Authenticated content audit is unavailable: ${reason}`);
    this.name = "AuthenticatedContentAuditUnavailableError";
  }
}

export interface AuthenticatedContentAuditReadiness {
  ready: boolean;
  reason?: AuthenticatedContentAuditUnavailableError["reason"];
  collectionStartedAt?: string;
}

/**
 * Before the immutable collection boundary exists, the default-off producer
 * is a transparent no-op. After first activation, disabling the flag cannot
 * silently create a history gap: body-bearing content requests fail closed
 * until the producer is ready again.
 */
export async function authenticatedContentAuditRequired(env: AuditEnv): Promise<boolean> {
  if (env.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED === "true") return true;
  if (!await d1TablesPresent(env.DELIVERY_DB, [TABLES[0]])) return false;
  const state = await env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT schema_version schemaVersion,collection_started_at collectionStartedAt FROM portal_authenticated_content_history_state WHERE singleton=1",
  ).first<{ schemaVersion: number; collectionStartedAt: string | null }>();
  if (state?.schemaVersion !== 1) throw new AuthenticatedContentAuditUnavailableError("state_invalid");
  if (state.collectionStartedAt === null) return false;
  if (!CANONICAL_TIME.test(state.collectionStartedAt))
    throw new AuthenticatedContentAuditUnavailableError("state_invalid");
  throw new AuthenticatedContentAuditUnavailableError("disabled");
}

interface AuthorityFence {
  sql: string;
  bindings: Array<string | number | null>;
  ctes?: string;
  cteBindings?: Array<string | number | null>;
  tables?: string[];
}

function authorityFence(input: AuthenticatedContentStart,env:AuditEnv): AuthorityFence {
  if (input.authorityMode === "legacy_delivery") {
    const projectId = bounded(input.projectId, "projectId");
    return {
      sql: `EXISTS(SELECT 1 FROM client_folder_associations association
        JOIN client_accounts account ON account.id=? AND account.status='active'
        JOIN client_identity_links identity ON identity.id=? AND identity.account_id=account.id AND identity.revoked_at IS NULL
        JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id AND member.revoked_at IS NULL
        JOIN file_index file ON file.r2_key=? AND file.etag=?
          AND substr(file.r2_key,1,length(association.r2_prefix))=association.r2_prefix
        WHERE association.id=? AND association.account_id=account.id AND association.revoked_at IS NULL
          AND COALESCE(account.project_alpha_source_id,'delivery:local')=?
          AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL AND
            (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix'
              AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)))
          AND ((? IS NULL AND association.scope_type='client' AND association.project_id IS NULL)
            OR (? IS NOT NULL AND association.scope_type='project' AND association.project_id=?
              AND EXISTS(SELECT 1 FROM projects project JOIN client_project_grants project_grant
                ON project_grant.project_id=project.id AND project_grant.account_id=account.id AND project_grant.revoked_at IS NULL
                WHERE project.id=? AND project.active=1 AND (member.role='manager' OR EXISTS(
                  SELECT 1 FROM client_member_project_grants member_grant WHERE member_grant.account_id=account.id
                    AND member_grant.identity_id=identity.id AND member_grant.project_id=project.id
                    AND member_grant.revoked_at IS NULL))))))`,
      bindings: [input.accountId, input.identityId, input.storageKey, input.contentVersion,
        input.associationId, input.sourceId, projectId, projectId, projectId, projectId],
    };
  }
  if(input.grantSource==="authenticated_delivery")return {
    // Keep the complete current-authority query at statement level. Nesting
    // its recursive guards inside EXISTS exceeds D1's expression-depth limit.
    // Materialization is still within each INSERT/SELECT, not a pre-read proof.
    ctes:`current_batch_authority AS MATERIALIZED(
      ${authenticatedDeliveryChangeAuthoritySql(env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true',env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED==='true',true)}),
      current_content_event_authority AS MATERIALIZED(SELECT 1 ok FROM authenticated_delivery_recipient_events event
      JOIN file_index file ON file.r2_key=? AND file.etag=? AND substr(file.r2_key,1,length(event.r2_prefix))=event.r2_prefix
      WHERE event.id=? AND event.batch_id=? AND event.source_id=? AND event.workspace_id=? AND event.identity_id=?
        AND event.folder_binding_id=? AND event.binding_source_version=? AND event.grant_id=? AND event.grant_version=?
        AND event.owner_scope_type=? AND event.owner_public_id=?
        AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL AND
          (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix'
            AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key))))`,
    cteBindings:[input.batchId,input.storageKey,input.contentVersion,input.recipientEventId,input.batchId,input.sourceId,input.workspaceId,input.identityId,
      input.folderBindingId,input.bindingSourceVersion,input.grantId,input.grantVersion,input.ownerScopeType,input.ownerPublicId],
    tables:["current_batch_authority","current_content_event_authority"],
    sql:"1=1",
    bindings:[],
  };
  const grantTable = input.grantSource === "staff"
    ? "portal_v2_authenticated_delivery_grants"
    : "project_alpha_delivery_portal_grants";
  const publication = input.grantSource === "staff"
    ? `AND EXISTS(SELECT 1 FROM portal_native_staff_grants publication
        WHERE publication.source_id=workspace.project_alpha_source_id AND publication.binding_id=binding.id
          AND publication.grant_id=grant_record.id AND publication.state='active')`
    : `AND EXISTS(SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
        WHERE receipt.receipt_id=grant_record.receipt_id AND receipt.project_alpha_source_id=workspace.project_alpha_source_id
          AND receipt.access_mode='portal' AND receipt.resource_id=grant_record.id AND receipt.status='accepted')`;
  return {
    sql: `EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
      JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
        AND source.projection_source_id=workspace.project_alpha_source_id
      JOIN portal_v2_identities identity ON identity.id=? AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
        AND membership.identity_id=identity.id AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN portal_v2_folder_bindings binding ON binding.workspace_id=workspace.id AND binding.id=?
        AND binding.status='active' AND binding.revoked_at IS NULL AND binding.source_version=?
        AND binding.owner_scope_type=? AND binding.owner_public_id=?
      JOIN ${grantTable} grant_record ON grant_record.workspace_id=workspace.id AND grant_record.id=?
        AND grant_record.folder_binding_id=binding.id AND grant_record.grant_version=?
        AND grant_record.binding_source_version=binding.source_version AND grant_record.status='active'
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
      JOIN file_index file ON file.r2_key=? AND file.etag=?
        AND substr(file.r2_key,1,length(binding.r2_prefix))=binding.r2_prefix
      WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL
        AND workspace.status='active' ${publication}
        AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL AND
          (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix'
            AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key))))`,
    bindings: [input.identityId, input.folderBindingId, input.bindingSourceVersion, input.ownerScopeType,
      input.ownerPublicId, input.grantId, input.grantVersion, input.storageKey, input.contentVersion,
      input.workspaceId, input.sourceId],
  };
}

function bounded(value: string | null | undefined, name: string): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 180) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function labelFromStorageKey(storageKey: string): string {
  const segments = storageKey.replace(/\\/g, "/").split("/").filter(Boolean);
  const label = (segments.at(-1) || "content")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 180);
  return label || "content";
}

export async function authenticatedContentAuditReadiness(env: AuditEnv): Promise<AuthenticatedContentAuditReadiness> {
  if (env.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED !== "true") return { ready: false, reason: "disabled" };
  if (!env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET || env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET.length < 32)
    return { ready: false, reason: "configuration_invalid" };
  const available = await d1TablesPresent(env.DELIVERY_DB, TABLES);
  if (!available) {
    const stateOnly = await d1TablesPresent(env.DELIVERY_DB, [TABLES[0]]);
    const eventsOnly = await d1TablesPresent(env.DELIVERY_DB, [TABLES[1]]);
    return { ready: false, reason: stateOnly || eventsOnly ? "schema_incomplete" : "schema_missing" };
  }
  const database = env.DELIVERY_DB.withSession("first-primary");
  try {
    const objects = (await database.prepare(
      `SELECT name FROM sqlite_master WHERE name IN (${SCHEMA_OBJECTS.map(() => "?").join(",")}) ORDER BY name`,
    ).bind(...SCHEMA_OBJECTS).all<{ name: string }>()).results.map(row => row.name);
    if (JSON.stringify(objects) !== JSON.stringify([...SCHEMA_OBJECTS].sort()))
      return { ready: false, reason: "schema_incomplete" };
    const activation = new Date().toISOString();
    await database.prepare(`UPDATE portal_authenticated_content_history_state SET collection_started_at=?
      WHERE singleton=1 AND schema_version=1 AND collection_started_at IS NULL`).bind(activation).run();
    const state = await database.prepare(
      "SELECT schema_version schemaVersion,collection_started_at collectionStartedAt FROM portal_authenticated_content_history_state WHERE singleton=1",
    ).first<{ schemaVersion: number; collectionStartedAt: string | null }>();
    if (state?.schemaVersion !== 1 || !state.collectionStartedAt || !CANONICAL_TIME.test(state.collectionStartedAt))
      return { ready: false, reason: "state_invalid" };
    return { ready: true, collectionStartedAt: state.collectionStartedAt };
  } catch {
    return { ready: false, reason: "schema_incomplete" };
  }
}

export async function appendAuthenticatedContentStart(
  env: AuditEnv,
  input: AuthenticatedContentStart,
  now = new Date(),
): Promise<{ id: string; occurredAt: string; replayed: boolean }> {
  const readiness = await authenticatedContentAuditReadiness(env);
  if (!readiness.ready) throw new AuthenticatedContentAuditUnavailableError(readiness.reason!);
  if (!Number.isFinite(now.getTime())) throw new TypeError("Audit time is invalid");

  const collectionStart = Date.parse(readiness.collectionStartedAt!);
  if (!Number.isFinite(collectionStart)) throw new AuthenticatedContentAuditUnavailableError("state_invalid");
  const occurredAtDate = new Date(Math.max(now.getTime(), collectionStart));
  const occurredAt = occurredAtDate.toISOString();
  const dedupeWindow = Math.floor(occurredAtDate.getTime() / WINDOW_MS);
  const sourceId = bounded(input.sourceId, "sourceId")!;
  const identityId = bounded(input.identityId, "identityId")!;
  const auditSecret = env.CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET!;
  const resourceFingerprint = await hmac(auditSecret, `client-content-audit:resource:v1:${input.storageKey}`);
  const contentVersionFingerprint = await hmac(auditSecret,
    `client-content-audit:version:v1:${resourceFingerprint}:${input.contentVersion}`);
  const coordinates = input.authorityMode === "legacy_delivery"
    ? [sourceId, bounded(input.workspaceId, "workspaceId"), bounded(input.accountId, "accountId"),
      bounded(input.projectId, "projectId"), bounded(input.associationId, "associationId")]
    : [sourceId, bounded(input.workspaceId, "workspaceId"), bounded(input.projectPublicId, "projectPublicId"),
      bounded(input.folderBindingId, "folderBindingId"), bounded(input.grantId, "grantId")];
  const dedupeKey = await sha256(JSON.stringify([
    "client-content-start:v1", input.authorityMode, ...coordinates, identityId, input.action,
    resourceFingerprint, contentVersionFingerprint, dedupeWindow,
  ]));
  const id = `authenticated-content-${dedupeKey}`;
  const resourceLabel = labelFromStorageKey(input.storageKey);

  const legacy = input.authorityMode === "legacy_delivery" ? input : null;
  const native = input.authorityMode === "native_delivery" ? input : null;
  const authority = authorityFence(input,env);
  const prefix = authority.ctes ? `WITH ${authority.ctes} ` : "";
  const prefixBindings = authority.cteBindings ?? [];
  const insertFrom = authority.tables?.length ? ` FROM ${authority.tables.join(" CROSS JOIN ")}` : "";
  const selectJoins = (authority.tables ?? []).map(table => ` CROSS JOIN ${table}`).join("");
  // Keep the conditional insert and replay read in one transaction and on one
  // first-primary session. Both statements repeat the current authority fence:
  // an existing dedupe row cannot turn a newly revoked request into success.
  const database = env.DELIVERY_DB.withSession("first-primary");
  const insert = database.prepare(`${prefix}INSERT OR IGNORE INTO portal_authenticated_content_events(
    id,dedupe_key,dedupe_window,authority_mode,source_id,workspace_id,account_id,identity_id,project_id,
    project_public_id,association_id,folder_binding_id,grant_id,action,resource_fingerprint,
    content_version_fingerprint,resource_label,occurred_at
  ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${insertFrom} WHERE ${authority.sql}`).bind(
    ...prefixBindings, id, dedupeKey, dedupeWindow, input.authorityMode, sourceId,
    bounded(input.workspaceId, "workspaceId"), legacy ? bounded(legacy.accountId, "accountId") : null,
    identityId, legacy ? bounded(legacy.projectId, "projectId") : null,
    native ? bounded(native.projectPublicId, "projectPublicId") : null,
    legacy ? bounded(legacy.associationId, "associationId") : null,
    native ? bounded(native.folderBindingId, "folderBindingId") : null,
    native ? bounded(native.grantId, "grantId") : null,
    input.action, resourceFingerprint, contentVersionFingerprint, resourceLabel, occurredAt, ...authority.bindings,
  );
  const select = database.prepare(
    `${prefix}SELECT id,occurred_at occurredAt FROM portal_authenticated_content_events${selectJoins} WHERE dedupe_key=? AND ${authority.sql}`,
  ).bind(...prefixBindings, dedupeKey, ...authority.bindings);
  const [result, selected] = await database.batch([insert, select]);
  if (!result || !selected) throw new AuthenticatedContentAuditUnavailableError("state_invalid");
  const stored = (selected.results as Array<{ id: string; occurredAt: string }>)[0];
  if (!stored) throw new AuthenticatedContentAuditUnavailableError("state_invalid");
  return { ...stored, replayed: Number(result.meta.changes || 0) === 0 };
}
