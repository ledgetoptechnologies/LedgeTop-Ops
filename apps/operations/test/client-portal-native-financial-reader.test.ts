import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({resolve:vi.fn(),read:vi.fn(),selector:vi.fn()}));
vi.mock("../src/worker/project-alpha-financial-mapping",()=>({resolveTrustedNativeFinancialMapping:mocks.resolve}));
vi.mock("../src/worker/project-alpha-financial-transport",()=>({
  selectorFromTrustedFinancialMapping:mocks.selector,
  readConfiguredProjectAlphaFinancialDocuments:mocks.read,
}));
import { readClientPortalNativeFinancialDocuments } from "../src/worker/client-portal-native-financial-reader";

const input={protocolVersion:1 as const,authorityId:"10000000-0000-4000-8000-000000000001",workspaceId:"workspace-1",
  ownershipEpoch:2,grantRevision:3,issuer:"https://issuer.example.test",subject:"recipient-subject",
  grantId:"20000000-0000-4000-8000-000000000002"};
const row={grant_id:input.grantId,revision:1,entity_kind:"project",native_entity_id:"project/one"};
const mapping={sourceId:"project-alpha:primary",kind:"project",externalId:"project/one",
  publicId:"30000000-0000-4000-8000-000000000003",revision:"4",projectionSha256:"a".repeat(64),authorizationGeneration:"5"};
const collection={selector:{kind:"project",externalId:"project/one",publicId:mapping.publicId,revision:"4",
  projectionSha256:"a".repeat(64),authorizationGeneration:"5"},snapshotSha256:"b".repeat(64),documents:[]};

function database(rows:(typeof row|null)[]):D1Database {
  return {withSession:()=>({prepare:()=>({bind:()=>({all:async()=>({results:(()=>{const value=rows.shift();return value?[value]:[];})()})})})})} as unknown as D1Database;
}

describe("private native financial reader",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.resolve.mockResolvedValue(mapping);mocks.selector.mockReturnValue(collection.selector);
    mocks.read.mockResolvedValue({status:"ok",value:collection});});
  it("fails closed unless explicitly enabled and rejects non-exact request shapes",async()=>{
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([])} as never,input)).resolves.toEqual({status:"disabled"});
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([]),CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"} as never,
      {...input,extra:true})).resolves.toEqual({status:"denied"});
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("derives the selector from live authority and rechecks authority and mapping after transport",async()=>{
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([row,row,row]),
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"} as never,input)).resolves.toEqual({status:"ok",grantId:input.grantId,revision:1,value:collection});
    expect(mocks.resolve).toHaveBeenNthCalledWith(1,expect.anything(),{kind:"project",externalProjectId:"project/one"});
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("does not disclose fetched documents when recipient authority is revoked during transport",async()=>{
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([row,null]),
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"} as never,input)).resolves.toEqual({status:"denied"});
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("does not disclose when the trusted native mapping changes during transport",async()=>{
    mocks.resolve.mockResolvedValueOnce(mapping).mockResolvedValueOnce({...mapping,revision:"5"});
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([row,row,row]),
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"} as never,input)).resolves.toEqual({status:"denied"});
  });
  it("rechecks authority after the second asynchronous mapping resolution",async()=>{
    await expect(readClientPortalNativeFinancialDocuments({OPS_DB:database([row,row,null]),
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"} as never,input)).resolves.toEqual({status:"denied"});
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });
});
