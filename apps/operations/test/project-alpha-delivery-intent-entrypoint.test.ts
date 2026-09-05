import { beforeEach,describe,expect,it,vi } from "vitest";
import { HTTPException } from "hono/http-exception";

vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
const mocks=vi.hoisted(()=>({
  resolve:vi.fn(),preflight:vi.fn(),provision:vi.fn(),revoke:vi.fn(),
}));
vi.mock("../src/worker/project-alpha-delivery-intents",()=>({
  resolveProjectAlphaDeliverySourceProof:mocks.resolve,
  applyProjectAlphaDeliveryPreflight:mocks.preflight,
  applyProjectAlphaDeliveryIntent:mocks.provision,
  applyProjectAlphaDeliveryIntentRevoke:mocks.revoke,
}));
import { processProjectAlphaDeliveryIntentIngress } from "../src/worker/project-alpha-delivery-intent-entrypoint";
import type { Env } from "../src/worker/types";

const env={} as Env,source={sourceId:"project-alpha:primary",staffAuthority:true},proof={sourceId:source.sourceId,
  revision:2,version:3,connectorRevision:4,connectorVersion:5};
function input(kind:"preflight"|"provision"|"revoke"="provision"){
  const deliveryId=`delivery-${kind}`,occurredAt="2026-09-04T12:00:00.000Z";
  const common={schemaVersion:1,applicationKey:"ltds_ops",deliveryId,occurredAt};
  const body=kind==="preflight"?common:kind==="revoke"?{...common,receiptId:"receipt-one",reasonCode:"project_alpha_delivery_revoked"}:
    {...common,scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
      accessMode:"portal",expiresAt:null,label:null,notify:true};
  return{protocolVersion:1,sourceId:source.sourceId,applicationKey:"ltds_ops",deliveryId,intentKind:kind,
    body:JSON.stringify(body),connectorProof:{revision:4,version:5}};
}

describe("Project Alpha delivery intent private entrypoint",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();mocks.resolve.mockResolvedValue({source,proof});
    mocks.preflight.mockResolvedValue({status:"ready",schemaVersion:1});
    mocks.provision.mockResolvedValue({receiptId:"receipt-one",status:"accepted"});
    mocks.revoke.mockResolvedValue({receiptId:"revoke-one",status:"accepted"});
  });
  it.each(["preflight","provision","revoke"] as const)("routes a strict %s intent under the revalidated source",async kind=>{
    const value=input(kind),result=await processProjectAlphaDeliveryIntentIngress(env,value);
    expect(result.ok).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith(env,source.sourceId,"ltds_ops",{revision:4,version:5});
    const selected=kind==="preflight"?mocks.preflight:kind==="revoke"?mocks.revoke:mocks.provision;
    expect(selected).toHaveBeenCalledWith(env,JSON.parse(value.body),expect.objectContaining({deliveryId:value.deliveryId,
      fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)}),source,"ltds_ops",proof);
  });
  it("rejects malformed RPC envelopes before authority resolution",async()=>{
    for(const value of [{...input(),extra:true},{...input(),sourceId:""},{...input(),body:"{"}]){
      expect(await processProjectAlphaDeliveryIntentIngress(env,value)).toMatchObject({ok:false,retryable:false});
    }
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("returns a non-retryable authority conflict without invoking a delivery mutation",async()=>{
    mocks.resolve.mockRejectedValue(new HTTPException(409,{message:"Project Alpha delivery authority changed"}));
    expect(await processProjectAlphaDeliveryIntentIngress(env,input())).toEqual({ok:false,protocolVersion:1,
      code:"authority_or_state_conflict",retryable:false});
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});
