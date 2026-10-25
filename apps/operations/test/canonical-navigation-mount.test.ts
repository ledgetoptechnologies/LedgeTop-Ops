import { describe,expect,it,vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
const OLD="https://ops.ledgetopdroneservices.com", LTT="https://ops.ledgetoptechnologies.com", NEW="https://ops.ledgetop.app";
const navigation={Accept:"text/html","Sec-Fetch-Dest":"document","Sec-Fetch-Mode":"navigate"};
const context={waitUntil:vi.fn(),passThroughOnException:vi.fn()} as unknown as ExecutionContext;
function fixture(enabled?:string){
  const fetch=vi.fn(async()=>new Response("existing staff shell",{headers:{"Content-Type":"text/html"}}));
  const env={ENVIRONMENT:"production",EXPECTED_HOST:"ops.ledgetopdroneservices.com",PUBLIC_BASE_URL:OLD,
    OPERATIONS_ORIGINS:`${NEW},${OLD},${LTT}`,CANONICAL_BROWSER_NAVIGATION_ENABLED:enabled,ASSETS:{fetch}} as unknown as Env;
  const request=(url:string,init:RequestInit={})=>worker.fetch(new Request(url,{headers:navigation,...init}),env,context);
  return {env,request,fetch};
}
describe("real Operations entrypoint canonical navigation mount",()=>{
  it.each([undefined,"false","TRUE"])("preserves existing staff page behavior with opt-in %s",async enabled=>{
    const f=fixture(enabled),response=await f.request(`${OLD}/clients?view=list`);
    expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("redirects only configured fresh staff pages with exact query and fixed destination",async()=>{
    const f=fixture("true");
    for(const origin of [OLD,LTT]) for(const method of ["GET","HEAD"]) {
      const path="/clients/source/project-alpha%3Aprimary/organization/synthetic?view=list&folder=opaque%2Fref";
      const response=await f.request(`${origin}${path}#Synthetic_fragment`,{method});
      expect(response.status).toBe(302);expect(response.headers.get("Location")).toBe(`${NEW}${path}`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("keeps existing sessions and capability routes local; APIs still require authentication",async()=>{
    const f=fixture("true");
    const protectedHeaders:Record<string,string>[]=[{Cookie:"CF_Authorization=synthetic"},{Authorization:"Bearer synthetic"},{Range:"bytes=0-1"},{"If-Range":"synthetic"},{Origin:OLD}];
    for(const headers of protectedHeaders) {
      const response=await f.request(`${OLD}/clients`,{headers:{...navigation,...headers}});
      expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
    }
    for(const path of ["/viewer/workspace/synthetic","/clients?token=synthetic","/assets/synthetic.js"]) {
      const response=await f.request(`${OLD}${path}`);expect(response.headers.get("Location")).toBeNull();
    }
    const api=await f.request(`${OLD}/api/session`);expect(api.status).toBe(503);expect(api.headers.get("Location")).toBeNull();
    const post=await f.request(`${OLD}/clients`,{method:"POST",body:"synthetic"});expect(post.headers.get("Location")).toBeNull();
  });
  it("requires both source and target in the original host policy; forwarding headers confer no trust",async()=>{
    const f=fixture("true");
    const forged=await f.request("https://unrelated.invalid/clients",{headers:{...navigation,Host:"ops.ledgetopdroneservices.com","X-Forwarded-Host":"ops.ledgetopdroneservices.com"}});
    expect(forged.status).toBe(404);expect(forged.headers.get("Location")).toBeNull();
    expect((await f.request(`${OLD}/clients`,{headers:{...navigation,"X-Forwarded-Host":"unrelated.invalid"}})).headers.get("Location")).toBe(`${NEW}/clients`);
    f.env.OPERATIONS_ORIGINS=`${OLD},${LTT}`;
    const noTarget=await f.request(`${OLD}/clients`);expect(noTarget.status).toBe(200);expect(noTarget.headers.get("Location")).toBeNull();
    f.env.OPERATIONS_ORIGINS=`${NEW},${OLD}`;
    expect((await f.request(`${LTT}/clients`)).status).toBe(404);
  });
});
