import { describe, expect, it, vi } from "vitest";
import { createUnifiedRequestRouter } from "../src/worker/client-portal/unified-request-routes";
import type { Env } from "../src/worker/types";
import type { PortalWorkspaceSummary } from "../src/worker/client-portal/workspace-v2";

const origin="https://client.example";
const env={CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_ORIGIN:origin} as Env;
const ws=(id:string,sourceId="project-alpha:primary"):PortalWorkspaceSummary=>({
  id,sourceId,resourceMode:"native",rootType:"standalone_client",rootPublicId:id,displayName:"Client "+id,
});
const proof={sourceId:"project-alpha:primary",workspaceId:"drone-workspace",identityId:"identity-global"} as any;
function fixture(resolveAuthority=vi.fn(async()=>proof),rows=[ws("drone-workspace")]){
  const submitInquiry=vi.fn(async(_env:Env,_proof:any,input:any)=>({kind:"created" as const,inquiry:{
    id:"inquiry-1",kind:input.kind,title:input.title,details:input.details,location:input.location,status:"received" as const,createdAt:"2026-10-30T00:00:00.000Z",
  }}));
  const listInquiries=vi.fn(async()=>[]);
  const scopedFetch=vi.fn(async()=>Response.json({services:[],nextCursor:null}));
  const router=createUnifiedRequestRouter({
    resolvePrincipal:async()=>({issuer:"issuer",subject:"subject",email:"client@example.com"}),
    checkConfiguration:false,discover:async()=>rows,scopedFetch,resolveAuthority,submitInquiry,listInquiries,
    inquirySchemaReady:async()=>true,
  });
  const post=(body:unknown,key="triage-idempotency-0001",originValue=origin)=>router.request(origin+"/inquiries",{
    method:"POST",headers:{Origin:originValue,"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(body),
  },env);
  return {router,post,submitInquiry,listInquiries,scopedFetch,resolveAuthority};
}

describe("unified client Ops triage inquiries",()=>{
  it("lets a Drone-only context submit a website inquiry without catalog dispatch or source selection",async()=>{
    const f=fixture();
    const response=await f.post({kind:"website",title:"Website refresh",details:"Please contact us about our public website."});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({inquiry:{kind:"website",status:"received"}});
    expect(f.submitInquiry).toHaveBeenCalledWith(env,proof,{
      kind:"website",title:"Website refresh",details:"Please contact us about our public website.",location:null,idempotencyKey:"triage-idempotency-0001",
    });
    expect(f.scopedFetch).not.toHaveBeenCalled();
  });
  it("rejects client-controlled source, workspace, recipient, project, and catalog fields",async()=>{
    const f=fixture();
    for(const field of ["sourceId","workspaceId","recipient","projectId","serviceChoiceId","accountId"]){
      expect((await f.post({kind:"drone",title:"Request",details:"Details",[field]:"attacker"})).status).toBe(400);
    }
    expect(f.submitInquiry).not.toHaveBeenCalled();
  });
  it("requires a current eligible authority and fails closed if it changes before writing",async()=>{
    const denied=fixture(vi.fn(async()=>null));
    expect((await denied.post({kind:"other",title:"Request",details:"Details"})).status).toBe(403);
    expect(denied.submitInquiry).not.toHaveBeenCalled();
    const changing=fixture(vi.fn().mockResolvedValueOnce(proof).mockResolvedValueOnce(null));
    expect((await changing.post({kind:"other",title:"Request",details:"Details"})).status).toBe(409);
    expect(changing.submitInquiry).not.toHaveBeenCalled();
  });
  it("uses a fresh current context for history when the earlier sorted audit anchor was revoked",async()=>{
    const first={identityId:"identity-global",workspaceId:"a-workspace",sourceId:"project-alpha:primary"} as any;
    const next={identityId:"identity-global",workspaceId:"b-workspace",sourceId:"project-alpha:secondary"} as any;
    const resolve=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(null).mockResolvedValueOnce(next);
    const f=fixture(resolve,[ws("a-workspace"),ws("b-workspace","project-alpha:secondary")]);
    const response=await f.router.request(origin+"/inquiries",{},env);
    expect(response.status).toBe(200);
    expect(f.listInquiries).toHaveBeenCalledWith(env,next,50);
  });
  it("requires an idempotency key and preserves the original catalog route",async()=>{
    const f=fixture();
    expect((await f.post({kind:"drone",title:"Request",details:"Details"},"short")).status).toBe(400);
    const catalog=await f.router.request(origin+"/request-services",{},env);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({inquiryKinds:["website","drone","other"]});
    expect(f.scopedFetch).toHaveBeenCalledTimes(1);
  });
});
