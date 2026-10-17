import { vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class {}}));
import { ingestOpsSyncPortalProjection } from "../../../client/src/worker/ops-sync-portal-entrypoint";
import type { Env as ClientEnv } from "../../../client/src/worker/types";

/** Actual private producer ingestion, immutable source reservation and snapshot activation;
 * creates no verified identity, membership, access invitation or authenticated content grant. */
export async function createIndependentPrimaryClientProjection(client:D1Database,rootPublicId:string,options:{activate?:boolean;rootType?:"organization"|"standalone_client";workspaceVersion?:string;rootEntityVersion?:string}={}){
 const rootType=options.rootType??"standalone_client";
 const applicationKey="ltds",workspaceId=`independent-${crypto.randomUUID()}`,principalPublicId=crypto.randomUUID().replaceAll("-","");
 const env={DELIVERY_DB:client,CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_ORIGIN:"https://client.example.test",PROJECT_ALPHA_PORTAL_SYNC_ENABLED:"true",
  PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:"false",PROJECT_ALPHA_PORTAL_APPLICATION_KEY:applicationKey,
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:"true"} as ClientEnv;
 const common={schemaVersion:2,applicationKey,occurredAt:new Date().toISOString(),sourceGeneration:`generation-${crypto.randomUUID()}`,workspaceId};
 const ingest=async(payload:Record<string,unknown>)=>{
  const result=await ingestOpsSyncPortalProjection(env,{protocolVersion:1,sourceId:"project-alpha:primary",applicationKey,deliveryId:String(payload.deliveryId),projectionKind:"portal",body:JSON.stringify(payload)});
  if(!result.ok||result.status!=="completed")throw Error(`independent actual projection failed: ${JSON.stringify(result)}`);
  return result;
 };
 const entitlements=[{capability:"workspace.view",scopeType:"workspace",scopePublicId:workspaceId},...(rootType==="standalone_client"?[{capability:"directory.read",scopeType:"client",scopePublicId:rootPublicId}]:[])]
  .map((e,i)=>({publicId:`entitlement-${crypto.randomUUID()}`,principalPublicId,...e,effect:"allow",sourceVersion:`entitlement-v1-${i}`,active:true,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:null}));
 const snapshotHash="a".repeat(64),snapshot={snapshotHash,pageCount:1,recordCount:2+entitlements.length};
 await ingest({...common,...snapshot,sourceSequence:1,kind:"snapshot.page",deliveryId:`page-${crypto.randomUUID()}`,pageNumber:1,
  workspace:{publicId:workspaceId,rootType,rootPublicId,displayName:"Independent Client",sourceVersion:options.workspaceVersion??"root-v1",active:true},
  entities:[{type:rootType,publicId:rootPublicId,parentPublicId:null,displayName:"Independent Client",sourceVersion:options.rootEntityVersion??"root-v1",active:true,primaryContact:false}],
  principals:[{publicId:principalPublicId,emailHint:"independent-client@example.test",displayName:"Independent Client",sourceVersion:"principal-v1",active:true}],entitlements});
 if(options.activate!==false)await ingest({...common,...snapshot,sourceSequence:1,kind:"snapshot.activate",deliveryId:`activate-${crypto.randomUUID()}`});
 const reservation=await client.prepare("SELECT workspace_id,projection_source_id,source_workspace_id FROM pa_portal_workspace_sources WHERE workspace_id=?").bind(workspaceId).first();
 if(!reservation||reservation.projection_source_id!=="project-alpha:primary"||reservation.source_workspace_id!==workspaceId)throw Error("independent native primary reservation missing");
 return{workspaceId,principalPublicId,rootPublicId,env,common,ingest,entitlements};
}
