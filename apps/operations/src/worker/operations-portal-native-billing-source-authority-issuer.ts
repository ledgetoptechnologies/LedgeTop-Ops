import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from "./native-staff-auth";
import { readOperationsPortalNativeBillingAuthorityStatus } from "./operations-portal-native-billing-authority-issuer";
import { resolveNativeBillingSourceContext, sameNativeBillingSourceIdentity,nativeBillingSourceContextFromEvidence, type NativeBillingSourceEnv } from "./operations-portal-native-billing-source-context";
import { prepareTrustedNativeFinancialMappingQuery,nativeFinancialMappingEvidenceFromRows,type NativeFinancialMappingRow,
  type NativeFinancialTarget } from "./project-alpha-financial-mapping";
import { nativeBillingSourceUuid, parseNativeBillingSourceSelection, parseNativeBillingSourceGrant,
  parseNativeBillingSourceRevoke, type NativeBillingSourceSelection, type NativeBillingSourceGrant,
  type NativeBillingSourceRevoke, type NativeBillingSourceContext } from "../../../../packages/shared/src/operations-portal-native-billing-source-authority";
type Row={grant_id:string;parent_grant_id:string;source_id:string;revision:number;state:"active"|"revoked";
 latest_operation_id:string;parent_revision:number;parent_finalization_id:string;context_json:string};
type Parent={grant_id:string;revision:number;latest_grant_finalization_id:string;entity_kind:"organization"|"client"|"project";native_entity_id:string};
const denied=():never=>{throw Error("native_billing_source_authority_denied");};
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))))
 .map(v=>v.toString(16).padStart(2,"0")).join("");
async function parent(env:NativeBillingSourceEnv,actor:Actor,id:string,requireLive:boolean):Promise<Parent>{
  // Reuse the ordinary deny-aware root billing permission/admission check, including for cleanup of stale children.
  const status=await readOperationsPortalNativeBillingAuthorityStatus(env.OPS_DB,actor,id);
  if(requireLive&&!status.live)denied();
  return await env.OPS_DB.withSession("first-primary").prepare(`SELECT grant_id,revision,latest_grant_finalization_id,
    entity_kind,native_entity_id FROM operations_portal_native_billing_authority_heads WHERE grant_id=?`).bind(id).first<Parent>()??denied();
}
async function head(env:NativeBillingSourceEnv,id:string):Promise<Row|null>{
  return env.OPS_DB.withSession("first-primary").prepare(`SELECT h.*,c.parent_revision,c.parent_finalization_id,c.context_json
    FROM operations_portal_native_billing_source_heads h JOIN operations_portal_native_billing_source_commands c
    ON c.operation_id=h.latest_operation_id WHERE h.grant_id=?`).bind(id).first<Row>();
}
export async function readNativeBillingSourceAuthorityStatus(env:NativeBillingSourceEnv,actor:Actor,id:string){
  if(!nativeBillingSourceUuid(id))denied();
  const h=await head(env,id)??denied();await parent(env,actor,h.parent_grant_id,false);
  const live=await env.OPS_DB.withSession("first-primary").prepare(`SELECT grant_id FROM
    operations_portal_native_billing_source_live_authority WHERE grant_id=?`).bind(id).first();
  const p=await parent(env,actor,h.parent_grant_id,false);
  const current=live?await resolveNativeBillingSourceContext(env,p,h.source_id):null;
  const target:NativeFinancialTarget=p.entity_kind==="project"?{kind:"project",externalProjectId:p.native_entity_id,sourceId:h.source_id}
    :{kind:p.entity_kind,recordId:p.native_entity_id,sourceId:h.source_id};
  const query=current?await prepareTrustedNativeFinancialMappingQuery(env,target):null;
  type Final={revision:number;parent_revision:number;parent_finalization_id:string;context_json:string};
  let final:Final|null=null,atomicContext:NativeBillingSourceContext|null=null;
  if(query){
    const db=env.OPS_DB.withSession("first-primary");
    const snapshot=await db.batch([db.prepare(query.sql).bind(...query.params),db.prepare(`SELECT revision,parent_revision,parent_finalization_id,context_json
      FROM operations_portal_native_billing_source_live_authority WHERE grant_id=?`).bind(id)]);
    if(snapshot.length===2&&snapshot.every(result=>result.success===true)){
      const evidence=nativeFinancialMappingEvidenceFromRows(env,target,snapshot[0]!.results as NativeFinancialMappingRow[]);
      atomicContext=evidence?nativeBillingSourceContextFromEvidence(evidence):null;
      const rows=snapshot[1]!.results as Final[];final=rows.length===1?rows[0]!:null;
    }
  }
  return {grantId:h.grant_id,parentGrantId:h.parent_grant_id,sourceId:h.source_id,revision:h.revision,state:h.state,
    live:Boolean(atomicContext&&final&&final.revision===h.revision&&final.parent_revision===h.parent_revision
      &&final.parent_finalization_id===h.parent_finalization_id&&final.context_json===h.context_json
      &&p.revision===h.parent_revision&&p.latest_grant_finalization_id===h.parent_finalization_id
      &&sameNativeBillingSourceIdentity(atomicContext,JSON.parse(h.context_json))),context:JSON.parse(h.context_json) as NativeBillingSourceContext};
}
async function candidate(env:NativeBillingSourceEnv,actor:Actor,input:NativeBillingSourceSelection){
  const p=await parent(env,actor,input.parentGrantId,true), context=await resolveNativeBillingSourceContext(env,p,input.sourceId)??denied();
  const h=await env.OPS_DB.withSession("first-primary").prepare(`SELECT grant_id,revision FROM
    operations_portal_native_billing_source_heads WHERE parent_grant_id=? AND source_id=?`)
    .bind(input.parentGrantId,input.sourceId).first<{grant_id:string;revision:number}>();
  const generation=await env.OPS_DB.withSession("first-primary").prepare(`SELECT generation FROM
    operations_portal_native_billing_permission_generations WHERE staff_id=?`).bind(actor.identity.staffId).first<{generation:number}>()??denied();
  const expectedRevision=h?.revision??0;
  const reviewFingerprint=await hash(JSON.stringify({parentGrantId:p.grant_id,parentRevision:p.revision,
    parentFinalizationId:p.latest_grant_finalization_id,context,expectedRevision,staffId:actor.identity.staffId,
    accessSubject:actor.identity.verifiedAccessSubject,admissionVersion:actor.admissionVersion,
    profileVersion:actor.identity.profileVersion,grantGeneration:generation.generation}));
  return {p,context,generation:generation.generation,grantId:h?.grant_id??null,expectedRevision,reviewFingerprint};
}
export async function reviewNativeBillingSourceAuthority(env:NativeBillingSourceEnv,actor:Actor,value:NativeBillingSourceSelection){
  const input=parseNativeBillingSourceSelection(value)??denied(), c=await candidate(env,actor,input);
  return {...input,grantId:c.grantId,expectedRevision:c.expectedRevision,reviewFingerprint:c.reviewFingerprint,context:c.context};
}
type Command=ReturnType<typeof command>;
function command(actor:Actor,input:NativeBillingSourceGrant|NativeBillingSourceRevoke,p:Parent,context:NativeBillingSourceContext,
  generation:number,action:"grant"|"revoke"){
  return {protocol:"operations-native-billing-source-authority",protocolVersion:1,operationId:input.operationId,
    grantId:input.grantId,parentGrantId:p.grant_id,parentRevision:p.revision,parentFinalizationId:p.latest_grant_finalization_id,
    sourceId:context.sourceId,action,expectedRevision:input.expectedRevision,resultingRevision:input.expectedRevision+1,context,
    actor:{staffId:actor.identity.staffId,accessSubject:actor.identity.verifiedAccessSubject,admissionVersion:actor.admissionVersion,
      profileVersion:actor.identity.profileVersion,grantGeneration:generation,verifiedUntil:actor.verifiedUntil},observedAt:new Date().toISOString()};
}
async function apply(env:NativeBillingSourceEnv,c:Command){
  const wire=JSON.stringify(c),sha=await hash(wire),a=c.actor,db=env.OPS_DB.withSession("first-primary");
  const insert=db.prepare(`INSERT INTO operations_portal_native_billing_source_commands
    (operation_id,request_sha256,canonical_command_json,grant_id,parent_grant_id,parent_revision,parent_finalization_id,source_id,
    action,expected_revision,resulting_revision,context_json,actor_staff_id,actor_access_subject,actor_admission_version,
    actor_profile_version,actor_grant_generation,actor_verified_until,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(c.operationId,sha,wire,c.grantId,c.parentGrantId,c.parentRevision,c.parentFinalizationId,c.sourceId,c.action,
      c.expectedRevision,c.resultingRevision,JSON.stringify(c.context),a.staffId,a.accessSubject,a.admissionVersion,a.profileVersion,
      a.grantGeneration,a.verifiedUntil,c.observedAt);
  const update=c.expectedRevision===0?db.prepare(`INSERT INTO operations_portal_native_billing_source_heads
    (grant_id,parent_grant_id,source_id,revision,state,creation_operation_id,latest_operation_id) VALUES(?,?,?,1,'active',?,?)`)
    .bind(c.grantId,c.parentGrantId,c.sourceId,c.operationId,c.operationId)
    :db.prepare(`UPDATE operations_portal_native_billing_source_heads SET revision=?,state=?,latest_operation_id=?
      WHERE grant_id=? AND revision=?`).bind(c.resultingRevision,c.action==="grant"?"active":"revoked",c.operationId,c.grantId,c.expectedRevision);
  await db.batch([insert,update]);
}
async function replay(env:NativeBillingSourceEnv,actor:Actor,input:NativeBillingSourceGrant|NativeBillingSourceRevoke,action:"grant"|"revoke"){
  const stored=await env.OPS_DB.withSession("first-primary").prepare(`SELECT canonical_command_json,request_sha256 FROM
    operations_portal_native_billing_source_commands WHERE operation_id=?`).bind(input.operationId)
    .first<{canonical_command_json:string;request_sha256:string}>();
  if(!stored)return null;
  const c=JSON.parse(stored.canonical_command_json) as Command;
  const reviewed=await hash(JSON.stringify({parentGrantId:c.parentGrantId,parentRevision:c.parentRevision,
    parentFinalizationId:c.parentFinalizationId,context:c.context,expectedRevision:c.expectedRevision,
    staffId:c.actor.staffId,accessSubject:c.actor.accessSubject,admissionVersion:c.actor.admissionVersion,
    profileVersion:c.actor.profileVersion,grantGeneration:c.actor.grantGeneration}));
  if(await hash(stored.canonical_command_json)!==stored.request_sha256||c.action!==action||c.grantId!==input.grantId
    ||c.expectedRevision!==input.expectedRevision||c.actor.staffId!==actor.identity.staffId
    ||c.actor.accessSubject!==actor.identity.verifiedAccessSubject
    ||("sourceId" in input&&(c.sourceId!==input.sourceId||c.parentGrantId!==input.parentGrantId
      ||input.reviewFingerprint!==reviewed)))return {status:"conflict" as const};
  return {status:"replayed" as const,operationId:input.operationId,authority:await readNativeBillingSourceAuthorityStatus(env,actor,input.grantId)};
}
export async function grantNativeBillingSourceAuthority(env:NativeBillingSourceEnv,actor:Actor,value:NativeBillingSourceGrant){
  const input=parseNativeBillingSourceGrant(value)??denied(), prior=await replay(env,actor,input,"grant");if(prior)return prior;
  const c=await candidate(env,actor,input);
  if(c.expectedRevision!==input.expectedRevision||(c.grantId!==null&&c.grantId!==input.grantId)
    ||c.reviewFingerprint!==input.reviewFingerprint)return {status:"conflict" as const};
  try{await apply(env,command(actor,input,c.p,c.context,c.generation,"grant"));}catch{return {status:"conflict" as const};}
  return {status:"applied" as const,operationId:input.operationId,authority:await readNativeBillingSourceAuthorityStatus(env,actor,input.grantId)};
}
export async function revokeNativeBillingSourceAuthority(env:NativeBillingSourceEnv,actor:Actor,value:NativeBillingSourceRevoke){
  const input=parseNativeBillingSourceRevoke(value)??denied(),prior=await replay(env,actor,input,"revoke");if(prior)return prior;
  const h=await head(env,input.grantId)??denied(),p=await parent(env,actor,h.parent_grant_id,false);
  if(h.revision!==input.expectedRevision)return {status:"conflict" as const};
  const g=await env.OPS_DB.withSession("first-primary").prepare(`SELECT generation FROM operations_portal_native_billing_permission_generations
    WHERE staff_id=?`).bind(actor.identity.staffId).first<{generation:number}>()??denied();
  try{await apply(env,command(actor,input,p,JSON.parse(h.context_json),g.generation,"revoke"));}catch{return {status:"conflict" as const};}
  return {status:"applied" as const,operationId:input.operationId,authority:await readNativeBillingSourceAuthorityStatus(env,actor,input.grantId)};
}
