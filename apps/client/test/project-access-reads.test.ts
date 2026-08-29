import { readFileSync,readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { splitD1MigrationStatements } from './helpers/d1-migrations';
import { authorizeNativePortalReadTarget,authorizePortalWorkspaceCapability,listPortalWorkspaceHierarchy,
  type NativePortalReadContext,type PortalAuthorizationEnv } from '../src/worker/client-portal/workspace-v2';
import { authorizeAuthenticatedDeliveryGrant,listAuthorizedAuthenticatedDeliveryPrefixes } from '../src/worker/client-portal/authenticated-delivery-grants';
import { prepareProjectAccessTerms,projectAccessTermsSql,type ProjectAccessTermsInput } from '../src/worker/client-portal/project-access-terms';
import { projectAccessAuthorityHistoryReady } from '../src/worker/client-portal/project-access-authority-history';
import { readNativeTargetScopes } from '../src/worker/client-portal/native-portal-scopes';

const principal={issuer:'https://terms.example.test',subject:'verified-person',email:'person@example.test'};
describe('per-grant project terms on current authorization reads',{timeout:60_000},()=>{
  let runtime:Miniflare,db:D1Database,env:PortalAuthorizationEnv&{AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true'},counter=0;
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:'2026-07-22',modules:true,script:"export default {fetch(){return new Response('terms')}}",d1Databases:{DELIVERY_DB:'project-access-reads'}});
    db=await runtime.getD1Database('DELIVERY_DB') as D1Database;
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<'0173_').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
    expect(await projectAccessAuthorityHistoryReady(db)).toBe(true);
    await db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES('terms-person',?,?,?,'active')`).bind(principal.issuer,principal.subject,principal.email).run();
    env={DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true'};
  },120_000);
  afterAll(async()=>runtime.dispose());
  async function fixture(){
    const id=`terms-${++counter}`,generation=`${id}-generation`,binding=`${id}-binding`,root=`${id}-root`;
    // Synthetic published storage fixture: producer/signature/latch tests live
    // separately. These tests exercise real migrated read authorization SQL.
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Terms','active','project-alpha:primary')`).bind(id,root),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES(?,?,'terms-person','operations','active')`).bind(`${id}-member`,id),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)`).bind(generation,id,generation),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(workspace_id,generation_id,schema_version) VALUES(?,?,3)`).bind(id,generation),
      ...[['organization',root,null],['project','same-project',root],['project','other-project',root]].map(([type,pid,parent])=>db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active) VALUES(?,?,?,?,?,?,'v1',1)`).bind(id,generation,type,pid,parent,pid)),
      ...['same-project','other-project'].map(pid=>db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES(?,?,?,'contains','organization',?,'project',?,'v1')`).bind(id,generation,`edge-${pid}`,root,pid)),
      ...['same-project','other-project'].map(pid=>db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active','v1')`).bind(id,generation,pid)),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(id,generation),
      db.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES('project-alpha:primary',?,?,'snapshot_activate',?,1,'completed')`).bind(`${id}-receipt`,id,'a'.repeat(64)),
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES(?,?,'project','same-project',?,'operations','v1')`).bind(binding,id,`${id}/`),
    ]);
    return {id,generation,binding,root};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function terms(f:Fixture,input:ProjectAccessTermsInput,project='same-project'){
    const prepared=await prepareProjectAccessTerms(db,{workspaceId:f.id,sourceId:'project-alpha:primary',projectPublicId:project},input,{type:'staff',id:'fixture-staff'});
    await prepared.statement.run();return prepared.id;
  }
  async function allow(f:Fixture,termsId:string|null,capability='delivery.view',effect='allow',project='same-project',source='operations'){
    const id=crypto.randomUUID();
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status,entitlement_version,access_terms_id)
      VALUES(?,?,'terms-person',?,?,'project',?,?,'active',?,?)`).bind(id,f.id,capability,effect,project,source,++counter,termsId).run();return id;
  }
  async function complete(f:Fixture,days:number,project='same-project'){
    await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now',?),source_version='completed-v1'
      WHERE workspace_id=? AND project_public_id=?`).bind(`-${days} days`,f.id,project).run();
  }
  const can=(f:Fixture,capability:'delivery.view'|'directory.read'='delivery.view',project='same-project')=>authorizePortalWorkspaceCapability(env,principal,f.id,capability,{scopeType:'project',publicId:project});
  it('keeps unclassified relation history at thirty days and structural ancestry separate',async()=>{
    const f=await fixture();await allow(f,null);await complete(f,40);
    expect(await can(f)).toBe(false);
    const context={workspaceId:f.id,generationId:f.generation,rootType:'organization' as const,rootPublicId:f.root},target=[{scopeType:'project' as const,publicId:'same-project'}];
    expect((await readNativeTargetScopes(env,context,target)).size).toBe(0);
    expect((await readNativeTargetScopes(env,context,target,{retention:'structural'})).get('project:same-project')?.proofRows.find(r=>r.entity_type==='project')?.retained).toBe(0);
    await db.prepare(`DELETE FROM portal_v2_project_lifecycle WHERE workspace_id=? AND project_public_id='same-project'`).bind(f.id).run();
    expect((await readNativeTargetScopes(env,context,target,{retention:'structural'})).size).toBe(0);
  });
  it.each(['project_alpha','legacy'])('preserves ordinary %s project history without extending mutation authority',async source=>{
    const f=await fixture();
    await allow(f,null,'delivery.view','allow','same-project',source);
    await allow(f,null,'directory.read','allow','same-project',source);
    await allow(f,null,'request.create','allow','same-project',source);
    await complete(f,40);
    expect(await can(f)).toBe(true);
    expect(await can(f,'directory.read')).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env,principal,f.id,'request.create',{scopeType:'project',publicId:'same-project'})).toBe(false);
    expect((await listPortalWorkspaceHierarchy(env,principal,f.id,null))?.map(row=>row.publicId)).toEqual(['same-project']);
  });
  it('preserves the same ordinary Project Alpha history for a native source adapter',async()=>{
    const f=await fixture();await complete(f,40);
    const base={workspaceId:f.id,sourceId:'project-alpha:secondary',identityId:'terms-person',displayName:'Terms',
      rootType:'organization',rootPublicId:f.root,generationId:f.generation,contextVersion:'fixture',authority:{},workspace:{},
      denials:[],projectAccessTermsAvailable:true};
    const rule=(capability:'delivery.view'|'directory.read',source_type='project_alpha')=>({capability,effect:'allow' as const,
      scope_type:'project' as const,scope_public_id:'same-project',source_type,access_terms_id:null,terms_project_id:null,
      terms_kind:null,terms_live:1});
    const target={scopeType:'project' as const,publicId:'same-project'};
    for(const capability of ['delivery.view','directory.read'] as const){
      const context={...base,grants:[rule(capability)]} as unknown as NativePortalReadContext;
      expect(await authorizeNativePortalReadTarget(env,context,capability,target)).toBe(true);
      const ambiguous={...base,grants:[rule(capability,'operations')]} as unknown as NativePortalReadContext;
      expect(await authorizeNativePortalReadTarget(env,ambiguous,capability,target)).toBe(false);
    }
  });
  it('does not infer permanent history from an unclassified client invitation',async()=>{
    const f=await fixture();await allow(f,null,'delivery.view','allow','same-project','client_invitation');await complete(f,40);
    expect(await can(f)).toBe(false);
  });
  it('retains only the explicit customer project in direct and batched hierarchy reads',async()=>{
    const f=await fixture(),id=await terms(f,{kind:'customer',mode:'until_revoked',expiresAt:null});
    await allow(f,id);await allow(f,id,'directory.read');await allow(f,null,'directory.read','allow','other-project');
    await complete(f,40);await complete(f,40,'other-project');
    expect(await can(f)).toBe(true);
    expect((await listPortalWorkspaceHierarchy(env,principal,f.id,null))?.map(x=>x.publicId)).toEqual(['same-project']);
    expect(await can(f,'directory.read','other-project')).toBe(false);
    await allow(f,null,'directory.read','deny');expect(await can(f,'directory.read')).toBe(false);
    expect(await listPortalWorkspaceHierarchy(env,principal,f.id,null)).toEqual([]);
  });
  it('expires project-end collaborators on read without a scheduler and retains an independent allow',async()=>{
    const f=await fixture(),id=await terms(f,{kind:'collaborator',mode:'project_end',expiresAt:null});
    await allow(f,id);expect(await can(f)).toBe(true);await complete(f,8);expect(await can(f)).toBe(false);
    await allow(f,null);expect(await can(f)).toBe(true);
    expect(await db.prepare(`SELECT status FROM portal_v2_workspace_memberships WHERE workspace_id=?`).bind(f.id).first('status')).toBe('active');
  });
  it('until-revoked collaborators do not inherit the unclassified thirty-day cutoff',async()=>{
    const f=await fixture(),id=await terms(f,{kind:'collaborator',mode:'until_revoked',expiresAt:null});
    const grant=await allow(f,id);await complete(f,40);expect(await can(f)).toBe(true);
    await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id=?`).bind(grant).run();
    expect(await can(f)).toBe(false);
  });
  it('excludes expired explicit allows before capacity without losing an independent customer or a current deny',async()=>{
    const f=await fixture(),expired=await terms(f,{kind:'collaborator',mode:'project_end',expiresAt:null});
    const customer=await terms(f,{kind:'customer',mode:'until_revoked',expiresAt:null});
    await allow(f,customer);await allow(f,customer,'directory.read');
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
      source_type,status,entitlement_version,access_terms_id)
      SELECT ?1||'-history-'||capability.value||'-'||history.value,?1,'terms-person',capability.value,'allow','project','same-project',
        'operations','active',1000+history.value,?2 FROM json_each(?3) history
        CROSS JOIN json_each('["delivery.view","directory.read"]') capability`)
      .bind(f.id,expired,JSON.stringify(Array.from({length:201},(_,index)=>index))).run();
    await complete(f,40);
    expect(await can(f)).toBe(true);
    expect((await listPortalWorkspaceHierarchy(env,principal,f.id,null))?.map(row=>row.publicId)).toEqual(['same-project']);
    expect(await db.prepare(`SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND access_terms_id=?
      AND status='active' AND expires_at IS NULL`).bind(f.id,expired).first('n')).toBe(402);
    await allow(f,null,'delivery.view','deny');await allow(f,null,'directory.read','deny');
    expect(await can(f)).toBe(false);
    expect(await listPortalWorkspaceHierarchy(env,principal,f.id,null)).toEqual([]);
  });
  it('continues counting every unclassified current rule toward the existing safety limit',async()=>{
    const f=await fixture(),customer=await terms(f,{kind:'customer',mode:'until_revoked',expiresAt:null});
    await allow(f,customer);await allow(f,customer,'directory.read');
    await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
      source_type,status,entitlement_version)
      SELECT ?1||'-current-'||capability.value||'-'||history.value,?1,'terms-person',capability.value,'allow','project','same-project',
        'operations','active',1000+history.value FROM json_each(?2) history
        CROSS JOIN json_each('["delivery.view","directory.read"]') capability`)
      .bind(f.id,JSON.stringify(Array.from({length:200},(_,index)=>index))).run();
    expect(await can(f)).toBe(false);
    expect(await listPortalWorkspaceHierarchy(env,principal,f.id,null)).toEqual([]);
  });
  it('enforces the specific-date boundary from SQL time without reclassifying another project',async()=>{
    const f=await fixture(),expiry=new Date(Date.now()+86400_000).toISOString(),id=await terms(f,{kind:'collaborator',mode:'specific_date',expiresAt:expiry});
    await allow(f,id);expect(await can(f)).toBe(true);
    const sql=`SELECT ${projectAccessTermsSql({termsId:'?1',workspaceId:'?2',projectId:'?3',legacyRetained:'1',now:'?4'})} allowed`;
    expect(await db.prepare(sql).bind(id,f.id,'same-project',new Date(Date.parse(expiry)-1000).toISOString()).first('allowed')).toBe(1);
    expect(await db.prepare(sql).bind(id,f.id,'same-project',expiry).first('allowed')).toBe(0);
    expect(await db.prepare(sql).bind(id,f.id,'other-project',new Date().toISOString()).first('allowed')).toBe(0);
  });
  it('never borrows terms from a different workspace with equal project IDs',async()=>{
    const first=await fixture(),second=await fixture(),id=await terms(first,{kind:'customer',mode:'until_revoked',expiresAt:null});
    await expect(allow(second,id)).rejects.toThrow();await allow(second,null);await complete(second,40);
    expect(await can(second)).toBe(false);
  });
  it('applies exact staff delivery terms in both direct and prefix readers independently of another grant',async()=>{
    const f=await fixture(),id=await terms(f,{kind:'collaborator',mode:'project_end',expiresAt:null});await allow(f,null);
    async function grant(termsId:string|null){const gid=crypto.randomUUID();await db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
      (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id,access_terms_id)
      VALUES(?,?,1,?,?,'v1','project','same-project','v1','fixture','fixture-staff',?)`).bind(gid,gid,f.id,f.binding,termsId).run();}
    await grant(id);expect(await authorizeAuthenticatedDeliveryGrant(env,principal,f.id,f.binding)).toBe(true);
    await complete(f,8);expect(await authorizeAuthenticatedDeliveryGrant(env,principal,f.id,f.binding)).toBe(false);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env,principal,f.id)).toEqual(new Set());
    await grant(null);expect(await authorizeAuthenticatedDeliveryGrant(env,principal,f.id,f.binding)).toBe(true);
    expect(await listAuthorizedAuthenticatedDeliveryPrefixes(env,principal,f.id)).toEqual(new Set([`${f.id}/`]));
  });
});
