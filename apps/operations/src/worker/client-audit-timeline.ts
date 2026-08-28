import {
  CLIENT_AUDIT_TIMELINE_ACTORS,
  CLIENT_AUDIT_TIMELINE_ACCESS_ADAPTERS,
  CLIENT_AUDIT_TIMELINE_CATEGORIES,
  CLIENT_AUDIT_TIMELINE_NOTIFICATION_ADAPTERS,
  CLIENT_AUDIT_TIMELINE_PROJECT_ADAPTERS,
  CLIENT_AUDIT_TIMELINE_RESULTS,
  PRIMARY_ALPHA_SOURCE_ID,
  type ClientAuditTimelineActorType,
  type ClientAuditTimelineCategory,
  type ClientAuditTimelineFilters,
  type ClientAuditTimelineItem,
  type ClientAuditTimelinePage,
  type ClientAuditTimelineResult,
} from "@ltds/shared";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { eligibleBusinessActivitySql } from "./client-business-activity";
import { readClientHubBusinessProjectDetail } from "./client-hub-business-project-detail";
import { clientHubBusinessProjectSourceProof } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { base64Url, sha256 } from "./crypto";
import { d1TablesPresent } from "./schema-readiness";
import type { Env, StaffPrincipal } from "./types";

type Producer = ClientAuditTimelineItem["producer"];
type CoverageReason = ClientAuditTimelinePage["coverage"][ClientAuditTimelineCategory]["reason"];
interface DeliveryScope {
  accountId: string | null;
  projectId: string | null;
  projectPublicId: string | null;
  workspaceId: string | null;
  proof: string;
}
interface CandidateRow {
  rowid: number;
  event_id: string | number;
  action: string;
  actor_type?: string | null;
  occurred_at: string;
  resource_id?: string | null;
  resource_label?: string | null;
}
interface TimelineCursor {
  v: 7;
  actor: string;
  root: [string, string, string, string];
  projectId: string | null;
  context: string;
  scope: string;
  project: string | null;
  businessPolicy: string;
  businessSource: string;
  businessRevision: number;
  deliveryAuditPolicy: string;
  portalPolicy: string;
  noticeScope: string;
  collaboratorNoticeSchema: boolean;
  companionNoticeSchema: boolean;
  operationalProjectSchema: boolean;
  organizationContactSchema:boolean;
  projectAccessHistory: string | null;
  viewerManagePolicy: string;
  filters: ClientAuditTimelineFilters;
  asOf: string;
  waters: Record<string, number>;
  after: [string, Producer, string] | null;
  expires: number;
}

const identifier = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.string().max(64).refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const filtersSchema = z.object({
  category: z.enum(["all", ...CLIENT_AUDIT_TIMELINE_CATEGORIES]),
  actorType: z.enum(["all", ...CLIENT_AUDIT_TIMELINE_ACTORS]),
  result: z.enum(["all", ...CLIENT_AUDIT_TIMELINE_RESULTS]),
  from: timestamp.nullable(),
  to: timestamp.nullable(),
}).strict();
const cursorSchema = z.object({
  v: z.literal(7), actor: identifier, root: z.tuple([identifier, identifier, identifier, identifier]),
  projectId: identifier.nullable(), context: proof, scope: proof, project: proof.nullable(),
  businessPolicy: proof, businessSource: proof, businessRevision: z.number().int().nonnegative(), deliveryAuditPolicy: proof,
  viewerManagePolicy: proof, portalPolicy: proof,
  noticeScope: proof,
  collaboratorNoticeSchema: z.boolean(), companionNoticeSchema: z.boolean(),
  operationalProjectSchema: z.boolean(),
  organizationContactSchema:z.boolean(),
  projectAccessHistory: timestamp.nullable(),
  filters: filtersSchema, asOf: timestamp,
  waters: z.record(z.string().min(1).max(80), z.number().int().nonnegative()),
  after: z.tuple([timestamp, z.enum(["project_alpha", "operations", "service_requests", "portal_access", "client_delivery"]), identifier]).nullable(),
  expires: z.number().int().positive(),
}).strict();

const timeExpression = (column: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${column})`;
const safeText = (value: unknown, fallback: string, maximum = 180): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
};
const normalizeTime = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const rootTuple = (context: ClientHubCollectionContext): TimelineCursor["root"] => [context.root.source_id,
  context.root.root_namespace, context.root.kind, context.root.public_id];
const rootPath = (context: ClientHubCollectionContext): string => `/clients/sources/${encodeURIComponent(context.root.source_id)}/business/${
  context.root.kind === "organization" ? "organizations" : "standalone"}/${encodeURIComponent(context.root.public_id)}`;
const changed = (): never => { throw new HTTPException(409, { message: "Timeline scope or access changed. Refresh the client workspace to continue" }); };

async function cursorKey(env: Env): Promise<CryptoKey> {
  if (!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length < 32)
    throw new Error("Client timeline cursor configuration unavailable");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`client-audit-timeline:v7:${env.OPERATIONS_SESSION_SECRET}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function encodeCursor(env: Env, actor: StaffPrincipal, value: TimelineCursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(`client-audit-timeline:v7:${actor.id}`) }, await cursorKey(env),
  new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(body))}`;
}
async function decodeCursor(env: Env, actor: StaffPrincipal, raw: string): Promise<TimelineCursor> {
  try {
    if (raw.length > 12_000) throw new Error();
    const parts = raw.split(".");
    if (parts.length !== 2) throw new Error();
    const body = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(parts[0]!),
      additionalData: new TextEncoder().encode(`client-audit-timeline:v7:${actor.id}`) }, await cursorKey(env), decodeBase64Url(parts[1]!));
    return cursorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch { throw new HTTPException(400, { message: "Client timeline cursor is invalid" }); }
}

export function parseClientAuditTimelineFilters(params: URLSearchParams): ClientAuditTimelineFilters {
  const category = params.get("category") ?? "all", actorType = params.get("actorType") ?? "all",
    result = params.get("result") ?? "all", from = params.get("from"), to = params.get("to");
  const parsed = filtersSchema.safeParse({ category, actorType, result, from, to });
  if (!parsed.success || (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to))
    throw new HTTPException(400, { message: "Client timeline filters are invalid" });
  return parsed.data;
}

function coverage(available: boolean, reason: CoverageReason = null) { return { available, reason: available ? null : reason }; }
async function projectAccessHistoryState(env:Env):Promise<{collectedSince:string|null;proof:string}>{
  const db=env.DELIVERY_DB.withSession('first-primary'),names=['portal_project_access_authority_history_state','portal_project_access_authority_events'];
  const rows=(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?) ORDER BY name`).bind(...names).all<{name:string}>()).results;
  if(rows.length===0)return {collectedSince:null,proof:await sha256('project-access-history:absent')};
  if(rows.length!==2)throw new Error('Project access authority history schema is incomplete');
  const raw=await db.prepare(`SELECT collection_started_at FROM portal_project_access_authority_history_state WHERE singleton=1`).first<string>('collection_started_at');
  const collectedSince=normalizeTime(raw);if(!collectedSince)throw new Error('Project access authority history coverage is invalid');
  return {collectedSince,proof:await sha256(JSON.stringify([rows.map(row=>row.name),collectedSince]))};
}
function actor(value: string | null | undefined): ClientAuditTimelineItem["actor"] {
  switch (value) {
    case "staff": return { type: "staff", label: "Team" };
    case "client": case "client_manager": case "identity": return { type: "client", label: "Client" };
    case "integration": return { type: "integration", label: "Connected service" };
    case "public": return { type: "public", label: "Public visitor" };
    case "system": return { type: "system", label: "System" };
    default: return null;
  }
}
function allowedByFilters(filters: ClientAuditTimelineFilters, category: ClientAuditTimelineCategory,
  actorType: ClientAuditTimelineActorType, result: ClientAuditTimelineResult): boolean {
  return (filters.category === "all" || filters.category === category)
    && (filters.actorType === "all" || filters.actorType === actorType)
    && (filters.result === "all" || filters.result === result);
}
function timeBounds(filters: ClientAuditTimelineFilters, asOf: string, expression: string): { sql: string; values: string[] } {
  const upper = filters.to && filters.to < asOf ? filters.to : asOf;
  return { sql: `${expression}<=?${filters.from ? ` AND ${expression}>=?` : ""}`, values: [upper, ...(filters.from ? [filters.from] : [])] };
}
function seek(expression: string, idExpression: string, producer: Producer,
  after: TimelineCursor["after"]): { sql: string; values: string[] } {
  if (!after) return { sql: "", values: [] };
  if (producer < after[1]) return { sql: ` AND ${expression}<?`, values: [after[0]] };
  if (producer > after[1]) return { sql: ` AND ${expression}<=?`, values: [after[0]] };
  return { sql: ` AND (${expression}<? OR (${expression}=? AND CAST(${idExpression} AS TEXT)>?))`,
    values: [after[0], after[0], after[2]] };
}
async function maxRowid(db: D1DatabaseSession, table: string): Promise<number> {
  const value = await db.prepare(`SELECT COALESCE(MAX(rowid),0) value FROM ${table}`).first<number>("value");
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
}

async function deliveryScope(env: Env, context: ClientHubCollectionContext, projectId: string | null): Promise<DeliveryScope> {
  const root = context.root, db = env.DELIVERY_DB.withSession("first-primary");
  if (root.root_namespace === "business" && root.source_id !== PRIMARY_ALPHA_SOURCE_ID)
    return { accountId: null, projectId: null, projectPublicId: null, workspaceId: null,
      proof: await sha256(JSON.stringify([rootTuple(context), "secondary-source-records-only"])) };
  let accounts: Array<{ id: string; status: string; project_alpha_source_id: string | null;
    project_alpha_client_id: string | null; project_alpha_organization_id: string | null }> = [];
  if (root.root_namespace === "account" && root.source_id === "delivery:local") {
    accounts = (await db.prepare(`SELECT id,status,project_alpha_source_id,project_alpha_client_id,project_alpha_organization_id
      FROM client_accounts WHERE id=? AND status='active' AND project_alpha_source_id IS NULL
      AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NULL LIMIT 2`).bind(root.public_id).all<typeof accounts[number]>()).results;
  } else if (root.root_namespace === "business" && root.source_id === PRIMARY_ALPHA_SOURCE_ID) {
    const owner = root.kind === "organization" ? "project_alpha_organization_id=?"
      : "project_alpha_client_id=? AND project_alpha_organization_id IS NULL";
    accounts = (await db.prepare(`SELECT id,status,project_alpha_source_id,project_alpha_client_id,project_alpha_organization_id
      FROM client_accounts WHERE status='active' AND project_alpha_source_id=? AND ${owner} LIMIT 2`)
      .bind(PRIMARY_ALPHA_SOURCE_ID, root.public_id).all<typeof accounts[number]>()).results;
  }
  if (accounts.length > 1) changed();
  const account = accounts[0] ?? null;
  let projects: Array<{ id: string; project_alpha_source_id: string | null; project_alpha_project_id: string | null;
    active: number; granted_at: string; revoked_at: string | null }> = [];
  if (account && projectId) {
    projects = (await db.prepare(`SELECT project.id,project.project_alpha_source_id,project.project_alpha_project_id,
      project.active,grant_record.granted_at,grant_record.revoked_at FROM projects project
      JOIN client_project_grants grant_record ON grant_record.project_id=project.id AND grant_record.account_id=?
      WHERE project.active=1 AND grant_record.revoked_at IS NULL AND project.project_alpha_source_id=?
        AND project.project_alpha_project_id=? LIMIT 2`).bind(account.id, root.source_id, projectId)
      .all<typeof projects[number]>()).results;
    if (projects.length > 1) changed();
  }
  const project = projects[0] ?? null;
  const stable = [rootTuple(context), account, project, root.workspace_id ?? null];
  return { accountId: account?.id ?? null, projectId: project?.id ?? null,
    projectPublicId: project?.project_alpha_project_id ?? null, workspaceId: root.workspace_id ?? null,
    proof: await sha256(JSON.stringify(stable)) };
}

async function readDeliveryAuditPolicy(env: Env, principal: StaffPrincipal): Promise<{ allowed: boolean; proof: string }> {
  const scope = await sqlScope(env, principal, "delivery.share.audit");
  const allowed = scope.global && !scope.deniedGlobal;
  return { allowed, proof: await sha256(JSON.stringify([principal.id, "delivery.share.audit", allowed, scope])) };
}

async function readViewerManagePolicy(env: Env, principal: StaffPrincipal): Promise<{ allowed: boolean; proof: string }> {
  const scope = await sqlScope(env, principal, "viewer.manage");
  const allowed = scope.global && !scope.deniedGlobal;
  return { allowed, proof: await sha256(JSON.stringify([principal.id, "viewer.manage", allowed, scope])) };
}

async function readPortalPolicy(env: Env, principal: StaffPrincipal): Promise<{ allowed: boolean; proof: string }> {
  const scope = await sqlScope(env, principal, "operations.manage");
  const allowed = scope.global && !scope.deniedGlobal;
  return { allowed, proof: await sha256(JSON.stringify([principal.id, "operations.manage", allowed, scope])) };
}

async function projectAccessNoticeScopeProof(env: Env, context: ClientHubCollectionContext): Promise<{ available: boolean; proof: string }> {
  if (context.root.root_namespace !== "business" || !context.root.workspace_id)
    return { available: false, proof: await sha256(JSON.stringify([rootTuple(context), "project-access-notices-not-applicable"])) };
  const rows = (await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,project_alpha_source_id,status
    FROM portal_v2_workspaces WHERE id=? AND project_alpha_source_id=? AND status='active' LIMIT 2`)
    .bind(context.root.workspace_id, context.root.source_id)
    .all<{ id: string; project_alpha_source_id: string; status: string }>()).results;
  if (rows.length > 1) changed();
  return { available: rows.length === 1, proof: await sha256(JSON.stringify([rootTuple(context), rows])) };
}

function item(input: Omit<ClientAuditTimelineItem, "id">): ClientAuditTimelineItem {
  return { ...input, id: `${input.producer}:${input.sourceId}:${input.producerEventId}` };
}
function compare(left: ClientAuditTimelineItem, right: ClientAuditTimelineItem): number {
  return right.occurredAt.localeCompare(left.occurredAt) || left.producer.localeCompare(right.producer)
    || left.producerEventId.localeCompare(right.producerEventId);
}

async function businessCandidates(env: Env, context: ClientHubCollectionContext, filters: ClientAuditTimelineFilters,
  projectId: string | null, asOf: string, after: TimelineCursor["after"], water: number,
  limit: number, policy: Awaited<ReturnType<typeof readClientHubBusinessProjectPolicy>>): Promise<ClientAuditTimelineItem[]> {
  if (context.root.root_namespace !== "business" || !allowedByFilters(filters, "project", "source", "informational")) return [];
  const eligible = eligibleBusinessActivitySql(policy.filter, asOf), producer: Producer = "project_alpha";
  const bounds = timeBounds(filters, asOf, "occurred_at"), continuation = seek("occurred_at", "sequence", producer, after);
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`WITH eligible AS (${eligible.sql})
    SELECT sequence rowid,sequence event_id,action,occurred_at,record_kind,record_id,record_name
    FROM eligible WHERE sequence<=? AND projection_source_id=? AND root_kind=? AND root_id=?
      ${projectId ? "AND record_kind='project' AND record_id=?" : ""}
      AND ${bounds.sql}${continuation.sql}
    ORDER BY occurred_at DESC,CAST(sequence AS TEXT) ASC LIMIT ?`).bind(...eligible.values, water,
      context.root.source_id, context.root.kind, context.root.public_id, ...(projectId ? [projectId] : []),
      ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow & { record_kind: string; record_id: string; record_name: string }>();
  const path = rootPath(context);
  return rows.results.map(row => item({ sourceId: context.root.source_id, producer,
    producerEventId: String(row.event_id), category: "project", action: safeText(row.action, "source_record_updated", 80),
    actor: null, resource: { type: safeText(row.record_kind, "source_record", 40), id: safeText(row.record_id, "source-record", 512),
      label: safeText(row.record_name, "Source record", 180),
      detailPath: row.record_kind === "project" ? `${path}/projects/${encodeURIComponent(row.record_id)}` : path },
    result: "informational", occurredAt: normalizeTime(row.occurred_at)! }));
}

async function requestCandidates(env: Env, context: ClientHubCollectionContext, scope: DeliveryScope,
  filters: ClientAuditTimelineFilters, asOf: string, after: TimelineCursor["after"], water: number,
  limit: number): Promise<ClientAuditTimelineItem[]> {
  if (!scope.accountId || !context.access.requests || !allowedByFilters(filters, "request", "client", "succeeded")
    && !allowedByFilters(filters, "request", "staff", "succeeded")
    && !allowedByFilters(filters, "request", "system", "succeeded")) return [];
  const producer: Producer = "service_requests", at = timeExpression("revision.created_at"),
    bounds = timeBounds(filters, asOf, at), continuation = seek(at, "revision.id", producer, after);
  const author = filters.actorType === "all" ? "" : ` AND revision.author_type=?`;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT revision.rowid,revision.id event_id,
    revision.action,revision.author_type actor_type,${at} occurred_at,request.id resource_id,request.title resource_label
    FROM request_revisions revision JOIN client_service_requests request ON request.id=revision.request_id
    JOIN client_accounts account ON account.id=request.account_id AND account.status='active'
    WHERE revision.rowid<=? AND request.account_id=? ${scope.projectId ? "AND request.project_id=?" : ""}
      AND ${bounds.sql}${author}${continuation.sql}
    ORDER BY ${at} DESC,revision.id ASC LIMIT ?`).bind(water, scope.accountId,
      ...(scope.projectId ? [scope.projectId] : []), ...bounds.values,
      ...(filters.actorType === "all" ? [] : [filters.actorType]), ...continuation.values, limit + 1).all<CandidateRow>();
  return rows.results.flatMap(row => {
    const actorValue = row.actor_type === "client" ? "client" : row.actor_type === "staff" ? "staff" : "system";
    if (!allowedByFilters(filters, "request", actorValue, "succeeded")) return [];
    return [item({ sourceId: context.root.source_id, producer, producerEventId: String(row.event_id), category: "request",
      action: safeText(row.action, "request.updated", 80), actor: actor(actorValue),
      resource: { type: "service_request", id: safeText(row.resource_id, "request", 512),
        label: safeText(row.resource_label, "Service request", 180),
        detailPath: `/clients/requests/${encodeURIComponent(String(row.resource_id))}` },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! })];
  });
}

async function accessCandidates(env: Env, context: ClientHubCollectionContext, scope: DeliveryScope,
  filters: ClientAuditTimelineFilters, projectId: string | null, asOf: string, after: TimelineCursor["after"],
  waters: Record<string, number>, limit: number, policies: { portal: boolean; deliveryAudit: boolean; viewerManage: boolean },
  canonicalHistoryStart:string|null,
): Promise<ClientAuditTimelineItem[]> {
  if (filters.category !== "all" && filters.category !== "access") return [];
  const producer: Producer = "portal_access", db = env.DELIVERY_DB.withSession("first-primary"),
    candidates: ClientAuditTimelineItem[] = [];
  const succeeded = filters.result === "all" || filters.result === "succeeded";

  // Workspace membership and peer-administrator events have no project key.
  // They are deliberately absent from project timelines rather than inferred.
  if (policies.portal && scope.workspaceId && !projectId && succeeded
    && (filters.actorType === "all" || filters.actorType === "client" || filters.actorType === "system")) {
    const at = timeExpression("created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'membership:'||id", producer, after),
      actorPredicate = filters.actorType === "all" ? "" : " AND CASE WHEN actor_identity_id IS NULL THEN 'system' ELSE 'client' END=?";
    const rows = await db.prepare(`SELECT audit.rowid,audit.id event_id,audit.action,CASE WHEN audit.actor_identity_id IS NULL THEN 'system' ELSE 'client' END actor_type,
      ${at} occurred_at FROM portal_v2_membership_audit audit WHERE audit.rowid<=? AND audit.workspace_id=?
      AND action IN ('invitation.created','invitation.revoked','invitation.accepted','membership.suspended','membership.reactivated','manager.transferred')
      ${canonicalHistoryStart?`AND NOT EXISTS(SELECT 1 FROM portal_project_access_authority_events canonical
        WHERE canonical.recorded_sequence<=? AND canonical.workspace_id=audit.workspace_id AND canonical.source_id=?
          AND canonical.authority_type='invitation'
          AND canonical.authority_id=audit.invitation_id
          AND canonical.event_kind=CASE audit.action WHEN 'invitation.created' THEN 'invitation_created'
            WHEN 'invitation.revoked' THEN 'invitation_revoked' WHEN 'invitation.accepted' THEN 'invitation_accepted' ELSE '' END
          AND canonical.producer_event_key='membership:'||audit.id)`:''}
      ${actorPredicate} AND ${bounds.sql}${continuation.sql} ORDER BY ${at} DESC,id ASC LIMIT ?`)
      .bind(waters.memberships ?? 0, scope.workspaceId,...(canonicalHistoryStart?[waters.projectAccessHistory??0,context.root.source_id]:[]),
        ...(filters.actorType === "all" ? [] : [filters.actorType]),
        ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `membership:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor(row.actor_type), resource: { type: "workspace_membership", label: "Client workspace access" },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! }));
  }

  if (policies.portal && scope.workspaceId) {
    const actorExpression = "CASE WHEN audit.actor_type='identity' THEN 'client' ELSE 'staff' END";
    const resultExpression = "CASE WHEN audit.action IN ('request.rejected','request.cancelled') THEN 'denied' "
      + "WHEN audit.action IN ('request.approval_abandoned','policy.changed') THEN 'informational' ELSE 'succeeded' END";
    const at = timeExpression("audit.created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'invitation-request:'||audit.id", producer, after),
      actorPredicate = filters.actorType === "all" ? "" : ` AND ${actorExpression}=?`,
      resultPredicate = filters.result === "all" ? "" : ` AND ${resultExpression}=?`,
      requestJoin = projectId
        ? "JOIN portal_workspace_invitation_requests request ON request.id=audit.request_id AND request.workspace_id=audit.workspace_id"
        : "LEFT JOIN portal_workspace_invitation_requests request ON request.id=audit.request_id AND request.workspace_id=audit.workspace_id";
    const rows = await db.prepare(`SELECT audit.rowid,audit.id event_id,audit.action,${actorExpression} actor_type,${at} occurred_at
      FROM portal_workspace_invitation_request_audit audit ${requestJoin}
      WHERE audit.rowid<=? AND audit.workspace_id=?
      AND audit.action IN ('policy.changed','request.submitted','request.approval_staged','request.approved','request.approval_abandoned','request.rejected','request.cancelled')
      AND ((audit.action='policy.changed' AND audit.request_id IS NULL) OR request.id IS NOT NULL)
      ${projectId ? "AND request.source_id=? AND request.scope_type='project' AND request.scope_public_id=?" : ""}
      ${canonicalHistoryStart?`AND NOT (audit.action='request.submitted' AND EXISTS(SELECT 1 FROM portal_project_access_authority_events canonical
        WHERE canonical.recorded_sequence<=? AND canonical.workspace_id=audit.workspace_id AND canonical.source_id=?
          AND canonical.authority_type='invitation_request'
          AND canonical.authority_id=audit.request_id AND canonical.event_kind='request_submitted'
          AND canonical.producer_event_key='invitation-request:submitted:'||audit.request_id
        ))`:''}
      ${actorPredicate}${resultPredicate} AND ${bounds.sql}${continuation.sql}
      ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(waters.invitationRequests ?? 0, scope.workspaceId,
      ...(projectId ? [context.root.source_id, projectId] : []),
      ...(canonicalHistoryStart?[waters.projectAccessHistory??0,context.root.source_id]:[]),
      ...(filters.actorType === "all" ? [] : [filters.actorType]),...(filters.result === "all" ? [] : [filters.result]),
      ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) {
      const result: ClientAuditTimelineResult = ["request.rejected", "request.cancelled"].includes(row.action) ? "denied"
        : ["request.approval_abandoned", "policy.changed"].includes(row.action) ? "informational" : "succeeded";
      candidates.push(item({ sourceId: context.root.source_id, producer,
        producerEventId: `invitation-request:${String(row.event_id)}`, category: "access", action: row.action,
        actor: actor(row.actor_type), resource: { type: "workspace_invitation_request", label: "Client access invitation request" },
        result, occurredAt: normalizeTime(row.occurred_at)! }));
    }
  }

  if (policies.portal && scope.workspaceId && !projectId && succeeded
    && (filters.actorType === "all" || filters.actorType === "client")) {
    const at = timeExpression("created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'peer-admin:'||id", producer, after);
    const rows = await db.prepare(`SELECT rowid,id event_id,action,'client' actor_type,${at} occurred_at
      FROM portal_workspace_peer_admin_audit WHERE rowid<=? AND workspace_id=?
      AND action IN ('manager.promoted','manager.demoted') AND ${bounds.sql}${continuation.sql}
      ORDER BY ${at} DESC,id ASC LIMIT ?`).bind(waters.peerAdministrators ?? 0, scope.workspaceId,
      ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `peer-admin:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor("client"), resource: { type: "workspace_peer_administrator", label: "Client workspace administrator" },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! }));
  }

  if (policies.portal && scope.workspaceId
    && (filters.actorType === "all" || filters.actorType === "staff" || filters.actorType === "system")) {
    const actorExpression = "CASE WHEN audit.actor_type='staff' THEN 'staff' ELSE 'system' END";
    const resultExpression = "CASE WHEN audit.action='denial.revoked' THEN 'succeeded' ELSE 'denied' END";
    const at = timeExpression("audit.created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'identity-denial:'||audit.id", producer, after),
      actorPredicate = filters.actorType === "all" ? "" : ` AND ${actorExpression}=?`,
      resultPredicate = filters.result === "all" ? "" : ` AND ${resultExpression}=?`;
    const rows = await db.prepare(`SELECT audit.rowid,audit.id event_id,audit.action,${actorExpression} actor_type,${at} occurred_at
      FROM portal_v2_identity_denial_audit audit
      JOIN portal_v2_identity_denials denial ON denial.id=audit.denial_id AND denial.identity_id=audit.identity_id
        AND denial.workspace_id=audit.workspace_id
      ${projectId ? `JOIN portal_v2_workspaces workspace ON workspace.id=denial.workspace_id AND workspace.project_alpha_source_id=?
      JOIN projects project_record ON project_record.id=? AND project_record.active=1
        AND project_record.project_alpha_source_id=workspace.project_alpha_source_id
        AND project_record.project_alpha_project_id=denial.scope_public_id` : ""}
      WHERE audit.rowid<=? AND audit.workspace_id=? AND audit.action IN ('denial.created','denial.revoked','denial.changed')
      ${projectId ? "AND denial.scope_type='project' AND denial.scope_public_id=?" : ""}
      ${actorPredicate}${resultPredicate} AND ${bounds.sql}${continuation.sql}
      ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(...(projectId ? [context.root.source_id, scope.projectId] : []),
      waters.identityDenials ?? 0, scope.workspaceId, ...(projectId ? [projectId] : []), ...(filters.actorType === "all" ? [] : [filters.actorType]),
      ...(filters.result === "all" ? [] : [filters.result]), ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `identity-denial:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor(row.actor_type), resource: { type: "portal_identity_denial", label: "Client portal access restriction" },
      result: row.action === "denial.revoked" ? "succeeded" : "denied", occurredAt: normalizeTime(row.occurred_at)! }));
  }

  if (policies.deliveryAudit && scope.workspaceId && succeeded
    && (filters.actorType === "all" || filters.actorType === "staff")) {
    const at = timeExpression("audit.created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'authenticated-grant:'||audit.id", producer, after);
    const rows = await db.prepare(`SELECT audit.rowid,audit.id event_id,audit.action,'staff' actor_type,${at} occurred_at
      FROM portal_v2_authenticated_delivery_grant_audit audit
      JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=audit.grant_id AND grant_record.workspace_id=audit.workspace_id
      JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=audit.workspace_id
      ${projectId ? `JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.project_alpha_source_id=?
      JOIN projects project_record ON project_record.id=? AND project_record.active=1
        AND project_record.project_alpha_source_id=workspace.project_alpha_source_id
        AND project_record.project_alpha_project_id=binding.owner_public_id` : ""}
      WHERE audit.rowid<=? AND audit.workspace_id=? AND audit.action IN ('grant.created','grant.revoked','grant.restored')
      ${projectId ? "AND binding.owner_scope_type='project' AND binding.owner_public_id=?" : ""}
      ${canonicalHistoryStart?`AND NOT EXISTS(SELECT 1 FROM portal_project_access_authority_events canonical
        WHERE canonical.recorded_sequence<=? AND canonical.workspace_id=audit.workspace_id AND canonical.source_id=?
          ${projectId?'AND canonical.project_public_id=?':''} AND canonical.authority_type='authenticated_delivery_grant'
          AND canonical.authority_id=audit.grant_id
          AND canonical.event_kind=CASE audit.action WHEN 'grant.created' THEN 'grant_created'
            WHEN 'grant.revoked' THEN 'grant_revoked' WHEN 'grant.restored' THEN 'grant_restored' ELSE '' END
          AND canonical.producer_event_key='authenticated-grant-audit:'||audit.id)`:''}
      AND ${bounds.sql}${continuation.sql} ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(
      ...(projectId ? [context.root.source_id, scope.projectId] : []), waters.authenticatedGrants ?? 0,
      scope.workspaceId, ...(projectId ? [projectId] : []),
      ...(canonicalHistoryStart?[waters.projectAccessHistory??0,context.root.source_id,...(projectId?[projectId]:[])]:[]),
      ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `authenticated-grant:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor("staff"), resource: { type: "authenticated_delivery_grant", label: "Authenticated delivery access" },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! }));
  }

  if (policies.deliveryAudit && scope.workspaceId && succeeded
    && (filters.actorType === "all" || ["staff", "client", "system"].includes(filters.actorType))) {
    const lifecycle = ["target.created", "target.revoked", "delegation.created", "delegation.transferred", "delegation.revoked",
      "client_share.created", "client_share.revoked"];
    const at = timeExpression("event.created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'delegated-share:'||event.id", producer, after),
      actorExpression = "CASE WHEN event.actor_type='staff' THEN 'staff' WHEN event.actor_type='client' THEN 'client' ELSE 'system' END",
      actorPredicate = filters.actorType === "all" ? "" : ` AND ${actorExpression}=?`;
    const rows = await db.prepare(`SELECT event.rowid,event.id event_id,event.event_type action,${actorExpression} actor_type,${at} occurred_at
      FROM client_delegated_share_events event
      LEFT JOIN client_delegated_shares share_record ON share_record.id=event.share_id AND share_record.workspace_id=event.workspace_id
      LEFT JOIN client_share_delegations delegation ON delegation.id=COALESCE(event.delegation_id,share_record.delegation_id)
        AND delegation.workspace_id=event.workspace_id
      LEFT JOIN client_share_folder_targets target ON target.id=COALESCE(share_record.folder_target_id,delegation.root_target_id)
        AND target.workspace_id=event.workspace_id
      LEFT JOIN portal_v2_folder_bindings binding ON binding.id=target.folder_binding_id AND binding.workspace_id=event.workspace_id
      ${projectId ? `JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.project_alpha_source_id=?
      JOIN projects project_record ON project_record.id=? AND project_record.active=1
        AND project_record.project_alpha_source_id=workspace.project_alpha_source_id
        AND project_record.project_alpha_project_id=binding.owner_public_id` : ""}
      WHERE event.rowid<=? AND event.workspace_id=? AND event.event_type IN (${lifecycle.map(() => "?").join(",")})
      ${projectId ? "AND event.event_type NOT LIKE 'target.%' AND binding.owner_scope_type='project' AND binding.owner_public_id=?" : ""}
      ${actorPredicate} AND ${bounds.sql}${continuation.sql} ORDER BY ${at} DESC,event.id ASC LIMIT ?`)
      .bind(...(projectId ? [context.root.source_id, scope.projectId] : []), waters.delegatedShares ?? 0,
        scope.workspaceId, ...lifecycle, ...(projectId ? [projectId] : []),
        ...(filters.actorType === "all" ? [] : [filters.actorType]), ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `delegated-share:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor(row.actor_type), resource: { type: "delegated_client_share", label: "Delegated client sharing access" },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! }));
  }

  if (policies.viewerManage && scope.accountId && (!projectId || scope.projectId) && succeeded
    && (filters.actorType === "all" || filters.actorType === "staff")) {
    const at = timeExpression("audit.created_at"), bounds = timeBounds(filters, asOf, at),
      continuation = seek(at, "'viewer-grant:'||audit.id", producer, after);
    const rows = await db.prepare(`SELECT audit.rowid,audit.id event_id,audit.action,'staff' actor_type,${at} occurred_at
      FROM viewer_client_grant_audit audit JOIN viewer_client_grants grant_record ON grant_record.id=audit.grant_id
      WHERE audit.rowid<=? AND grant_record.account_id=? AND audit.action IN ('grant.created','grant.revoked')
      ${projectId ? "AND grant_record.project_id=?" : ""} AND ${bounds.sql}${continuation.sql}
      ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(waters.viewerGrants ?? 0, scope.accountId,
      ...(projectId ? [scope.projectId] : []), ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
    for (const row of rows.results) candidates.push(item({ sourceId: context.root.source_id, producer,
      producerEventId: `viewer-grant:${String(row.event_id)}`, category: "access", action: row.action,
      actor: actor("staff"), resource: { type: "viewer_client_grant", label: "3D Viewer client access" },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! }));
  }
  return candidates;
}

async function projectAccessHistoryCandidates(env:Env,context:ClientHubCollectionContext,filters:ClientAuditTimelineFilters,
  projectId:string|null,asOf:string,after:TimelineCursor['after'],water:number,limit:number):Promise<ClientAuditTimelineItem[]>{
  if(filters.category!=='all'&&filters.category!=='access')return [];
  const actorExpression=`CASE actor_type WHEN 'identity' THEN 'client' WHEN 'staff' THEN 'staff' ELSE 'system' END`,
    resultExpression=`CASE WHEN event_kind='access_expired' THEN 'informational' ELSE 'succeeded' END`,at='occurred_at',
    bounds=timeBounds(filters,asOf,at),eventId=`'project-access:'||printf('%020d',recorded_sequence)||':'||id`,
    continuation=seek(at,eventId,'portal_access',after),actorPredicate=filters.actorType==='all'?'':` AND ${actorExpression}=?`,
    resultPredicate=filters.result==='all'?'':` AND ${resultExpression}=?`;
  const rows=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT recorded_sequence rowid,${eventId} event_id,event_kind action,
      ${actorExpression} actor_type,occurred_at FROM portal_project_access_authority_events
    WHERE recorded_sequence<=? AND workspace_id=? AND source_id=? ${projectId?'AND project_public_id=?':''}
      ${actorPredicate}${resultPredicate} AND ${bounds.sql}${continuation.sql}
    ORDER BY julianday(occurred_at) DESC,recorded_sequence ASC LIMIT ?`).bind(water,context.root.workspace_id,context.root.source_id,
      ...(projectId?[projectId]:[]),...(filters.actorType==='all'?[]:[filters.actorType]),...(filters.result==='all'?[]:[filters.result]),
      ...bounds.values,...continuation.values,limit+1).all<CandidateRow>();
  return rows.results.map(row=>item({sourceId:context.root.source_id,producer:'portal_access',producerEventId:String(row.event_id),category:'access',
    action:`project_access.${safeText(row.action,'changed',80)}`,actor:actor(row.actor_type),resource:{type:'project_access',label:'Project access'},
    result:row.action==='access_expired'?'informational':'succeeded',occurredAt:normalizeTime(row.occurred_at)!}));
}

async function operationalProjectCandidates(env: Env, context: ClientHubCollectionContext,
  filters: ClientAuditTimelineFilters, projectId: string | null, asOf: string,
  after: TimelineCursor["after"], water: number, limit: number,
  policy: Awaited<ReturnType<typeof readClientHubBusinessProjectPolicy>>, available: boolean,
): Promise<ClientAuditTimelineItem[]> {
  if (!available || context.root.root_namespace !== "business"
    || !allowedByFilters(filters, "project", "staff", "succeeded")) return [];
  const producer: Producer = "operations", at = timeExpression("event.created_at"),
    bounds = timeBounds(filters, asOf, at),
    continuation = seek(at, "'operational-project:'||event.id", producer, after),
    rootKind = context.root.kind === "organization" ? "organization" : "client";
  const ownership = context.root.kind === "organization"
    ? "(p.organization_id=? OR (p.organization_id IS NULL AND owner.organization_id=?))"
    : "p.client_id=? AND p.organization_id IS NULL AND owner.id IS NOT NULL AND owner.organization_id IS NULL";
  const ownershipValues = context.root.kind === "organization"
    ? [context.root.public_id, context.root.public_id] : [context.root.public_id];
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT event.rowid,event.id event_id,
      event.event_kind,event.project_id resource_id,p.name resource_label,${at} occurred_at,
      CASE WHEN json_valid(event.details_json) AND json_type(event.details_json,'$.copied')='true' THEN 1 ELSE 0 END copied
    FROM project_operational_events event
    JOIN pa_projection_record_ids handle ON handle.projection_source_id=event.projection_source_id
      AND handle.record_kind='project' AND handle.local_id=event.project_id
    JOIN pa_projects p ON p.id=event.project_id AND p.projection_source_id=event.projection_source_id AND p.active=1
    LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    JOIN staff_users event_actor ON event_actor.id=event.actor_id
    WHERE event.rowid<=? AND event.projection_source_id=? AND event.project_record_kind='project'
      AND event.event_kind IN ('contacts_saved','memory_saved','memory_amended')
      AND (${ownership}) AND (${policy.filter.sql})
      ${projectId ? "AND event.project_id=?" : ""}
      AND ((event.event_kind='contacts_saved' AND EXISTS (
        SELECT 1 FROM project_operational_contact_sets current
        JOIN project_operational_contact_revisions revision
          ON revision.projection_source_id=current.projection_source_id AND revision.project_id=current.project_id
          AND revision.version=event.result_version AND revision.actor_id=event.actor_id
        WHERE current.projection_source_id=event.projection_source_id AND current.project_id=event.project_id
          AND current.project_record_kind='project' AND current.root_record_kind=? AND current.root_id=?
          AND current.version>=event.result_version))
      OR (event.event_kind IN ('memory_saved','memory_amended') AND EXISTS (
        SELECT 1 FROM project_operational_memory current
        JOIN project_operational_memory_revisions revision
          ON revision.projection_source_id=current.projection_source_id AND revision.project_id=current.project_id
          AND revision.version=event.result_version AND revision.actor_id=event.actor_id
          AND revision.change_kind=CASE event.event_kind WHEN 'memory_amended' THEN 'post_completion_amendment' ELSE 'saved' END
        WHERE current.projection_source_id=event.projection_source_id AND current.project_id=event.project_id
          AND current.project_record_kind='project' AND current.root_record_kind=? AND current.root_id=?
          AND current.version>=event.result_version)))
      AND ${bounds.sql}${continuation.sql}
    ORDER BY ${at} DESC,event.id ASC LIMIT ?`).bind(water, context.root.source_id,
      ...ownershipValues, ...policy.filter.values, ...(projectId ? [projectId] : []),
      rootKind, context.root.public_id, rootKind, context.root.public_id,
      ...bounds.values, ...continuation.values, limit + 1)
    .all<CandidateRow & { event_kind: "contacts_saved" | "memory_saved" | "memory_amended"; copied: number }>();
  const path = rootPath(context);
  return rows.results.map(row => {
    const resourceId = identifier.safeParse(row.resource_id).success ? String(row.resource_id) : null;
    const action = row.event_kind === "contacts_saved"
      ? row.copied === 1 ? "project.contacts.copied_forward" : "project.contacts.saved"
      : row.event_kind === "memory_amended" ? "project.memory.amended"
        : row.copied === 1 ? "project.memory.copied_forward" : "project.memory.saved";
    return item({ sourceId: context.root.source_id, producer,
      producerEventId: `operational-project:${String(row.event_id)}`, category: "project", action,
      actor: actor("staff"), resource: { type: "project_operational_record",
        ...(resourceId ? { id: resourceId, detailPath: `${path}/projects/${encodeURIComponent(resourceId)}` } : {}),
        label: safeText(row.resource_label, "Project", 180) },
      result: "succeeded", occurredAt: normalizeTime(row.occurred_at)! });
  });
}

async function deliveryCandidates(env: Env, context: ClientHubCollectionContext, scope: DeliveryScope,
  filters: ClientAuditTimelineFilters, asOf: string, after: TimelineCursor["after"], water: number,
  limit: number): Promise<ClientAuditTimelineItem[]> {
  if (!scope.accountId || !context.access.delivery || !["all", "delivery", "notification"].includes(filters.category)) return [];
  const producer: Producer = "client_delivery", at = timeExpression("audit.created_at"), bounds = timeBounds(filters, asOf, at),
    continuation = seek(at, "audit.id", producer, after);
  const lifecycle = ["share.created", "share.updated", "share.revoked", "share.auto_revoked"];
  const notifications = ["notification.sent", "notification.suppressed", "notification.failed", "notification.retry_scheduled"];
  const requestedActions = filters.category === "delivery" ? lifecycle : filters.category === "notification" ? notifications : [...lifecycle, ...notifications];
  const placeholders = requestedActions.map(() => "?").join(",");
  const actorExpression = "CASE WHEN audit.actor_type='staff' THEN 'staff' WHEN audit.actor_type='integration' THEN 'integration' "
    + "WHEN audit.actor_type='public' THEN 'public' ELSE 'system' END";
  const resultExpression = "CASE WHEN audit.action LIKE '%.failed' THEN 'failed' WHEN audit.action LIKE '%.suppressed' THEN 'denied' "
    + "WHEN audit.action LIKE '%.retry_scheduled' THEN 'informational' ELSE 'succeeded' END";
  const actorPredicate = filters.actorType === "all" ? "" : ` AND ${actorExpression}=?`;
  const resultPredicate = filters.result === "all" ? "" : ` AND ${resultExpression}=?`;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT audit.rowid,audit.id event_id,audit.action,
    audit.actor_type,${at} occurred_at,share.id resource_id,share.label resource_label
    FROM audit_log audit JOIN shares share ON audit.entity_type='share' AND share.id=audit.entity_id
    JOIN projects project ON project.id=share.project_id AND project.active=1
    JOIN client_project_grants grant_record ON grant_record.project_id=project.id AND grant_record.account_id=? AND grant_record.revoked_at IS NULL
    WHERE audit.rowid<=? ${scope.projectId ? "AND project.id=?" : ""} AND audit.action IN (${placeholders})
      ${actorPredicate}${resultPredicate} AND ${bounds.sql}${continuation.sql} ORDER BY ${at} DESC,CAST(audit.id AS TEXT) ASC LIMIT ?`).bind(scope.accountId, water,
      ...(scope.projectId ? [scope.projectId] : []), ...requestedActions,
      ...(filters.actorType === "all" ? [] : [filters.actorType]), ...(filters.result === "all" ? [] : [filters.result]),
      ...bounds.values, ...continuation.values, limit + 1).all<CandidateRow>();
  return rows.results.flatMap(row => {
    const category: ClientAuditTimelineCategory = row.action.startsWith("notification.") ? "notification" : "delivery";
    const result: ClientAuditTimelineResult = row.action.endsWith(".failed") ? "failed"
      : row.action.endsWith(".suppressed") ? "denied" : row.action.endsWith(".retry_scheduled") ? "informational" : "succeeded";
    const actorValue = row.actor_type === "staff" ? "staff" : row.actor_type === "integration" ? "integration"
      : row.actor_type === "public" ? "public" : "system";
    if (!allowedByFilters(filters, category, actorValue, result)) return [];
    return [item({ sourceId: context.root.source_id, producer, producerEventId: String(row.event_id), category,
      action: safeText(row.action, `${category}.updated`, 100), actor: actor(actorValue),
      resource: { type: "delivery_share", id: safeText(row.resource_id, "share", 512),
        label: safeText(row.resource_label, "Client delivery link", 180) }, result,
      occurredAt: normalizeTime(row.occurred_at)! })];
  });
}

const PROJECT_ACCESS_COLLABORATOR_NOTICE_TABLES = [
  "portal_project_access_notice_audit", "portal_project_access_notice_outbox", "portal_project_access_terms",
] as const;
const PROJECT_ACCESS_COMPANION_NOTICE_TABLES = [
  "portal_project_access_companion_notice_audit", "portal_project_access_companion_notice_outbox", "portal_project_access_terms",
] as const;
const OPERATIONAL_PROJECT_EVENT_TABLES = [
  "project_operational_events", "project_operational_contact_sets", "project_operational_contact_revisions",
  "project_operational_memory", "project_operational_memory_revisions",
] as const;
const ORGANIZATION_CONTACT_EVENT_TABLES=[
  'organization_operational_events','organization_operational_contact_sets','organization_operational_contact_revisions',
] as const;

async function organizationContactCandidates(env:Env,context:ClientHubCollectionContext,filters:ClientAuditTimelineFilters,
  projectId:string|null,asOf:string,after:TimelineCursor['after'],water:number,limit:number,available:boolean):Promise<ClientAuditTimelineItem[]>{
  if(!available||projectId||!allowedByFilters(filters,'project','staff','succeeded'))return [];
  const producer:Producer='operations',at=timeExpression('event.created_at'),bounds=timeBounds(filters,asOf,at),
    continuation=seek(at,"'organization-contacts:'||event.id",producer,after);
  const rows=await env.OPS_DB.withSession('first-primary').prepare(`SELECT event.rowid,event.id event_id,event.event_kind action,
      'staff' actor_type,${at} occurred_at,organization.name resource_label
    FROM organization_operational_events event
    JOIN organization_operational_contact_sets current ON current.projection_source_id=event.projection_source_id
      AND current.organization_id=event.organization_id AND current.version>=event.result_version
    JOIN organization_operational_contact_revisions revision ON revision.projection_source_id=event.projection_source_id
      AND revision.organization_id=event.organization_id AND revision.version=event.result_version AND revision.actor_id=event.actor_id
    JOIN pa_projection_record_ids handle ON handle.projection_source_id=event.projection_source_id
      AND handle.record_kind='organization' AND handle.local_id=event.organization_id
    JOIN pa_organizations organization ON organization.id=event.organization_id
      AND organization.projection_source_id=event.projection_source_id AND organization.active=1
    JOIN staff_users actor_record ON actor_record.id=event.actor_id
    WHERE event.rowid<=? AND event.projection_source_id=? AND event.organization_record_kind='organization'
      AND event.organization_id=? AND event.event_kind='contacts_saved' AND ${bounds.sql}${continuation.sql}
    ORDER BY ${at} DESC,event.id ASC LIMIT ?`).bind(water,context.root.source_id,context.root.public_id,
      ...bounds.values,...continuation.values,limit+1).all<CandidateRow>();
  return rows.results.map(row=>item({sourceId:context.root.source_id,producer,producerEventId:`organization-contacts:${String(row.event_id)}`,
    category:'project',action:'organization.contacts.saved',actor:actor('staff'),resource:{type:'organization_operational_contacts',
      label:safeText(row.resource_label,'Organization operational contacts',180)},result:'succeeded',occurredAt:normalizeTime(row.occurred_at)!}));
}

async function projectAccessNoticeCandidates(env: Env, context: ClientHubCollectionContext,
  filters: ClientAuditTimelineFilters, projectId: string | null, asOf: string, after: TimelineCursor["after"],
  water: number, limit: number, available: boolean): Promise<ClientAuditTimelineItem[]> {
  if (!available || !["all", "notification"].includes(filters.category)
    || !["all", "system"].includes(filters.actorType)) return [];
  const producer: Producer = "portal_access", at = timeExpression("audit.created_at"),
    bounds = timeBounds(filters, asOf, at), continuation = seek(at, "'project-access-notice:'||audit.id", producer, after);
  const actions = ["notice.staged", "notice.sent", "notice.suppressed", "notice.retry_scheduled", "notice.failed"];
  const eventTypes = ["warning_7d", "warning_24h", "expired"];
  const resultExpression = "CASE WHEN audit.action='notice.sent' THEN 'succeeded' WHEN audit.action='notice.failed' THEN 'failed' ELSE 'informational' END";
  const resultPredicate = filters.result === "all" ? "" : ` AND ${resultExpression}=?`;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT audit.rowid,audit.id event_id,
    audit.action,audit.event_type,'system' actor_type,${at} occurred_at
    FROM portal_project_access_notice_audit audit
    JOIN portal_project_access_notice_outbox outbox ON outbox.id=audit.outbox_id
      AND outbox.workspace_id=audit.workspace_id AND outbox.project_public_id=audit.project_public_id
      AND outbox.identity_id=audit.identity_id AND outbox.event_type=audit.event_type
    JOIN portal_project_access_terms terms ON terms.id=outbox.access_terms_id
      AND terms.workspace_id=outbox.workspace_id AND terms.source_id=outbox.source_id
      AND terms.project_public_id=outbox.project_public_id AND terms.kind='collaborator'
    JOIN portal_v2_workspaces workspace ON workspace.id=terms.workspace_id
      AND workspace.project_alpha_source_id=terms.source_id AND workspace.status='active'
    WHERE audit.rowid<=? AND audit.workspace_id=? AND outbox.source_id=?
      ${projectId ? "AND audit.project_public_id=?" : ""}
      AND audit.action IN (${actions.map(() => "?").join(",")})
      AND audit.event_type IN (${eventTypes.map(() => "?").join(",")})
      ${resultPredicate} AND ${bounds.sql}${continuation.sql}
    ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(water, context.root.workspace_id, context.root.source_id,
      ...(projectId ? [projectId] : []), ...actions, ...eventTypes,
      ...(filters.result === "all" ? [] : [filters.result]), ...bounds.values, ...continuation.values, limit + 1)
    .all<CandidateRow & { event_type: "warning_7d" | "warning_24h" | "expired" }>();
  return rows.results.map(row => {
    const result: ClientAuditTimelineResult = row.action === "notice.sent" ? "succeeded"
      : row.action === "notice.failed" ? "failed" : "informational";
    return item({ sourceId: context.root.source_id, producer,
      producerEventId: `project-access-notice:${String(row.event_id)}`, category: "notification",
      action: `project_access.collaborator.${row.event_type}.${row.action.slice("notice.".length)}`, actor: actor("system"),
      resource: { type: "project_access_notice", label: "Project access notice" }, result,
      occurredAt: normalizeTime(row.occurred_at)! });
  });
}

async function projectAccessCompanionNoticeCandidates(env: Env, context: ClientHubCollectionContext,
  filters: ClientAuditTimelineFilters, projectId: string | null, asOf: string, after: TimelineCursor["after"],
  water: number, limit: number, available: boolean): Promise<ClientAuditTimelineItem[]> {
  if (!available || !["all", "notification"].includes(filters.category)
    || !["all", "system"].includes(filters.actorType)) return [];
  const producer: Producer = "portal_access", at = timeExpression("audit.created_at"),
    bounds = timeBounds(filters, asOf, at), continuation = seek(at, "'project-access-companion-notice:'||audit.id", producer, after);
  const actions = ["notice.staged", "notice.sent", "notice.suppressed", "notice.retry_scheduled", "notice.failed"];
  const eventTypes = ["warning_7d", "warning_24h", "expired"], roles = ["inviter", "access_creator"];
  const resultExpression = "CASE WHEN audit.action='notice.sent' THEN 'succeeded' WHEN audit.action='notice.failed' THEN 'failed' ELSE 'informational' END";
  const resultPredicate = filters.result === "all" ? "" : ` AND ${resultExpression}=?`;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT audit.rowid,audit.id event_id,
    audit.action,audit.event_type,audit.recipient_role,'system' actor_type,${at} occurred_at
    FROM portal_project_access_companion_notice_audit audit
    JOIN portal_project_access_companion_notice_outbox outbox ON outbox.id=audit.outbox_id
      AND outbox.workspace_id=audit.workspace_id AND outbox.project_public_id=audit.project_public_id
      AND outbox.recipient_role=audit.recipient_role AND outbox.event_type=audit.event_type
    JOIN portal_project_access_terms terms ON terms.id=outbox.access_terms_id
      AND terms.workspace_id=outbox.workspace_id AND terms.source_id=outbox.source_id
      AND terms.project_public_id=outbox.project_public_id AND terms.kind='collaborator'
    JOIN portal_v2_workspaces workspace ON workspace.id=terms.workspace_id
      AND workspace.project_alpha_source_id=terms.source_id AND workspace.status='active'
    WHERE audit.rowid<=? AND audit.workspace_id=? AND outbox.source_id=?
      ${projectId ? "AND audit.project_public_id=?" : ""}
      AND audit.action IN (${actions.map(() => "?").join(",")})
      AND audit.event_type IN (${eventTypes.map(() => "?").join(",")})
      AND audit.recipient_role IN (${roles.map(() => "?").join(",")})
      ${resultPredicate} AND ${bounds.sql}${continuation.sql}
    ORDER BY ${at} DESC,audit.id ASC LIMIT ?`).bind(water, context.root.workspace_id, context.root.source_id,
      ...(projectId ? [projectId] : []), ...actions, ...eventTypes, ...roles,
      ...(filters.result === "all" ? [] : [filters.result]), ...bounds.values, ...continuation.values, limit + 1)
    .all<CandidateRow & { event_type: "warning_7d" | "warning_24h" | "expired"; recipient_role: "inviter" | "access_creator" }>();
  return rows.results.map(row => {
    const result: ClientAuditTimelineResult = row.action === "notice.sent" ? "succeeded"
      : row.action === "notice.failed" ? "failed" : "informational";
    return item({ sourceId: context.root.source_id, producer,
      producerEventId: `project-access-companion-notice:${String(row.event_id)}`, category: "notification",
      action: `project_access.${row.recipient_role}.${row.event_type}.${row.action.slice("notice.".length)}`, actor: actor("system"),
      resource: { type: "project_access_notice", label: "Project access notice" }, result,
      occurredAt: normalizeTime(row.occurred_at)! });
  });
}

async function currentWatermarks(env: Env, context: ClientHubCollectionContext, scope: DeliveryScope,
  policies: { portal: boolean; deliveryAudit: boolean; viewerManage: boolean },
  collaboratorNoticeSchema: boolean, companionNoticeSchema: boolean,
  operationalProjectSchema: boolean,organizationContactSchema:boolean,projectAccessHistoryAvailable:boolean,projectPublicId:string|null): Promise<Record<string, number>> {
  const ops = env.OPS_DB.withSession("first-primary"), delivery = env.DELIVERY_DB.withSession("first-primary");
  const waters: Record<string, number> = {};
  if (context.root.root_namespace === "business") waters.business = await ops.prepare("SELECT COALESCE(MAX(sequence),0) value FROM client_business_activity").first<number>("value") ?? 0;
  if (scope.accountId && context.access.requests) waters.requests = await maxRowid(delivery, "request_revisions");
  if (scope.workspaceId && policies.portal) {
    waters.memberships = await maxRowid(delivery, "portal_v2_membership_audit");
    waters.invitationRequests = await maxRowid(delivery, "portal_workspace_invitation_request_audit");
    waters.peerAdministrators = await maxRowid(delivery, "portal_workspace_peer_admin_audit");
    waters.identityDenials = await maxRowid(delivery, "portal_v2_identity_denial_audit");
  }
  if (scope.workspaceId && policies.deliveryAudit) {
    waters.authenticatedGrants = await maxRowid(delivery, "portal_v2_authenticated_delivery_grant_audit");
    waters.delegatedShares = await maxRowid(delivery, "client_delegated_share_events");
  }
  if (scope.accountId && policies.viewerManage) waters.viewerGrants = await maxRowid(delivery, "viewer_client_grant_audit");
  if (scope.accountId && policies.deliveryAudit) waters.deliveryAudit = await maxRowid(delivery, "audit_log");
  if (scope.workspaceId && policies.portal && collaboratorNoticeSchema)
    waters.projectAccessNotices = await maxRowid(delivery, "portal_project_access_notice_audit");
  if (scope.workspaceId && policies.portal && companionNoticeSchema)
    waters.projectAccessCompanionNotices = await maxRowid(delivery, "portal_project_access_companion_notice_audit");
  if (context.root.root_namespace === "business" && operationalProjectSchema)
    waters.operationalProjects = await maxRowid(ops, "project_operational_events");
  if(organizationContactSchema&&context.root.root_namespace==='business'&&context.root.kind==='organization')
    waters.organizationContacts=await ops.prepare(`SELECT COALESCE(MAX(rowid),0) value FROM organization_operational_events
      WHERE projection_source_id=? AND organization_id=?`).bind(context.root.source_id,context.root.public_id).first<number>('value')??0;
  if(projectAccessHistoryAvailable)waters.projectAccessHistory=await delivery.prepare(`SELECT COALESCE(MAX(recorded_sequence),0) value
    FROM portal_project_access_authority_events WHERE workspace_id=? AND source_id=? ${projectPublicId?'AND project_public_id=?':''}`)
    .bind(context.root.workspace_id,context.root.source_id,...(projectPublicId?[projectPublicId]:[])).first<number>('value')??0;
  return waters;
}

/** Staff-only, read-only federation over already-recorded meaningful events.
 * It never treats a business-party link, cursor, display cache or event actor as
 * authorization. Raw payloads, notes, addresses, storage keys and proofs are
 * not selected and therefore cannot cross the response boundary. */
export async function listClientAuditTimeline(env: Env, principal: StaffPrincipal, context: ClientHubCollectionContext,
  options: { projectId?: string; expectedContextVersion?: string; filters?: ClientAuditTimelineFilters;
    limit?: number; cursor?: string } = {}): Promise<ClientAuditTimelinePage> {
  const projectId = options.projectId ?? null, limit = options.limit ?? 10, filters = options.filters ?? {
    category: "all", actorType: "all", result: "all", from: null, to: null,
  };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (projectId !== null && !identifier.safeParse(projectId).success)
    || (options.expectedContextVersion !== undefined && !proof.safeParse(options.expectedContextVersion).success)
    || !filtersSchema.safeParse(filters).success) throw new HTTPException(400, { message: "Client timeline query is invalid" });
  if (!context.access.directory) throw new HTTPException(403, { message: "Global team.view permission required" });
  if (options.expectedContextVersion !== undefined && options.expectedContextVersion !== context.contextVersion) changed();
  const detail = projectId ? await readClientHubBusinessProjectDetail(env, principal, context, projectId,
    { expectedContextVersion: options.expectedContextVersion }) : null;
  const projectProof = detail ? await sha256(JSON.stringify(detail.project)) : null;
  const scope = await deliveryScope(env, context, projectId), policy = await readClientHubBusinessProjectPolicy(env, principal),
    deliveryAuditPolicy = await readDeliveryAuditPolicy(env, principal),
    viewerManagePolicy = await readViewerManagePolicy(env, principal), portalPolicy = await readPortalPolicy(env, principal),
    noticeScope = await projectAccessNoticeScopeProof(env, context),
    collaboratorNoticeSchema = await d1TablesPresent(env.DELIVERY_DB, PROJECT_ACCESS_COLLABORATOR_NOTICE_TABLES),
    companionNoticeSchema = await d1TablesPresent(env.DELIVERY_DB, PROJECT_ACCESS_COMPANION_NOTICE_TABLES),
    operationalProjectSchema = await d1TablesPresent(env.OPS_DB, OPERATIONAL_PROJECT_EVENT_TABLES),
    organizationContactSchema=await d1TablesPresent(env.OPS_DB,ORGANIZATION_CONTACT_EVENT_TABLES),
    projectAccessHistory=await projectAccessHistoryState(env),
    source = context.root.root_namespace === "business" ? await clientHubBusinessProjectSourceProof(env, context)
      : await sha256(JSON.stringify([rootTuple(context), "not-business"]));
  const businessRevision = context.root.root_namespace === "business"
    ? await env.OPS_DB.withSession("first-primary").prepare("SELECT revision FROM client_business_activity_state WHERE singleton=1").first<number>("revision") ?? 0 : 0;
  const cursor = options.cursor ? await decodeCursor(env, principal, options.cursor) : null;
  if (cursor && (cursor.actor !== principal.id || JSON.stringify(cursor.root) !== JSON.stringify(rootTuple(context))
    || cursor.projectId !== projectId || JSON.stringify(cursor.filters) !== JSON.stringify(filters)))
    throw new HTTPException(400, { message: "Client timeline cursor does not match this view" });
  if (cursor && (cursor.expires < Date.now() || cursor.context !== context.contextVersion || cursor.scope !== scope.proof
    || cursor.project !== projectProof || cursor.businessPolicy !== policy.proof || cursor.businessSource !== source
    || cursor.businessRevision !== businessRevision || cursor.deliveryAuditPolicy !== deliveryAuditPolicy.proof
    || cursor.viewerManagePolicy !== viewerManagePolicy.proof || cursor.portalPolicy !== portalPolicy.proof
    || cursor.noticeScope !== noticeScope.proof
    || cursor.collaboratorNoticeSchema !== collaboratorNoticeSchema
    || cursor.companionNoticeSchema !== companionNoticeSchema
    || cursor.operationalProjectSchema !== operationalProjectSchema
    || cursor.organizationContactSchema!==organizationContactSchema
    || cursor.projectAccessHistory !== projectAccessHistory.collectedSince)) changed();
  const accessPolicies = { portal: context.access.requests && portalPolicy.allowed, deliveryAudit: deliveryAuditPolicy.allowed,
    viewerManage: viewerManagePolicy.allowed };
  const asOf = cursor?.asOf ?? new Date().toISOString(), waters = cursor?.waters
    ?? await currentWatermarks(env, context, scope, accessPolicies, collaboratorNoticeSchema, companionNoticeSchema,
      operationalProjectSchema,organizationContactSchema,projectAccessHistory.collectedSince!==null,projectId);
  const secondary = context.root.root_namespace === "business" && context.root.source_id !== PRIMARY_ALPHA_SOURCE_ID;
  const sourceAvailable = context.root.root_namespace === "business";
  const requestAvailable = !secondary && Boolean(scope.accountId) && context.access.requests;
  const accessAvailable = !secondary && (Boolean(scope.workspaceId) && (accessPolicies.portal || accessPolicies.deliveryAudit)
    || Boolean(scope.accountId) && accessPolicies.viewerManage);
  const deliveryAvailable = !secondary && Boolean(scope.accountId) && deliveryAuditPolicy.allowed;
  const projectAccessCollaboratorNoticeAvailable = !secondary && Boolean(scope.workspaceId) && noticeScope.available
    && accessPolicies.portal && collaboratorNoticeSchema;
  const projectAccessCompanionNoticeAvailable = !secondary && Boolean(scope.workspaceId) && noticeScope.available
    && accessPolicies.portal && companionNoticeSchema;
  const sourceProjectAvailable = context.root.root_namespace === "business";
  const operationalProjectAvailable = sourceProjectAvailable && operationalProjectSchema && policy.allowed;
  const organizationContactAvailable=sourceProjectAvailable&&context.root.kind==='organization'&&organizationContactSchema&&policy.allowed&&!projectId;
  const projectAccessAvailable=context.root.root_namespace==='business'&&Boolean(context.root.workspace_id)&&noticeScope.available
    &&projectAccessHistory.collectedSince!==null&&portalPolicy.allowed;
  const projectCoverage = Object.fromEntries(CLIENT_AUDIT_TIMELINE_PROJECT_ADAPTERS.map(adapter => {
    const available = adapter === "source_record_activity" ? sourceProjectAvailable
      :adapter==='organization_contact_activity'?organizationContactAvailable:operationalProjectAvailable;
    const reason: CoverageReason = available ? null : context.root.root_namespace !== "business" ? "not_applicable"
      :adapter==='organization_contact_activity'&&(context.root.kind!=='organization'||projectId)?'not_applicable'
        :!policy.allowed?'permission_required':'not_collected';
    return [adapter, coverage(available, reason)];
  })) as ClientAuditTimelinePage["projectCoverage"];
  const adapterCoverage = Object.fromEntries(CLIENT_AUDIT_TIMELINE_ACCESS_ADAPTERS.map(adapter => {
    const portalAdapter = ["workspace_membership", "workspace_invitation_request", "workspace_peer_administrator", "portal_identity_denial"].includes(adapter);
    const deliveryAdapter = ["authenticated_delivery_grant", "delegated_client_share"].includes(adapter);
    const viewerAdapter = adapter === "viewer_client_grant";
    const clientOnly = adapter === "workspace_membership" || adapter === "workspace_peer_administrator";
    const available = adapter==='project_access'?projectAccessAvailable:!secondary && !(projectId && clientOnly) && (portalAdapter ? Boolean(scope.workspaceId) && accessPolicies.portal
      : deliveryAdapter ? Boolean(scope.workspaceId) && accessPolicies.deliveryAudit
        : viewerAdapter ? Boolean(scope.accountId) && accessPolicies.viewerManage : false);
    const reason: CoverageReason = available ? null : adapter==='project_access'
      ? context.root.root_namespace!=='business'||!context.root.workspace_id||!noticeScope.available?'not_applicable'
        : projectAccessHistory.collectedSince===null?'not_collected':!portalPolicy.allowed?'permission_required':'not_collected'
      : secondary ? "unsupported_source"
      : projectId && clientOnly ? "not_applicable"
        : portalAdapter || deliveryAdapter ? !scope.workspaceId ? "not_applicable" : "permission_required"
          : !scope.accountId ? "not_applicable" : "permission_required";
    return [adapter,adapter==='project_access'?{...coverage(available,reason),collectedSince:projectAccessHistory.collectedSince}:coverage(available, reason)];
  })) as ClientAuditTimelinePage["accessCoverage"];
  const notificationCoverage = Object.fromEntries(CLIENT_AUDIT_TIMELINE_NOTIFICATION_ADAPTERS.map(adapter => {
    const available = adapter === "delivery_share_notification" ? deliveryAvailable
      : adapter === "project_access_collaborator_notice" ? projectAccessCollaboratorNoticeAvailable : projectAccessCompanionNoticeAvailable;
    const reason: CoverageReason = available ? null : secondary ? "unsupported_source"
      : adapter === "delivery_share_notification"
        ? !scope.accountId ? "not_applicable" : "permission_required"
        : !scope.workspaceId || !noticeScope.available ? "not_applicable" : !accessPolicies.portal ? "permission_required" : "not_collected";
    return [adapter, coverage(available, reason)];
  })) as ClientAuditTimelinePage["notificationCoverage"];
  const notificationAvailable = Object.values(notificationCoverage).some(value => value.available);
  const notificationUnavailableReason: CoverageReason = secondary ? "unsupported_source"
    : Object.values(notificationCoverage).some(value => value.reason === "permission_required") ? "permission_required"
      : Object.values(notificationCoverage).some(value => value.reason === "not_collected") ? "not_collected" : "not_applicable";
  const accessAdapterValues=Object.values(adapterCoverage),responseAccessAvailable=accessAdapterValues.some(value=>value.available);
  const responseAccessReason:CoverageReason=responseAccessAvailable?null:accessAdapterValues.some(value=>value.reason==='permission_required')?'permission_required'
    :accessAdapterValues.some(value=>value.reason==='not_collected')?'not_collected'
      :accessAdapterValues.some(value=>value.reason==='unsupported_source')?'unsupported_source':'not_applicable';
  const responseCoverage: ClientAuditTimelinePage["coverage"] = {
    project: coverage(Object.values(projectCoverage).some(value => value.available), "not_applicable"),
    request: coverage(requestAvailable, secondary ? "unsupported_source" : !scope.accountId ? "not_applicable" : "permission_required"),
    feedback: coverage(false, secondary ? "unsupported_source" : "not_collected"),
    access: coverage(responseAccessAvailable,responseAccessReason),
    delivery: coverage(deliveryAvailable, secondary ? "unsupported_source" : !scope.accountId ? "not_applicable" : "permission_required"),
    notification: coverage(notificationAvailable, notificationUnavailableReason),
  };
  const candidates = (await Promise.all([
    sourceAvailable ? businessCandidates(env, context, filters, projectId, asOf, cursor?.after ?? null, waters.business ?? 0, limit, policy) : [],
    operationalProjectAvailable ? operationalProjectCandidates(env, context, filters, projectId, asOf,
      cursor?.after ?? null, waters.operationalProjects ?? 0, limit, policy, operationalProjectAvailable) : [],
    organizationContactAvailable?organizationContactCandidates(env,context,filters,projectId,asOf,cursor?.after??null,
      waters.organizationContacts??0,limit,organizationContactAvailable):[],
    requestAvailable ? requestCandidates(env, context, scope, filters, asOf, cursor?.after ?? null, waters.requests ?? 0, limit) : [],
    accessAvailable ? accessCandidates(env, context, scope, filters, projectId, asOf, cursor?.after ?? null, waters, limit, accessPolicies,
      projectAccessAvailable?projectAccessHistory.collectedSince:null) : [],
    projectAccessAvailable ? projectAccessHistoryCandidates(env,context,filters,projectId,asOf,cursor?.after??null,waters.projectAccessHistory??0,limit):[],
    deliveryAvailable ? deliveryCandidates(env, context, scope, filters, asOf, cursor?.after ?? null, waters.deliveryAudit ?? 0, limit) : [],
    projectAccessCollaboratorNoticeAvailable ? projectAccessNoticeCandidates(env, context, filters, projectId, asOf,
      cursor?.after ?? null, waters.projectAccessNotices ?? 0, limit, projectAccessCollaboratorNoticeAvailable) : [],
    projectAccessCompanionNoticeAvailable ? projectAccessCompanionNoticeCandidates(env, context, filters, projectId, asOf,
      cursor?.after ?? null, waters.projectAccessCompanionNotices ?? 0, limit, projectAccessCompanionNoticeAvailable) : [],
  ])).flat().filter(candidate => candidate.occurredAt && candidate.occurredAt <= asOf).sort(compare);
  const pageItems = candidates.slice(0, limit), hasMore = candidates.length > limit;
  const [currentScope, currentPolicy, currentSource, currentRevision, currentDetail, currentDeliveryAuditPolicy,
    currentViewerManagePolicy, currentPortalPolicy, currentNoticeScope, currentCollaboratorNoticeSchema,
    currentCompanionNoticeSchema, currentOperationalProjectSchema,currentOrganizationContactSchema,currentProjectAccessHistory] = await Promise.all([
    deliveryScope(env, context, projectId), readClientHubBusinessProjectPolicy(env, principal),
    context.root.root_namespace === "business" ? clientHubBusinessProjectSourceProof(env, context) : Promise.resolve(source),
    context.root.root_namespace === "business" ? env.OPS_DB.withSession("first-primary")
      .prepare("SELECT revision FROM client_business_activity_state WHERE singleton=1").first<number>("revision") : Promise.resolve(0),
    projectId ? readClientHubBusinessProjectDetail(env, principal, context, projectId,
      { expectedContextVersion: options.expectedContextVersion }) : Promise.resolve(null), readDeliveryAuditPolicy(env, principal),
    readViewerManagePolicy(env, principal), readPortalPolicy(env, principal),
    projectAccessNoticeScopeProof(env, context),
    d1TablesPresent(env.DELIVERY_DB, PROJECT_ACCESS_COLLABORATOR_NOTICE_TABLES),
    d1TablesPresent(env.DELIVERY_DB, PROJECT_ACCESS_COMPANION_NOTICE_TABLES),
    d1TablesPresent(env.OPS_DB, OPERATIONAL_PROJECT_EVENT_TABLES),
    d1TablesPresent(env.OPS_DB,ORGANIZATION_CONTACT_EVENT_TABLES),
    projectAccessHistoryState(env),
  ]);
  if (currentScope.proof !== scope.proof || currentPolicy.proof !== policy.proof || currentSource !== source
    || currentRevision !== businessRevision || currentDeliveryAuditPolicy.proof !== deliveryAuditPolicy.proof
    || currentViewerManagePolicy.proof !== viewerManagePolicy.proof
    || currentPortalPolicy.proof !== portalPolicy.proof
    || currentNoticeScope.proof !== noticeScope.proof
    || currentCollaboratorNoticeSchema !== collaboratorNoticeSchema
    || currentCompanionNoticeSchema !== companionNoticeSchema
    || currentOperationalProjectSchema !== operationalProjectSchema
    || currentOrganizationContactSchema!==organizationContactSchema
    || currentProjectAccessHistory.proof!==projectAccessHistory.proof
    || (currentDetail && await sha256(JSON.stringify(currentDetail.project)) !== projectProof)) changed();
  const last = pageItems.at(-1);
  return { canonicalRoot: context.canonicalRoot, projectId, contextVersion: context.contextVersion,
    refreshedAt: new Date().toISOString(), asOf, coverage: responseCoverage, projectCoverage, accessCoverage: adapterCoverage,
    notificationCoverage,
    filters, items: pageItems,
    page: { returned: pageItems.length, limit, hasMore, nextCursor: hasMore && last ? await encodeCursor(env, principal, {
      v: 7, actor: principal.id, root: rootTuple(context), projectId, context: context.contextVersion, scope: scope.proof,
      project: projectProof, businessPolicy: policy.proof, businessSource: source, businessRevision,
      deliveryAuditPolicy: deliveryAuditPolicy.proof, viewerManagePolicy: viewerManagePolicy.proof,
      portalPolicy: portalPolicy.proof, noticeScope: noticeScope.proof, collaboratorNoticeSchema, companionNoticeSchema,
      operationalProjectSchema,organizationContactSchema,projectAccessHistory:projectAccessHistory.collectedSince,
      filters, asOf, waters, after: [last.occurredAt, last.producer, last.producerEventId], expires: Date.now() + 30 * 60_000,
    }) : null } };
}
