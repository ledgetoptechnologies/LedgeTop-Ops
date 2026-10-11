import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({homes:vi.fn()}));
vi.mock("../src/worker/client-portal/operations-native-recipient-read",()=>({readNativeOperationsPortalHomes:mocks.homes}));
import { readPortalFinancialDocuments } from "../src/worker/client-portal/operations-financial";

const authorityId="10000000-0000-4000-8000-000000000001";
const home={authorityId,workspaceId:"workspace-1",ownershipEpoch:2,grantRevision:3};
const principal={issuer:"https://issuer.example.test",subject:"recipient-1"};
const success=JSON.stringify({ok:true,protocolVersion:1,...home,collections:[{status:"ok",
  grantId:"20000000-0000-4000-8000-000000000002",revision:1,value:{selector:{},snapshotSha256:"a".repeat(64),documents:[{publicId:"doc-1",kind:"invoice",
    status:"unpaid",currency:"USD",total:"10.00",amountPaid:"0.00",balanceDue:"10.00",
    documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
    actionUrl:"https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop"}]}}]});
const env=(rpc=vi.fn(async()=>success))=>({DELIVERY_DB:{} as D1Database,
  CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED:"true",CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED:"true",
  CLIENT_PORTAL_NATIVE_FINANCIAL_READER:{readFinancialDocuments:rpc}});

describe("Client private native financial consumer",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.homes.mockResolvedValue([home]);});
  it("derives recipient identity from the verified principal and rechecks the home after RPC",async()=>{
    const rpc=vi.fn(async()=>success);
    await expect(readPortalFinancialDocuments(env(rpc),principal,authorityId)).resolves.toMatchObject({ok:true,
      collections:[{documents:[{kind:"invoice",status:"unpaid"}]}]});
    expect(rpc).toHaveBeenCalledWith({protocolVersion:1,...home,issuer:principal.issuer,subject:principal.subject});
    expect(mocks.homes).toHaveBeenCalledTimes(2);
  });
  it("fails closed when disabled or when the requested authority is not the principal's current home",async()=>{
    await expect(readPortalFinancialDocuments({DELIVERY_DB:{} as D1Database},principal,authorityId))
      .resolves.toEqual({ok:false,code:"disabled"});
    mocks.homes.mockResolvedValue([]);
    await expect(readPortalFinancialDocuments(env(),principal,authorityId)).resolves.toEqual({ok:false,code:"denied"});
  });
  it("discards a valid private response if recipient authority changes while it is in flight",async()=>{
    mocks.homes.mockResolvedValueOnce([home]).mockResolvedValueOnce([]);
    await expect(readPortalFinancialDocuments(env(),principal,authorityId)).resolves.toEqual({ok:false,code:"denied"});
  });
  it("rejects a response whose echoed authority differs",async()=>{
    await expect(readPortalFinancialDocuments(env(vi.fn(async()=>success.replace("workspace-1","workspace-2"))),principal,authorityId))
      .resolves.toEqual({ok:false,code:"unavailable"});
  });
  it("rejects unsafe document links at the server-side Client boundary",async()=>{
    await expect(readPortalFinancialDocuments(env(vi.fn(async()=>success.replace(
      "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop","javascript:alert(1)"))),principal,authorityId))
      .resolves.toEqual({ok:false,code:"unavailable"});
  });
  it("rejects unexpected private fields and duplicate grants instead of forwarding them",async()=>{
    await expect(readPortalFinancialDocuments(env(vi.fn(async()=>success.replace('"publicId":"doc-1"','"publicId":"doc-1","privateNote":"secret"'))),principal,authorityId))
      .resolves.toEqual({ok:false,code:"unavailable"});
    const parsed=JSON.parse(success) as {collections:unknown[]};parsed.collections.push(parsed.collections[0]);
    await expect(readPortalFinancialDocuments(env(vi.fn(async()=>JSON.stringify(parsed))),principal,authorityId))
      .resolves.toEqual({ok:false,code:"unavailable"});
  });
});
