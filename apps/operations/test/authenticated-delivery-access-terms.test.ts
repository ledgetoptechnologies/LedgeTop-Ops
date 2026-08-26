import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {createAuthenticatedDeliveryGrant,previewAuthenticatedDeliveryGrant,listAuthenticatedDeliveryGrants,revokeAuthenticatedDeliveryGrant,
  restoreAuthenticatedDeliveryGrant,type AuthenticatedDeliveryGrantInput} from '../src/worker/authenticated-delivery-grants';
import {authorizeAuthenticatedDeliveryGrant,listAuthorizedAuthenticatedDeliveryPrefixes} from '../../client/src/worker/client-portal/authenticated-delivery-grants';
import {authorizeEffectiveWorkspaceProject,listPortalWorkspaceHierarchy} from '../../client/src/worker/client-portal/workspace-v2';
import type {Env,StaffPrincipal} from '../src/worker/types';
vi.mock('cloudflare:workers',()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));

const staff:StaffPrincipal={id:'primary-reviewer',email:'reviewer@example.test',displayName:'Reviewer',accessSubject:'primary-reviewer-subject',projectAlphaUserId:null};
const source='project-alpha:primary',issuer='https://clients.example.test',pub=(n:number)=>n.toString(16).padStart(32,'0');
let runtime:Miniflare,ops:D1Database,delivery:D1Database,env:Env,sequence=0;
async function fixture(group=false){
  const n=++sequence,workspace=`primary-terms-${n}`,generation=`primary-generation-${n}`,project=`primary-project-${n}`,
    identity=`primary-person-${n}`,binding=`primary-binding-${n}`,projectPublic=pub(n+100),rootPublic=pub(n+1000),prefix=`primary/${n}/`,account=`primary-account-${n}`;
  await ops.batch([
    ops.prepare(`INSERT INTO pa_projects(id,name,active,payload_json,last_sync_id) VALUES(?,?,1,?,'fixture')`).bind(project,`Ops label ${n}`,JSON.stringify({public_id:projectPublic})),
    ops.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'primary-division',?,'manual',?)`).bind(project,prefix,staff.id),
  ]);
  await delivery.batch([
    delivery.prepare(`INSERT INTO client_accounts(id,display_name,status) VALUES(?,?,'active')`).bind(account,`Local wrapper ${n}`),
    delivery.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_project_id,project_alpha_source_id) VALUES(?,'Client',?,?,?,?)`)
      .bind(project,`Delivery project ${n}`,prefix,projectPublic,source),
    delivery.prepare(`INSERT INTO client_project_grants(account_id,project_id) VALUES(?,?)`).bind(account,project),
    delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,legacy_account_id,project_alpha_source_id)
      VALUES(?,'organization',?,?,'active',?,?)`).bind(workspace,rootPublic,`Workspace ${n}`,account,source),
    delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)`)
      .bind(generation,workspace,generation),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'organization',?,NULL,?,'root-v1')`).bind(workspace,generation,rootPublic,`Root ${n}`),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project',?,?,?,'project-v1')`).bind(workspace,generation,projectPublic,rootPublic,`Delivery label ${n}`),
    delivery.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(workspace,generation),
    delivery.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_version,source_type)
      VALUES(?,?,?,?,?,?,'project_alpha')`).bind(binding,workspace,group?'organization':'project',group?rootPublic:projectPublic,prefix,group?'root-v1':'project-v1'),
    delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`).bind(identity,issuer,identity,`${identity}@example.test`),
    delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
      VALUES(?,?,?,'project_alpha','active','person-v1')`).bind(`member-${n}`,workspace,identity),
    delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
      VALUES(?,'exact-person',?,?,'Exact recipient','person-v1','active')`).bind(workspace,identity,`${identity}@example.test`),
    ...['workspace.view','directory.read','delivery.view'].map(capability=>delivery.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version) VALUES(?,?,?,?,'allow','workspace',?,'project_alpha','allow-v1')`)
      .bind(`${capability}-${n}`,workspace,identity,capability,workspace)),
  ]);
  const operation:AuthenticatedDeliveryGrantInput={folderBindingId:binding,audienceType:'principal',audiencePublicId:'exact-person',reasonCode:'reviewed_delivery',expiresAt:null,
    ...(group?{}:{accessTerms:{kind:'customer',mode:'until_revoked',expiresAt:null} as const})};
  return {n,workspace,generation,project,identity,binding,projectPublic,rootPublic,prefix,account,operation,
    person:{issuer,subject:identity,email:`${identity}@example.test`}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function reviewed(f:Fixture,target=env,operation=f.operation){return {...operation,expectedContextVersion:(await previewAuthenticatedDeliveryGrant(target,staff,operation)).contextVersion};}
async function create(f:Fixture,target=env){return createAuthenticatedDeliveryGrant(target,staff,await reviewed(f,target),`primary-create-key-${f.n}`);}
async function lifecycle(f:Fixture,completed:string|null=null){
  await delivery.batch([
    delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(f.generation,f.workspace),
    delivery.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES(?,?,'project-parent','contains','organization',?,'project',?,'relation-v1')`).bind(f.workspace,f.generation,f.rootPublic,f.projectPublic),
    delivery.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(source,`signed-${f.n}`,f.workspace,'b'.repeat(64)),
    delivery.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
      VALUES(?,?,?,?,?,'lifecycle-v1')`).bind(f.workspace,f.generation,f.projectPublic,completed?'completed':'active',completed),
  ]);
  return {...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'};
}
function intercept(action:()=>Promise<void>,after=false):D1Database{
  const sqls=new WeakMap<object,string>();let done=false,proxy:D1Database;
  function wrap(raw:D1PreparedStatement,sql:string):D1PreparedStatement{const p=new Proxy(raw,{get(target,key){
    if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values),sql);
    const value=target[key as keyof D1PreparedStatement];return typeof value==='function'?value.bind(target):value;}});sqls.set(p,sql);return p;}
  proxy=new Proxy(delivery,{get(target,key){if(key==='withSession')return()=>proxy;if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{const selected=!done&&statements.some(s=>(sqls.get(s)??'').includes('INSERT INTO portal_project_access_write_fences'));
      if(selected){done=true;if(!after)await action();}const result=await target.batch(statements);if(selected&&after)await action();return result;};
    const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;}});return proxy;
}
async function deny(permission='delivery.share.create'){await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
  VALUES(?,?,?,'deny','division','primary-division','primary-division',?)`).bind(crypto.randomUUID(),staff.id,permission,staff.id).run();}
describe('primary staff project access terms and real customer history',{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('primary-terms')}}",d1Databases:['OPS_DB','DELIVERY_DB']});
    ops=await runtime.getD1Database('OPS_DB') as D1Database;delivery=await runtime.getD1Database('DELIVERY_DB') as D1Database;
    for(const [db,path,cap] of [[ops,new URL('../migrations/',import.meta.url),'0040'],[delivery,new URL('../../client/migrations/',import.meta.url),'0164']] as const)
      for(const name of readdirSync(path).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)<=cap).sort())
        await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
    env={OPS_DB:ops,DELIVERY_DB:delivery,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true'} as Env;
    await ops.batch([
      ops.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`).bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
      ops.prepare(`INSERT INTO divisions(id,name,code,active) VALUES('primary-division','Primary division','PRIMARY',1)`),
      ops.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('primary-admin',?,'role-admin','global','global')`).bind(staff.id),
    ]);
  },180_000);
  beforeEach(async()=>{await ops.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND effect='deny'`).bind(staff.id).run();});
  afterAll(async()=>runtime.dispose());
  it('uses the same directory label in list/review and creates one immutable reviewed term',async()=>{
    const f=await fixture(),list=await listAuthenticatedDeliveryGrants(env,staff,f.prefix),preview=await previewAuthenticatedDeliveryGrant(env,staff,f.operation);
    expect(list).toMatchObject({projectName:`Delivery label ${f.n}`,accessTermsSupported:true,projectEndSupported:false});
    expect(preview.projectName).toBe(list.projectName);expect(preview.operation).toEqual(f.operation);
    const input={...f.operation,expectedContextVersion:preview.contextVersion},first=await createAuthenticatedDeliveryGrant(env,staff,input,`primary-create-key-${f.n}`);
    expect(first.grant.accessTerms).toEqual(f.operation.accessTerms);expect(first.grant.status).toBe('active');
    expect(await createAuthenticatedDeliveryGrant(env,staff,input,`primary-create-key-${f.n}`)).toEqual({...first,replayed:true});
    expect(await delivery.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(1);
  });
  it('requires explicit project review, rejects invalid classifications and date mismatches',async()=>{
    const f=await fixture();await expect(createAuthenticatedDeliveryGrant(env,staff,f.operation,`missing-review-${f.n}`)).rejects.toMatchObject({status:409});
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...f.operation,accessTerms:{kind:'customer',mode:'project_end',expiresAt:null}})).rejects.toMatchObject({status:400});
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...f.operation,expiresAt:'not-a-date'})).rejects.toMatchObject({status:400});
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...f.operation,accessTerms:{kind:'collaborator',mode:'project_end',expiresAt:null}})).rejects.toMatchObject({status:409});
  });
  it('preserves reviewed nonproject sharing as unclassified and old direct API compatibility',async()=>{
    const f=await fixture(true),preview=await previewAuthenticatedDeliveryGrant(env,staff,f.operation);
    expect(preview).toMatchObject({projectName:null,accessTermsSupported:false,accessTerms:null});
    const made=await create(f);expect(made.grant.accessTerms).toBeNull();
    const old=await createAuthenticatedDeliveryGrant(env,staff,f.operation,`legacy-unreviewed-${f.n}`);expect(old.grant.accessTerms).toBeNull();
  });
  it('uses the shared explicit-date policy without a primary-only one-year ceiling',async()=>{
    const f=await fixture(),expiresAt=new Date(Date.now()+730*86400_000).toISOString();
    const preview=await previewAuthenticatedDeliveryGrant(env,staff,{...f.operation,expiresAt,accessTerms:{kind:'collaborator',mode:'specific_date',expiresAt}});
    expect(preview.effectiveAccessExpiresAt).toBe(expiresAt);
    await expect(previewAuthenticatedDeliveryGrant(env,staff,{...f.operation,accessTerms:undefined,expiresAt})).rejects.toMatchObject({status:400});
  });
  it('rejects equal public coordinates belonging to a different primary folder owner',async()=>{
    const f=await fixture();await ops.prepare(`UPDATE pa_projects SET payload_json=? WHERE id=?`).bind(JSON.stringify({public_id:pub(99999)}),f.project).run();
    await expect(previewAuthenticatedDeliveryGrant(env,staff,f.operation)).rejects.toMatchObject({status:404});
  });
  it.each(['binding','recipient','deny','membership'] as const)('rolls back term/grant/receipt when %s changes at the Delivery write',async kind=>{
    const f=await fixture(),input=await reviewed(f);let injected=false;
    const db=intercept(async()=>{injected=true;
      if(kind==='binding')await delivery.prepare(`UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?`).bind(f.binding).run();
      if(kind==='recipient')await delivery.prepare(`UPDATE pa_portal_principals SET source_version='person-v2' WHERE workspace_id=?`).bind(f.workspace).run();
      if(kind==='membership')await delivery.prepare(`UPDATE portal_v2_workspace_memberships SET source_version='changed' WHERE workspace_id=?`).bind(f.workspace).run();
      if(kind==='deny')await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type)
        VALUES(?,?,?,'delivery.view','deny','project',?,'operations')`).bind(`deny-${f.n}`,f.workspace,f.identity,f.projectPublic).run();
    });
    await expect(createAuthenticatedDeliveryGrant({...env,DELIVERY_DB:db},staff,input,`primary-race-key-${f.n}`)).rejects.toBeDefined();expect(injected).toBe(true);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_v2_authenticated_delivery_grants WHERE workspace_id=?').bind(f.workspace).first('n')).toBe(0);
  });
  it('closes only the newly written grant if OPS authority changes after Delivery commits',async()=>{
    const f=await fixture(),input=await reviewed(f);let injected=false;
    const db=intercept(async()=>{injected=true;await deny();},true);
    await expect(createAuthenticatedDeliveryGrant({...env,DELIVERY_DB:db},staff,input,`primary-after-key-${f.n}`)).rejects.toBeDefined();expect(injected).toBe(true);
    expect(await delivery.prepare('SELECT status FROM portal_v2_authenticated_delivery_grants WHERE workspace_id=?').bind(f.workspace).first('status')).toBe('revoked');
    expect(await authorizeAuthenticatedDeliveryGrant(env,f.person,f.workspace,f.binding)).toBe(false);
  });
  it('restores explicit history with new reviewed immutable terms, never silently dropping classification',async()=>{
    const f=await fixture(),first=await create(f);
    await revokeAuthenticatedDeliveryGrant(env,staff,first.grant.grantId,1,'reviewed_revoke',`primary-revoke-key-${f.n}`);
    await expect(restoreAuthenticatedDeliveryGrant(env,staff,first.grant.grantId,1,'restored',null,`primary-restore-key-${f.n}`)).rejects.toMatchObject({status:409});
    const operation={...f.operation,reasonCode:'restored'},preview=await previewAuthenticatedDeliveryGrant(env,staff,operation),options={accessTerms:operation.accessTerms,expectedContextVersion:preview.contextVersion};
    const restored=await restoreAuthenticatedDeliveryGrant(env,staff,first.grant.grantId,1,'restored',null,`primary-restore-key-${f.n}`,options);
    expect(restored.grant).toMatchObject({version:2,status:'active',accessTerms:operation.accessTerms});
    expect(await restoreAuthenticatedDeliveryGrant(env,staff,first.grant.grantId,1,'restored',null,`primary-restore-key-${f.n}`,options)).toEqual({...restored,replayed:true});
  });
  it.each(['customer','collaborator_until_revoked','collaborator_specific_date'] as const)('retains independently authorized %s project history and file access, but not after revoke or deny',async role=>{
    const f=await fixture();
    if(role!=='customer'){const expiresAt=role==='collaborator_specific_date'?new Date(Date.now()+100*86400_000).toISOString():null;
      f.operation={...f.operation,expiresAt,accessTerms:{kind:'collaborator',mode:expiresAt?'specific_date':'until_revoked',expiresAt}};}
    const created=await create(f),target=await lifecycle(f,new Date(Date.now()-40*86400_000).toISOString());
    const context={workspaceId:f.workspace,identityId:f.identity,rootType:'organization' as const,rootPublicId:f.rootPublic,legacyAccountId:f.account,
      legacyIdentityId:'not-used',displayName:'Workspace',role:'member' as const,canViewBilling:false};
    expect((await listPortalWorkspaceHierarchy(target,f.person,f.workspace,null))?.some(row=>row.publicId===f.projectPublic)).toBe(true);
    expect(await authorizeEffectiveWorkspaceProject(target,f.person,context,'delivery.view',f.project)).toBe(true);
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(true);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(target,f.person,f.workspace)).toContain(f.prefix);
    await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type)
      VALUES(?,?,?,'directory.read','deny','project',?,'operations')`).bind(`directory-deny-${f.n}`,f.workspace,f.identity,f.projectPublic).run();
    expect((await listPortalWorkspaceHierarchy(target,f.person,f.workspace,null))?.some(row=>row.publicId===f.projectPublic)).toBe(false);
    await revokeAuthenticatedDeliveryGrant(target,staff,created.grant.grantId,1,'revoke_history',`history-revoke-${f.n}`);
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(false);
    expect(await authorizeEffectiveWorkspaceProject(target,f.person,context,'delivery.view',f.project)).toBe(false);
  });
  it('pins project-end expiry to the first signed completion and lists its terminal state',async()=>{
    const f=await fixture(),target=await lifecycle(f),operation={...f.operation,accessTerms:{kind:'collaborator',mode:'project_end',expiresAt:null} as const};
    const created=await createAuthenticatedDeliveryGrant(target,staff,await reviewed(f,target,operation),`completion-key-${f.n}`);
    const completed=new Date(Date.now()-8*86400_000).toISOString();
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=?,source_version='completed-v2' WHERE workspace_id=?`)
      .bind(completed,f.workspace).run();
    const listed=await listAuthenticatedDeliveryGrants(target,staff,f.prefix);
    expect(listed.grants.find(g=>g.id===created.grant.id)).toMatchObject({status:'expired',effectiveAccessExpiresAt:new Date(Date.parse(completed)+7*86400_000).toISOString()});
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(false);
  });
  it('does not retain an unclassified completed project in prefix listing or direct authorization',async()=>{
    const f=await fixture();await createAuthenticatedDeliveryGrant(env,staff,{...f.operation,accessTerms:undefined},`unclassified-key-${f.n}`);
    const target=await lifecycle(f,new Date(Date.now()-40*86400_000).toISOString());
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(target,f.person,f.workspace)).not.toContain(f.prefix);
    expect((await listPortalWorkspaceHierarchy(target,f.person,f.workspace,null))?.some(row=>row.publicId===f.projectPublic)).toBe(false);
  });
  it('does not let expired term history consume the active-grant capacity of independent customer access',async()=>{
    const f=await fixture(),target=await lifecycle(f);await create(f,target);
    const historical=JSON.stringify(Array.from({length:101},(_,n)=>`elapsed-${f.n}-${n}`));
    await delivery.batch([
      delivery.prepare(`INSERT INTO portal_project_access_terms(id,workspace_id,source_id,project_public_id,kind,mode,created_by_actor_type,created_by_actor_id)
        SELECT value,?,?,?,'collaborator','project_end','staff',? FROM json_each(?)`).bind(f.workspace,source,f.projectPublic,staff.id,historical),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id,access_terms_id)
        SELECT value,value,1,?,?,'project-v1','principal','exact-person','person-v1','fixture_history',?,value FROM json_each(?)`).bind(f.workspace,f.binding,staff.id,historical),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        SELECT value,?,'exact-person',?,'person-v1' FROM json_each(?)`).bind(f.workspace,f.identity,historical),
    ]);
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=?,source_version='completion-v2' WHERE workspace_id=?`)
      .bind(new Date(Date.now()-40*86400_000).toISOString(),f.workspace).run();
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(true);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(target,f.person,f.workspace)).toContain(f.prefix);
    expect((await listPortalWorkspaceHierarchy(target,f.person,f.workspace,null))?.some(row=>row.publicId===f.projectPublic)).toBe(true);
  });
  it('reviews new access with expired invitation history without discarding a current deny',async()=>{
    const f=await fixture(),target=await lifecycle(f),term=`expired-proof-${f.n}`;
    await delivery.batch([
      delivery.prepare(`INSERT INTO portal_project_access_terms(id,workspace_id,source_id,project_public_id,kind,mode,created_by_actor_type,created_by_actor_id)
        VALUES(?,?,?,?,'collaborator','project_end','staff',?)`).bind(term,f.workspace,source,f.projectPublic,staff.id),
      delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,entitlement_version,access_terms_id)
        SELECT ?||'-'||value,?,?,'delivery.view','allow','project',?,'client_invitation',value+1,? FROM json_each(?)`)
        .bind(term,f.workspace,f.identity,f.projectPublic,term,JSON.stringify(Array.from({length:202},(_,i)=>i))),
    ]);
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=?,source_version='proof-completion' WHERE workspace_id=?`)
      .bind(new Date(Date.now()-40*86400_000).toISOString(),f.workspace).run();
    const made=await create(f,target);
    expect(made.grant.accessTerms).toEqual(f.operation.accessTerms);
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(true);
    await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type)
      VALUES(?,?,?,'delivery.view','deny','project',?,'operations')`).bind(`deny-${term}`,f.workspace,f.identity,f.projectPublic).run();
    await expect(previewAuthenticatedDeliveryGrant(target,staff,f.operation)).rejects.toMatchObject({status:404});
    expect(await authorizeAuthenticatedDeliveryGrant(target,f.person,f.workspace,f.binding)).toBe(false);
  });
  it('keeps an owner rename/version change fenced even for persistent customer history',async()=>{
    const f=await fixture();await create(f);
    await delivery.prepare(`UPDATE portal_v2_directory_entities SET display_name='Renamed',source_version='project-v2' WHERE workspace_id=? AND entity_type='project'`)
      .bind(f.workspace).run();
    expect(await authorizeAuthenticatedDeliveryGrant(env,f.person,f.workspace,f.binding)).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env,f.person,f.workspace)).not.toContain(f.prefix);
  });
  it('reauthorizes a revoke receipt rather than replaying after staff authority is removed',async()=>{
    const f=await fixture(),created=await create(f),key=`primary-revoke-replay-${f.n}`;
    await revokeAuthenticatedDeliveryGrant(env,staff,created.grant.grantId,1,'revoke',key);await deny('delivery.share.revoke');
    await expect(revokeAuthenticatedDeliveryGrant(env,staff,created.grant.grantId,1,'revoke',key)).rejects.toMatchObject({status:404});
  });
});
