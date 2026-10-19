import { readFileSync,readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  compareAndSwapProjectFolderAssociation,createPrimaryWorkspaceBinding,primaryWorkspaceBindingsReady,revokePrimaryWorkspaceBinding,
  searchPrimaryWorkspaceBindingTargets,suspendPrimaryWorkspaceBindingsForFolderReassignment,
} from "../src/worker/primary-delivery-workspace-bindings";
import { searchAuthenticatedDeliveryGrantAudiences,previewAuthenticatedDeliveryGrant,createAuthenticatedDeliveryGrant,revokeAuthenticatedDeliveryGrant } from "../src/worker/authenticated-delivery-grants";
import { listAuthorizedAuthenticatedDeliveryPrefixes } from "../../client/src/worker/client-portal/authenticated-delivery-grants";
import type { Env,StaffPrincipal } from "../src/worker/types";
import { reservePrimaryFolderMutation,attemptPrimaryFolderMutation,completePrimaryFolderMutation,reconcilePrimaryFolderMutation,primaryDivisionDeactivationStatement,readPrimaryFolderMutationReview,retryPrimaryDivisionMutation,suspendExplicitBindingsForDivisionDeactivation } from '../src/worker/primary-folder-authority-mutations';
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
async function signedStandaloneWorkspace(id:string,clientPublicId:string){
  const directory='directory-'+id,snapshot='snapshot-'+id;
  await delivery.batch([
    delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,display_name,status,project_alpha_source_id)
      VALUES(?,'standalone_client',?,'Standalone Owner','active','project-alpha:primary')`).bind(id,clientPublicId),
    delivery.prepare(`INSERT INTO pa_portal_projection_generations(id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,
      workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
      VALUES(?,?,'standalone-source',1,?,1,1,'standalone_client',?,'Standalone Owner','standalone-v1',1,'active',1,'project-alpha:primary')`)
      .bind(snapshot,id,'c'.repeat(64),clientPublicId),
    delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,'standalone-source',1,'active',1)`).bind(directory,id),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
      VALUES(?,?,'standalone_client',?,NULL,'Standalone Owner','standalone-v1',1)`).bind(id,directory,clientPublicId),
    delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(directory,id),
    delivery.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(id,directory),
    delivery.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES(?,'standalone-source',1,?)`).bind(id,snapshot),
    delivery.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES('project-alpha:primary',?,?,'snapshot_activate',?,1,'completed')`).bind('signed-'+id,id,'d'.repeat(64)),
  ]);
}

describe("primary signed workspace folder binding",{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS","DELIVERY"]});
    ops=await runtime.getD1Database("OPS") as D1Database;delivery=await runtime.getD1Database("DELIVERY") as D1Database;
    await migrate(ops,new URL("../migrations/",import.meta.url),"0050");
    await migrate(delivery,new URL("../../client/migrations/",import.meta.url),"0189");
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0233_explicit_primary_workspace_folder_ownership.sql',import.meta.url),'utf8')).map(sql=>delivery.prepare(sql)));
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

  it("explicitly links an unmapped folder to a reviewed signed workspace without creating client access",async()=>{
    const folder="Jobs/Clients/Lori Koschnick/";
    const targets=await searchPrimaryWorkspaceBindingTargets(env,staff,folder,"Acme",{divisionId:"division-one"});
    expect(targets.targets).toHaveLength(1);
    const selected=targets.targets[0]!;
    expect(selected).toMatchObject({workspaceId:workspace,ownershipMode:"explicit_workspace",divisionId:"division-one",ownerScopeType:"organization",projectPublicId:null});
    const input={folderRef:"explicit-folder-ref",workspaceId:workspace,ownershipMode:"explicit_workspace",divisionId:"division-one",ownerScopeType:'organization',ownerPublicId:organizationPublic,
      reasonCode:"reviewed_client_folder",expectedContextVersion:selected.contextVersion};
    const first=await createPrimaryWorkspaceBinding(env,staff,folder,input,"explicit-primary-folder-one");
    expect(first.binding).toMatchObject({state:"active",ownershipMode:"explicit_workspace",divisionId:"division-one",folderPrefix:folder});
    expect(await createPrimaryWorkspaceBinding(env,staff,folder,input,"explicit-primary-folder-one")).toEqual({...first,replayed:true});
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first<number>("n")).toBe(0);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first<number>("n")).toBe(0);
    const audience=await searchAuthenticatedDeliveryGrantAudiences(env,staff,first.binding!.bindingId,"Acme","organization");
    expect(audience.audiences).toContainEqual(expect.objectContaining({type:"organization",publicId:organizationPublic}));
    await expect(createPrimaryWorkspaceBinding(env,staff,folder,{...input,reasonCode:'changed_body'},"explicit-primary-folder-one")).rejects.toMatchObject({status:409});
    await expect(delivery.prepare("UPDATE portal_primary_staff_bindings SET ops_division_id='other-division' WHERE binding_id=?")
      .bind(first.binding!.bindingId).run()).rejects.toThrow(/primary-explicit-binding-immutable/);
  });

  it("rejects raw ancestor and descendant mappings even when PA joins would hide them",async()=>{
    for(const [projectId,prefix] of [['unjoined-project','Jobs/Raw/Missing/Child/'],['secondary-inactive-project','Jobs/Raw/Secondary/'],['malformed-raw-project','/Jobs//Raw/Malformed\\Child/']] as const){
      await ops.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'division-one',?,'manual',?)`)
        .bind(projectId,prefix,staff.id).run();
    }
    await ops.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
      VALUES('project-alpha:secondary','project','secondary-external-project','secondary-inactive-project')`).run();
    await ops.prepare(`INSERT INTO pa_projects(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES('secondary-inactive-project','Other source',0,'{}','raw-test','project-alpha:secondary')`).run();
    for(const folder of ['Jobs/Raw/Missing/','Jobs/Raw/Secondary/Child/','Jobs/Raw/Malformed/'])
      await expect(searchPrimaryWorkspaceBindingTargets(env,staff,folder,'Acme',{divisionId:'division-one'})).rejects.toMatchObject({status:409});
  });

  it("serializes binding publication against an ownership writer paused after its deny phase and reconciles the same operation",async()=>{
    const folder='Jobs/Fence/Unmapped/',targets=await searchPrimaryWorkspaceBindingTargets(env,staff,folder,'Acme',{divisionId:'division-one'});
    const op=await reservePrimaryFolderMutation(env,staff.id,'project_folder',{projectId:'fenced-project',previous:null,
      next:{divisionId:'division-one',r2Prefix:folder+'Child/'},confirmedBy:staff.id});
    expect(op).not.toBeNull();
    await suspendPrimaryWorkspaceBindingsForFolderReassignment(env,staff,{opsProjectId:'fenced-project',previousPrefix:null,
      nextPrefix:folder+'Child/',previousDivisionId:null,nextDivisionId:'division-one'});
    await attemptPrimaryFolderMutation(env,op);
    await expect(createPrimaryWorkspaceBinding(env,staff,folder,{folderRef:'fence-folder',workspaceId:workspace,ownershipMode:'explicit_workspace',
      divisionId:'division-one',ownerScopeType:'organization',ownerPublicId:organizationPublic,reasonCode:'reviewed_folder',expectedContextVersion:targets.targets[0]!.contextVersion},'fenced-binding-create'))
      .rejects.toThrow(/primary-folder-authority-publication-conflict/);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_folder_bindings WHERE r2_prefix=?").bind(folder).first('n')).toBe(0);
    await expect(reconcilePrimaryFolderMutation(env,op!.operationId,'cancel_reserved')).rejects.toMatchObject({status:409});
    await expect(reconcilePrimaryFolderMutation(env,op!.operationId,'reconcile')).rejects.toMatchObject({status:409});
    await compareAndSwapProjectFolderAssociation(env,{projectId:'fenced-project',previous:null,next:{divisionId:'division-one',r2Prefix:folder+'Child/'},confirmedBy:staff.id});
    expect(await reconcilePrimaryFolderMutation(env,op!.operationId,'reconcile')).toMatchObject({state:'completed',replayed:false});
    expect(await reconcilePrimaryFolderMutation(env,op!.operationId,'reconcile')).toMatchObject({state:'completed',replayed:true});
    await expect(searchPrimaryWorkspaceBindingTargets(env,staff,folder,'Acme',{divisionId:'division-one'})).rejects.toMatchObject({status:409});
    const reserved=await reservePrimaryFolderMutation(env,staff.id,'project_folder',{projectId:'never-attempted',previous:null,
      next:{divisionId:'division-one',r2Prefix:'Jobs/Never/'},confirmedBy:staff.id});
    expect(await reconcilePrimaryFolderMutation(env,reserved!.operationId,'cancel_reserved')).toMatchObject({state:'completed'});
    await expect(attemptPrimaryFolderMutation(env,reserved)).rejects.toMatchObject({status:409});
  });

  it("rejects overlapping explicit bindings and division permission or context drift without publishing",async()=>{
    const folder='Jobs/Clients/Lori Koschnick/Child/',targets=await searchPrimaryWorkspaceBindingTargets(env,staff,folder,'Acme',{divisionId:'division-one'});
    const input={folderRef:'overlap-ref',workspaceId:workspace,ownershipMode:'explicit_workspace',divisionId:'division-one',
      ownerScopeType:'organization',ownerPublicId:organizationPublic,reasonCode:'reviewed_folder',expectedContextVersion:targets.targets[0]!.contextVersion};
    await expect(createPrimaryWorkspaceBinding(env,staff,folder,input,'explicit-overlapping-binding')).rejects.toThrow(/primary-folder-authority-publication-conflict/);
    await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('explicit-division-deny',?,'delivery.share.create','deny','division','division-one','division-one',?)`).bind(staff.id,staff.id).run();
    try{await expect(searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/NoPermission/','Acme',{divisionId:'division-one'})).rejects.toMatchObject({status:404});}
    finally{await ops.prepare("DELETE FROM staff_permission_overrides WHERE id='explicit-division-deny'").run();}
    await expect(createPrimaryWorkspaceBinding(env,staff,'Jobs/StaleContext/',{...input,expectedContextVersion:'f'.repeat(64)},'explicit-stale-binding')).rejects.toMatchObject({status:409});
  });

  it("offers current permitted divisions but denies first ownership classification to a scoped-only sharer",async()=>{
    expect(await searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/UnmappedChoices/','')).toEqual({targets:[],divisionsRequired:true,
      divisions:[{divisionId:'division-chippewa-falls',label:'Chippewa Falls'},{divisionId:'division-one',label:'Division one'}]});
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE id='allow-delivery.share.create'").run();
    await ops.batch([
      ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES('scoped-only-create',?,'delivery.share.create','allow','division','division-one','division-one',?)`).bind(staff.id,staff.id),
      ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES('scoped-global-browse',?,'delivery.browse','allow','global','global',?)`).bind(staff.id,staff.id),
    ]);
    try{
      await expect(searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/ScopedClaim/','')).rejects.toMatchObject({status:404});
      await expect(searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/ScopedClaim/','Acme',{divisionId:'division-one'})).rejects.toMatchObject({status:404});
      await expect(createPrimaryWorkspaceBinding(env,staff,'Jobs/ScopedClaim/',{folderRef:'scoped-ref',workspaceId:workspace,ownershipMode:'explicit_workspace',
        divisionId:'division-one',ownerScopeType:'organization',ownerPublicId:organizationPublic,reasonCode:'scoped_claim',expectedContextVersion:'a'.repeat(64)},'scoped-claim-valid-key')).rejects.toMatchObject({status:404});
      // Existing project-derived classification keeps its division-scoped ACL.
      expect((await searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/Clients/Acme/Survey/Scoped/','')).targets).toHaveLength(1);
    }finally{
      await ops.prepare("DELETE FROM staff_permission_overrides WHERE id IN ('scoped-only-create','scoped-global-browse')").run();
      await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES('allow-delivery.share.create',?,'delivery.share.create','allow','global','global',?)`).bind(staff.id,staff.id).run();
    }
  });

  it("uses the exact client owner under its organization root and intersects an own-client PA entitlement with a separate principal grant",async()=>{
    const ownerId='3'.repeat(32),siblingId='4'.repeat(32),folder='Jobs/ClientOnlyOwner/';
    for(const [id,name] of [[ownerId,'ClientOnly Owner'],[siblingId,'Sibling Owner']])await delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES(?,'directory-primary-one','client',?,?,?,'client-v1',1)`).bind(workspace,id,organizationPublic,name),
      delivery.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES(?,'directory-primary-one',?,'contains','organization',?,'client',?,'relation-client-v1',1)`)
        .bind(workspace,'relation-'+id,organizationPublic,id),
    ]);
    for(const [id,clientId] of [['own-client',ownerId],['sibling-client',siblingId]])await delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`)
        .bind(id,issuer,id,id+'@example.test'),
      delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,source_version,status)
        VALUES(?,?,?,'project_alpha','person-v1','active')`).bind('member-'+id,workspace,id),
      delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,?,'person-v1','active')`).bind(workspace,'person-'+id,id,id+'@example.test',id),
      ...['workspace.view','directory.read','delivery.view'].map(capability=>delivery.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES(?,?,?,?,'allow',?,?,'project_alpha','own-client-v1','active')`)
        .bind(capability+'-'+id,workspace,id,capability,capability==='workspace.view'?'workspace':'client',capability==='workspace.view'?workspace:clientId)),
    ]);
    const target=(await searchPrimaryWorkspaceBindingTargets(env,staff,folder,'ClientOnly',{divisionId:'division-one'})).targets[0]!;
    expect(target).toMatchObject({rootPublicId:organizationPublic,ownerScopeType:'client',ownerPublicId:ownerId,projectPublicId:null});
    const linked=await createPrimaryWorkspaceBinding(env,staff,folder,{folderRef:'client-owned-ref',workspaceId:workspace,
      ownershipMode:'explicit_workspace',divisionId:'division-one',ownerScopeType:'client',ownerPublicId:ownerId,
      reasonCode:'client_owned_folder',expectedContextVersion:target.contextVersion},'explicit-client-owner-bind');
    const own={issuer,subject:'own-client',email:'own-client@example.test'},sibling={issuer,subject:'sibling-client',email:'sibling-client@example.test'};
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,own,workspace)).not.toContain(folder);
    const operation={folderBindingId:linked.binding!.bindingId,audienceType:'principal' as const,audiencePublicId:'person-own-client',reasonCode:'reviewed_client_delivery'};
    const preview=await previewAuthenticatedDeliveryGrant(env,staff,operation);
    expect(preview).toMatchObject({recipientCount:1,projectName:null,dynamicAudience:false});
    const granted=await createAuthenticatedDeliveryGrant(env,staff,{...operation,expectedContextVersion:preview.contextVersion},'explicit-client-owner-grant');
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,own,workspace)).toContain(folder);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,sibling,workspace)).not.toContain(folder);
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...operation,audiencePublicId:'person-sibling-client'})).rejects.toMatchObject({status:404});
    const mutation=await reservePrimaryFolderMutation(env,staff.id,'project_folder',{projectId:'client-owner-reassigned',previous:null,
      next:{divisionId:'division-one',r2Prefix:folder+'Child/'},confirmedBy:staff.id});
    // Workspace status cannot hide an ownership link from the deny phase.
    await delivery.prepare("UPDATE portal_v2_workspaces SET status='suspended' WHERE id=?").bind(workspace).run();
    await suspendPrimaryWorkspaceBindingsForFolderReassignment(env,staff,{opsProjectId:'client-owner-reassigned',previousPrefix:null,
      nextPrefix:folder+'Child/',previousDivisionId:null,nextDivisionId:'division-one'});
    await delivery.prepare("UPDATE portal_v2_workspaces SET status='active' WHERE id=?").bind(workspace).run();
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,own,workspace)).not.toContain(folder);
    await attemptPrimaryFolderMutation(env,mutation);
    await compareAndSwapProjectFolderAssociation(env,{projectId:'client-owner-reassigned',previous:null,next:{divisionId:'division-one',r2Prefix:folder+'Child/'},confirmedBy:staff.id});
    await completePrimaryFolderMutation(env,mutation);
    await expect(revokePrimaryWorkspaceBinding(env,staff,linked.binding!.bindingId,folder,{folderRef:'client-owned-ref',expectedVersion:2,reasonCode:'cleanup'},'explicit-client-unlink-before-revoke')).rejects.toMatchObject({status:409});
    await revokeAuthenticatedDeliveryGrant(env,staff,granted.grant.grantId,1,'cleanup','explicit-client-grant-revoke');
    const unlinked=await revokePrimaryWorkspaceBinding(env,staff,linked.binding!.bindingId,folder,{folderRef:'client-owned-ref',expectedVersion:2,reasonCode:'cleanup'},'explicit-client-unlink');
    expect(unlinked.binding).toMatchObject({state:'revoked',version:3});
  });

  it("normalizes only the exact standalone root client without creating aliases or widening another client's scope",async()=>{
    const ownWorkspace='standalone-own-workspace',otherWorkspace='standalone-other-workspace',ownId='5'.repeat(32),otherId='6'.repeat(32),folder='Jobs/StandaloneOwner/';
    await signedStandaloneWorkspace(ownWorkspace,ownId);await signedStandaloneWorkspace(otherWorkspace,otherId);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_directory_entities WHERE workspace_id=? AND entity_type='client'").bind(ownWorkspace).first('n')).toBe(0);
    const targets=await searchPrimaryWorkspaceBindingTargets(env,staff,folder,'Standalone',{divisionId:'division-one'});
    const selected=targets.targets.find(target=>target.workspaceId===ownWorkspace)!;
    expect(selected).toMatchObject({ownerScopeType:'client',ownerPublicId:ownId,rootType:'standalone_client',rootPublicId:ownId});
    const input={folderRef:'standalone-ref',workspaceId:ownWorkspace,ownershipMode:'explicit_workspace',divisionId:'division-one',
      ownerScopeType:'client',ownerPublicId:ownId,reasonCode:'standalone_owner',expectedContextVersion:selected.contextVersion};
    await expect(createPrimaryWorkspaceBinding(env,staff,folder,{...input,ownerPublicId:otherId},'standalone-wrong-owner')).rejects.toMatchObject({status:404});
    const linked=await createPrimaryWorkspaceBinding(env,staff,folder,input,'standalone-exact-owner');
    for(const [id,rootId] of [['standalone-own',ownId],['standalone-wrong',otherId]])await delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`).bind(id,issuer,id,id+'@example.test'),
      delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,source_version,status)
        VALUES(?,?,?,'project_alpha','person-v1','active')`).bind('membership-'+id,ownWorkspace,id),
      delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,?,'person-v1','active')`).bind(ownWorkspace,'person-'+id,id,id+'@example.test',id),
      ...['workspace.view','directory.read','delivery.view'].map(capability=>delivery.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES(?,?,?,?,'allow',?,?,'project_alpha','standalone-entitlement-v1','active')`).bind(id+'-'+capability,ownWorkspace,id,capability,
          capability==='workspace.view'?'workspace':'client',capability==='workspace.view'?ownWorkspace:rootId)),
    ]);
    const operation={folderBindingId:linked.binding!.bindingId,audienceType:'principal' as const,audiencePublicId:'person-standalone-own',reasonCode:'standalone_delivery'};
    const preview=await previewAuthenticatedDeliveryGrant(env,staff,operation);expect(preview.recipientCount).toBe(1);
    await createAuthenticatedDeliveryGrant(env,staff,{...operation,expectedContextVersion:preview.contextVersion},'standalone-principal-grant');
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,{issuer,subject:'standalone-own',email:'standalone-own@example.test'},ownWorkspace)).toContain(folder);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env as any,{issuer,subject:'standalone-wrong',email:'standalone-wrong@example.test'},ownWorkspace)).not.toContain(folder);
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...operation,audiencePublicId:'person-standalone-wrong'})).rejects.toMatchObject({status:404});
  });

  it("rejects a projected root with a parent even when the selected client reaches that root",async()=>{
    await delivery.prepare("UPDATE portal_v2_directory_entities SET parent_public_id=? WHERE workspace_id=? AND entity_type='organization' AND public_id=?")
      .bind('unexpected-parent',workspace,organizationPublic).run();
    try{
      await expect(searchPrimaryWorkspaceBindingTargets(env,staff,'Jobs/RootParentMalformed/','Acme',{divisionId:'division-one'})).rejects.toMatchObject({status:404});
    }finally{
      await delivery.prepare("UPDATE portal_v2_directory_entities SET parent_public_id=NULL WHERE workspace_id=? AND entity_type='organization' AND public_id=?")
        .bind(workspace,organizationPublic).run();
    }
  });

  it("retires PA-owned division deactivation without replaying writes and still reconciles a proven prior result",async()=>{
    const ids=['retry-division-a','retry-division-b'];
    await ops.batch(ids.map(id=>ops.prepare("INSERT INTO divisions(id,name,code,active,project_alpha_business_unit_id,updated_at) VALUES(?,?,?,1,?,'2026-10-16 00:00:00')").bind(id,id,id,id)));
    await ops.prepare("INSERT INTO pa_projection_entity_leases(projection_source_id,entity_type,entity_id,owner_event_id,lease_until) VALUES('project-alpha:primary','integration_projection','project-alpha','snapshot:retry-original',datetime('now','+1 hour'))").run();
    const expectedRows=(await ops.prepare("SELECT id,active,project_alpha_business_unit_id,updated_at FROM divisions WHERE id IN(?,?) ORDER BY id").bind(...ids).all<{id:string;active:number;project_alpha_business_unit_id:string|null;updated_at:string}>()).results;
    const witness={divisionIds:ids,sourceId:'project-alpha:primary',leaseOwner:'snapshot:retry-original',expectedRows};
    const mutation=await reservePrimaryFolderMutation(env,staff.id,'division_deactivation',witness);
    await attemptPrimaryFolderMutation(env,mutation);
    expect(()=>primaryDivisionDeactivationStatement(env,witness)).toThrow(/no longer control/);
    const review=await readPrimaryFolderMutationReview(env,mutation!.operationId);
    await expect(retryPrimaryDivisionMutation(env,mutation!.operationId,review.contextVersion)).rejects.toMatchObject({status:409});
    expect(await ops.prepare("SELECT count(*) n FROM divisions WHERE id IN(?,?) AND active=1").bind(...ids).first<number>('n')).toBe(2);
    // A result committed by the previous release may still be proven and closed.
    await ops.prepare("UPDATE divisions SET active=0 WHERE id IN(?,?)").bind(...ids).run();
    expect(await reconcilePrimaryFolderMutation(env,mutation!.operationId,'reconcile')).toMatchObject({state:'completed'});
    await ops.prepare("DELETE FROM pa_projection_entity_leases WHERE owner_event_id='snapshot:retry-original'").run();
  });

  it("lists only the exact signed primary project workspace and creates no access",async()=>{
    const grantsBefore=(await delivery.prepare('SELECT * FROM portal_v2_authenticated_delivery_grants ORDER BY id').all()).results;
    const membershipsBefore=(await delivery.prepare('SELECT * FROM portal_v2_workspace_memberships ORDER BY id').all()).results;
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
    expect((await delivery.prepare('SELECT * FROM portal_v2_authenticated_delivery_grants ORDER BY id').all()).results).toEqual(grantsBefore);
    expect((await delivery.prepare('SELECT * FROM portal_v2_workspace_memberships ORDER BY id').all()).results).toEqual(membershipsBefore);
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
    // Exercise the populated current-chain upgrade; prior ownership receipts
    // and public tokens must survive the additive ownership fence migration.
    const directory=new URL('../../client/migrations/',import.meta.url);
    for(const name of readdirSync(directory).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name.slice(0,4)>'0189'&&name.slice(0,4)<='0232').sort())
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>database.prepare(sql)));
    await database.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('upgrade-public-project','Legacy','Legacy','Jobs/Legacy/')").run();
    await database.prepare("INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id) VALUES('upgrade-public-link','upgrade-public-project','preserved-public-token-hash','staff','legacy-staff')").run();
    const receiptBefore=await database.prepare("SELECT * FROM portal_primary_staff_bindings WHERE binding_id='upgrade-binding'").first<Record<string,unknown>>();
    const publicBefore=await database.prepare("SELECT * FROM shares WHERE id='upgrade-public-link'").first();
    await database.batch(splitD1MigrationStatements(readFileSync(new URL('0233_explicit_primary_workspace_folder_ownership.sql',directory),'utf8')).map(sql=>database.prepare(sql)));
    expect(await database.prepare("SELECT * FROM portal_primary_staff_bindings WHERE binding_id='upgrade-binding'").first()).toEqual({...receiptBefore,ownership_kind:'project_mapping',ops_division_id:null});
    expect(await database.prepare("SELECT * FROM shares WHERE id='upgrade-public-link'").first()).toEqual(publicBefore);
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }finally{await upgrade.dispose();}
});

it("fresh Client install accepts the full canonical migration chain including explicit ownership",{timeout:180_000},async()=>{
  const fresh=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['FRESH']});
  try{
    const database=await fresh.getD1Database('FRESH') as D1Database;
    await migrate(database,new URL('../../client/migrations/',import.meta.url),'0233');
    expect(await database.prepare("SELECT name FROM sqlite_master WHERE name='portal_primary_folder_authority_mutations'").first<string>('name')).toBe('portal_primary_folder_authority_mutations');
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }finally{await fresh.dispose();}
});
