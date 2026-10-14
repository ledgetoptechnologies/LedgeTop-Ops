import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({homes:vi.fn()}));
vi.mock("../src/worker/client-portal/operations-native-recipient-read",()=>({readNativeOperationsPortalHomes:mocks.homes}));
import {createOperationsHomeRouter} from "../src/worker/client-portal/operations-home-routes";
import type {Env} from "../src/worker/types";

const authorityId="10000000-0000-4000-8000-000000000001",principal={issuer:"https://issuer.example.test",subject:"subject-1",email:"client@example.test"};
const home={authorityId,workspaceId:"workspace-1",ownershipEpoch:2,grantRevision:3};
const document={publicId:"doc-1",kind:"contract",status:"pending",currency:"USD",total:"0.00",amountPaid:null,balanceDue:null,
  documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",actionUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop"};
const rpc=vi.fn(async()=>JSON.stringify({ok:true,protocolVersion:1,...home,collections:[{status:"ok",
  grantId:"20000000-0000-4000-8000-000000000002",revision:1,value:{selector:{},snapshotSha256:"a".repeat(64),documents:[document]}}]}));
const env={CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED:"true",
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:"true",CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED:"true",
  CLIENT_PORTAL_ORIGIN:"https://client.example.test",DELIVERY_DB:{},
  CLIENT_PORTAL_NATIVE_FINANCIAL_READER:{readFinancialDocuments:rpc}} as unknown as Env;

describe("authenticated native financial route",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.homes.mockResolvedValue([home]);});
  it("derives recipient identity and returns only the verified private response",async()=>{
    const response=await createOperationsHomeRouter({resolvePrincipal:async()=>principal}).fetch(
      new Request(`https://client.example.test/home/${authorityId}/financial`),env);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({resourceMode:"operations_financial",
      collections:[{grantId:"20000000-0000-4000-8000-000000000002",revision:1,documents:[document]}]});
    expect(rpc).toHaveBeenCalledWith({protocolVersion:1,...home,issuer:principal.issuer,subject:principal.subject});
  });
  it("is default-off and denies a principal without the selected native home",async()=>{
    const router=createOperationsHomeRouter({resolvePrincipal:async()=>principal});
    expect((await router.fetch(new Request(`https://client.example.test/home/${authorityId}/financial`),
      {...env,CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED:"false"})).status).toBe(404);
    mocks.homes.mockResolvedValue([]);
    expect((await router.fetch(new Request(`https://client.example.test/home/${authorityId}/financial`),env)).status).toBe(403);
  });
  it("retains overlapping document IDs under separate grants in one home and drops removed-grant links on the next read",async()=>{
    const secondGrant="30000000-0000-4000-8000-000000000003";
    const first={status:"ok",grantId:"20000000-0000-4000-8000-000000000002",revision:1,
      value:{selector:{},snapshotSha256:"a".repeat(64),documents:[document]}};
    const secondDocument={...document,documentUrl:"https://pa-two.example.test/?page=public-doc&token=abcdefghijklmnop",
      actionUrl:"https://pa-two.example.test/?page=public-doc&token=abcdefghijklmnop"};
    const second={...first,grantId:secondGrant,value:{...first.value,documents:[secondDocument]}};
    const envelope=(collections:unknown[])=>JSON.stringify({ok:true,protocolVersion:1,...home,collections});
    rpc.mockResolvedValueOnce(envelope([first,second])).mockResolvedValueOnce(envelope([first]));
    const router=createOperationsHomeRouter({resolvePrincipal:async()=>principal});
    const read=()=>router.fetch(new Request(`https://client.example.test/home/${authorityId}/financial`),env);
    const response=await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({resourceMode:"operations_financial",collections:[
      {grantId:first.grantId,revision:1,documents:[document]},
      {grantId:secondGrant,revision:1,documents:[secondDocument]},
    ]});
    const after=await read();
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({resourceMode:"operations_financial",collections:[
      {grantId:first.grantId,revision:1,documents:[document]},
    ]});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(after.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("maps an exact upstream denial to the non-provisioned response without leaking data",async()=>{
    rpc.mockResolvedValueOnce(JSON.stringify({ok:false,protocolVersion:1,code:"denied"}));
    const response=await createOperationsHomeRouter({resolvePrincipal:async()=>principal}).fetch(
      new Request(`https://client.example.test/home/${authorityId}/financial`),env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:"Client access is not provisioned"});
  });
  it("keeps malformed and non-denial upstream failures unavailable without leaking data",async()=>{
    const router=createOperationsHomeRouter({resolvePrincipal:async()=>principal});
    for(const upstream of [{ok:false,protocolVersion:1,code:"unavailable"},
      {ok:false,protocolVersion:1,code:"denied",privateNote:"must-not-cross"}]){
      rpc.mockResolvedValueOnce(JSON.stringify(upstream));
      const response=await router.fetch(new Request(`https://client.example.test/home/${authorityId}/financial`),env);
      expect(response.status).toBe(503);
      const body=await response.text();
      expect(body).toBe('{"error":"Client financial information is temporarily unavailable"}');
      expect(body).not.toContain("must-not-cross");
    }
  });
});
