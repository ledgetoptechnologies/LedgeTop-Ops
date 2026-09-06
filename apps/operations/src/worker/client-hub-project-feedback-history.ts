import { PRIMARY_ALPHA_SOURCE_ID, type ProjectFeedbackHistoryPage } from "@ltds/shared";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readFeedbackRecord, type FeedbackRecord } from "../../../client/src/worker/client-portal/feedback-store";
import { readNativeFeedbackRecord, type NativeFeedbackRecord } from "../../../client/src/worker/client-portal/native-feedback-store";
import { base64Url, sha256 } from "./crypto";
import { readClientHubBusinessProjectDetail } from "./client-hub-business-project-detail";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { validatedUniquePublicIdExpression } from "./client-hub-source";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import {
  readStaffFeedbackEvents,
  readStaffNativeFeedbackScope,
  readStaffFeedbackPolicy,
  readStaffFeedbackScope,
  nativeFeedbackReady,
  requireClientFeedbackReady,
  type StaffFeedbackPolicy,
} from "./client-feedback";
import type { Env, StaffPrincipal } from "./types";

interface DeliveryProjectMapping {
  account_id: string;
  account_status: string;
  account_source_id: string | null;
  account_client_id: string | null;
  account_organization_id: string | null;
  project_id: string;
  project_active: number;
  project_source_id: string | null;
  project_alpha_id: string | null;
  granted_at: string;
  revoked_at: string | null;
}
interface NativeProjectMapping { source_id:string; workspace_id:string; project_id:string; project_public_id:string }
interface Candidate { id: string; created_at: string; watermark: number }
interface Cursor {
  v: 2;
  root: [string, string, string, string];
  projectId: string;
  context: string;
  project: string;
  feedback: string;
  mapping: string;
  asOf: string;
  water: number;
  after: [string, string];
  expires: number;
}

const identifier = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const cursorIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.string().max(64).refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const cursorSchema = z.object({
  v: z.literal(2), root: z.tuple([identifier, identifier, identifier, identifier]), projectId: identifier,
  context: proof, project: proof, feedback: proof, mapping: proof, asOf: timestamp,
  water: z.number().int().nonnegative(), after: z.tuple([timestamp, cursorIdentifier]), expires: z.number().int().positive(),
}).strict();

function changed(): never {
  throw new HTTPException(409, { message: "Project feedback or access changed. Refresh the project workspace to continue" });
}
function rootTuple(context: ClientHubCollectionContext): Cursor["root"] {
  const root = context.root;
  return [root.source_id, root.root_namespace, root.kind, root.public_id];
}
async function cursorKey(env: Env) {
  if (!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length < 32)
    throw new Error("Project feedback cursor configuration unavailable");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`project-feedback-history:v2:${env.OPERATIONS_SESSION_SECRET}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encodeCursor(env: Env, actor: StaffPrincipal, value: Cursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(actor.id) }, await cursorKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(bytes))}`;
}
async function decodeCursor(env: Env, actor: StaffPrincipal, value: string): Promise<Cursor> {
  try {
    if (value.length > 4096) throw new Error();
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const decode = (part: string) => Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parts[0]!),
      additionalData: new TextEncoder().encode(actor.id) }, await cursorKey(env), decode(parts[1]!));
    return cursorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new HTTPException(400, { message: "Project feedback cursor is invalid" }); }
}

async function deliveryMapping(env: Env, context: ClientHubCollectionContext, projectId: string): Promise<DeliveryProjectMapping | null> {
  const root = context.root;
  if (root.source_id !== PRIMARY_ALPHA_SOURCE_ID || root.root_namespace !== "business") return null;
  const owner = root.kind === "organization"
    ? "account.project_alpha_organization_id=?"
    : "account.project_alpha_client_id=? AND account.project_alpha_organization_id IS NULL";
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT account.id account_id,account.status account_status,
    account.project_alpha_source_id account_source_id,account.project_alpha_client_id account_client_id,
    account.project_alpha_organization_id account_organization_id,project.id project_id,project.active project_active,
    project.project_alpha_source_id project_source_id,project.project_alpha_project_id project_alpha_id,
    project_grant.granted_at,project_grant.revoked_at
    FROM client_accounts account JOIN client_project_grants project_grant ON project_grant.account_id=account.id
    JOIN projects project ON project.id=project_grant.project_id
    WHERE account.status='active' AND account.project_alpha_source_id=? AND ${owner}
      AND project.active=1 AND project.project_alpha_source_id=? AND project.project_alpha_project_id=?
      AND project_grant.revoked_at IS NULL ORDER BY account.id,project.id LIMIT 2`)
    .bind(PRIMARY_ALPHA_SOURCE_ID, root.public_id, PRIMARY_ALPHA_SOURCE_ID, projectId).all<DeliveryProjectMapping>();
  if (rows.results.length > 1) changed();
  return rows.results[0] ?? null;
}
function mappingProof(mapping: DeliveryProjectMapping | null): Promise<string> {
  return sha256(JSON.stringify(mapping ? [mapping.account_id,mapping.account_status,mapping.account_source_id,
    mapping.account_client_id,mapping.account_organization_id,mapping.project_id,mapping.project_active,
    mapping.project_source_id,mapping.project_alpha_id,mapping.granted_at,mapping.revoked_at] : null));
}
async function nativeProjectMapping(env:Env,context:ClientHubCollectionContext,projectId:string):Promise<NativeProjectMapping|null>{
  const root=context.root;
  if(root.source_id===PRIMARY_ALPHA_SOURCE_ID||root.root_namespace!=="business"||!root.workspace_id
    ||root.mapping_status!=="mapped"||!root.pa_public_id)return null;
  const workspace=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT workspace.id FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
      AND entity.entity_type=workspace.root_type AND entity.parent_public_id IS NULL AND entity.active=1
      AND entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL
      AND workspace.root_type=? AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=? LIMIT 1`)
    .bind(root.workspace_id,root.source_id,root.kind==="organization"?"organization":"standalone_client",root.pa_public_id).first<{id:string}>();
  if(!workspace)return null;
  const project=await env.OPS_DB.withSession("first-primary").prepare(`SELECT p.id,
    ${validatedUniquePublicIdExpression("pa_projects","p")} project_public_id
    FROM pa_projects p WHERE p.id=? AND p.projection_source_id=? AND p.active=1
      AND ${projectAlphaReadVisibleSql("p.projection_source_id")} LIMIT 1`).bind(projectId,root.source_id)
    .first<{id:string;project_public_id:string|null}>();
  if(!project?.project_public_id)return null;
  return {source_id:root.source_id,workspace_id:root.workspace_id,project_id:project.id,project_public_id:project.project_public_id};
}
function nativeMappingProof(mapping:NativeProjectMapping|null):Promise<string>{
  return sha256(JSON.stringify(mapping?[mapping.source_id,mapping.workspace_id,mapping.project_id,mapping.project_public_id]:null));
}
function sameRecord(left: FeedbackRecord, right: FeedbackRecord): boolean {
  return left.id === right.id && left.context.accountId === right.context.accountId
    && left.target.projectId === right.target.projectId && left.targetFingerprint === right.targetFingerprint
    && left.revision === right.revision && left.status === right.status && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}
function sameNativeRecord(left:NativeFeedbackRecord,right:NativeFeedbackRecord):boolean{
  return left.id===right.id&&left.context.sourceId===right.context.sourceId&&left.context.workspaceId===right.context.workspaceId
    && left.target.sourceId===right.target.sourceId&&left.target.workspaceId===right.target.workspaceId
    && left.target.rootType===right.target.rootType&&left.target.rootPublicId===right.target.rootPublicId
    && left.target.kind===right.target.kind&&left.target.projectPublicId===right.target.projectPublicId
    && left.targetFingerprint===right.targetFingerprint&&left.revision===right.revision&&left.status===right.status
    && left.createdAt===right.createdAt&&left.updatedAt===right.updatedAt;
}
function action(status: "new" | "in_progress" | "done") {
  return status === "new" ? "submitted" as const : status === "in_progress" ? "started" as const : "completed" as const;
}
async function currentProject(env: Env, actor: StaffPrincipal, context: ClientHubCollectionContext,
  projectId: string, expectedContextVersion?: string): Promise<string> {
  const detail = await readClientHubBusinessProjectDetail(env, actor, context, projectId, { expectedContextVersion });
  return sha256(JSON.stringify([detail.canonicalRoot,detail.contextVersion,detail.project.id,detail.project.status,
    detail.project.manager,detail.project.start_date,detail.project.end_date]));
}

async function listNativeProjectFeedbackHistory(env:Env,actor:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,
  projectProof:string,feedbackPolicy:StaffFeedbackPolicy,options:{expectedContextVersion?:string;cursor?:string;limit?:number}):Promise<ProjectFeedbackHistoryPage>{
  const limit=options.limit??25,now=new Date().toISOString(),tuple=rootTuple(context);
  if(!(await nativeFeedbackReady(env)))throw new HTTPException(503,{message:"Feedback is not ready. The database upgrade must finish first."});
  const mapping=await nativeProjectMapping(env,context,projectId),mappedProof=await nativeMappingProof(mapping);
  const cursor=options.cursor?await decodeCursor(env,actor,options.cursor):null;
  if(cursor&&(JSON.stringify(cursor.root)!==JSON.stringify(tuple)||cursor.projectId!==projectId))
    throw new HTTPException(400,{message:"Project feedback cursor does not match this project"});
  if(cursor&&(cursor.context!==context.contextVersion||cursor.project!==projectProof||cursor.feedback!==feedbackPolicy.proof
    ||cursor.mapping!==mappedProof||cursor.expires<Date.now()))changed();
  const asOf=cursor?.asOf??now;
  const empty=(available:boolean):ProjectFeedbackHistoryPage=>({canonicalRoot:context.canonicalRoot,projectId,
    contextVersion:context.contextVersion,refreshedAt:now,asOf,coverage:"feedback_only",items:[],
    page:{available,reason:available?null:"unsupported_source",nextCursor:null,hasMore:false,returned:0,limit}});
  if(!mapping){
    const [releaseProject,releasePolicy,releaseMapping]=await Promise.all([
      currentProject(env,actor,context,projectId,options.expectedContextVersion),readStaffFeedbackPolicy(env,actor),nativeProjectMapping(env,context,projectId),
    ]);
    if(releaseProject!==projectProof||releasePolicy.proof!==feedbackPolicy.proof||(await nativeMappingProof(releaseMapping))!==mappedProof)changed();
    return empty(true);
  }
  const db=env.DELIVERY_DB.withSession("first-primary");
  const water=cursor?.water??Number((await db.prepare(`SELECT COALESCE(MAX(rowid),0) water FROM portal_native_feedback
    WHERE source_id=? AND workspace_id=? AND project_public_id=? AND target_kind='project'`)
    .bind(mapping.source_id,mapping.workspace_id,mapping.project_public_id).first<{water:number}>())?.water??0);
  const rows=await db.prepare(`SELECT rowid watermark,id,created_at FROM portal_native_feedback INDEXED BY idx_portal_native_feedback_project
    WHERE source_id=? AND workspace_id=? AND project_public_id=? AND target_kind='project' AND rowid<=? AND created_at<=?
      ${cursor?"AND (created_at,id)<(?,?)":""} ORDER BY created_at DESC,id DESC LIMIT 51`)
    .bind(mapping.source_id,mapping.workspace_id,mapping.project_public_id,water,asOf,...(cursor?.after??[])).all<Candidate>();
  const shown:Array<{record:NativeFeedbackRecord;scopeProof:string;item:ProjectFeedbackHistoryPage["items"][number]}>=[];
  let examined=0;
  for(const candidate of rows.results.slice(0,50)){
    examined+=1;
    const record=await readNativeFeedbackRecord(db,candidate.id);
    if(!record||record.context.sourceId!==mapping.source_id||record.context.workspaceId!==mapping.workspace_id
      ||record.target.sourceId!==mapping.source_id||record.target.workspaceId!==mapping.workspace_id||record.target.kind!=="project"
      ||record.target.projectPublicId!==mapping.project_public_id||record.createdAt!==candidate.created_at)continue;
    const scope=await readStaffNativeFeedbackScope(env,actor,record,feedbackPolicy);
    if(!scope||(scope.projectId!==null&&scope.projectId!==projectId))continue;
    const history=await readStaffFeedbackEvents(env,record.id);
    if(history.length!==record.revision||history.at(-1)?.status!==record.status)
      throw new HTTPException(503,{message:"Project feedback history is unavailable"});
    shown.push({record,scopeProof:scope.proof,item:{feedbackId:record.id,createdAt:record.createdAt,status:record.status,
      events:history.map(event=>({revision:event.revision,action:action(event.status),occurredAt:event.createdAt})),
      detailPath:`/clients/feedback/${encodeURIComponent(record.id)}?status=all`}});
    if(shown.length===limit)break;
  }
  const fence=async()=>Promise.all([nativeProjectMapping(env,context,projectId),
    currentProject(env,actor,context,projectId,options.expectedContextVersion),readStaffFeedbackPolicy(env,actor)] as const);
  let [currentMapping,currentProjectProof,currentPolicy]=await fence();
  if((await nativeMappingProof(currentMapping))!==mappedProof||currentProjectProof!==projectProof||currentPolicy.proof!==feedbackPolicy.proof)changed();
  for(const result of shown){
    const current=await readNativeFeedbackRecord(db,result.record.id);
    const scope=current?await readStaffNativeFeedbackScope(env,actor,current,currentPolicy):null;
    if(!current||!sameNativeRecord(current,result.record)||!scope||scope.proof!==result.scopeProof
      ||(scope.projectId!==null&&scope.projectId!==projectId))changed();
  }
  [currentMapping,currentProjectProof,currentPolicy]=await fence();
  if((await nativeMappingProof(currentMapping))!==mappedProof||currentProjectProof!==projectProof||currentPolicy.proof!==feedbackPolicy.proof)changed();
  const last=rows.results[examined-1],hasMore=Boolean(last&&rows.results.length>examined);
  return {canonicalRoot:context.canonicalRoot,projectId,contextVersion:context.contextVersion,refreshedAt:new Date().toISOString(),
    asOf,coverage:"feedback_only",items:shown.map(result=>result.item),page:{available:true,reason:null,returned:shown.length,
      limit,hasMore,nextCursor:hasMore?await encodeCursor(env,actor,{v:2,root:tuple,projectId,context:context.contextVersion,
        project:projectProof,feedback:feedbackPolicy.proof,mapping:mappedProof,asOf,water,after:[last!.created_at,last!.id],expires:Date.now()+30*60_000}):null}};
}

/** Project-scoped feedback submissions with bounded lifecycle metadata. This is
 * not a general activity stream and intentionally returns no message, note,
 * actor, target snapshot or authorization proof. */
export async function listClientHubProjectFeedbackHistory(env: Env, actor: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string,
  options: { expectedContextVersion?: string; cursor?: string; limit?: number } = {}): Promise<ProjectFeedbackHistoryPage> {
  const parsedProject = identifier.safeParse(projectId), limit = options.limit ?? 25;
  if (!parsedProject.success || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Project feedback history query is invalid" });
  if (options.expectedContextVersion !== undefined && !proof.safeParse(options.expectedContextVersion).success)
    throw new HTTPException(400, { message: "Client context is invalid" });
  if (options.expectedContextVersion !== undefined && options.expectedContextVersion !== context.contextVersion) changed();
  const projectProof = await currentProject(env,actor,context,projectId,options.expectedContextVersion);
  const feedbackPolicy = await readStaffFeedbackPolicy(env,actor);
  if(context.root.source_id!==PRIMARY_ALPHA_SOURCE_ID)
    return listNativeProjectFeedbackHistory(env,actor,context,projectId,projectProof,feedbackPolicy,options);
  await requireClientFeedbackReady(env);
  const now = new Date().toISOString();
  const empty = (): ProjectFeedbackHistoryPage => ({ canonicalRoot:context.canonicalRoot,projectId,
    contextVersion:context.contextVersion,refreshedAt:now,asOf:now,coverage:"feedback_only",items:[],
    page:{available:false,reason:"unsupported_source",nextCursor:null,hasMore:false,returned:0,limit} });
  const mapping = await deliveryMapping(env,context,projectId), mappedProof = await mappingProof(mapping);
  const cursor = options.cursor ? await decodeCursor(env,actor,options.cursor) : null;
  const tuple = rootTuple(context);
  if (cursor && (JSON.stringify(cursor.root) !== JSON.stringify(tuple) || cursor.projectId !== projectId))
    throw new HTTPException(400, { message: "Project feedback cursor does not match this project" });
  if (cursor && (cursor.context !== context.contextVersion || cursor.project !== projectProof
    || cursor.feedback !== feedbackPolicy.proof || cursor.mapping !== mappedProof || cursor.expires < Date.now())) changed();
  const asOf = cursor?.asOf ?? now;
  if (!mapping) {
    if ((await mappingProof(await deliveryMapping(env,context,projectId))) !== mappedProof
      || (await currentProject(env,actor,context,projectId,options.expectedContextVersion)) !== projectProof
      || (await readStaffFeedbackPolicy(env,actor)).proof !== feedbackPolicy.proof) changed();
    return { ...empty(), asOf, page:{available:true,reason:null,nextCursor:null,hasMore:false,returned:0,limit} };
  }
  const db = env.DELIVERY_DB.withSession("first-primary");
  const water=cursor?.water??Number((await db.prepare(`SELECT COALESCE(MAX(rowid),0) water FROM client_feedback
    WHERE account_id=? AND project_id=?`).bind(mapping.account_id,mapping.project_id).first<{water:number}>())?.water??0);
  const rows = await db.prepare(`SELECT rowid watermark,id,created_at FROM client_feedback INDEXED BY idx_client_feedback_project
    WHERE account_id=? AND project_id=? AND rowid<=? AND created_at<=? ${cursor ? "AND (created_at,id)<(?,?)" : ""}
    ORDER BY created_at DESC,id DESC LIMIT 51`).bind(mapping.account_id,mapping.project_id,water,asOf,...(cursor?.after ?? [])).all<Candidate>();
  const shown: Array<{ record: FeedbackRecord; scopeProof: string; item: ProjectFeedbackHistoryPage["items"][number] }> = [];
  let examined = 0;
  for (const candidate of rows.results.slice(0,50)) {
    examined += 1;
    const record = await readFeedbackRecord(db,candidate.id);
    if (!record || record.context.accountId !== mapping.account_id || record.target.projectId !== mapping.project_id
      || record.createdAt !== candidate.created_at) continue;
    const scope = await readStaffFeedbackScope(env,actor,record,feedbackPolicy);
    if (!scope || scope.projectId !== projectId) continue;
    const history = await readStaffFeedbackEvents(env,record.id);
    if (history.length !== record.revision || history.at(-1)?.status !== record.status)
      throw new HTTPException(503,{message:"Project feedback history is unavailable"});
    shown.push({record,scopeProof:scope.proof,item:{feedbackId:record.id,createdAt:record.createdAt,status:record.status,
      events:history.map(event=>({revision:event.revision,action:action(event.status),occurredAt:event.createdAt})),
      detailPath:`/clients/feedback/${encodeURIComponent(record.id)}?status=all`}});
    if (shown.length === limit) break;
  }
  const [currentMapping,currentProjectProof,currentFeedbackPolicy] = await Promise.all([
    deliveryMapping(env,context,projectId),currentProject(env,actor,context,projectId,options.expectedContextVersion),readStaffFeedbackPolicy(env,actor),
  ]);
  if ((await mappingProof(currentMapping)) !== mappedProof || currentProjectProof !== projectProof
    || currentFeedbackPolicy.proof !== feedbackPolicy.proof) changed();
  for (const result of shown) {
    const current = await readFeedbackRecord(db,result.record.id);
    const scope = current ? await readStaffFeedbackScope(env,actor,current,currentFeedbackPolicy) : null;
    if (!current || !sameRecord(current,result.record) || !scope || scope.proof !== result.scopeProof || scope.projectId !== projectId) changed();
  }
  // Per-record scope checks can be slow and intentionally share one captured
  // policy. Fence that entire loop: no policy, project or Delivery mapping
  // change may land after the earlier reread and still release this page.
  const [releaseMapping,releaseProjectProof,releaseFeedbackPolicy] = await Promise.all([
    deliveryMapping(env,context,projectId),currentProject(env,actor,context,projectId,options.expectedContextVersion),readStaffFeedbackPolicy(env,actor),
  ]);
  if ((await mappingProof(releaseMapping)) !== mappedProof || releaseProjectProof !== projectProof
    || releaseFeedbackPolicy.proof !== feedbackPolicy.proof) changed();
  const last = rows.results[examined-1], hasMore = Boolean(last && rows.results.length > examined);
  return {canonicalRoot:context.canonicalRoot,projectId,contextVersion:context.contextVersion,refreshedAt:new Date().toISOString(),
    asOf,coverage:"feedback_only",items:shown.map(result=>result.item),page:{available:true,reason:null,returned:shown.length,
      limit,hasMore,nextCursor:hasMore?await encodeCursor(env,actor,{v:2,root:tuple,projectId,context:context.contextVersion,
        project:projectProof,feedback:feedbackPolicy.proof,mapping:mappedProof,asOf,water,after:[last!.created_at,last!.id],expires:Date.now()+30*60_000}):null}};
}
