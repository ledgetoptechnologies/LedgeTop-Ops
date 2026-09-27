import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
vi.mock("../src/worker/client-portal-authority-v2",()=>({writeClientPortalAuthorityV2:vi.fn(),readClientPortalAuthorityV2Status:vi.fn()}));
import {readClientPortalAuthorityV2Status,writeClientPortalAuthorityV2} from "../src/worker/client-portal-authority-v2";
import {applyClientPortalAuthorityV2,getClientPortalAuthorityV2Status} from "../src/worker/client-portal-authority-v2-entrypoint";

const writer=vi.mocked(writeClientPortalAuthorityV2),reader=vi.mocked(readClientPortalAuthorityV2Status);
const env={CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED:"true",DELIVERY_DB:{} as D1Database};
const command={protocolVersion:2,operationId:"grant-1",clientAuthorityId:"22222222-2222-4222-8222-222222222222",
  workspaceId:"workspace-a",bindingOperationId:"bind-1",issuer:"https://access.example.test",subject:"person-1",
  desiredState:"active",expectedOwnershipEpoch:0,expectedGrantRevision:0,scopes:[]};
describe("portal authority v2 private entrypoint",()=>{
  beforeEach(()=>{writer.mockReset();reader.mockReset();});
  it("accepts only exact empty-scope protocol v2 commands",async()=>{
    writer.mockResolvedValueOnce({operationId:"grant-1",clientAuthorityId:command.clientAuthorityId,workspaceId:"workspace-a",
      issuer:command.issuer,subject:"person-1",ownershipEpoch:1,grantRevision:1,state:"active",replayed:false});
    await expect(applyClientPortalAuthorityV2(env,command)).resolves.toMatchObject({ok:true,protocolVersion:2,status:"recorded",grantRevision:1});
    for(const invalid of [{...command,protocolVersion:1},{...command,scopes:["workspace.view"]},{...command,extra:true}])
      await expect(applyClientPortalAuthorityV2(env,invalid)).resolves.toMatchObject({ok:false,code:"invalid"});
  });
  it("maps conflicts and supports exact status recovery",async()=>{
    writer.mockRejectedValueOnce(new Error("client-portal-authority-v2-cas-conflict"));
    await expect(applyClientPortalAuthorityV2(env,command)).resolves.toMatchObject({ok:false,code:"conflict"});
    reader.mockResolvedValueOnce({operationId:"grant-1",clientAuthorityId:command.clientAuthorityId,workspaceId:"workspace-a",
      issuer:command.issuer,subject:"person-1",ownershipEpoch:1,grantRevision:1,state:"active"});
    await expect(getClientPortalAuthorityV2Status(env,{protocolVersion:2,operationId:"grant-1"}))
      .resolves.toMatchObject({ok:true,status:"recorded",grantRevision:1});
  });
});
