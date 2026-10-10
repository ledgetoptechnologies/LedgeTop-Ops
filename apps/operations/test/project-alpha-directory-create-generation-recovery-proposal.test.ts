import { describe,expect,it } from "vitest";
import { planDirectoryCreateGenerationRecovery,type DirectoryCreateGenerationRecoveryProof } from
  "../src/worker/project-alpha-directory-create-generation-recovery-proposal";

const predecessor={operation:"create" as const,commandId:"10000000-0000-4000-8000-000000000001",
  resourceType:"client" as const,externalId:"50000000-0000-4000-8000-000000000005",expectedRevision:"0" as const,
  expectedAuthorizationGeneration:"52",fields:{name:"Synthetic Client",clientType:"other"},organization:null};
const proof:DirectoryCreateGenerationRecoveryProof={predecessorCommandId:predecessor.commandId,
  successorCommandId:"10000000-0000-4000-8000-000000000002",predecessorState:"terminal",predecessorHttpStatus:409,
  observedAuthorizationGeneration:"53"};

describe("Directory create generation recovery proposal",()=>{
  it("changes only command ID and authorization generation",()=>{
    const before=JSON.stringify(predecessor);
    const planned=planDirectoryCreateGenerationRecovery(predecessor,proof);expect(planned).toEqual({...predecessor,
      commandId:proof.successorCommandId,expectedAuthorizationGeneration:"53"});
    expect(JSON.stringify(predecessor)).toBe(before);
    expect(planned?.externalId).toBe(predecessor.externalId);expect(planned?.fields).toBe(predecessor.fields);
    expect(planned?.organization).toBe(predecessor.organization);
  });
  it.each([
    ["same command",{successorCommandId:predecessor.commandId}],
    ["noncanonical generation",{observedAuthorizationGeneration:"53junk"}],
    ["overflow generation",{observedAuthorizationGeneration:"9223372036854775808"}],
    ["exhausted generation",{observedAuthorizationGeneration:"9223372036854775807"}],
    ["unchanged generation",{observedAuthorizationGeneration:"52"}],
  ])("rejects %s",(_label,change)=>expect(planDirectoryCreateGenerationRecovery(predecessor,
    {...proof,...change} as DirectoryCreateGenerationRecoveryProof)).toBeNull());
  it("preserves a linked client's exact relationship assertion",()=>{
    const linked={...predecessor,organization:{externalId:"organization-external",publicId:"a".repeat(32),expectedRevision:"7"}};
    const planned=planDirectoryCreateGenerationRecovery(linked,proof);expect(planned?.organization).toBe(linked.organization);
  });
});
