import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks=vi.hoisted(()=>({scope:vi.fn(),native:vi.fn(),candidates:vi.fn(),review:vi.fn(),reserve:vi.fn(),bind:vi.fn(),finalize:vi.fn(),audit:vi.fn()}));
vi.mock("../src/worker/acl",()=>({sqlScope:mocks.scope}));
vi.mock("../src/worker/native-staff-auth",()=>({authenticateNativeStaffWithAdmissionVersion:mocks.native}));
vi.mock("../src/worker/project-alpha-project-adoption-candidates-consumer",()=>({listAuthorizedProjectAlphaProjectAdoptionCandidates:mocks.candidates}));
vi.mock("../src/worker/project-alpha-project-adoption-review-producer",()=>({produceProjectAlphaProjectAdoptionReview:mocks.review}));
vi.mock("../src/worker/project-alpha-project-adoption-review-consumer",()=>({reserveProjectAlphaProjectAdoptionReview:mocks.reserve}));
vi.mock("../src/worker/project-alpha-project-adoption-bind-consumer",()=>({planProjectAlphaProjectAdoptionBind:mocks.bind}));
vi.mock("../src/worker/project-alpha-project-adoption-finalizer",()=>({finalizeProjectAlphaProjectAdoption:mocks.finalize}));
vi.mock("../src/worker/request-security",async original=>({...await original<typeof import("../src/worker/request-security")>(),auditStatement:mocks.audit}));

import { registerProjectAlphaProjectOperationalAdoptionRoutes } from "../src/worker/project-alpha-project-adoption-operational-routes";

const principal:StaffPrincipal={id:"owner",email:"owner@example.test",displayName:"Owner",accessSubject:"subject",projectAlphaUserId:null};
const sourceId="project-alpha:primary",rootPublicId="local-customer",paPublicId="a".repeat(32),otherPublicId="b".repeat(32);
const reviewId="10000000-0000-4000-8000-000000000001",key="20000000-0000-4000-8000-000000000002";
const reservationId="30000000-0000-4000-8000-000000000003",commandId="40000000-0000-4000-8000-000000000004";
const context:ClientHubCollectionContext={root:{source_id:sourceId,root_namespace:"business",kind:"organization",public_id:rootPublicId,
  pa_public_id:paPublicId,mapping_status:"mapped",display_name:"Customer",sort_name:"Customer",status:"active",portal_status:"not_provisioned",
  workspace_id:null,legacy_account_id:null,account_count:0,project_count:0,request_count:0,contact_count:0,meaningful_activity_at:null,
  source_version:null,indexed_at:"",scan_generation:0},access:{directory:true,requests:true,delivery:false,viewer:false},contextVersion:"context-1",
  canonicalRoot:{sourceId,rootNamespace:"business",kind:"organization",publicId:rootPublicId}};

function fixture(options:{operational?:boolean;review?:boolean;finalization?:boolean;denied?:boolean;owner?:boolean}={}){
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  app.use("/api/*",async(c,next)=>{c.set("principal",principal);c.set("administrator",true);await requireMutationSecurity(c.req.raw,c.env,principal);await next();});
  const resolve=vi.fn().mockResolvedValue(context),verify=vi.fn().mockResolvedValue(undefined);
  registerProjectAlphaProjectOperationalAdoptionRoutes(app,resolve,verify);
  const first=vi.fn(async(sql:string)=>sql.includes("staff_role_assignments")?(options.owner===false?null:1):{
    source_id:sourceId,organizationPublicId:paPublicId,clientPublicId:null,
  });
  const prepared:unknown[]=[];
  const env={PROJECT_ALPHA_PROJECT_ADOPTION_OPERATIONAL_ENABLED:options.operational===false?"false":"true",
    PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED:options.review===false?"false":"true",
    PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED:options.finalization===false?"false":"true",
    TEAM_DOMAIN:"https://team.cloudflareaccess.com",OPERATIONS_AUD:"operations",OPERATIONS_SESSION_SECRET:"operations-session-secret-0123456789abcdef",
    AUDIT_IP_SECRET:"audit-secret-0123456789abcdef",EXPECTED_HOST:"ops.example.test",OPERATIONS_ORIGINS:"https://ops.example.test",
    OPS_DB:{prepare:vi.fn((sql:string)=>({bind:vi.fn((...values:unknown[])=>{prepared.push({sql,values});return{first:vi.fn(()=>first(sql))};})})),batch:vi.fn().mockResolvedValue([])}} as unknown as Env;
  mocks.scope.mockResolvedValue({global:true,deniedGlobal:options.denied===true});
  const request=async(path:string,init:RequestInit={})=>app.request(`https://ops.example.test${path}`,{...init,headers:{Origin:"https://ops.example.test","X-CSRF-Token":await csrfToken(env,principal),...(init.headers??{})}},env);
  const base=`/api/client-hub/sources/${sourceId}/business/organizations/${rootPublicId}/project-adoption`;
  return{request,base,resolve,verify,env,prepared};
}

describe("operational Project Alpha-first Project adoption",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.native.mockResolvedValue({admissionVersion:3,verifiedUntil:"2099-01-01T00:00:00.000Z",identity:{staffId:principal.id,email:principal.email,
      verifiedAccessSubject:principal.accessSubject,profileVersion:4}});
    mocks.audit.mockResolvedValue({});
    mocks.candidates.mockResolvedValue({status:"observed",authorizationGeneration:"7",projects:[
      {publicId:"c".repeat(32),revision:"1",projectionSha256:"d".repeat(64),name:"Exact",status:"active",archived:false,
        organizationPublicId:paPublicId,clientPublicId:null,organizationRecordId:"org",clientRecordId:null},
      {publicId:"e".repeat(32),revision:"1",projectionSha256:"f".repeat(64),name:"Other",status:"active",archived:false,
        organizationPublicId:otherPublicId,clientPublicId:null,organizationRecordId:"other",clientRecordId:null}],nextCursor:null});
    mocks.review.mockResolvedValue({status:"reviewed",reviewItemId:reviewId,requestSha256:"1".repeat(64),replayed:false});
    mocks.reserve.mockResolvedValue({status:"reserved",reservationId,reviewItemId:reviewId,idempotencyKey:key,replayed:false});
    mocks.bind.mockResolvedValue({status:"planned",bridgeId:key,reservationId,commandId,requestSha256:"2".repeat(64),replayed:false});
    mocks.finalize.mockResolvedValue({stage:"activate",outcome:{status:"activated",activationId:key,replayed:false}});
  });

  it("stays hidden unless the independent operational and existing workflow gates are all enabled",async()=>{
    for(const options of [{operational:false},{review:false},{finalization:false}]){
      const value=fixture(options);
      expect((await value.request(`${value.base}/candidates?expectedContextVersion=context-1`)).status).toBe(404);
    }
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it("derives the source and exact customer relationship from Client Hub and filters unrelated candidates",async()=>{
    const value=fixture();
    const response=await value.request(`${value.base}/candidates?expectedContextVersion=context-1&limit=50`);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    const json=await response.json() as {outcome:{projects:Array<Record<string,unknown>>}};
    expect(json.outcome.projects).toEqual([expect.objectContaining({name:"Exact",organizationPublicId:paPublicId})]);
    expect(json.outcome.projects[0]).not.toHaveProperty("organizationRecordId");
    expect(mocks.candidates).toHaveBeenCalledWith(expect.anything(),{staffId:"owner",accessSubject:"subject"},
      {sourceId,cursor:undefined,limit:50},expect.any(Function));
    expect(value.resolve).toHaveBeenCalledWith(expect.anything(),principal,"organization",rootPublicId,sourceId,"business");
  });

  it("denies missing owner or deny-aware integrations.manage authority before any PA operation",async()=>{
    for(const options of [{owner:false},{denied:true}]){
      const value=fixture(options);
      expect((await value.request(`${value.base}/candidates?expectedContextVersion=context-1`)).status).toBe(403);
    }
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it("keeps the legacy review flag insufficient for a production operational route",async()=>{
    const value=fixture({operational:false,review:true,finalization:true});
    expect((await value.request(`${value.base}/candidates?expectedContextVersion=context-1`)).status).toBe(404);
  });

  it("runs the existing reviewed workflow with strict bodies, CSRF, frozen keys, root evidence and audits",async()=>{
    const value=fixture();
    const post=(path:string,payload:unknown,id:string)=>value.request(`${value.base}${path}`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":id},body:JSON.stringify(payload)});
    expect((await post("/review",{expectedContextVersion:"context-1",externalProjectId:"new-ops-project",projectAlphaPublicId:"c".repeat(32),sourceId},key)).status).toBe(400);
    expect((await post("/review",{expectedContextVersion:"context-1",externalProjectId:"new-ops-project",projectAlphaPublicId:"c".repeat(32)},key)).status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(expect.anything(),{staffId:"owner",accessSubject:"subject"},{idempotencyKey:key,
      sourceId,externalProjectId:"new-ops-project",projectAlphaPublicId:"c".repeat(32)},expect.any(Function));
    expect((await post("/reserve",{expectedContextVersion:"context-1",reviewItemId:reviewId,idempotencyKey:key},key)).status).toBe(200);
    expect((await post("/bind",{expectedContextVersion:"context-1",reservationId},reservationId)).status).toBe(200);
    expect((await post("/finalize",{expectedContextVersion:"context-1",reservationId,commandId},commandId)).status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);expect(mocks.bind).toHaveBeenCalledTimes(1);expect(mocks.finalize).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(4);expect(value.verify).toHaveBeenCalledTimes(4);
  });

  it("fails a review closed when the fresh PA detail no longer belongs to the Client Hub customer",async()=>{
    mocks.review.mockImplementation(async(_env:unknown,_actor:unknown,_input:unknown,send:typeof fetch)=>{
      const response=await send(`https://pa.example.test/api/v2/projects/${"c".repeat(32)}`,{},);
      return response.status===409?{status:"blocked",reason:"relationship"}:{status:"reviewed",reviewItemId:reviewId,requestSha256:"1".repeat(64),replayed:false};
    });
    const original=globalThis.fetch;
    globalThis.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{organizationPublicId:otherPublicId,clientPublicId:null}}),{status:200,headers:{"Content-Type":"application/json"}}));
    try{
      const value=fixture();
      const response=await value.request(`${value.base}/review`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},
        body:JSON.stringify({expectedContextVersion:"context-1",externalProjectId:"new-ops-project",projectAlphaPublicId:"c".repeat(32)})});
      expect(response.status).toBe(200);expect((await response.json() as {outcome:{status:string}}).outcome.status).toBe("blocked");
    }finally{globalThis.fetch=original;}
  });

  it.each([
    ["an oversized response",()=>new Response(JSON.stringify({data:{organizationPublicId:paPublicId,clientPublicId:null},padding:"x".repeat(65_536)}),
      {status:200,headers:{"Content-Type":"application/json"}})],
    ["duplicate JSON members",()=>new Response(`{"data":{"organizationPublicId":"${paPublicId}","organizationPublicId":"${otherPublicId}","clientPublicId":null}}`,
      {status:200,headers:{"Content-Type":"application/json"}})],
  ])("fails a review closed on %s before accepting downstream success",async(_label,response)=>{
    mocks.review.mockImplementation(async(_env:unknown,_actor:unknown,_input:unknown,send:typeof fetch)=>{
      const received=await send(`https://pa.example.test/api/v2/projects/${"c".repeat(32)}`,{});
      return received.status===409?{status:"blocked",reason:"relationship"}:{status:"reviewed",reviewItemId:reviewId,requestSha256:"1".repeat(64),replayed:false};
    });
    const original=globalThis.fetch;
    globalThis.fetch=vi.fn().mockImplementation(async()=>response());
    try{
      const value=fixture();
      const result=await value.request(`${value.base}/review`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},
        body:JSON.stringify({expectedContextVersion:"context-1",externalProjectId:"new-ops-project",projectAlphaPublicId:"c".repeat(32)})});
      expect(result.status).toBe(200);
      expect((await result.json() as {outcome:{status:string}}).outcome.status).toBe("blocked");
      expect(value.prepared.some(entry=>(entry as {sql:string}).sql.includes("project_alpha_project_adoption_review_evidence"))).toBe(false);
    }finally{globalThis.fetch=original;}
  });
});
