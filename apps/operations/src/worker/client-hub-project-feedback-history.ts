import { PRIMARY_ALPHA_SOURCE_ID, type ProjectFeedbackHistoryPage } from "@ltds/shared";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readFeedbackRecord, type FeedbackRecord } from "../../../client/src/worker/client-portal/feedback-store";
import { base64Url, sha256 } from "./crypto";
import { readClientHubBusinessProjectDetail } from "./client-hub-business-project-detail";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import {
  readStaffFeedbackEvents,
  readStaffFeedbackPolicy,
  readStaffFeedbackScope,
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
interface Candidate { id: string; created_at: string }
interface Cursor {
  v: 1;
  root: [string, string, string, string];
  projectId: string;
  context: string;
  project: string;
  feedback: string;
  mapping: string;
  asOf: string;
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
  v: z.literal(1), root: z.tuple([identifier, identifier, identifier, identifier]), projectId: identifier,
  context: proof, project: proof, feedback: proof, mapping: proof, asOf: timestamp,
  after: z.tuple([timestamp, cursorIdentifier]), expires: z.number().int().positive(),
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
    new TextEncoder().encode(`project-feedback-history:v1:${env.OPERATIONS_SESSION_SECRET}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
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
function sameRecord(left: FeedbackRecord, right: FeedbackRecord): boolean {
  return left.id === right.id && left.context.accountId === right.context.accountId
    && left.target.projectId === right.target.projectId && left.targetFingerprint === right.targetFingerprint
    && left.revision === right.revision && left.status === right.status && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
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
  await requireClientFeedbackReady(env);
  const unavailable = context.root.source_id !== PRIMARY_ALPHA_SOURCE_ID;
  const now = new Date().toISOString();
  const empty = (): ProjectFeedbackHistoryPage => ({ canonicalRoot:context.canonicalRoot,projectId,
    contextVersion:context.contextVersion,refreshedAt:now,asOf:now,coverage:"feedback_only",items:[],
    page:{available:false,reason:"unsupported_source",nextCursor:null,hasMore:false,returned:0,limit} });
  if (unavailable) {
    if ((await currentProject(env,actor,context,projectId,options.expectedContextVersion)) !== projectProof
      || (await readStaffFeedbackPolicy(env,actor)).proof !== feedbackPolicy.proof) changed();
    return empty();
  }
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
  const rows = await db.prepare(`SELECT id,created_at FROM client_feedback INDEXED BY idx_client_feedback_project
    WHERE account_id=? AND project_id=? AND created_at<=? ${cursor ? "AND (created_at,id)<(?,?)" : ""}
    ORDER BY created_at DESC,id DESC LIMIT 51`).bind(mapping.account_id,mapping.project_id,asOf,...(cursor?.after ?? [])).all<Candidate>();
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
      limit,hasMore,nextCursor:hasMore?await encodeCursor(env,actor,{v:1,root:tuple,projectId,context:context.contextVersion,
        project:projectProof,feedback:feedbackPolicy.proof,mapping:mappedProof,asOf,after:[last!.created_at,last!.id],expires:Date.now()+30*60_000}):null}};
}
