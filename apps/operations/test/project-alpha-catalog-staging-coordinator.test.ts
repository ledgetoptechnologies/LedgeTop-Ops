import {describe,expect,it,vi} from "vitest";
import {stageConfiguredProjectAlphaCatalogSnapshot,type OpsCatalogPromotionBinding,type OpsCatalogStagingBinding,type OpsCatalogStagingPage,type ProjectAlphaCatalogStagingEnvironment} from "../src/worker/project-alpha-catalog-staging-coordinator";

const sourceId="project-alpha:primary",sourceInstanceId="11111111-1111-4111-8111-111111111111";
const applicationId="22222222-2222-4222-8222-222222222222",historyEpoch="33333333-3333-4333-8333-333333333333";
const connection={sourceId,enabled:true,baseUrl:"https://alpha.example.test/",apiKey:"never-forward-this-secret",
  sourceInstanceId,applicationId,historyEpoch};
const connections=JSON.stringify({version:1,instances:{[sourceId]:connection}});
const item=(index:number)=>({publicId:index.toString(16).padStart(32,"0"),sourceVersion:`sha256-${index.toString(16).padStart(64,"0")}`,
  name:`Service ${index}`,summary:null,category:"Survey",displayOrder:index,geometryRequirement:"optional" as const,questions:[]});
const complete=(count:number)=>({status:"complete" as const,snapshotId:"a".repeat(64),totalCount:count,
  items:Array.from({length:count},(_,index)=>item(index+1)),pageCount:1,attemptCount:1});
function harness(enabled="true"){
  const pages:OpsCatalogStagingPage[]=[];
  const stage=vi.fn<OpsCatalogStagingBinding["stageCatalogInventoryPage"]>(async(page)=>{pages.push(page);return{ok:true,protocolVersion:1,status:"staged",receiptHash:"b".repeat(64)};});
  const binding:OpsCatalogStagingBinding={stageCatalogInventoryPage:stage};
  const promote=vi.fn<OpsCatalogPromotionBinding["promoteCatalogInventorySnapshot"]>(async authority=>({ok:true,protocolVersion:1,
    status:"promoted",generationId:`ops-inventory:${authority.registryId}:${authority.snapshotId}`,sourceSequence:authority.expectedSourceSequence+1}));
  const env={PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED:enabled,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"false",
    PROJECT_ALPHA_API_V2_CONNECTIONS:connections,OPS_INVENTORY_CATALOG_STAGING:binding,
    OPS_INVENTORY_CATALOG_PROMOTION:{promoteCatalogInventorySnapshot:promote}} satisfies ProjectAlphaCatalogStagingEnvironment;
  return{env,pages,binding,stage,promote};
}

describe("route-less catalog staging coordinator",()=>{
  it("is default-off before reading a connection or calling Client",async()=>{
    const {env,binding}=harness("false"),readSnapshot=vi.fn();
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot})).resolves.toEqual({status:"disabled"});
    expect(readSnapshot).not.toHaveBeenCalled();expect(binding.stageCatalogInventoryPage).not.toHaveBeenCalled();
  });

  it("reads one immutable snapshot and stages bounded pages without forwarding credentials",async()=>{
    const {env,pages}=harness();const readSnapshot=vi.fn(async()=>complete(201));
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot}))
      .resolves.toMatchObject({status:"complete",totalCount:201,pageCount:5,stagedCount:5,duplicateCount:0});
    expect(pages.map(value=>value.items.length)).toEqual([50,50,50,50,1]);
    expect(pages.map(value=>value.nextCursor)).toEqual(["page_1","page_2","page_3","page_4",null]);
    expect(pages.every(value=>JSON.stringify(value).includes("never-forward-this-secret")===false)).toBe(true);
    expect(pages[0]).toMatchObject({sourceId,sourceInstanceId,applicationId,historyEpoch,pageIndex:0});
  });

  it("rechunks large source pages below the Client RPC byte ceiling",async()=>{
    const {env,pages}=harness();
    const largeItems=Array.from({length:20},(_,index)=>({...item(index+1),summary:"s".repeat(1000),questions:Array.from({length:10},(_,question)=>({
      id:`q_${question}`,label:"Q".repeat(200),type:"select" as const,required:true,helpText:"H".repeat(500),
      options:Array.from({length:50},(_,option)=>({value:`v_${option}`,label:"L".repeat(200)})),
    }))}));
    const snapshot={...complete(20),items:largeItems};
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>snapshot}))
      .resolves.toMatchObject({status:"complete",totalCount:20});
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=1024*1024-64*1024)).toBe(true);
    expect(pages.flatMap(value=>value.items.map(entry=>entry.publicId))).toEqual(largeItems.map(value=>value.publicId));
  });

  it("rejects a snapshot above the canonical catalog limit before staging any page",async()=>{
    const {env,stage}=harness();
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>complete(501)}))
      .resolves.toEqual({status:"blocked",reason:"catalog_limit"});
    expect(stage).not.toHaveBeenCalled();
  });

  it("blocks PA-valid names beyond the Client canonical limit before staging",async()=>{
    const {env,stage}=harness(),snapshot={...complete(1),items:[{...item(1),name:"N".repeat(161)}]};
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>snapshot}))
      .resolves.toEqual({status:"blocked",reason:"catalog_contract"});
    expect(stage).not.toHaveBeenCalled();
  });

  it("stops on the first failed receipt and reports only bounded diagnostics",async()=>{
    const {env,stage}=harness();stage.mockResolvedValueOnce({ok:false,protocolVersion:1,code:"source-unavailable",retryable:false});
    const result=await stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>complete(1)});
    expect(result).toEqual({status:"blocked",reason:"staging",stageCode:"source-unavailable",retryable:false});
    expect(JSON.stringify(result)).not.toContain("never-forward-this-secret");
  });

  it("maps service-binding transport exceptions to bounded retryable staging failures",async()=>{
    const {env,stage}=harness();stage.mockRejectedValueOnce(new Error("secret-bearing provider detail"));
    const result=await stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>complete(1)});
    expect(result).toEqual({status:"blocked",reason:"staging",stageCode:"temporarily-unavailable",retryable:true});
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  it("emits byte-identical pages for idempotent retries of one snapshot",async()=>{
    const first=harness(),second=harness();
    second.stage.mockImplementation(async page=>{second.pages.push(page);return{ok:true,protocolVersion:1,status:"duplicate",receiptHash:"b".repeat(64)};});
    const readSnapshot=async()=>complete(201);
    await stageConfiguredProjectAlphaCatalogSnapshot(first.env,{registryId:1,sourceId},{readSnapshot});
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(second.env,{registryId:1,sourceId},{readSnapshot}))
      .resolves.toMatchObject({status:"complete",stagedCount:0,duplicateCount:5});
    expect(second.pages).toEqual(first.pages);
    expect(first.pages.every(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId))).toBe(true);
  });

  it("fails closed for disabled sources, malformed commands, and unavailable bindings",async()=>{
    const {env}=harness();
    await expect(stageConfiguredProjectAlphaCatalogSnapshot({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{...connection,enabled:false}}})},{registryId:1,sourceId}))
      .resolves.toEqual({status:"blocked",reason:"source_disabled"});
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId:"bad source"})).resolves.toEqual({status:"rejected",reason:"invalid_command"});
    await expect(stageConfiguredProjectAlphaCatalogSnapshot({...env,OPS_INVENTORY_CATALOG_STAGING:undefined},{registryId:1,sourceId}))
      .resolves.toEqual({status:"blocked",reason:"configuration"});
  });

  it("promotes only after staging with exact operator registry/source/checkpoint authority",async()=>{
    const {env,promote,pages}=harness();
    const result=await stageConfiguredProjectAlphaCatalogSnapshot({...env,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"true"},
      {registryId:17,sourceId,expectedSnapshotId:"a".repeat(64),expectedSourceSequence:8},{readSnapshot:async()=>complete(1)});
    expect(result).toMatchObject({status:"complete",promotion:{status:"promoted",sourceSequence:9}});
    expect(pages[0]).toMatchObject({registryId:17,sourceId});
    expect(promote).toHaveBeenCalledOnce();
    expect(promote).toHaveBeenCalledWith({registryId:17,sourceId,sourceInstanceId,applicationId,historyEpoch,
      snapshotId:"a".repeat(64),expectedSourceSequence:8});
  });

  it("is a promotion no-op while the independent promotion flag is off",async()=>{
    const {env,promote}=harness();
    const result=await stageConfiguredProjectAlphaCatalogSnapshot(env,{registryId:1,sourceId},{readSnapshot:async()=>complete(1)});
    expect(result).toMatchObject({status:"complete"});
    expect(result).not.toHaveProperty("promotion");
    expect(promote).not.toHaveBeenCalled();
  });

  it("fails closed on missing authority, denial, and transport failure without substituting checkpoint authority",async()=>{
    const {env,promote}=harness(),enabled={...env,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"true"};
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(enabled,{registryId:1,sourceId},{readSnapshot:async()=>complete(1)}))
      .resolves.toEqual({status:"rejected",reason:"invalid_command"});
    promote.mockResolvedValueOnce({ok:false,protocolVersion:1,code:"stale",retryable:false});
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(enabled,{registryId:1,sourceId,expectedSnapshotId:"a".repeat(64),expectedSourceSequence:3},{readSnapshot:async()=>complete(1)}))
      .resolves.toEqual({status:"blocked",reason:"promotion",promotionCode:"stale",retryable:false});
    expect(promote).toHaveBeenLastCalledWith(expect.objectContaining({registryId:1,sourceId,expectedSourceSequence:3}));
    promote.mockRejectedValueOnce(new Error("database detail"));
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(enabled,{registryId:1,sourceId,expectedSnapshotId:"a".repeat(64),expectedSourceSequence:3},{readSnapshot:async()=>complete(1)}))
      .resolves.toEqual({status:"blocked",reason:"promotion",promotionCode:"temporarily-unavailable",retryable:true});
  });

  it("accepts concurrent exact replays only as promoted plus duplicate outcomes",async()=>{
    const first=harness(),enabled={...first.env,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"true"};let winner=false;
    first.promote.mockImplementation(async authority=>{const status=winner?"duplicate":"promoted" as const;winner=true;
      return{ok:true,protocolVersion:1,status,generationId:`ops-inventory:${authority.registryId}:${authority.snapshotId}`,sourceSequence:1};});
    const results=await Promise.all([0,1].map(()=>stageConfiguredProjectAlphaCatalogSnapshot(enabled,
      {registryId:1,sourceId,expectedSnapshotId:"a".repeat(64),expectedSourceSequence:0},{readSnapshot:async()=>complete(1)})));
    expect(results.map(result=>result.status==="complete"?result.promotion?.status:null).sort()).toEqual(["duplicate","promoted"]);
    expect(first.promote).toHaveBeenCalledTimes(2);
  });

  it("blocks a changed source snapshot before every staging and promotion RPC",async()=>{
    const {env,stage,promote}=harness(),enabled={...env,PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED:"true"};
    await expect(stageConfiguredProjectAlphaCatalogSnapshot(enabled,
      {registryId:1,sourceId,expectedSnapshotId:"f".repeat(64),expectedSourceSequence:0},{readSnapshot:async()=>complete(1)}))
      .resolves.toEqual({status:"blocked",reason:"snapshot_mismatch"});
    expect(stage).not.toHaveBeenCalled();expect(promote).not.toHaveBeenCalled();
  });
});
