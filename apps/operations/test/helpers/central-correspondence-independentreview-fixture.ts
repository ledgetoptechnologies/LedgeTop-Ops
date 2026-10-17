import { Miniflare } from "miniflare";
import { applyCanonicalChain } from "./verified-recipient-canonical-lineage";
import { registerVisibleTestSource } from "./project-alpha-connectors";
import { managePortalDirectoryCorrespondence, previewPortalDirectoryCorrespondence, type CorrespondenceEnv } from "../../src/worker/portal-directory-correspondence";
import { synchronizePrimaryDeliveryAuthority } from "../../src/worker/project-alpha-primary-delivery-authority";
import type { StaffPrincipal } from "../../src/worker/types";
import { reservePrimaryPortalPrivateIngress } from "../../../client/src/worker/project-alpha-portal-authority";

export const correspondenceLogicalSource="project-alpha:staging",correspondencePrimarySource="project-alpha:primary";
export const correspondenceTuple={sourceInstanceId:"11111111-1111-4111-8111-111111111111",applicationId:"22222222-2222-4222-8222-222222222222",historyEpochId:"33333333-3333-4333-8333-333333333333"};
export const correspondenceOwner:StaffPrincipal={id:"independent-correspondence-owner",email:"independent-owner@example.test",displayName:"Independent Owner",accessSubject:"independent-access-subject",projectAlphaUserId:null};
/** Real current schemas and supported registry/primary mirror. No trigger bypass or synthetic authority-table replacement. */
export async function createIndependentCorrespondenceFixture(){
 const runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID(),DELIVERY_DB:crypto.randomUUID()}});
 try{
  const ops=await runtime.getD1Database("OPS_DB") as unknown as D1Database,client=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const opsNames=await applyCanonicalChain(ops,"operations","0212_primary_portal_directory_correspondence.sql");
  const clientNames=await applyCanonicalChain(client,"client","0234_pa_principal_reenrollment.sql");
  const actor=correspondenceOwner,primary=correspondencePrimarySource,logical=correspondenceLogicalSource;
  await ops.batch([
   ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(actor.id,actor.email,actor.displayName,actor.accessSubject),
   ops.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(actor.id,actor.accessSubject,actor.id),
   ops.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(actor.id,actor.email,actor.displayName),
   ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)").bind("independent-owner-role",actor.id,actor.id),
  ]);
  await registerVisibleTestSource(ops,primary,"Independent primary");
  const origin=await ops.prepare("SELECT snapshot_origin FROM pa_connectors WHERE source_id=?").bind(primary).first<string>("snapshot_origin");
  const tuple=correspondenceTuple;
  const config={version:1,instances:{[logical]:{sourceId:logical,enabled:true,baseUrl:origin,apiKey:"test-private-key",sourceInstanceId:tuple.sourceInstanceId,applicationId:tuple.applicationId,historyEpoch:tuple.historyEpochId}}};
  await ops.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(primary).run();
  const connector=await ops.prepare("SELECT active_revision,version FROM pa_connectors WHERE source_id=?").bind(primary).first<{active_revision:number;version:number}>();
  await synchronizePrimaryDeliveryAuthority(client,{kind:"primary_connector",sourceId:primary,mode:"registry",connectorRevision:connector!.active_revision,connectorVersion:connector!.version});
  await reservePrimaryPortalPrivateIngress({DELIVERY_DB:client,PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:"false",PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"ltds"});
  const env:CorrespondenceEnv={OPS_DB:ops,DELIVERY_DB:client,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(config)};
  const send:typeof fetch=async(input,init)=>{
   if(new URL(String(input)).pathname!=="/api/v2/capabilities"||(init?.method??"GET")!=="GET")throw Error("unexpected independent PA fixture request");
   return Response.json({apiVersion:"2",sourceInstanceId:tuple.sourceInstanceId,applicationId:tuple.applicationId,historyEpoch:tuple.historyEpochId,requestId:"55555555-5555-4555-8555-555555555555",grantedCapabilities:[{name:"api.capabilities.read"}],implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"}]},{headers:{"Cache-Control":"no-store","X-Request-ID":"55555555-5555-4555-8555-555555555555"}});
  };
  const approve=async()=>{
   const p=await previewPortalDirectoryCorrespondence(env,logical);if(!p.preview)throw Error("independent correspondence preview missing");
   const command={operationId:crypto.randomUUID(),action:"approve" as const,expectedVersion:p.current?.version??0,expectedProofSha256:p.preview.proofSha256};
   const result=await managePortalDirectoryCorrespondence(env,actor,logical,command,send);if(!result.ok)throw Error("independent correspondence approval failed");return{result,command};
  };
  return{runtime,ops,client,env,send,approve,actor,tuple,opsNames,clientNames,dispose:()=>runtime.dispose()};
 }catch(error){await runtime.dispose();throw error;}
}
