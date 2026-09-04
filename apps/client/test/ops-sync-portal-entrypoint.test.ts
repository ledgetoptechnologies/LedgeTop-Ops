import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
vi.mock("../src/worker/project-alpha-portal",()=>({
  parsePortalProjectionDelivery:vi.fn((value)=>value),
  applyPortalProjectionDelivery:vi.fn(async()=>"completed"),
}));
vi.mock("../src/worker/project-alpha-catalog",()=>({
  parseCatalogProjectionDelivery:vi.fn((value)=>value),
  applyCatalogProjectionDelivery:vi.fn(async()=>"completed"),
}));
vi.mock("../src/worker/project-alpha-service-assignments",()=>({
  parseServiceAssignmentProjectionDelivery:vi.fn((value)=>value),
  applyServiceAssignmentProjectionFromOpsSync:vi.fn(async()=>"completed"),
}));
vi.mock("../src/worker/project-alpha-portal-authority",()=>({
  getPortalSourceAuthority:vi.fn(),readPortalSourceAuthorityProof:vi.fn(),
}));

import {PRIMARY_ALPHA_SOURCE_ID} from "@ltds/shared";
import {ingestOpsSyncPortalProjection} from "../src/worker/ops-sync-portal-entrypoint";
import {applyCatalogProjectionDelivery} from "../src/worker/project-alpha-catalog";
import {getPortalSourceAuthority,readPortalSourceAuthorityProof} from "../src/worker/project-alpha-portal-authority";
import type {Env} from "../src/worker/types";

const applicationKey="ltds_ops";
const env={PROJECT_ALPHA_PORTAL_SYNC_ENABLED:"true",PROJECT_ALPHA_CATALOG_SYNC_ENABLED:"true",
  PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED:"true",PROJECT_ALPHA_PORTAL_APPLICATION_KEY:applicationKey,
  CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:"true"} as Env;

describe("private Ops Sync projection ingress",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it.each(["portal","catalog","service_assignments"] as const)("dispatches the exact %s contract behind its own feature gate",async(projectionKind)=>{
    const deliveryId=`delivery-${projectionKind.replace("_","-")}`;
    await expect(ingestOpsSyncPortalProjection(env,{protocolVersion:1,sourceId:PRIMARY_ALPHA_SOURCE_ID,
      applicationKey,deliveryId,projectionKind,body:JSON.stringify({deliveryId})}))
      .resolves.toEqual({ok:true,protocolVersion:1,status:"completed"});
  });
  it("fails closed without the exact per-contract gate and rejects cross-application routing",async()=>{
    const input={protocolVersion:1 as const,sourceId:PRIMARY_ALPHA_SOURCE_ID,applicationKey,
      deliveryId:"delivery-one",projectionKind:"catalog" as const,body:'{"deliveryId":"delivery-one"}'};
    await expect(ingestOpsSyncPortalProjection({...env,PROJECT_ALPHA_CATALOG_SYNC_ENABLED:"false"},input))
      .resolves.toEqual({ok:false,protocolVersion:1,code:"disabled",retryable:true});
    await expect(ingestOpsSyncPortalProjection(env,{...input,applicationKey:"another_app"}))
      .resolves.toEqual({ok:false,protocolVersion:1,code:"source-mismatch",retryable:false});
  });
  it("passes a current Client authority proof into secondary catalog writes",async()=>{
    const sourceId="project-alpha:secondary",deliveryId="delivery-secondary",proof={sourceId,version:4};
    vi.mocked(getPortalSourceAuthority).mockResolvedValue({state:"active",applicationKey} as never);
    vi.mocked(readPortalSourceAuthorityProof).mockResolvedValue(proof as never);
    const secondaryEnv={...env,DELIVERY_DB:{withSession:()=>({})}} as unknown as Env;
    await expect(ingestOpsSyncPortalProjection(secondaryEnv,{protocolVersion:1,sourceId,applicationKey,deliveryId,
      projectionKind:"catalog",body:JSON.stringify({deliveryId})}))
      .resolves.toEqual({ok:true,protocolVersion:1,status:"completed"});
    expect(applyCatalogProjectionDelivery).toHaveBeenCalledWith(secondaryEnv,expect.objectContaining({sourceId}),
      {deliveryId},expect.stringMatching(/^[a-f0-9]{64}$/),proof);
  });
});
