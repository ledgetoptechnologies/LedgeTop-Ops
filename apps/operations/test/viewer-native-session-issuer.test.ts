import { Miniflare } from "miniflare";
import { afterEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({
  authorize:vi.fn(async()=>true),
  resolve:vi.fn(async()=>({sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",
    contextVersion:"a".repeat(64),generationId:"generation-one",workspace:{membership_expires_at:null},
    grants:[] as Array<{effect:string;expires_at?:string|null}>})),
  issue:vi.fn(async()=>({grant:"00000000-0000-4000-8000-000000000001",grantExpiresAt:"2026-09-06T20:00:00.000Z",
    sessionTtlSeconds:900,redeemUrl:"https://viewer.example.test/api/v1/sessions/redeem",embedUrl:"https://viewer.example.test/session/grant"})),
}));
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
vi.mock("../../client/src/worker/client-portal/workspace-v2",()=>({
  authorizeNativePortalReadTarget:mocks.authorize,resolveNativePortalWorkspaceReadContext:mocks.resolve,
}));
vi.mock("../src/worker/viewer-integration",async importOriginal=>({
  ...(await importOriginal<typeof import("../src/worker/viewer-integration")>()),issueViewerSession:mocks.issue,
}));

import type { NativeClientViewerAuthorizationV1,NativeClientViewerSessionRequestV1 } from "@ltds/shared";
import { issueNativeClientViewerSession,listNativeClientViewerModels } from "../src/worker/viewer-session-issuer";
import type { Env } from "../src/worker/types";

const active:Miniflare[]=[];
const auth:NativeClientViewerAuthorizationV1={protocolVersion:1,sourceId:"project-alpha:primary",workspaceId:"workspace-one",
  identityId:"identity-one",principalIssuer:"https://portal.example.test",principalSubject:"subject-one",
  verifiedEmail:"person@example.test",projectPublicId:"pa-project-one",contextVersion:"a".repeat(64)};
async function fixture(){const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
  script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"native-viewer"}});active.push(mf);
  const database=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const statements=[`CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,project_alpha_project_id TEXT,source_updated_at TEXT,active INTEGER)`,
    `CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,project_id TEXT,project_alpha_project_id TEXT,project_source_version TEXT,
      viewer_model_id TEXT,viewer_model_version_id TEXT,viewer_resource_version TEXT,model_title TEXT,model_provider TEXT,model_status TEXT,
      state TEXT,association_version INTEGER,created_at TEXT,updated_at TEXT,revoked_at TEXT)`,
    `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER)`,
    `CREATE TABLE viewer_native_client_grants(id TEXT PRIMARY KEY,source_id TEXT,workspace_id TEXT,project_public_id TEXT,scope_type TEXT,
      association_id TEXT,include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,can_download INTEGER,
      authorization_expires_at TEXT,status TEXT,revoked_at TEXT)`,
    `CREATE TABLE viewer_session_issuance_receipts(actor_id TEXT,audience TEXT,idempotency_key TEXT,request_fingerprint TEXT,response_json TEXT,expires_at TEXT,
      PRIMARY KEY(actor_id,audience,idempotency_key))`,
    `INSERT INTO projects VALUES('project-one','project-alpha:primary','pa-project-one','source-v1',1)`,
    `INSERT INTO viewer_model_associations VALUES('association-one','project-one','pa-project-one','source-v1','model-one','version-one','resource-one',
      'Church model','webodm','ready','active',3,datetime('now'),datetime('now'),NULL)`,
    `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','project','pa-project-one','source-v1',1)`,
    `INSERT INTO viewer_native_client_grants VALUES('grant-one','project-alpha:primary','workspace-one','pa-project-one','task','association-one',0,1,1,0,NULL,'active',NULL)`];
  for(const statement of statements)await database.prepare(statement).run();
  return {database,env:{DELIVERY_DB:database,OPS_DB:database,CLIENT_VIEWER_SESSION_ISSUER_ENABLED:"true"} as Env};}
afterEach(async()=>{mocks.authorize.mockReset().mockResolvedValue(true);mocks.resolve.mockReset().mockResolvedValue({
  sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",contextVersion:"a".repeat(64),
  generationId:"generation-one",workspace:{membership_expires_at:null},grants:[] as Array<{effect:string;expires_at?:string|null}>,
});mocks.issue.mockClear();await Promise.all(active.splice(0).map(m=>m.dispose()));});

describe("native client Viewer issuance",()=>{
  it("lists only the exact source-qualified current association and never enables client resharing",async()=>{
    const {env}=await fixture();expect(await listNativeClientViewerModels(env,auth)).toEqual({ok:true,protocolVersion:1,models:[{
      associationId:"association-one",title:"Church model",provider:"webodm",modelId:"model-one",modelVersionId:"version-one",
      updatedAt:expect.any(String),canShare:false}]});
    expect(mocks.resolve).toHaveBeenCalledTimes(2);expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(),expect.anything(),"delivery.view",
      {scopeType:"project",publicId:"pa-project-one"});
  });

  it("issues for the stable individual identity and denies changed source/grant without a Viewer call",async()=>{
    const {database,env}=await fixture(),expiry=new Date(Date.now()+5*60_000).toISOString();
    mocks.resolve.mockResolvedValue({sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",
      contextVersion:"a".repeat(64),generationId:"generation-one",workspace:{membership_expires_at:null},
      grants:[{effect:"allow",expires_at:expiry}]});
    const request:NativeClientViewerSessionRequestV1={...auth,associationId:"association-one",
      idempotencyKey:"native-viewer-session-0001",displayUnits:"imperial"};
    expect(await issueNativeClientViewerSession(env,request)).toMatchObject({ok:true,modelId:"model-one"});
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({actorId:"identity-one",audience:"client",verifiedIndividualIdentity:{
      identityId:"identity-one",principalIssuer:"https://portal.example.test",principalSubject:"subject-one"}}));
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({association:expect.objectContaining({authorization_expires_at:expiry})}));
    mocks.issue.mockClear();
    expect(await issueNativeClientViewerSession(env,{...request,sourceId:"project-alpha:other",idempotencyKey:"native-viewer-session-0002"}))
      .toMatchObject({ok:false,code:"denied"});expect(mocks.issue).not.toHaveBeenCalled();
    await database.prepare("UPDATE viewer_native_client_grants SET status='revoked',revoked_at=datetime('now')").run();
    expect(await issueNativeClientViewerSession(env,{...request,idempotencyKey:"native-viewer-session-0003"}))
      .toMatchObject({ok:false,code:"denied"});expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("fails closed for a different individual or a context change between lookup and issuance",async()=>{
    const {env}=await fixture();const request:NativeClientViewerSessionRequestV1={...auth,associationId:"association-one",
      idempotencyKey:"native-viewer-session-0010",displayUnits:"metric"};
    expect(await issueNativeClientViewerSession(env,{...request,identityId:"identity-two"})).toMatchObject({ok:false,code:"denied"});
    expect(mocks.issue).not.toHaveBeenCalled();
    const base={sourceId:"project-alpha:primary",workspaceId:"workspace-one",identityId:"identity-one",
      generationId:"generation-one",workspace:{membership_expires_at:null},grants:[]};
    mocks.resolve.mockReset().mockResolvedValueOnce({...base,contextVersion:"a".repeat(64)})
      .mockResolvedValueOnce({...base,contextVersion:"b".repeat(64)});
    expect(await issueNativeClientViewerSession(env,{...request,idempotencyKey:"native-viewer-session-0011"}))
      .toMatchObject({ok:false,code:"denied"});expect(mocks.issue).not.toHaveBeenCalled();
  });
});
