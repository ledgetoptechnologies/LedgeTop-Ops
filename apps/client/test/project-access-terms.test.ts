import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {prepareProjectAccessTerms,readProjectAccessTerms,projectAccessTermsSql,projectAccessTermsReady,parseProjectAccessTerms} from '../src/worker/client-portal/project-access-terms';
import {createWorkspaceInvitation} from '../src/worker/client-portal/workspace-memberships';
import {acceptPortalWorkspaceInvitation,authorizePortalWorkspaceCapability} from '../src/worker/client-portal/workspace-v2';
import type {Env} from '../src/worker/types';

const source='project-alpha:primary',issuer='https://access.example.test';
let mf:Miniflare,db:D1Database,env:Env,n=0;
async function fixture(signed=true){
  const id=`terms-${++n}`,project=`project-${n}`,generation=`gen-${n}`,identity=`manager-${n}`;
  const principal={issuer,subject:identity,email:`${identity}@example.test`};
  await db.batch([
    db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status) VALUES(?,'organization',?,?,'active')`).bind(id,`root-${n}`,id),
    db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)`).bind(generation,id,generation),
    db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(generation,id),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,?,'root-v1')`).bind(id,generation,`root-${n}`,id),
    db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'project-v1')`).bind(id,generation,project,`root-${n}`,project),
    db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES(?,?,'root-project','contains','organization',?,'project',?,'r1')`).bind(id,generation,`root-${n}`,project),
    db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES(?,?,?,'active','l1')`).bind(id,generation,project),
    ...(signed?[db.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(source,`signed-${n}`,id,'a'.repeat(64))]:[]),
    db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(id,generation),
    db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)`).bind(identity,issuer,identity,principal.email),
    db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES(?,?,?,'operations')`).bind(`membership-${n}`,id,identity),
    ...['workspace.view','member.manage','delivery.view'].map(capability=>db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type) VALUES(?,?,?,?,'workspace',?,'operations')`)
      .bind(`${capability}-${n}`,id,identity,capability,id)),
  ]);
  return {id,project,generation,identity,principal,scope:{sourceId:source,workspaceId:id,projectPublicId:project}};
}
const collaborator={kind:'collaborator',mode:'project_end',expiresAt:null} as const;
async function issue(f:Awaited<ReturnType<typeof fixture>>,value:unknown=collaborator){
  const terms=await prepareProjectAccessTerms(db,f.scope,value,{type:'staff',id:'operator'});await terms.statement.run();return terms;
}
async function permitted(id:string|null,f:Awaited<ReturnType<typeof fixture>>,legacy='0',now="'now'"){
  return db.prepare(`SELECT ${projectAccessTermsSql({termsId:'?',workspaceId:'?',projectId:'?',legacyRetained:legacy,now})} allowed`)
    .bind(id,id,f.id,f.project).first<number>('allowed');
}
async function invite(f:Awaited<ReturnType<typeof fixture>>,email:string,key:string,project=f.project,accessTerms:unknown=collaborator){
  const result=await createWorkspaceInvitation(env,f.principal,f.id,{email,projectPublicId:project,capabilities:['delivery.view'],
    accessTerms:parseProjectAccessTerms(accessTerms)},key);
  expect(result.outcome).toBe('created');if(!('invitation' in result))throw new Error('Invitation missing');
  const payload=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(result.invitation.id).first<string>('payload_json');
  return {invitation:result.invitation,token:(JSON.parse(payload!) as {token:string}).token};
}
function beforeBatch(database:D1Database,action:()=>Promise<void>):D1Database{
  let proxy:D1Database,called=false;const sql=new WeakMap<object,string>();
  const wrap=(statement:D1PreparedStatement,text:string):D1PreparedStatement=>{
    const wrapped=new Proxy(statement,{get(target,key){if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values),text);
      const value=target[key as keyof D1PreparedStatement];return typeof value==='function'?value.bind(target):value;}});sql.set(wrapped,text);return wrapped;
  };
  proxy=new Proxy(database,{get(target,key){if(key==='withSession')return()=>proxy;
    if(key==='prepare')return(text:string)=>wrap(target.prepare(text),text);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!called&&statements.some(statement=>(sql.get(statement)??'').includes('portal_project_invitation_fences'))){called=true;await action();}return target.batch(statements);};
    const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;}});return proxy;
}
describe('explicit project access terms: populated migration and invitation lifetime',{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    mf=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('terms')}}",d1Databases:['DB','EMPTY']});
    db=await mf.getD1Database('DB') as D1Database;
    const path=new URL('../migrations/',import.meta.url);
    for(const name of readdirSync(path).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name.slice(0,4)<='0163').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
    const old=await fixture();
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES('old-binding',?,'project',?,'preserve/','operations','project-v1')`).bind(old.id,old.project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES('old-grant','old-grant',1,?,'old-binding','project-v1','principal','old-principal','v1','legacy','operator')`).bind(old.id),
    ]);
    const before=await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grants WHERE id='old-grant'").first();
    expect(await projectAccessTermsReady(db)).toBe(false);
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('0164_project_access_terms.sql',path),'utf8')).map(sql=>db.prepare(sql)));
    const after=await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grants WHERE id='old-grant'").first<Record<string,unknown>>();
    expect(after?.access_terms_id).toBeNull();delete after!.access_terms_id;expect(after).toEqual(before);
    const partial:Partial<Env>={DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED:'true'};
    env=partial as Env;
  },180_000);
  afterAll(async()=>mf.dispose());
  it('preserves NULL legacy policy, requires explicit classification and exact source/project',async()=>{
    const f=await fixture(),other=await fixture(),t=await issue(f,{kind:'customer',mode:'until_revoked',expiresAt:null});
    expect(await permitted(null,f,'1')).toBe(1);expect(await permitted(null,f,'0')).toBe(0);
    expect(await permitted(t.id,f)).toBe(1);expect(await permitted(t.id,other)).toBe(0);
    await expect(prepareProjectAccessTerms(db,{...f.scope,sourceId:'project-alpha:other'},collaborator,{type:'staff',id:'op'})).rejects.toMatchObject({status:404});
    await expect(prepareProjectAccessTerms(db,f.scope,{kind:'customer',mode:'until_revoked',expiresAt:null},{type:'identity',id:f.identity})).rejects.toMatchObject({status:403});
  });
  it('latches completion plus seven days once and never extends on reopen or changed date',async()=>{
    const f=await fixture(),t=await issue(f),completed='2026-01-01T00:00:00.000Z';
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=?,source_version='l2' WHERE workspace_id=?`).bind(completed,f.id).run();
    expect((await readProjectAccessTerms(db,t.id))?.effectiveExpiresAt).toBe('2026-01-08T00:00:00.000Z');
    expect(await permitted(t.id,f,'0',"'2026-01-07T23:59:59Z'")).toBe(1);
    expect(await permitted(t.id,f,'0',"'2026-01-08T00:00:00Z'")).toBe(0);
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='l3' WHERE workspace_id=?`).bind(f.id).run();
    expect((await readProjectAccessTerms(db,t.id))?.effectiveExpiresAt).toBe('2026-01-08T00:00:00.000Z');
    expect(await permitted(t.id,f,'0',"'2026-01-09T00:00:00Z'")).toBe(0);
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2026-06-01T00:00:00Z',source_version='l4' WHERE workspace_id=?`).bind(f.id).run();
    expect((await readProjectAccessTerms(db,t.id))?.effectiveExpiresAt).toBe('2026-01-08T00:00:00.000Z');
  });
  it('keeps ordinary customer history and manual collaborator terms after completion',async()=>{
    const f=await fixture(),customer=await issue(f,{kind:'customer',mode:'until_revoked',expiresAt:null}),manual=await issue(f,{kind:'collaborator',mode:'until_revoked',expiresAt:null});
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z' WHERE workspace_id=?`).bind(f.id).run();
    expect(await permitted(customer.id,f)).toBe(1);expect(await permitted(manual.id,f)).toBe(1);
    await expect(issue(f)).rejects.toMatchObject({status:409});
  });
  it('requires signed current lifecycle for project end, not staging or unsigned state',async()=>{
    const f=await fixture(false);await expect(issue(f)).rejects.toMatchObject({status:409});
    const manual=await issue(f,{kind:'collaborator',mode:'until_revoked',expiresAt:null});expect(await permitted(manual.id,f)).toBe(1);
    const signed=await fixture(),t=await issue(signed);
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES('staging-terms',?,'staging-terms',2,'staging',0)`).bind(signed.id),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
        VALUES(?,'staging-terms','project',?,'Staged project','staged')`).bind(signed.id,signed.project),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
        VALUES(?,'staging-terms',?,'completed','2020-01-01T00:00:00Z','staged')`).bind(signed.id,signed.project),
    ]);
    expect((await readProjectAccessTerms(db,t.id))?.completionPending).toBe(true);
  });
  it('validates specific dates and never permits immutable term/deadline replacement',async()=>{
    const f=await fixture(),future=new Date(Date.now()+86400_000).toISOString(),t=await issue(f,{kind:'collaborator',mode:'specific_date',expiresAt:future});
    expect((await readProjectAccessTerms(db,t.id))?.effectiveExpiresAt).toBe(future);
    expect(()=>parseProjectAccessTerms({kind:'collaborator',mode:'specific_date',expiresAt:'2026-02-30T00:00:00Z'})).toThrow();
    await expect(db.prepare('UPDATE portal_project_access_terms SET mode=? WHERE id=?').bind('until_revoked',t.id).run()).rejects.toThrow();
    await expect(db.prepare('INSERT OR REPLACE INTO portal_project_access_terms SELECT * FROM portal_project_access_terms WHERE id=?').bind(t.id).run()).rejects.toThrow();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('copies invitation terms per entitlement without expiring shared membership',async()=>{
    const f=await fixture(),email=`guest-${n}@example.test`,result=await createWorkspaceInvitation(env,f.principal,f.id,
      {email,projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`terms-invitation-${n}`);
    expect(result.outcome).toBe('created');if(!('invitation' in result))throw new Error('Invitation missing');
    const outbox=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(result.invitation.id).first<string>('payload_json');
    const token=(JSON.parse(outbox!) as {token:string}).token;
    expect(await acceptPortalWorkspaceInvitation(env,{issuer,subject:`guest-${n}`,email},token)).toBe('accepted');
    const rows=(await db.prepare('SELECT e.access_terms_id,m.expires_at FROM portal_v2_entitlements e JOIN portal_v2_workspace_memberships m ON m.workspace_id=e.workspace_id AND m.identity_id=e.identity_id WHERE e.source_type=? AND e.workspace_id=?')
      .bind('client_invitation',f.id).all<{access_terms_id:string|null;expires_at:string|null}>()).results;
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.access_terms_id===result.invitation.accessTerms?.id&&row.expires_at===null)).toBe(true);
    expect(Date.parse(result.invitation.expiresAt)).toBeGreaterThan(Date.now()+6*86400_000);
  });
  it('accepts newly reviewed terms after an earlier same-project invitation expires without renewing old terms',async()=>{
    const f=await fixture(),guest={issuer,subject:`renewed-${n}`,email:`renewed-${n}@example.test`};
    const first=await invite(f,guest.email,`first-reviewed-invite-${n}`);
    expect(await acceptPortalWorkspaceInvitation(env,guest,first.token)).toBe('accepted');
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-8 days'),source_version='completed'
      WHERE workspace_id=?`).bind(f.id).run();
    expect(await authorizePortalWorkspaceCapability(env,guest,f.id,'delivery.view',{scopeType:'project',publicId:f.project})).toBe(false);
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='reopened'
      WHERE workspace_id=?`).bind(f.id).run();
    const second=await invite(f,guest.email,`second-reviewed-invite-${n}`);
    expect(await acceptPortalWorkspaceInvitation(env,guest,second.token)).toBe('accepted');
    expect(await authorizePortalWorkspaceCapability(env,guest,f.id,'delivery.view',{scopeType:'project',publicId:f.project})).toBe(true);
    expect((await readProjectAccessTerms(db,first.invitation.accessTerms!.id))?.expired).toBe(true);
    const rows=(await db.prepare(`SELECT capability,entitlement_version,access_terms_id FROM portal_v2_entitlements
      WHERE workspace_id=? AND source_type='client_invitation' ORDER BY capability,entitlement_version`).bind(f.id).all()).results;
    expect(rows).toHaveLength(4);
    for(const capability of ['delivery.view','workspace.view'])expect(rows.filter(row=>row.capability===capability)).toEqual([
      {capability,entitlement_version:1,access_terms_id:first.invitation.accessTerms!.id},
      {capability,entitlement_version:2,access_terms_id:second.invitation.accessTerms!.id},
    ]);
    expect(await acceptPortalWorkspaceInvitation(env,guest,second.token)).toBe('replayed');
    expect((await db.prepare(`SELECT capability,entitlement_version,access_terms_id FROM portal_v2_entitlements
      WHERE workspace_id=? AND source_type='client_invitation' ORDER BY capability,entitlement_version`).bind(f.id).all()).results).toEqual(rows);
  });
  it('gives a second project invitation its own live shell without changing the expired first project',async()=>{
    const f=await fixture(),other=`second-project-${n}`,guest={issuer,subject:`second-project-guest-${n}`,email:`second-project-${n}@example.test`};
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'project',?,?,?,'project-v1')`).bind(f.id,f.generation,other,`root-${n}`,other),
      db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES(?,?,'second-edge','contains','organization',?,'project',?,'r1')`).bind(f.id,f.generation,`root-${n}`,other),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active','l1')`).bind(f.id,f.generation,other),
    ]);
    const first=await invite(f,guest.email,`first-project-invite-${n}`);
    expect(await acceptPortalWorkspaceInvitation(env,guest,first.token)).toBe('accepted');
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-8 days'),source_version='ended'
      WHERE workspace_id=? AND project_public_id=?`).bind(f.id,f.project).run();
    const second=await invite(f,guest.email,`second-project-invite-${n}`,other);
    expect(await acceptPortalWorkspaceInvitation(env,guest,second.token)).toBe('accepted');
    expect(await authorizePortalWorkspaceCapability(env,guest,f.id,'workspace.view',{scopeType:'workspace',publicId:f.id})).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env,guest,f.id,'delivery.view',{scopeType:'project',publicId:other})).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env,guest,f.id,'delivery.view',{scopeType:'project',publicId:f.project})).toBe(false);
    expect((await db.prepare(`SELECT access_terms_id FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='client_invitation'
      AND capability='workspace.view' ORDER BY entitlement_version`).bind(f.id).all()).results).toEqual([
        {access_terms_id:first.invitation.accessTerms!.id},{access_terms_id:second.invitation.accessTerms!.id},
      ]);
    expect(await acceptPortalWorkspaceInvitation(env,guest,second.token)).toBe('replayed');
  });
  it.each(['disabled','require_approval'] as const)('enforces organization %s policy before issue and acceptance',async policy=>{
    const f=await fixture(),email=`blocked-${n}@example.test`,created=await createWorkspaceInvitation(env,f.principal,f.id,
      {email,projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`before-policy-${n}`);
    if(!('invitation' in created))throw new Error('Invitation missing');
    const json=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(created.invitation.id).first<string>('payload_json');
    await db.prepare('INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id) VALUES(?,?,1,?)').bind(f.id,policy,'operator').run();
    expect((await createWorkspaceInvitation(env,f.principal,f.id,{email:'new@example.test',projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`after-policy-invite-${n}`)).outcome)
      .toBe(policy==='disabled'?'policy_disabled':'approval_required');
    expect(await acceptPortalWorkspaceInvitation(env,{issuer,subject:`blocked-${n}`,email},(JSON.parse(json!) as {token:string}).token)).toBe('denied');
    expect(await db.prepare('SELECT status FROM portal_v2_invitations WHERE id=?').bind(created.invitation.id).first('status')).toBe('pending');
  });
  it('does not delegate a missing capability or outlive a finite manager path',async()=>{
    const f=await fixture(),request={email:'ceiling@example.test',projectPublicId:f.project,capabilities:['request.create' as const],accessTerms:collaborator};
    await expect(createWorkspaceInvitation(env,f.principal,f.id,request,`capability-ceiling-${n}`)).rejects.toMatchObject({status:403});
    await db.prepare(`UPDATE portal_v2_entitlements SET expires_at=? WHERE workspace_id=? AND capability='member.manage'`)
      .bind(new Date(Date.now()+86400_000).toISOString(),f.id).run();
    await expect(createWorkspaceInvitation(env,f.principal,f.id,{...request,capabilities:['delivery.view']},`lifetime-ceiling-${n}`)).rejects.toMatchObject({status:403});
    const short={kind:'collaborator' as const,mode:'specific_date' as const,expiresAt:new Date(Date.now()+3600_000).toISOString()};
    expect((await createWorkspaceInvitation(env,f.principal,f.id,{...request,capabilities:['delivery.view'],accessTerms:short},`shorter-ceiling-${n}`)).outcome).toBe('created');
  });
  it('rolls back new terms and invitation if issuer permission changes inside the write batch',async()=>{
    const f=await fixture(),racing={...env,DELIVERY_DB:beforeBatch(db,async()=>{
      await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND capability='delivery.view'`).bind(f.id).run();})};
    const result=await createWorkspaceInvitation(racing,f.principal,f.id,{email:'race@example.test',projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`permission-race-${n}`);
    expect(result.outcome).toBe('invalid');
    expect(await db.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.id).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_invitations WHERE workspace_id=?').bind(f.id).first('n')).toBe(0);
  });
  it('does not let revoked and expired history consume the current delegation proof capacity',async()=>{
    const f=await fixture(),history=JSON.stringify(Array.from({length:802},(_,index)=>index));
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,
        entitlement_version,source_type,status,valid_from,expires_at,revoked_at)
        SELECT 'old-entitlement-'||?1||'-'||value,?1,?2,'delivery.view','workspace',?1,value+2,'operations',
          CASE WHEN value%2=0 THEN 'revoked' ELSE 'active' END,'2020-01-01T00:00:00Z',
          CASE WHEN value%2=1 THEN '2020-01-02T00:00:00Z' ELSE NULL END,
          CASE WHEN value%2=0 THEN '2020-01-02T00:00:00Z' ELSE NULL END FROM json_each(?3)`)
        .bind(f.id,f.identity,history),
      db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,status,
        valid_from,expires_at,created_by_actor_type,created_by_actor_id,revoked_at,revoked_by_actor_type,revoked_by_actor_id)
        SELECT 'old-denial-'||?1||'-'||value,?2,?1,'workspace',?1,'historical',
          CASE WHEN value%2=0 THEN 'revoked' ELSE 'active' END,'2020-01-01T00:00:00Z',
          CASE WHEN value%2=1 THEN '2020-01-02T00:00:00Z' ELSE NULL END,'staff','operator',
          CASE WHEN value%2=0 THEN '2020-01-02T00:00:00Z' ELSE NULL END,
          CASE WHEN value%2=0 THEN 'staff' ELSE NULL END,CASE WHEN value%2=0 THEN 'operator' ELSE NULL END
          FROM json_each(?3) WHERE value<202`).bind(f.id,f.identity,history),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,reason_code,status,valid_from,expires_at,
        created_by_actor_type,created_by_actor_id,revoked_at)
        SELECT 'old-block-'||?1||'-'||value,'issuer_subject',?2,?1,'historical',
          CASE WHEN value%2=0 THEN 'revoked' ELSE 'active' END,'2020-01-01T00:00:00Z',
          CASE WHEN value%2=1 THEN '2020-01-02T00:00:00Z' ELSE NULL END,'staff','operator',
          CASE WHEN value%2=0 THEN '2020-01-02T00:00:00Z' ELSE NULL END FROM json_each(?3) WHERE value<202`)
        .bind(f.identity,issuer,history),
    ]);
    const result=await createWorkspaceInvitation({...env,CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true'},f.principal,f.id,
      {email:'history-invite@example.test',projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`history-invitation-${n}`);
    expect(result.outcome).toBe('created');
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=?').bind(f.id).first('n')).toBe(805);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identity_denials WHERE identity_id=?').bind(f.identity).first('n')).toBe(202);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identity_eligibility_blocks WHERE subject=?').bind(f.identity).first('n')).toBe(202);
  });
  it('does not let expired explicit collaborator terms consume the delegation proof capacity',async()=>{
    const f=await fixture(),old=await issue(f);
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,
      entitlement_version,source_type,status,access_terms_id)
      SELECT ?1||'-expired-terms-'||value,?1,?2,'delivery.view','project',?3,value+1000,'operations','active',?4 FROM json_each(?5)`)
      .bind(f.id,f.identity,f.project,old.id,JSON.stringify(Array.from({length:802},(_,index)=>index))).run();
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-8 days'),source_version='ended'
      WHERE workspace_id=?`).bind(f.id).run();
    const result=await createWorkspaceInvitation(env,f.principal,f.id,{email:'expired-terms-history@example.test',projectPublicId:f.project,
      capabilities:['delivery.view'],accessTerms:{kind:'collaborator',mode:'specific_date',expiresAt:new Date(Date.now()+86400_000).toISOString()}},`explicit-history-invite-${n}`);
    expect(result.outcome).toBe('created');
    expect(await db.prepare(`SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND access_terms_id=?
      AND status='active' AND expires_at IS NULL`).bind(f.id,old.id).first('n')).toBe(802);
  });
  it('fences a pre-existing future denial becoming live between authorization and the write batch',async()=>{
    const f=await fixture(),start=Math.ceil((Date.now()+18_000)/1000)*1000;let reachedFence=false;
    await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,valid_from,
      created_by_actor_type,created_by_actor_id) VALUES(?,?,?,'workspace',?,'scheduled_deny',?,'staff','operator')`)
      .bind(`future-deny-${n}`,f.identity,f.id,f.id,new Date(start).toISOString()).run();
    const racing={...env,CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',DELIVERY_DB:beforeBatch(db,async()=>{
      reachedFence=true;const remaining=start-Date.now()+100;if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));})};
    const result=await createWorkspaceInvitation(racing,f.principal,f.id,{email:'future-deny@example.test',projectPublicId:f.project,
      capabilities:['delivery.view'],accessTerms:collaborator},`future-denial-invite-${n}`);
    expect(reachedFence).toBe(true);expect(result.outcome).toBe('invalid');
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_invitations WHERE workspace_id=?').bind(f.id).first('n')).toBe(0);
  });
  it('rejects acceptance after project completion expires without changing shared memberships',async()=>{
    const f=await fixture(),email=`expired-${n}@example.test`,created=await createWorkspaceInvitation(env,f.principal,f.id,
      {email,projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator},`expired-accept-${n}`);
    if(!('invitation' in created))throw new Error('Invitation missing');
    const payload=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(created.invitation.id).first<string>('payload_json');
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z' WHERE workspace_id=?`).bind(f.id).run();
    expect(await acceptPortalWorkspaceInvitation(env,{issuer,subject:`expired-${n}`,email},(JSON.parse(payload!) as {token:string}).token)).toBe('denied');
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?').bind(f.id).first('n')).toBe(1);
  });
  it('uses the source-sequence receipt index for the current lifecycle proof',async()=>{
    const f=await fixture(),plan=(await db.prepare('EXPLAIN QUERY PLAN SELECT * FROM portal_project_access_current_lifecycle WHERE workspace_id=? AND project_public_id=?').bind(f.id,f.project).all<{detail:string}>()).results;
    expect(plan.some(row=>row.detail.includes('idx_portal_project_lifecycle_receipt'))).toBe(true);
  });
  it('reports real missing metadata without inventing an available policy',async()=>{
    expect(await projectAccessTermsReady(await mf.getD1Database('EMPTY') as D1Database)).toBe(false);
    expect(await projectAccessTermsReady(db)).toBe(true);
  });
});
