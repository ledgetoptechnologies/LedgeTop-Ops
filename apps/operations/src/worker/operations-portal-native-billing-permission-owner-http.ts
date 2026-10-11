import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion as Actor } from "./native-staff-auth";
import { readBoundedJson } from "./bounded-json";
import { manageOperationsPortalNativeBillingPermission, type NativeBillingPermissionChange } from "./operations-portal-native-billing-permission-issuer";

export const OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE = "/api/native-client-portal/operations-billing-permissions";
const HOST="ops-staging.ledgetopdroneservices.com",ORIGIN=`https://${HOST}`;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
export type OperationsPortalNativeBillingPermissionOwnerHttpDependencies=Readonly<{
  environment:string;expectedHost:string;delegationFlag:string;database:D1Database;
  configuration:Readonly<{enabled:boolean;origin:string;issuer:string;staffAudience:string;csrfSecret:string}>;
  authenticate?:typeof authenticateNativeStaffWithAdmissionVersion;
  manage?:typeof manageOperationsPortalNativeBillingPermission;
}>;
type Db=D1DatabaseSession;
class Failure extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{"Cache-Control":"no-store",
  "Cloudflare-CDN-Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"}});
function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
  if(value===null||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)return false;
  const names=Reflect.ownKeys(value);
  return names.length===keys.length && names.every(name=>typeof name==="string"&&keys.includes(name)
    && Object.getOwnPropertyDescriptor(value,name)?.enumerable===true && Object.hasOwn(Object.getOwnPropertyDescriptor(value,name)!,"value"));
}
const uuid=(v:unknown):v is string=>typeof v==="string"&&UUID.test(v);
const identifier=(v:unknown):v is string=>typeof v==="string"&&ID.test(v);
const generation=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
function alive(actor:Actor){if(!Number.isFinite(Date.parse(actor.verifiedUntil))||Date.parse(actor.verifiedUntil)<=Date.now())throw new Failure(403,"denied");}
function config(d:OperationsPortalNativeBillingPermissionOwnerHttpDependencies){
  if(d.environment!=="staging"||d.delegationFlag!=="true")throw new Failure(404,"not_found");
  try{
    const c=d.configuration,issuer=new URL(c.issuer),bytes=new TextEncoder().encode(c.csrfSecret).byteLength;
    if(d.expectedHost!==HOST||!c.enabled||c.origin!==ORIGIN||issuer.protocol!=="https:"||issuer.origin!==c.issuer
      ||issuer.pathname!=="/"||issuer.search||issuer.hash||issuer.port||issuer.username||issuer.password
      ||!issuer.hostname.endsWith(".cloudflareaccess.com")||issuer.hostname===".cloudflareaccess.com"
      ||!/^[A-Za-z0-9_-]{16,128}$/u.test(c.staffAudience)||bytes<32||bytes>512||!d.database)throw Error();
    return {secret:c.csrfSecret,access:{enabled:true,issuer:c.issuer,staffAudience:c.staffAudience}};
  }catch{throw new Failure(503,"unavailable");}
}
const encode=(value:string)=>new TextEncoder().encode(value);
function buffer(bytes:Uint8Array):ArrayBuffer{const result=new ArrayBuffer(bytes.byteLength);new Uint8Array(result).set(bytes);return result;}
function message(actor:Actor,bucket:number){return encode(JSON.stringify(["operations-native-billing-permission-delegation-csrf-v1",ORIGIN,
  actor.identity.staffId,actor.identity.verifiedAccessSubject,actor.admissionVersion,actor.identity.profileVersion,bucket]));}
async function csrf(secret:string,actor:Actor,request?:Request):Promise<string>{
  const bucket=Math.floor(Date.now()/600_000),token=request?.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const key=await crypto.subtle.importKey("raw",buffer(encode(secret)),{name:"HMAC",hash:"SHA-256"},false,request?["verify"]:["sign"]);
  if(request){const supplied=Number(token?.[1]);
    if(!token||supplied!==bucket&&supplied!==bucket-1||!await crypto.subtle.verify("HMAC",key,
      buffer(Uint8Array.from(token[2]!.match(/../gu)!,part=>Number.parseInt(part,16))),buffer(message(actor,supplied))))throw new Failure(403,"denied");
    return "";
  }
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,buffer(message(actor,bucket))));
  return `${bucket}.${[...signature].map(byte=>byte.toString(16).padStart(2,"0")).join("")}`;
}
async function body(request:Request,keys:string[]){
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type")??""))throw new Failure(400,"invalid_request");
  let value:unknown;try{value=await readBoundedJson(request,2048,"billing permission delegation");}catch{throw new Failure(400,"invalid_request");}
  if(!exact(value,keys))throw new Failure(400,"invalid_request");return value;
}
// Keep the issuer's prerequisite, plus 0191's exact-resource deny fence.
// The issuer's historical replay predicate is unchanged by this boundary.
async function manager(db:Db,actor:Actor,resourceId:string|null=null){alive(actor);
  const authorized=await db.prepare(`SELECT 1 ok FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id JOIN staff_users staff ON staff.id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.version=? AND staff.status='active' AND staff.access_subject=? AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=admission.staff_id AND g.permission='directory.portal_access.manage'
        AND g.effect='allow' AND g.active=1 AND g.scope_kind='global')
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=admission.staff_id AND g.permission='directory.portal_access.manage'
        AND g.effect='deny' AND g.active=1 AND (g.scope_kind='global' OR (g.scope_kind='resource' AND g.resource_id=?)))`).bind(actor.identity.staffId,actor.identity.verifiedAccessSubject,
      actor.admissionVersion,actor.identity.profileVersion,actor.identity.verifiedAccessSubject,actor.verifiedUntil,resourceId).first();
  if(!authorized)throw new Failure(403,"denied");
}
async function target(db:Db,staffId:string,resourceId:string){
  const value=await db.prepare(`SELECT COALESCE(g.generation,0) generation FROM native_staff_admissions a
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    LEFT JOIN operations_portal_native_billing_permission_generations g ON g.staff_id=a.staff_id
    WHERE a.staff_id=? AND a.active=1 AND s.status='active' AND EXISTS(SELECT 1 FROM operations_directory_records r WHERE r.record_id=?)`)
    .bind(staffId,resourceId).first<{generation:number}>();
  if(!value||!generation(value.generation))throw new Failure(403,"denied");return value.generation;
}
async function review(db:Db,actor:Actor,staffId:string,resourceId:string){
  await manager(db,actor,resourceId);const currentGeneration=await target(db,staffId,resourceId);
  const rows=(await db.prepare(`SELECT p.grant_id,p.effect,p.scope_kind,p.resource_id,
    EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations r WHERE r.grant_id=p.grant_id) revoked
    FROM operations_portal_native_billing_permissions p WHERE p.staff_id=? AND p.scope_kind='resource' AND p.resource_id=?
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations r WHERE r.grant_id=p.grant_id)
    ORDER BY p.grant_id LIMIT 101`).bind(staffId,resourceId).all<{grant_id:string;effect:string;scope_kind:string;resource_id:string|null;revoked:number}>()).results;
  // Never disclose global or unrelated-resource ledger IDs through this narrow
  // resource review, even if a provider adapter returns unexpected extra rows.
  const permissions=rows.filter(r=>r.scope_kind==="resource"&&r.resource_id===resourceId&&r.revoked===0).map(r=>{
    if(!uuid(r.grant_id)||r.effect!=="allow"&&r.effect!=="deny"||r.scope_kind!=="global"&&r.scope_kind!=="resource"
      ||r.scope_kind==="global"&&r.resource_id!==null||r.scope_kind==="resource"&&r.resource_id!==resourceId||r.revoked!==0&&r.revoked!==1)throw new Failure(503,"unavailable");
    return {grantId:r.grant_id,effect:r.effect,scopeKind:r.scope_kind,resourceId:r.resource_id,revoked:r.revoked===1};
  });
  if(permissions.length>100)throw new Failure(503,"unavailable");
  await manager(db,actor,resourceId);return {staffId,resourceId,generation:currentGeneration,permissions};
}
/** Fixed-host, default-off staging boundary. Session CSRF conveys no permission. */
export async function handleOperationsPortalNativeBillingPermissionOwnerHttp(request:Request,d:OperationsPortalNativeBillingPermissionOwnerHttpDependencies):Promise<Response>{
  try{
    const configuration=config(d),url=new URL(request.url),base=OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE;
    if(url.origin!==ORIGIN||url.hash||request.headers.get("Sec-Fetch-Site")!=="same-origin")throw new Failure(403,"denied");
    const route=url.pathname.startsWith(`${base}/`)?url.pathname.slice(base.length):"";
    const session=request.method==="GET"&&route==="/session",read=request.method==="POST"&&route==="/review",
      issue=request.method==="POST"&&route==="/grants",revoke=request.method==="POST"&&/^\/grants\/[0-9a-f-]{36}\/revoke$/u.test(route);
    if(!session&&!read&&!issue&&!revoke)throw new Failure(404,"not_found");
    if(url.search)throw new Failure(400,"invalid_request");
    if(request.headers.has("Origin")&&request.headers.get("Origin")!==ORIGIN||request.method==="POST"&&request.headers.get("Origin")!==ORIGIN
      ||request.method==="GET"&&request.headers.get("X-Native-Staff-Request")!=="1")throw new Failure(403,"denied");
    let actor:Actor;try{actor=await(d.authenticate??authenticateNativeStaffWithAdmissionVersion)(request,d.database,configuration.access);}catch{throw new Failure(403,"denied");}
    alive(actor);if(session)return reply(200,{csrfToken:await csrf(configuration.secret,actor)});
    await csrf(configuration.secret,actor,request);const db=d.database.withSession("first-primary");
    if(read){const value=await body(request,["staffId","resourceId"]);
      if(!identifier(value.staffId)||!identifier(value.resourceId))throw new Failure(400,"invalid_request");
      return reply(200,{review:await review(db,actor,value.staffId,value.resourceId)});
    }
    let change:NativeBillingPermissionChange;
    if(issue){const value=await body(request,["confirm","operationId","grantId","expectedGeneration","staffId","effect","resourceId"]);
      if(value.confirm!==true||!uuid(value.operationId)||!uuid(value.grantId)||!generation(value.expectedGeneration)
        ||!identifier(value.staffId)||!identifier(value.resourceId)||value.effect!=="allow"&&value.effect!=="deny")throw new Failure(400,"invalid_request");
      await manager(db,actor,value.resourceId);await target(db,value.staffId,value.resourceId);
      change={action:"issue",operationId:value.operationId,grantId:value.grantId,expectedGeneration:value.expectedGeneration,
        staffId:value.staffId,effect:value.effect,scope:{kind:"resource",resourceId:value.resourceId}};
    }else{const grantId=route.split("/")[2]!;if(!uuid(grantId))throw new Failure(404,"not_found");
      const value=await body(request,["confirm","operationId","expectedGeneration"]);
      if(value.confirm!==true||!uuid(value.operationId)||!generation(value.expectedGeneration))throw new Failure(400,"invalid_request");
      await manager(db,actor);
      // Revoke remains available after beneficiary disablement. Global permission
      // changes are deliberately outside this resource-scoped UI contract.
      const grant=await db.prepare("SELECT resource_id FROM operations_portal_native_billing_permissions WHERE grant_id=? AND scope_kind='resource'").bind(grantId).first<{resource_id:string}>();
      if(!grant||!identifier(grant.resource_id))throw new Failure(403,"denied");
      await manager(db,actor,grant.resource_id);
      change={action:"revoke",operationId:value.operationId,grantId,expectedGeneration:value.expectedGeneration};
    }
    const result=await(d.manage??manageOperationsPortalNativeBillingPermission)(d.database,actor,change);alive(actor);
    if(result.status==="conflict")throw new Failure(result.reason==="authority"?403:409,result.reason==="authority"?"denied":"conflict");
    if(result.operationId!==change.operationId||result.grantId!==change.grantId||!generation(result.generation)
      ||result.generation!==change.expectedGeneration+1||result.status!=="applied"&&result.status!=="replayed")throw new Failure(503,"unavailable");
    return reply(200,{status:result.status,operationId:result.operationId,grantId:result.grantId,generation:result.generation});
  }catch(error){const failure=error instanceof Failure?error:new Failure(503,"unavailable");return reply(failure.status,{error:failure.code});}
}
