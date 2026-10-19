import { Miniflare } from "miniflare";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import type { Env } from "../src/worker/types";
const probe=vi.hoisted(()=>vi.fn());
vi.mock("../src/worker/project-alpha-api-v2-connections",async original=>({
  ...await original<typeof import("../src/worker/project-alpha-api-v2-connections")>(),probeConfiguredProjectAlphaApiV2Connection:probe,
}));
import { configuredLocalDivisionIdentity,refreshLocalDivisionSourceIdentity } from "../src/worker/local-project-division-source";
const source="project-alpha:primary",origin="https://pa.example.test";
const instance="11111111-1111-4111-8111-111111111111",application="22222222-2222-4222-8222-222222222222",epoch="33333333-3333-4333-8333-333333333333";
let runtime:Miniflare,db:D1Database,env:Env,next=0;
beforeAll(()=>{runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:Array.from({length:12},(_,i)=>`DB${i}`)});});
afterAll(()=>runtime.dispose());
beforeEach(async()=>{
  db=await runtime.getD1Database(`DB${next++}`) as D1Database;
  await db.prepare("CREATE TABLE pa_local_division_source_heads(projection_source_id TEXT PRIMARY KEY,identity_key TEXT,revision INTEGER,verified_at TEXT)").run();
  env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled:true,baseUrl:origin,apiKey:"fixture",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}})} as Env;
  await db.prepare("INSERT INTO pa_local_division_source_heads VALUES(?,?,1,'previous')").bind(source,configuredLocalDivisionIdentity(env,source)).run();
  probe.mockReset();
});
describe("local division source identity preflight",()=>{
  it("clears the prior identity before the probe and restores only the verified runtime identity",async()=>{
    probe.mockImplementation(async()=>{
      expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
      return {status:"verified",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch};
    });
    await refreshLocalDivisionSourceIdentity(env,source,origin);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBe(configuredLocalDivisionIdentity(env,source));
    expect(probe).toHaveBeenCalledOnce();
  });
  it("leaves an unavailable or mismatched PA identity unassigned",async()=>{
    probe.mockResolvedValue({status:"incompatible",reason:"history_epoch_mismatch"});
    await refreshLocalDivisionSourceIdentity(env,source,origin);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
  });
  it("rejects a different snapshot origin and missing runtime configuration without probing",async()=>{
    await refreshLocalDivisionSourceIdentity(env,source,"https://other.example.test");
    expect(probe).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
    await refreshLocalDivisionSourceIdentity({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:undefined},source,origin);
    expect(probe).not.toHaveBeenCalled();
  });
  it("does not overwrite a concurrent identity-head revision",async()=>{
    probe.mockImplementation(async()=>{
      await db.prepare("UPDATE pa_local_division_source_heads SET revision=revision+1,identity_key='reviewed-other-head'").run();
      return {status:"verified",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch};
    });
    await refreshLocalDivisionSourceIdentity(env,source,origin);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBe("reviewed-other-head");
  });
  it("rejects a verified response carrying a different source identity",async()=>{
    probe.mockResolvedValue({status:"verified",sourceInstanceId:application,applicationId:instance,historyEpoch:epoch});
    await refreshLocalDivisionSourceIdentity(env,source,origin);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
  });

  it("uses an explicit projection identity envelope without renaming the directory alias",async()=>{
    const original=JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
    const entry=original.instances[source],alias="project-alpha:staging";
    const directory=JSON.stringify({version:1,instances:{[alias]:{...entry,sourceId:alias}}});
    const identityEnvelope=JSON.stringify({version:1,instances:{[source]:{...entry,apiKey:"separate-capabilities-only-key"}}});
    const directoryOnly={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:directory};
    expect(configuredLocalDivisionIdentity(directoryOnly,source)).toBeNull();
    const explicit={...directoryOnly,PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS:identityEnvelope};
    expect(configuredLocalDivisionIdentity(explicit,source)).toBe(configuredLocalDivisionIdentity(env,source));
    probe.mockResolvedValue({status:"verified",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,grantedCapabilities:["api.capabilities.read"]});
    await refreshLocalDivisionSourceIdentity(explicit,source,origin);
    expect(probe).toHaveBeenCalledWith({PROJECT_ALPHA_API_V2_CONNECTIONS:identityEnvelope},source);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBe(configuredLocalDivisionIdentity(env,source));
    expect(explicit.PROJECT_ALPHA_API_V2_CONNECTIONS).toBe(directory);
  });
  it("fails closed for an explicit invalid or incomplete identity envelope instead of using general connections",async()=>{
    for(const configured of ["",JSON.stringify({version:1,instances:{}})]) {
      const explicit={...env,PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS:configured};
      expect(configuredLocalDivisionIdentity(explicit,source)).toBeNull();
      await refreshLocalDivisionSourceIdentity(explicit,source,origin);
      expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it("pins application identity independently of credentials so both writers agree only on the same PA application",()=>{
    const readonly=JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
    readonly.instances[source].apiKey="dedicated-sync-read-key";
    const same={...env,PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS:JSON.stringify(readonly)};
    expect(configuredLocalDivisionIdentity(same,source)).toBe(configuredLocalDivisionIdentity(env,source));
    readonly.instances[source].applicationId="55555555-5555-4555-8555-555555555555";
    expect(configuredLocalDivisionIdentity({...same,PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS:JSON.stringify(readonly)},source)).not.toBe(configuredLocalDivisionIdentity(env,source));
  });

  it("rejects accidentally copied command or financial keys in a dedicated identity envelope",async()=>{
    const dedicated={...env,PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS:env.PROJECT_ALPHA_API_V2_CONNECTIONS};
    for(const grantedCapabilities of [["api.capabilities.read","directory.clients.write"],["api.capabilities.read","financial.summary.read"],[]]) {
      probe.mockResolvedValue({status:"verified",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,grantedCapabilities});
      await refreshLocalDivisionSourceIdentity(dedicated,source,origin);
      expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBeNull();
    }
    probe.mockResolvedValue({status:"verified",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,grantedCapabilities:["api.capabilities.read"]});
    await refreshLocalDivisionSourceIdentity(dedicated,source,origin);
    expect(await db.prepare("SELECT identity_key FROM pa_local_division_source_heads").first("identity_key")).toBe(configuredLocalDivisionIdentity(dedicated,source));
  });

});
