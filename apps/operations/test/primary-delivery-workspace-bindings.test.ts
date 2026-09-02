import { readFileSync,readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  createPrimaryWorkspaceBinding,primaryWorkspaceBindingsReady,revokePrimaryWorkspaceBinding,
  searchPrimaryWorkspaceBindingTargets,
} from "../src/worker/primary-delivery-workspace-bindings";
import { searchAuthenticatedDeliveryGrantAudiences } from "../src/worker/authenticated-delivery-grants";
import type { Env,StaffPrincipal } from "../src/worker/types";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));

const staff:StaffPrincipal={id:"primary-binding-staff",email:"staff@example.test",displayName:"Staff",accessSubject:"staff-subject",projectAlphaUserId:null};
const organizationPublic="1".repeat(32),projectPublic="2".repeat(32),workspace="primary-workspace-one",issuer="https://clients.example.test";
let runtime:Miniflare,ops:D1Database,delivery:D1Database,env:Env;
async function migrate(database:D1Database,path:URL,cap:string){
  for(const name of readdirSync(path).filter(value=>/^\d{4}_.*\.sql$/.test(value)&&value.slice(0,4)<=cap).sort())
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),"utf8")).map(sql=>database.prepare(sql)));
}
async function signedWorkspace(){
  const snapshot="snapshot-primary-one",directory="directory-primary-one";
  await delivery.batch([
    delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
      VALUES(?,'organization',?,'Acme Workspace','active','project-alpha:primary')`).bind(workspace,organizationPublic),
    delivery.prepare(`INSERT INTO pa_portal_projection_generations
      (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
       workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
      VALUES(?,?,'source-one',1,?,1,2,'organization',?,'Acme Workspace','workspace-v1',1,'active',1,'project-alpha:primary')`)
      .bind(snapshot,workspace,"a".repeat(64),organizationPublic),
    delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,'source-one',1,'active',1)`).bind(directory,workspace),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities
      (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      VALUES(?,?,'organization',?,NULL,'Acme Organization','org-v1',1)`).bind(workspace,directory,organizationPublic),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities
      (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      VALUES(?,?,'project',?,?,'Acme Survey','project-v1',1)`).bind(workspace,directory,projectPublic,organizationPublic),
    delivery.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(workspace,directory),
    delivery.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES(?,'source-one',1,?)`).bind(workspace,snapshot),
    delivery.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES('project-alpha:primary','signed-primary-one',?,'snapshot_activate',?,1,'completed')`).bind(workspace,"b".repeat(64)),
  ]);
}

describe("primary signed workspace folder binding",{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS","DELIVERY"]});
    ops=await runtime.getD1Database("OPS") as D1Database;delivery=await runtime.getD1Database("DELIVERY") as D1Database;
    await migrate(ops,new URL("../migrations/",import.meta.url),"0050");
    await migrate(delivery,new URL("../../client/migrations/",import.meta.url),"0189");
    env={OPS_DB:ops,DELIVERY_DB:delivery,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true"} as Env;
    await ops.batch([
      ops.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`).bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
      ops.prepare(`INSERT INTO divisions(id,name,code,active) VALUES('division-one','Division one','ONE',1)`),
      ops.prepare(`INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,'Acme Organization','{}','sync-org','project-alpha:primary')`).bind(organizationPublic),
      ops.prepare(`INSERT INTO pa_projects(id,organization_id,name,payload_json,last_sync_id,projection_source_id)
        VALUES(?,?,'Acme Survey','{}','sync-project','project-alpha:primary')`).bind(projectPublic,organizationPublic),
      ops.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
        VALUES(?,'division-one','Jobs/Clients/Acme/Survey/','manual',?)`).bind(projectPublic,staff.id),
    ]);
    for(const permission of ["delivery.share.create","delivery.share.revoke"])
      await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES(?,?,?,'allow','global','global',?)`).bind(`allow-${permission}`,staff.id,permission,staff.id).run();
    await signedWorkspace();
  },180_000);
  afterAll(async()=>runtime.dispose());

  it("lists only the exact signed primary project workspace and creates no access",async()=>{
    expect(await primaryWorkspaceBindingsReady(env)).toBe(true);
    const result=await searchPrimaryWorkspaceBindingTargets(env,staff,"Jobs/Clients/Acme/Survey/Deliverables/","Acme");
    expect(result.targets).toHaveLength(1);expect(result.targets[0]).toMatchObject({workspaceId:workspace,sourceId:"project-alpha:primary",
      ownerScopeType:"project",ownerPublicId:projectPublic,projectPublicId:projectPublic});
    const input={folderRef:"unused-ref",workspaceId:workspace,reasonCode:"client_workspace_link",expectedContextVersion:result.targets[0]!.contextVersion};
    const first=await createPrimaryWorkspaceBinding(env,staff,"Jobs/Clients/Acme/Survey/Deliverables/",input,"primary-binding-create-one");
    const second=await createPrimaryWorkspaceBinding(env,staff,"Jobs/Clients/Acme/Survey/Deliverables/",input,"primary-binding-create-one");
    expect(first.replayed).toBe(false);expect(second).toEqual({...first,replayed:true});
    expect(first.binding).not.toBeNull();if(!first.binding)throw new Error("Expected an active primary folder binding");
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first<number>("n")).toBe(0);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first<number>("n")).toBe(0);
    const audiences=await searchAuthenticatedDeliveryGrantAudiences(env,staff,first.binding.bindingId,"Acme","organization");
    expect(audiences.audiences).toContainEqual(expect.objectContaining({type:"organization",publicId:organizationPublic,recipientMode:"dynamic"}));
  });

  it("links an exact organization root only when all explicit descendant project mappings agree",async()=>{
    const result=await searchPrimaryWorkspaceBindingTargets(env,staff,"Jobs/Clients/Acme/","");
    expect(result.targets).toHaveLength(1);expect(result.targets[0]).toMatchObject({workspaceId:workspace,ownerScopeType:"organization",
      ownerPublicId:organizationPublic,projectPublicId:null});
    const created=await createPrimaryWorkspaceBinding(env,staff,"Jobs/Clients/Acme/",{
      folderRef:"unused-root-ref",workspaceId:workspace,reasonCode:"client_workspace_root_link",expectedContextVersion:result.targets[0]!.contextVersion,
    },"primary-root-binding-create");
    expect(created.binding).toMatchObject({state:"active",ownerScopeType:"organization",ownerPublicId:organizationPublic});
    if(!created.binding)throw new Error("Expected an active primary root binding");
    const revoked=await revokePrimaryWorkspaceBinding(env,staff,created.binding.bindingId,"Jobs/Clients/Acme/",{
      folderRef:"unused-root-ref",expectedVersion:1,reasonCode:"client_workspace_root_unlink",
    },"primary-root-binding-revoke");
    expect(revoked.binding).toMatchObject({state:"revoked",version:2});
    expect(await revokePrimaryWorkspaceBinding(env,staff,created.binding.bindingId,"Jobs/Clients/Acme/",{
      folderRef:"unused-root-ref",expectedVersion:1,reasonCode:"client_workspace_root_unlink",
    },"primary-root-binding-revoke")).toEqual({...revoked,replayed:true});
  });

  it("rejects an unsigned or wrong-root workspace and stale reviewed context without writes",async()=>{
    await delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
      VALUES('wrong-root-workspace','organization',?,'Wrong root','active','project-alpha:primary')`).bind("9".repeat(32)).run();
    const targets=await searchPrimaryWorkspaceBindingTargets(env,staff,"Jobs/Clients/Acme/Survey/","");
    await expect(createPrimaryWorkspaceBinding(env,staff,"Jobs/Clients/Acme/Survey/",{
      folderRef:"unused",workspaceId:"wrong-root-workspace",reasonCode:"wrong_root",expectedContextVersion:targets.targets[0]!.contextVersion,
    },"primary-wrong-root-key")).rejects.toMatchObject({status:404});
    await expect(createPrimaryWorkspaceBinding(env,staff,"Jobs/Clients/Acme/Survey/",{
      folderRef:"unused",workspaceId:workspace,reasonCode:"stale_context",expectedContextVersion:"f".repeat(64),
    },"primary-stale-context-key")).rejects.toMatchObject({status:409});
    expect(await delivery.prepare("SELECT count(*) n FROM portal_primary_staff_binding_mutations WHERE idempotency_key IN (?,?)")
      .bind("primary-wrong-root-key","primary-stale-context-key").first<number>("n")).toBe(0);
  });
});
