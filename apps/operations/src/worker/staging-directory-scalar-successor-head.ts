import { readConfiguredProjectAlphaDirectoryInventory, type ProjectAlphaDirectoryInventoryOutcome } from "./project-alpha-directory-inventory-api-v2";
import { readConfiguredProjectAlphaDirectoryBindingStatus, type ProjectAlphaDirectoryBindingStatusOutcome } from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqlScope } from "./acl";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { selectGrant } from "./native-directory-profile-routes";
import type { StaffPrincipal } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

const SOURCE="project-alpha:staging", RECORD="614ed50f-8800-4ab3-aa69-009d8e5cefa9", MAX=8;
const HOST="ops-staging.ledgetopdroneservices.com", OWNER="staff-beau-koltz";
export const STAGING_DIRECTORY_SCALAR_SUCCESSOR_HEAD_ROUTE="/api/admin/staging/directory/scalar-successor-head";
type Local={sourceId:string;sourceInstanceId:string;applicationId:string;historyEpoch:string;origin:string;externalId:string;publicId:string;revision:string;projectionSha256:string;relationshipVersion:number;commandId:string;relationshipAuthorizationGeneration:string;mappingKind:"legacy"|"acquired";mappingProvenanceId:string;mappingCreatedAt:string};
type Readers={local:(db:D1Database)=>Promise<Local|null>;inventory:typeof readConfiguredProjectAlphaDirectoryInventory;binding:typeof readConfiguredProjectAlphaDirectoryBindingStatus};
const canonical=(v:string,zero=false)=>new RegExp(zero?"^(0|[1-9][0-9]{0,18})$":"^[1-9][0-9]{0,18}$").test(v)&&(v.length<19||v<="9223372036854775807");
const same=(a:Local,b:Local)=>JSON.stringify(a)===JSON.stringify(b);

export async function readLocalScalarSuccessorTuple(db:D1Database):Promise<Local|null>{
  const rows=await db.withSession("first-primary").prepare(`SELECT mapping.source_id sourceId,mapping.source_instance_id sourceInstanceId,mapping.application_id applicationId,mapping.history_epoch_id historyEpoch,
    mapping.external_id externalId,mapping.project_alpha_public_id publicId,mapping.mapping_kind mappingKind,mapping.provenance_id mappingProvenanceId,mapping.created_at mappingCreatedAt,
    ack.destination_origin origin,ack.revision,observation.projection_sha256 projectionSha256,ack.relationship_version relationshipVersion,ack.command_id commandId,
    json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') relationshipAuthorizationGeneration
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=mapping.record_id
    JOIN project_alpha_directory_validated_recovery_relationship_acknowledgements ack ON ack.client_record_id=mapping.record_id AND ack.relationship_version=relation.relationship_version
      AND ack.source_id=mapping.source_id AND ack.source_instance_id=mapping.source_instance_id AND ack.application_id=mapping.application_id AND ack.history_epoch_id=mapping.history_epoch_id
      AND ack.client_public_id=mapping.project_alpha_public_id AND ack.identity_valid=1
    JOIN project_alpha_directory_relationship_recovery_outbox outbox ON outbox.command_id=ack.command_id AND outbox.state='acknowledged'
    JOIN project_alpha_api_v2_directory_observations observation ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id AND observation.resource_type='client' AND observation.project_alpha_public_id=mapping.project_alpha_public_id AND observation.resource_revision=ack.revision AND observation.present=1
    JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
      AND receipt.observed_at=(SELECT max(latest.observed_at) FROM project_alpha_api_v2_inventory_receipts latest JOIN project_alpha_api_v2_directory_observations latest_observation ON latest_observation.source_id=latest.source_id AND latest_observation.source_instance_id=latest.source_instance_id AND latest_observation.application_id=latest.application_id AND latest_observation.history_epoch_id=latest.history_epoch_id AND latest_observation.request_id=latest.request_id AND latest_observation.resource_type='client' AND latest_observation.project_alpha_public_id=mapping.project_alpha_public_id WHERE latest.source_id=receipt.source_id AND latest.source_instance_id=receipt.source_instance_id AND latest.application_id=receipt.application_id AND latest.history_epoch_id=receipt.history_epoch_id AND latest.inventory_kind='directory')
      AND 1=(SELECT count(*) FROM project_alpha_api_v2_inventory_receipts tied JOIN project_alpha_api_v2_directory_observations tied_observation ON tied_observation.source_id=tied.source_id AND tied_observation.source_instance_id=tied.source_instance_id AND tied_observation.application_id=tied.application_id AND tied_observation.history_epoch_id=tied.history_epoch_id AND tied_observation.request_id=tied.request_id AND tied_observation.resource_type='client' AND tied_observation.project_alpha_public_id=mapping.project_alpha_public_id WHERE tied.source_id=receipt.source_id AND tied.source_instance_id=receipt.source_instance_id AND tied.application_id=receipt.application_id AND tied.history_epoch_id=receipt.history_epoch_id AND tied.inventory_kind='directory' AND tied.observed_at=receipt.observed_at)
    WHERE mapping.source_id=? AND mapping.resource_type='client' AND mapping.record_id=? LIMIT 2`).bind(SOURCE,RECORD).all<Local>();
  return rows.results.length===1?rows.results[0]!:null;
}
const defaults:Readers={local:readLocalScalarSuccessorTuple,inventory:readConfiguredProjectAlphaDirectoryInventory,binding:readConfiguredProjectAlphaDirectoryBindingStatus};
export async function collectStagingScalarSuccessorHead(env:Env,readers:Readers=defaults){
  if(env.ENVIRONMENT!=="staging"||env.EXPECTED_HOST!=="ops-staging.ledgetopdroneservices.com"||env.STAGING_DIRECTORY_SCALAR_SUCCESSOR_HEAD_ENABLED!=="true")return{status:"disabled" as const};
  const before=await readers.local(env.OPS_DB);if(!before||!canonical(before.revision)||!canonical(before.relationshipAuthorizationGeneration,true)||!/^[0-9a-f]{64}$/.test(before.projectionSha256))return{status:"blocked" as const,reason:"local" as const};
  let origin:string;try{origin=resolveProjectAlphaApiV2Connection(env,SOURCE).connection.baseUrl}catch{return{status:"blocked" as const,reason:"configuration" as const}}if(before.origin!==origin)return{status:"blocked" as const,reason:"origin" as const};
  let cursor:string|null=null,found:null|{revision:string;present:boolean;projectionSha256:string}=null,receipt:null|Record<string,unknown>=null;
  const seen=new Set<string>();let complete=false,generation:string|null=null;
  for(let n=0;n<MAX;n++){
    const outcome:ProjectAlphaDirectoryInventoryOutcome=await readers.inventory(env,SOURCE,{type:"client",limit:100,cursor});
    if(outcome.status!=="observed")return{status:"unavailable" as const,reason:"inventory" as const};const page=outcome.inventory;
    if(page.sourceId!==SOURCE||page.sourceInstanceId!==before.sourceInstanceId||page.applicationId!==before.applicationId||page.historyEpoch!==before.historyEpoch||!canonical(page.authorizationGeneration,true)||(generation!==null&&generation!==page.authorizationGeneration))return{status:"blocked" as const,reason:"inventory_identity" as const};generation=page.authorizationGeneration;
    for(const r of page.resources)if(r.type==="client"&&r.publicId===before.publicId){if(found)return{status:"blocked" as const,reason:"ambiguous" as const};found={revision:r.revision,present:r.present,projectionSha256:r.projectionSha256};receipt={source_id:SOURCE,source_instance_id:page.sourceInstanceId,application_id:page.applicationId,history_epoch_id:page.historyEpoch,inventory_kind:"directory",authorization_generation:page.authorizationGeneration,request_id:page.requestId};}
    if(page.nextCursor===null){complete=true;break}if(seen.has(page.nextCursor))return{status:"blocked" as const,reason:"pagination" as const};seen.add(page.nextCursor);cursor=page.nextCursor;
  }
  if(!complete||!found||!found.present||found.revision!==before.revision||found.projectionSha256!==before.projectionSha256||!receipt)return{status:"blocked" as const,reason:"inventory_target" as const};
  const binding:ProjectAlphaDirectoryBindingStatusOutcome=await readers.binding(env,SOURCE,"client",before.externalId,before.publicId);
  if(binding.status!=="observed")return{status:"unavailable" as const,reason:"binding" as const};const observation=binding.observation;
  if(observation.sourceId!==SOURCE||observation.sourceInstanceId!==before.sourceInstanceId||observation.applicationId!==before.applicationId||observation.historyEpoch!==before.historyEpoch||observation.authorizationGeneration!==String(receipt.authorization_generation)||observation.binding.externalId!==before.externalId||observation.binding.publicId!==before.publicId||observation.resource.revision!==before.revision||observation.resource.present!==true)return{status:"blocked" as const,reason:"binding_identity" as const};
  const after=await readers.local(env.OPS_DB);if(!after||!same(before,after))return{status:"blocked" as const,reason:"local_drift" as const};
  return{status:"observed" as const,local:before,inventoryReceipt:receipt,bindingObservation:observation};
}

type App=Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>;
export function registerStagingDirectoryScalarSuccessorHeadRoute(app:App,collect=collectStagingScalarSuccessorHead):void{
  app.post(STAGING_DIRECTORY_SCALAR_SUCCESSOR_HEAD_ROUTE,async c=>{
    if(c.env.STAGING_DIRECTORY_SCALAR_SUCCESSOR_HEAD_ENABLED!=="true"||c.env.ENVIRONMENT!=="staging"||c.env.EXPECTED_HOST!==HOST||new URL(c.req.url).origin!==`https://${HOST}`)throw new HTTPException(404,{message:"Not found"});
    c.header("Cache-Control","no-store");
    const principal=c.get("principal");if(!c.get("administrator")||principal.id!==OWNER)throw new HTTPException(403,{message:"Protected owner access required"});
    const scope=await sqlScope(c.env,principal,"integrations.manage");if(!scope.global||scope.deniedGlobal)throw new HTTPException(403,{message:"Global integrations.manage permission required"});
    let native;try{native=await authenticateNativeStaffWithAdmissionVersion(c.req.raw,c.env.OPS_DB,{enabled:true,issuer:c.env.TEAM_DOMAIN??"",staffAudience:c.env.OPERATIONS_AUD})}catch{throw new HTTPException(403,{message:"Current native staff authority is required"})}
    if(native.identity.staffId!==principal.id||native.identity.email!==principal.email||native.identity.verifiedAccessSubject!==principal.accessSubject)throw new HTTPException(403,{message:"Operations and native staff identities do not match"});
    const owner=await c.env.OPS_DB.withSession("first-primary").prepare("SELECT 1 ok FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner' AND scope='global' LIMIT 1").bind(principal.id).first();
    const view=await selectGrant(c.env.OPS_DB,principal.id,"directory.profile.view",RECORD,[],false);if(!owner||!view)throw new HTTPException(403,{message:"Protected owner Directory profile view required"});
    const result=await collect(c.env);
    let current;try{current=await authenticateNativeStaffWithAdmissionVersion(c.req.raw,c.env.OPS_DB,{enabled:true,issuer:c.env.TEAM_DOMAIN??"",staffAudience:c.env.OPERATIONS_AUD})}catch{throw new HTTPException(403,{message:"Current native staff authority is required"})}
    const currentScope=await sqlScope(c.env,principal,"integrations.manage"),currentOwner=await c.env.OPS_DB.withSession("first-primary").prepare("SELECT 1 ok FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner' AND scope='global' LIMIT 1").bind(principal.id).first(),currentView=await selectGrant(c.env.OPS_DB,principal.id,"directory.profile.view",RECORD,[],false);
    if(current.identity.staffId!==principal.id||current.identity.email!==principal.email||current.identity.verifiedAccessSubject!==principal.accessSubject||current.admissionVersion!==native.admissionVersion||!currentScope.global||currentScope.deniedGlobal||!currentOwner||!currentView)throw new HTTPException(403,{message:"Authority changed during read"});
    return c.json(result);
  });
}
