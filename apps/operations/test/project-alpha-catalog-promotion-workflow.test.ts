import {describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{}}));
import {runProjectAlphaCatalogPromotionWorkflow,type ProjectAlphaCatalogPromotionWorkflowStep} from "../src/worker/project-alpha-catalog-promotion-workflow";
import type {OpsCatalogPromotionBinding,OpsCatalogStagingBinding,ProjectAlphaCatalogStagingEnvironment} from "../src/worker/project-alpha-catalog-staging-coordinator";

const sourceId="project-alpha:primary",sourceInstanceId="11111111-1111-4111-8111-111111111111";
const applicationId="22222222-2222-4222-8222-222222222222",historyEpoch="33333333-3333-4333-8333-333333333333";
const snapshotId="a".repeat(64),approvalId="CHG-2026-0917";
const stageCommand={protocolVersion:1 as const,action:"stage" as const,registryId:17,sourceId,approvalId};
const promoteCommand={protocolVersion:1 as const,action:"promote" as const,registryId:17,sourceId,
  expectedSnapshotId:snapshotId,expectedSourceSequence:8,approvalId};
function harness(overrides:Partial<ProjectAlphaCatalogStagingEnvironment>={}){
  const stage=vi.fn<OpsCatalogStagingBinding["stageCatalogInventoryPage"]>(async()=>({ok:true,protocolVersion:1,status:"staged",receiptHash:"b".repeat(64)}));
  const promote=vi.fn<OpsCatalogPromotionBinding["promoteCatalogInventorySnapshot"]>(async()=>({ok:true,protocolVersion:1,status:"promoted",
    generationId:`ops-inventory:17:${snapshotId}`,sourceSequence:9}));
  const env={PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED:"false",PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"false",
    PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:"https://alpha.example.test/",
      apiKey:"secret-never-returned",sourceInstanceId,applicationId,historyEpoch}}}),OPS_INVENTORY_CATALOG_STAGING:{stageCatalogInventoryPage:stage},
    OPS_INVENTORY_CATALOG_PROMOTION:{promoteCatalogInventorySnapshot:promote},...overrides} satisfies ProjectAlphaCatalogStagingEnvironment;
  const callbackResult={status:"complete",snapshotId,totalCount:1,pageCount:1,stagedCount:1,duplicateCount:0,
    promotion:{status:"promoted",generationId:`ops-inventory:17:${snapshotId}`,sourceSequence:9}} as const;
  const run=vi.fn(async()=>callbackResult);
  const doStep=vi.fn(async(_name:string,_config:unknown,callback:()=>Promise<unknown>)=>callback());
  return{env,stage,promote,run,doStep,step:{do:doStep} as unknown as ProjectAlphaCatalogPromotionWorkflowStep};
}

describe("manual Project Alpha catalog promotion Workflow",()=>{
  it("rejects malformed or extra-key payloads before creating a durable step",async()=>{
    const {env,step,doStep,run}=harness();
    await expect(runProjectAlphaCatalogPromotionWorkflow(env,{...stageCommand,requestedBy:"untrusted"},step))
      .resolves.toEqual({status:"rejected",reason:"invalid_command"});
    await expect(runProjectAlphaCatalogPromotionWorkflow(env,{...promoteCommand,expectedSourceSequence:-1},step))
      .resolves.toEqual({status:"rejected",reason:"invalid_command"});
    await expect(runProjectAlphaCatalogPromotionWorkflow(env,{...promoteCommand,expectedSnapshotId:"bad"},step))
      .resolves.toEqual({status:"rejected",reason:"invalid_command"});
    expect(doStep).not.toHaveBeenCalled();
  });

  it("uses one explicitly non-retrying step and returns only correlation plus bounded outcome",async()=>{
    const {env,step,doStep,run}=harness();
    const result=await runProjectAlphaCatalogPromotionWorkflow(env,promoteCommand,step,{stageAndPromote:run});
    expect(doStep).toHaveBeenCalledOnce();
    expect(doStep.mock.calls[0]?.slice(0,2)).toEqual(["promote-project-alpha-catalog",
      {retries:{limit:0,delay:"1 second",backoff:"constant"},timeout:"10 minutes"}]);
    expect(result).toMatchObject({status:"completed",approvalId,outcome:{status:"complete"}});
    expect(run).toHaveBeenCalledWith(env,{registryId:17,sourceId,expectedSnapshotId:snapshotId,expectedSourceSequence:8});
    expect(JSON.stringify(result)).not.toContain("secret-never-returned");
  });

  it("is a no-op while default-off and does not substitute operator authority",async()=>{
    const {env,step,stage,promote}=harness();
    await expect(runProjectAlphaCatalogPromotionWorkflow(env,stageCommand,step))
      .resolves.toEqual({status:"completed",approvalId,outcome:{status:"disabled"}});
    expect(stage).not.toHaveBeenCalled();expect(promote).not.toHaveBeenCalled();
  });

  it("forces the stage action to suppress promotion even when the deployment flag is enabled",async()=>{
    const {env,step,run}=harness({PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"true"});
    await runProjectAlphaCatalogPromotionWorkflow(env,stageCommand,step,{stageAndPromote:run});
    expect(run).toHaveBeenCalledWith(expect.objectContaining({PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"false"}),
      {registryId:17,sourceId});
  });
});
