import { describe,expect,it,vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
const OLD="https://ops.ledgetopdroneservices.com", LTT="https://ops.ledgetoptechnologies.com", NEW="https://ops.ledgetop.app";
const navigation={Accept:"text/html","Sec-Fetch-Dest":"document","Sec-Fetch-Mode":"navigate"};
const context={waitUntil:vi.fn(),passThroughOnException:vi.fn()} as unknown as ExecutionContext;
function fixture(publicBaseUrl=OLD){
  const fetch=vi.fn(async()=>new Response("existing staff shell",{headers:{"Content-Type":"text/html"}}));
  const expectedHost=publicBaseUrl===NEW?"ops.ledgetop.app":"ops.ledgetopdroneservices.com";
  const env={ENVIRONMENT:"production",EXPECTED_HOST:expectedHost,PUBLIC_BASE_URL:publicBaseUrl,
    OPERATIONS_ORIGINS:publicBaseUrl===NEW?NEW:OLD,
    LEGACY_OPERATIONS_REDIRECT_ORIGINS:`${OLD},${LTT}`,ASSETS:{fetch}} as unknown as Env;
  const request=(url:string,init:RequestInit={})=>worker.fetch(new Request(url,{headers:navigation,...init}),env,context);
  return {env,request,fetch};
}
describe("real Operations entrypoint canonical navigation mount",()=>{
  it("preserves exact legacy navigation and pending callbacks without an additional scalar",async()=>{
    const f=fixture(NEW);
    Reflect.deleteProperty(f.env,"LEGACY_OPERATIONS_REDIRECT_ORIGINS");
    for(const origin of [OLD,LTT]) {
      expect((await f.request(`${origin}/clients`)).headers.get("Location")).toBe(`${NEW}/clients`);
      const callback=await f.request(`${origin}/api/dropbox-import/oauth/callback?state=synthetic&code=synthetic`);
      expect(callback.status).not.toBe(404);
      expect((await f.request(`${origin}/api/session`)).status).toBe(404);
    }
    expect((await f.request("https://ops.unrelated.invalid/clients")).status).toBe(404);
    f.env.EXPECTED_HOST="ops.ledgetopdroneservices.com";
    expect((await f.request(`${OLD}/api/dropbox-import/oauth/callback`)).status).toBe(404);
    f.env.EXPECTED_HOST="ops.ledgetop.app";
    f.env.LEGACY_OPERATIONS_REDIRECT_ORIGINS="";
    expect((await f.request(`${OLD}/clients`)).status).toBe(404);
    expect((await f.request(`${OLD}/api/dropbox-import/oauth/callback`)).status).toBe(404);
  });
  it.each([OLD,"https://ops.alternate.invalid"])("preserves existing staff page behavior until canonical PUBLIC_BASE_URL: %s",async baseUrl=>{
    const f=fixture(baseUrl),response=await f.request(`${OLD}/clients?view=list`);
    expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("does not redirect a partial canonical tuple",async()=>{
    const f=fixture(NEW);
    f.env.EXPECTED_HOST="ops.ledgetopdroneservices.com";
    f.env.OPERATIONS_ORIGINS=`${NEW},${OLD}`;
    const response=await f.request(`${OLD}/clients?view=list`);
    expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
  });
  it("redirects only configured fresh staff pages with exact query and fixed destination",async()=>{
    const f=fixture(NEW);
    for(const origin of [OLD,LTT]) for(const method of ["GET","HEAD"]) {
      const path="/clients/sources/project-alpha%3Aprimary/business/organizations/synthetic?view=list&folder=opaque%2Fref";
      const response=await f.request(`${origin}${path}#Synthetic_fragment`,{method});
      expect(response.status).toBe(302);expect(response.headers.get("Location")).toBe(`${NEW}${path}`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("redirects old-host staff pages with Access cookies without forwarding them; keeps APIs and capabilities local",async()=>{
    const f=fixture(NEW);
    const protectedHeaders:Record<string,string>[]=[{Authorization:"Bearer synthetic"},{Range:"bytes=0-1"},{"If-Range":"synthetic"},{Origin:OLD}];
    for(const headers of protectedHeaders) {
      const response=await f.request(`${OLD}/clients`,{headers:{...navigation,...headers}});
      expect(response.status).toBe(404);expect(response.headers.get("Location")).toBeNull();
    }
    const accessCookie=await f.request(`${OLD}/clients`,{headers:{...navigation,Cookie:"CF_Authorization=synthetic"}});
    expect(accessCookie.status).toBe(302);expect(accessCookie.headers.get("Location")).toBe(`${NEW}/clients`);
    expect(accessCookie.headers.get("Set-Cookie")).toBeNull();
    for(const path of ["/viewer/workspace/synthetic","/clients?token=synthetic","/assets/synthetic.js"]) {
      const response=await f.request(`${OLD}${path}`);expect(response.headers.get("Location")).toBeNull();
    }
    const api=await f.request(`${OLD}/api/session`);expect(api.status).toBe(404);expect(api.headers.get("Location")).toBeNull();
    const post=await f.request(`${OLD}/clients`,{method:"POST",body:"synthetic"});expect(post.status).toBe(404);expect(post.headers.get("Location")).toBeNull();
  });
  it("canonicalizes each ordinary Models, Intel, account and administration page without covering signed namespaces",async()=>{
    const f=fixture(NEW);
    const pages=["/viewer","/viewer/models","/viewer/sharing","/viewer/processing","/operations/processing",
      "/intel","/account","/configurations","/notifications","/jobs","/projects","/tasks","/sops",
      "/operations/projects","/operations/tasks","/operations/sops","/operations/notifications",
      "/operations/client-requests","/operations/feedback","/operations/inbox","/operations/invitation-requests",
      "/operations/client-requests/synthetic-id","/operations/feedback/synthetic-id","/operations/invitation-requests/synthetic-id",
      "/clients/requests","/clients/feedback","/clients/invitation-requests","/clients/invitation-requests/synthetic-id",
      "/delivery/incoming","/delivery/links"];
    for(const origin of [OLD,LTT]) for(const page of pages) {
      const query=page==="/intel"?"?business=synthetic-business&view=search-console&range=28d":"";
      const response=await f.request(origin+page+query);
      expect(response.status).toBe(302);expect(response.headers.get("Location")).toBe(NEW+page+query);
    }
    const viewerReview=await f.request(`${OLD}/operations/processing?attemptId=synthetic-attempt`);
    expect(viewerReview.status).toBe(302);
    expect(viewerReview.headers.get("Location")).toBe(`${NEW}/operations/processing?attemptId=synthetic-attempt`);
    for(const path of ["/viewer/workspace/synthetic","/viewer/session/synthetic","/viewer/attempts/synthetic",
      "/intel?token=synthetic","/account?intentId=synthetic","/operations/processing?reviewToken=synthetic"]) {
      expect((await f.request(OLD+path)).headers.get("Location")).toBeNull();
    }
  });
  it("keeps callback paths local while denying old-host Ops APIs",async()=>{
    const f=fixture(NEW);
    const legacyCallback=await f.request(`${OLD}/api/dropbox-import/oauth/callback?state=signed-state&code=signed-code`);
    expect(legacyCallback.status).not.toBe(404);expect(legacyCallback.headers.get("Location")).toBeNull();
    for(const path of ["/api/session?token=preserve-me","/api/admin/team"]){
      const response=await f.request(`${OLD}${path}`);expect(response.status).toBe(404);expect(response.headers.get("Location")).toBeNull();
    }
  });
  it("requires both source and target in the original host policy; forwarding headers confer no trust",async()=>{
    const f=fixture(NEW);
    const forged=await f.request("https://unrelated.invalid/clients",{headers:{...navigation,Host:"ops.ledgetopdroneservices.com","X-Forwarded-Host":"ops.ledgetopdroneservices.com"}});
    expect(forged.status).toBe(404);expect(forged.headers.get("Location")).toBeNull();
    expect((await f.request(`${OLD}/clients`,{headers:{...navigation,"X-Forwarded-Host":"unrelated.invalid"}})).headers.get("Location")).toBe(`${NEW}/clients`);
    f.env.LEGACY_OPERATIONS_REDIRECT_ORIGINS=`${LTT}`;
    expect((await f.request(`${LTT}/clients`)).headers.get("Location")).toBe(`${NEW}/clients`);
    f.env.LEGACY_OPERATIONS_REDIRECT_ORIGINS=`https://ops.attacker.invalid`;
    expect((await f.request(`${OLD}/clients`)).status).toBe(404);
    expect((await f.request(`${LTT}/clients`)).status).toBe(404);
  });
});
