import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Context } from "hono";
import type { Env } from "./types";
import { createProjectAlphaDeliveryGuestShare, revokeProjectAlphaDeliveryGuestShare } from "./delivery";
import { resolveProjectAlphaDeliveryPrincipal } from "./share-recipients";

const PATH = "/api/internal/project-alpha/delivery-intents";
const PREFLIGHT_PATH = `${PATH}/preflight`;
const REVOKE_PATH = `${PATH}/revoke`;
const MAX_BODY = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const preflightSchema = z.object({ schemaVersion: z.literal(1), applicationKey: z.string(),
  deliveryId: z.string().regex(SAFE_ID), occurredAt: z.iso.datetime({ offset: true }) }).strict();
const intentSchema = preflightSchema.extend({
  scope: z.object({ type: z.enum(["organization","department","client","project"]), publicId: z.string().regex(SAFE_ID) }).strict(),
  audience: z.object({ type: z.literal("principal"), publicId: z.string().regex(SAFE_ID) }).strict(),
  accessMode: z.enum(["portal","guest"]), expiresAt: z.iso.datetime({ offset: true }).nullable(),
  label: z.string().trim().max(160).nullable(), notify: z.literal(true),
}).strict();
const revokeSchema=preflightSchema.extend({receiptId:z.string().regex(SAFE_ID),reasonCode:z.literal("project_alpha_delivery_revoked")}).strict();

type IntentContext = Context<{ Bindings: Env }>;
function db(env: Env): D1Database { const value = env.DELIVERY_DB as D1Database & { withSession?: (v:"first-primary")=>D1Database }; return value.withSession?.("first-primary") ?? value; }
async function body(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) throw new HTTPException(413, { message: "Delivery intent is too large" });
  const value = new Uint8Array(await request.arrayBuffer());
  if (!value.length || value.length > MAX_BODY) throw new HTTPException(400, { message: "Delivery intent body is invalid" });
  return value;
}
async function hex(value: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice().buffer))].map(v=>v.toString(16).padStart(2,"0")).join(""); }
function fromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) || [], v=>parseInt(v,16)); }
async function authenticate(env: Env, request: Request, raw: Uint8Array, path: string): Promise<{ deliveryId:string; fingerprint:string }> {
  const applicationKey=request.headers.get("X-Portal-Integration-Application-Key")||"", timestamp=request.headers.get("X-Portal-Integration-Timestamp")||"";
  const digest=(request.headers.get("X-Portal-Integration-Body-SHA256")||"").toLowerCase(), keyId=request.headers.get("X-Portal-Integration-Key-Id")||"";
  const deliveryId=request.headers.get("X-Portal-Integration-Delivery-Id")||"", signature=request.headers.get("X-Portal-Integration-Signature")||"";
  const secret=keyId===env.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID?env.PROJECT_ALPHA_PORTAL_HMAC_SECRET:keyId===env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID?env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET:undefined;
  const timestampMs=Date.parse(timestamp);
  if (!env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY || applicationKey!==env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY || !SAFE_ID.test(keyId) || !SAFE_ID.test(deliveryId) ||
      !timestamp || !Number.isFinite(timestampMs) || Math.abs(Date.now()-timestampMs)>300_000 || !HEX.test(digest) || digest!==await hex(raw) || !secret || secret.length<32 || !signature.startsWith("sha256=") || !HEX.test(signature.slice(7).toLowerCase()))
    throw new HTTPException(401, { message: "Project Alpha delivery authentication failed" });
  const canonical=encoder.encode(`${timestamp}\nPOST\n${path}\n${keyId}\n${deliveryId}\n${new TextDecoder().decode(raw)}`);
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const supplied=fromHex(signature.slice(7).toLowerCase());
  if (!await crypto.subtle.verify("HMAC",key,supplied.buffer.slice(supplied.byteOffset,supplied.byteOffset+supplied.byteLength) as ArrayBuffer,canonical))
    throw new HTTPException(401, { message: "Project Alpha delivery authentication failed" });
  return { deliveryId, fingerprint:digest };
}

export function projectAlphaDeliveryMachineRequest(method:string,path:string): boolean { return method.toUpperCase()==="POST" && (path===PATH || path===PREFLIGHT_PATH || path===REVOKE_PATH); }
export function projectAlphaDeliveryMachineHostRequest(urlValue:string,method:string,env:Pick<Env,"INCOMING_EXPECTED_HOST">):boolean{
  try{const url=new URL(urlValue);return url.host===env.INCOMING_EXPECTED_HOST&&projectAlphaDeliveryMachineRequest(method,url.pathname);}catch{return false;}
}
function decode(raw:Uint8Array):unknown{try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));}catch{throw new HTTPException(400,{message:"Delivery intent JSON is invalid"});}}
async function rate(env:Env,scope:"preflight"|"intent"):Promise<void>{
  const maximum=scope==="preflight"?120:60;
  const count=await env.OPS_DB.prepare(`INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count)
    VALUES(?,strftime('%Y-%m-%dT%H:%M:00Z','now'),1) ON CONFLICT(scope,window_start) DO UPDATE SET request_count=request_count+1
    WHERE request_count<? RETURNING request_count`).bind(scope,maximum).first<number>("request_count");
  if(typeof count!=="number"||count>maximum)throw new HTTPException(429,{message:"Too many Project Alpha delivery requests"});
}
export async function pruneProjectAlphaDeliveryIntentRateLimits(env:Pick<Env,"OPS_DB">):Promise<number>{
  const result=await env.OPS_DB.prepare(`DELETE FROM project_alpha_delivery_intent_rate_limits WHERE rowid IN
    (SELECT rowid FROM project_alpha_delivery_intent_rate_limits WHERE datetime(window_start)<=datetime('now','-10 minutes') LIMIT 1000)`).run();
  return result.meta.changes||0;
}
export async function handleProjectAlphaDeliveryPreflight(c: IntentContext) {
  const raw=await body(c.req.raw), auth=await authenticate(c.env,c.req.raw,raw,PREFLIGHT_PATH);
  await rate(c.env,"preflight");
  const parsed=preflightSchema.safeParse(decode(raw));
  if (!parsed.success || parsed.data.applicationKey!==c.env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY || parsed.data.deliveryId!==auth.deliveryId)
    throw new HTTPException(400,{message:"Delivery preflight is invalid"});
  return c.json({ status:"ready" as const,schemaVersion:1 as const,
    integrationEnabled:c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED==="true",
    portalSupported:c.env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true" && c.env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED==="true",
    guestSupported:c.env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED==="true",revocationSupported:true });
}

export async function handleProjectAlphaDeliveryIntent(c: IntentContext) {
  if (c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true") throw new HTTPException(404,{message:"Not found"});
  const raw=await body(c.req.raw), auth=await authenticate(c.env,c.req.raw,raw,PATH);
  await rate(c.env,"intent");
  const parsed=intentSchema.safeParse(decode(raw));
  if (!parsed.success || parsed.data.applicationKey!==c.env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY || parsed.data.deliveryId!==auth.deliveryId)
    throw new HTTPException(400,{message:"Delivery intent is invalid"});
  if(parsed.data.accessMode==="portal"&&(c.env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED!=="true"||c.env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED!=="true"))
    throw new HTTPException(404,{message:"Not found"});
  let effectiveExpiry=parsed.data.expiresAt;
  if(parsed.data.accessMode==="guest"){
    effectiveExpiry=effectiveExpiry??new Date(Date.now()+30*24*60*60*1000).toISOString();
    const expiry=Date.parse(effectiveExpiry);
    if(!Number.isFinite(expiry)||expiry<=Date.now()+5*60*1000||expiry>Date.now()+90*24*60*60*1000)
      throw new HTTPException(400,{message:"Guest delivery expiry is invalid"});
  }else if(effectiveExpiry!==null){
    const expiry=Date.parse(effectiveExpiry);
    if(!Number.isFinite(expiry)||expiry<=Date.now()+5*60*1000||expiry>Date.now()+366*24*60*60*1000)
      throw new HTTPException(400,{message:"Portal delivery expiry is invalid"});
  }
  const database=db(c.env), prior=await database.prepare("SELECT receipt_id,request_fingerprint FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?").bind(auth.deliveryId).first<{receipt_id:string;request_fingerprint:string}>();
  if (prior) { if(prior.request_fingerprint!==auth.fingerprint) throw new HTTPException(409,{message:"Delivery ID was already used"}); return c.json({receiptId:prior.receipt_id,status:"accepted" as const},202); }
  const bindings=await database.prepare(`SELECT b.id,b.workspace_id,b.source_version,b.r2_prefix,cp.active_generation_id FROM portal_v2_folder_bindings b
    JOIN portal_v2_workspaces w ON w.id=b.workspace_id AND w.status='active'
    JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=b.workspace_id
    JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities e ON e.workspace_id=b.workspace_id AND e.generation_id=cp.active_generation_id
      AND e.entity_type=b.owner_scope_type AND e.public_id=b.owner_public_id AND e.active=1 AND e.source_version=b.source_version
    WHERE b.status='active' AND b.revoked_at IS NULL AND b.owner_scope_type=? AND b.owner_public_id=? LIMIT 2`)
    .bind(parsed.data.scope.type,parsed.data.scope.publicId).all<{id:string;workspace_id:string;source_version:string;active_generation_id:string;r2_prefix:string}>();
  if(bindings.results.length!==1) throw new HTTPException(409,{message:"Delivery scope is not uniquely bound"});
  const binding=bindings.results[0]!;
  const audience=parsed.data.audience.type==="principal"
    ? await database.prepare(`SELECT source_version FROM pa_portal_principals WHERE workspace_id=? AND public_id=? AND status='active'`).bind(binding.workspace_id,parsed.data.audience.publicId).first<{source_version:string}>()
    : await database.prepare(`SELECT source_version FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND entity_type=? AND public_id=? AND active=1`).bind(binding.workspace_id,binding.active_generation_id,parsed.data.audience.type,parsed.data.audience.publicId).first<{source_version:string}>();
  if(!audience) throw new HTTPException(404,{message:"Delivery audience not found"});
  await resolveProjectAlphaDeliveryPrincipal(c.env,binding.r2_prefix,parsed.data.audience.publicId,audience.source_version);
  if(parsed.data.accessMode==="guest"){
    if(c.env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED!=="true")throw new HTTPException(404,{message:"Not found"});
    const receiptId=crypto.randomUUID();
    await createProjectAlphaDeliveryGuestShare(c.env,{deliveryId:auth.deliveryId,receiptId,fingerprint:auth.fingerprint,
      r2Prefix:binding.r2_prefix,label:parsed.data.label,expiresAt:effectiveExpiry!,
      audience:{...parsed.data.audience,sourceVersion:audience.source_version}});
    return c.json({receiptId,status:"accepted" as const},202);
  }
  const exact=await database.prepare(`SELECT id,expires_at FROM project_alpha_delivery_portal_grants WHERE workspace_id=?
    AND folder_binding_id=? AND binding_source_version=? AND audience_type=? AND audience_public_id=?
    AND audience_source_version=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) ORDER BY created_at LIMIT 2`)
    .bind(binding.workspace_id,binding.id,binding.source_version,parsed.data.audience.type,parsed.data.audience.publicId,audience.source_version)
    .all<{id:string;expires_at:string|null}>();
  const expiring=await database.prepare(`SELECT id FROM project_alpha_delivery_portal_grants WHERE workspace_id=?
    AND folder_binding_id=? AND binding_source_version=? AND audience_public_id=? AND audience_source_version=?
    AND status='active' AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now') LIMIT 2`)
    .bind(binding.workspace_id,binding.id,binding.source_version,parsed.data.audience.publicId,audience.source_version)
    .all<{id:string}>();
  if(expiring.results.length>1)throw new HTTPException(409,{message:"Delivery authorization is ambiguous"});
  if(exact.results.length>1||(exact.results.length===1&&exact.results[0]!.expires_at!==(effectiveExpiry??null)))
    throw new HTTPException(409,{message:"An existing delivery authorization has different policy"});
  const receiptId=crypto.randomUUID(),grantId=exact.results[0]?.id??crypto.randomUUID();
  const receiptStatement=exact.results.length
    ?database.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id)
      SELECT ?,?,?,?,id FROM project_alpha_delivery_portal_grants WHERE id=? AND status='active'
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`).bind(receiptId,auth.deliveryId,auth.fingerprint,"portal",grantId)
    :database.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES(?,?,?,?,?)`)
      .bind(receiptId,auth.deliveryId,auth.fingerprint,"portal",grantId);
  const statements=[
    database.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='expired',grant_version=grant_version+1
      WHERE status='active' AND folder_binding_id=? AND binding_source_version=? AND audience_public_id=?
        AND audience_source_version=? AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now')`)
      .bind(binding.id,binding.source_version,parsed.data.audience.publicId,audience.source_version),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json)
      SELECT ?,receipt_id,'portal.expired','project_alpha_delivery',? FROM project_alpha_delivery_portal_grants
      WHERE id=? AND status='expired' AND changes()=1`).bind(crypto.randomUUID(),JSON.stringify({reason:"elapsed"}),expiring.results[0]?.id??""),
    receiptStatement,
  ];
  if(!exact.results.length)statements.push(database.prepare(`INSERT INTO project_alpha_delivery_portal_grants(id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,expires_at,label,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(grantId,receiptId,binding.workspace_id,binding.id,binding.source_version,parsed.data.audience.type,parsed.data.audience.publicId,audience.source_version,effectiveExpiry,parsed.data.label,auth.deliveryId));
  statements.push(
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) VALUES(?,?,'portal.accepted',?,?)`).bind(crypto.randomUUID(),receiptId,auth.deliveryId,JSON.stringify({reused:Boolean(exact.results.length),scopeType:parsed.data.scope.type,scopePublicId:parsed.data.scope.publicId,audienceType:parsed.data.audience.type,audiencePublicId:parsed.data.audience.publicId})),
    database.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type) VALUES(?,?,?,?,?,'granted')`).bind(crypto.randomUUID(),receiptId,grantId,parsed.data.audience.publicId,audience.source_version),
  );
  try{await database.batch(statements);}catch{
    const raced=await database.prepare(`SELECT receipt_id,request_fingerprint FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?`).bind(auth.deliveryId).first<{receipt_id:string;request_fingerprint:string}>();
    if(raced?.request_fingerprint===auth.fingerprint)return c.json({receiptId:raced.receipt_id,status:"accepted" as const},202);
    throw new HTTPException(409,{message:"Delivery authorization changed concurrently"});
  }
  return c.json({receiptId,status:"accepted" as const},202);
}

export async function handleProjectAlphaDeliveryIntentRevoke(c:IntentContext){
  if(c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true")throw new HTTPException(404,{message:"Not found"});
  const raw=await body(c.req.raw),auth=await authenticate(c.env,c.req.raw,raw,REVOKE_PATH);await rate(c.env,"intent");
  const parsed=revokeSchema.safeParse(decode(raw));
  if(!parsed.success||parsed.data.applicationKey!==c.env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY||parsed.data.deliveryId!==auth.deliveryId)
    throw new HTTPException(400,{message:"Delivery revocation is invalid"});
  const database=db(c.env),prior=await database.prepare(`SELECT receipt_id,request_fingerprint FROM project_alpha_delivery_intent_revocation_receipts WHERE delivery_id=?`).bind(auth.deliveryId).first<{receipt_id:string;request_fingerprint:string}>();
  if(prior){if(prior.request_fingerprint!==auth.fingerprint)throw new HTTPException(409,{message:"Delivery ID was already used"});return c.json({receiptId:prior.receipt_id,status:"accepted" as const},202);}
  const original=await database.prepare(`SELECT receipt.receipt_id,receipt.access_mode,receipt.resource_id FROM project_alpha_delivery_intent_receipts receipt WHERE receipt.receipt_id=?`).bind(parsed.data.receiptId).first<{receipt_id:string;access_mode:"portal"|"guest";resource_id:string}>();
  if(!original)throw new HTTPException(404,{message:"Delivery receipt not found"});
  const revokeReceipt=crypto.randomUUID(),auditId=crypto.randomUUID();
  if(original.access_mode==="guest"){
    await revokeProjectAlphaDeliveryGuestShare(c.env,{shareId:original.resource_id,deliveryId:auth.deliveryId,
      revokeReceiptId:revokeReceipt,originalReceiptId:original.receipt_id,fingerprint:auth.fingerprint});
    return c.json({receiptId:revokeReceipt,status:"accepted" as const},202);
  }
  const results=await database.batch([
    database.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now'),revoke_reason_code=? WHERE id=? AND status='active'`).bind(parsed.data.reasonCode,original.resource_id),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts(receipt_id,delivery_id,original_receipt_id,request_fingerprint) SELECT ?,?,?,? WHERE changes()=1`).bind(revokeReceipt,auth.deliveryId,original.receipt_id,auth.fingerprint),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) SELECT ?,?,'portal.revoked',?,? WHERE changes()=1`).bind(auditId,original.receipt_id,auth.deliveryId,JSON.stringify({reasonCode:parsed.data.reasonCode})),
    database.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type)
      SELECT ?,grant.receipt_id,grant.id,grant.audience_public_id,grant.audience_source_version,'revoked'
      FROM project_alpha_delivery_portal_grants grant WHERE grant.id=? AND changes()=1`).bind(crypto.randomUUID(),original.resource_id),
  ]);
  if(!results[0]?.meta.changes)throw new HTTPException(409,{message:"Delivery authorization is not active"});
  return c.json({receiptId:revokeReceipt,status:"accepted" as const},202);
}
