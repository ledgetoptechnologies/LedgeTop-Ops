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
    OPERATIONS_ORIGINS:`${NEW},${OLD},${LTT}`,ASSETS:{fetch}} as unknown as Env;
  const request=(url:string,init:RequestInit={})=>worker.fetch(new Request(url,{headers:navigation,...init}),env,context);
  return {env,request,fetch};
}
describe("real Operations entrypoint canonical navigation mount",()=>{
  it.each([OLD,"https://ops.alternate.invalid"])("preserves existing staff page behavior until canonical PUBLIC_BASE_URL: %s",async baseUrl=>{
    const f=fixture(baseUrl),response=await f.request(`${OLD}/clients?view=list`);
    expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("does not redirect a partial canonical tuple",async()=>{
    const f=fixture(NEW);
    f.env.EXPECTED_HOST="ops.ledgetopdroneservices.com";
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
  it("canonicalizes old-host staff pages with Access cookies without forwarding them; keeps capabilities local",async()=>{
    const f=fixture(NEW);
    const protectedHeaders:Record<string,string>[]=[{Authorization:"Bearer synthetic"},{Range:"bytes=0-1"},{"If-Range":"synthetic"},{Origin:OLD}];
    for(const headers of protectedHeaders) {
      const response=await f.request(`${OLD}/clients`,{headers:{...navigation,...headers}});
      expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
    }
    const accessCookie=await f.request(`${OLD}/clients`,{headers:{...navigation,Cookie:"CF_Authorization=synthetic"}});
    expect(accessCookie.status).toBe(302);expect(accessCookie.headers.get("Location")).toBe(`${NEW}/clients`);
    expect(accessCookie.headers.get("Set-Cookie")).toBeNull();
    for(const path of ["/viewer/workspace/synthetic","/clients?token=synthetic","/assets/synthetic.js"]) {
      const response=await f.request(`${OLD}${path}`);expect(response.headers.get("Location")).toBeNull();
    }
    const api=await f.request(`${OLD}/api/session`);expect(api.status).toBe(503);expect(api.headers.get("Location")).toBeNull();
    const post=await f.request(`${OLD}/clients`,{method:"POST",body:"synthetic"});expect(post.headers.get("Location")).toBeNull();
  });
  it("keeps legacy public link paths, APIs and signed callbacks local on an admitted old origin",async()=>{
    const f=fixture(NEW);
    for(const url of [
      `${OLD}/s/legacy-public-id?state=signed-callback`,
      `${OLD}/client-share/legacy-public-id?token=preserve-me`,
      `${OLD}/api/dropbox-import/oauth/callback?state=signed-state&code=signed-code`,
      `${OLD}/api/session?token=preserve-me`,
    ]) {
      const response=await f.request(url);
      expect(response.headers.get("Location")).toBeNull();
    }
    expect((await f.request(`${OLD}/api/dropbox-import/oauth/callback?state=signed-state&code=signed-code`)).status)
      .not.toBe(302);
  });
  it("requires both source and target in the original host policy; forwarding headers confer no trust",async()=>{
    const f=fixture(NEW);
    const forged=await f.request("https://unrelated.invalid/clients",{headers:{...navigation,Host:"ops.ledgetopdroneservices.com","X-Forwarded-Host":"ops.ledgetopdroneservices.com"}});
    expect(forged.status).toBe(404);expect(forged.headers.get("Location")).toBeNull();
    expect((await f.request(`${OLD}/clients`,{headers:{...navigation,"X-Forwarded-Host":"unrelated.invalid"}})).headers.get("Location")).toBe(`${NEW}/clients`);
    f.env.OPERATIONS_ORIGINS=`${NEW},${LTT}`;
    expect((await f.request(`${OLD}/clients`)).status).toBe(404);
    f.env.OPERATIONS_ORIGINS=`${NEW},${OLD}`;
    expect((await f.request(`${LTT}/clients`)).status).toBe(404);
  });
});
