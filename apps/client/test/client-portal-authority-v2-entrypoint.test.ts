import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
vi.mock("../src/worker/client-portal-authority-v2",()=>({writeClientPortalAuthorityV2:vi.fn(),readClientPortalAuthorityV2Status:vi.fn(),
  writeClientPortalAuthorityV3:vi.fn(),readClientPortalAuthorityV3Status:vi.fn()}));
import {readClientPortalAuthorityV2Status,readClientPortalAuthorityV3Status,writeClientPortalAuthorityV2,
  writeClientPortalAuthorityV3} from "../src/worker/client-portal-authority-v2";
import {applyClientPortalAuthorityV2,applyClientPortalAuthorityV3,getClientPortalAuthorityV2Status,
  getClientPortalAuthorityV3Status} from "../src/worker/client-portal-authority-v2-entrypoint";

const writer=vi.mocked(writeClientPortalAuthorityV2),reader=vi.mocked(readClientPortalAuthorityV2Status);
const writerV3=vi.mocked(writeClientPortalAuthorityV3),readerV3=vi.mocked(readClientPortalAuthorityV3Status);
const env={CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED:"true",DELIVERY_DB:{} as D1Database};
const command={protocolVersion:2,operationId:"grant-1",clientAuthorityId:"22222222-2222-4222-8222-222222222222",
  workspaceId:"workspace-a",bindingOperationId:"bind-1",issuer:"https://access.example.test",subject:"person-1",
  desiredState:"active",expectedOwnershipEpoch:0,expectedGrantRevision:0,scopes:[]};
describe("portal authority v2 private entrypoint",()=>{
  beforeEach(()=>{writer.mockReset();reader.mockReset();writerV3.mockReset();readerV3.mockReset();});
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
  it("accepts only exact protocol-3 permission commands and exposes v3 status",async()=>{
    const v3={...command,protocolVersion:3,permissions:["operations.service_home.read"] as ["operations.service_home.read"]};
    delete (v3 as Partial<typeof v3>).scopes;
    writerV3.mockResolvedValueOnce({operationId:"grant-1",clientAuthorityId:command.clientAuthorityId,workspaceId:"workspace-a",
      issuer:command.issuer,subject:"person-1",ownershipEpoch:1,grantRevision:1,state:"active",replayed:false,
      permissions:["operations.service_home.read"]});
    await expect(applyClientPortalAuthorityV3(env,v3)).resolves.toMatchObject({ok:true,protocolVersion:3,
      permissions:["operations.service_home.read"]});
    for(const invalid of [{...v3,extra:true},{...v3,permissions:["workspace.view"]},
      {...v3,desiredState:"revoked",permissions:["operations.service_home.read"]},
      {...v3,[Symbol("hidden")]:true}])
      await expect(applyClientPortalAuthorityV3(env,invalid)).resolves.toMatchObject({ok:false,protocolVersion:3,code:"invalid"});
    readerV3.mockResolvedValueOnce({operationId:"grant-1",clientAuthorityId:command.clientAuthorityId,workspaceId:"workspace-a",
      issuer:command.issuer,subject:"person-1",ownershipEpoch:1,grantRevision:1,state:"active",
      permissions:["operations.service_home.read"]});
    await expect(getClientPortalAuthorityV3Status(env,{protocolVersion:3,operationId:"grant-1"}))
      .resolves.toMatchObject({ok:true,protocolVersion:3,permissions:["operations.service_home.read"]});
  });
});
