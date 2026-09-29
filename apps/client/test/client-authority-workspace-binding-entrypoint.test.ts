import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
vi.mock("../src/worker/client-authority-workspace-binding",()=>({
  writeClientAuthorityWorkspaceBinding:vi.fn(),
  readClientAuthorityWorkspaceBindingStatus:vi.fn(),
}));
import {readClientAuthorityWorkspaceBindingStatus,writeClientAuthorityWorkspaceBinding} from "../src/worker/client-authority-workspace-binding";
import {bindClientAuthorityWorkspace,getClientAuthorityWorkspaceBindingStatus,type ClientAuthorityWorkspaceBindingRpcCommand} from
  "../src/worker/client-authority-workspace-binding-entrypoint";

const writer=vi.mocked(writeClientAuthorityWorkspaceBinding);
const statusReader=vi.mocked(readClientAuthorityWorkspaceBindingStatus);
const command:ClientAuthorityWorkspaceBindingRpcCommand={protocolVersion:1,operationId:"bind-1",
  clientAuthorityId:"22222222-2222-4222-8222-222222222222",workspaceId:"workspace-a",
  projectionSourceId:"project-alpha:east",sourceWorkspaceId:"source-workspace-17",rootType:"organization",
  rootPublicId:"a".repeat(32),expectedCheckpoint:{sourceGeneration:"generation-7",sourceSequence:7,
    snapshotGenerationId:"snapshot-7"}};
const env={DELIVERY_DB:{} as D1Database,CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:"true",
  CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED:"true"};

describe("Client authority workspace binding private RPC",()=>{
  beforeEach(()=>{writer.mockReset();statusReader.mockReset();});
  it("validates the protocol and returns a minimal versioned receipt",async()=>{
    writer.mockResolvedValueOnce({operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,
      workspaceId:command.workspaceId,projectionSourceId:command.projectionSourceId,sourceWorkspaceId:command.sourceWorkspaceId,
      rootType:command.rootType,rootPublicId:command.rootPublicId,checkpoint:command.expectedCheckpoint,state:"inactive",revision:1,
      replayed:false});
    await expect(bindClientAuthorityWorkspace(env,command)).resolves.toEqual({ok:true,protocolVersion:1,status:"recorded",
      operationId:"bind-1",clientAuthorityId:command.clientAuthorityId,workspaceId:command.workspaceId,
      projectionSourceId:command.projectionSourceId,sourceWorkspaceId:command.sourceWorkspaceId,rootType:command.rootType,
      rootPublicId:command.rootPublicId,checkpoint:command.expectedCheckpoint,state:"inactive",revision:1});
    expect(writer).toHaveBeenCalledOnce();
    const passed=writer.mock.calls[0]![1] as Record<string,unknown>;
    expect(passed).not.toHaveProperty("protocolVersion");
  });

  it("reports replay without expanding the receipt",async()=>{
    writer.mockResolvedValueOnce({operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,
      workspaceId:command.workspaceId,projectionSourceId:command.projectionSourceId,sourceWorkspaceId:command.sourceWorkspaceId,
      rootType:command.rootType,rootPublicId:command.rootPublicId,checkpoint:command.expectedCheckpoint,state:"inactive",revision:1,
      replayed:true});
    await expect(bindClientAuthorityWorkspace(env,command)).resolves.toMatchObject({ok:true,status:"duplicate",operationId:command.operationId,
      clientAuthorityId:command.clientAuthorityId,workspaceId:command.workspaceId,projectionSourceId:command.projectionSourceId,
      sourceWorkspaceId:command.sourceWorkspaceId,rootType:command.rootType,rootPublicId:command.rootPublicId,
      checkpoint:command.expectedCheckpoint,revision:1});
  });

  it("fails closed before invoking the writer for malformed or unsafe DTOs",async()=>{
    for(const input of [{...command,protocolVersion:2},{...command,extra:true},
      {...command,expectedCheckpoint:{...command.expectedCheckpoint,sourceSequence:0}}])
      await expect(bindClientAuthorityWorkspace(env,input)).resolves.toEqual({ok:false,protocolVersion:1,code:"invalid",retryable:false});
    let accessed=false;
    const accessor=Object.defineProperty({...command},"workspaceId",{enumerable:true,get(){accessed=true;return"workspace-a";}});
    await expect(bindClientAuthorityWorkspace(env,accessor)).resolves.toMatchObject({ok:false,code:"invalid"});
    expect(accessed).toBe(false);expect(writer).not.toHaveBeenCalled();
  });

  it.each([
    ["client-authority-workspace-binding-writer-disabled","disabled",true],
    ["client-authority-workspace-binding-operation-conflict","conflict",false],
    ["client-authority-workspace-binding-conflict","conflict",false],
    ["database unavailable","temporarily-unavailable",true],
  ] as const)("maps %s to a bounded error receipt",async(message,code,retryable)=>{
    writer.mockRejectedValueOnce(new Error(message));
    await expect(bindClientAuthorityWorkspace(env,command)).resolves.toEqual({ok:false,protocolVersion:1,code,retryable});
  });

  it("returns the full immutable status tuple or exact not_found",async()=>{
    const recorded={operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,
      workspaceId:command.workspaceId,projectionSourceId:command.projectionSourceId,
      sourceWorkspaceId:command.sourceWorkspaceId,rootType:command.rootType,rootPublicId:command.rootPublicId,
      checkpoint:command.expectedCheckpoint,state:"inactive" as const,revision:1 as const};
    statusReader.mockResolvedValueOnce(recorded).mockResolvedValueOnce(null);
    await expect(getClientAuthorityWorkspaceBindingStatus(env,{protocolVersion:1,operationId:command.operationId}))
      .resolves.toEqual({ok:true,protocolVersion:1,status:"recorded",...recorded});
    await expect(getClientAuthorityWorkspaceBindingStatus(env,{protocolVersion:1,operationId:"missing"}))
      .resolves.toEqual({ok:false,protocolVersion:1,code:"not_found",retryable:false});
  });

  it("rejects malformed status DTOs and fails closed while disabled",async()=>{
    for(const input of [{protocolVersion:2,operationId:"bind-1"},{protocolVersion:1,operationId:" bind-1"},
      {protocolVersion:1,operationId:"bind-1",extra:true}])
      await expect(getClientAuthorityWorkspaceBindingStatus(env,input)).resolves.toMatchObject({ok:false,code:"invalid"});
    statusReader.mockRejectedValueOnce(new Error("client-authority-workspace-binding-status-disabled"));
    await expect(getClientAuthorityWorkspaceBindingStatus({...env,CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED:"false"},
      {protocolVersion:1,operationId:"bind-1"})).resolves.toEqual(
        {ok:false,protocolVersion:1,code:"disabled",retryable:true});
    expect(statusReader).toHaveBeenCalledOnce();
  });
});
