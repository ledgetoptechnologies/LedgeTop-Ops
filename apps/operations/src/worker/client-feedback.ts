import type { ClientFeedbackEvent, ClientFeedbackStatus, StaffClientFeedbackItem } from "@ltds/shared";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { FeedbackStoreError, readFeedbackRecord, transitionFeedbackRecord, type FeedbackRecord, type FeedbackWriteGuard } from "../../../client/src/worker/client-portal/feedback-store";
import { feedbackSourceOwnerSource } from "../../../client/src/worker/client-portal/feedback-target";
import { readNativeFeedbackRecord,transitionNativeFeedbackRecord,type NativeFeedbackRecord } from "../../../client/src/worker/client-portal/native-feedback-store";
import { reauthorizeNativeFeedbackRecipient } from "../../../client/src/worker/client-portal/native-feedback-target";
import { nativeFeedbackNotificationsSchemaAvailable } from "../../../client/src/worker/client-portal/native-feedback-authority";
import { evaluatePermission, isAdministrator, loadGrants, type SqlScope } from "./acl";
import { base64Url, sha256 } from "./crypto";
import { d1TablesPresent } from "./schema-readiness";
import { paProjectFilter } from "./visibility";
import { isAlphaPublicId,validatedUniquePublicIdExpression } from './client-hub-source';
import { projectAlphaReadVisibleSql } from './project-alpha-read-visibility';
import type { Env, GrantRow, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type StatusFilter = ClientFeedbackStatus | "all" | "open";
export interface StaffFeedbackPolicy { grants: GrantRow[]; administrator: boolean; proof: string }
interface Scope { accountName: string; divisionId: string|null; projectId: string|null; available: boolean; proof: string; guard: FeedbackWriteGuard; actionPath:string|null }
interface SourceScope { project_id: string; division_id: string; client_id: string | null; organization_id: string | null; assigned: number; owner_id?: string | null; owner_organization_id?: string | null; root_organization_id?: string | null }
interface Cursor { v: 1; status: StatusFilter; accountId: string; q: string; policy: string; after: [string,string]; expires: number }
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const statusSchema = z.enum(["new", "in_progress", "done", "all", "open"]);
const actionSchema = z.object({ expectedRevision: z.number().int().min(1).max(2), status: z.enum(["in_progress", "done"]), note: z.string().max(2000).nullable() }).strict();
const tables = ["client_feedback", "client_feedback_events", "client_feedback_mutations", "client_feedback_notifications", "client_feedback_notification_outbox"];
const nativeTables=['portal_native_feedback','portal_native_feedback_events','portal_native_feedback_mutations',
  'portal_native_feedback_notifications'];
export async function nativeFeedbackReady(env:Env):Promise<boolean>{return await d1TablesPresent(env.DELIVERY_DB,nativeTables)
  && await nativeFeedbackNotificationsSchemaAvailable(env);}
function missing(): never { throw new HTTPException(404, { message: "Feedback is unavailable" }); }
function changed(): never { throw new HTTPException(409, { message: "Feedback or access changed. Refresh before trying again." }); }
export async function requireClientFeedbackReady(env: Env) {
  if (!(await d1TablesPresent(env.DELIVERY_DB, tables))) throw new HTTPException(503, { message: "Feedback is not ready. The database upgrade must finish first." });
}
export async function readStaffFeedbackPolicy(env: Env, actor: StaffPrincipal): Promise<StaffFeedbackPolicy> {
  const [grants, administrator] = await Promise.all([loadGrants(env, actor.id), isAdministrator(env, actor)]);
  const management = grants.filter(row => row.permission === "operations.manage");
  if (!management.some(row => row.effect === "allow") || management.some(row => row.source === "override" && row.effect === "deny" && row.scope === "global"))
    throw new HTTPException(403, { message: "Operations management permission is required" });
  return { grants, administrator, proof: await sha256(JSON.stringify([actor.id, actor.projectAlphaUserId, administrator, grants.map(row => JSON.stringify(row)).sort()])) };
}
/** Navigation readiness only. This does not add any permission or authorize a
 * row; every read and transition still resolves its current resource scope. */
export async function staffFeedbackEntryEnabled(env: Env, actor: StaffPrincipal): Promise<boolean> {
  const grants = (await loadGrants(env,actor.id)).filter(row=>row.permission === "operations.manage");
  if (!grants.some(row=>row.effect === "allow") || grants.some(row=>row.source === "override" && row.effect === "deny" && row.scope === "global")) return false;
  return d1TablesPresent(env.DELIVERY_DB,tables);
}
function projectScope(grants: GrantRow[]): SqlScope {
  const rows = grants.filter(row => row.permission === "projects.view");
  return { global: rows.some(row => row.effect === "allow" && row.scope === "global"), divisions: [],
    assigned: rows.some(row => row.effect === "allow" && row.scope === "assigned"), own: false, deniedDivisions: [],
    deniedGlobal: rows.some(row => row.effect === "deny" && row.source === "override" && row.scope === "global") };
}

/** Staff history does not impersonate the author. It requires the same current
 * source owner, active delivery association and staff resource permission, but
 * can still acknowledge a report after its image disappeared or author left. */
export async function readStaffFeedbackScope(env: Env, actor: StaffPrincipal, record: FeedbackRecord, access?: StaffFeedbackPolicy): Promise<Scope | null> {
  const auth = access ?? await readStaffFeedbackPolicy(env, actor), target = record.target, owner = target.sourceOwner;
  const accountSource = feedbackSourceOwnerSource(owner, "account"), projectSource = feedbackSourceOwnerSource(owner, "project");
  if (accountSource !== "project-alpha:primary" || (target.projectId && projectSource !== "project-alpha:primary")) return null;
  const values = JSON.stringify({ accountId: record.context.accountId, clientId: owner.account.projectAlphaClientId,
    orgId: owner.account.projectAlphaOrganizationId, projectId: target.projectId, paProjectId: owner.project?.projectAlphaProjectId ?? null,
    accountSource, projectSource,
    associationId: target.associationId, prefix: owner.association?.prefix ?? null, workspaceId: record.context.workspaceId,
    rootType: owner.workspace?.rootType ?? null, rootId: owner.workspace?.rootPublicId ?? null });
  const f = (name: string) => `json_extract(input.v,'$.${name}')`;
  const localSql = `WITH input AS (SELECT json(?) v) SELECT account.display_name account_name,account.project_alpha_client_id client_id,
    account.project_alpha_source_id account_source,project.project_alpha_source_id project_source,
    account.project_alpha_organization_id org_id,project.project_alpha_project_id pa_project_id,association.r2_prefix prefix
    FROM input JOIN client_accounts account ON account.id=${f("accountId")} AND account.status='active'
    LEFT JOIN projects project ON project.id=${f("projectId")} AND project.active=1
    LEFT JOIN client_folder_associations association ON association.id=${f("associationId")} AND association.account_id=account.id AND association.revoked_at IS NULL
    WHERE account.project_alpha_source_id IS ${f("accountSource")} AND account.project_alpha_client_id IS ${f("clientId")} AND account.project_alpha_organization_id IS ${f("orgId")}
      AND (${f("projectId")} IS NULL OR (project.id IS NOT NULL AND project.project_alpha_source_id IS ${f("projectSource")} AND project.project_alpha_project_id IS ${f("paProjectId")}
        AND EXISTS(SELECT 1 FROM client_project_grants g WHERE g.account_id=account.id AND g.project_id=project.id AND g.revoked_at IS NULL)))
      AND (${f("associationId")} IS NULL OR (association.id IS NOT NULL AND association.r2_prefix=${f("prefix")}
        AND ((${f("projectId")} IS NULL AND association.scope_type='client' AND association.project_id IS NULL)
          OR (association.scope_type='project' AND association.project_id=project.id))))
      AND (${f("workspaceId")} IS NULL OR EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=${f("workspaceId")}
        AND w.status='active' AND (w.legacy_account_id=account.id
          OR EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_legacy_bridges bridge WHERE bridge.workspace_id=w.id AND bridge.legacy_account_id=account.id AND bridge.status='active' AND bridge.revoked_at IS NULL)
          OR EXISTS(SELECT 1 FROM portal_v2_legacy_member_bridges bridge WHERE bridge.workspace_id=w.id AND bridge.legacy_account_id=account.id AND bridge.status='active' AND bridge.revoked_at IS NULL))
        AND w.root_type=${f("rootType")}
        AND CASE WHEN w.root_type='organization' THEN w.pa_organization_public_id ELSE w.pa_client_public_id END=${f("rootId")}))`;
  const db = env.DELIVERY_DB.withSession("first-primary");
  const local = await db.prepare(localSql).bind(values).first<{ account_name: string; client_id: string | null; org_id: string | null; pa_project_id: string | null; prefix: string | null }>();
  if (!local) return null;
  const ops = env.OPS_DB.withSession("first-primary");
  let source: SourceScope | null = null;
  if (target.projectId) {
    if (!local.pa_project_id) return null;
    const scope = projectScope(auth.grants), filter = paProjectFilter(scope, actor, auth.administrator,
      auth.grants.some(row => row.source === "override" && row.effect === "allow" && row.scope === "global" && row.permission === "operations.view_all"));
    const assignment = paProjectFilter(scope,actor,false,false);
    const ownership = {sql:"((p.client_id=? AND owner.id IS NOT NULL) OR (p.organization_id=? AND organization.id IS NOT NULL))",values:[local.client_id,local.org_id]};
    source = await ops.prepare(`SELECT p.id project_id,d.id division_id,p.client_id,p.organization_id,CASE WHEN ${assignment.sql} THEN 1 ELSE 0 END assigned,
      owner.id owner_id,owner.organization_id owner_organization_id,organization.id root_organization_id
      FROM pa_projects p JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id AND d.active=1
      LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.active=1
      LEFT JOIN pa_organizations organization ON organization.id=? AND organization.active=1
      WHERE p.id=? AND p.projection_source_id='project-alpha:primary' AND (${filter.sql}) AND (${ownership.sql})`).bind(...assignment.values,local.org_id,local.pa_project_id,...filter.values,...ownership.values).first();
  } else {
    const prefix = local.prefix;
    if (!prefix || prefix.length > 1000 || !prefix.endsWith("/")) return null;
    const ancestors: string[] = [];
    for (let index = 0; index < prefix.length; index++) if (prefix[index] === "/") ancestors.push(prefix.slice(0,index), prefix.slice(0,index+1));
    const assignment = paProjectFilter(projectScope(auth.grants),actor,false,false);
    const rows = await ops.prepare(`WITH matching AS (
      SELECT p.id project_id,pf.division_id,p.client_id,p.organization_id,CASE WHEN ${assignment.sql} THEN 1 ELSE 0 END assigned,length(rtrim(pf.r2_prefix,'/')||'/') size
      FROM project_folders pf JOIN pa_projects p ON p.id=pf.project_id AND p.active=1 AND p.projection_source_id='project-alpha:primary'
      JOIN divisions d ON d.id=pf.division_id AND d.active=1
      WHERE pf.r2_prefix IN (SELECT value FROM json_each(?)))
      SELECT DISTINCT project_id,division_id,client_id,organization_id,assigned FROM matching WHERE size=(SELECT max(size) FROM matching) LIMIT 2`)
      .bind(...assignment.values,JSON.stringify(ancestors)).all<SourceScope>();
    if (rows.results.length !== 1) return null;
    source = rows.results[0]!;
  }
  if (!source) return null;
  // Project context follows the existing portal project-grant contract: exact
  // client OR explicit organization, not the directory's grouping rules. No
  // organization is inferred from a contact. Client-level legacy delivery keeps
  // its established client-first grant ownership contract.
  if (!target.projectId && (source.client_id ? source.client_id !== local.client_id : !source.organization_id || source.organization_id !== local.org_id)) return null;
  const context = { divisionId: source.division_id, assignedStaffIds: source.assigned ? [actor.id] : [] };
  if (target.projectId && !auth.administrator && !source.assigned
    && !evaluatePermission(auth.grants,actor,"operations.view_all",context)) return null;
  if (!evaluatePermission(auth.grants, actor, "operations.manage", context)
    || (target.projectId && !evaluatePermission(auth.grants,actor,"projects.view",context))
    || (target.kind !== "project" && !evaluatePermission(auth.grants,actor,"delivery.browse",context))) return null;
  let available = true;
  if (target.kind === "file") available = Boolean(await db.prepare(`SELECT 1 FROM file_index f WHERE f.r2_key=? AND f.etag=? AND f.size=? AND f.uploaded_at=?
    AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`)
    .bind(target.storageKey,owner.file?.etag ?? null,owner.file?.size ?? null,owner.file?.uploadedAt ?? null).first());
  if (target.kind === "folder") available = target.relativePath === "" || Boolean(await db.prepare(`SELECT 1 FROM file_index f WHERE substr(f.r2_key,1,length(?))=?
    AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key))) LIMIT 1`)
    .bind(`${local.prefix}${target.relativePath}`,`${local.prefix}${target.relativePath}`).first());
  // Cross-database policy is checked before and after mutation; this guard
  // independently prevents delivery-side reassignment inside the write batch.
  const guard = { sql: `EXISTS(${localSql})`, bindings: [values] };
  return { accountName: local.account_name, divisionId: source.division_id, projectId: source.project_id, available,
    proof: await sha256(JSON.stringify([local,source,auth.proof])), guard,actionPath:null };
}

/** Secondary feedback is authorized from the source-owned native workspace and
 * then independently mapped into the exact same Operations projection source.
 * Purchased-service assignments are intentionally absent from this decision. */
export async function readStaffNativeFeedbackScope(env:Env,actor:StaffPrincipal,record:NativeFeedbackRecord,
  access?:StaffFeedbackPolicy):Promise<Scope|null>{
  const auth=access??await readStaffFeedbackPolicy(env,actor),target=record.target;
  if(target.sourceId!==record.context.sourceId||target.workspaceId!==record.context.workspaceId
    ||target.sourceId==='project-alpha:primary'||!isAlphaPublicId(target.rootPublicId))return null;
  const owner=target.kind==='project'?{type:'project' as const,publicId:target.projectPublicId}
    :target.grant?{type:target.grant.ownerType,publicId:target.grant.ownerPublicId}:null;
  if(!owner||!owner.publicId||!isAlphaPublicId(owner.publicId)
    ||(owner.type==='project')!==Boolean(target.projectPublicId)
    ||(target.projectPublicId&&target.projectPublicId!==owner.publicId))return null;
  // Staff history is durable after submission. Live client authorization is
  // used only to decide whether the original target can still be opened; it is
  // never used to erase a source-qualified report or impersonate its author.
  const recipient=await reauthorizeNativeFeedbackRecipient(env as unknown as import('../../../client/src/worker/types').Env,record);
  const ops=env.OPS_DB.withSession('first-primary'),rootTable=target.rootType==='organization'?'pa_organizations':'pa_clients',rootAlias='root';
  const root=await ops.prepare(`SELECT ${rootAlias}.id,${rootAlias}.name FROM ${rootTable} ${rootAlias}
    WHERE ${rootAlias}.projection_source_id=? AND ${rootAlias}.active=1 AND ${target.rootType==='standalone_client'?`${rootAlias}.organization_id IS NULL AND`:''}
      ${validatedUniquePublicIdExpression(rootTable,rootAlias)}=? AND ${projectAlphaReadVisibleSql(`${rootAlias}.projection_source_id`)}`)
    .bind(target.sourceId,target.rootPublicId).first<{id:string;name:string}>();
  if(!root)return null;
  const historicalGuard:FeedbackWriteGuard={sql:`EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL AND workspace.status='active'
      AND workspace.root_type=? AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=?)`,
    bindings:[target.workspaceId,target.sourceId,target.rootType,target.rootPublicId]};
  const rootKind=target.rootType==='organization'?'organizations':'standalone';
  if(owner.type!=='project'){
    const globalContext={};
    if(!evaluatePermission(auth.grants,actor,'operations.manage',globalContext)
      ||!evaluatePermission(auth.grants,actor,'delivery.browse',globalContext))return null;
    const available=Boolean(recipient?.available),actionPath=available
      ?`/clients/sources/${encodeURIComponent(target.sourceId)}/business/${rootKind}/${encodeURIComponent(target.rootPublicId)}`:null;
    return {accountName:root.name,divisionId:null,projectId:null,available,
      proof:await sha256(JSON.stringify([target.sourceId,target.rootType,target.rootPublicId,owner,auth.proof])),
      guard:historicalGuard,actionPath};
  }
  const scope=projectScope(auth.grants),filter=paProjectFilter(scope,actor,auth.administrator,
    auth.grants.some(row=>row.source==='override'&&row.effect==='allow'&&row.scope==='global'&&row.permission==='operations.view_all'));
  const assignment=paProjectFilter(scope,actor,false,false);
  const row=await ops.prepare(`SELECT p.id project_id,d.id division_id,CASE WHEN ${assignment.sql} THEN 1 ELSE 0 END assigned
    FROM pa_projects p JOIN divisions d ON d.project_alpha_business_unit_id=p.business_unit_id AND d.active=1
    LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.projection_source_id=? AND ${validatedUniquePublicIdExpression('pa_projects','p')}=? AND (${filter.sql})
      AND ${target.rootType==='organization'?`(p.organization_id=? OR (p.organization_id IS NULL AND owner.organization_id=?))`:
        `p.client_id=? AND owner.id IS NOT NULL AND owner.organization_id IS NULL AND p.organization_id IS NULL`}`)
    .bind(...assignment.values,target.sourceId,target.projectPublicId,...filter.values,root.id,...(target.rootType==='organization'?[root.id]:[]))
    .first<{project_id:string;division_id:string;assigned:number}>();
  const globalContext={},globalHistory=evaluatePermission(auth.grants,actor,'operations.manage',globalContext)
    &&evaluatePermission(auth.grants,actor,'projects.view',globalContext)
    &&(target.kind==='project'||evaluatePermission(auth.grants,actor,'delivery.browse',globalContext));
  if(!row&&!globalHistory)return null;
  if(row&&!globalHistory){
    const permissionContext={divisionId:row.division_id,assignedStaffIds:row.assigned?[actor.id]:[]};
    if(!auth.administrator&&!row.assigned&&!evaluatePermission(auth.grants,actor,'operations.view_all',permissionContext))return null;
    if(!evaluatePermission(auth.grants,actor,'operations.manage',permissionContext)
      ||!evaluatePermission(auth.grants,actor,'projects.view',permissionContext)
      ||(target.kind!=='project'&&!evaluatePermission(auth.grants,actor,'delivery.browse',permissionContext)))return null;
  }
  const available=Boolean(row&&recipient?.available),actionPath=available
    ?`/clients/sources/${encodeURIComponent(target.sourceId)}/business/${rootKind}/${encodeURIComponent(target.rootPublicId)}/business-projects/${encodeURIComponent(row!.project_id)}`:null;
  return {accountName:root.name,divisionId:row?.division_id??null,projectId:row?.project_id??null,available,
    proof:await sha256(JSON.stringify([target.sourceId,target.rootType,target.rootPublicId,target.projectPublicId,globalHistory?null:row,auth.proof])),
    guard:historicalGuard,actionPath};
}

type AnyFeedbackRecord=FeedbackRecord|NativeFeedbackRecord;
async function readAnyFeedbackRecord(db:Pick<D1Database,'prepare'>,id:string,nativeReady:boolean):Promise<AnyFeedbackRecord|null>{
  return id.startsWith('native_')?(nativeReady?readNativeFeedbackRecord(db,id):null):readFeedbackRecord(db,id);
}
async function readAnyStaffFeedbackScope(env:Env,actor:StaffPrincipal,record:AnyFeedbackRecord,access?:StaffFeedbackPolicy){
  return record.id.startsWith('native_')?readStaffNativeFeedbackScope(env,actor,record as NativeFeedbackRecord,access)
    :readStaffFeedbackScope(env,actor,record as FeedbackRecord,access);
}

function item(record: AnyFeedbackRecord, scope: Scope): StaffClientFeedbackItem {
  const projectId=record.id.startsWith('native_')?(record as NativeFeedbackRecord).target.projectPublicId:(record as FeedbackRecord).target.projectId;
  return { id: record.id, status: record.status, revision: record.revision, message: record.message, completionNote: record.completionNote,
    createdAt: record.createdAt, updatedAt: record.updatedAt, completedAt: record.completedAt, accountName: scope.accountName,
    canStart: record.status === "new", canComplete: record.status !== "done",
    target: { kind: record.target.kind, projectId, label: record.target.label, projectName: record.target.projectName,
      available: scope.available, actionPath: scope.actionPath } };
}
export async function readStaffFeedbackEvents(env: Env, id: string): Promise<ClientFeedbackEvent[]> {
  const table=id.startsWith('native_')?'portal_native_feedback_events':'client_feedback_events';
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT revision,actor_type actor,status,note,created_at createdAt
    FROM ${table} WHERE feedback_id=? ORDER BY revision LIMIT 3`).bind(id).all<ClientFeedbackEvent>();
  return rows.results;
}
async function cursorKey(env: Env) {
  if (!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length < 32) throw new Error("Feedback cursor configuration unavailable");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`staff-feedback:v1:${env.OPERATIONS_SESSION_SECRET}`)), "AES-GCM", false, ["encrypt","decrypt"]);
}
async function encodeCursor(env: Env, actor: StaffPrincipal, value: Cursor) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(actor.id) }, await cursorKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(bytes))}`;
}
async function decodeCursor(env: Env, actor: StaffPrincipal, token: string, status: StatusFilter, accountId: string, q: string, proof: string) {
  let value: Cursor;
  try {
    if (token.length > 2048) throw new Error();
    const parts = token.split("."); if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const decode = (part: string) => Uint8Array.from(atob(part.replaceAll("-","+").replaceAll("_","/")), ch => ch.charCodeAt(0));
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parts[0]!), additionalData: new TextEncoder().encode(actor.id) }, await cursorKey(env), decode(parts[1]!));
    value = z.object({ v: z.literal(1), status: statusSchema, accountId: z.string().max(128), q: z.string().max(200), policy: z.string(), after: z.tuple([z.string().max(64),idSchema]), expires: z.number().int() }).strict().parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { throw new HTTPException(400, { message: "Feedback cursor is invalid" }); }
  if (value.status !== status || value.accountId !== accountId || value.q !== q || value.policy !== proof || value.expires < Date.now()) changed();
  return value;
}
export async function listStaffFeedback(env: Env, actor: StaffPrincipal, query: { status?: string; accountId?: string; cursor?: string; q?: string } = {}) {
  const parsed = statusSchema.safeParse(query.status ?? "new");
  if (!parsed.success || (query.accountId && !idSchema.safeParse(query.accountId).success)) throw new HTTPException(400, { message: "Feedback filter is invalid" });
  if ((query.q?.length ?? 0) > 200 || /[\u0000-\u001f\u007f]/.test(query.q ?? "")) throw new HTTPException(400,{message:"Feedback search is invalid"});
  const q = (query.q ?? "").normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (q.length > 200) throw new HTTPException(400,{message:"Feedback search is invalid"});
  const status = parsed.data, accountId = query.accountId ?? "", access = await readStaffFeedbackPolicy(env, actor);
  await requireClientFeedbackReady(env);
  const cursor = query.cursor ? await decodeCursor(env,actor,query.cursor,status,accountId,q,access.proof) : null;
  const predicates: string[] = [], values: string[] = [];
  if (status === "open") predicates.push("status IN ('new','in_progress')");
  else if (status !== "all") { predicates.push("status=?"); values.push(status); }
  if (cursor) { predicates.push("(created_at,id)>(?,?)"); values.push(...cursor.after); }
  const primaryAccount=accountId?'AND account_id=?':'',nativeReady=await nativeFeedbackReady(env);
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,created_at FROM (
      SELECT id,created_at,status FROM client_feedback WHERE 1=1 ${primaryAccount}
      ${accountId||!nativeReady?'':'UNION ALL SELECT id,created_at,status FROM portal_native_feedback'}
    ) ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""} ORDER BY created_at,id LIMIT 51`).bind(...(accountId?[accountId]:[]),...values)
    .all<{id:string;created_at:string}>();
  const shown: {record: AnyFeedbackRecord; scope: Scope}[] = []; let examined = 0;
  for (const row of rows.results.slice(0,50)) {
    examined++;
    const record = await readAnyFeedbackRecord(env.DELIVERY_DB.withSession("first-primary"),row.id,nativeReady);
    if (!record || (status === "open" ? record.status === "done" : status !== "all" && record.status !== status)) continue;
    const scope = await readAnyStaffFeedbackScope(env,actor,record,access);
    if (scope && (!q || [scope.accountName,record.message,record.target.label,record.target.projectName ?? ""].some(value => value.normalize("NFC").toLocaleLowerCase("en-US").includes(q)))) shown.push({record,scope});
    if (shown.length === 25) break;
  }
  if ((await readStaffFeedbackPolicy(env,actor)).proof !== access.proof) changed();
  for (const result of shown) if ((await readAnyStaffFeedbackScope(env,actor,result.record,access))?.proof !== result.scope.proof) changed();
  const last = rows.results[examined-1];
  return { items: shown.map(value => item(value.record,value.scope)), nextCursor: last && rows.results.length > examined
    ? await encodeCursor(env,actor,{v:1,status,accountId,q,policy:access.proof,after:[last.created_at,last.id],expires:Date.now()+30*60_000}) : null };
}
export async function getStaffFeedback(env: Env, actor: StaffPrincipal, id: string) {
  if (!idSchema.safeParse(id).success) missing();
  const access = await readStaffFeedbackPolicy(env,actor); await requireClientFeedbackReady(env);
  const nativeReady=!id.startsWith('native_')||await nativeFeedbackReady(env);
  const record = await readAnyFeedbackRecord(env.DELIVERY_DB.withSession("first-primary"),id,nativeReady);
  const scope = record ? await readAnyStaffFeedbackScope(env,actor,record,access) : null;
  if (!record || !scope) missing();
  const history = await readStaffFeedbackEvents(env,id);
  if ((await readStaffFeedbackPolicy(env,actor)).proof !== access.proof || (await readAnyStaffFeedbackScope(env,actor,record,access))?.proof !== scope.proof) changed();
  return { feedback: item(record,scope), events: history };
}
export async function transitionStaffFeedback(env: Env, actor: StaffPrincipal, id: string, value: unknown, key: string) {
  if (!idSchema.safeParse(id).success) missing();
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message: "Feedback status update is invalid" });
  const access = await readStaffFeedbackPolicy(env,actor); await requireClientFeedbackReady(env);
  const nativeReady=!id.startsWith('native_')||await nativeFeedbackReady(env);
  const db = env.DELIVERY_DB.withSession("first-primary"), record = await readAnyFeedbackRecord(db,id,nativeReady);
  const scope = record ? await readAnyStaffFeedbackScope(env,actor,record,access) : null;
  if (!record || !scope) missing();
  const assertCurrent = async () => {
    if ((await readStaffFeedbackPolicy(env,actor)).proof !== access.proof || (await readAnyStaffFeedbackScope(env,actor,record,access))?.proof !== scope.proof) changed();
  };
  await assertCurrent();
  try {
    const result = record.id.startsWith('native_')
      ? await transitionNativeFeedbackRecord(db,record as NativeFeedbackRecord,actor.id,parsed.data,key,scope.guard)
      : await transitionFeedbackRecord(db,record as FeedbackRecord,actor.id,parsed.data,key,scope.guard);
    const finalScope=await readAnyStaffFeedbackScope(env,actor,result.record,access);
    if(!finalScope||finalScope.proof!==scope.proof)changed();
    return { feedback: item(result.record,finalScope), events: await readStaffFeedbackEvents(env,id), replayed: result.replayed, appliedRevision: result.appliedRevision };
  } catch (error) {
    if (error instanceof FeedbackStoreError) throw new HTTPException(error.code === "invalid" ? 400 : 409, { message: error.code === "idempotency_conflict" ? "This action key was already used for another change" : "Feedback changed. Refresh before trying again." });
    throw error;
  }
}
async function boundedBody(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HTTPException(400, { message: "Request body must be JSON" });
  const reader = request.body?.getReader(); if (!reader) throw new HTTPException(400,{message:"Request body is required"});
  let text = "", size = 0; const decoder = new TextDecoder();
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new HTTPException(413,{message:"Feedback update is too large"}); }
    text += decoder.decode(chunk.value,{stream:true}); } text += decoder.decode(); }
  finally { reader.releaseLock(); }
  try { return JSON.parse(text) as unknown; } catch { throw new HTTPException(400,{message:"Request body must be JSON"}); }
}
export function registerClientFeedbackRoutes(app: App) {
  app.get("/api/operations/feedback",async c => c.json(await listStaffFeedback(c.env,c.get("principal"),c.req.query())));
  app.get("/api/operations/feedback/:id",async c => c.json(await getStaffFeedback(c.env,c.get("principal"),c.req.param("id"))));
  app.post("/api/operations/feedback/:id/status",async c => c.json(await transitionStaffFeedback(c.env,c.get("principal"),c.req.param("id"),await boundedBody(c.req.raw),c.req.header("Idempotency-Key") ?? "")));
}
