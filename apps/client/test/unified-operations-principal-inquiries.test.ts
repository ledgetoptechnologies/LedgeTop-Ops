import { describe, expect, it, vi } from "vitest";
import { createUnifiedRequestRouter } from "../src/worker/client-portal/unified-request-routes";
import type { Env } from "../src/worker/types";
import type { NativeOperationsRequestCapability } from "../src/worker/client-portal/operations-native-request-capability-read";

const origin="https://client.example";
const env={CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_ORIGIN:origin,
 CLIENT_PORTAL_OPS_INQUIRIES_ENABLED:"true",CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED:"true",CLIENT_PORTAL_REQUEST_V2_ENABLED:"false"} as Env;
const cap={targetId:"10000000-0000-4000-8000-000000000001",targetRevision:1,clientAuthorityId:"10000000-0000-4000-8000-000000000002",
 workspaceId:"ops-workspace",targetClientRecordId:"client-record",recipientBindingId:"10000000-0000-4000-8000-000000000003",issuer:"issuer",subject:"subject",
 baseOperationId:"10000000-0000-4000-8000-000000000004",ownershipEpoch:1,grantRevision:1,
 capabilityOperationId:"10000000-0000-4000-8000-000000000005",capabilityRevision:1,
 publicationOperationId:"10000000-0000-4000-8000-000000000006",publicationRevision:1,publicationSourceSequence:1,
 publicationSnapshotId:"10000000-0000-4000-8000-000000000007",publicationSnapshotSha256:"a".repeat(64),expiresAt:"2026-10-31T00:00:00.000Z"} as NativeOperationsRequestCapability;
const secondCap={...cap,targetId:"20000000-0000-4000-8000-000000000001",clientAuthorityId:"20000000-0000-4000-8000-000000000002",
 recipientBindingId:"20000000-0000-4000-8000-000000000003",baseOperationId:"20000000-0000-4000-8000-000000000004",
 capabilityOperationId:"20000000-0000-4000-8000-000000000005",publicationOperationId:"20000000-0000-4000-8000-000000000006",
 publicationSnapshotId:"20000000-0000-4000-8000-000000000007"} as NativeOperationsRequestCapability;
const inquiry={id:"10000000-0000-4000-8000-000000000008",kind:"website" as const,title:"Site help",details:"Please contact me.",location:null,
 status:"received" as const,createdAt:"2026-10-30T00:00:00.000Z"};
function fixture(resolve=vi.fn(async()=>[cap])){
 const listOperationsInquiries=vi.fn(async()=>[inquiry]);
 const submitOperationsInquiry=vi.fn(async(_binding:any,_principal:any,_proof:any,input:any)=>({kind:"created" as const,inquiry:{...inquiry,kind:input.kind,title:input.title,details:input.details,location:input.location}}));
 const router=createUnifiedRequestRouter({resolvePrincipal:async()=>({issuer:"issuer",subject:"subject",email:"owner@example.test"}),
  checkConfiguration:false,discover:async()=>[],scopedFetch:async()=>new Response("unexpected",{status:500}),resolveInquiryAuthority:async()=>null,
  inquirySchemaReady:async()=>true,resolveOperationsCapability:resolve,listOperationsInquiries,submitOperationsInquiry});
 const request=(path:string,init:RequestInit={})=>router.request(origin+path,init,env);
 return {request,resolve,listOperationsInquiries,submitOperationsInquiry};
}
describe("Ops-owned principal inquiry routing",()=>{
 it("exposes the existing aggregated inquiry contract for one fresh Ops capability",async()=>{
  const f=fixture(),response=await f.request("/request-services");
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({services:[],inquiryKinds:["website","drone","other"]});
  expect(f.submitOperationsInquiry).not.toHaveBeenCalled();
 });
 it("submits through the private Operations path with only the authenticated principal and exact capability",async()=>{
  const f=fixture();const response=await f.request("/inquiries",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":"ops-inquiry-idempotency-1"},
   body:JSON.stringify({kind:"website",title:"Site help",details:"Please contact me."})});
  expect(response.status).toBe(201);expect(await response.json()).toMatchObject({inquiry:{kind:"website",status:"received"}});
  expect(f.resolve).toHaveBeenCalledTimes(2);
  expect(f.submitOperationsInquiry).toHaveBeenCalledWith(undefined,{issuer:"issuer",subject:"subject",email:"owner@example.test"},[cap],
   {kind:"website",title:"Site help",details:"Please contact me.",location:null,idempotencyKey:"ops-inquiry-idempotency-1"});
 });
 it("lists Ops history after a second current authority read",async()=>{
  const f=fixture(),response=await f.request("/inquiries");
  expect(response.status).toBe(200);expect(await response.json()).toEqual({inquiries:[inquiry]});
  expect(f.listOperationsInquiries).toHaveBeenCalledTimes(1);
 });
 it("denies write when exact capability disappears between eligibility and mutation",async()=>{
  const resolve=vi.fn().mockResolvedValueOnce([cap]).mockResolvedValueOnce([]),f=fixture(resolve);
  const response=await f.request("/inquiries",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":"ops-inquiry-idempotency-1"},
   body:JSON.stringify({kind:"website",details:"Please contact me."})});
  expect(response.status).toBe(409);expect(f.submitOperationsInquiry).not.toHaveBeenCalled();
 });
 it("routes one inquiry across multiple eligible Ops companies without adding a selector",async()=>{
  const resolve=vi.fn(async()=>[secondCap,cap]),f=fixture(resolve);
  const options=await f.request("/request-services");
  expect(await options.json()).toMatchObject({inquiryKinds:["website","drone","other"]});
  const response=await f.request("/inquiries",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":"ops-inquiry-idempotency-2"},
   body:JSON.stringify({kind:"other",details:"Support across my linked businesses."})});
  expect(response.status).toBe(201);expect(f.submitOperationsInquiry).toHaveBeenCalledWith(undefined,
   {issuer:"issuer",subject:"subject",email:"owner@example.test"},[secondCap,cap],expect.objectContaining({kind:"other"}));
 });
});
