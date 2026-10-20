import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerServiceClient } from "@ltds/shared";
import {
  currentNativeStaffAssociation, persistViewerAssociation, registerViewerIntegrationRoutes,
  resolveNativeViewerAssociationTarget,
} from "../src/worker/viewer-integration";
import type { Env, StaffPrincipal } from "../src/worker/types";

const instances: Miniflare[]=[];
const target={sourceId:"project-alpha:secondary",workspaceId:"workspace-two",projectPublicId:"shared-pa-id",
  projectId:"project-two",generationId:"generation-two",sourceVersion:"source-v2"};
const principal:StaffPrincipal={id:"staff-one",email:"staff@example.test",displayName:"Staff",
  accessSubject:"subject-one",projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+300};
const model={id:"model-one",title:"Map",provider:"webodm",status:"ready",available:true,updatedAt:"resource-v1",
  activeVersion:{id:"version-one",providerVersionId:"provider-version",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"}};
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(instances.splice(0).map(instance=>instance.dispose()));});

async function fixture(manage=true){
  const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
    script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:"native-associations"}});
  instances.push(mf);
  const database=await mf.getD1Database("DB") as unknown as D1Database;
  await database.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,project_alpha_project_id TEXT,
      source_updated_at TEXT,active INTEGER,project_name TEXT,client_name TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER);
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,
      entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT);
    INSERT INTO role_permissions VALUES('reader','viewer.view');
    INSERT INTO staff_role_assignments VALUES('staff-one','reader','global',NULL);
    INSERT INTO projects VALUES('project-one','project-alpha:primary','shared-pa-id','source-v1',1,'Drone project','Drone client'),
      ('project-two','project-alpha:secondary','shared-pa-id','source-v2',1,'Technology project','Technology client'),
      ('legacy-project','project-alpha:primary','legacy-pa','source-v1',1,'Legacy project','Legacy client');
    INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary','Drone client','active',NULL),
      ('workspace-two','project-alpha:secondary','Technology client','active',NULL);
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one'),('workspace-two','generation-two');
    INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1),('generation-two','workspace-two','active',1);
    INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','project','shared-pa-id','source-v1',1),
      ('workspace-two','generation-two','project','shared-pa-id','source-v2',1);
  `.replace(/\s*\n\s*/g," "));
  for(const migration of ["0138_viewer_model_associations.sql","0143_viewer_session_revocation_outbox.sql"]){
    await database.exec(readFileSync(new URL(`../../client/migrations/${migration}`,import.meta.url),"utf8")
      .replace(/^\s*--.*$/gm,"").replace(/\s*\n\s*/g," "));
  }
  if(manage)await database.prepare("INSERT INTO role_permissions VALUES('reader','viewer.manage')").run();
  const env={OPS_DB:database,DELIVERY_DB:database,AUDIT_IP_SECRET:"synthetic-audit-secret-not-a-real-credential",
    VIEWER_INTEGRATION_ENABLED:"true",VIEWER_BASE_URL:"https://viewer.example.test",
    VIEWER_SERVICE_KEY_ID:"test-key",VIEWER_SERVICE_HMAC_SECRET:"non-production-test-secret-32-characters"} as Env;
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  let sessionPrincipal={...principal};
  app.use("*",async(c,next)=>{c.set("principal",sessionPrincipal);await next();});
  registerViewerIntegrationRoutes(app);
  vi.spyOn(ViewerServiceClient.prototype,"listModels").mockResolvedValue([model]);
  vi.spyOn(ViewerServiceClient.prototype,"revokePublishedSessionSourceAuthorization")
    .mockImplementation(async input=>({sourceAuthorization:input.sourceAuthorization,revokedGrants:0,revokedSessions:0}));
  const call=(path:string,body?:unknown,key="native-association-key-0001")=>app.request(`https://ops.example.test${path}`,
    body===undefined?undefined:{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)},env);
  return {database,env,call,setPrincipal:(value:StaffPrincipal)=>{sessionPrincipal=value;}};
}

describe("native Viewer associations",()=>{
  it("allows global viewer.view-only catalog reads without legacy grants or manage, but denies writes",async()=>{
    const {call,database}=await fixture(false);
    const response=await call("/api/viewer/native-associations");
    expect(response.status).toBe(200);
    const body=await response.json() as {projects:Array<typeof target>};
    expect(body.projects).toHaveLength(2);
    expect(body.projects).toContainEqual(expect.objectContaining(target));
    expect(body.projects.map(project=>project.projectId)).not.toContain("legacy-project");
    expect((await call("/api/viewer/native-associations",{...target,viewerModelId:model.id})).status).toBe(403);
    await database.prepare("INSERT INTO staff_permission_overrides VALUES('staff-one','viewer.view','deny','global',NULL)").run();
    expect((await call("/api/viewer/native-associations")).status).toBe(403);
  });

  it("links only the selected source-qualified project, replays once, and creates no client grants",async()=>{
    const {call,database}=await fixture();
    const request={...target,viewerModelId:model.id};
    const created=await call("/api/viewer/native-associations",request);
    expect(created.status).toBe(201);
    const body=await created.json() as {association:{id:string;projectId:string}};
    expect(body.association.projectId).toBe(target.projectId);
    expect((await call("/api/viewer/native-associations",request)).status).toBe(200);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_model_associations").first("n")).toBe(1);
    expect(await database.prepare("SELECT association_version FROM viewer_model_associations").first("association_version")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_association_mutation_receipts").first("n")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE '%client_grants%'").first("n")).toBe(0);
    expect((await call("/api/viewer/native-associations",{...request,viewerModelId:"different-model"})).status).toBe(409);
  });

  it("rejects wrong source, workspace, project identity, generation and source version before linking",async()=>{
    const {call,database}=await fixture();
    const changes=[{sourceId:"project-alpha:primary"},{workspaceId:"workspace-one"},{projectId:"project-one"},
      {projectPublicId:"other-pa-id"},{generationId:"generation-one"},{sourceVersion:"source-v1"}];
    for(const change of changes)expect((await call("/api/viewer/native-associations",{...target,...change,viewerModelId:model.id})).status).toBe(409);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_model_associations").first("n")).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_association_mutation_receipts").first("n")).toBe(0);
  });

  it("aborts the whole mutation if the active generation changes after target lookup",async()=>{
    const {database,env}=await fixture();
    const project=await resolveNativeViewerAssociationTarget(env,target);
    const input={env,principal,project,model,idempotencyKey:"native-race-key-0001",fingerprint:"request-one",nativeTarget:target};
    const created=await persistViewerAssociation(input);
    await database.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-three' WHERE workspace_id=?")
      .bind(target.workspaceId).run();
    await expect(persistViewerAssociation({...input,idempotencyKey:"native-race-key-0002",fingerprint:"request-two"}))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT association_version FROM viewer_model_associations WHERE id=?").bind(created.id).first("association_version")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_association_mutation_receipts").first("n")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) n FROM viewer_session_revocation_outbox").first("n")).toBe(0);
  });

  it("fences source reassignment and workspace revocation at the actual D1 batch boundary",async()=>{
    const {database,env}=await fixture();
    const project=await resolveNativeViewerAssociationTarget(env,target);
    const batch=database.batch.bind(database);
    for(const mutation of ["UPDATE projects SET project_alpha_source_id='project-alpha:primary' WHERE id='project-two'",
      "UPDATE portal_v2_workspaces SET status='revoked' WHERE id='workspace-two'",
      "UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-three' WHERE workspace_id='workspace-two'"]){
      await database.prepare("UPDATE projects SET project_alpha_source_id='project-alpha:secondary' WHERE id='project-two'").run();
      await database.prepare("UPDATE portal_v2_workspaces SET status='active' WHERE id='workspace-two'").run();
      let raced=false,batchFailure="";
      const racingDatabase=new Proxy(database,{get(object,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
        raced=true;await database.prepare(mutation).run();try{return await batch(statements);}
        catch(error){batchFailure=String(error);throw error;}};
        if(key==='withSession')return ()=>racingDatabase;
        const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
      await expect(persistViewerAssociation({env:{...env,DELIVERY_DB:racingDatabase},principal,project,model,
        idempotencyKey:"native-boundary-key-0001",fingerprint:"request-one",nativeTarget:target})).rejects.toMatchObject({status:409});
      expect(raced).toBe(true);
      expect(batchFailure).toMatch(/malformed JSON/i);
      expect(await database.prepare("SELECT COUNT(*) n FROM viewer_model_associations").first("n")).toBe(0);
      expect(await database.prepare("SELECT COUNT(*) n FROM viewer_association_mutation_receipts").first("n")).toBe(0);
      expect(await database.prepare("SELECT COUNT(*) n FROM viewer_session_revocation_outbox").first("n")).toBe(0);
    }
  });

  it("resolves native staff sessions without legacy PA fallback and denies mismatched or revoked targets",async()=>{
    const {database,env,call,setPrincipal}=await fixture();
    const created=await call("/api/viewer/native-associations",{...target,viewerModelId:model.id});
    const {association}=await created.json() as {association:{id:string}};
    const session=vi.spyOn(ViewerServiceClient.prototype,"createSession").mockResolvedValue({grant:"grant-one",
      grantExpiresAt:new Date(Date.now()+60_000).toISOString(),sessionTtlSeconds:60,
      redeemUrl:"https://viewer.example.test/api/v1/sessions/redeem",embedUrl:"https://viewer.example.test/session/grant-one"});
    expect((await call(`/api/viewer/native-associations/${association.id}/session`,target,"native-session-key-0001")).status).toBe(201);
    expect(session).toHaveBeenCalledTimes(1);
    expect(Date.parse(session.mock.calls[0]![0].authorizationExpiresAt)).toBe(principal.accessExpiresAt!*1000);
    setPrincipal({...principal,accessExpiresAt:Math.floor(Date.now()/1000)-1});
    expect((await call(`/api/viewer/native-associations/${association.id}/session`,target,"native-session-key-0001")).status).toBe(401);
    setPrincipal({...principal,accessExpiresAt:principal.accessExpiresAt!+600});
    expect((await call(`/api/viewer/native-associations/${association.id}/session`,target,"native-session-key-0001")).status).toBe(409);
    setPrincipal({...principal});
    await database.exec(`INSERT INTO portal_v2_workspaces VALUES('workspace-three','project-alpha:secondary','Other authorized client','active',NULL);
      INSERT INTO portal_v2_directory_generations VALUES('generation-three','workspace-three','active',1);
      INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-three','generation-three');
      INSERT INTO portal_v2_directory_entities VALUES('workspace-three','generation-three','project','shared-pa-id','source-v2',1);`
      .replace(/\s*\n\s*/g," "));
    expect((await call(`/api/viewer/native-associations/${association.id}/session`,
      {...target,workspaceId:"workspace-three",generationId:"generation-three"},"native-session-key-0001")).status).toBe(409);
    for(const change of [{sourceId:"project-alpha:primary"},{workspaceId:"workspace-one"},{generationId:"generation-one"}]){
      expect((await call(`/api/viewer/native-associations/${association.id}/session`,{...target,...change},"native-session-key-0002")).status).toBe(409);
    }
    expect(session).toHaveBeenCalledTimes(1);
    await database.prepare("UPDATE viewer_model_associations SET state='revoked',revoked_at=datetime('now') WHERE id=?").bind(association.id).run();
    await expect(currentNativeStaffAssociation(env,target,association.id)).rejects.toMatchObject({status:404});
    expect((await call(`/api/viewer/native-associations/${association.id}/session`,target,"native-session-key-0003")).status).toBe(404);
    expect(session).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy persistence without requiring a native workspace tuple",async()=>{
    const {database,env}=await fixture();
    const created=await persistViewerAssociation({env,principal,project:{id:"legacy-project",project_alpha_project_id:"legacy-pa",
      project_name:"Legacy project",client_name:"Legacy client",source_updated_at:"source-v1"},model,
      idempotencyKey:"legacy-compatible-key-0001",fingerprint:"legacy-request"});
    expect(created.created).toBe(true);
    expect(await database.prepare("SELECT project_id FROM viewer_model_associations WHERE id=?").bind(created.id).first("project_id"))
      .toBe("legacy-project");
  });

  it("does not return a grant if its association refreshes during Viewer session creation",async()=>{
    const {database,call}=await fixture();
    const response=await call("/api/viewer/native-associations",{...target,viewerModelId:model.id});
    const {association}=await response.json() as {association:{id:string}};
    let refreshed=false;
    vi.spyOn(ViewerServiceClient.prototype,"createSession").mockImplementation(async()=>{
      await database.prepare(`UPDATE viewer_model_associations SET association_version=association_version+1,
        viewer_model_version_id='version-two' WHERE id=?`).bind(association.id).run();
      refreshed=true;
      return {grant:"must-not-return-this-grant",grantExpiresAt:new Date(Date.now()+60_000).toISOString(),sessionTtlSeconds:60,
        redeemUrl:"https://viewer.example.test/api/v1/sessions/redeem",embedUrl:"https://viewer.example.test/session/private-grant"};
    });
    const opened=await call(`/api/viewer/native-associations/${association.id}/session`,target,"native-session-race-key-0001");
    expect(refreshed).toBe(true);
    expect(opened.status).toBe(409);
    expect(await opened.text()).not.toContain("must-not-return-this-grant");
    expect(await database.prepare("SELECT state FROM viewer_model_associations WHERE id=?").bind(association.id).first("state")).toBe("active");
  });
});
