import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
import clientWranglerRaw from "../wrangler.jsonc?raw";
const clientWrangler=JSON.parse(clientWranglerRaw) as {vars:Record<string,string>;routes:Array<{pattern:string}>};

const OLD="https://portal.ledgetopdroneservices.com", CLIENT="https://client.ledgetopdroneservices.com";
const LTT="https://portal.ledgetoptechnologies.com", PORTAL="https://portal.ledgetop.app", DELIVERY="https://delivery.ledgetop.app";
const navigation={Accept:"text/html","Sec-Fetch-Dest":"document","Sec-Fetch-Mode":"navigate"};
const context={waitUntil:vi.fn(),passThroughOnException:vi.fn()} as unknown as ExecutionContext;
function fixture(enabled?:string) {
  const fetch=vi.fn(async()=>new Response("existing shell",{headers:{"Content-Type":"text/html"}}));
  const prepare=vi.fn(()=>{throw Error("navigation must not query storage");});
  const env={ENVIRONMENT:"production",EXPECTED_HOST:"delivery.ledgetop.app",PUBLIC_BASE_URL:DELIVERY,PUBLIC_SHARE_ORIGIN:DELIVERY,
    CLIENT_PORTAL_ORIGIN:PORTAL,CLIENT_PORTAL_ORIGINS:`${PORTAL},${OLD},${LTT}`,LEGACY_CLIENT_ORIGINS:`${OLD},${CLIENT}`,
    CLIENT_PORTAL_RETIRED_ORIGINS:"",CANONICAL_BROWSER_NAVIGATION_ENABLED:enabled,
    ASSETS:{fetch},DELIVERY_DB:{prepare},AUDIT_IP_SECRET:"synthetic-audit-secret-not-a-credential",PUBLIC_SESSION_RATE_LIMITER:{limit:async()=>({success:true})}} as unknown as Env;
  const request=(url:string,init:RequestInit={})=>worker.fetch(new Request(url,{headers:navigation,...init}),env,context);
  return {env,request,fetch,prepare};
}
describe("real Client entrypoint canonical navigation mount",()=>{
  it("enables production canonical browser navigation while retaining compatibility hosts",()=>{
    expect(clientWrangler.vars.CANONICAL_BROWSER_NAVIGATION_ENABLED).toBe("true");
    expect(clientWrangler.routes.map(route=>route.pattern)).toEqual(expect.arrayContaining([
      "portal.ledgetop.app","delivery.ledgetop.app","client.ledgetopdroneservices.com",
      "portal.ledgetopdroneservices.com","portal.ledgetoptechnologies.com",
    ]));
  });
  it.each([undefined,"false","TRUE","1"])("keeps the active mixed host local when the opt-in is %s",async enabled=>{
    const f=fixture(enabled);
    for(const path of ["/portal/projects?view=list","/s/synthetic-id?folder=opaque%2Fref"]) {
      const response=await f.request(`${OLD}${path}`);
      expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
    }
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("routes fresh mixed-host public and private entries to their distinct fixed destinations",async()=>{
    const f=fixture("true");
    for(const [origin,path,target] of [[OLD,"/s/synthetic-id?folder=opaque%2Fref&sort=name&sort=date",DELIVERY],
      [CLIENT,"/client-share/synthetic-id?folder=opaque%2Fref",DELIVERY],
      [OLD,"/portal/projects?folder=opaque%2Fref&view=list",PORTAL],
      [LTT,"/portal/account?tab=profile",PORTAL]]) for(const method of ["GET","HEAD"]) {
      const response=await f.request(`${origin}${path}#Synthetic_fragment`,{method});
      expect(response.status).toBe(302);expect(response.headers.get("Location")).toBe(`${target}${path}`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(f.fetch).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
    expect((await f.request(`${OLD}/?folder=opaque%2Fref`)).headers.get("Location")).toBe(`${PORTAL}/portal?folder=opaque%2Fref`);
  });
  it("moves ordinary private pages with old cookies without copying session credentials",async()=>{
    const f=fixture("true");
    for(const origin of [OLD,CLIENT,LTT]) for(const method of ["GET","HEAD"])
      for(const cookie of ["__Host-ltds_delivery=synthetic","CF_Authorization=synthetic","unrelated=synthetic"]){
        const response=await f.request(`${origin}/portal/account?tab=profile`,{method,headers:{...navigation,Cookie:cookie}});
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe(`${PORTAL}/portal/account?tab=profile`);
        expect(response.headers.get("Set-Cookie")).toBeNull();
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    expect(f.fetch).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();
  });
  it("keeps public cookies and all authorization, ranges and non-navigation requests local",async()=>{
    const f=fixture("true");
    for(const path of ["/portal/projects","/s/synthetic-id","/client-share/synthetic-id"]) {
      const protectedHeaders:Record<string,string>[]=[{Authorization:"Bearer synthetic"},{Range:"bytes=0-1"},{"If-Range":"synthetic"},{Origin:OLD},
        ...(path.startsWith("/portal/")?[]:[{Cookie:"__Host-ltds_delivery=synthetic"},{Cookie:"CF_Authorization=synthetic"}])];
      for(const headers of protectedHeaders) {
        const response=await f.request(`${OLD}${path}`,{headers:{...navigation,...headers}});
        expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
      }
      expect((await f.request(`${OLD}${path}`,{headers:{Accept:"text/html"}})).headers.get("Location")).toBeNull();
    }
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("keeps public callback and encoded capability queries local through the entire Worker mount",async()=>{
    const f=fixture("true");
    for(const origin of [OLD,CLIENT]) for(const root of ["s","client-share"]) for(const method of ["GET","HEAD"])
      for(const key of ["cloudTransferNonce","cloudTransferAuthorization","cloudTransferJob","token","%74oken","access%5Fcode","state","next","unknown"]) {
        const response=await f.request(`${origin}/${root}/synthetic-id?folder=opaque%2Fref&${key}=synthetic`,{method});
        expect(response.status).toBe(200);expect(response.headers.get("Location")).toBeNull();
      }
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("retains ordinary API/session and method validation; portal.app never gains public share admission",async()=>{
    const f=fixture("true");
    for(const path of ["/api/public/shares/synthetic-id/manifest","/api/public/shares/synthetic-id/items/item/download"]) {
      const response=await f.request(`${OLD}${path}`,{headers:{...navigation,Range:"bytes=0-1"}});
      expect(response.status).toBe(401);expect(response.headers.get("Location")).toBeNull();
    }
    const session=await f.request(`${OLD}/api/public/shares/synthetic-id/session`,{method:"POST",headers:{Origin:OLD,"Content-Type":"application/json"},body:"{}"});
    expect(session.status).toBe(404);expect(await session.json()).toMatchObject({code:"SHARE_INVALID"});expect(session.headers.get("Location")).toBeNull();
    for(const path of ["/s/synthetic-id","/client-share/synthetic-id"]) expect((await f.request(`${PORTAL}${path}`)).status).toBe(404);
    const post=await f.request(`${OLD}/portal/projects`,{method:"POST",body:"synthetic"});
    expect(post.status).toBe(404);expect(post.headers.get("Location")).toBeNull();
  });
  it("uses request URL plus exact configured origins, never Host or forwarding headers",async()=>{
    const f=fixture("true");
    const forged=await f.request("https://unrelated.invalid/portal",{headers:{...navigation,Host:"portal.ledgetopdroneservices.com","X-Forwarded-Host":"portal.ledgetopdroneservices.com"}});
    expect(forged.status).toBe(404);expect(forged.headers.get("Location")).toBeNull();
    const normal=await f.request(`${OLD}/portal/projects`,{headers:{...navigation,Host:"unrelated.invalid","X-Forwarded-Host":"unrelated.invalid"}});
    expect(normal.headers.get("Location")).toBe(`${PORTAL}/portal/projects`);
    f.env.CLIENT_PORTAL_ORIGINS=PORTAL;
    expect((await f.request(`${LTT}/portal/projects`)).status).toBe(404);
  });
});
