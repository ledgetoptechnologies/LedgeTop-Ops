import {beforeEach,describe,expect,it,vi} from "vitest";

const calls=vi.hoisted(()=>({native:vi.fn(),select:vi.fn(),enqueue:vi.fn(),dispatch:vi.fn()}));
vi.mock("../src/worker/native-staff-auth",()=>({authenticateNativeStaffWithAdmissionVersion:calls.native}));
vi.mock("../src/worker/client-portal-workspace-binding-selection",()=>({selectPortalWorkspaceBinding:calls.select}));
vi.mock("../src/worker/client-portal-workspace-binding-outbox",()=>({
  enqueuePortalWorkspaceBinding:calls.enqueue,dispatchNextPortalWorkspaceBinding:calls.dispatch,
}));
import {handleWorkspaceBindingAdminHttp,
  type WorkspaceBindingAdminHttpDependencies} from "../src/worker/client-portal-workspace-binding-admin-http";

const origin="https://ops-staging.example.test",selectionId="11111111-1111-4111-8111-111111111111";
const actor={identity:{kind:"native" as const,staffId:"owner",verifiedAccessSubject:"access|owner",
  email:"owner@example.test",displayName:"Owner",profileVersion:2},admissionVersion:3,
  verifiedUntil:"2099-01-01T00:00:00.000Z"};
const unavailable=():never=>{throw Error("unexpected database use")};
const database={prepare:unavailable,batch:unavailable,exec:unavailable,withSession:unavailable,dump:unavailable} as D1Database;
const binding={bindWorkspace:vi.fn()};
const dependencies=(enabled=true,environment="staging")=>({environment,expectedHost:"ops-staging.example.test",configuration:{enabled,
  issuer:"https://team.cloudflareaccess.com",staffAudience:"synthetic-staff-audience",origin,
  csrfSecret:"workspace-binding-admin-secret-at-least-thirty-two-bytes"},database,
  dispatch:{OPS_DB:database,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
    CLIENT_AUTHORITY_WORKSPACE_BINDING:binding}});
const send=(path:string,method="GET",body?:unknown,csrf?:string,
  environment:WorkspaceBindingAdminHttpDependencies=dependencies(),requestOrigin=origin)=>
  handleWorkspaceBindingAdminHttp(new Request(`${origin}${path}`,{method,headers:{
    "X-Native-Staff-Request":"1","Sec-Fetch-Site":"same-origin",Origin:requestOrigin,
    "Content-Type":"application/json",...(csrf?{"X-CSRF-Token":csrf}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}),environment);
async function session(environment=dependencies()){
  const result=await send("/api/native-client-portal/workspace-binding/session","GET",undefined,undefined,environment);
  expect(result.status).toBe(200);return (await result.json() as {csrfToken:string}).csrfToken;
}

beforeEach(()=>{
  calls.native.mockReset().mockResolvedValue(actor);
  calls.select.mockReset().mockResolvedValue({selectionId,clientAuthorityId:"22222222-2222-4222-8222-222222222222",
    recordId:"33333333-3333-4333-8333-333333333333",activationId:"44444444-4444-4444-8444-444444444444",
    workspaceId:"workspace-a",sourceId:"project-alpha:primary",sourceWorkspaceId:"source-workspace-a",
    rootType:"organization",rootPublicId:"a".repeat(32),checkpoint:{sourceGeneration:"g",sourceSequence:1,
      snapshotGenerationId:"s"},state:"inactive",replayed:false});
  calls.enqueue.mockReset().mockResolvedValue({operationId:selectionId,state:"pending",replayed:false});
  calls.dispatch.mockReset().mockResolvedValue({status:"acknowledged",operationId:selectionId});
});

describe("native owner workspace-binding HTTP boundary",()=>{
  it("is absent unless both staging and the dedicated flag are active",async()=>{
    expect((await send("/api/native-client-portal/workspace-binding/session","GET",undefined,undefined,
      dependencies(false))).status).toBe(404);
    expect((await send("/api/native-client-portal/workspace-binding/session","GET",undefined,undefined,
      dependencies(true,"production"))).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
  });

  it("fails closed when the configured origin is not the exact staging host",async()=>{
    const wrong={...dependencies(),expectedHost:"ops.example.test"};
    expect((await send("/api/native-client-portal/workspace-binding/session","GET",undefined,undefined,wrong)).status)
      .toBe(503);
    const productionNamed={...dependencies(),expectedHost:"ops.example.test",configuration:{
      ...dependencies().configuration,origin:"https://ops.example.test"}};
    const request=new Request("https://ops.example.test/api/native-client-portal/workspace-binding/session",{
      headers:{"X-Native-Staff-Request":"1","Sec-Fetch-Site":"same-origin",Origin:"https://ops.example.test"}});
    expect((await handleWorkspaceBindingAdminHttp(request,productionNamed)).status).toBe(503);
    expect(calls.native).not.toHaveBeenCalled();
  });

  it("requires exact origin and CSRF before selection",async()=>{
    expect((await send("/api/native-client-portal/workspace-binding/session","GET",undefined,undefined,
      dependencies(),"https://evil.example.test")).status).toBe(403);
    expect((await send("/api/native-client-portal/workspace-binding/select","POST",{},"bad")).status).toBe(403);
    expect(calls.select).not.toHaveBeenCalled();
  });

  it("freezes and returns the review tuple without enqueueing",async()=>{
    const csrf=await session(),command={selectionId,recordId:"33333333-3333-4333-8333-333333333333",
      activationId:"44444444-4444-4444-8444-444444444444",workspaceId:"workspace-a",
      sourceWorkspaceId:"source-workspace-a",checkpoint:{sourceGeneration:"g",sourceSequence:1,
        snapshotGenerationId:"s"}};
    const result=await send("/api/native-client-portal/workspace-binding/select","POST",command,csrf);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({selectionId,workspaceId:"workspace-a",state:"inactive"});
    expect(calls.select).toHaveBeenCalledWith(database,actor,command);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("applies only the reviewed selection and dispatches that exact operation",async()=>{
    const csrf=await session();
    const result=await send("/api/native-client-portal/workspace-binding/apply","POST",{selectionId},csrf);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({selectionId,status:"acknowledged"});
    expect(calls.enqueue).toHaveBeenCalledWith(database,actor,selectionId);
    expect(calls.dispatch).toHaveBeenCalledWith(dependencies().dispatch,selectionId);
  });

  it("replays an acknowledged apply without another delivery",async()=>{
    calls.enqueue.mockResolvedValueOnce({operationId:selectionId,state:"acknowledged",replayed:true});
    const csrf=await session();
    const result=await send("/api/native-client-portal/workspace-binding/apply","POST",{selectionId},csrf);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({selectionId,status:"acknowledged"});
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("does not enqueue when the dispatcher flag or service binding is unavailable",async()=>{
    const csrf=await session();
    const disabled={...dependencies(),dispatch:{...dependencies().dispatch,
      CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"false"}};
    expect((await send("/api/native-client-portal/workspace-binding/apply","POST",{selectionId},csrf,disabled)).status)
      .toBe(503);
    const missing={...dependencies(),dispatch:{OPS_DB:database,
      CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",CLIENT_AUTHORITY_WORKSPACE_BINDING:undefined}};
    expect((await send("/api/native-client-portal/workspace-binding/apply","POST",{selectionId},csrf,missing)).status)
      .toBe(503);
    expect(calls.enqueue).not.toHaveBeenCalled();
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("reports an exact-operation idle race as accepted and pending",async()=>{
    calls.dispatch.mockResolvedValueOnce({status:"idle"});
    const csrf=await session();
    const result=await send("/api/native-client-portal/workspace-binding/apply","POST",{selectionId},csrf);
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({selectionId,status:"pending"});
  });
});
