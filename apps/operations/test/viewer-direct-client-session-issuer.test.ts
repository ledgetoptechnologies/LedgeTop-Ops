import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectClientViewerAuthorizationV1, DirectClientViewerSessionRequestV1 } from "@ltds/shared";
import type { Env } from "../src/worker/types";

const mock=vi.hoisted(()=>({context:vi.fn(),allowed:vi.fn(),rows:vi.fn(),catalog:vi.fn(),create:vi.fn()}));
vi.mock("../src/worker/viewer-direct-client-grants",()=>({readDirectViewerClientGrants:mock.rows,
  readDirectViewerClientBusinessName:async()=>"Drone Services"}));
vi.mock("../../client/src/worker/client-portal/workspace-v2",()=>({resolveNativePortalWorkspaceReadContext:mock.context,
  nativePortalScopesAllowed:mock.allowed}));
vi.mock("../src/worker/viewer-integration",()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mock.catalog,createSession:mock.create})}));
import { issueDirectClientViewerSession, listDirectClientViewerItems } from "../src/worker/viewer-direct-client-session-issuer";

const auth:DirectClientViewerAuthorizationV1={protocolVersion:1,sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",
  principalIssuer:"https://access.example.test",principalSubject:"subject-one",verifiedEmail:"synthetic@example.test",contextVersion:"a".repeat(64)};
const session:DirectClientViewerSessionRequestV1={...auth,grantId:"grant-one",taskId:"task-one",idempotencyKey:"direct-client-session-test-001",displayUnits:"imperial"};
const row=()=>({id:"grant-one",source_id:auth.sourceId,workspace_id:auth.workspaceId,viewer_project_id:"project-one",task_id:"task-one",scope_type:"task",
  grant_version:1,authorization_expires_at:null,created_at:"2026-10-01T00:00:00Z",can_measure:0,can_view_cameras:1,can_download:0});
const task={id:"task-one",displayName:"Property map",modelId:"model-one",modelVersionId:"version-one",modelTitle:"Private model title",publishedAt:"2026-10-01T00:00:00Z"};
let intents:Map<string,{request_fingerprint:string;authorization_expires_at:string}>;
let receipts:Map<string,{request_fingerprint:string;response_json:string;expires_at:string}>;
function database(){return {prepare(sql:string){let values:unknown[]=[];return {bind(...input:unknown[]){values=input;return this;},
  async first(){const key=String(values[1]);return sql.includes("session_intents")?intents.get(key)??null:receipts.get(key)??null;},
  async run(){if(sql.includes("session_intents")){const key=String(values[1]);if(!intents.has(key))intents.set(key,
    {request_fingerprint:String(values[4]),authorization_expires_at:String(values[5])});}
    else receipts.set(String(values[1]),{request_fingerprint:String(values[2]),response_json:String(values[3]),expires_at:String(values[4])});return {meta:{changes:1}};}};}};}
function env():Env{return {CLIENT_VIEWER_SESSION_ISSUER_ENABLED:"true",VIEWER_SERVICE_HMAC_SECRET:"synthetic-secret-for-direct-cursor-tests-only",
  DELIVERY_DB:{withSession:()=>database()}} as unknown as Env;}
beforeEach(()=>{vi.resetAllMocks();intents=new Map();receipts=new Map();mock.allowed.mockReturnValue(true);
  mock.context.mockResolvedValue({...auth,workspace:{membership_expires_at:null},grants:[],denials:[]});
  mock.rows.mockResolvedValue([row()]);mock.catalog.mockResolvedValue({schemaVersion:1,project:{id:"project-one",displayName:"Property survey"},tasks:[task],nextCursor:null});
  mock.create.mockResolvedValue({grant:"00000000-0000-4000-8000-000000000001",grantExpiresAt:new Date(Date.now()+120_000).toISOString(),
    sessionTtlSeconds:1800,redeemUrl:"https://viewer.example.test/redeem",embedUrl:"https://viewer.example.test/session"});});

describe("direct Viewer recipient authorization",()=>{
  it("lists a minimal task DTO without a PA project or sibling catalog",async()=>{
    const result=await listDirectClientViewerItems(env(),auth);expect(result).toMatchObject({ok:true,nextCursor:null,items:[{title:"Property map",projectName:"Property survey"}]});
    expect(mock.catalog).toHaveBeenCalledWith({projectId:"project-one",taskId:"task-one",limit:25});
    expect(JSON.stringify(result)).not.toContain("model-one");expect(JSON.stringify(result)).not.toContain("Private model title");
  });
  it("rejects mismatched identity, source, context and workspace denials before catalog reads",async()=>{
    for(const change of [{identityId:"other"},{sourceId:"project-alpha:other"},{contextVersion:"b".repeat(64)}]){
      mock.context.mockResolvedValueOnce({...auth,...change});expect(await listDirectClientViewerItems(env(),auth)).toMatchObject({ok:false,code:"denied"});}
    mock.allowed.mockReturnValueOnce(false);expect(await listDirectClientViewerItems(env(),auth)).toMatchObject({ok:false,code:"denied"});
    expect(mock.catalog).not.toHaveBeenCalled();
  });
  it("cannot issue a session for a sibling task",async()=>{
    expect(await issueDirectClientViewerSession(env(),{...session,taskId:"task-two"})).toMatchObject({ok:false,code:"denied"});
    expect(mock.catalog).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
  });
  it("rechecks grant authority after the remote catalog lookup",async()=>{
    mock.rows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:false,code:"denied"});expect(mock.create).not.toHaveBeenCalled();
  });
  it("uses typed recipient grant authority and exact current version, preserving narrow permissions",async()=>{
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:true,modelId:"model-one"});
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({modelId:"model-one",modelVersionId:"version-one",audience:"client",
      sourceAuthorization:{type:"direct_client_grant",id:"grant-one",version:1},permissions:{view:true,measure:false,cameras:true,download:false,personalMeasurements:true}}));
  });
  it("rejects expired or imminently expiring membership",async()=>{
    mock.context.mockResolvedValue({...auth,workspace:{membership_expires_at:new Date(Date.now()+30_000).toISOString()},grants:[],denials:[]});
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:false,code:"denied"});expect(mock.create).not.toHaveBeenCalled();
  });
  it("keeps upstream request deadline stable after a lost response and returns the saved result on replay",async()=>{
    mock.create.mockRejectedValueOnce(new Error("lost response"));expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:false});
    const original=mock.create.mock.calls[0]![0].authorizationExpiresAt;
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:true});expect(mock.create.mock.calls[1]![0].authorizationExpiresAt).toBe(original);
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:true});expect(mock.create).toHaveBeenCalledTimes(2);
  });
  it("does not return a minted grant when recipient membership changes while issuing",async()=>{
    mock.create.mockImplementationOnce(async()=>{mock.context.mockResolvedValue(null);return {grant:"hidden",grantExpiresAt:new Date(Date.now()+60_000).toISOString()};});
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:false,code:"denied"});expect(receipts.size).toBe(0);
  });
  it("binds pagination to current recipient, grant permissions and context",async()=>{
    mock.rows.mockResolvedValue([{...row(),scope_type:"project",task_id:null}]);
    mock.catalog.mockResolvedValue({...await mock.catalog(),nextCursor:"upstream-page-two"});mock.catalog.mockClear();
    const first=await listDirectClientViewerItems(env(),auth);expect(first.ok).toBe(true);if(!first.ok||!first.nextCursor)throw Error("missing cursor");
    mock.rows.mockResolvedValue([{...row(),scope_type:"project",task_id:null,can_download:1}]);
    expect(await listDirectClientViewerItems(env(),{...auth,cursor:first.nextCursor})).toMatchObject({ok:false,code:"invalid_request"});
    expect(mock.catalog).toHaveBeenCalledTimes(1);
  });
});
