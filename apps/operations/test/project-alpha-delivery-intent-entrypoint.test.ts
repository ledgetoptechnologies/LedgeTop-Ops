import { beforeEach,describe,expect,it,vi } from "vitest";
import { HTTPException } from "hono/http-exception";

vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
const mocks=vi.hoisted(()=>({resolve:vi.fn(),budget:vi.fn(),preflight:vi.fn(),provision:vi.fn(),revoke:vi.fn()}));
vi.mock("../src/worker/project-alpha-delivery-intents",()=>({
  resolveProjectAlphaDeliverySourceProof:mocks.resolve,
  applyProjectAlphaDeliveryRpcBudget:mocks.budget,
  applyProjectAlphaDeliveryPreflight:mocks.preflight,
  applyProjectAlphaDeliveryIntent:mocks.provision,
  applyProjectAlphaDeliveryIntentRevoke:mocks.revoke,
}));
import { processProjectAlphaDeliveryIntentIngress } from "../src/worker/project-alpha-delivery-intent-entrypoint";
import type { Env } from "../src/worker/types";

const env={PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"true"} as Env;
const source={sourceId:"project-alpha:primary",staffAuthority:true};
function input(kind:"preflight"|"provision"|"revoke"="provision"){
  const deliveryId=`delivery-${kind}`,occurredAt="2026-09-04T12:00:00.000Z";
  const common={schemaVersion:1,applicationKey:"ltds_ops",deliveryId,occurredAt};
  const body=kind==="preflight"?common:kind==="revoke"?{...common,receiptId:"receipt-one",reasonCode:"project_alpha_delivery_revoked"}:
    {...common,scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},accessMode:"portal",expiresAt:null,label:null,notify:true};
  return{protocolVersion:1,sourceId:source.sourceId,applicationKey:"ltds_ops",deliveryId,intentKind:kind,body:JSON.stringify(body),connectorProof:{revision:0,version:0}};
}

describe("Project Alpha delivery intent private entrypoint",()=>{
  beforeEach(()=>{
    vi.clearAllMocks(); env.PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED="true";
    mocks.resolve.mockResolvedValue({source}); mocks.preflight.mockResolvedValue({status:"ready",schemaVersion:1});
    mocks.provision.mockResolvedValue({receiptId:"receipt-one",status:"accepted"}); mocks.revoke.mockResolvedValue({receiptId:"revoke-one",status:"accepted"});
  });
  it.each(["preflight","provision","revoke"] as const)("routes a strict %s intent only after source revalidation",async kind=>{
    const value=input(kind),result=await processProjectAlphaDeliveryIntentIngress(env,value);
    expect(result.ok).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith(env,source.sourceId,"ltds_ops",{revision:0,version:0});
    expect(mocks.budget).toHaveBeenCalledWith(env,source,kind);
    const selected=kind==="preflight"?mocks.preflight:kind==="revoke"?mocks.revoke:mocks.provision;
    expect(selected).toHaveBeenCalledWith(env,JSON.parse(value.body),expect.objectContaining({deliveryId:value.deliveryId,fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)}),source,"ltds_ops",undefined);
  });
  it("rejects malformed envelopes before authority resolution",async()=>{
    for(const value of [{...input(),extra:true},{...input(),sourceId:""},{...input(),body:"{"}])
      expect(await processProjectAlphaDeliveryIntentIngress(env,value)).toMatchObject({ok:false,retryable:false});
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("does not resolve or mutate disabled provision/revoke traffic",async()=>{
    const disabled={...env,PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"false"} as Env;
    for(const kind of ["provision","revoke"] as const)
      expect(await processProjectAlphaDeliveryIntentIngress(disabled,input(kind))).toEqual({ok:false,protocolVersion:1,code:"not_found_or_disabled",retryable:false});
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.provision).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("keeps disabled preflight read-only",async()=>{
    const disabled={...env,PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"false"} as Env;
    mocks.preflight.mockResolvedValue({status:"ready",schemaVersion:1,integrationEnabled:false});
    expect(await processProjectAlphaDeliveryIntentIngress(disabled,input("preflight"))).toMatchObject({ok:true,result:{integrationEnabled:false}});
    expect(mocks.provision).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("returns a retryable rate limit without a mutation",async()=>{
    mocks.budget.mockRejectedValue(new HTTPException(429,{message:"Too many Project Alpha delivery requests"}));
    expect(await processProjectAlphaDeliveryIntentIngress(env,input())).toEqual({ok:false,protocolVersion:1,code:"rate_limited",retryable:true});
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});
