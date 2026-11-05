import { describe, expect, it, vi } from "vitest";
import { createUnifiedRequestRouter } from "../src/worker/client-portal/unified-request-routes";
import type { Env } from "../src/worker/types";
import type { NativeOperationsRequestCapability } from "../src/worker/client-portal/operations-native-request-capability-read";
import type { NativeRequestAuthorityProof } from "../src/worker/client-portal/native-request-authority";
import type { PortalWorkspaceSummary } from "../src/worker/client-portal/workspace-v2";
import type { ClientPortalSession, VerifiedClientPrincipal } from "../src/worker/client-portal/types";

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
function makePaProof(workspaceId:string,sourceId:string,identityId:string):NativeRequestAuthorityProof{return{
 sourceId,workspaceId,identityId,rootType:"standalone_client",rootPublicId:`${workspaceId}-root`,projectPublicId:null,generationId:`${workspaceId}-generation`,
 sourceSequence:1,targetScopes:[`workspace:${workspaceId}`],allowedEntitlementIds:[`${workspaceId}-entitlement`],authority:{},denylistEnabled:false,
 rootAccessPolicyEnabled:false,evaluatedAt:"2026-10-30T00:00:00.000Z",expiresAt:"2026-10-30T00:00:30.000Z"} as NativeRequestAuthorityProof;}
function fixture(resolve=vi.fn(async()=>[cap]),paAuthority:(env:Env,session:ClientPortalSession)=>Promise<NativeRequestAuthorityProof|null>=async()=>null,
 paWorkspaces:PortalWorkspaceSummary[]=[],principal:VerifiedClientPrincipal={issuer:"issuer",subject:"subject",email:"owner@example.test"}){
 const listOperationsInquiries=vi.fn(async()=>[inquiry]);
 const submitOperationsInquiry=vi.fn(async(_binding:any,_principal:any,_proof:any,input:any)=>({kind:"created" as const,inquiry:{...inquiry,kind:input.kind,title:input.title,details:input.details,location:input.location}}));
 const listInquiries=vi.fn(async()=>[{...inquiry,id:"pa-inquiry"}]);
 const submitInquiry=vi.fn(async()=>({kind:"created" as const,inquiry:{...inquiry,id:"pa-inquiry"}}));
 const router=createUnifiedRequestRouter({resolvePrincipal:async()=>principal,
  checkConfiguration:false,discover:async()=>paWorkspaces,scopedFetch:async()=>new Response("unexpected",{status:500}),resolveInquiryAuthority:paAuthority,
  inquirySchemaReady:async()=>true,inquiryAuthoritySchemaReady:async()=>true,listInquiries,submitInquiry,
  resolveOperationsCapability:resolve,listOperationsInquiries,submitOperationsInquiry});
 const request=(path:string,init:RequestInit={})=>router.request(origin+path,init,env);
 return {request,resolve,listInquiries,submitInquiry,listOperationsInquiries,submitOperationsInquiry};
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
 it("does not switch a submission to Ops if PA becomes eligible before the write",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"},proof=makePaProof(paWorkspace.id,paWorkspace.sourceId,"pa-identity");
  const paAuthority=vi.fn(async()=>null as unknown as NativeRequestAuthorityProof|null).mockResolvedValueOnce(null).mockResolvedValueOnce(proof);
  const f=fixture(vi.fn(async()=>[cap]),paAuthority,[paWorkspace]);
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
 it("aggregates PA and Ops history for one principal while submitting exactly once through the established PA intake",async()=>{
  const paProof=makePaProof("pa-workspace","project-alpha:ltds","pa-identity");
  const paProofTwo=makePaProof("pa-workspace-two","project-alpha:ltt","pa-identity");
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"};
  const paWorkspaceTwo={id:"pa-workspace-two",sourceId:"project-alpha:ltt",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root-two",displayName:"LTT"};
  const opsInquiry={...inquiry,id:"ops-inquiry",title:"Ops home request",createdAt:"2026-10-30T00:03:00.000Z"};
  const paInquiryOne={...inquiry,id:"pa-inquiry-one",title:"LTDS request",createdAt:"2026-10-30T00:02:00.000Z"};
  const paInquiryTwo={...inquiry,id:"pa-inquiry-two",title:"LTT request",createdAt:"2026-10-30T00:01:00.000Z"};
  const f=fixture(vi.fn(async()=>[cap]),async(_env,session)=>session.workspaceId===paProof.workspaceId?paProof:paProofTwo,[paWorkspace,paWorkspaceTwo]);
  f.listOperationsInquiries.mockResolvedValue([opsInquiry]);
  f.listInquiries.mockResolvedValueOnce([paInquiryOne,paInquiryTwo]);
  const discovery=await f.request("/request-services");
  expect(await discovery.json()).toEqual({services:[],inquiryKinds:["website","drone","other"],unavailable:[]});
  const history=await f.request("/inquiries");
  expect(history.status).toBe(200);
  expect(await history.json()).toEqual({inquiries:[opsInquiry,paInquiryOne,paInquiryTwo]});
  expect(f.listInquiries).toHaveBeenCalledTimes(1);expect(f.listOperationsInquiries).toHaveBeenCalledTimes(1);
  const submitted=await f.request("/inquiries",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":"mixed-inquiry-idempotency"},
   body:JSON.stringify({kind:"website",title:"One canonical intake",details:"Please route this once."})});
  expect(submitted.status).toBe(201);expect(f.submitInquiry).toHaveBeenCalledTimes(1);expect(f.submitOperationsInquiry).not.toHaveBeenCalled();
 });
 it("keeps Ops history available when PA eligibility is revoked",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"};
  const f=fixture(vi.fn(async()=>[cap]),async()=>null,[paWorkspace]);
  const response=await f.request("/inquiries");
  expect(response.status).toBe(200);expect(await response.json()).toEqual({inquiries:[inquiry]});
  expect(f.listInquiries).not.toHaveBeenCalled();expect(f.listOperationsInquiries).toHaveBeenCalledTimes(1);
 });
 it("keeps PA history available when Ops eligibility is revoked",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"},proof=makePaProof(paWorkspace.id,paWorkspace.sourceId,"pa-identity");
  const f=fixture(vi.fn(async()=>[]),async()=>proof,[paWorkspace]);
  const response=await f.request("/inquiries");
  expect(response.status).toBe(200);expect(await response.json()).toEqual({inquiries:[{...inquiry,id:"pa-inquiry"}]});
  expect(f.listInquiries).toHaveBeenCalledTimes(1);expect(f.listOperationsInquiries).not.toHaveBeenCalled();
 });
 it("does not disclose either history to a foreign principal",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"};
  const f=fixture(vi.fn(async()=>[]),async()=>null,[paWorkspace],{issuer:"issuer",subject:"foreign-subject",email:"foreign@example.test"});
  const response=await f.request("/inquiries");
  expect(response.status).toBe(403);expect(f.listInquiries).not.toHaveBeenCalled();expect(f.listOperationsInquiries).not.toHaveBeenCalled();
 });
 it("does not mask an unavailable Ops history reader with PA history",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"},proof=makePaProof(paWorkspace.id,paWorkspace.sourceId,"pa-identity");
  const f=fixture(vi.fn(async()=>[cap]),async()=>proof,[paWorkspace]);
  f.listOperationsInquiries.mockImplementation(async()=>null as unknown as typeof inquiry[]);
  const response=await f.request("/inquiries");
  expect(response.status).toBe(503);expect(f.listInquiries).toHaveBeenCalledTimes(1);expect(f.listOperationsInquiries).toHaveBeenCalledTimes(1);
 });
 it("rejects a PA authority set that drifts during the merged history read",async()=>{
  const paWorkspace={id:"pa-workspace",sourceId:"project-alpha:ltds",resourceMode:"native" as const,rootType:"standalone_client" as const,
   rootPublicId:"pa-root",displayName:"LTDS"},proof=makePaProof(paWorkspace.id,paWorkspace.sourceId,"pa-identity");
  const paAuthority=vi.fn(async()=>proof).mockResolvedValueOnce(proof).mockResolvedValueOnce(proof).mockResolvedValueOnce(null as unknown as NativeRequestAuthorityProof);
  const f=fixture(vi.fn(async()=>[]),paAuthority,[paWorkspace]);
  const response=await f.request("/inquiries");
  expect(response.status).toBe(409);expect(f.listInquiries).toHaveBeenCalledTimes(1);
 });
});
