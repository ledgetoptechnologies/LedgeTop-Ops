import { HTTPException } from "hono/http-exception";
import { isAdministrator, sqlScope } from "./acl";
import { eligibilityBlockManagementEnabled, portalOperationsManagementEnabled } from "./client-identity-eligibility";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

export type PortalIdentityScope = { kind: "client"; context: ClientHubCollectionContext } | { kind: "global" };
export type PortalIdentityCollection = "access" | "invitations" | "eligibility-blocks";
export interface PortalIdentityPageMetadata {
  available: boolean;
  reason: "workspace_unavailable" | "identity_unlinked" | "identity_conflict" | null;
  nextCursor: string | null; hasMore: boolean; returned: number; limit: number;
}
export interface PortalIdentityCapabilities {
  canManagePortal: boolean;
  canManageEligibilityBlocks: boolean;
  canReviewIdentityDetails: boolean;
}
export interface PortalIdentitySummary {
  workspace_id: string; public_id: string; workspace_name: string; display_name: string; email_hint: string;
  status: string; identity_id: string | null; binding_status: "linked" | "unlinked" | "conflict";
  contact_key: string; row_key: string; principalContextVersion: string;
  has_workspace_access: number; blocked: number; hasExplicitAccess: boolean; accessLoaded: false;
  effectiveEmailBlockCount: number; effectiveSubjectBlock: boolean; removableEmailBlockId: string | null;
  invitation: null | { id: string; status: string; expires_at: string; email_status: string | null;
    attempts: number | null; last_error_code: string | null };
  actions: { canRetryInvitation: boolean; canCreateEmailBlock: boolean; canReviewEligibilityBlocks: boolean };
}
export interface PortalIdentityPage {
  items: PortalIdentitySummary[]; page: PortalIdentityPageMetadata; contextVersion: string;
  refreshedAt: string; capabilities: PortalIdentityCapabilities;
}
export interface PortalIdentityCollectionPage {
  items: Array<Record<string, unknown>>; page: PortalIdentityPageMetadata; contextVersion: string;
  principalContextVersion: string; refreshedAt: string;
}
export interface PortalIdentityQuery {
  q?: string; link?: string; blocked?: string; principalStatus?: string;
  cursor?: string; limit?: number;
}
export function portalIdentityQuery(parameters: URLSearchParams): PortalIdentityQuery {
  const limit = parameters.get("limit");
  return { q: parameters.get("q") ?? undefined, link: parameters.get("link") ?? undefined,
    blocked: parameters.get("blocked") ?? undefined, principalStatus: parameters.get("principalStatus") ?? undefined,
    cursor: parameters.get("cursor") ?? undefined,
    limit: limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : Number.NaN };
}
export function isPortalIdentityCollection(value: string): value is PortalIdentityCollection {
  return value === "access" || value === "invitations" || value === "eligibility-blocks";
}
interface Policy { contextVersion: string; hash: string; capabilities: PortalIdentityCapabilities }
interface PrincipalKey { workspaceId: string; publicId: string }
interface Fact extends Record<string, unknown> {
  workspace_id: string; public_id: string; display_name: string; email_hint: string; status: string;
  workspace_name: string; identity_id: string | null; candidate_count: number; membership_active: number;
  blocked: number; email_block_count: number; subject_block: number; email_block_id: string | null;
  has_rules: number; invitation_id: string | null; invitation_status: string | null; invitation_expires_at: string | null;
  email_status: string | null; attempts: number | null; last_error_code: string | null; invitation_retryable: number;
}
interface Cursor { v: 1; policy: string; selection: string; collection: string; after: string[]; principal?: string }

const normalized = (expression: string) => `lower(trim(${expression}))`;
const activeBlock = "block.status='active' AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))";
// Explicit principal identity bindings are used by project-alpha-portal.ts to
// materialize rules only when verified email still matches. If an explicit ID
// exists, never substitute another identity based on old eligibility receipts.
// Without an explicit ID, eligiblePortalShell requires a current source version
// and the exact verified email chain. More than one distinct candidate is a
// conflict, not a reason to choose whichever historical binding sorts first.
const candidates = `SELECT identity.id FROM portal_v2_identities identity WHERE identity.id IN (
  SELECT pa.identity_id WHERE pa.identity_id IS NOT NULL
  UNION SELECT eligibility.identity_id FROM portal_v2_identity_eligibility_bindings eligibility
    WHERE pa.identity_id IS NULL AND eligibility.workspace_id=pa.workspace_id
      AND eligibility.principal_public_id=pa.public_id AND eligibility.principal_source_version=pa.source_version
      AND ${normalized("eligibility.verified_email")}=${normalized("pa.email_hint")}
  ) AND ${normalized("identity.verified_email")}=${normalized("pa.email_hint")} LIMIT 2`;

// All joins following the key relation are single-row joins or scalar EXISTS /
// bounded candidate lookups. Entitlements and historical bindings never fan a
// principal out into multiple rows before pagination.
function factsCte(principalPredicate: string): string { return `WITH principal_keys AS (
  SELECT pa.workspace_id,pa.public_id,pa.identity_id explicit_identity_id,pa.email_hint,pa.display_name,pa.source_version,pa.status,
    (SELECT count(*) FROM (${candidates})) candidate_count,
    (SELECT id FROM (${candidates}) LIMIT 1) candidate_id
  FROM pa_portal_principals pa WHERE ${principalPredicate}
), resolved AS (
  SELECT principal_keys.*,CASE WHEN candidate_count=1 THEN candidate_id ELSE NULL END identity_id FROM principal_keys
), facts AS (
  SELECT pa.workspace_id,pa.public_id,pa.email_hint,pa.display_name,pa.source_version,pa.status,pa.explicit_identity_id,
    pa.candidate_count,pa.identity_id,workspace.display_name workspace_name,workspace.status workspace_status,
    workspace.pa_organization_public_id,workspace.pa_client_public_id,
    checkpoint.active_generation_id,checkpoint.source_sequence,
    generation.source_generation,generation.status generation_status,generation.complete,
    identity.issuer,identity.subject,identity.verified_email,identity.status identity_status,identity.revoked_at identity_revoked_at,
    member.status membership_status,member.revoked_at membership_revoked_at,member.expires_at membership_expires_at,member.source_version membership_source_version,
    CASE WHEN pa.status='active' AND workspace.status='active' AND identity.status='active' AND identity.revoked_at IS NULL
      AND member.status='active' AND member.revoked_at IS NULL
      AND (member.expires_at IS NULL OR datetime(member.expires_at)>datetime('now'))
      AND generation.status='active' AND generation.complete=1
      AND EXISTS(SELECT 1 FROM portal_v2_directory_entities root WHERE root.workspace_id=workspace.id
        AND root.generation_id=generation.id AND root.entity_type=workspace.root_type AND root.parent_public_id IS NULL
        AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1)
      THEN 1 ELSE 0 END membership_active,
    (SELECT count(*) FROM portal_v2_identity_eligibility_blocks block WHERE ${activeBlock}
      AND block.match_type='email' AND ${normalized("block.normalized_email")}=${normalized("pa.email_hint")}) email_block_count,
    (SELECT min(block.id) FROM portal_v2_identity_eligibility_blocks block WHERE ${activeBlock}
      AND block.match_type='email' AND ${normalized("block.normalized_email")}=${normalized("pa.email_hint")}) email_block_id,
    EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE ${activeBlock}
      AND block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject) subject_block,
    EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=pa.workspace_id
      AND entitlement.identity_id=pa.identity_id) has_rules,
    (SELECT invitation.id FROM portal_v2_invitations invitation WHERE invitation.workspace_id=pa.workspace_id
      AND ${normalized("invitation.invited_email")}=${normalized("pa.email_hint")}
      ORDER BY invitation.created_at DESC,invitation.id DESC LIMIT 1) latest_invitation_id
  FROM resolved pa JOIN portal_v2_workspaces workspace ON workspace.id=pa.workspace_id
  LEFT JOIN portal_v2_identities identity ON identity.id=pa.identity_id
  LEFT JOIN portal_v2_workspace_memberships member ON member.workspace_id=pa.workspace_id AND member.identity_id=pa.identity_id
  LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=pa.workspace_id
  LEFT JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=pa.workspace_id AND generation.source_sequence=checkpoint.source_sequence
  WHERE workspace.status<>'closed'
), visible AS (
  SELECT facts.*,CASE WHEN email_block_count>0 OR subject_block=1 THEN 1 ELSE 0 END blocked,
    invitation.id invitation_id,invitation.status invitation_status,invitation.expires_at invitation_expires_at,
    outbox.status email_status,outbox.attempts,outbox.last_error_code,
    CASE WHEN facts.status='active' AND invitation.status='pending' AND datetime(invitation.expires_at)>datetime('now')
      AND outbox.status IN ('pending','failed') AND outbox.payload_json NOT LIKE '%"redacted"%'
      THEN 1 ELSE 0 END invitation_retryable
  FROM facts LEFT JOIN portal_v2_invitations invitation ON invitation.id=facts.latest_invitation_id
    AND invitation.workspace_id=facts.workspace_id
  LEFT JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=invitation.id
)`; }

function invalid(message = "Portal identity query is invalid"): never { throw new HTTPException(400, { message }); }
function changed(): never { throw new HTTPException(409, { message: "Client identity or permissions changed. Refresh the client workspace to continue" }); }
function checkId(value: string): void { if (!value || value.length > 128 || /[\0-\x1f\x7f]/.test(value)) invalid("Portal principal identifier is invalid"); }
function pageLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) invalid(`Portal page limit must be between 1 and ${maximum}`);
  return limit;
}
function encode(cursor: Cursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0))));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<Cursor>;
    if (cursor.v !== 1 || typeof cursor.policy !== "string" || typeof cursor.selection !== "string"
      || typeof cursor.collection !== "string" || !Array.isArray(cursor.after) || cursor.after.length !== 2
      || !cursor.after.every(value => typeof value === "string" && value.length <= 512)
      || (cursor.principal !== undefined && typeof cursor.principal !== "string")) throw new Error();
    return cursor as Cursor;
  } catch { invalid("Portal identity cursor is invalid"); }
}
async function policy(env: Env, actor: StaffPrincipal, scope: PortalIdentityScope): Promise<Policy> {
  const access = await sqlScope(env, actor, "team.view");
  if (!access.global || access.deniedGlobal) throw new HTTPException(403, { message: "Global team.view permission required" });
  const administrator = await isAdministrator(env, actor);
  const primaryClientScope = scope.kind === "global" || scope.context.root.source_id === "project-alpha:primary";
  const capabilities = { canManagePortal: primaryClientScope && administrator && portalOperationsManagementEnabled(env),
    canManageEligibilityBlocks: primaryClientScope && administrator && eligibilityBlockManagementEnabled(env),
    canReviewIdentityDetails: primaryClientScope };
  const hash = await sha256(JSON.stringify([actor.id, access.global, access.deniedGlobal, administrator, capabilities,
    scope.kind === "global" ? "global" : [scope.context.canonicalRoot, scope.context.root.workspace_id, scope.context.contextVersion]]));
  return { hash, contextVersion: scope.kind === "client" ? scope.context.contextVersion : hash, capabilities };
}
function metadata(limit: number, reason: PortalIdentityPageMetadata["reason"] = null): PortalIdentityPageMetadata {
  return { available: reason === null, reason, nextCursor: null, hasMore: false, returned: 0, limit };
}
function unavailableScope(scope: PortalIdentityScope): boolean { return scope.kind === "client" && scope.context.root.workspace_id === null; }
async function summary(fact: Fact, current: Policy): Promise<PortalIdentitySummary> {
  // The fingerprint intentionally includes live computed membership and block
  // flags, not just timestamps. It is a current-principal fence, not a snapshot
  // revision for every unloaded rule or historical invitation.
  const principalContextVersion = await sha256(JSON.stringify([current.hash, fact]));
  const linked = fact.candidate_count === 1;
  const email = fact.email_hint.trim().toLocaleLowerCase("en-US");
  return {
    workspace_id: fact.workspace_id, public_id: fact.public_id, workspace_name: fact.workspace_name,
    display_name: fact.display_name, email_hint: email, status: fact.status,
    identity_id: linked ? fact.identity_id : null, binding_status: linked ? "linked" : fact.candidate_count > 1 ? "conflict" : "unlinked",
    contact_key: `principal:${fact.workspace_id}:${fact.public_id}`, row_key: JSON.stringify([fact.workspace_id, fact.public_id]),
    principalContextVersion, has_workspace_access: fact.blocked ? 0 : fact.membership_active, blocked: fact.blocked,
    hasExplicitAccess: Boolean(fact.has_rules), accessLoaded: false,
    effectiveEmailBlockCount: fact.email_block_count, effectiveSubjectBlock: Boolean(fact.subject_block),
    removableEmailBlockId: current.capabilities.canManageEligibilityBlocks && fact.email_block_count === 1 ? fact.email_block_id : null,
    invitation: current.capabilities.canReviewIdentityDetails && fact.invitation_id ? { id: fact.invitation_id, status: fact.invitation_status!, expires_at: fact.invitation_expires_at!,
      email_status: fact.email_status, attempts: fact.attempts, last_error_code: fact.last_error_code } : null,
    actions: { canRetryInvitation: current.capabilities.canManagePortal && Boolean(fact.invitation_retryable),
      canCreateEmailBlock: current.capabilities.canManageEligibilityBlocks && fact.email_block_count === 0
        && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      canReviewEligibilityBlocks: current.capabilities.canReviewIdentityDetails },
  };
}

async function factsForKeys(env: Env, keys: PrincipalKey[]): Promise<Fact[]> {
  const facts: Fact[] = [];
  for (let offset = 0; offset < keys.length; offset += 20) {
    const part = keys.slice(offset, offset + 20);
    const predicate = part.map(() => "(pa.workspace_id=? AND pa.public_id=?)").join(" OR ");
    const result = await env.DELIVERY_DB.withSession("first-primary").prepare(`${factsCte(predicate)}
      SELECT * FROM visible
      ORDER BY workspace_id,public_id LIMIT ?`).bind(...part.flatMap(key => [key.workspaceId, key.publicId]), part.length).all<Fact>();
    facts.push(...result.results);
  }
  return facts;
}
async function verifyFacts(env: Env, actor: StaffPrincipal, scope: PortalIdentityScope, original: Policy, rows: PortalIdentitySummary[]): Promise<void> {
  const current = await policy(env, actor, scope);
  if (current.hash !== original.hash) changed();
  const facts = await factsForKeys(env, rows.map(row => ({ workspaceId: row.workspace_id, publicId: row.public_id })));
  const refreshed = await Promise.all(facts.map(row => summary(row, current)));
  const versions = new Map(refreshed.map(row => [row.row_key, row.principalContextVersion]));
  if (rows.some(row => versions.get(row.row_key) !== row.principalContextVersion)) changed();
}

/** This is a live, progressively loaded directory. Every page reruns search,
 * ownership and eligibility predicates before LIMIT; cursors never authorize
 * anything and do not promise a frozen inventory of unloaded principals. */
export async function listPortalIdentityPage(env: Env, actor: StaffPrincipal, scope: PortalIdentityScope,
  options: PortalIdentityQuery = {}): Promise<PortalIdentityPage> {
  const limit = pageLimit(options.limit, 50), current = await policy(env, actor, scope);
  const q = (options.q ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
  if ((options.q?.length ?? 0) > 200 || /[\0-\x1f\x7f]/.test(options.q ?? "")) invalid();
  const link = options.link ?? "all", blocked = options.blocked ?? "all", principalStatus = options.principalStatus ?? "active";
  if (!["all", "linked", "unlinked", "conflict"].includes(link) || !["all", "yes", "no"].includes(blocked)
    || !["all", "active", "suspended", "revoked"].includes(principalStatus)) invalid();
  const selection = await sha256(JSON.stringify([q, link, blocked, principalStatus]));
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.collection !== "identities" || cursor.selection !== selection)) invalid("Portal cursor does not match this search");
  if (cursor && cursor.policy !== current.hash) changed();
  const page = metadata(limit, unavailableScope(scope) ? "workspace_unavailable" : null);
  const response: PortalIdentityPage = { items: [], page, contextVersion: current.contextVersion,
    refreshedAt: new Date().toISOString(), capabilities: current.capabilities };
  if (!page.available) return response;
  const predicates: string[] = [], clauses: string[] = [], values: string[] = [];
  if (scope.kind === "client") { predicates.push("pa.workspace_id=?"); values.push(scope.context.root.workspace_id!); }
  if (principalStatus !== "all") { predicates.push("pa.status=?"); values.push(principalStatus); }
  if (q) { predicates.push(`(instr(lower(pa.display_name),?)>0 OR instr(${normalized("pa.email_hint")},?)>0)`); values.push(q, q); }
  if (link !== "all") clauses.push(`candidate_count${link === "linked" ? "=1" : link === "unlinked" ? "=0" : ">1"}`);
  if (blocked !== "all") clauses.push(`blocked=${blocked === "yes" ? "1" : "0"}`);
  if (cursor) { predicates.push("(pa.workspace_id,pa.public_id)>(?,?)"); values.push(...cursor.after); }
  const result = await env.DELIVERY_DB.withSession("first-primary").prepare(`${factsCte(predicates.join(" AND ") || "1=1")}
    SELECT * FROM visible ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY workspace_id,public_id LIMIT ?`).bind(...values, limit + 1).all<Fact>();
  const facts = result.results.slice(0, limit);
  response.items = await Promise.all(facts.map(row => summary(row, current)));
  page.returned = facts.length; page.hasMore = result.results.length > limit;
  if (page.hasMore) {
    const last = facts[facts.length - 1]!;
    page.nextCursor = encode({ v: 1, policy: current.hash, selection, collection: "identities", after: [last.workspace_id, last.public_id] });
  }
  await verifyFacts(env, actor, scope, current, response.items);
  return response;
}

export async function listPortalIdentityCollection(env: Env, actor: StaffPrincipal, scope: PortalIdentityScope,
  key: PrincipalKey, collection: PortalIdentityCollection,
  options: { expectedPrincipalContext: string; cursor?: string; limit?: number }): Promise<PortalIdentityCollectionPage> {
  checkId(key.workspaceId); checkId(key.publicId);
  const limit = pageLimit(options.limit, 100), current = await policy(env, actor, scope);
  if (!["access", "invitations", "eligibility-blocks"].includes(collection)) invalid("Portal identity collection is invalid");
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.expectedPrincipalContext)) invalid("A current principal context is required");
  if (scope.kind === "client" && scope.context.root.workspace_id !== key.workspaceId)
    throw new HTTPException(404, { message: "Portal principal not found in this client workspace" });
  const fact = (await factsForKeys(env, [key]))[0];
  if (!fact) throw new HTTPException(404, { message: "Portal principal not found" });
  const principal = await summary(fact, current);
  if (principal.principalContextVersion !== options.expectedPrincipalContext) changed();
  const selection = await sha256(JSON.stringify([key.workspaceId, key.publicId]));
  const cursor = options.cursor === undefined ? null : decode(options.cursor);
  if (cursor && (cursor.collection !== collection || cursor.selection !== selection)) invalid("Portal cursor does not match this principal collection");
  if (cursor && (cursor.policy !== current.hash || cursor.principal !== principal.principalContextVersion)) changed();
  const reason = collection === "access" && principal.binding_status !== "linked"
    ? principal.binding_status === "conflict" ? "identity_conflict" : "identity_unlinked" : null;
  const page = metadata(limit, reason);
  const response: PortalIdentityCollectionPage = { items: [], page, contextVersion: current.contextVersion,
    principalContextVersion: principal.principalContextVersion, refreshedAt: new Date().toISOString() };
  if (reason) { await verifyFacts(env, actor, scope, current, [principal]); return response; }
  let select: string, from: string, where: string;
  let values: unknown[];
  if (collection === "access") {
    select = `row.id,row.capability,row.effect,row.scope_type,row.scope_public_id,COALESCE(entity.display_name,row.scope_public_id) scope_label,
      row.status,row.valid_from,row.expires_at,row.revoked_at,row.source_type,row.entitlement_version,row.created_at,
      CASE WHEN row.status='active' AND row.revoked_at IS NULL AND datetime(row.valid_from)<=datetime('now')
        AND (row.expires_at IS NULL OR datetime(row.expires_at)>datetime('now')) THEN 1 ELSE 0 END effective_now`;
    from = `portal_v2_entitlements row LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=row.workspace_id
      LEFT JOIN portal_v2_directory_entities entity ON entity.workspace_id=row.workspace_id
        AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type=row.scope_type AND entity.public_id=row.scope_public_id`;
    where = "row.workspace_id=? AND row.identity_id=?"; values = [key.workspaceId, principal.identity_id];
  } else if (collection === "invitations") {
    select = `row.id,row.status,row.created_at,row.expires_at,row.accepted_at,row.revoked_at,
      outbox.status email_status,outbox.attempts,outbox.last_error_code`;
    from = "portal_v2_invitations row LEFT JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=row.id";
    where = `row.workspace_id=? AND ${normalized("row.invited_email") }=?`; values = [key.workspaceId, principal.email_hint];
  } else {
    select = `row.id,row.match_type,row.normalized_email,row.reason_code,row.status,row.valid_from,row.expires_at,row.created_at,row.revoked_at,
      CASE WHEN row.status='active' AND datetime(row.valid_from)<=datetime('now')
        AND (row.expires_at IS NULL OR datetime(row.expires_at)>datetime('now')) THEN 1 ELSE 0 END effective_now`;
    from = "portal_v2_identity_eligibility_blocks row";
    where = `((row.match_type='email' AND ${normalized("row.normalized_email")}=?)
      OR (row.match_type='issuer_subject' AND row.issuer=? AND row.subject=?))`;
    values = [principal.email_hint, fact.issuer ?? null, fact.subject ?? null];
  }
  const after = cursor ? " AND (row.created_at,row.id)<(?,?)" : "";
  const result = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT ${select},row.created_at cursor_created_at
    FROM ${from} WHERE (${where})${after} ORDER BY row.created_at DESC,row.id DESC LIMIT ?`)
    .bind(...values, ...(cursor?.after ?? []), limit + 1).all<Record<string, unknown>>();
  const rows = result.results.slice(0, limit);
  page.returned = rows.length; page.hasMore = result.results.length > limit;
  if (page.hasMore) {
    const last = rows[rows.length - 1]!;
    page.nextCursor = encode({ v: 1, policy: current.hash, selection, collection, principal: principal.principalContextVersion,
      after: [String(last.cursor_created_at), String(last.id)] });
  }
  response.items = rows.map(({ cursor_created_at: _cursorCreatedAt, ...row }) => ({ ...row,
    row_key: JSON.stringify([key.workspaceId, key.publicId, collection, row.id]),
    ...(collection === "access" ? { effective_now: Boolean(row.effective_now) } : {}),
    ...(collection === "eligibility-blocks" ? { effective_now: Boolean(row.effective_now), global_scope: true,
      canRevoke: current.capabilities.canManageEligibilityBlocks && row.match_type === "email" && row.status === "active" } : {}),
  }));
  await verifyFacts(env, actor, scope, current, [principal]);
  return response;
}
