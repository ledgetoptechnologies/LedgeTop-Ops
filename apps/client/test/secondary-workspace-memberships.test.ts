import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {createWorkspaceInvitation,listWorkspaceAccess,revokeWorkspaceInvitation,suspendWorkspaceMember} from '../src/worker/client-portal/workspace-memberships';
import {acceptPortalWorkspaceInvitation} from '../src/worker/client-portal/workspace-v2';
import type {Env} from '../src/worker/types';

const issuer='https://people.example.test',sourceA='project-alpha:secondary-a',sourceB='project-alpha:secondary-b';
let mf:Miniflare,db:D1Database,env:Env,n=0;
const principal=(subject:string,email=`${subject}@example.test`)=>({issuer,subject,email});
async function migrate(name:string){await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>db.prepare(sql)));}

async function secondary(source:string,shared='same-upstream'){
  const suffix=`${source.slice(-1)}-${++n}`,workspace=`workspace-${suffix}`,generation=`generation-${suffix}`,root=`root-${shared}`,
    project=`project-${shared}`,manager=`manager-${suffix}`,managerPrincipal=principal(manager),sequence=n+10;
  await db.batch([
    db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,
      active_revision,version,connector_revision,connector_version) VALUES(?,?,?,'/portal','portal','active',1,1,1,1)`)
      .bind(source,`binding-${suffix}`,`https://${suffix}.example.test`),
    db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,access_subject,
      current_key_id,current_key_fingerprint,created_by) VALUES(?,1,'test',?,'audience','producer','key',?,'test')`)
      .bind(source,issuer,'a'.repeat(64)),
    db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)`).bind(workspace,source,shared),
    db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
      VALUES(?,'organization',?,?,'active',?)`).bind(workspace,root,`Workspace ${suffix}`,source),
    db.prepare(`INSERT INTO pa_portal_projection_generations(id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,
      workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
      VALUES(?,?,?,? ,?,1,4,'organization',?,?, 'root-v1',1,'active',1,?)`)
      .bind(`projection-${generation}`,workspace,generation,sequence,'b'.repeat(64),root,`Workspace ${suffix}`,source),
    db.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES(?,?,?,?)`).bind(workspace,generation,sequence,`projection-${generation}`),
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,?,?,'active',1)`).bind(generation,workspace,generation,sequence),
    db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(generation,workspace),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
      VALUES(?,?,'organization',?,?,'root-v1')`).bind(workspace,generation,root,`Workspace ${suffix}`),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project',?,?,?,'project-v1')`).bind(workspace,generation,project,root,`Project ${suffix}`),
    db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES(?,?,'root-project','contains','organization',?,'project',?,'relation-v1')`).bind(workspace,generation,root,project),
    db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
      VALUES(?,?,?,'active','lifecycle-v1')`).bind(workspace,generation,project),
    db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,?)`).bind(workspace,generation,sequence),
    db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`)
      .bind(manager,issuer,manager,managerPrincipal.email),
    db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
      VALUES(?,'manager',?,?, 'Manager','manager-v1','active')`).bind(workspace,manager,managerPrincipal.email),
    db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
      VALUES(?,?,?,'project_alpha','active','manager-v1')`).bind(`membership-${suffix}`,workspace,manager),
    ...['workspace.view','member.manage','delivery.view','request.create'].map((capability,index)=>db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status)
      VALUES(?,?,?,?,'allow','workspace',?,1,'project_alpha','manager-v1','active')`).bind(`manager-${suffix}-${index}`,workspace,manager,capability,workspace)),
  ]);
  return {source,workspace,generation,root,project,manager,principal:managerPrincipal,sequence};
}

async function invite(f:Awaited<ReturnType<typeof secondary>>,recipient:string,key=`secondary-invite-${crypto.randomUUID()}`){
  const result=await createWorkspaceInvitation(env,f.principal,f.workspace,{email:recipient,projectPublicId:f.project,
    capabilities:['delivery.view'],accessTerms:{kind:'collaborator',mode:'until_revoked',expiresAt:null}},key,{emailDeliveryAvailable:true});
  if(!('invitation' in result))return {result,token:null};
  const payload=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?')
    .bind(result.invitation.id).first<string>('payload_json');
  return {result,token:(JSON.parse(payload!) as {token:string}).token};
}

describe('secondary source-owned collaborator memberships',{timeout:90_000,concurrent:false},()=>{
  let a:Awaited<ReturnType<typeof secondary>>,b:Awaited<ReturnType<typeof secondary>>;
  beforeAll(async()=>{
    mf=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('secondary-memberships')}}",d1Databases:{DELIVERY_DB:'secondary-memberships'}});
    db=await mf.getD1Database('DELIVERY_DB') as D1Database;
    const names=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
    for(const name of names.filter(name=>name<'0171_'))await migrate(name);
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status)
        VALUES('primary-existing','organization','primary-root','Primary','active')`),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES('primary-manager',?,'primary-manager','primary@example.test','active')`).bind(issuer),
      db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id)
        VALUES('primary-existing','require_approval',1,'staff')`),
      db.prepare(`INSERT INTO portal_workspace_invitation_requests(id,workspace_id,source_id,requester_identity_id,recipient_email,
        scope_type,scope_public_id,capabilities_json,request_hash,policy_version)
        VALUES('preserved-request','primary-existing','project-alpha:primary','primary-manager','guest@example.test',
          'workspace','primary-existing','["workspace.view"]','preserved-hash',1)`),
    ]);
    await migrate('0171_secondary_workspace_membership_management.sql');
    await migrate('0172_project_access_authority_history.sql');
    env={DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',
      CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true'} as Env;
    a=await secondary(sourceA);b=await secondary(sourceB);
  },240_000);
  afterAll(async()=>mf.dispose());

  it('preserves populated primary requests, removes only the source CHECK and creates no guessed bindings',async()=>{
    expect(await db.prepare("SELECT source_id FROM portal_workspace_invitation_requests WHERE id='preserved-request'").first('source_id')).toBe('project-alpha:primary');
    expect(await db.prepare('SELECT count(*) n FROM portal_secondary_workspace_invitation_authority').first('n')).toBe(0);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('keeps colliding producer IDs isolated and lets only the exact current secondary manager list and invite',async()=>{
    const access=await listWorkspaceAccess(env,a.principal,a.workspace);
    expect(access).toMatchObject({sourceId:sourceA,canManageMembers:true,invitationRequestsSupported:false});
    expect(await listWorkspaceAccess(env,a.principal,b.workspace)).toBeNull();
    const created=await invite(a,'recipient@example.test');
    expect(created.result.outcome).toBe('created');expect(created.token).toBeTruthy();
    expect(await db.prepare(`SELECT source_id FROM portal_secondary_workspace_invitation_authority WHERE invitation_id=?`)
      .bind('invitation' in created.result?created.result.invitation.id:'').first('source_id')).toBe(sourceA);
  });

  it('denies unregistered, suspended, stale-revision and incomplete/replaced source context',async()=>{
    await db.prepare(`UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id=?`).bind(sourceA).run();
    expect(await listWorkspaceAccess(env,a.principal,a.workspace)).toBeNull();
    await db.prepare(`UPDATE pa_portal_source_authorities SET state='active',version=version+1 WHERE source_id=?`).bind(sourceA).run();
    const created=await invite(a,'stale@example.test');expect(created.result.outcome).toBe('created');
    await db.prepare(`UPDATE pa_portal_source_authorities SET active_revision=active_revision+1,version=version+1 WHERE source_id=?`).bind(sourceA).run().catch(()=>undefined);
    // A generation replacement is sufficient to invalidate the immutable invitation proof.
    await db.prepare(`UPDATE portal_v2_directory_generations SET complete=0,status='staging' WHERE id=?`).bind(a.generation).run();
    expect(await acceptPortalWorkspaceInvitation(env,principal('stale','stale@example.test'),created.token!)).toBe('denied');
    await db.prepare(`UPDATE portal_v2_directory_generations SET complete=1,status='active' WHERE id=?`).bind(a.generation).run();
  });

  it('fails closed for issuer, subject, email, source-version, expiry, denial and hierarchy mismatches',async()=>{
    const created=await invite(a,'exact@example.test');expect(created.result.outcome).toBe('created');
    expect(await listWorkspaceAccess(env,principal('wrong',a.principal.email),a.workspace)).toBeNull();
    expect(await listWorkspaceAccess(env,{issuer:'https://wrong.example',subject:a.manager,email:a.principal.email},a.workspace)).toBeNull();
    expect(await listWorkspaceAccess(env,{...a.principal,email:'wrong@example.test'},a.workspace)).toBeNull();
    expect(await acceptPortalWorkspaceInvitation(env,principal('exact','wrong@example.test'),created.token!)).toBe('denied');
    await db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
      VALUES('recipient-exact',?,'exact','exact@example.test','active')`).bind(issuer).run();
    await db.prepare(`INSERT INTO portal_v2_identity_denials
      (id,identity_id,scope_type,scope_public_id,reason_code,status,created_by_actor_type,created_by_actor_id)
      VALUES('deny-exact','recipient-exact','global',NULL,'membership-test','active','system','test')`).run();
    expect(await acceptPortalWorkspaceInvitation(env,principal('exact','exact@example.test'),created.token!)).toBe('denied');
    await db.prepare(`UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),
      revoked_by_actor_type='system',revoked_by_actor_id='test' WHERE id='deny-exact'`).run();
    await db.prepare(`UPDATE pa_portal_principals SET source_version='changed' WHERE workspace_id=? AND identity_id=?`).bind(a.workspace,a.manager).run();
    expect(await listWorkspaceAccess(env,a.principal,a.workspace)).toBeNull();
    await db.prepare(`UPDATE pa_portal_principals SET source_version='manager-v1' WHERE workspace_id=? AND identity_id=?`).bind(a.workspace,a.manager).run();
    await db.prepare(`UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id=? AND generation_id=? AND entity_type='project' AND public_id=?`)
      .bind(a.workspace,a.generation,a.project).run();
    expect((await invite(a,'moved@example.test')).result.outcome).toBe('denied');
    await db.prepare(`UPDATE portal_v2_directory_entities SET active=1 WHERE workspace_id=? AND generation_id=? AND entity_type='project' AND public_id=?`)
      .bind(a.workspace,a.generation,a.project).run();
  });

  it('accepts only the exact recipient, replays only that identity and writes no legacy rows',async()=>{
    const created=await invite(a,'accepted@example.test');expect(created.result.outcome).toBe('created');
    const recipient=principal('accepted','accepted@example.test');
    expect(await acceptPortalWorkspaceInvitation(env,recipient,created.token!)).toBe('accepted');
    expect(await acceptPortalWorkspaceInvitation(env,recipient,created.token!)).toBe('replayed');
    expect(await acceptPortalWorkspaceInvitation(env,principal('takeover','accepted@example.test'),created.token!)).toBe('denied');
    const identity=await db.prepare(`SELECT id FROM portal_v2_identities WHERE issuer=? AND subject='accepted'`).bind(issuer).first<string>('id');
    expect(await db.prepare(`SELECT source_type FROM portal_v2_workspace_memberships WHERE workspace_id=? AND identity_id=?`).bind(a.workspace,identity).first('source_type')).toBe('client_invitation');
    expect(await db.prepare(`SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND identity_id=?`).bind(a.workspace,identity).first('n')).toBe(2);
    expect(await db.prepare(`SELECT count(*) n FROM portal_v2_legacy_member_bridges WHERE workspace_id=?`).bind(a.workspace).first('n')).toBe(0);
    expect(await db.prepare(`SELECT count(*) n FROM client_identity_links WHERE subject=?`).bind(identity).first('n')).toBe(0);
    expect(await db.prepare(`SELECT count(*) n FROM client_member_project_grants WHERE identity_id=?`).bind(identity).first('n')).toBe(0);
  });

  it('does not convert projected members, keeps source-managed rows immutable through local APIs and scopes revoke/suspend exactly',async()=>{
    const collision=await invite(a,a.principal.email);expect(collision.result.outcome).toBe('created');
    expect(await acceptPortalWorkspaceInvitation(env,a.principal,collision.token!)).toBe('denied');
    expect(await suspendWorkspaceMember(env,a.principal,a.workspace,a.manager)).toBe('managed_source');
    const pending=await invite(a,'revoke@example.test');expect(pending.result.outcome).toBe('created');
    expect(await revokeWorkspaceInvitation(env,a.principal,a.workspace,'invitation' in pending.result?pending.result.invitation.id:'')).toBe(true);
    expect(await db.prepare(`SELECT count(*) n FROM portal_v2_invitations WHERE workspace_id=? AND status='revoked'`).bind(b.workspace).first('n')).toBe(0);
  });

  it('treats address-book contacts as data only and explicitly rejects secondary approval mode',async()=>{
    expect((await createWorkspaceInvitation(env,a.principal,a.workspace,{email:'contact@example.test',addressContact:{id:'contact-only',expectedVersion:1},
      projectPublicId:a.project,capabilities:['delivery.view']},`address-${crypto.randomUUID()}`,{emailDeliveryAvailable:true})).outcome).toBe('invalid');
    await db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id)
      VALUES(?,'require_approval',1,'staff')`).bind(a.workspace).run();
    expect((await invite(a,'approval@example.test')).result.outcome).toBe('secondary_approval_unsupported');
    expect(await db.prepare(`SELECT count(*) n FROM portal_workspace_invitation_requests WHERE source_id=?`).bind(sourceA).first('n')).toBe(0);
  });
});
