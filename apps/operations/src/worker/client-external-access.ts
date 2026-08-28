import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { sha256 } from "./crypto";
import type { Env } from "./types";

export const EXTERNAL_ACCESS_STATUSES = ["current", "all", "active", "unassigned", "pending", "suspended", "blocked", "expired", "revoked"] as const;
export type ExternalAccessStatusFilter = (typeof EXTERNAL_ACCESS_STATUSES)[number];

export interface ExternalAccessRow {
  row_key: string;
  kind: "membership" | "invitation";
  display_name: string;
  email_hint: string;
  access_status: "active" | "unassigned" | "pending" | "suspended" | "blocked" | "expired" | "revoked" | "needs_review";
  source_type: "project_alpha" | "operations" | "client_invitation" | "legacy";
  expires_at: string | null;
  revoked_at: string | null;
  assigned_access_count: number;
  created_at: string;
}

export interface ExternalAccessPage {
  available: boolean;
  reason: "workspace_unavailable" | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}

export interface ExternalAccessResult {
  items: ExternalAccessRow[];
  page: ExternalAccessPage;
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"];
  contextVersion: string;
  refreshedAt: string;
}

export interface ExternalAccessQuery {
  q?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

interface Cursor {
  v: 1;
  context: string;
  selection: string;
  after: [string, string, string];
}

interface AccessRecord extends Record<string, unknown> {
  kind: "membership" | "invitation";
  id: string;
  display_name: string;
  email_hint: string;
  access_status: ExternalAccessRow["access_status"];
  source_type: ExternalAccessRow["source_type"];
  expires_at: string | null;
  revoked_at: string | null;
  assigned_access_count: number;
  created_at: string;
}

function invalid(message = "External access query is invalid"): never {
  throw new HTTPException(400, { message });
}

function encode(cursor: Cursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0))));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (cursor.v !== 1 || typeof cursor.context !== "string" || typeof cursor.selection !== "string"
      || !Array.isArray(cursor.after) || cursor.after.length !== 3
      || !cursor.after.every(item => typeof item === "string" && item.length <= 512)) throw new Error();
    return cursor as Cursor;
  } catch {
    invalid("External access cursor is invalid");
  }
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid("External access page limit must be between 1 and 100");
  return limit;
}

export function externalAccessQuery(parameters: URLSearchParams): ExternalAccessQuery {
  const limit = parameters.get("limit");
  return {
    q: parameters.get("q") ?? undefined,
    status: parameters.get("status") ?? undefined,
    cursor: parameters.get("cursor") ?? undefined,
    limit: limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : Number.NaN,
  };
}

const activeEmailBlock = `block.status='active' AND datetime(block.valid_from)<=datetime('now')
  AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))`;

/**
 * A source-qualified, read-only people roster. It intentionally does not start
 * from Project Alpha principals: Operations/legacy memberships and invitations
 * without a linked identity must remain visible to staff. Email is presentation
 * metadata only and is never used to merge records or authorize access.
 */
export async function listClientExternalAccess(env: Pick<Env, "DELIVERY_DB">, context: ClientHubCollectionContext,
  options: ExternalAccessQuery = {}): Promise<ExternalAccessResult> {
  const limit = pageLimit(options.limit);
  const q = (options.q ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
  if ((options.q?.length ?? 0) > 200 || /[\0-\x1f\x7f]/.test(options.q ?? "")) invalid();
  const status = options.status ?? "current";
  if (!(EXTERNAL_ACCESS_STATUSES as readonly string[]).includes(status)) invalid("External access status is invalid");
  const page: ExternalAccessPage = { available: Boolean(context.root.workspace_id), reason: context.root.workspace_id ? null : "workspace_unavailable",
    nextCursor: null, hasMore: false, returned: 0, limit };
  const response: ExternalAccessResult = { items: [], page, canonicalRoot: context.canonicalRoot,
    contextVersion: context.contextVersion, refreshedAt: new Date().toISOString() };
  if (!page.available) return response;

  const selection = await sha256(JSON.stringify([context.canonicalRoot, context.root.workspace_id, context.contextVersion, q, status]));
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.context !== context.contextVersion || cursor.selection !== selection))
    throw new HTTPException(409, { message: "Client mapping, permissions, or external access filters changed. Refresh the client workspace" });

  const predicates: string[] = [];
  const values: unknown[] = [context.root.workspace_id, context.root.workspace_id];
  if (q) {
    predicates.push("(instr(lower(display_name),?)>0 OR instr(lower(email_hint),?)>0)");
    values.push(q, q);
  }
  if (status === "current") predicates.push("access_status IN ('active','unassigned','pending')");
  else if (status !== "all") predicates.push("access_status=?");
  if (status !== "current" && status !== "all") values.push(status);
  if (cursor) {
    predicates.push("(created_at,kind,id)<(?,?,?)");
    values.push(...cursor.after);
  }

  const result = await env.DELIVERY_DB.withSession("first-primary").prepare(`WITH membership_rows AS (
    SELECT 'membership' kind,membership.id,
      CASE WHEN (SELECT count(*) FROM pa_portal_principals principal
        WHERE principal.workspace_id=membership.workspace_id AND principal.identity_id=membership.identity_id)=1
        THEN (SELECT principal.display_name FROM pa_portal_principals principal
          WHERE principal.workspace_id=membership.workspace_id AND principal.identity_id=membership.identity_id LIMIT 1)
        ELSE COALESCE(NULLIF(trim(identity.verified_email),''),'Portal member') END display_name,
      lower(trim(identity.verified_email)) email_hint,membership.source_type,membership.expires_at,membership.revoked_at,membership.created_at,
      (SELECT count(*) FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=membership.workspace_id
        AND entitlement.identity_id=membership.identity_id AND entitlement.effect='allow' AND entitlement.status='active'
        AND entitlement.revoked_at IS NULL AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))) assigned_access_count,
      CASE WHEN EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE ${activeEmailBlock} AND (
          (block.match_type='email' AND lower(trim(block.normalized_email))=lower(trim(identity.verified_email)))
          OR (block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject))) THEN 1 ELSE 0 END blocked,
      membership.status stored_status,identity.status identity_status,identity.revoked_at identity_revoked_at,workspace.status workspace_status,
      CASE WHEN membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals current_principal
        WHERE current_principal.workspace_id=membership.workspace_id AND current_principal.identity_id=membership.identity_id
          AND current_principal.status='active' AND current_principal.source_version=membership.source_version) THEN 1 ELSE 0 END source_current,
      CASE WHEN membership.source_type='project_alpha' AND EXISTS(SELECT 1 FROM pa_portal_principals current_principal
        WHERE current_principal.workspace_id=membership.workspace_id AND current_principal.identity_id=membership.identity_id
          AND current_principal.source_version=membership.source_version AND current_principal.status='suspended') THEN 1 ELSE 0 END source_suspended,
      CASE WHEN membership.source_type='project_alpha' AND EXISTS(SELECT 1 FROM pa_portal_principals current_principal
        WHERE current_principal.workspace_id=membership.workspace_id AND current_principal.identity_id=membership.identity_id
          AND current_principal.source_version=membership.source_version AND current_principal.status='revoked') THEN 1 ELSE 0 END source_revoked
    FROM portal_v2_workspace_memberships membership
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
    JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id
    WHERE membership.workspace_id=?
  ), invitation_rows AS (
    SELECT 'invitation' kind,invitation.id,invitation.invited_email display_name,lower(trim(invitation.invited_email)) email_hint,
      'client_invitation' source_type,invitation.expires_at,invitation.revoked_at,invitation.created_at,
      (SELECT count(*) FROM portal_v2_invitation_entitlements entitlement WHERE entitlement.invitation_id=invitation.id) assigned_access_count,
      CASE WHEN EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE ${activeEmailBlock}
        AND block.match_type='email' AND lower(trim(block.normalized_email))=lower(trim(invitation.invited_email))) THEN 1 ELSE 0 END blocked,
      invitation.status stored_status,NULL identity_status,NULL identity_revoked_at,workspace.status workspace_status,
      1 source_current,0 source_suspended,0 source_revoked
    FROM portal_v2_invitations invitation JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
    WHERE invitation.workspace_id=? AND (invitation.status<>'accepted' OR NOT EXISTS(
      SELECT 1 FROM portal_v2_workspace_memberships membership
      WHERE membership.workspace_id=invitation.workspace_id AND membership.identity_id=invitation.accepted_by_identity_id))
  ), combined AS (
    SELECT * FROM membership_rows UNION ALL SELECT * FROM invitation_rows
  ), effective AS (
    SELECT *,CASE
      WHEN revoked_at IS NOT NULL OR identity_revoked_at IS NOT NULL OR stored_status='revoked' OR identity_status='revoked' OR source_revoked=1 THEN 'revoked'
      WHEN stored_status='suspended' OR identity_status='suspended' OR workspace_status='suspended' OR source_suspended=1 THEN 'suspended'
      WHEN expires_at IS NOT NULL AND datetime(expires_at) IS NULL THEN 'needs_review'
      WHEN expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now') THEN 'expired'
      WHEN kind='invitation' AND stored_status='expired' THEN 'expired'
      WHEN kind='invitation' AND stored_status='pending' AND blocked=1 THEN 'blocked'
      WHEN kind='invitation' AND stored_status='pending' THEN 'pending'
      WHEN kind='invitation' THEN 'needs_review'
      WHEN blocked=1 THEN 'blocked'
      WHEN source_current=0 THEN 'needs_review'
      WHEN stored_status='active' AND identity_status='active' AND workspace_status='active' AND assigned_access_count=0 THEN 'unassigned'
      WHEN stored_status='active' AND identity_status='active' AND workspace_status='active' THEN 'active'
      ELSE 'needs_review' END access_status
    FROM combined
  ) SELECT kind,id,display_name,email_hint,access_status,source_type,expires_at,revoked_at,assigned_access_count,created_at
    FROM effective ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
    ORDER BY created_at DESC,kind DESC,id DESC LIMIT ?`)
    .bind(...values, limit + 1).all<AccessRecord>();
  const rows = result.results.slice(0, limit);
  response.items = rows.map(row => ({ row_key: JSON.stringify([row.kind, row.id]), kind: row.kind,
    display_name: row.display_name, email_hint: row.email_hint, access_status: row.access_status,
    source_type: row.source_type, expires_at: row.expires_at, revoked_at: row.revoked_at,
    assigned_access_count: Number(row.assigned_access_count), created_at: row.created_at }));
  page.returned = rows.length;
  page.hasMore = result.results.length > limit;
  if (page.hasMore) {
    const last = rows[rows.length - 1]!;
    page.nextCursor = encode({ v: 1, context: context.contextVersion, selection, after: [last.created_at, last.kind, last.id] });
  }
  return response;
}
