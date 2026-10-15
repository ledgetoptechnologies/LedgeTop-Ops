import {beforeEach,describe,expect,it,vi} from "vitest";
import {handleOperationsPortalNativeBillingSourceAuthorityOwnerHttp as handle,
 type OperationsPortalNativeBillingSourceAuthorityOwnerHttpDependencies as Dependencies} from "../src/worker/operations-portal-native-billing-source-authority-owner-http";
import {sameNativeBillingSourceIdentity} from "../src/worker/operations-portal-native-billing-source-context";
import {parseNativeBillingSourceContext} from "../../../packages/shared/src/operations-portal-native-billing-source-authority";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const origin="https://ops-staging.example.test",base=origin+"/api/native-client-portal/operations-billing-source-authority";
const actor={identity:{kind:"native" as const,staffId:"billing-manager",verifiedAccessSubject:"access|manager",
 email:"manager@example.invalid",displayName:"Manager",profileVersion:2},admissionVersion:3,verifiedUntil:"2099-01-01T00:00:00.000Z"};
const selection={parentGrantId:id(1),sourceId:"project-alpha:staging"};
const context={sourceId:selection.sourceId,sourceInstanceId:id(2),applicationId:id(3),historyEpochId:id(4),origin:"https://pa.example.test",
 kind:"client" as const,externalId:"client-1",publicId:"a".repeat(32),mappingKind:"acquired",mappingProvenanceId:id(5),
 revision:"1",projectionSha256:"a".repeat(64),authorizationGeneration:"0",conflictRevision:"0"};
const authority={...selection,grantId:id(6),revision:1,state:"active",live:true};
const review={...selection,grantId:null,expectedRevision:0,reviewFingerprint:"a".repeat(64),context};
const authenticate=vi.fn(),core={review:vi.fn(),grant:vi.fn(),revoke:vi.fn(),readStatus:vi.fn()};
const deps=():Dependencies=>({environment:"staging",expectedHost:"ops-staging.example.test",lifecycleFlag:"true",
 configuration:{enabled:true,origin,issuer:"https://team.cloudflareaccess.com",staffAudience:"a".repeat(16),csrfSecret:"source-owner-csrf-test-secret-long-enough"},
 database:{} as D1Database,authenticate,core});
function request(path:string,value?:unknown,headers:Record<string,string>={}){
 return new Request(base+"/"+path,{method:value===undefined?"GET":"POST",headers:{Origin:origin,"Sec-Fetch-Site":"same-origin",
 "X-Native-Staff-Request":"1","Content-Type":"application/json",...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
}
async function token(d:Dependencies){const r=await handle(request("session"),d);expect(r.status).toBe(200);
 return (await r.json() as {csrfToken:string}).csrfToken;}
describe("source-qualified native billing owner boundary",()=>{
 beforeEach(()=>{vi.clearAllMocks();authenticate.mockResolvedValue(actor);core.review.mockResolvedValue({...review,apiKey:"SECRET"});
 core.grant.mockResolvedValue({status:"applied",operationId:id(7),authority:{...authority,apiKey:"SECRET"}});
 core.readStatus.mockResolvedValue({...authority,canonicalWire:"SECRET"});});
 it("requires ordinary native authentication, same origin and source-family CSRF before review",async()=>{
  const d=deps(),csrf=await token(d);
  expect((await handle(request("review",selection),d)).status).toBe(403);
  expect((await handle(request("review",selection,{"X-CSRF-Token":csrf,Origin:"https://evil.example.test"}),d)).status).toBe(403);
  authenticate.mockRejectedValueOnce(Error("denied"));
  expect((await handle(request("review",selection,{"X-CSRF-Token":csrf}),d)).status).toBe(403);
  expect(core.review).not.toHaveBeenCalled();
 });
 it("reviews only source alias selection, excludes secrets, and refuses caller PA identity/selector fields",async()=>{
  const d=deps(),csrf=await token(d),headers={"X-CSRF-Token":csrf};
  const r=await handle(request("review",selection,headers),d);expect(r.status).toBe(200);
  expect(await r.json()).toEqual({review});
  for(const extra of [{publicId:"b".repeat(32)},{sourceInstanceId:id(9)},{context},{apiKey:"secret"}])
    expect((await handle(request("review",{...selection,...extra},headers),d)).status).toBe(400);
  expect(core.review).toHaveBeenCalledTimes(1);
 });
 it("requires confirmation/review CAS and returns only the child grant identity",async()=>{
  const d=deps(),csrf=await token(d),headers={"X-CSRF-Token":csrf};
  const body={confirm:true,...selection,operationId:id(7),grantId:id(6),expectedRevision:0,reviewFingerprint:"a".repeat(64)};
  expect((await handle(request("grants",{...body,confirm:false},headers),d)).status).toBe(400);
  expect((await handle(request("grants",{...body,expectedRevision:1.5},headers),d)).status).toBe(400);
  const r=await handle(request("grants",body,headers),d);expect(r.status).toBe(200);
  expect(await r.json()).toEqual({operationId:id(7),status:"applied",authority});
  core.grant.mockResolvedValueOnce({status:"conflict"});
  expect((await handle(request("grants",body,headers),d)).status).toBe(409);
 });
 it("does not borrow CSRF across staff admission changes or disclose invalid core output",async()=>{
  const d=deps(),csrf=await token(d);
  authenticate.mockResolvedValueOnce({...actor,admissionVersion:4});
  expect((await handle(request("review",selection,{"X-CSRF-Token":csrf}),d)).status).toBe(403);
  core.review.mockResolvedValueOnce({...review,context:{...context,apiKey:"SECRET"}});
  const r=await handle(request("review",selection,{"X-CSRF-Token":csrf}),d);expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("SECRET");
 });
 it("preserves default-off and authenticated no-store status behavior",async()=>{
  expect((await handle(request("session"),{...deps(),lifecycleFlag:"false"})).status).toBe(404);
  const r=await handle(request(`grants/${id(6)}`),deps());expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");expect(await r.json()).toEqual({authority});
 });
 it("revokes only the path-selected child with exact CAS and preserves replay status without exposing internal context",async()=>{
  const d=deps(),csrf=await token(d),headers={"X-CSRF-Token":csrf};
  const revoked={...authority,state:"revoked",revision:2,live:false};
  core.revoke.mockResolvedValueOnce({status:"replayed",operationId:id(7),authority:{...revoked,context,canonicalWire:"SECRET"}});
  const body={confirm:true,operationId:id(7),expectedRevision:1};
  expect((await handle(request(`grants/${id(6)}/revoke`,{...body,grantId:id(9)},headers),d)).status).toBe(400);
  const r=await handle(request(`grants/${id(6)}/revoke`,body,headers),d);expect(r.status).toBe(200);
  expect(core.revoke).toHaveBeenCalledWith(d.database,actor,{operationId:id(7),grantId:id(6),expectedRevision:1});
  expect(await r.json()).toEqual({operationId:id(7),status:"replayed",authority:revoked});
 });
 it("keeps source ownership stable across ordinary freshness changes while rejecting identity changes",()=>{
  expect(parseNativeBillingSourceContext(context)).toEqual(context);
  expect(sameNativeBillingSourceIdentity(context,{...context,revision:"2",projectionSha256:"b".repeat(64),authorizationGeneration:"8"})).toBe(true);
  for(const changed of [{sourceInstanceId:id(8)},{origin:"https://other.example.test"},{publicId:"c".repeat(32)},
   {mappingProvenanceId:id(9)},{historyEpochId:id(9)}])expect(sameNativeBillingSourceIdentity(context,{...context,...changed})).toBe(false);
 });
});
