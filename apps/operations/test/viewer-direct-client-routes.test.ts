import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";
const mock=vi.hoisted(()=>({list:vi.fn(),create:vi.fn(),revoke:vi.fn(),enabled:vi.fn()}));
vi.mock("../src/worker/viewer-direct-client-grants",async original=>({
  ...await original<typeof import("../src/worker/viewer-direct-client-grants")>(),
  listDirectViewerClientGrantWorkspace:mock.list,createDirectViewerClientGrant:mock.create,revokeDirectViewerClientGrant:mock.revoke}));
vi.mock("../src/worker/viewer-integration",()=>({viewerIntegrationEnabled:mock.enabled}));
import { registerDirectViewerClientRoutes } from "../src/worker/viewer-direct-client-routes";
import { DirectViewerGrantError } from "../src/worker/viewer-direct-client-grants";

function app(){
 const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
 app.use("*",async(c,next)=>{c.set("principal",{id:"staff-one",displayName:"Staff",email:"staff@example.test",accessSubject:"staff-one",projectAlphaUserId:null});
  c.set("administrator",true);await next();});
 registerDirectViewerClientRoutes(app);
 return (path="",init?:RequestInit)=>app.request(`https://ops.example.test/api/viewer/direct-client-grants${path}`,init,
  {CLIENT_VIEWER_SESSION_ISSUER_ENABLED:"true"} as unknown as Env);
}
const mutation=(method="POST",value:unknown={}):RequestInit=>({method,headers:{"Content-Type":"application/json","Idempotency-Key":"direct-route-key-0001"},body:JSON.stringify(value)});
beforeEach(()=>{vi.resetAllMocks();mock.enabled.mockReturnValue(true);mock.list.mockResolvedValue({clients:[],clientsNextCursor:null,grants:[]});
 mock.create.mockResolvedValue({grant:{grantId:"grant-one"},replayed:false});mock.revoke.mockResolvedValue({success:true,replayed:false,sessionRevocation:{pending:false}});});
describe("staff direct Viewer grant routes",()=>{
 it("passes only bounded search fields and authenticated principal to the picker",async()=>{
  const response=await app()("?q=Client&limit=25&viewerProjectId=project-one");expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mock.list).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:"staff-one"}),{q:"Client",limit:25,viewerProjectId:"project-one"});
 });
 it("rejects unbounded or ambiguous picker queries before reading records",async()=>{
  const request=app();for(const query of ["?limit=51","?q=a&q=b","?sourceId=other"])
   expect((await request(query)).status).toBe(400);expect(mock.list).not.toHaveBeenCalled();
 });
 it("keeps the additive surface closed when the Viewer integration is disabled",async()=>{
  mock.enabled.mockReturnValue(false);expect((await app()()).status).toBe(404);
  expect((await app()("/grant-one",mutation("DELETE",{}))).status).toBe(404);
  expect(mock.list).not.toHaveBeenCalled();expect(mock.revoke).not.toHaveBeenCalled();
 });
 it("rejects oversized request bodies before grant creation",async()=>{
  expect((await app()("",mutation("POST",{value:"x".repeat(17_000)}))).status).toBe(413);expect(mock.create).not.toHaveBeenCalled();
 });
 it("requires an idempotency key before a mutation",async()=>{
  expect((await app()("",{method:"POST",body:"{}"})).status).toBe(400);expect(mock.create).not.toHaveBeenCalled();
 });
 it("preserves a safe error code and existing grant ID for a duplicate",async()=>{
  mock.create.mockRejectedValue(new DirectViewerGrantError(409,"duplicate_active_grant","Client already has this share","grant-existing"));
  const response=await app()("",mutation());expect(response.status).toBe(409);
  expect(await response.json()).toEqual({error:"Client already has this share",code:"duplicate_active_grant",grantId:"grant-existing"});
 });
 it("accurately distinguishes pending revocation from completed idempotent revocation",async()=>{
  mock.revoke.mockResolvedValueOnce({success:true,replayed:false,sessionRevocation:{pending:true}});
  const request=app();expect((await request("/grant-one",mutation("DELETE",{}))).status).toBe(202);
  mock.revoke.mockResolvedValueOnce({success:true,replayed:true,sessionRevocation:{pending:false}});
  expect((await request("/grant-one",mutation("DELETE",{reason:"Owner request"}))).status).toBe(200);
  expect(mock.revoke.mock.calls[0]![0]).toMatchObject({grantId:"grant-one",reason:"Revoked by staff"});
 });
});
