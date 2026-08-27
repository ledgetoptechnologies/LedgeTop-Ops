import { HTTPException } from "hono/http-exception";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { clientHubBusinessProjectSourceProof, clientHubBusinessProjectOwnership } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubCollectionContext, ClientHubCollectionPage } from "./client-hub-collections";
import type { Env, StaffPrincipal } from "./types";
import type { SqlFilter } from "./visibility";

export type BusinessActivityRecordKind = "organization" | "client" | "project";
export interface ClientBusinessActivityItem {
  id: string; sourceId: string; recordKind: BusinessActivityRecordKind; recordId: string; recordName: string;
  action: "upsert" | "revoke" | "source_record_updated";
  origin: "projection_event" | "source_observation";
  occurredAt: string; observedAt: string; detailPath: string | null;
}
export interface ClientBusinessActivityPage {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"]; contextVersion: string;
  refreshedAt: string; asOf: string; coverage: "source_records_only";
  items: ClientBusinessActivityItem[]; page: ClientHubCollectionPage;
}
interface ActivityRow {
  sequence: number; projection_source_id: string; record_kind: BusinessActivityRecordKind; record_id: string;
  record_name: string; action: ClientBusinessActivityItem["action"]; origin: ClientBusinessActivityItem["origin"];
  occurred_at: string; observed_at: string;
}
interface ActivityCursor {
  v: 1; root: string[]; context: string; policy: string; source: string; projectId: string | null;
  revision: number; asOf: string; after: [string, number];
}
const canonicalTime = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identifier = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);

/** Strict source time, never generated_at, received_at or the local sync clock.
 * SQL timestamp strings without a zone have the established Alpha UTC meaning. */
export function normalizeBusinessActivityTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 35
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  const day = value.slice(0,10);
  const dayAt = Date.parse(day);
  if (!Number.isFinite(dayAt) || new Date(dayAt).toISOString().slice(0,10) !== day
    || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) return null;
  const timestamp = Date.parse(/[Z]|[+-]\d{2}:\d{2}$/.test(value.slice(19)) ? value : value + "Z");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Append to the SAME fenced OPS batch as the applied source row. A receipt is
 * not an actor. Missing/unresolvable ownership omits the event, never guesses.
 * Existence is checked explicitly: outer UPSERT conflict policy can override
 * INSERT OR IGNORE inside triggers. */
export function businessActivityProjectionStatement(db: Pick<D1Database,"prepare">, input: {
  sourceId: string; eventId: string; recordKind: BusinessActivityRecordKind; recordId: string;
  action: "upsert" | "revoke"; occurredAt: string; sourceUpdatedAt: string;
}): D1PreparedStatement | null {
  const at = normalizeBusinessActivityTime(input.occurredAt);
  const sourceAt = normalizeBusinessActivityTime(input.sourceUpdatedAt);
  if (!at || !sourceAt) return null;
  return db.prepare(`INSERT INTO client_business_activity
    (projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
    SELECT record.projection_source_id,?,'projection_event',record.record_kind,record.record_id,
      record.root_kind,record.root_id,record.root_record_kind,?,?,?
    FROM client_business_activity_records record
    WHERE record.projection_source_id=? AND record.record_kind=? AND record.record_id=? AND record.root_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM pa_projection_record_ids root_map WHERE root_map.projection_source_id=record.projection_source_id
        AND root_map.record_kind=record.root_record_kind AND root_map.local_id=record.root_id)
      AND NOT EXISTS(SELECT 1 FROM client_business_activity prior
        WHERE prior.projection_source_id=record.projection_source_id AND prior.event_key=?
          AND prior.origin='projection_event' AND prior.record_kind=record.record_kind AND prior.record_id=record.record_id
          AND prior.action=? AND prior.occurred_at=? AND prior.source_updated_at=?)`)
    .bind("event:" + input.eventId,input.action,at,sourceAt,input.sourceId,input.recordKind,input.recordId,
      "event:" + input.eventId,input.action,at,sourceAt);
}

/** Run after all changed snapshot rows have landed: a client can appear before
 * its organization in the snapshot. No supplied date means no observation. */
export function businessActivityObservationStatement(db: Pick<D1Database,"prepare">, sourceId: string,
  recordKind: BusinessActivityRecordKind, recordId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO client_business_activity
    (projection_source_id,event_key,origin,record_kind,record_id,root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
    SELECT observation.projection_source_id,observation.event_key,'source_observation',observation.record_kind,observation.record_id,
      observation.root_kind,observation.root_id,observation.root_record_kind,'source_record_updated',observation.occurred_at,observation.occurred_at
    FROM client_business_activity_observations observation
    WHERE observation.projection_source_id=? AND observation.record_kind=? AND observation.record_id=?
      AND NOT EXISTS(SELECT 1 FROM client_business_activity prior
        WHERE prior.projection_source_id=observation.projection_source_id AND prior.event_key=observation.event_key)`)
    .bind(sourceId,recordKind,recordId);
}

export function eligibleBusinessActivitySql(projectFilter: SqlFilter, asOf: string): SqlFilter {
  if (!canonicalTime(asOf)) throw new Error("business-activity-as-of-invalid");
  return { sql: `SELECT activity.*,substr(record.record_name,1,500) record_name
    FROM client_business_activity activity
    JOIN client_business_activity_records record ON record.projection_source_id=activity.projection_source_id
      AND record.record_kind=activity.record_kind AND record.record_id=activity.record_id
      AND record.root_kind=activity.root_kind AND record.root_id=activity.root_id AND record.readable=1
    LEFT JOIN pa_projects p ON activity.record_kind='project' AND p.id=activity.record_id
      AND p.projection_source_id=activity.projection_source_id
    WHERE ${projectAlphaReadVisibleSql("activity.projection_source_id")}
      AND (activity.record_kind<>'project' OR (${projectFilter.sql}))
      AND (activity.origin<>'source_observation' OR NOT EXISTS(SELECT 1 FROM client_business_activity applied
        WHERE applied.projection_source_id=activity.projection_source_id AND applied.record_kind=activity.record_kind
          AND applied.record_id=activity.record_id AND applied.source_updated_at=activity.source_updated_at
          AND applied.root_kind=activity.root_kind AND applied.root_id=activity.root_id
          AND applied.origin='projection_event' AND applied.occurred_at<=?))
      AND activity.occurred_at<=?`, values: [...projectFilter.values,asOf,asOf] };
}

/** Caller must require global team.view first. Project authorization is applied
 * before MAX: a hidden project cannot change a visible customer's sort order.
 * No raw payload or globally cached maximum is returned. */
export function businessActivityRecencyCte(projectFilter: SqlFilter, asOf: string): SqlFilter {
  const eligible = eligibleBusinessActivitySql(projectFilter,asOf);
  return { sql: `business_activity_eligible AS (${eligible.sql}),
    business_activity_roots AS (
      SELECT projection_source_id source_id,root_kind,root_id,MAX(occurred_at) meaningful_activity_at
      FROM business_activity_eligible GROUP BY projection_source_id,root_kind,root_id
    )`, values: eligible.values };
}
function changed(): never {
  throw new HTTPException(409,{message:"Business activity or access changed. Refresh the client workspace to continue"});
}
function encode(cursor: ActivityCursor): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)),v=>String.fromCharCode(v)).join(""))
    .replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
function decode(raw: string): ActivityCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,8192}$/.test(raw)) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
      Uint8Array.from(atob(raw.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0))));
    if (!value || typeof value !== "object") throw new Error();
    const cursor = value as Partial<ActivityCursor>;
    if (cursor.v!==1 || !Array.isArray(cursor.root) || cursor.root.length!==4 || !cursor.root.every(identifier)
      || ![cursor.context,cursor.policy,cursor.source].every(v=>typeof v==="string" && /^[A-Za-z0-9_-]{43}$/.test(v))
      || !(cursor.projectId===null || identifier(cursor.projectId))
      || !Number.isSafeInteger(cursor.revision) || cursor.revision!<0 || !canonicalTime(cursor.asOf)
      || Date.parse(cursor.asOf)>Date.now() || !Array.isArray(cursor.after) || cursor.after.length!==2
      || !canonicalTime(cursor.after[0]) || cursor.after[0]>cursor.asOf || !Number.isSafeInteger(cursor.after[1]) || cursor.after[1]<1) throw new Error();
    return cursor as ActivityCursor;
  } catch { throw new HTTPException(400,{message:"Business activity cursor is invalid"}); }
}
function rootPath(context: ClientHubCollectionContext): string {
  const r=context.root;
  return `/clients/sources/${encodeURIComponent(r.source_id)}/business/${r.kind==="organization"?"organizations":"standalone"}/${encodeURIComponent(r.public_id)}`;
}
async function exactProject(env: Env, context: ClientHubCollectionContext, projectId: string, filter: SqlFilter): Promise<void> {
  const ownership=clientHubBusinessProjectOwnership(context);
  const row=await env.OPS_DB.withSession("first-primary").prepare(`SELECT p.id FROM pa_projects p
    LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.id=? AND (${ownership.sql}) AND (${filter.sql}) LIMIT 1`)
    .bind(projectId,...ownership.values,...filter.values).first();
  if (!row) throw new HTTPException(404,{message:"Business project not found"});
}

/** Source-record history only. These are live, bounded pages with explicit
 * change invalidation, not a snapshot of all business activity. Route callers
 * must also verify their shared Client Hub context after this read. */
export async function listClientBusinessActivity(env: Env, principal: StaffPrincipal, context: ClientHubCollectionContext,
  options: {projectId?: string; limit?: number; cursor?: string} = {}): Promise<ClientBusinessActivityPage> {
  const limit=options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || (options.projectId!==undefined && !identifier(options.projectId)))
    throw new HTTPException(400,{message:"Business activity query is invalid"});
  if (!context.access.directory) throw new HTTPException(403,{message:"Global team.view permission required"});
  const tuple=[context.root.source_id,context.root.root_namespace,context.root.kind,context.root.public_id];
  const cursor=options.cursor===undefined?null:decode(options.cursor);
  if (cursor && (JSON.stringify(cursor.root)!==JSON.stringify(tuple) || cursor.projectId!==(options.projectId??null)))
    throw new HTTPException(400,{message:"Business activity cursor does not match this resource"});
  if (cursor && cursor.context!==context.contextVersion) changed();
  const asOf=cursor?.asOf ?? new Date().toISOString();
  const response: ClientBusinessActivityPage={canonicalRoot:context.canonicalRoot,contextVersion:context.contextVersion,
    refreshedAt:new Date().toISOString(),asOf,coverage:"source_records_only",items:[],
    page:{available:context.root.root_namespace==="business",reason:context.root.root_namespace==="business"?null:"not_applicable",
      nextCursor:null,hasMore:false,returned:0,limit}};
  if (!response.page.available) return response;
  const policy=await readClientHubBusinessProjectPolicy(env,principal);
  const source=await clientHubBusinessProjectSourceProof(env,context);
  if (options.projectId) await exactProject(env,context,options.projectId,policy.filter);
  if (cursor && (cursor.policy!==policy.proof || cursor.source!==source)) changed();
  const eligible=eligibleBusinessActivitySql(policy.filter,asOf);
  const db=env.OPS_DB.withSession("first-primary");
  const results=await db.batch<ActivityRow|{revision:number}>([
    db.prepare("SELECT revision FROM client_business_activity_state WHERE singleton=1"),
    db.prepare(`WITH eligible AS (${eligible.sql}) SELECT * FROM eligible
      WHERE projection_source_id=? AND root_kind=? AND root_id=?
      ${options.projectId?"AND record_kind='project' AND record_id=?":""}
      ${cursor?"AND (occurred_at,sequence)<(?,?)":""}
      ORDER BY occurred_at DESC,sequence DESC LIMIT ?`).bind(...eligible.values,context.root.source_id,context.root.kind,
        context.root.public_id,...(options.projectId?[options.projectId]:[]),...(cursor?.after??[]),limit+1),
  ]);
  const state=results[0]!.results.find((row):row is {revision:number}=>"revision" in row);
  if (!state || !Number.isSafeInteger(state.revision)) throw new HTTPException(503,{message:"Business activity is unavailable"});
  if (cursor && state.revision!==cursor.revision) changed();
  const rows=results[1]!.results.filter((row):row is ActivityRow=>"sequence" in row);
  const pageRows=rows.slice(0,limit);
  const [nowPolicy,nowSource,nowRevision]=await Promise.all([
    readClientHubBusinessProjectPolicy(env,principal),clientHubBusinessProjectSourceProof(env,context),
    env.OPS_DB.withSession("first-primary").prepare("SELECT revision FROM client_business_activity_state WHERE singleton=1").first<number>("revision"),
  ]);
  if (nowPolicy.proof!==policy.proof || nowSource!==source || nowRevision!==state.revision) changed();
  response.items=pageRows.map(row=>({id:String(row.sequence),sourceId:row.projection_source_id,recordKind:row.record_kind,
    recordId:row.record_id,recordName:row.record_name.replace(/[\u0000-\u001f\u007f-\u009f]/g," ").trim() || "Source record",action:row.action,origin:row.origin,
    occurredAt:row.occurred_at,observedAt:row.observed_at,
    detailPath:row.record_kind==="project"?rootPath(context)+"/projects/"+encodeURIComponent(row.record_id):rootPath(context)}));
  response.page.returned=pageRows.length; response.page.hasMore=rows.length>limit;
  if (response.page.hasMore) {
    const last=pageRows[pageRows.length-1]!;
    response.page.nextCursor=encode({v:1,root:tuple,context:context.contextVersion,policy:policy.proof,source,
      projectId:options.projectId??null,revision:state.revision,asOf,after:[last.occurred_at,last.sequence]});
  }
  return response;
}
