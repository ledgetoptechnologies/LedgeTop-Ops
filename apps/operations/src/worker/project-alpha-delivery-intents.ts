import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Context } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./types";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID, PRIMARY_CATALOG_SOURCE, type CatalogSourceContext } from "@ltds/shared";
import { portalAutomaticEligibilityEnabled } from "./portal-automatic-eligibility";
import { createProjectAlphaDeliveryGuestShare, revokeProjectAlphaDeliveryGuestShare } from "./delivery";
import { projectAlphaDeliveryPrincipalGuard, resolveProjectAlphaDeliveryPrincipal } from "./share-recipients";
import { nativeDeliveryNotificationsReady, stagePortalDeliveryNotificationStatements } from "./portal-delivery-notification-batches";
import { d1TablesPresent } from "./schema-readiness";

const PATH = "/api/internal/project-alpha/delivery-intents";
const PREFLIGHT_PATH = `${PATH}/preflight`;
const REVOKE_PATH = `${PATH}/revoke`;
const MAX_BODY = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const MAX_REGISTERED_ACCESS_JWKS_RESOLVERS = 32;
const registeredAccessJwksResolvers = new Map<string,JWTVerifyGetKey>();
const credentialRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const portalSigningKeySchema = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  value: z.string().min(32).max(8192).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();
const portalCredentialEnvelopeSchema = z.object({
  version: z.literal(1),
  sets: z.record(credentialRefSchema, z.unknown()),
}).strict();
const preflightSchema = z.object({ schemaVersion: z.literal(1), applicationKey: z.string(),
  deliveryId: z.string().regex(SAFE_ID), occurredAt: z.iso.datetime({ offset: true }) }).strict();
const intentSchema = preflightSchema.extend({
  scope: z.object({ type: z.enum(["organization","department","client","project"]), publicId: z.string().regex(SAFE_ID) }).strict(),
  audience: z.object({ type: z.literal("principal"), publicId: z.string().regex(SAFE_ID) }).strict(),
  accessMode: z.enum(["portal","guest"]), expiresAt: z.iso.datetime({ offset: true }).nullable(),
  label: z.string().trim().max(160).nullable(), notify: z.literal(true),
}).strict();
const revokeSchema=preflightSchema.extend({receiptId:z.string().regex(SAFE_ID),reasonCode:z.literal("project_alpha_delivery_revoked")}).strict();

type IntentContext = Pick<Context<{ Bindings: Env }>, "env" | "req" | "json">;
type PortalSigningKey = z.infer<typeof portalSigningKeySchema> & { fingerprint: string };
export type DeliverySourceProof = { sourceId:string; revision:number; version:number; connectorRevision:number; connectorVersion:number };
type DeliveryAuthority = { applicationKey:string; current:PortalSigningKey; previous:PortalSigningKey|null;
  accessIssuer:string; accessAudience:string; accessSubject:string; proof?:DeliverySourceProof };
type DeliveryAccessAuthority = Pick<DeliveryAuthority,"accessIssuer"|"accessAudience"|"accessSubject">;
type DeliverySourceAuthorityRow = { source_id:string; application_key:string; state:string; active_revision:number; version:number;
  connector_revision:number; connector_version:number; credential_ref:string; access_issuer:string; access_audience:string;
  access_subject:string; current_key_id:string; current_key_fingerprint:string; previous_key_id:string|null; previous_key_fingerprint:string|null };
function db(env: Env): D1Database { const value = env.DELIVERY_DB as D1Database & { withSession?: (v:"first-primary")=>D1Database }; return value.withSession?.("first-primary") ?? value; }
async function body(request: Request): Promise<Uint8Array> {
  const header = request.headers.get("Content-Length");
  if (header !== null && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)))) throw new HTTPException(400, { message: "Delivery intent body is invalid" });
  if (Number(header ?? 0) > MAX_BODY) throw new HTTPException(413, { message: "Delivery intent is too large" });
  if (!request.body) throw new HTTPException(400, { message: "Delivery intent body is invalid" });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); throw new HTTPException(413, { message: "Delivery intent is too large" }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new HTTPException(400, { message: "Delivery intent body is invalid" });
  const value = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
  return value;
}
async function hex(value: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice().buffer))].map(v=>v.toString(16).padStart(2,"0")).join(""); }
function fromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) || [], v=>parseInt(v,16)); }
function registeredSource(sourceId:string):CatalogSourceContext{
  let source:CatalogSourceContext;
  try{source=createCatalogSourceContext(sourceId);}catch{throw new HTTPException(404,{message:"Not found"});}
  if(source.sourceId===PRIMARY_ALPHA_SOURCE_ID)throw new HTTPException(404,{message:"Not found"});
  return source;
}
function sourcePath(sourceId:string,suffix:""|"/preflight"|"/revoke"=""):string{
  const source=registeredSource(sourceId).sourceId;
  if(source===PRIMARY_ALPHA_SOURCE_ID)throw new HTTPException(404,{message:"Not found"});
  return `/api/internal/project-alpha/sources/${encodeURIComponent(source)}/delivery-intents${suffix}`;
}
function sourceFence(database:D1Database,proof:DeliverySourceProof):D1PreparedStatement{
  return database.prepare(`INSERT INTO pa_portal_source_write_fences(source_id,write_guard)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM pa_portal_source_authorities authority
      JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id
        AND revision.revision=authority.active_revision
      WHERE authority.source_id=? AND authority.state='active' AND authority.active_revision=? AND authority.version=?
        AND authority.connector_revision=? AND authority.connector_version=?) THEN 1 ELSE 0 END)
    ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`)
    .bind(proof.sourceId,proof.sourceId,proof.revision,proof.version,proof.connectorRevision,proof.connectorVersion);
}
async function assertSourceProof(database:D1Database,proof:DeliverySourceProof):Promise<void>{
  const live=await database.prepare(`SELECT 1 ok FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id
      AND revision.revision=authority.active_revision
    WHERE authority.source_id=? AND authority.state='active' AND authority.active_revision=? AND authority.version=?
      AND authority.connector_revision=? AND authority.connector_version=?`)
    .bind(proof.sourceId,proof.revision,proof.version,proof.connectorRevision,proof.connectorVersion).first<number>("ok");
  if(live!==1)throw new HTTPException(409,{message:"Project Alpha delivery authority changed"});
}
type RegisteredAuthorityMetadata=DeliveryAccessAuthority&DeliverySourceAuthorityRow&{proof:DeliverySourceProof};
async function resolveAuthorityMetadata(env:Env,sourceId:string,registeredOnly=true):Promise<RegisteredAuthorityMetadata>{
  const source=registeredOnly?registeredSource(sourceId).sourceId:createCatalogSourceContext(sourceId).sourceId;
  const database=db(env);
  let row:DeliverySourceAuthorityRow|null;
  try{
    row=await database.prepare(`SELECT authority.source_id,authority.application_key,authority.state,
      authority.active_revision,authority.version,authority.connector_revision,authority.connector_version,
      revision.credential_ref,revision.access_issuer,revision.access_audience,revision.access_subject,
      revision.current_key_id,revision.current_key_fingerprint,revision.previous_key_id,revision.previous_key_fingerprint
      FROM pa_portal_source_authorities authority JOIN pa_portal_source_authority_revisions revision
        ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
      WHERE authority.source_id=? AND authority.state='active'`).bind(source).first<DeliverySourceAuthorityRow>();
  }catch{throw new HTTPException(503,{message:"Project Alpha delivery authority is unavailable"});}
  if(!row)throw new HTTPException(404,{message:"Not found"});
  let issuer:URL;
  try{issuer=new URL(row.access_issuer);if(issuer.protocol!=="https:"||issuer.origin!==row.access_issuer)throw new Error();}
  catch{throw new HTTPException(503,{message:"Project Alpha delivery authority is unavailable"});}
  const proof={sourceId:source,revision:row.active_revision,version:row.version,
    connectorRevision:row.connector_revision,connectorVersion:row.connector_version};
  if([proof.revision,proof.version,proof.connectorRevision,proof.connectorVersion].some(value=>!Number.isSafeInteger(value)||value<1))
    throw new HTTPException(503,{message:"Project Alpha delivery authority is unavailable"});
  return{...row,accessIssuer:issuer.origin,accessAudience:row.access_audience,accessSubject:row.access_subject,proof};
}
export async function resolveProjectAlphaDeliverySourceProof(env:Env,sourceId:string,applicationKey:string,
  connectorProof:{revision:number;version:number}):Promise<{source:CatalogSourceContext;proof:DeliverySourceProof}>{
  const metadata=await resolveAuthorityMetadata(env,sourceId,false);
  if(metadata.application_key!==applicationKey||metadata.connector_revision!==connectorProof.revision||
    metadata.connector_version!==connectorProof.version)throw new HTTPException(409,{message:"Project Alpha delivery authority changed"});
  await assertSourceProof(db(env),metadata.proof);
  return{source:createCatalogSourceContext(metadata.source_id),proof:metadata.proof};
}
async function loadRegisteredSigningAuthority(env:Env,metadata:RegisteredAuthorityMetadata):Promise<DeliveryAuthority>{
  let current:PortalSigningKey,previous:PortalSigningKey|null;
  try{
    const raw=env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS;
    if(!raw||encoder.encode(raw).byteLength>256*1024)throw new Error();
    const envelope=portalCredentialEnvelopeSchema.parse(JSON.parse(raw));
    if(Object.keys(envelope.sets).length>64)throw new Error();
    const selected=envelope.sets[metadata.credential_ref];
    if(!selected||typeof selected!=="object"||Array.isArray(selected))throw new Error();
    const set=selected as Record<string,unknown>;
    const currentValue=portalSigningKeySchema.parse(set.portalCurrent);
    const previousValue=set.portalPrevious===undefined?null:portalSigningKeySchema.parse(set.portalPrevious);
    current={...currentValue,fingerprint:await hex(encoder.encode(currentValue.value))};
    previous=previousValue?{...previousValue,fingerprint:await hex(encoder.encode(previousValue.value))}:null;
    if(current.keyId!==metadata.current_key_id||current.fingerprint!==metadata.current_key_fingerprint||
      (previous?.keyId??null)!==metadata.previous_key_id||(previous?.fingerprint??null)!==metadata.previous_key_fingerprint||
      (previous&&(previous.keyId===current.keyId||previous.fingerprint===current.fingerprint)))throw new Error();
  }catch{throw new HTTPException(503,{message:"Project Alpha delivery credentials are unavailable"});}
  return{applicationKey:metadata.application_key,current,previous,accessIssuer:metadata.accessIssuer,
    accessAudience:metadata.accessAudience,accessSubject:metadata.accessSubject,proof:metadata.proof};
}
export async function verifyRegisteredDeliveryAccess(request:Request,authority:DeliveryAccessAuthority,getKey?:JWTVerifyGetKey):Promise<void>{
  try{
    const assertion=request.headers.get("Cf-Access-Jwt-Assertion");
    if(!assertion)throw new Error();
    let resolver=getKey;
    if(!resolver){
      const issuer=new URL(authority.accessIssuer);
      if(issuer.protocol!=="https:"||issuer.origin!==authority.accessIssuer)throw new Error();
      resolver=registeredAccessJwksResolvers.get(authority.accessIssuer);
      if(resolver){
        registeredAccessJwksResolvers.delete(authority.accessIssuer);
        registeredAccessJwksResolvers.set(authority.accessIssuer,resolver);
      }else{
        resolver=createRemoteJWKSet(new URL("/cdn-cgi/access/certs",issuer));
        if(registeredAccessJwksResolvers.size>=MAX_REGISTERED_ACCESS_JWKS_RESOLVERS){
          const oldest=registeredAccessJwksResolvers.keys().next().value;
          if(oldest)registeredAccessJwksResolvers.delete(oldest);
        }
        registeredAccessJwksResolvers.set(authority.accessIssuer,resolver);
      }
    }
    const{payload}=await jwtVerify(assertion,resolver,{
      issuer:authority.accessIssuer,audience:authority.accessAudience,algorithms:["RS256"],
    });
    if(payload.sub!==authority.accessSubject)throw new Error();
  }catch{throw new HTTPException(401,{message:"Project Alpha delivery access failed"});}
}
function legacyAuthority(env:Env):DeliveryAuthority{
  const current=env.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID&&env.PROJECT_ALPHA_PORTAL_HMAC_SECRET
    ?{keyId:env.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID,value:env.PROJECT_ALPHA_PORTAL_HMAC_SECRET,fingerprint:""}:null;
  const previous=env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID&&env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET
    ?{keyId:env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID,value:env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET,fingerprint:""}:null;
  if(!env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY||!current)throw new HTTPException(401,{message:"Project Alpha delivery authentication failed"});
  return{applicationKey:env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,current,previous,accessIssuer:"",accessAudience:"",accessSubject:""};
}
async function authenticate(request: Request, raw: Uint8Array, path: string, authority:DeliveryAuthority): Promise<{ deliveryId:string; fingerprint:string }> {
  const applicationKey=request.headers.get("X-Portal-Integration-Application-Key")||"", timestamp=request.headers.get("X-Portal-Integration-Timestamp")||"";
  const digest=(request.headers.get("X-Portal-Integration-Body-SHA256")||"").toLowerCase(), keyId=request.headers.get("X-Portal-Integration-Key-Id")||"";
  const deliveryId=request.headers.get("X-Portal-Integration-Delivery-Id")||"", signature=request.headers.get("X-Portal-Integration-Signature")||"";
  const selected=keyId===authority.current.keyId?authority.current:keyId===authority.previous?.keyId?authority.previous:null;
  const secret=selected?.value;
  const timestampMs=Date.parse(timestamp);
  if (applicationKey!==authority.applicationKey || !SAFE_KEY_ID.test(keyId) || !SAFE_ID.test(deliveryId) ||
      !timestamp || !Number.isFinite(timestampMs) || Math.abs(Date.now()-timestampMs)>300_000 || !HEX.test(digest) || digest!==await hex(raw) || !secret || secret.length<32 || !signature.startsWith("sha256=") || !HEX.test(signature.slice(7).toLowerCase()))
    throw new HTTPException(401, { message: "Project Alpha delivery authentication failed" });
  const canonical=encoder.encode(`${timestamp}\nPOST\n${path}\n${keyId}\n${deliveryId}\n${new TextDecoder().decode(raw)}`);
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  const supplied=fromHex(signature.slice(7).toLowerCase());
  if (!await crypto.subtle.verify("HMAC",key,supplied.buffer.slice(supplied.byteOffset,supplied.byteOffset+supplied.byteLength) as ArrayBuffer,canonical))
    throw new HTTPException(401, { message: "Project Alpha delivery authentication failed" });
  return { deliveryId, fingerprint:digest };
}

export function projectAlphaDeliveryMachineRequest(method:string,path:string): boolean {
  return method.toUpperCase()==="POST" && ((path===PATH || path===PREFLIGHT_PATH || path===REVOKE_PATH)
    || /^\/api\/internal\/project-alpha\/sources\/[^/]+\/delivery-intents(?:\/preflight|\/revoke)?$/.test(path));
}
export function projectAlphaDeliveryMachineHostRequest(urlValue:string,method:string,
  env:Partial<Pick<Env,"INCOMING_EXPECTED_HOST"|"PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_ENABLED"|"PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_UNTIL">>,
  now=Date.now()):boolean{
  if(env.PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_ENABLED!=="true")return false;
  const until=Date.parse(env.PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_UNTIL??"");
  // Compatibility must be deliberately time-boxed. A missing, expired, or
  // excessively long window fails closed so the direct public path cannot
  // become a permanent bypass around authenticated Ops Sync ingress.
  if(!Number.isFinite(until)||until<now||until>now+14*24*60*60*1000)return false;
  try{const url=new URL(urlValue);return url.host===env.INCOMING_EXPECTED_HOST&&projectAlphaDeliveryMachineRequest(method,url.pathname);}catch{return false;}
}
function decode(raw:Uint8Array):unknown{try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));}catch{throw new HTTPException(400,{message:"Delivery intent JSON is invalid"});}}
async function rate(env:Env,source:CatalogSourceContext,scope:"attempt_preflight"|"attempt_intent"|"preflight"|"intent",maximum:number):Promise<void>{
  let count:number|null;
  if(source.sourceId===PRIMARY_ALPHA_SOURCE_ID){
    count=await env.OPS_DB.prepare(`INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count)
      VALUES(?,strftime('%Y-%m-%dT%H:%M:00Z','now'),1) ON CONFLICT(scope,window_start)
      DO UPDATE SET request_count=request_count+1 WHERE request_count<? RETURNING request_count`)
      .bind(scope,maximum).first<number>("request_count");
  }else{
    if(!await d1TablesPresent(env.OPS_DB,["project_alpha_delivery_intent_source_rate_limits"]))
      throw new HTTPException(503,{message:"Registered Project Alpha delivery rate limits are unavailable"});
    count=await env.OPS_DB.prepare(`INSERT INTO project_alpha_delivery_intent_source_rate_limits(source_id,scope,window_start,request_count)
      VALUES(?,?,strftime('%Y-%m-%dT%H:%M:00Z','now'),1) ON CONFLICT(source_id,scope,window_start)
      DO UPDATE SET request_count=request_count+1 WHERE request_count<? RETURNING request_count`)
      .bind(source.sourceId,scope,maximum).first<number>("request_count");
  }
  if(typeof count!=="number"||count>maximum)throw new HTTPException(429,{message:"Too many Project Alpha delivery requests"});
}
/** Apply the same two source-qualified budgets used by registered HTTP
 * ingress. Callers must resolve and validate the active source proof first. */
export async function applyProjectAlphaDeliveryRpcBudget(env:Env,source:CatalogSourceContext,
  kind:"preflight"|"provision"|"revoke"):Promise<void>{
  const preflight=kind==="preflight";
  await rate(env,source,preflight?"attempt_preflight":"attempt_intent",preflight?600:300);
  await rate(env,source,preflight?"preflight":"intent",preflight?120:60);
}
export async function pruneProjectAlphaDeliveryIntentRateLimits(env:Pick<Env,"OPS_DB">):Promise<number>{
  const legacy=await env.OPS_DB.prepare(`DELETE FROM project_alpha_delivery_intent_rate_limits WHERE rowid IN
    (SELECT rowid FROM project_alpha_delivery_intent_rate_limits WHERE datetime(window_start)<=datetime('now','-10 minutes') LIMIT 1000)`).run();
  if(!await d1TablesPresent(env.OPS_DB,["project_alpha_delivery_intent_source_rate_limits"]))return legacy.meta.changes||0;
  const sources=await env.OPS_DB.prepare(`DELETE FROM project_alpha_delivery_intent_source_rate_limits WHERE rowid IN
    (SELECT rowid FROM project_alpha_delivery_intent_source_rate_limits WHERE datetime(window_start)<=datetime('now','-10 minutes') LIMIT 1000)`).run();
  return (legacy.meta.changes||0)+(sources.meta.changes||0);
}
export async function handleProjectAlphaDeliveryPreflight(c: IntentContext) {
  const authority=legacyAuthority(c.env),raw=await body(c.req.raw),auth=await authenticate(c.req.raw,raw,PREFLIGHT_PATH,authority);
  await rate(c.env,PRIMARY_CATALOG_SOURCE,"preflight",120);
  const parsed=preflightSchema.safeParse(decode(raw));
  if (!parsed.success || parsed.data.applicationKey!==authority.applicationKey || parsed.data.deliveryId!==auth.deliveryId)
    throw new HTTPException(400,{message:"Delivery preflight is invalid"});
  return c.json({ status:"ready" as const,schemaVersion:1 as const,
    integrationEnabled:c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED==="true",
    portalSupported:c.env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true" && c.env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED==="true",
    guestSupported:c.env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED==="true",revocationSupported:true });
}

export async function applyProjectAlphaDeliveryPreflight(env:Env,payload:unknown,auth:DeliveryAuthentication,
  trustedSource:CatalogSourceContext,expectedApplicationKey:string,authorityProof:DeliverySourceProof){
  const source=createCatalogSourceContext(trustedSource.sourceId),parsed=preflightSchema.safeParse(payload);
  if(!parsed.success||parsed.data.applicationKey!==expectedApplicationKey||parsed.data.deliveryId!==auth.deliveryId||
    !HEX.test(auth.fingerprint))throw new HTTPException(400,{message:"Delivery preflight is invalid"});
  if(authorityProof.sourceId!==source.sourceId)throw new HTTPException(409,{message:"Project Alpha delivery authority changed"});
  await assertSourceProof(db(env),authorityProof);
  return{status:"ready" as const,schemaVersion:1 as const,
    integrationEnabled:env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED==="true",
    portalSupported:env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true"&&env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED==="true",
    guestSupported:env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED==="true",revocationSupported:true};
}

export async function handleProjectAlphaDeliveryIntent(c: IntentContext) {
  if (c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true") throw new HTTPException(404,{message:"Not found"});
  const authority=legacyAuthority(c.env),raw=await body(c.req.raw),auth=await authenticate(c.req.raw,raw,PATH,authority);
  await rate(c.env,PRIMARY_CATALOG_SOURCE,"intent",60);
  return c.json(await applyProjectAlphaDeliveryIntent(c.env, decode(raw), auth, PRIMARY_CATALOG_SOURCE,authority.applicationKey),202);
}

async function registered(c:IntentContext,sourceId:string,suffix:""|"/preflight"|"/revoke",
  accessVerifier:(request:Request,authority:DeliveryAccessAuthority)=>Promise<void>=verifyRegisteredDeliveryAccess){
  if(c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true"&&suffix!=="/preflight")throw new HTTPException(404,{message:"Not found"});
  const metadata=await resolveAuthorityMetadata(c.env,sourceId),source=createCatalogSourceContext(metadata.proof.sourceId);
  const path=sourcePath(source.sourceId,suffix);
  await accessVerifier(c.req.raw,metadata);
  await rate(c.env,source,suffix==="/preflight"?"attempt_preflight":"attempt_intent",suffix==="/preflight"?600:300);
  const authority=await loadRegisteredSigningAuthority(c.env,metadata);
  const raw=await body(c.req.raw),auth=await authenticate(c.req.raw,raw,path,authority);
  await rate(c.env,source,suffix==="/preflight"?"preflight":"intent",suffix==="/preflight"?120:60);
  const payload=decode(raw);
  if(suffix==="/preflight"){
    const parsed=preflightSchema.safeParse(payload);
    if(!parsed.success||parsed.data.applicationKey!==authority.applicationKey||parsed.data.deliveryId!==auth.deliveryId)
      throw new HTTPException(400,{message:"Delivery preflight is invalid"});
    await assertSourceProof(db(c.env),authority.proof!);
    return c.json({status:"ready" as const,schemaVersion:1 as const,
      integrationEnabled:c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED==="true",
      portalSupported:c.env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true"&&c.env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED==="true",
      guestSupported:c.env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED==="true",revocationSupported:true});
  }
  if(suffix==="/revoke")return c.json(await applyProjectAlphaDeliveryIntentRevoke(c.env,payload,auth,source,authority.applicationKey,authority.proof),202);
  return c.json(await applyProjectAlphaDeliveryIntent(c.env,payload,auth,source,authority.applicationKey,authority.proof),202);
}
export const handleRegisteredProjectAlphaDeliveryPreflight=(c:IntentContext,sourceId:string,accessVerifier?:typeof verifyRegisteredDeliveryAccess)=>
  registered(c,sourceId,"/preflight",accessVerifier);
export const handleRegisteredProjectAlphaDeliveryIntent=(c:IntentContext,sourceId:string,accessVerifier?:typeof verifyRegisteredDeliveryAccess)=>
  registered(c,sourceId,"",accessVerifier);
export const handleRegisteredProjectAlphaDeliveryIntentRevoke=(c:IntentContext,sourceId:string,accessVerifier?:typeof verifyRegisteredDeliveryAccess)=>
  registered(c,sourceId,"/revoke",accessVerifier);

type DeliveryAuthentication = { deliveryId: string; fingerprint: string };
type AcceptedDelivery = { receiptId: string; status: "accepted" };
function accepted(receiptId: string): AcceptedDelivery { return { receiptId, status: "accepted" }; }
async function priorReceipt(database: D1Database, source: CatalogSourceContext, auth: DeliveryAuthentication, revoke = false): Promise<AcceptedDelivery | null> {
  const table = revoke ? "project_alpha_delivery_intent_revocation_receipts" : "project_alpha_delivery_intent_receipts";
  const prior = await database.prepare(`SELECT receipt_id,request_fingerprint FROM ${table} WHERE project_alpha_source_id=? AND delivery_id=?`)
    .bind(source.sourceId,auth.deliveryId).first<{receipt_id:string;request_fingerprint:string}>();
  if (!prior) return null;
  if (prior.request_fingerprint !== auth.fingerprint) throw new HTTPException(409,{message:"Delivery ID was already used"});
  return accepted(prior.receipt_id);
}

/** Internal authenticated ingestion seam. HTTP always selects primary after HMAC. */
export async function applyProjectAlphaDeliveryIntent(env: Env, payload: unknown, auth: DeliveryAuthentication,
  trustedSource: CatalogSourceContext = PRIMARY_CATALOG_SOURCE,expectedApplicationKey=env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,
  authorityProof?:DeliverySourceProof): Promise<AcceptedDelivery> {
  const source = createCatalogSourceContext(trustedSource?.sourceId);
  const parsed=intentSchema.safeParse(payload);
  if (!parsed.success || parsed.data.applicationKey!==expectedApplicationKey || parsed.data.deliveryId!==auth.deliveryId || !HEX.test(auth.fingerprint))
    throw new HTTPException(400,{message:"Delivery intent is invalid"});
  const database=db(env);
  if(authorityProof){
    if(authorityProof.sourceId!==source.sourceId)throw new HTTPException(409,{message:"Project Alpha delivery authority changed"});
    await assertSourceProof(database,authorityProof);
  }
  const prior=await priorReceipt(database,source,auth),authorityFence=authorityProof?sourceFence(database,authorityProof):undefined;
  if (prior) return prior;
  if(parsed.data.accessMode==="portal"&&(env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED!=="true"||env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED!=="true"))
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
  const bindings=await database.prepare(`SELECT b.id,b.workspace_id,b.source_version,b.r2_prefix,cp.active_generation_id FROM portal_v2_folder_bindings b
    JOIN portal_v2_workspaces w ON w.id=b.workspace_id AND w.status='active'
      AND w.project_alpha_source_id=?
    JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=b.workspace_id
    JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=b.workspace_id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities e ON e.workspace_id=b.workspace_id AND e.generation_id=cp.active_generation_id
      AND e.entity_type=b.owner_scope_type AND e.public_id=b.owner_public_id AND e.active=1 AND e.source_version=b.source_version
    WHERE b.status='active' AND b.revoked_at IS NULL AND b.owner_scope_type=? AND b.owner_public_id=? LIMIT 2`)
    .bind(source.sourceId,parsed.data.scope.type,parsed.data.scope.publicId).all<{id:string;workspace_id:string;source_version:string;active_generation_id:string;r2_prefix:string}>();
  if(bindings.results.length!==1) throw new HTTPException(409,{message:"Delivery scope is not uniquely bound"});
  const binding=bindings.results[0]!;
  const audience=parsed.data.audience.type==="principal"
    ? await database.prepare(`SELECT source_version FROM pa_portal_principals WHERE workspace_id=? AND public_id=? AND status='active'`).bind(binding.workspace_id,parsed.data.audience.publicId).first<{source_version:string}>()
    : await database.prepare(`SELECT source_version FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND entity_type=? AND public_id=? AND active=1`).bind(binding.workspace_id,binding.active_generation_id,parsed.data.audience.type,parsed.data.audience.publicId).first<{source_version:string}>();
  if(!audience) throw new HTTPException(404,{message:"Delivery audience not found"});
  const recipient=await resolveProjectAlphaDeliveryPrincipal(env,binding.r2_prefix,parsed.data.audience.publicId,audience.source_version,source);
  if(recipient.workspaceId!==binding.workspace_id||recipient.folderBindingId!==binding.id||
    recipient.directoryGenerationId!==binding.active_generation_id)
    throw new HTTPException(409,{message:"Delivery recipient binding changed"});
  if(parsed.data.accessMode==="guest"){
    if(env.PROJECT_ALPHA_DELIVERY_GUEST_ENABLED!=="true")throw new HTTPException(404,{message:"Not found"});
    const receiptId=crypto.randomUUID();
    const result = await createProjectAlphaDeliveryGuestShare(env,{deliveryId:auth.deliveryId,receiptId,fingerprint:auth.fingerprint,
      r2Prefix:binding.r2_prefix,label:parsed.data.label,expiresAt:effectiveExpiry!,
      expectedBinding:{workspaceId:binding.workspace_id,folderBindingId:binding.id,bindingSourceVersion:binding.source_version,directoryGenerationId:binding.active_generation_id},
      audience:{...parsed.data.audience,sourceVersion:audience.source_version}},source,authorityFence);
    return accepted(result.receiptId);
  }
  const grantScope = `grant_record.workspace_id=? AND grant_record.folder_binding_id=? AND grant_record.binding_source_version=?
    AND grant_record.audience_type='principal' AND grant_record.audience_public_id=? AND grant_record.audience_source_version=? AND grant_record.status='active'`;
  const grantScopeBindings = [binding.workspace_id,binding.id,binding.source_version,parsed.data.audience.publicId,audience.source_version];
  const active = await database.prepare(`SELECT grant_record.id,grant_record.expires_at,grant_record.grant_version,
      (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now')) live
    FROM project_alpha_delivery_portal_grants grant_record JOIN project_alpha_delivery_intent_receipts owner_receipt
      ON owner_receipt.receipt_id=grant_record.receipt_id AND owner_receipt.project_alpha_source_id=?
    WHERE ${grantScope} LIMIT 2`).bind(source.sourceId,...grantScopeBindings)
    .all<{id:string;expires_at:string|null;grant_version:number;live:number}>();
  if(active.results.length>1)throw new HTTPException(409,{message:"Delivery authorization is ambiguous"});
  const exact=active.results.find(row=>row.live===1),expiring=active.results.find(row=>row.live===0);
  if(exact&&exact.expires_at!==(effectiveExpiry??null))
    throw new HTTPException(409,{message:"An existing delivery authorization has different policy"});
  const receiptId=crypto.randomUUID(),grantId=exact?.id??crypto.randomUUID(),outboxId=crypto.randomUUID();
  const staging=await nativeDeliveryNotificationsReady(env);
  const recipientGuard=projectAlphaDeliveryPrincipalGuard({audience:recipient,principalSourceVersion:audience.source_version,
    bindingSourceVersion:binding.source_version,prefix:binding.r2_prefix,allowUnclaimed:portalAutomaticEligibilityEnabled(env),source});
  const guards=[`(${recipientGuard.sql})`,`(SELECT COUNT(*) FROM project_alpha_delivery_portal_grants grant_record WHERE ${grantScope})=?`];
  const guardBindings:(string|number|null)[]=[...recipientGuard.bindings,...grantScopeBindings,active.results.length];
  for(const row of active.results){
    guards.push(`EXISTS(SELECT 1 FROM project_alpha_delivery_portal_grants grant_record
      JOIN project_alpha_delivery_intent_receipts owner_receipt ON owner_receipt.receipt_id=grant_record.receipt_id AND owner_receipt.project_alpha_source_id=?
      WHERE ${grantScope} AND grant_record.id=? AND grant_record.grant_version=? AND grant_record.expires_at IS ?
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))=?)`);
    guardBindings.push(source.sourceId,...grantScopeBindings,row.id,row.grant_version,row.expires_at,row.live);
  }
  const statements:D1PreparedStatement[]=[...(authorityFence?[authorityFence]:[]),database.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
    (receipt_id,project_alpha_source_id,delivery_id,request_fingerprint,access_mode,resource_id,write_guard)
    VALUES(?,?,?,?,?,?,CASE WHEN ${guards.join(" AND ")} THEN 1 ELSE 0 END)`)
    .bind(receiptId,source.sourceId,auth.deliveryId,auth.fingerprint,"portal",grantId,...guardBindings)];
  if(expiring)statements.push(
    database.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='expired',grant_version=grant_version+1
      WHERE id=? AND status='active' AND grant_version=?`).bind(expiring.id,expiring.grant_version),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json)
      SELECT ?,receipt_id,'portal.expired','project_alpha_delivery',? FROM project_alpha_delivery_portal_grants
      WHERE id=? AND status='expired'`).bind(crypto.randomUUID(),JSON.stringify({reason:"elapsed"}),expiring.id),
  );
  if(!exact)statements.push(database.prepare(`INSERT INTO project_alpha_delivery_portal_grants(id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,expires_at,label,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(grantId,receiptId,binding.workspace_id,binding.id,binding.source_version,parsed.data.audience.type,parsed.data.audience.publicId,audience.source_version,effectiveExpiry,parsed.data.label,auth.deliveryId));
  statements.push(
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) VALUES(?,?,'portal.accepted',?,?)`).bind(crypto.randomUUID(),receiptId,auth.deliveryId,JSON.stringify({reused:Boolean(exact),scopeType:parsed.data.scope.type,scopePublicId:parsed.data.scope.publicId,audienceType:parsed.data.audience.type,audiencePublicId:parsed.data.audience.publicId})),
    database.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type) VALUES(?,?,?,?,?,'granted')`).bind(outboxId,receiptId,grantId,parsed.data.audience.publicId,audience.source_version),
  );
  if(staging)statements.push(...stagePortalDeliveryNotificationStatements(database,outboxId));
  try{await database.batch(statements);}catch{
    const raced=await priorReceipt(database,source,auth);
    if(raced)return raced;
    throw new HTTPException(409,{message:"Delivery authorization changed concurrently"});
  }
  return accepted(receiptId);
}

export async function handleProjectAlphaDeliveryIntentRevoke(c:IntentContext){
  if(c.env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED!=="true")throw new HTTPException(404,{message:"Not found"});
  const authority=legacyAuthority(c.env),raw=await body(c.req.raw),auth=await authenticate(c.req.raw,raw,REVOKE_PATH,authority);await rate(c.env,PRIMARY_CATALOG_SOURCE,"intent",60);
  return c.json(await applyProjectAlphaDeliveryIntentRevoke(c.env,decode(raw),auth,PRIMARY_CATALOG_SOURCE,authority.applicationKey),202);
}

/** Internal authenticated revocation seam; a source cannot revoke another source's receipt. */
export async function applyProjectAlphaDeliveryIntentRevoke(env:Env,payload:unknown,auth:DeliveryAuthentication,
  trustedSource:CatalogSourceContext=PRIMARY_CATALOG_SOURCE,expectedApplicationKey=env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,
  authorityProof?:DeliverySourceProof):Promise<AcceptedDelivery>{
  const source=createCatalogSourceContext(trustedSource?.sourceId);
  const parsed=revokeSchema.safeParse(payload);
  if(!parsed.success||parsed.data.applicationKey!==expectedApplicationKey||parsed.data.deliveryId!==auth.deliveryId||!HEX.test(auth.fingerprint))
    throw new HTTPException(400,{message:"Delivery revocation is invalid"});
  const database=db(env);
  if(authorityProof){
    if(authorityProof.sourceId!==source.sourceId)throw new HTTPException(409,{message:"Project Alpha delivery authority changed"});
    await assertSourceProof(database,authorityProof);
  }
  const prior=await priorReceipt(database,source,auth,true),authorityFence=authorityProof?sourceFence(database,authorityProof):undefined;
  if(prior)return prior;
  const original=await database.prepare(`SELECT receipt.receipt_id,receipt.access_mode,receipt.resource_id FROM project_alpha_delivery_intent_receipts receipt WHERE receipt.receipt_id=? AND receipt.project_alpha_source_id=?`).bind(parsed.data.receiptId,source.sourceId).first<{receipt_id:string;access_mode:"portal"|"guest";resource_id:string}>();
  if(!original)throw new HTTPException(404,{message:"Delivery receipt not found"});
  const revokeReceipt=crypto.randomUUID(),auditId=crypto.randomUUID();
  if(original.access_mode==="guest"){
    const result=await revokeProjectAlphaDeliveryGuestShare(env,{shareId:original.resource_id,deliveryId:auth.deliveryId,
      revokeReceiptId:revokeReceipt,originalReceiptId:original.receipt_id,fingerprint:auth.fingerprint},source,authorityFence);
    return accepted(result.receiptId);
  }
  const grant=await database.prepare(`SELECT grant_record.grant_version FROM project_alpha_delivery_portal_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id AND workspace.project_alpha_source_id=?
    WHERE grant_record.id=? AND grant_record.status='active'`).bind(source.sourceId,original.resource_id).first<{grant_version:number}>();
  if(!grant){const raced=await priorReceipt(database,source,auth,true);if(raced)return raced;throw new HTTPException(409,{message:"Delivery authorization is not active"});}
  try{await database.batch([
    ...(authorityFence?[authorityFence]:[]),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts
      (receipt_id,project_alpha_source_id,delivery_id,original_receipt_id,request_fingerprint,write_guard)
      VALUES(?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM project_alpha_delivery_portal_grants grant_record
        JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id AND workspace.project_alpha_source_id=?
        JOIN project_alpha_delivery_intent_receipts original ON original.resource_id=grant_record.id AND original.access_mode='portal'
          AND original.receipt_id=? AND original.project_alpha_source_id=?
        WHERE grant_record.id=? AND grant_record.status='active' AND grant_record.grant_version=?) THEN 1 ELSE 0 END)`)
      .bind(revokeReceipt,source.sourceId,auth.deliveryId,original.receipt_id,auth.fingerprint,source.sourceId,original.receipt_id,source.sourceId,original.resource_id,grant.grant_version),
    database.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now'),revoke_reason_code=? WHERE id=? AND status='active' AND grant_version=?`).bind(parsed.data.reasonCode,original.resource_id,grant.grant_version),
    database.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) VALUES(?,?,'portal.revoked',?,?)`).bind(auditId,original.receipt_id,auth.deliveryId,JSON.stringify({reasonCode:parsed.data.reasonCode})),
    database.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox(id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type)
      SELECT ?,grant.receipt_id,grant.id,grant.audience_public_id,grant.audience_source_version,'revoked'
      FROM project_alpha_delivery_portal_grants grant WHERE grant.id=?`).bind(crypto.randomUUID(),original.resource_id),
  ]);}catch{const raced=await priorReceipt(database,source,auth,true);if(raced)return raced;throw new HTTPException(409,{message:"Delivery authorization changed concurrently"});}
  return accepted(revokeReceipt);
}
