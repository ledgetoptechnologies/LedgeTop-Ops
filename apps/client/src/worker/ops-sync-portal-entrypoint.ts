import { WorkerEntrypoint } from "cloudflare:workers";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import type { Env } from "./types";
import { applyPortalProjectionDelivery, parsePortalProjectionDelivery } from "./project-alpha-portal";
import { getPortalSourceAuthority, readPortalSourceAuthorityProof } from "./project-alpha-portal-authority";
import { applyCatalogProjectionDelivery, parseCatalogProjectionDelivery } from "./project-alpha-catalog";
import { applyServiceAssignmentProjectionFromOpsSync, parseServiceAssignmentProjectionDelivery } from "./project-alpha-service-assignments";

const SAFE_DELIVERY_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_BODY_BYTES:Record<ProjectionKind,number>={portal:256*1024,catalog:128*1024,service_assignments:256*1024};

type ProjectionKind="portal"|"catalog"|"service_assignments";
type Input={protocolVersion:1;sourceId:string;applicationKey:string;deliveryId:string;projectionKind:ProjectionKind;body:string};
type Result={ok:true;protocolVersion:1;status:"completed"|"ignored"|"duplicate"}
  |{ok:false;protocolVersion:1;code:string;retryable:boolean};

async function sha256(value:string):Promise<string>{
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
    .map(byte=>byte.toString(16).padStart(2,"0")).join("");
}

/** Private, route-less RPC boundary. Ops Sync already authenticated the PA
 * producer; this entrypoint retains Client's feature, source and schema gates. */
export async function ingestOpsSyncPortalProjection(env:Env,input:Input):Promise<Result>{
  if(!input||input.protocolVersion!==1||typeof input.body!=="string"
    ||!Object.hasOwn(MAX_BODY_BYTES,input.projectionKind)
    ||new TextEncoder().encode(input.body).byteLength>MAX_BODY_BYTES[input.projectionKind]
    ||!SAFE_DELIVERY_ID.test(input.deliveryId))return{ok:false,protocolVersion:1,code:"invalid",retryable:false};
  const enabled=input?.projectionKind==="portal"?env.PROJECT_ALPHA_PORTAL_SYNC_ENABLED==="true"
    :input?.projectionKind==="catalog"?env.PROJECT_ALPHA_CATALOG_SYNC_ENABLED==="true"
      :input?.projectionKind==="service_assignments"?env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED==="true":false;
  if(!enabled)return{ok:false,protocolVersion:1,code:"disabled",retryable:true};
  try{
    const source=createCatalogSourceContext(input.sourceId);
    let proof;
    if(source.sourceId===PRIMARY_ALPHA_SOURCE_ID){
      if(!env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY||input.applicationKey!==env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY)
        return{ok:false,protocolVersion:1,code:"source-mismatch",retryable:false};
    }else{
      const db=env.DELIVERY_DB.withSession("first-primary");
      const authority=await getPortalSourceAuthority(db,source.sourceId);
      if(!authority||authority.state!=="active")return{ok:false,protocolVersion:1,code:"source-unavailable",retryable:true};
      if(authority.applicationKey!==input.applicationKey)return{ok:false,protocolVersion:1,code:"source-mismatch",retryable:false};
      proof=await readPortalSourceAuthorityProof(db,source.sourceId);
      if(!proof)return{ok:false,protocolVersion:1,code:"source-unavailable",retryable:true};
    }
    let parsed:unknown;
    try{parsed=JSON.parse(input.body);}catch{return{ok:false,protocolVersion:1,code:"invalid",retryable:false};}
    const bodyHash=await sha256(input.body);
    let status:"completed"|"ignored"|"duplicate";
    if(input.projectionKind==="portal"){
      const delivery=parsePortalProjectionDelivery(parsed,input.applicationKey,env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==="true");
      if(delivery.deliveryId!==input.deliveryId)return{ok:false,protocolVersion:1,code:"delivery-mismatch",retryable:false};
      status=await applyPortalProjectionDelivery(env,delivery,bodyHash,source,proof);
    }else if(input.projectionKind==="catalog"){
      const delivery=parseCatalogProjectionDelivery(parsed,input.applicationKey);
      if(delivery.deliveryId!==input.deliveryId)return{ok:false,protocolVersion:1,code:"delivery-mismatch",retryable:false};
      status=await applyCatalogProjectionDelivery(env,source,delivery,bodyHash,proof);
    }else{
      const delivery=parseServiceAssignmentProjectionDelivery(parsed,input.applicationKey);
      if(delivery.deliveryId!==input.deliveryId)return{ok:false,protocolVersion:1,code:"delivery-mismatch",retryable:false};
      status=await applyServiceAssignmentProjectionFromOpsSync(env,source,proof??null,delivery,bodyHash);
    }
    return{ok:true,protocolVersion:1,status};
  }catch(error){
    const message=error instanceof Error?error.message:"";
    const retryable=/busy|unavailable|internal|database|changed/.test(message);
    return{ok:false,protocolVersion:1,code:retryable?"temporarily-unavailable":"rejected",retryable};
  }
}

export class OpsSyncPortalProjectionIngress extends WorkerEntrypoint<Env>{
  ingestProjectAlphaPortalProjection(input:Input):Promise<Result>{return ingestOpsSyncPortalProjection(this.env,input);}
}
