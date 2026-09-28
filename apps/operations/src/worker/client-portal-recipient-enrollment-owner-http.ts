import {Buffer} from "node:buffer";
import {timingSafeEqual} from "node:crypto";
import {readBoundedJson} from "./bounded-json";
import {authenticateNativeStaffWithAdmissionVersion,type NativeStaffAccessConfiguration} from "./native-staff-auth";
import {confirmRecipientEnrollmentIntent,issueRecipientEnrollmentIntent,listRecipientEnrollmentIntentsForOwner,
  readRecipientEnrollmentIntentForOwner,reconcileRecipientEnrollmentRevocation,revokeRecipientEnrollmentBinding}
  from "./client-portal-recipient-enrollment-ledger";
import {dispatchNextClientPortalAuthorityV2,type AuthorityV2Env} from "./client-portal-authority-v2-outbox";

const BASE="/api/native-client-portal/recipient-enrollment",UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIMIT=4_096,BUCKET=600,HEX=/^[0-9a-f]{64}$/,AUD=/^[A-Za-z0-9_-]{16,128}$/,encoder=new TextEncoder();
const HEADERS={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"};
type Config=NativeStaffAccessConfiguration&Readonly<{origin:string;recipientOrigin:string;csrfSecret:string}>;
export type RecipientEnrollmentOwnerHttpDependencies=Readonly<{environment?:string;expectedHost?:string;configuration:Config;
  database:D1Database;dispatch:AuthorityV2Env}>;
class Failure extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...HEADERS,"Content-Type":"application/json; charset=utf-8"}});
const exact=(value:unknown,names:readonly string[])=>Boolean(value&&typeof value==="object"&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===names.length
  &&names.every(name=>Object.hasOwn(value as object,name)));
function snapshot(d:RecipientEnrollmentOwnerHttpDependencies){try{if(d.environment!=="staging"||d.configuration.enabled!==true)
    throw new Failure(404,"not_found");if(!AUD.test(d.configuration.staffAudience)||encoder.encode(d.configuration.csrfSecret).byteLength<32
      ||encoder.encode(d.configuration.csrfSecret).byteLength>512)throw Error();const issuer=new URL(d.configuration.issuer),origin=new URL(d.configuration.origin),recipient=new URL(d.configuration.recipientOrigin);
    if(issuer.protocol!=="https:"||!issuer.hostname.endsWith(".cloudflareaccess.com")||issuer.origin!==d.configuration.issuer
      ||issuer.pathname!=="/"||origin.protocol!=="https:"||origin.origin!==d.configuration.origin||origin.pathname!=="/"
      ||origin.hostname!==d.expectedHost||!/(?:^|[-.])staging(?:[-.]|$)/.test(origin.hostname)
      ||recipient.protocol!=="https:"||recipient.origin!==d.configuration.recipientOrigin||recipient.origin===origin.origin
      ||!/(?:^|[-.])staging(?:[-.]|$)/.test(recipient.hostname)
      ||d.dispatch.CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED!=="true"||!d.dispatch.CLIENT_PORTAL_AUTHORITY_V2
      ||typeof d.dispatch.CLIENT_PORTAL_AUTHORITY_V2.applyAuthorityV3!=="function"
      ||typeof d.dispatch.CLIENT_PORTAL_AUTHORITY_V2.getAuthorityV3Status!=="function")throw Error();return{issuer:issuer.origin,
      origin:origin.origin,recipientOrigin:recipient.origin,access:{enabled:true,issuer:issuer.origin,staffAudience:d.configuration.staffAudience},secret:d.configuration.csrfSecret};
  }catch(error){if(error instanceof Failure)throw error;throw new Failure(503,"unavailable")}}
async function mac(secret:string,value:string){const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC",key,encoder.encode(value))).toString("hex")}
const message=(origin:string,actor:{identity:{staffId:string;verifiedAccessSubject:string};admissionVersion:number},bucket:number)=>
  JSON.stringify(["client-portal-recipient-enrollment-owner-csrf-v1",origin,actor.identity.staffId,
    actor.identity.verifiedAccessSubject,actor.admissionVersion,bucket]);
async function csrf(secret:string,origin:string,actor:{identity:{staffId:string;verifiedAccessSubject:string};admissionVersion:number},request?:Request){
  const bucket=Math.floor(Date.now()/1000/BUCKET),current=await mac(secret,message(origin,actor,bucket));if(!request)return current;
  const candidate=request.headers.get("X-CSRF-Token")??"",prior=await mac(secret,message(origin,actor,bucket-1));
  if(!HEX.test(candidate)||candidate.length!==64||!(timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(current,"hex"))
    ||timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(prior,"hex"))))throw new Failure(403,"denied")}
async function body(request:Request,names:readonly string[]){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type")??""))
  throw new Failure(400,"invalid_request");let value:unknown;try{value=await readBoundedJson(request,LIMIT,"recipient enrollment owner")}
  catch(error){if(error&&typeof error==="object"&&"status" in error&&error.status===413)throw new Failure(413,"request_too_large");throw new Failure(400,"invalid_request")}
  if(!exact(value,names))throw new Failure(400,"invalid_request");return value as Record<string,unknown>}
const alive=(until:string)=>{if(Date.parse(until)<=Date.now())throw new Failure(403,"denied")};

export async function handleRecipientEnrollmentOwnerHttp(request:Request,d:RecipientEnrollmentOwnerHttpDependencies){try{
  const config=snapshot(d),url=new URL(request.url);if(url.origin!==config.origin||url.search||url.hash)throw new Failure(403,"denied");
  if(url.pathname!==BASE&&!url.pathname.startsWith(`${BASE}/`))throw new Failure(404,"not_found");
  if(request.headers.get("Sec-Fetch-Site")!=="same-origin")throw new Failure(403,"denied");
  const relative=url.pathname.slice(BASE.length),session=request.method==="GET"&&relative==="/session",listing=request.method==="GET"&&relative==="/intents";
  const read=request.method==="GET"&&/^\/intents\/[0-9a-f-]{36}$/.test(relative),issue=request.method==="POST"&&relative==="/intents";
  const mutation=request.method==="POST"&&/^\/intents\/[0-9a-f-]{36}\/(confirm|revoke|reconcile)$/.test(relative);
  if(!session&&!listing&&!read&&!issue&&!mutation)throw new Failure(404,"not_found");
  if(session){if(request.headers.get("X-Native-Staff-Request")!=="1"||(request.headers.get("Origin")!==null&&request.headers.get("Origin")!==config.origin))throw new Failure(403,"denied")}
  else if((issue||mutation)&&request.headers.get("Origin")!==config.origin)throw new Failure(403,"denied");
  let actor;try{actor=await authenticateNativeStaffWithAdmissionVersion(request,d.database,config.access)}catch{throw new Failure(403,"denied")}alive(actor.verifiedUntil);
  if(session){const csrfToken=await csrf(config.secret,config.origin,actor);alive(actor.verifiedUntil);
    return json(200,{csrfToken,verifiedUntil:actor.verifiedUntil,recipientOrigin:config.recipientOrigin})}
  if(listing){const intents=await listRecipientEnrollmentIntentsForOwner(d.database,actor);alive(actor.verifiedUntil);return json(200,{intents})}
  const intentId=read?relative.slice(9):mutation?relative.split("/")[2]! : null;
  if(read){const intent=await readRecipientEnrollmentIntentForOwner(d.database,intentId!,actor);alive(actor.verifiedUntil);return json(200,{intent})}
  await csrf(config.secret,config.origin,actor,request);alive(actor.verifiedUntil);
  if(issue){const value=await body(request,["operationId","selectionId","clientRecordId","expiresAt"]);
    if(typeof value.operationId!=="string"||!UUID.test(value.operationId)||typeof value.selectionId!=="string"||!UUID.test(value.selectionId)
      ||typeof value.clientRecordId!=="string"||value.clientRecordId.length<1||value.clientRecordId.length>200
      ||value.clientRecordId.trim()!==value.clientRecordId||typeof value.expiresAt!=="string")throw new Failure(400,"invalid_request");
    const result=await issueRecipientEnrollmentIntent(d.database,{operationId:value.operationId,target:{selectionId:value.selectionId,
      clientRecordId:value.clientRecordId},expiresAt:value.expiresAt,owner:actor});alive(actor.verifiedUntil);return json(result.replayed?200:201,result)}
  const action=relative.split("/")[3]!,value=await body(request,["operationId","expectedRevision"]);
  if(typeof value.operationId!=="string"||!UUID.test(value.operationId)||typeof value.expectedRevision!=="number"
    ||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)throw new Failure(400,"invalid_request");
  const input={intentId:intentId!,operationId:value.operationId,expectedRevision:value.expectedRevision,owner:actor};alive(actor.verifiedUntil);
  if(action==="reconcile"){const result=await reconcileRecipientEnrollmentRevocation(d.database,input);
    alive(actor.verifiedUntil);return json(200,result)}
  const result=action==="confirm"?await confirmRecipientEnrollmentIntent(d.database,input):await revokeRecipientEnrollmentBinding(d.database,input);
  alive(actor.verifiedUntil);let dispatched;try{dispatched=await dispatchNextClientPortalAuthorityV2(d.dispatch,result.operationId)}catch{throw new Failure(503,"unavailable")}
  alive(actor.verifiedUntil);
  if(dispatched.status==="dead")return json(409,{operationId:result.operationId,status:"rejected"});
  return json(dispatched.status==="acknowledged"?200:202,{operationId:result.operationId,
    status:dispatched.status==="acknowledged"?"acknowledged":"pending",intent:result.review,replayed:result.replayed});
}catch(error){const failure=error instanceof Failure?error:new Failure(error instanceof Error&&error.message==="recipient_enrollment_denied"?403:503,
  error instanceof Error&&error.message==="recipient_enrollment_denied"?"denied":"unavailable");return json(failure.status,{error:failure.code})}}
