import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({inventory:vi.fn(),persist:vi.fn(),connection:vi.fn(),create:vi.fn(),conflictProof:vi.fn()}));
vi.mock("../src/worker/project-alpha-directory-command-api-v2",()=>({readConfiguredProjectAlphaDirectoryInventory:mocks.inventory}));
vi.mock("../src/worker/project-alpha-v2-sync",()=>({persistProjectAlphaDirectoryInventoryPage:mocks.persist}));
vi.mock("../src/worker/project-alpha-api-v2-connections",()=>({resolveProjectAlphaApiV2Connection:mocks.connection}));
vi.mock("../src/worker/project-alpha-directory-profile-api-v2",()=>({sendConfiguredProjectAlphaDirectoryCreate:mocks.create,
  validatedProjectAlphaDirectoryCreateGenerationConflict:mocks.conflictProof}));
import { prepareDirectoryCreateGenerationRecovery } from "../src/worker/project-alpha-directory-create-generation-recovery";
const ids={authorization:"10000000-0000-4000-8000-000000000001",predecessor:"10000000-0000-4000-8000-000000000002",
  successor:"10000000-0000-4000-8000-000000000003",instance:"20000000-0000-4000-8000-000000000002",
  application:"30000000-0000-4000-8000-000000000003",epoch:"40000000-0000-4000-8000-000000000004",
  record:"50000000-0000-4000-8000-000000000005"};
const actor={staffId:"owner",accessSubject:"subject",email:"owner@example.test",admissionVersion:3,profileVersion:4,
  verifiedUntil:"2999-01-01T00:00:00.000Z"},sourceId="project-alpha:staging";
const command={operation:"create",commandId:ids.predecessor,resourceType:"client",externalId:ids.record,expectedRevision:"0",
  expectedAuthorizationGeneration:"52",fields:{name:"Synthetic",organizationPublicId:null},organization:null};
const row={root_command_id:ids.predecessor,recovery_depth:0,intent_id:"intent",record_id:ids.record,record_kind:"client",
  source_id:sourceId,application_id:ids.application,expected_source_instance_id:ids.instance,expected_history_epoch_id:ids.epoch,
  destination_base_url:"https://pa.example.test",external_id:ids.record,command_json:JSON.stringify(command),origin_snapshot_json:"{}",
  outcome_json:JSON.stringify({httpStatus:409,errorCode:"authorization_generation_conflict"}),state:"terminal",audit_actor_id:actor.staffId,audit_subject:actor.accessSubject,
  audit_command_json:JSON.stringify({actor:{loginEmail:actor.email,admissionVersion:3,profileVersion:4,
    selectedGrantId:"old-profile",selectedIdentityGrantId:"old-identity"}})};
const input={authorizationId:ids.authorization,predecessorCommandId:ids.predecessor,successorCommandId:ids.successor,
  sourceId,reason:"Reviewed stale generation"};
function fixture(){const statements:Array<{sql:string;binds:unknown[]}>=[];const db={withSession:vi.fn(()=>db),
  prepare:vi.fn((sql:string)=>({bind:vi.fn((...binds:unknown[])=>{statements.push({sql,binds});return{
    first:vi.fn(async(column?:string)=>{if(sql.includes("WHERE authorization_id=?"))return null;
      if(sql.includes("SELECT 1 present FROM staff_users staff"))return {present:1};
      if(sql.includes("FROM project_alpha_directory_outbox outbox"))return row;
      if(sql.includes("SELECT allow_grant.id")){const value=`new-${binds[1]}`;return column?value:{id:value};}return null;})};})})),
  batch:vi.fn(async()=>[])} as unknown as D1Database;return{db,statements,env:{OPS_DB:db,
    PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED:"true",PROJECT_ALPHA_API_V2_CONNECTIONS:"configured"}};}
describe("Directory create generation recovery service",()=>{beforeEach(()=>{vi.clearAllMocks();mocks.connection.mockReturnValue({enabled:true,
  connection:{baseUrl:"https://pa.example.test",expectedSourceInstanceId:ids.instance,expectedApplicationId:ids.application,
    expectedHistoryEpoch:ids.epoch}});mocks.inventory.mockResolvedValue({status:"observed",inventory:{authoritative:false,sourceId,
      sourceInstanceId:ids.instance,applicationId:ids.application,historyEpoch:ids.epoch,requestId:"60000000-0000-4000-8000-000000000006",
      authorizationGeneration:"53",resources:[],nextCursor:null}});mocks.persist.mockResolvedValue({status:"persisted",
        continuationIdentity:{authorizationGeneration:"53"}});mocks.create.mockResolvedValue({status:"conflict",reason:"http_status",httpStatus:409});
    mocks.conflictProof.mockReturnValue({commandJson:JSON.stringify({commandId:ids.predecessor,externalId:ids.record,
      expectedAuthorizationGeneration:"52",profile:{name:"Synthetic"},organization:null}),destinationOrigin:"https://pa.example.test",
      requestId:"70000000-0000-4000-8000-000000000007",sourceInstanceId:ids.instance,applicationId:ids.application,historyEpoch:ids.epoch});});
  it("is default off",async()=>{const{db}=fixture();await expect(prepareDirectoryCreateGenerationRecovery({OPS_DB:db},input,actor))
    .resolves.toEqual({status:"blocked",reason:"disabled"});expect(db.prepare).not.toHaveBeenCalled();});
  it("rejects an invalid verification expiry before database access",async()=>{const{db,env}=fixture();
    await expect(prepareDirectoryCreateGenerationRecovery(env,input,{...actor,verifiedUntil:"not-a-date"}))
      .resolves.toEqual({status:"blocked",reason:"authority"});expect(db.prepare).not.toHaveBeenCalled();});
  it("fails closed when exact replay produces an undifferentiated terminal 409",async()=>{const value=fixture();mocks.conflictProof.mockReturnValueOnce(null);
    await expect(prepareDirectoryCreateGenerationRecovery(value.env,input,actor)).resolves.toEqual({status:"blocked",reason:"not_eligible"});
    expect(value.db.batch).not.toHaveBeenCalled();});
  it("rejects an exhausted freshly observed generation before persistence",async()=>{const value=fixture();
    mocks.inventory.mockResolvedValueOnce({status:"observed",inventory:{authoritative:false,sourceId,sourceInstanceId:ids.instance,
      applicationId:ids.application,historyEpoch:ids.epoch,requestId:"60000000-0000-4000-8000-000000000006",
      authorizationGeneration:"9223372036854775807",resources:[],nextCursor:null}});
    await expect(prepareDirectoryCreateGenerationRecovery(value.env,input,actor)).resolves.toEqual({status:"blocked",reason:"generation"});
    expect(mocks.persist).not.toHaveBeenCalled();expect(value.db.batch).not.toHaveBeenCalled();});
  it("rechecks verification expiry after network waits before persistence or recovery writes",async()=>{vi.useFakeTimers();
    try{vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));const value=fixture(),expiring={...actor,verifiedUntil:"2026-10-08T12:00:01.000Z"};
      mocks.inventory.mockImplementationOnce(async()=>{vi.setSystemTime(new Date("2026-10-08T12:00:02.000Z"));return{status:"observed",inventory:{
        authoritative:false,sourceId,sourceInstanceId:ids.instance,applicationId:ids.application,historyEpoch:ids.epoch,
        requestId:"60000000-0000-4000-8000-000000000006",authorizationGeneration:"53",resources:[],nextCursor:null}};});
      await expect(prepareDirectoryCreateGenerationRecovery(value.env,input,expiring)).resolves.toEqual({status:"blocked",reason:"authority"});
      expect(mocks.persist).not.toHaveBeenCalled();expect(value.db.batch).not.toHaveBeenCalled();}
    finally{vi.useRealTimers();}});
  it("rechecks verification expiry again immediately before the atomic recovery batch",async()=>{vi.useFakeTimers();
    try{vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));const value=fixture(),expiring={...actor,verifiedUntil:"2026-10-08T12:00:01.000Z"};
      mocks.persist.mockImplementationOnce(async()=>{vi.setSystemTime(new Date("2026-10-08T12:00:02.000Z"));return{status:"persisted",
        continuationIdentity:{authorizationGeneration:"53"}};});
      await expect(prepareDirectoryCreateGenerationRecovery(value.env,input,expiring)).resolves.toEqual({status:"blocked",reason:"authority"});
      expect(mocks.persist).toHaveBeenCalledOnce();expect(value.db.batch).not.toHaveBeenCalled();}
    finally{vi.useRealTimers();}});
  it("atomically appends a same-identity successor with new current grants and generation",async()=>{const{db,env,statements}=fixture();
    await expect(prepareDirectoryCreateGenerationRecovery(env,input,actor)).resolves.toEqual({status:"prepared",
      successorCommandId:ids.successor,generation:"53",replayed:false});expect(db.batch).toHaveBeenCalledOnce();
    const writes=statements.slice(-2);expect(writes[0]!.binds).toEqual(expect.arrayContaining(["old-profile","old-identity",
      "new-directory.profile.edit","new-directory.identity.link","new-directory.enrollment.manage"]));
    expect(JSON.parse(String(writes[1]!.binds[5]))).toEqual({...command,commandId:ids.successor,expectedAuthorizationGeneration:"53"});
    expect(writes[1]!.binds.at(-1)).toBe(ids.epoch);});
  it("fails closed at the recovery depth bound",async()=>{const value=fixture();
    row.recovery_depth=3;try{await expect(prepareDirectoryCreateGenerationRecovery(value.env,input,actor)).resolves.toEqual({status:"blocked",reason:"depth"});}
    finally{row.recovery_depth=0;}});
});
