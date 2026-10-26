import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectClientViewerAuthorizationV1, DirectClientViewerSessionRequestV1 } from "@ltds/shared";
import type { Env } from "../src/worker/types";

const mock=vi.hoisted(()=>({context:vi.fn(),allowed:vi.fn(),rows:vi.fn(),pin:vi.fn(),catalog:vi.fn(),create:vi.fn()}));
vi.mock("../src/worker/viewer-direct-client-grants",async original=>({...await original<typeof import("../src/worker/viewer-direct-client-grants")>(),
  readDirectViewerClientGrants:mock.rows,readDirectViewerClientGrantAuthorityPin:mock.pin,
  readDirectViewerClientBusinessName:async()=>"Drone Services"}));
vi.mock("../../client/src/worker/client-portal/direct-viewer-workspace-context",()=>({resolveDirectViewerWorkspaceContext:mock.context}));
vi.mock("../../client/src/worker/client-portal/workspace-v2",()=>({
  nativePortalScopesAllowed:mock.allowed}));
vi.mock("../src/worker/viewer-integration",()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mock.catalog,createSession:mock.create})}));
import { issueDirectClientViewerSession, listDirectClientViewerItems } from "../src/worker/viewer-direct-client-session-issuer";
import {directViewerGrantMatchesRecipientAuthority} from "../src/worker/viewer-direct-client-grants";

const auth:DirectClientViewerAuthorizationV1={protocolVersion:1,sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",
  principalIssuer:"https://access.example.test",principalSubject:"subject-one",verifiedEmail:"synthetic@example.test",contextVersion:"a".repeat(64)};
const session:DirectClientViewerSessionRequestV1={...auth,grantId:"grant-one",taskId:"task-one",idempotencyKey:"direct-client-session-test-001",displayUnits:"imperial"};
const nativeContext={mode:"native" as const,...auth,displayName:"Client",rootType:"standalone_client" as const,rootPublicId:"client-one",
  sourceWorkspaceId:"source-client-one",sourceAuthorityDigest:"a".repeat(64),nativeContext:{...auth,workspace:{membership_expires_at:null},grants:[],denials:[]}};
const operationsContext={...nativeContext,mode:"operations_native" as const,identityId:"op_identity-one",authorityId:"10000000-0000-4000-8000-000000000001",
  ownershipEpoch:1,authorityOwnershipEpoch:4,membershipExpiresAt:null};
const operationsPin={version:1 as const,mode:"operations_native" as const,sourceId:auth.sourceId,workspaceId:auth.workspaceId,
  sourceWorkspaceId:"source-client-one",rootType:"standalone_client" as const,rootPublicId:"client-one",authorityId:operationsContext.authorityId,
  ownershipEpoch:4,claimOwnershipEpoch:1};
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
  APPLICATION_KEY:"ltds_ops",DELIVERY_DB:{withSession:()=>database()}} as unknown as Env;}
beforeEach(()=>{vi.resetAllMocks();intents=new Map();receipts=new Map();mock.allowed.mockReturnValue(true);
  mock.context.mockResolvedValue(nativeContext);mock.pin.mockResolvedValue(null);
  mock.rows.mockResolvedValue([row()]);mock.catalog.mockResolvedValue({schemaVersion:1,project:{id:"project-one",displayName:"Property survey"},tasks:[task],nextCursor:null});
  mock.create.mockResolvedValue({grant:"00000000-0000-4000-8000-000000000001",grantExpiresAt:new Date(Date.now()+120_000).toISOString(),
    sessionTtlSeconds:1800,redeemUrl:"https://viewer.example.test/redeem",embedUrl:"https://viewer.example.test/session"});});

describe("direct Viewer recipient authorization",()=>{
  it("passes the default primary private-proof selector and Operations application pin to Client context reads",async()=>{
    const sourceEnv=env();
    expect(await listDirectClientViewerItems(sourceEnv,auth)).toMatchObject({ok:true});
    const proofEnv=mock.context.mock.calls[0]?.[0] as Partial<Env>;
    expect(proofEnv).toMatchObject({APPLICATION_KEY:"ltds_ops",PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:"false",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"ltds_ops"});
    expect(sourceEnv.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED).toBeUndefined();
    expect(sourceEnv.PROJECT_ALPHA_PORTAL_APPLICATION_KEY).toBeUndefined();
  });
  it("preserves explicitly configured legacy HMAC proof mode for Client context reads",async()=>{
    const sourceEnv={...env(),PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:"ops-v1",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET:"synthetic-primary-hmac-secret-with-at-least-32-bytes"} as Env;
    expect(await listDirectClientViewerItems(sourceEnv,auth)).toMatchObject({ok:true});
    const proofEnv=mock.context.mock.calls[0]?.[0] as Partial<Env>;
    expect(proofEnv.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED).toBeUndefined();
    expect(proofEnv.PROJECT_ALPHA_PORTAL_APPLICATION_KEY).toBe("ltds_ops");
    expect(proofEnv.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID).toBe("ops-v1");
    expect(proofEnv.PROJECT_ALPHA_PORTAL_HMAC_SECRET).toBe(sourceEnv.PROJECT_ALPHA_PORTAL_HMAC_SECRET);
  });
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
  it("accepts a claimed workspace grant only when its immutable authority and ownership pin matches",async()=>{
    const operationsSession={...session,identityId:operationsContext.identityId};
    mock.context.mockResolvedValue(operationsContext);mock.pin.mockResolvedValue(operationsPin);
    expect(await issueDirectClientViewerSession(env(),operationsSession)).toMatchObject({ok:true,modelId:"model-one"});
    mock.context.mockResolvedValue(operationsContext);mock.pin.mockResolvedValue({...operationsPin,authorityId:"20000000-0000-4000-8000-000000000001"});
    expect(await issueDirectClientViewerSession(env(),{...operationsSession,idempotencyKey:"direct-client-session-test-002"})).toMatchObject({ok:false,code:"denied"});
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh Ops membership proof after the remote Viewer call",async()=>{
    const operationsSession={...session,identityId:operationsContext.identityId};
    mock.context.mockResolvedValueOnce(operationsContext).mockResolvedValueOnce({...operationsContext,contextVersion:"b".repeat(64)});
    mock.pin.mockResolvedValue(operationsPin);
    mock.create.mockImplementationOnce(async()=>({grant:"hidden",grantExpiresAt:new Date(Date.now()+60_000).toISOString()}));
    expect(await issueDirectClientViewerSession(env(),operationsSession)).toMatchObject({ok:false,code:"denied"});
    expect(receipts.size).toBe(0);
  });
  it("caps claimed-workspace sessions at the current Ops member expiry",async()=>{
    const operationsSession={...session,identityId:operationsContext.identityId};
    mock.context.mockResolvedValue({...operationsContext,membershipExpiresAt:new Date(Date.now()+30_000).toISOString()});
    mock.pin.mockResolvedValue(operationsPin);
    expect(await issueDirectClientViewerSession(env(),operationsSession)).toMatchObject({ok:false,code:"denied"});
    expect(mock.create).not.toHaveBeenCalled();
    mock.context.mockResolvedValue(operationsContext);
    expect(await issueDirectClientViewerSession(env(),{...operationsSession,idempotencyKey:"direct-client-session-positive-01"}))
      .toMatchObject({ok:true,modelId:"model-one"});
  });
  it("rejects expired or imminently expiring membership",async()=>{
    mock.context.mockResolvedValue({...nativeContext,nativeContext:{...nativeContext.nativeContext,
      workspace:{membership_expires_at:new Date(Date.now()+30_000).toISOString()}}});
    expect(await issueDirectClientViewerSession(env(),session)).toMatchObject({ok:false,code:"denied"});expect(mock.create).not.toHaveBeenCalled();
    mock.context.mockResolvedValue({...nativeContext,nativeContext:{...nativeContext.nativeContext,
      workspace:{membership_expires_at:new Date(Date.now()+5*60_000).toISOString()}}});
    expect(await issueDirectClientViewerSession(env(),{...session,idempotencyKey:"direct-client-session-native-positive-01"}))
      .toMatchObject({ok:true,modelId:"model-one"});
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
  it("does not return a minted grant if publication changes during the Viewer call",async()=>{
    mock.create.mockImplementationOnce(async()=>{mock.catalog.mockResolvedValue({schemaVersion:1,project:{id:"project-one",displayName:"Property survey"},
      tasks:[{...task,modelVersionId:"replacement-version"}],nextCursor:null});
      return {grant:"hidden",grantExpiresAt:new Date(Date.now()+60_000).toISOString()};});
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
