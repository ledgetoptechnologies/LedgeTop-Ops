import { readFileSync,readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  compareAndSwapProjectFolderAssociation,createPrimaryWorkspaceBinding,primaryWorkspaceBindingsReady,revokePrimaryWorkspaceBinding,
  searchPrimaryWorkspaceBindingTargets,suspendPrimaryWorkspaceBindingsForFolderReassignment,
} from "../src/worker/primary-delivery-workspace-bindings";
import { searchAuthenticatedDeliveryGrantAudiences } from "../src/worker/authenticated-delivery-grants";
import { listAuthorizedAuthenticatedDeliveryPrefixes } from "../../client/src/worker/client-portal/authenticated-delivery-grants";
import type { Env,StaffPrincipal } from "../src/worker/types";
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));

const staff:StaffPrincipal={id:"primary-binding-staff",email:"staff@example.test",displayName:"Staff",accessSubject:"staff-subject",projectAlphaUserId:null};
const organizationPublic="1".repeat(32),projectPublic="2".repeat(32),workspace="primary-workspace-one",issuer="https://clients.example.test";
let runtime:Miniflare,ops:D1Database,delivery:D1Database,env:Env;
let projectBindingId="",projectBindingSourceVersion="";
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
    delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
      VALUES(?,?,3)`).bind(directory,workspace),
    delivery.prepare(`INSERT INTO portal_v2_directory_relations
      (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
      VALUES(?,?,'project-parent','contains','organization',?,'project',?,'relation-v1',1)`)
      .bind(workspace,directory,organizationPublic,projectPublic),
    delivery.prepare(`INSERT INTO portal_v2_project_lifecycle
      (workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
      VALUES(?,?,?,'active',NULL,'lifecycle-v1')`).bind(workspace,directory,projectPublic),
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
    env={OPS_DB:ops,DELIVERY_DB:delivery,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:"true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true",PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:"true",AUTHENTICATED_DELIVERY_CREATION_ENABLED:"true"} as Env;
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
    projectBindingId=first.binding.bindingId;
    projectBindingSourceVersion=(await delivery.prepare("SELECT source_version FROM portal_v2_folder_bindings WHERE id=?")
      .bind(projectBindingId).first<string>("source_version"))!;
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
    const creationPaused={...env,AUTHENTICATED_DELIVERY_CREATION_ENABLED:"false"} as Env;
    await expect(createPrimaryWorkspaceBinding(creationPaused,staff,"Jobs/Clients/Acme/Survey/Paused/",{
      folderRef:"unused-paused-ref",workspaceId:workspace,reasonCode:"creation_paused",expectedContextVersion:result.targets[0]!.contextVersion,
    },"primary-paused-binding-create")).rejects.toMatchObject({status:503});
    const revoked=await revokePrimaryWorkspaceBinding(creationPaused,staff,created.binding.bindingId,"Jobs/Clients/Acme/",{
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

  it("serializes grant insertion against binding revocation in either transaction order",async()=>{
    const insert=(id:string)=>delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
      (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,
       audience_public_id,audience_source_version,reason_code,created_by_staff_id)
      VALUES(?,?,1,?,?,?,'organization',?,'org-v1','race_test',?)`)
      .bind(id,`${id}-logical`,workspace,projectBindingId,projectBindingSourceVersion,organizationPublic,staff.id);
    await expect(delivery.batch([
      insert("grant-race-first"),
      delivery.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(projectBindingId),
    ])).rejects.toThrow(/primary-staff-binding-active-grants/);
    await expect(delivery.batch([
      delivery.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(projectBindingId),
      insert("revoke-race-first"),
    ])).rejects.toThrow(/primary-staff-binding-required/);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants WHERE id IN (?,?)")
      .bind("grant-race-first","revoke-race-first").first<number>("n")).toBe(0);
    expect(await delivery.prepare("SELECT status FROM portal_v2_folder_bindings WHERE id=?").bind(projectBindingId).first<string>("status")).toBe("active");
  });

  it("suspends a receipt before audience search can rely on changed Operations authority",async()=>{
    await ops.prepare("UPDATE pa_projects SET updated_at=datetime('now','+1 minute') WHERE id=?").bind(projectPublic).run();
    await expect(searchAuthenticatedDeliveryGrantAudiences(env,staff,projectBindingId,"Acme","organization"))
      .rejects.toMatchObject({status:409});
    expect(await delivery.prepare("SELECT state FROM portal_primary_staff_bindings WHERE binding_id=?")
      .bind(projectBindingId).first<string>("state")).toBe("suspended");
    expect(await delivery.prepare("SELECT status FROM portal_v2_folder_bindings WHERE id=?")
      .bind(projectBindingId).first<string>("status")).toBe("suspended");
  });

  it("denies an old client before folder reassignment and preserves public links",async()=>{
    const folder="Jobs/Clients/Acme/Survey/Other/",targets=await searchPrimaryWorkspaceBindingTargets(env,staff,folder,"");
    const created=await createPrimaryWorkspaceBinding(env,staff,folder,{
      folderRef:"unused-reassignment-ref",workspaceId:workspace,reasonCode:"reassignment_fixture",
      expectedContextVersion:targets.targets[0]!.contextVersion,
    },"primary-reassignment-binding-create");
    if(!created.binding)throw new Error("Expected a reassignment fixture binding");
    const bindingId=created.binding.bindingId,sourceVersion=await delivery.prepare("SELECT source_version FROM portal_v2_folder_bindings WHERE id=?")
      .bind(bindingId).first<string>("source_version");
    await delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES('reassignment-identity',?,'reassignment-subject','client@example.test','active')`).bind(issuer),
      delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,source_version,status)
        VALUES('reassignment-membership',?,'reassignment-identity','project_alpha','person-v1','active')`).bind(workspace),
      delivery.prepare(`INSERT INTO pa_portal_principals
        (workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,'reassignment-person','reassignment-identity','client@example.test','Client','person-v1','active')`).bind(workspace),
      delivery.prepare(`INSERT INTO portal_project_access_terms
        (id,workspace_id,source_id,project_public_id,kind,mode,created_by_actor_type,created_by_actor_id)
        VALUES('reassignment-terms',?,'project-alpha:primary',?,'customer','until_revoked','staff',?)`).bind(workspace,projectPublic,staff.id),
      delivery.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,access_terms_id,status)
        VALUES('reassignment-entitlement',?,'reassignment-identity','delivery.view','allow','project',?,'operations',
          'reassignment-entitlement-v1','reassignment-terms','active')`).bind(workspace,projectPublic),
      delivery.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES('reassignment-workspace-view',?,'reassignment-identity','workspace.view','allow','workspace',?,'project_alpha','workspace-v1','active'),
          ('reassignment-directory-read',?,'reassignment-identity','directory.read','allow','workspace',?,'project_alpha','directory-v1','active')`)
        .bind(workspace,workspace,workspace,workspace),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
        (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,
         audience_public_id,audience_source_version,reason_code,created_by_staff_id,access_terms_id)
        VALUES('reassignment-grant','reassignment-grant',1,?,?,?,'principal','reassignment-person','person-v1',
          'reassignment_test',?,'reassignment-terms')`).bind(workspace,bindingId,sourceVersion,staff.id),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES('reassignment-grant',?,'reassignment-person','reassignment-identity','person-v1')`).bind(workspace),
      delivery.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('public-project','Client','Public','Public/Prefix/')"),
      delivery.prepare(`INSERT INTO shares(id,project_id,token_hash,label,created_by_type,created_by_id)
        VALUES('public-share','public-project','public-token-hash','Preserved','staff',?)`).bind(staff.id),
    ]);
    const client={issuer,subject:"reassignment-subject",email:"client@example.test"};
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,client,workspace)).toContain(folder);
    const secondarySource="project-alpha:secondary-preserved",secondaryWorkspace="secondary-preserved-workspace",
      secondaryBinding="secondary-preserved-binding";
    await delivery.batch([
      delivery.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
        application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,'secondary-producer','https://secondary.example.test','/','ltds_ops','active',1,1,1,1)`).bind(secondarySource),
      delivery.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES(?,?,?)`).bind(secondaryWorkspace,secondarySource,"secondary-external"),
      delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Secondary preserved','active',?)`).bind(secondaryWorkspace,organizationPublic,secondarySource),
      delivery.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES(?,?,'project',?,'Jobs/Clients/Acme/Survey/Native/','operations','native-v1','active')`)
        .bind(secondaryBinding,secondaryWorkspace,projectPublic),
      delivery.prepare(`INSERT INTO portal_native_staff_bindings
        (binding_id,source_id,workspace_id,project_id,project_public_id,r2_prefix,division_id)
        VALUES(?,?,?,?,?,'Jobs/Clients/Acme/Survey/Native/','division-one')`)
        .bind(secondaryBinding,secondarySource,secondaryWorkspace,"native-project",projectPublic),
    ]);
    const before=await delivery.prepare("SELECT * FROM shares WHERE id='public-share'").first();
    const result=await suspendPrimaryWorkspaceBindingsForFolderReassignment(env,staff,{
      opsProjectId:projectPublic,previousPrefix:"Jobs/Clients/Acme/Survey/",nextPrefix:"Jobs/Clients/Acme/Moved/",
      previousDivisionId:"division-one",nextDivisionId:"division-one",
    });
    expect(result.bindingIds).toContain(bindingId);
    // This is the secure crash boundary: old reads are denied even if the
    // subsequent OPS_DB write has not happened yet.
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,client,workspace)).toEqual(new Set());
    expect(await delivery.prepare("SELECT state FROM portal_primary_staff_bindings WHERE binding_id=?").bind(bindingId).first("state")).toBe("suspended");
    expect(await delivery.prepare("SELECT action FROM portal_primary_staff_binding_audit WHERE binding_id=? AND binding_version=2")
      .bind(bindingId).first("action")).toBe("binding.suspended");
    expect(await delivery.prepare("SELECT * FROM shares WHERE id='public-share'").first()).toEqual(before);
    expect(await delivery.prepare("SELECT status FROM portal_v2_folder_bindings WHERE id=?").bind(secondaryBinding).first("status")).toBe("active");
    await ops.prepare("UPDATE project_folders SET r2_prefix='Jobs/Clients/Acme/Moved/' WHERE project_id=?").bind(projectPublic).run();
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,client,workspace)).toEqual(new Set());
    // Retrying the deny phase is idempotent and cannot revive the old route.
    expect((await suspendPrimaryWorkspaceBindingsForFolderReassignment(env,staff,{
      opsProjectId:projectPublic,previousPrefix:"Jobs/Clients/Acme/Survey/",nextPrefix:"Jobs/Clients/Acme/Moved/",
      previousDivisionId:"division-one",nextDivisionId:"division-one",
    })).bindingIds).toEqual([]);
  });

  it("rejects a stale no-op compare-and-swap after a concurrent folder move",async()=>{
    const captured={divisionId:"division-one",r2Prefix:"Jobs/Clients/Acme/Survey/"};
    await ops.prepare("UPDATE project_folders SET r2_prefix='Jobs/Clients/Acme/Concurrent/' WHERE project_id=?")
      .bind(projectPublic).run();
    await expect(compareAndSwapProjectFolderAssociation(env,{
      projectId:projectPublic,previous:captured,next:captured,confirmedBy:staff.id,
    })).rejects.toMatchObject({status:409});
    expect(await ops.prepare("SELECT r2_prefix FROM project_folders WHERE project_id=?").bind(projectPublic).first("r2_prefix"))
      .toBe("Jobs/Clients/Acme/Concurrent/");
  });
});

it("migration 0189 backfills a coherent populated primary Operations binding",{timeout:180_000},async()=>{
  const upgrade=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DELIVERY_UPGRADE"]});
  try{
    const database=await upgrade.getD1Database("DELIVERY_UPGRADE") as D1Database;
    await migrate(database,new URL("../../client/migrations/",import.meta.url),"0188");
    await database.batch([
      database.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES('upgrade-workspace','organization',?,'Upgrade Workspace','active','project-alpha:primary')`).bind(organizationPublic),
      database.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
         workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
        VALUES('upgrade-snapshot','upgrade-workspace','upgrade-source',7,?,1,2,'organization',?,'Upgrade Workspace','workspace-v7',1,'active',1,'project-alpha:primary')`)
        .bind("c".repeat(64),organizationPublic),
      database.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES('upgrade-directory','upgrade-workspace','upgrade-source',7,'active',1)`),
      database.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES('upgrade-workspace','upgrade-directory','organization',?,NULL,'Upgrade Org','org-v7',1)`).bind(organizationPublic),
      database.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES('upgrade-workspace','upgrade-directory','project',?,?,'Upgrade Project','project-v7',1)`).bind(projectPublic,organizationPublic),
      database.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES('upgrade-workspace','upgrade-directory',7)`),
      database.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
        VALUES('upgrade-workspace','upgrade-source',7,'upgrade-snapshot')`),
      database.prepare(`INSERT INTO pa_portal_projection_receipts
        (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES('project-alpha:primary','upgrade-delivery','upgrade-workspace','snapshot_activate',?,7,'completed')`).bind("d".repeat(64)),
      database.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES('upgrade-binding','upgrade-workspace','project',?,'Jobs/Upgrade/','operations','project-v7','active')`).bind(projectPublic),
    ]);
    await expect(suspendPrimaryWorkspaceBindingsForFolderReassignment({
      ...env,DELIVERY_DB:database,
    },staff,{opsProjectId:"upgrade-project",previousPrefix:"Jobs/Upgrade/",nextPrefix:"Jobs/Moved/",
      previousDivisionId:"division-one",nextDivisionId:"division-one"})).rejects.toMatchObject({status:503});
    expect(await database.prepare("SELECT status,r2_prefix FROM portal_v2_folder_bindings WHERE id='upgrade-binding'").first())
      .toEqual({status:"active",r2_prefix:"Jobs/Upgrade/"});
    const migration=readFileSync(new URL("../../client/migrations/0189_primary_staff_folder_bindings.sql",import.meta.url),"utf8");
    await database.batch(splitD1MigrationStatements(migration).map(sql=>database.prepare(sql)));
    expect(await database.prepare(`SELECT workspace_id,source_id,owner_scope_type,owner_public_id,project_public_id,
      directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,
      reason_code,state,created_by_staff_id FROM portal_primary_staff_bindings WHERE binding_id='upgrade-binding'`).first()).toEqual({
      workspace_id:"upgrade-workspace",source_id:"project-alpha:primary",owner_scope_type:"project",owner_public_id:projectPublic,
      project_public_id:projectPublic,directory_generation_id:"upgrade-directory",snapshot_generation_id:"upgrade-snapshot",
      source_sequence:7,root_source_version:"org-v7",project_source_version:"project-v7",
      reason_code:"migration_0189_legacy_compat",state:"active",created_by_staff_id:"migration:0189",
    });
    expect(await database.prepare(`SELECT count(*) n FROM portal_v2_folder_bindings binding
      JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
      LEFT JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id AND receipt.state='active'
      WHERE binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL
        AND workspace.project_alpha_source_id='project-alpha:primary' AND receipt.binding_id IS NULL`).first<number>("n")).toBe(0);
  }finally{await upgrade.dispose();}
});
