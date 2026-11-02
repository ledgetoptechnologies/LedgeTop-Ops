import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authorizeDeliveryFolderPrefix, decodeRef, normalizePrefix } from "./delivery";
import { requirePermission } from "./acl";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type Mode = "recent" | "search";
type RecipientType = "client" | "organization";
type RootRow = {
  record_id: string; record_kind: "client" | "organization"; current_version: number; display_name: string;
  organization_record_id: string | null; organization_name: string | null; organization_version: number | null;
  updated_at: string;
};
export type AuthorityRow = {
  root_record_id: string; target_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; ownership_epoch: number; publication_revision: number | null;
  source_sequence: number | null; snapshot_id: string | null; snapshot_sha256: string | null; operation_id: string | null;
  snapshot_verified_id: string | null; ack_token: string | null; acknowledged_claim_token: string | null; checkpoint_id: string | null;
};
type WorkspaceState = { state: "active" | "no_members" | "not_set_up"; memberCount: number | null;
  lastActivityAt: string | null; roster: unknown };

const MAX_QUERY = 120;
const MAX_RECIPIENTS = 20;
const MAX_FOLDER_MAPPINGS = 100;
const encoder = new TextEncoder();

function badRequest(): never { throw new HTTPException(400, { message: "Invalid client recipient query" }); }
function unavailable(): never { throw new HTTPException(503, { message: "Client recipient directory is temporarily unavailable" }); }
function db(database: D1Database) { return database.withSession("first-primary"); }

export function parseClientRecipientQuery(url: URL): { folderRef: string; q: string; limit: number; mode: Mode } {
  for (const key of url.searchParams.keys())
    if (!["folderRef", "q", "limit"].includes(key) || url.searchParams.getAll(key).length !== 1) badRequest();
  const folderRef = url.searchParams.get("folderRef");
  const query = url.searchParams.get("q") ?? "";
  const rawLimit = url.searchParams.get("limit") ?? String(MAX_RECIPIENTS);
  if (!folderRef || folderRef.length > 1400 || query.length > MAX_QUERY || query.trim() !== query
    || !/^(?:[1-9]|1[0-9]|20)$/.test(rawLimit)) badRequest();
  return { folderRef, q: query, limit: Number(rawLimit), mode: query ? "search" : "recent" };
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && name.length <= 160 && !/\p{C}/u.test(name) ? name : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value.replace(" ", "T").replace(/(\.\d{3})\d+Z$/, "$1Z").replace(/(?<!Z|[+-]\d\d:\d\d)$/, "Z")).toISOString();
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** The externally returned pin is a one-way opaque digest; inputs include all
 * current local record, relationship, authority, publication and roster facts. */
export async function clientRecipientVersion(material: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(material)));
  return `crv_${b64url(new Uint8Array(digest))}`;
}

export async function authorizeClientRecipientFolder(env: Env, principal: StaffPrincipal, folderRef: string): Promise<{
  prefix: string; projectFolder: boolean; divisionIds: string[];
}> {
  let decoded: string;
  try { decoded = decodeRef(folderRef); } catch (error) { throw error; }
  const prefix = normalizePrefix(decoded);
  await authorizeDeliveryFolderPrefix(env, principal, prefix);
  let listed: R2Objects;
  try { listed = await env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 1 }); }
  catch { return unavailable(); }
  if (!listed.objects.length && !listed.delimitedPrefixes.length) throw new HTTPException(404, { message: "Folder not found" });

  let mappings: Array<{ division_id: string }>;
  try {
    mappings = (await db(env.OPS_DB).prepare(`SELECT DISTINCT folder.division_id
      FROM project_folders folder JOIN pa_projects project ON project.id=folder.project_id
      WHERE project.active=1 AND project.projection_source_id LIKE 'project-alpha:%'
        AND (substr(?,1,length(rtrim(folder.r2_prefix,'/')||'/'))=rtrim(folder.r2_prefix,'/')||'/'
          OR substr(rtrim(folder.r2_prefix,'/')||'/',1,length(?))=?)
      ORDER BY folder.division_id LIMIT ?`)
      .bind(prefix, prefix, prefix, MAX_FOLDER_MAPPINGS + 1).all<{ division_id: string }>() ).results;
  } catch { return unavailable(); }
  if (mappings.length > MAX_FOLDER_MAPPINGS) return unavailable();
  const divisions = [...new Set(mappings.map(row => row.division_id))];
  if (divisions.length) {
    for (const divisionId of divisions)
      await requirePermission(env, principal, "delivery.share.create", { divisionId }, true);
  } else {
    await requirePermission(env, principal, "delivery.share.create", undefined, true);
  }
  return { prefix, projectFolder: mappings.length > 0, divisionIds: divisions };
}

async function readRoots(env: Env, q: string, limit: number): Promise<RootRow[]> {
  const rows = await db(env.OPS_DB).prepare(`SELECT record.record_id,record.record_kind,record.current_version,
      json_extract(revision.profile_json,'$.name') display_name,relation.organization_record_id,
      parent_revision.profile_json parent_profile_json,parent.current_version organization_version,record.updated_at
    FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
    LEFT JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id
    LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'
    LEFT JOIN operations_directory_revisions parent_revision ON parent_revision.record_id=parent.record_id AND parent_revision.version=parent.current_version
    LEFT JOIN operations_directory_lifecycle_state parent_lifecycle ON parent_lifecycle.record_id=parent.record_id
    WHERE record.record_kind IN ('client','organization') AND coalesce(lifecycle.status,'active')='active'
      AND (relation.organization_record_id IS NULL OR (parent.record_id IS NOT NULL AND coalesce(parent_lifecycle.status,'active')='active'))
      AND (?='' OR instr(lower(json_extract(revision.profile_json,'$.name')),lower(?))>0
        OR instr(lower(json_extract(parent_revision.profile_json,'$.name')),lower(?))>0)
    ORDER BY CASE WHEN ?='' THEN record.updated_at END DESC,lower(json_extract(revision.profile_json,'$.name')),record.record_id
    LIMIT ?`).bind(q, q, q, q, limit).all<Omit<RootRow, "organization_name"> & { parent_profile_json: string | null }>();
  return rows.results.map(row => {
    const displayName = normalizeDisplayName(row.display_name);
    let organizationName: string | null = null;
    if (row.parent_profile_json) {
      try { organizationName = normalizeDisplayName(JSON.parse(row.parent_profile_json)?.name); } catch { organizationName = null; }
      if (!organizationName) return unavailable();
    }
    if (!displayName || !Number.isSafeInteger(row.current_version) || row.current_version < 1
      || (row.organization_record_id !== null && (!Number.isSafeInteger(row.organization_version) || row.organization_version === null || row.organization_version < 1))) return unavailable();
    return { ...row, display_name: displayName, organization_name: organizationName };
  });
}

async function readAuthorityPins(env: Env, roots: readonly RootRow[]): Promise<Map<string, AuthorityRow>> {
  const rootIds = [...new Set(roots.map(row => row.organization_record_id ?? row.record_id))];
  if (!rootIds.length) return new Map();
  const result = await db(env.OPS_DB).prepare(`WITH wanted(root_record_id) AS (SELECT value FROM json_each(?))
    SELECT workspace.root_record_id,workspace.target_id,workspace.target_revision,workspace.client_authority_id,
      workspace.workspace_id,workspace.root_kind,workspace.ownership_epoch,
      publication.publication_revision,publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256,
      snapshot.snapshot_id snapshot_verified_id,
      publication.latest_operation_id operation_id,publication_receipt.acknowledged_claim_token ack_token,
      outbox.acknowledged_claim_token,current_checkpoint.checkpoint_id
    FROM wanted
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.root_record_id=wanted.root_record_id
      AND workspace.state='active' AND workspace.root_kind IN ('organization','standalone_client')
    JOIN operations_portal_workspace_reservation_heads reservation ON reservation.target_id=workspace.target_id
      AND reservation.revision=workspace.target_revision AND reservation.client_authority_id=workspace.client_authority_id
      AND reservation.workspace_id=workspace.workspace_id AND reservation.root_kind=workspace.root_kind
      AND reservation.root_record_id=workspace.root_record_id AND reservation.state='active'
    LEFT JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
      AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
      AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind
      AND publication.root_record_id=workspace.root_record_id
    LEFT JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
      AND snapshot.operation_id=publication.latest_operation_id AND snapshot.target_id=publication.target_id
      AND snapshot.revision=publication.publication_revision AND snapshot.source_sequence=publication.source_sequence
      AND snapshot.snapshot_sha256=publication.snapshot_sha256
    LEFT JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
      AND publication_receipt.target_id=publication.target_id AND publication_receipt.resulting_revision=publication.publication_revision
      AND publication_receipt.source_sequence=publication.source_sequence AND publication_receipt.snapshot_id=publication.snapshot_id
      AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
    LEFT JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=publication.latest_operation_id
      AND outbox.target_id=publication.target_id AND outbox.state='acknowledged'
      AND outbox.acknowledged_claim_token=publication_receipt.acknowledged_claim_token
    JOIN operations_portal_workspace_publication_current_checkpoints current_checkpoint
      ON current_checkpoint.checkpoint_id=publication.checkpoint_id
    WHERE workspace.root_record_id IN (SELECT root_record_id FROM wanted)
    ORDER BY workspace.root_record_id,workspace.target_id`).bind(JSON.stringify(rootIds)).all<AuthorityRow>();
  const map = new Map<string, AuthorityRow>();
  for (const row of result.results) {
    if (map.has(row.root_record_id)) throw new HTTPException(503, { message: "Client recipient authority needs review" });
    map.set(row.root_record_id, row);
  }
  return map;
}

export function isPublicationAcknowledged(row: Pick<AuthorityRow, "publication_revision" | "source_sequence" | "snapshot_id"
  | "snapshot_verified_id" | "snapshot_sha256" | "operation_id" | "ack_token" | "acknowledged_claim_token" | "checkpoint_id">): boolean {
  return row.publication_revision !== null && row.source_sequence === row.publication_revision && !!row.snapshot_id
    && row.snapshot_verified_id === row.snapshot_id && !!row.snapshot_sha256 && !!row.operation_id
    && !!row.ack_token && row.ack_token === row.acknowledged_claim_token
    && !!row.checkpoint_id;
}

async function readWorkspaceState(env: Env, authority: AuthorityRow | undefined): Promise<WorkspaceState> {
  if (!authority || !isPublicationAcknowledged(authority)) return { state: "not_set_up", memberCount: null, lastActivityAt: null, roster: null };
  let workspace: { id: string; root_type: string; status: string; active_generation_id: string | null;
    source_sequence: number | null; root_source_version: string } | null;
  try {
    workspace = await db(env.DELIVERY_DB).prepare(`SELECT workspace.id,workspace.root_type,workspace.status,
        checkpoint.active_generation_id,generation.source_sequence,root.source_version root_source_version
      FROM portal_v2_workspaces workspace
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
        AND generation.source_sequence=checkpoint.source_sequence
      JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
        AND root.entity_type=workspace.root_type AND root.active=1 AND root.parent_public_id IS NULL
        AND root.public_id=CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END
      WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL`)
      .bind(authority.workspace_id).first();
  } catch { return unavailable(); }
  if (!workspace || workspace.root_type !== authority.root_kind) return { state: "not_set_up", memberCount: null, lastActivityAt: null, roster: null };
  try {
    const members = await db(env.DELIVERY_DB).prepare(`SELECT membership.identity_id, membership.source_type,membership.source_version,
        membership.updated_at membership_updated_at,identity.updated_at identity_updated_at
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      WHERE membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR membership.expires_at>datetime('now'))
      ORDER BY membership.identity_id COLLATE BINARY LIMIT 501`).bind(authority.workspace_id)
      .all<{ identity_id: string; source_type: string; source_version: string | null; membership_updated_at: string; identity_updated_at: string }>();
    if (members.results.length > 500) return unavailable();
    const roster = { directory: { generationId: workspace.active_generation_id, sourceSequence: workspace.source_sequence,
        rootSourceVersion: workspace.root_source_version }, members: members.results.map(member => ({ identity: member.identity_id,
      source: member.source_type, version: member.source_version, membershipUpdatedAt: member.membership_updated_at,
      identityUpdatedAt: member.identity_updated_at })) };
    const lastActivityAt = members.results.reduce<string | null>((latest, member) => {
      const activity = timestamp(member.membership_updated_at) ?? timestamp(member.identity_updated_at);
      return activity && (!latest || Date.parse(activity) > Date.parse(latest)) ? activity : latest;
    }, null);
    return { state: members.results.length ? "active" : "no_members", memberCount: members.results.length, lastActivityAt, roster };
  } catch { return unavailable(); }
}

export async function listClientDeliveryRecipients(env: Env, principal: StaffPrincipal, input: { folderRef: string; q?: string; limit?: number }) {
  const q = input.q ?? "", limit = input.limit ?? MAX_RECIPIENTS;
  if (typeof q !== "string" || q.length > MAX_QUERY || q.trim() !== q || !Number.isInteger(limit) || limit < 1 || limit > MAX_RECIPIENTS) badRequest();
  const folder = await authorizeClientRecipientFolder(env, principal, input.folderRef);
  let roots: RootRow[];
  try { roots = await readRoots(env, q, limit); } catch { return unavailable(); }
  let pins: Map<string, AuthorityRow>;
  try { pins = await readAuthorityPins(env, roots); } catch (error) {
    if (error instanceof HTTPException && error.status === 503) throw error;
    return unavailable();
  }
  const recipients = [];
  for (const row of roots) {
    const rootId = row.organization_record_id ?? row.record_id;
    const authority = pins.get(rootId);
    let portalState: WorkspaceState;
    try { portalState = await readWorkspaceState(env, authority); } catch { return unavailable(); }
    const recordPin = { id: row.record_id, type: row.record_kind, version: row.current_version,
      parent: row.organization_record_id ? { id: row.organization_record_id, version: row.organization_version } : null };
    const authorityPin = authority ? { target: authority.target_id, targetRevision: authority.target_revision,
      clientAuthority: authority.client_authority_id, workspace: authority.workspace_id, rootKind: authority.root_kind,
      ownershipEpoch: authority.ownership_epoch, publication: isPublicationAcknowledged(authority) ? {
        revision: authority.publication_revision, sequence: authority.source_sequence, snapshot: authority.snapshot_id,
        digest: authority.snapshot_sha256, operation: authority.operation_id, ack: authority.ack_token, checkpoint: authority.checkpoint_id,
      } : null } : null;
    const recipientVersion = await clientRecipientVersion({ record: recordPin, authority: authorityPin, roster: portalState.roster });
    recipients.push({ recipientId: row.record_id, recipientVersion, type: row.record_kind as RecipientType,
      displayName: row.display_name, organizationName: row.organization_name,
      portal: { state: portalState.state === "active" ? "ready" : portalState.state }, memberCount: portalState.memberCount,
      lastActivityAt: portalState.lastActivityAt });
  }
  return { mode: q ? "search" as const : "recent" as const, projectFolder: folder.projectFolder, recipients };
}

/** Mount this adapter from the main worker. The file is kept separate so route
 * integration can be reviewed independently from recipient authority reads. */
export function registerClientDeliveryRecipientRoutes(app: App): void {
  const path = "/api/delivery/client-recipients";
  app.get(path, async c => {
    c.header("Cache-Control", "no-store");
    const query = parseClientRecipientQuery(new URL(c.req.url));
    return c.json(await listClientDeliveryRecipients(c.env, c.get("principal"), query));
  });
}
