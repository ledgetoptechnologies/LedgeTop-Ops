import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { base64Url, sha256 } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type PendingStatus = "submitted" | "under_review" | "accepted_pending_pa_linkage";
export interface StaffInboxRequestItem {
  id: string; title: string; accountName: string; projectName: string | null; status: PendingStatus; createdAt: string;
}
interface RequestRow {
  id: string; title: string; account_name: string; project_name: string | null; status: PendingStatus; created_at: string;
  account_id: string; project_id: string | null; catalog_source_id: string;
  account_source: string | null; account_client: string | null; account_organization: string | null;
  project_source: string | null; source_project: string | null;
}
interface Cursor { v: 1; q: string; policy: string; after: [string,string]; expires: number }
const cursorSchema = z.object({ v:z.literal(1),q:z.string().max(200),policy:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  after:z.tuple([z.string().min(1).max(64),z.string().min(1).max(128)]),
  expires:z.number().int().positive() }).strict();
const pending = "r.status IN ('submitted','under_review','accepted_pending_pa_linkage')";
function changed(): never { throw new HTTPException(409,{message:"Request inbox or access changed. Refresh before continuing."}); }
function queryText(value: string): string {
  if (value.length>200 || /[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new HTTPException(400,{message:"Request inbox search is invalid"});
  // SQLite lower() folds ASCII, not Unicode. Preserve non-ASCII case here so
  // exact NFC Unicode text remains searchable; do not claim full case folding.
  const normalized=value.normalize("NFC").trim();
  if(normalized.length>200)throw new HTTPException(400,{message:"Request inbox search is invalid"});
  return normalized;
}
async function policy(env: Env, principal: StaffPrincipal): Promise<string> {
  if(!principal?.id)throw new HTTPException(401,{message:"Staff authentication required"});
  const [current,scope]=await Promise.all([
    env.OPS_DB.withSession("first-primary").prepare(`SELECT email,access_subject,project_alpha_user_id
      FROM staff_users WHERE id=? AND status='active'`).bind(principal.id)
      .first<{email:string;access_subject:string|null;project_alpha_user_id:string|null}>(),
    sqlScope(env,principal,"operations.manage"),
  ]);
  if(!current || current.email!==principal.email || current.access_subject!==principal.accessSubject
    || current.project_alpha_user_id!==principal.projectAlphaUserId)
    throw new HTTPException(403,{message:"Current staff authentication required"});
  // Exact existing /api/client-service-requests global triage policy.
  // A division/assigned allowance alone must never expose this global queue.
  if(!scope.global || scope.deniedGlobal)
    throw new HTTPException(403,{message:"Global operations.manage permission required"});
  return sha256(JSON.stringify([principal.id,current,{...scope,
    divisions:[...scope.divisions].sort(),deniedDivisions:[...scope.deniedDivisions].sort()}]));
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if(!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length<32)
    throw new HTTPException(503,{message:"Request inbox cursor configuration is unavailable"});
  const key=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("staff-inbox-requests:v1:"+env.OPERATIONS_SESSION_SECRET));
  return crypto.subtle.importKey("raw",key,"AES-GCM",false,["encrypt","decrypt"]);
}
function decode64(text:string):Uint8Array<ArrayBuffer>{
  if(!/^[A-Za-z0-9_-]+$/.test(text))throw new Error("invalid token");
  const bytes=Uint8Array.from(atob(text.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0));
  if(base64Url(bytes)!==text)throw new Error("noncanonical token");
  return bytes;
}
async function encodeCursor(env:Env,principal:StaffPrincipal,value:Cursor):Promise<string>{
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new TextEncoder().encode(principal.id)},
    await encryptionKey(env),new TextEncoder().encode(JSON.stringify(value)));
  return base64Url(iv)+"."+base64Url(new Uint8Array(encrypted));
}
async function decodeCursor(env:Env,principal:StaffPrincipal,token:string,q:string,proof:string):Promise<Cursor>{
  const key=await encryptionKey(env);
  let cursor:Cursor;
  try{
    if(token.length>4096)throw new Error("oversized token");
    const [iv,body,extra]=token.split(".");
    if(!iv || !body || extra!==undefined)throw new Error("invalid token");
    const ivBytes=decode64(iv);if(ivBytes.length!==12)throw new Error("invalid iv");
    const bytes=await crypto.subtle.decrypt({name:"AES-GCM",iv:ivBytes,additionalData:new TextEncoder().encode(principal.id)},
      key,decode64(body));
    cursor=cursorSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
  }catch{throw new HTTPException(400,{message:"Request inbox cursor is invalid"});}
  if(cursor.q!==q || cursor.policy!==proof || cursor.expires<=Date.now())changed();
  return cursor;
}
function selectedRows(db:D1DatabaseSession,q:string,cursor:Cursor|null):Promise<D1Result<RequestRow>>{
  // Preserve the established multi-source staff triage boundary: active account,
  // not primary-only catalog/project provenance or a current client-view grant.
  // Those are separate portal/outbound authorities, not global staff triage.
  return db.prepare(`SELECT r.id,substr(r.title,1,500) title,substr(a.display_name,1,500) account_name,substr(p.project_name,1,500) project_name,
    r.status,r.created_at,r.account_id,r.project_id,r.catalog_source_id,
    a.project_alpha_source_id account_source,a.project_alpha_client_id account_client,a.project_alpha_organization_id account_organization,
    p.project_alpha_source_id project_source,p.project_alpha_project_id source_project
    FROM client_service_requests r JOIN client_accounts a ON a.id=r.account_id AND a.status='active'
    LEFT JOIN projects p ON p.id=r.project_id
    WHERE ${pending}
      ${q?"AND (instr(lower(r.title),lower(?))>0 OR instr(lower(a.display_name),lower(?))>0 OR instr(lower(COALESCE(p.project_name,'')),lower(?))>0 OR instr(lower(COALESCE(p.client_name,'')),lower(?))>0)":""}
      ${cursor?"AND (r.created_at,r.id)>(?,?)":""}
    ORDER BY r.created_at ASC,r.id ASC LIMIT 26`)
    .bind(...(q?[q,q,q,q]:[]),...(cursor?.after??[])).all<RequestRow>();
}
function display(value:string):string{return value.replace(/[\u0000-\u001f\u007f-\u009f]/g," ").trim();}
function timestamp(value:string):string{
  const iso=value.replace(" ","T"),at=Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(iso)?iso:iso+"Z");
  if(!Number.isFinite(at))throw new HTTPException(503,{message:"Request inbox timestamp is unavailable"});
  return new Date(at).toISOString();
}
export async function listStaffInboxRequests(env:Env,principal:StaffPrincipal,query:{q?:string;cursor?:string}={}):
  Promise<{items:StaffInboxRequestItem[];nextCursor:string|null}>{
  const q=queryText(query.q??""),proof=await policy(env,principal);
  const cursor=query.cursor===undefined?null:await decodeCursor(env,principal,query.cursor,q,proof);
  const rows=(await selectedRows(env.DELIVERY_DB.withSession("first-primary"),q,cursor)).results;
  // Recheck the bounded page, including its lookahead, under current account,
  // pending-state and ownership facts. No stale DTO is released after revocation.
  const current=(await selectedRows(env.DELIVERY_DB.withSession("first-primary"),q,cursor)).results;
  if(JSON.stringify(current)!==JSON.stringify(rows))changed();
  if(await policy(env,principal)!==proof)changed();
  const visible=rows.slice(0,25),last=visible.at(-1);
  return {items:visible.map(row=>({id:row.id,title:display(row.title),accountName:display(row.account_name),
    projectName:row.project_name===null?null:display(row.project_name),status:row.status,createdAt:timestamp(row.created_at)})),
    nextCursor:rows.length>25&&last?await encodeCursor(env,principal,{v:1,q,policy:proof,
      after:[last.created_at,last.id],expires:Date.now()+30*60_000}):null};
}
/** Mounted after the existing Operations authentication/origin middleware.
 * Read-only endpoint; no separate or weaker division-level grant is introduced. */
export function registerStaffInboxRequestRoutes(app:App):void{
  app.get("/api/operations/inbox/requests",async c=>{
    c.header("Cache-Control","no-store");
    const params=new URL(c.req.url).searchParams;
    for(const name of params.keys())if((name!=="q"&&name!=="cursor")||params.getAll(name).length!==1)
      throw new HTTPException(400,{message:"Request inbox query is invalid"});
    return c.json(await listStaffInboxRequests(c.env,c.get("principal"),{
      q:params.get("q")??undefined,cursor:params.get("cursor")??undefined}));
  });
}
