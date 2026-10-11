import {beforeEach,describe,expect,it,vi} from "vitest";
import {handleOperationsPortalNativeBillingPermissionOwnerHttp as handle,
  type OperationsPortalNativeBillingPermissionOwnerHttpDependencies as Dependencies} from "../src/worker/operations-portal-native-billing-permission-owner-http";
import {manageOperationsPortalNativeBillingPermission} from "../src/worker/operations-portal-native-billing-permission-issuer";
import {runCanonicalPortalResourceAcceptance} from "./helpers/operations-native-portal-resource-acceptance-fixture";
const origin="https://ops-staging.ledgetopdroneservices.com",base="/api/native-client-portal/operations-billing-permissions";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const actor={identity:{kind:"native" as const,staffId:"owner",verifiedAccessSubject:"access|owner",email:"owner@example.test",displayName:"Owner",profileVersion:1},admissionVersion:1,verifiedUntil:"2099-01-01T00:00:00.000Z"};
const authenticate=vi.fn(),manage=vi.fn<typeof manageOperationsPortalNativeBillingPermission>();
let allowed=true,grantExists=true,rows:Record<string,unknown>[]=[],lastManagerValues:unknown[]=[];
const prepare=vi.fn((sql:string)=>{
  let values:unknown[]=[];
  const statement={bind:(...args:unknown[])=>{values=args;return statement;},first:async()=>{
    if(sql.includes("SELECT 1 ok")){lastManagerValues=values;return allowed?{ok:1}:null;}
    if(sql.includes("COALESCE"))return {generation:0};
    if(sql.includes("SELECT resource_id"))return grantExists?{resource_id:"root-one"}:null;
    throw Error("unexpected test query");
  },all:async()=>({results:rows})};return statement;
});
const database: D1Database={
  withSession:()=>({prepare:(query:string)=>prepare(query) as D1PreparedStatement,
    batch:async()=>{throw Error("unexpected batch");},getBookmark:()=>null}),
  prepare:vi.fn<D1Database["prepare"]>(),batch:async()=>{throw Error("unexpected batch");},
  exec:vi.fn<D1Database["exec"]>(),dump:vi.fn<D1Database["dump"]>(),
};
function deps():Dependencies{return {environment:"staging",expectedHost:"ops-staging.ledgetopdroneservices.com",delegationFlag:"true",database,
  configuration:{enabled:true,origin,issuer:"https://team.cloudflareaccess.com",staffAudience:"a".repeat(16),csrfSecret:"synthetic-test-csrf-secret-long-enough"},authenticate,manage};}
function request(route:string,value?:unknown,headers:Record<string,string>={}){return new Request(`${origin}${base}/${route}`,{
  method:value===undefined?"GET":"POST",headers:{Origin:origin,"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1","Content-Type":"application/json",...headers},
  ...(value===undefined?{}:{body:JSON.stringify(value)})});}
async function token(d:Dependencies){const response=await handle(request("session"),d);expect(response.status).toBe(200);return(await response.json() as {csrfToken:string}).csrfToken;}
const issue={confirm:true,operationId:id(1),grantId:id(2),expectedGeneration:0,staffId:"manager-one",effect:"allow",resourceId:"root-one"};
describe("resource-scoped billing permission owner HTTP",()=>{
  beforeEach(()=>{vi.clearAllMocks();allowed=true;grantExists=true;rows=[];lastManagerValues=[];authenticate.mockResolvedValue(actor);
    manage.mockResolvedValue({status:"applied",operationId:id(1),grantId:id(2),generation:1});});
  it("is default-off, staging-only, fixed-host before any authentication",async()=>{
    for(const d of [{...deps(),environment:"production"},{...deps(),delegationFlag:"false"},{...deps(),expectedHost:"ops-staging.example.test"},
      {...deps(),configuration:{...deps().configuration,origin:"https://ops-staging.example.test"}}])expect((await handle(request("session"),d)).status).toBeGreaterThanOrEqual(400);
    expect(authenticate).not.toHaveBeenCalled();expect(manage).not.toHaveBeenCalled();
  });
  it("session conveys CSRF but no owner privilege or permission data",async()=>{
    allowed=false;const d=deps(),csrf=await token(d);expect(prepare).not.toHaveBeenCalled();
    expect((await handle(request("review",{staffId:"manager-one",resourceId:"root-one"},{"X-CSRF-Token":csrf}),d)).status).toBe(403);
    expect(manage).not.toHaveBeenCalled();
  });
  it("requires native auth, same origin, nonexpired actor and actor-bound CSRF",async()=>{
    const d=deps();authenticate.mockRejectedValueOnce(Error("private assertion"));expect((await handle(request("session"),d)).status).toBe(403);
    expect((await handle(request("session",undefined,{"Sec-Fetch-Site":"cross-site"}),d)).status).toBe(403);
    const csrf=await token(d);expect((await handle(request("grants",issue),d)).status).toBe(403);
    expect((await handle(request("grants",issue,{"X-CSRF-Token":csrf,Origin:"https://other.example.test"}),d)).status).toBe(403);
    authenticate.mockResolvedValueOnce({...actor,admissionVersion:2});expect((await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d)).status).toBe(403);
    authenticate.mockResolvedValueOnce({...actor,verifiedUntil:"2000-01-01T00:00:00.000Z"});expect((await handle(request("session"),d)).status).toBe(403);
    expect(manage).not.toHaveBeenCalled();
  });
  it("reads only the exact target/resource and redacts rows with no subjects/proofs",async()=>{
    rows=[{grant_id:id(2),effect:"deny",scope_kind:"global",resource_id:null,revoked:0,privateProof:"DO_NOT_RETURN"}];
    const d=deps(),csrf=await token(d),response=await handle(request("review",{staffId:"manager-one",resourceId:"root-one"},{"X-CSRF-Token":csrf}),d);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({review:{staffId:"manager-one",resourceId:"root-one",generation:0,permissions:[]}});
    expect(lastManagerValues.at(-1)).toBe("root-one");
    expect(prepare.mock.calls.some(([sql])=>sql.includes("g.scope_kind='resource' AND g.resource_id=?"))).toBe(true);
    expect(prepare.mock.calls.some(([sql])=>sql.includes("p.scope_kind='resource' AND p.resource_id=?"))).toBe(true);
  });
  it("does not let historical revoked rows exhaust the current review bound",async()=>{
    rows=Array.from({length:101},()=>({grant_id:id(2),effect:"allow",scope_kind:"resource",resource_id:"root-one",revoked:1}));
    const d=deps(),csrf=await token(d),response=await handle(request("review",{staffId:"manager-one",resourceId:"root-one"},{"X-CSRF-Token":csrf}),d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({review:{staffId:"manager-one",resourceId:"root-one",generation:0,permissions:[]}});
    expect(prepare.mock.calls.some(([sql])=>sql.includes("AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations r WHERE r.grant_id=p.grant_id)"))).toBe(true);
  });
  it("issues only resource scope using immutable explicit IDs/generation",async()=>{
    const d=deps(),csrf=await token(d),response=await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({status:"applied",operationId:id(1),grantId:id(2),generation:1});
    expect(manage).toHaveBeenCalledWith(database,actor,{action:"issue",operationId:id(1),grantId:id(2),expectedGeneration:0,
      staffId:"manager-one",effect:"allow",scope:{kind:"resource",resourceId:"root-one"}});
  });
  it("rejects global scope, coercion, extras, missing confirmation, and oversized bodies",async()=>{
    const d=deps(),csrf=await token(d);
    for(const value of [{...issue,scope:{kind:"global",resourceId:null}},{...issue,confirm:false},{...issue,expectedGeneration:"0"},
      {...issue,expectedGeneration:Number.MAX_SAFE_INTEGER},{...issue,effect:"admin"},{...issue,staffId:"x".repeat(192)},{...issue,actorProof:{}},
      {...issue,resourceId:"x".repeat(3000)}])expect((await handle(request("grants",value,{"X-CSRF-Token":csrf}),d)).status).toBe(400);
    expect(manage).not.toHaveBeenCalled();
  });
  it("refuses relevant resource deny before review/issue/revoke and derives revoke scope from immutable grant",async()=>{
    const d=deps(),csrf=await token(d);allowed=false;
    for(const [route,value] of [["review",{staffId:"manager-one",resourceId:"root-one"}],["grants",issue],
      [`grants/${id(2)}/revoke`,{confirm:true,operationId:id(1),expectedGeneration:0}]] as const)
      expect((await handle(request(route,value,{"X-CSRF-Token":csrf}),d)).status).toBe(403);
    expect(manage).not.toHaveBeenCalled();allowed=true;
    expect((await handle(request(`grants/${id(2)}/revoke`,{confirm:true,operationId:id(1),expectedGeneration:0},{"X-CSRF-Token":csrf}),d)).status).toBe(200);
    expect(lastManagerValues.at(-1)).toBe("root-one");
    expect(manage).toHaveBeenCalledWith(database,actor,{action:"revoke",operationId:id(1),grantId:id(2),expectedGeneration:0});
    grantExists=false;expect((await handle(request(`grants/${id(2)}/revoke`,{confirm:true,operationId:id(1),expectedGeneration:0},{"X-CSRF-Token":csrf}),d)).status).toBe(403);
  });
  it("redacts core conflicts, exceptions, and rejects mismatched receipts/overflow",async()=>{
    const d=deps(),csrf=await token(d);
    manage.mockResolvedValueOnce({status:"conflict",reason:"authority"});expect((await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d)).status).toBe(403);
    manage.mockResolvedValueOnce({status:"conflict",reason:"generation"});expect((await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d)).status).toBe(409);
    manage.mockRejectedValueOnce(Error("private secret"));const failed=await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d);expect(await failed.json()).toEqual({error:"unavailable"});
    manage.mockResolvedValueOnce({status:"replayed",operationId:id(3),grantId:id(2),generation:1});expect((await handle(request("grants",issue,{"X-CSRF-Token":csrf}),d)).status).toBe(503);
    rows=Array.from({length:101},()=>({grant_id:id(2),effect:"allow",scope_kind:"resource",resource_id:"root-one",revoked:0}));
    expect((await handle(request("review",{staffId:"manager-one",resourceId:"root-one"},{"X-CSRF-Token":csrf}),d)).status).toBe(503);
  });
});
describe("billing permission HTTP with canonical real D1",{timeout:300_000},()=>{
  it("uses the unchanged normal issuer for exact resource issue, replay and revoke",async()=>{
    await runCanonicalPortalResourceAcceptance(async context=>{
      const {owner,operations,workspace,id}=context;
      const d:Dependencies={...deps(),database:operations,manage:undefined,authenticate:vi.fn().mockResolvedValue(owner)};
      const csrf=await token(d),headers={"X-CSRF-Token":csrf},selected={staffId:owner.identity.staffId,resourceId:workspace.rootRecordId};
      const before=await handle(request("review",selected,headers),d);expect(before.status).toBe(200);
      expect((await before.json() as {review:{generation:number}}).review.generation).toBe(0);
      const input={...selected,confirm:true,operationId:id(),grantId:id(),expectedGeneration:0,effect:"allow"};
      expect((await handle(request("grants",input,headers),d)).status).toBe(200);
      const replayed=await handle(request("grants",input,headers),d);expect((await replayed.json() as {status:string}).status).toBe("replayed");
      const revoked=await handle(request(`grants/${input.grantId}/revoke`,{confirm:true,operationId:id(),expectedGeneration:1},headers),d);
      expect(revoked.status).toBe(200);
      const after=await handle(request("review",selected,headers),d);
      expect(await after.json()).toEqual({review:{...selected,generation:2,permissions:[]}});
      expect((await operations.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    },{stopAfterReady:true});
  });
});
