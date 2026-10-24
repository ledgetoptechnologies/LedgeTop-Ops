import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";
const mock=vi.hoisted(()=>({context:vi.fn(),list:vi.fn(),issue:vi.fn()}));
vi.mock("../src/worker/client-portal/workspace-v2",async original=>({
  ...await original<typeof import("../src/worker/client-portal/workspace-v2")>(),resolveNativePortalWorkspaceReadContext:mock.context}));
import { createNativePortalWorkspaceRouter } from "../src/worker/client-portal/native-portal-resources";

const principal={issuer:"https://access.example.test",subject:"signed-in-one",email:"synthetic@example.test"};
const context={sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",contextVersion:"a".repeat(64)};
function app(tableCount=2){
  const app=new Hono<{Bindings:Env;Variables:{clientPrincipal:typeof principal}}>();
  app.use("*",async(c,next)=>{c.set("clientPrincipal",principal);await next();});
  app.route("/api/client/v2/workspaces",createNativePortalWorkspaceRouter());
  const env={CLIENT_VIEWER_ENABLED:"true",CLIENT_PORTAL_ORIGIN:"https://portal.example.test",CLIENT_PORTAL_ORIGINS:"https://portal.example.test",
    DELIVERY_DB:{withSession:()=>({prepare:()=>({first:async()=>tableCount})})},
    VIEWER_SESSION_ISSUER:{listDirectClientViewerItems:mock.list,issueDirectClientViewerSession:mock.issue}} as unknown as Env;
  return (path:string,init?:RequestInit)=>app.request(`https://portal.example.test/api/client/v2/workspaces/workspace-one${path}`,init,env);
}
beforeEach(()=>{vi.resetAllMocks();mock.context.mockResolvedValue(context);
  mock.list.mockResolvedValue({ok:true,protocolVersion:1,items:[],nextCursor:null});
  mock.issue.mockResolvedValue({ok:true,protocolVersion:1,grant:"grant-one",grantExpiresAt:"2027-01-01T00:00:00Z",modelId:"model-one",
    sessionTtlSeconds:1800,redeemUrl:"https://viewer.example.test/redeem",embedUrl:"https://viewer.example.test/session"});});
const post=(body:unknown={displayUnits:"imperial"},origin="https://portal.example.test"):RequestInit=>({method:"POST",
  headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":"viewer-session-route-test-001"},body:JSON.stringify(body)});
describe("native direct Viewer portal routes",()=>{
  it("uses the verified identity and account context, with no PA project coordinate",async()=>{
    const response=await app()("/viewer?cursor=opaque-cursor");expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mock.list).toHaveBeenCalledWith({...context,protocolVersion:1,principalIssuer:principal.issuer,
      principalSubject:principal.subject,verifiedEmail:principal.email,cursor:"opaque-cursor"});
    expect(await response.json()).toMatchObject({workspaceId:context.workspaceId,items:[],nextCursor:null});
  });
  it("requires both new migration tables and a supported RPC before exposing the new route",async()=>{
    expect((await app(1)("/viewer")).status).toBe(404);expect(mock.list).not.toHaveBeenCalled();
  });
  it("rejects arbitrary filters and duplicate cursors",async()=>{
    expect((await app()("/viewer?sourceId=project-alpha:other")).status).toBe(400);
    expect((await app()("/viewer?cursor=a&cursor=b")).status).toBe(400);expect(mock.list).not.toHaveBeenCalled();
  });
  it("never returns a list if account access changed during the RPC",async()=>{
    mock.context.mockResolvedValueOnce(context).mockResolvedValueOnce({...context,contextVersion:"b".repeat(64)});
    expect((await app()("/viewer")).status).toBe(409);
  });
  it("issues an exact-task session and does not accept browser-supplied identity or permissions",async()=>{
    const request=app();expect((await request("/viewer/grant-one/tasks/task-one/session",post())).status).toBe(201);
    expect(mock.issue).toHaveBeenCalledWith(expect.objectContaining({grantId:"grant-one",taskId:"task-one",identityId:"identity-one"}));
    expect((await request("/viewer/grant-one/tasks/task-one/session",post({displayUnits:"imperial",download:true}))).status).toBe(404);
    expect(mock.issue).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-origin requests and inaccessible task handles",async()=>{
    expect((await app()("/viewer/grant-one/tasks/task-one/session",post(undefined,"https://evil.example.test"))).status).toBe(403);
    expect(mock.issue).not.toHaveBeenCalled();mock.issue.mockResolvedValue({ok:false,protocolVersion:1,code:"denied"});
    expect((await app()("/viewer/grant-one/tasks/task-other/session",post())).status).toBe(404);
  });
});
