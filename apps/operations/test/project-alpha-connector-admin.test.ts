import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const mocks=vi.hoisted(()=>({authenticateStaff:vi.fn()}));
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
vi.mock("../src/worker/auth",()=>({authenticateStaff:mocks.authenticateStaff}));
import worker from "../src/worker/index";
import { csrfToken } from "../src/worker/request-security";
import { registerProjectAlphaConnector, type RegisterProjectAlphaConnectorInput } from "../src/worker/project-alpha-connectors";
import type { Env, StaffPrincipal } from "../src/worker/types";

const ROOT="/api/admin/integrations/project-alpha/connectors";
const principal:StaffPrincipal={id:"registry-route-admin",email:"registry-admin@example.test",displayName:"Registry administrator",accessSubject:"verified-admin-subject",projectAlphaUserId:null};
// This route never uses the platform-only execution context members.
const executionCtx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
const publicKey=(seed:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
let runtime:Miniflare,db:D1Database,env:Env,sequence=0,portalUpgraded=false;
const revision={credentialRef:"secondary",snapshotBasePath:"/",accessIssuer:"https://access.example.test",accessAudience:"receiver-audience",accessSubject:"producer-service-token"};

function input():RegisterProjectAlphaConnectorInput {
  const suffix=`route-${++sequence}`;
  // Each new fixture connector has its own signing identity; no key reuse.
  env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=JSON.stringify({version:1,sets:{
    primary:{snapshotApiKey:"private-primary-snapshot-key",eventCurrent:{keyId:"primary",algorithm:"ed25519",value:publicKey(1)}},
    secondary:{snapshotApiKey:"private-secondary-snapshot-key",eventCurrent:{keyId:"secondary",algorithm:"ed25519",value:publicKey(sequence+10)},
      portalCurrent:{keyId:`portal-${sequence}`,value:`private-secondary-portal-key-${sequence}-longer-than-thirty-two-characters`}},
  }});
  return {sourceId:`project-alpha:${suffix}`,producerBindingId:suffix,snapshotOrigin:`https://${suffix}.example.test`,applicationKey:"ltds_ops",
    profile:"business_data",displayName:"Business connection",revision};
}
async function send(path:string,method="GET",body?:unknown,headers:Record<string,string>={}){
  const defaults:Record<string,string>=method==="GET"?{}:{Origin:"https://ops.example","Content-Type":"application/json","X-CSRF-Token":await csrfToken(env,principal)};
  return worker.fetch(new Request(`https://ops.example${path}`,{method,headers:{...defaults,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,executionCtx);
}
async function rows(table:"pa_connectors"|"pa_connector_audit"|"pa_connector_revisions"){
  return db.prepare(`SELECT count(*) total FROM ${table}`).first<number>("total");
}
async function registerPending(){
  const value=input();const response=await send(ROOT,"POST",value);expect(response.status).toBe(201);return value;
}
async function upgradePortal(){
  if(portalUpgraded)return;
  const delivery=await runtime.getD1Database("DELIVERY_DB") as D1Database;
  await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0039_portal_connector_coordination.sql",import.meta.url),"utf8")).map(sql=>db.prepare(sql)));
  await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0162_portal_source_authorities.sql",import.meta.url),"utf8")).map(sql=>delivery.prepare(sql)));
  env.DELIVERY_DB=delivery;
  env.PROJECT_ALPHA_PORTAL_HMAC_SECRET="primary-portal-fixture-signing-key-at-least-thirty-two-characters";
  portalUpgraded=true;
}

describe("Project Alpha connector administration HTTP boundary",{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB","DELIVERY_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    const directory=new URL("../migrations/",import.meta.url);
    for(const name of readdirSync(directory).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name.slice(0,4)<="0038").sort()){
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8")).map(sql=>db.prepare(sql)));
    }
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0046_project_alpha_project_management_routes.sql",import.meta.url),"utf8"))
      .map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(principal.id,principal.email,principal.displayName),
      db.prepare("INSERT INTO divisions(id,name,code) VALUES('registry-route-division','Route division','registry-route-division')"),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('registry-route-admin-role',?,'role-admin','global','global')").bind(principal.id),
    ]);
    env={OPS_DB:db,ENVIRONMENT:"development",EXPECTED_HOST:"ops.example",INCOMING_EXPECTED_HOST:"incoming.example",PUBLIC_BASE_URL:"https://ops.example",
      OPERATIONS_SESSION_SECRET:"fixture-session-secret-at-least-32-characters",AUDIT_IP_SECRET:"fixture-audit-secret-at-least-32-characters",APPLICATION_KEY:"ltds_ops",
      PROJECT_ALPHA_BASE_URL:"https://primary.example.test",PROJECT_ALPHA_API_KEY:"private-primary-snapshot-key",
      PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:publicKey(1),PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:{
        primary:{snapshotApiKey:"private-primary-snapshot-key",eventCurrent:{keyId:"primary",algorithm:"ed25519",value:publicKey(1)}},
      }})} as unknown as Env; // Unrelated Worker bindings are deliberately absent from this route fixture.
    await registerProjectAlphaConnector(env,{sourceId:"project-alpha:primary",producerBindingId:"primary-producer",snapshotOrigin:"https://primary.example.test",
      applicationKey:"ltds_ops",profile:"primary_legacy",displayName:"Primary",revision:{...revision,credentialRef:"primary"}},principal.id);
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id='project-alpha:primary'").run();
  },60_000);
  beforeEach(async()=>{
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    await db.batch([
      db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('registry-route-admin-role',?,'role-admin','global','global')").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin','integrations.manage')"),
    ]);
  },60_000);
  afterAll(async()=>{await runtime?.dispose();},60_000);

  it("rejects an unauthenticated caller before reading or changing the registry",async()=>{
    mocks.authenticateStaff.mockRejectedValue(new HTTPException(401,{message:"Authentication required"}));
    const before=await rows("pa_connector_audit");
    expect((await send(ROOT)).status).toBe(401);expect((await send(ROOT,"POST",input())).status).toBe(401);
    expect(await rows("pa_connector_audit")).toBe(before);
  });
  it("requires administrator membership in addition to a global integrations grant",async()=>{
    await db.batch([
      db.prepare("DELETE FROM staff_role_assignments WHERE id='registry-route-admin-role'"),
      db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('registry-allow',?,'integrations.manage','allow','global','global',?)").bind(principal.id,principal.id),
    ]);
    expect((await send(ROOT)).status).toBe(403);expect((await send(ROOT,"POST",input())).status).toBe(403);
  });
  it("does not promote a division-scoped integrations grant into global registry authority",async()=>{
    await db.batch([
      db.prepare("DELETE FROM role_permissions WHERE role_id='role-admin' AND permission_key='integrations.manage'"),
      db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES('registry-division',?,'integrations.manage','allow','division','registry-route-division','registry-route-division',?)").bind(principal.id,principal.id),
    ]);
    expect((await send(ROOT)).status).toBe(403);expect((await send(ROOT,"POST",input())).status).toBe(403);
  });
  it("honors a global deny on every registry read and action",async()=>{
    await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('registry-deny',?,'integrations.manage','deny','global','global',?)").bind(principal.id,principal.id).run();
    const before=await rows("pa_connector_audit");
    for(const [path,method,body] of [[ROOT,"GET",undefined],[ROOT,"POST",input()],[`${ROOT}/project-alpha:primary`,"PATCH",{expectedVersion:2,state:"suspended"}],
      [`${ROOT}/project-alpha:primary/revisions`,"POST",{expectedVersion:2,revision}],[`${ROOT}/project-alpha:primary/sync`,"POST",{}],
      [`${ROOT}/project-alpha:secondary/portal`,"POST",{expectedVersion:1,expectedPortalVersion:null,action:"configure"}],
      [`${ROOT}/recover-portal-update`,"POST",{expectedVersion:1}]] as const){
      expect((await send(path,method,body)).status).toBe(403);
    }
    expect(await rows("pa_connector_audit")).toBe(before);
  });
  it.each<Record<string,string>>([{Origin:"https://evil.example"},{"X-CSRF-Token":""}])("enforces the real origin and CSRF checks: %j",async(headers)=>{
    const before=await rows("pa_connectors");
    expect((await send(ROOT,"POST",input(),headers)).status).toBe(403);expect(await rows("pa_connectors")).toBe(before);
    expect((await send(`${ROOT}/project-alpha:secondary/portal`,"POST",{expectedVersion:1,expectedPortalVersion:null,action:"configure"},headers)).status).toBe(403);
    expect((await send(`${ROOT}/recover-portal-update`,"POST",{expectedVersion:1},headers)).status).toBe(403);
  });
  it("records only the authenticated actor and rejects actor/secret fields in strict JSON",async()=>{
    const value=input(),before=await rows("pa_connectors");
    expect((await send(ROOT,"POST",{...value,actorId:"spoofed-admin"})).status).toBe(400);
    expect((await send(ROOT,"POST",{...value,revision:{...revision,secret:"injected-secret"}})).status).toBe(400);
    expect(await rows("pa_connectors")).toBe(before);
    const response=await send(ROOT,"POST",value);expect(response.status).toBe(201);
    expect(await db.prepare("SELECT created_by,state FROM pa_connectors WHERE source_id=?").bind(value.sourceId).first()).toEqual({created_by:principal.id,state:"pending"});
    expect(await db.prepare("SELECT actor_id,action FROM pa_connector_audit WHERE source_id=?").bind(value.sourceId).first()).toEqual({actor_id:principal.id,action:"registered"});
  });
  it("fails stale version updates without creating another revision or audit event",async()=>{
    const value=await registerPending();
    expect((await send(`${ROOT}/${value.sourceId}`,"PATCH",{expectedVersion:1,state:"active"})).status).toBe(200);
    const auditBefore=await rows("pa_connector_audit"),revisionBefore=await rows("pa_connector_revisions");
    expect((await send(`${ROOT}/${value.sourceId}`,"PATCH",{expectedVersion:1,state:"suspended"})).status).toBe(409);
    expect((await send(`${ROOT}/${value.sourceId}/revisions`,"POST",{expectedVersion:1,revision})).status).toBe(409);
    expect(await rows("pa_connector_audit")).toBe(auditBefore);expect(await rows("pa_connector_revisions")).toBe(revisionBefore);
    expect(await db.prepare("SELECT state,version,active_revision FROM pa_connectors WHERE source_id=?").bind(value.sourceId).first()).toEqual({state:"active",version:2,active_revision:1});
  });
  it("requires explicit expected versions and strict sync action bodies",async()=>{
    expect((await send(`${ROOT}/project-alpha:primary`,"PATCH",{state:"suspended"})).status).toBe(400);
    expect((await send(`${ROOT}/project-alpha:primary/revisions`,"POST",{revision})).status).toBe(400);
    expect((await send(`${ROOT}/project-alpha:primary/sync`,"POST",{sourceId:"project-alpha:another"})).status).toBe(400);
  });
  it("returns a safe bounded registry summary without credentials or key material",async()=>{
    const response=await send(ROOT);expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toContain("no-store");
    const text=await response.text();expect(text).toContain("project-alpha:primary");
    for(const privateValue of ["private-primary-snapshot-key","private-secondary-snapshot-key",publicKey(1),"credentialRef","accessSubject","current_key_fingerprint"])
      expect(text).not.toContain(privateValue);
  });
  it("configures only a reviewed HTTPS project-management route with optimistic idempotent revisions",async()=>{
    const path=`${ROOT}/${encodeURIComponent("project-alpha:primary")}/project-management`;
    const initial=await send(ROOT);expect(initial.status).toBe(200);
    expect((await initial.json() as {projectManagement:unknown[]}).projectManagement).toEqual([]);
    const request={expectedConnectorVersion:2,expectedVersion:null,idempotencyKey:"route-operation-key-0001",
      reviewedUrlTemplate:"https://alpha.example.test/clients/{recordId}/projects/new"};
    const created=await send(path,"PUT",request);expect(created.status).toBe(200);
    expect((await created.json() as {projectManagement:Record<string,unknown>}).projectManagement).toEqual({
      sourceId:"project-alpha:primary",version:1,revision:1,enabled:true,
      reviewedUrlTemplate:request.reviewedUrlTemplate,replayed:false,
    });
    const before={
      revisions:await db.prepare("SELECT count(*) total FROM pa_connector_project_management_route_revisions").first<number>("total"),
      audit:await db.prepare("SELECT count(*) total FROM pa_connector_project_management_route_audit").first<number>("total"),
    };
    const replay=await send(path,"PUT",request);expect(replay.status).toBe(200);
    expect((await replay.json() as {projectManagement:{replayed:boolean}}).projectManagement.replayed).toBe(true);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_project_management_route_revisions").first<number>("total")).toBe(before.revisions);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_project_management_route_audit").first<number>("total")).toBe(before.audit);
    expect((await send(path,"PUT",{...request,reviewedUrlTemplate:"https://other.example.test/projects"})).status).toBe(409);
    expect((await send(path,"PUT",{...request,idempotencyKey:"route-operation-key-0002",expectedVersion:null})).status).toBe(409);
    const updated=await send(path,"PUT",{...request,idempotencyKey:"route-operation-key-0003",expectedVersion:1,
      reviewedUrlTemplate:"https://alpha.example.test/projects"});
    expect(updated.status).toBe(200);
    expect((await updated.json() as {projectManagement:Record<string,unknown>}).projectManagement).toMatchObject({version:2,revision:2,enabled:true,replayed:false});
    const disabled=await send(path,"PUT",{...request,idempotencyKey:"route-operation-key-0004",expectedVersion:2,reviewedUrlTemplate:null});
    expect(disabled.status).toBe(200);
    expect((await disabled.json() as {projectManagement:Record<string,unknown>}).projectManagement).toMatchObject({version:3,revision:3,enabled:false,reviewedUrlTemplate:null});
    const summary=await send(ROOT);expect(summary.status).toBe(200);
    expect((await summary.json() as {projectManagement:Array<Record<string,unknown>>}).projectManagement).toEqual([
      expect.objectContaining({sourceId:"project-alpha:primary",version:3,revision:3,enabled:false,reviewedUrlTemplate:null}),
    ]);
    const audit=await db.prepare("SELECT actor_id,action,details_json FROM pa_connector_project_management_route_audit ORDER BY route_version")
      .all<{actor_id:string;action:string;details_json:string}>();
    expect(audit.results.map(row=>({actor:row.actor_id,action:row.action,details:JSON.parse(row.details_json)}))).toEqual([
      {actor:principal.id,action:"configured",details:{enabled:true,templateKind:"record_path"}},
      {actor:principal.id,action:"configured",details:{enabled:true,templateKind:"base_url"}},
      {actor:principal.id,action:"disabled",details:{enabled:false,templateKind:"disabled"}},
    ]);
    expect(JSON.stringify(audit.results)).not.toContain("alpha.example.test");
  });
  it("rejects unsafe destinations, browser secrets, inactive sources, and immutable-ledger changes",async()=>{
    const value=await registerPending(),path=`${ROOT}/${encodeURIComponent(value.sourceId)}/project-management`;
    const request={expectedConnectorVersion:1,expectedVersion:null,idempotencyKey:"route-operation-key-unsafe",reviewedUrlTemplate:"https://alpha.example.test/projects"};
    expect((await send(path,"PUT",request)).status).toBe(409);
    expect((await send(`${ROOT}/${value.sourceId}`,"PATCH",{expectedVersion:1,state:"active",readVisible:true})).status).toBe(200);
    for(const reviewedUrlTemplate of ["http://alpha.example.test/projects","https://user:secret@alpha.example.test/projects",
      "https://alpha.example.test/projects?token=secret","https://alpha.example.test/projects#fragment",
      "https://alpha.example.test/clients/prefix-{recordId}/projects","https://alpha.example.test/clients/{recordId}/{recordId}"]){
      const response=await send(path,"PUT",{...request,expectedConnectorVersion:2,idempotencyKey:`unsafe-${crypto.randomUUID()}`,reviewedUrlTemplate});
      expect(response.status).toBe(400);
    }
    expect((await send(path,"PUT",{...request,expectedConnectorVersion:2,idempotencyKey:"route-operation-key-secret",credential:"browser-secret"})).status).toBe(400);
    const good=await send(path,"PUT",{...request,expectedConnectorVersion:2,idempotencyKey:"route-operation-key-good"});expect(good.status).toBe(200);
    await expect(db.prepare("UPDATE pa_connector_project_management_route_revisions SET reviewed_url_template='https://evil.example.test'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM pa_connector_project_management_route_audit").run()).rejects.toThrow(/persistent/);
    await expect(db.prepare("UPDATE pa_connector_project_management_route_mutations SET source_id='project-alpha:primary'").run()).rejects.toThrow(/immutable/);
  });
  it("reports recovery independently from connection health without scheduling or enabling a pending source",async()=>{
    const value=await registerPending();
    const auditBefore=await rows("pa_connector_audit");
    const response=await send(ROOT);expect(response.status).toBe(200);
    const body=await response.json() as {recovery:Array<Record<string,unknown>>};
    expect(body.recovery.find(row=>row.sourceId===value.sourceId)).toEqual({
      sourceId:value.sourceId,status:"never",lastAttemptAt:null,lastSuccessAt:null,nextAttemptAt:null,errorCode:null,failureCount:0,
    });
    expect(body.recovery.some(row=>row.sourceId==="project-alpha:primary")).toBe(false);
    expect(await db.prepare("SELECT state,read_visible FROM pa_connectors WHERE source_id=?").bind(value.sourceId).first())
      .toEqual({state:"pending",read_visible:0});
    expect(await db.prepare("SELECT count(*) total FROM pa_snapshot_recovery_attempts").first("total")).toBe(0);
    expect(await rows("pa_connector_audit")).toBe(auditBefore);
  });
  it("does not expose unknown stored recovery diagnostics or internal lease fields",async()=>{
    const value=await registerPending();
    await db.prepare(`UPDATE pa_snapshot_recovery_sources SET status='failed',last_attempt_at=1787745600000,
      next_attempt_at=1787749200000,failure_count=2,error_code='project-alpha-private-diagnostic-fixture' WHERE source_id=?`)
      .bind(value.sourceId).run();
    const response=await send(ROOT);expect(response.status).toBe(200);
    const body=await response.json() as {recovery:Array<Record<string,unknown>>};
    expect(body.recovery.find(row=>row.sourceId===value.sourceId)).toEqual({
      sourceId:value.sourceId,status:"failed",lastAttemptAt:new Date(1787745600000).toISOString(),lastSuccessAt:null,
      nextAttemptAt:new Date(1787749200000).toISOString(),errorCode:"project-alpha-recovery-failed",failureCount:2,
    });
    expect(JSON.stringify(body)).not.toContain("project-alpha-private-diagnostic-fixture");
    expect(JSON.stringify(body)).not.toMatch(/scheduler_token|lease_token|attempt_id|deadline_at/);
  });
  it("rejects an oversized actual JSON body even with a smaller declared length",async()=>{
    const value={...input(),displayName:"x".repeat(17*1024)},before=await rows("pa_connectors");
    expect((await send(ROOT,"POST",value,{"Content-Length":"2"})).status).toBe(413);
    expect(await rows("pa_connectors")).toBe(before);
  });
  it("rejects browser-supplied portal authentication and actor fields",async()=>{
    const body={expectedVersion:1,expectedPortalVersion:null,action:"configure"};
    for(const extra of [{actorId:"spoofed"},{credentialRef:"other"},{accessAudience:"other"},{portalCurrent:{keyId:"fake",value:"secret"}}])
      expect((await send(`${ROOT}/project-alpha:secondary/portal`,"POST",{...body,...extra})).status).toBe(400);
    expect((await send(`${ROOT}/recover-portal-update`,"POST",{expectedVersion:1,actorId:"spoofed"})).status).toBe(400);
  });
  it("stages and activates the same connection's client portal with explicit versions and the authenticated actor",async()=>{
    await upgradePortal();
    const value=await registerPending();
    expect((await send(`${ROOT}/${value.sourceId}`,"PATCH",{expectedVersion:1,state:"active"})).status).toBe(200);
    const path=`${ROOT}/${value.sourceId}/portal`;
    const staged=await send(path,"POST",{expectedVersion:2,expectedPortalVersion:null,action:"configure"});
    expect(staged.status).toBe(200);
    expect((await staged.json() as {authority:{state:string;version:number}}).authority).toMatchObject({state:"pending",version:1});
    const active=await send(path,"POST",{expectedVersion:2,expectedPortalVersion:1,action:"activate"});
    expect(active.status).toBe(200);
    expect((await active.json() as {authority:{state:string}}).authority.state).toBe("active");
    expect((await send(`${ROOT}/${value.sourceId}`,"PATCH",{expectedVersion:2,state:"suspended"})).status).toBe(200);
    expect(await env.DELIVERY_DB.prepare("SELECT state FROM pa_portal_source_authorities WHERE source_id=?").bind(value.sourceId).first("state")).toBe("suspended");
    const actors=await env.DELIVERY_DB.prepare("SELECT DISTINCT actor_id FROM pa_portal_source_authority_audit WHERE source_id=?").bind(value.sourceId).all<{actor_id:string}>();
    expect(actors.results).toEqual([{actor_id:principal.id}]);
    const summary=await send(ROOT);expect(summary.status).toBe(200);
    const text=await summary.text();expect(text).not.toContain("private-secondary-portal-key");expect(text).not.toContain("access_subject");
  });
  it("returns actionable credential errors and exposes explicit recovery instead of a generic 500",async()=>{
    await upgradePortal();
    const value=await registerPending();
    const credentials=JSON.parse(env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS!);
    delete credentials.sets.secondary.portalCurrent;
    env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=JSON.stringify(credentials);
    const response=await send(`${ROOT}/${value.sourceId}/portal`,"POST",{expectedVersion:1,expectedPortalVersion:null,action:"configure"});
    expect(response.status).toBe(503);
    const body=await response.json() as {error:string;code:string};
    expect(body.code).toBe("PROJECT_ALPHA_PORTAL_CREDENTIALS_UNAVAILABLE");
    expect(body.error).toContain("Deploy this connection's portal signing credentials");
    const status=await (await send(ROOT)).json() as {portal:{recovery:{version:number;sourceId:string}}};
    expect(status.portal.recovery.sourceId).toBe(value.sourceId);
    expect((await send(`${ROOT}/recover-portal-update`,"POST",{expectedVersion:status.portal.recovery.version})).status).toBe(200);
    expect((await (await send(ROOT)).json() as {portal:{recovery:null}}).portal.recovery).toBeNull();
  });
});
