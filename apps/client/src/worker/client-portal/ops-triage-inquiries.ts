import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { d1TablesPresent } from "../schema-readiness";
import { sha256Hex } from "../security";
import { nativeRequestMutationGuardSql, type NativeRequestAuthorityProof } from "./native-request-authority";

export type OpsTriageInquiryKind = "website" | "drone" | "other";
export interface OpsTriageInquiryInput {
  kind: OpsTriageInquiryKind;
  title: string;
  details: string;
  location: string | null;
  idempotencyKey: string;
}
export interface OpsTriageInquiryReceipt {
  id: string;
  kind: OpsTriageInquiryKind;
  title: string;
  details: string;
  location: string | null;
  status: "received" | "under_review" | "declined" | "closed";
  createdAt: string;
}
export type SubmitOpsTriageInquiryResult =
  | { kind: "created"; inquiry: OpsTriageInquiryReceipt }
  | { kind: "replayed"; inquiry: OpsTriageInquiryReceipt }
  | { kind: "conflict" }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };
type InquiryRow = { id:string;kind:OpsTriageInquiryKind;title:string;details:string;location:string|null;
  status:OpsTriageInquiryReceipt["status"];created_at:string;request_fingerprint:string };

function database(env: Env) {
  return env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
}
export async function opsTriageInquirySchemaReady(env:Env):Promise<boolean>{
  if(!env.DELIVERY_DB)return false;
  try{return await d1TablesPresent(env.DELIVERY_DB,["client_ops_triage_inquiries","client_ops_triage_notification_outbox"]);}
  catch{return false;}
}
function iso(value: string): string {
  const normalized = value.replace(" ", "T");
  return new Date(normalized + (/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? "" : "Z")).toISOString();
}
function receipt(row:InquiryRow):OpsTriageInquiryReceipt{
  return {id:row.id,kind:row.kind,title:row.title,details:row.details,location:row.location,status:row.status,createdAt:iso(row.created_at)};
}
function selectByKeySql(guardSql:string):string{
  return "SELECT id,kind,title,details,location,status,created_at,request_fingerprint FROM client_ops_triage_inquiries "+
    "WHERE portal_identity_id=? AND idempotency_key=? AND "+guardSql;
}

/** Writes a typed intake record without entering the account/catalog/PA request lifecycle. */
export async function submitOpsTriageInquiry(
  env: Env, proof: NativeRequestAuthorityProof, input: OpsTriageInquiryInput,
): Promise<SubmitOpsTriageInquiryResult> {
  const fingerprint = await sha256Hex(JSON.stringify({ kind: input.kind, title: input.title, details: input.details, location:input.location }));
  const db = database(env), guard = nativeRequestMutationGuardSql(proof), selectByKey=selectByKeySql(guard.sql);
  let prior:InquiryRow|null;
  try{prior=await db.prepare(selectByKey).bind(proof.identityId,input.idempotencyKey,...guard.bindings).first<InquiryRow>();}
  catch{throw new HTTPException(503,{message:"Inquiry storage is unavailable"});}
  if(prior){
    if(prior.request_fingerprint!==fingerprint)return{kind:"conflict"};
    return{kind:"replayed",inquiry:receipt(prior)};
  }
  const id=crypto.randomUUID(),outboxId=crypto.randomUUID();
  const insert=db.prepare("INSERT INTO client_ops_triage_inquiries "+
    "(id,portal_identity_id,authorizing_workspace_id,authorizing_source_id,kind,title,details,location,idempotency_key,request_fingerprint) "+
    "SELECT ?,?,?,?,?,?,?,?,?,? WHERE "+guard.sql+" ON CONFLICT(portal_identity_id,idempotency_key) DO NOTHING")
    .bind(id,proof.identityId,proof.workspaceId,proof.sourceId,input.kind,input.title,input.details,input.location,
      input.idempotencyKey,fingerprint,...guard.bindings);
  const outbox=db.prepare("INSERT INTO client_ops_triage_notification_outbox "+
    "(id,inquiry_id,event_type,recipient_kind,dedupe_key,payload_json) "+
    "SELECT ?,id,'inquiry_submitted','staff_triage',?,json_object('kind',kind,'title',title) "+
    "FROM client_ops_triage_inquiries WHERE id=? AND portal_identity_id=?")
    .bind(outboxId,id+":inquiry_submitted:staff_triage",id,proof.identityId);
  const audit=db.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) "+
    "SELECT 'client',?,'client.ops_triage_inquiry.submitted','client_ops_triage_inquiry',?,json_object('workspaceId',?,'sourceId',?,'kind',?) "+
    "WHERE EXISTS(SELECT 1 FROM client_ops_triage_inquiries WHERE id=? AND portal_identity_id=?)")
    .bind(proof.identityId,id,proof.workspaceId,proof.sourceId,input.kind,id,proof.identityId);
  try{await db.batch([insert,outbox,audit]);}catch{/* Reconcile this exact key below; never retry the mutation. */}
  let winner:InquiryRow|null;
  try{winner=await db.prepare(selectByKey).bind(proof.identityId,input.idempotencyKey,...guard.bindings).first<InquiryRow>();}
  catch{throw new HTTPException(503,{message:"Inquiry result is uncertain; retry with the same idempotency key"});}
  if(!winner){
    let authorized:number|null;
    try{authorized=await db.prepare("SELECT "+guard.sql+" authorized").bind(...guard.bindings).first<number>("authorized");}
    catch{throw new HTTPException(503,{message:"Inquiry result is uncertain; retry with the same idempotency key"});}
    if(authorized!==1)return{kind:"unauthorized"};
    return{kind:"unavailable"};
  }
  if(winner.request_fingerprint!==fingerprint)return{kind:"conflict"};
  return{kind:winner.id===id?"created":"replayed",inquiry:receipt(winner)};
}

export async function listOpsTriageInquiries(env:Env,proof:NativeRequestAuthorityProof,limit=25):Promise<OpsTriageInquiryReceipt[]>{
  const db=database(env),guard=nativeRequestMutationGuardSql(proof);
  try{
    const authorized=await db.prepare("SELECT "+guard.sql+" authorized").bind(...guard.bindings).first<number>("authorized");
    if(authorized!==1)throw new HTTPException(403,{message:"Inquiry history access is unavailable"});
    const rows=await db.prepare("SELECT id,kind,title,details,location,status,created_at,request_fingerprint "+
      "FROM client_ops_triage_inquiries WHERE portal_identity_id=? AND "+guard.sql+" ORDER BY created_at DESC,id DESC LIMIT ?")
      .bind(proof.identityId,...guard.bindings,Math.min(50,Math.max(1,limit))).all<InquiryRow>();
    const stillAuthorized=await db.prepare("SELECT "+guard.sql+" authorized").bind(...guard.bindings).first<number>("authorized");
    if(stillAuthorized!==1)throw new HTTPException(403,{message:"Inquiry history access changed. Refresh and try again."});
    return rows.results.map(receipt);
  }catch(error){
    if(error instanceof HTTPException)throw error;
    throw new HTTPException(503,{message:"Inquiry history is unavailable"});
  }
}
