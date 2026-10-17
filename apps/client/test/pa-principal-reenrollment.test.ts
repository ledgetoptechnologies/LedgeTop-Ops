import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('cloudflare:workers',()=>({WorkerEntrypoint:class {}}));
import {ingestOpsSyncPortalProjection} from '../src/worker/ops-sync-portal-entrypoint';
import {createClientPortalRouter} from '../src/worker/client-portal/routes';
import {createWorkspaceInvitation} from '../src/worker/client-portal/workspace-memberships';
import {acceptPortalWorkspaceInvitation} from '../src/worker/client-portal/workspace-v2';
import {d1ClientPortalRepository} from '../src/worker/client-portal/repository';
import {bindNativePortalEligibility} from '../src/worker/client-portal/native-portal-eligibility';
import type {Env} from '../src/worker/types';
import {splitD1MigrationStatements} from './helpers/d1-migrations';

describe('current PA principal replaces revoked eligibility without rewriting history',()=>{
 let mf:Miniflare,db:D1Database,env:Env;
 const primary='project-alpha:primary',secondary='project-alpha:reenrollment',applicationKey='reenrollment-test';
 beforeAll(async()=>{
  mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'pa-reenrollment'}});
  db=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
  const directory=new URL('../migrations/',import.meta.url);
  for(const n of readdirSync(directory).filter(n=>/^\d+.*\.sql$/.test(n)).sort())
   await db.batch(splitD1MigrationStatements(readFileSync(new URL(n,directory),'utf8')).map(sql=>db.prepare(sql)));
  env={DELIVERY_DB:db,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_ORIGIN:'https://client.test',
   PROJECT_ALPHA_PORTAL_SYNC_ENABLED:'true',PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'false',PROJECT_ALPHA_PORTAL_APPLICATION_KEY:applicationKey,
   CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',
   CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true',CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED:'true',PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true'} as Env;
  await db.batch([
   db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
    VALUES(?,'reenrollment-binding','https://pa.test','/portal',?,'active',1,1,1,1)`).bind(secondary,applicationKey),
   db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
    VALUES(?,1,'test-only','https://team.test','test','producer','key',?,'test')`).bind(secondary,'a'.repeat(64)),
  ]);
 },90_000);
 afterAll(async()=>mf?.dispose());
 it('keeps ordinary pre-0234 sign-in working but defers replacement binding until the receipt contract exists',async()=>{
  const oldRuntime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'pre-reenrollment'}});
  try{
   const database=await oldRuntime.getD1Database('DELIVERY_DB') as unknown as D1Database;
   const directory=new URL('../migrations/',import.meta.url),names=readdirSync(directory).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
   for(const name of names.filter(n=>n<'0234_'))await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>database.prepare(sql)));
   const target={...env,DELIVERY_DB:database},actor={issuer:'https://team.test',subject:'rolling-person',email:'rolling@example.test'};
   const upstream='rolling-workspace',root='rolling-root',common={schemaVersion:2,applicationKey,occurredAt:'2026-10-01T00:00:00.000Z',sourceGeneration:'rolling-generation',workspaceId:upstream};
   const ingest=async(payload:Record<string,unknown>)=>expect(await ingestOpsSyncPortalProjection(target,{protocolVersion:1,sourceId:primary,applicationKey,deliveryId:String(payload.deliveryId),projectionKind:'portal',body:JSON.stringify(payload)})).toMatchObject({ok:true,status:'completed'});
   const grants=['workspace.view','directory.read'].map((capability,index)=>({publicId:`rolling-grant-${index}`,principalPublicId:'rolling-old',capability,effect:'allow',scopeType:'workspace',scopePublicId:upstream,sourceVersion:'grant-v1',active:true,validFrom:'2026-01-01T00:00:00.000Z',expiresAt:null}));
   await ingest({...common,sourceSequence:1,kind:'snapshot.page',deliveryId:'rolling-page',snapshotHash:'d'.repeat(64),pageCount:1,recordCount:4,pageNumber:1,workspace:{publicId:upstream,rootType:'organization',rootPublicId:root,displayName:'Rolling',sourceVersion:'root-v1',active:true},entities:[{type:'organization',publicId:root,parentPublicId:null,displayName:'Rolling',sourceVersion:'root-v1',active:true,primaryContact:false}],principals:[{publicId:'rolling-old',emailHint:actor.email,displayName:'Person',sourceVersion:'old-v1',active:true}],entitlements:grants});
   await ingest({...common,sourceSequence:1,kind:'snapshot.activate',deliveryId:'rolling-activate',snapshotHash:'d'.repeat(64),pageCount:1,recordCount:4});
   const workspace=await database.prepare('SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?').bind(primary,upstream).first<string>('workspace_id');
   const router=createClientPortalRouter({resolvePrincipal:async()=>actor,repository:d1ClientPortalRepository});
   expect((await router.request('https://client.test/session',{},target)).status).toBe(200);
   await ingest({...common,sourceSequence:2,kind:'event',deliveryId:'rolling-revoke',event:{resource:'principal',action:'tombstone',publicId:'rolling-old',sourceVersion:'revoked-v2'}});
   const old=await database.prepare("SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id='rolling-old'").bind(workspace).first();
   await ingest({...common,sourceSequence:3,kind:'event',deliveryId:'rolling-new',event:{resource:'principal',action:'upsert',principal:{publicId:'rolling-new',emailHint:actor.email,displayName:'Person',sourceVersion:'new-v1',active:true}}});
   for(const [index,grant] of grants.entries())await ingest({...common,sourceSequence:4+index,kind:'event',deliveryId:`rolling-grant-update-${index}`,event:{resource:'entitlement',action:'upsert',entitlement:{...grant,principalPublicId:'rolling-new',sourceVersion:'new-grant-v1'}}});
   expect((await router.request('https://client.test/session',{},target)).status).toBe(200);
   expect(await database.prepare("SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id='rolling-new'").bind(workspace).first('n')).toBe(0);
   expect(await (await router.request('https://client.test/v2/workspaces',{},target)).json()).toEqual({workspaces:[]});
   await database.batch(splitD1MigrationStatements(readFileSync(new URL('0234_pa_principal_reenrollment.sql',directory),'utf8')).map(sql=>database.prepare(sql)));
   expect((await router.request('https://client.test/session',{},target)).status).toBe(200);
   expect(await (await router.request('https://client.test/v2/workspaces',{},target)).json()).toMatchObject({workspaces:[expect.objectContaining({id:workspace})]});
   expect(await database.prepare("SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id='rolling-old'").bind(workspace).first()).toEqual(old);
   expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }finally{await oldRuntime.dispose();}
 },180_000);
 it.each([primary,secondary,'legacy-primary'])('reenrolls exact verified identity in %s and preserves revoked rows',async sourceCase=>{
  const source=sourceCase==='legacy-primary'?primary:sourceCase;
  const tag=sourceCase==='legacy-primary'?'legacy':source===primary?'primary':'secondary',upstream=`reenrollment-${tag}`,root=`root-${tag}`;
  const actor={issuer:'https://team.test',subject:`person-${tag}`,email:`${tag}@example.test`};
  const old=`old-${tag}`,current=`new-${tag}`;
  const common={schemaVersion:2,applicationKey,occurredAt:'2026-10-01T00:00:00.000Z',sourceGeneration:`generation-${tag}`,workspaceId:upstream};
  const grants=['workspace.view','directory.read','member.manage'].map((capability,i)=>({publicId:`grant-${tag}-${i}`,principalPublicId:old,capability,effect:'allow',scopeType:'workspace',scopePublicId:upstream,sourceVersion:'grant-v1',active:true,validFrom:'2026-01-01T00:00:00.000Z',expiresAt:null}));
  const ingest=async(payload:Record<string,unknown>)=>{
   const result=await ingestOpsSyncPortalProjection(env,{protocolVersion:1,sourceId:source,applicationKey,deliveryId:String(payload.deliveryId),projectionKind:'portal',body:JSON.stringify(payload)});
   expect(result).toMatchObject({ok:true,status:'completed'});
  };
  await ingest({...common,sourceSequence:1,kind:'snapshot.page',deliveryId:`page-${tag}`,snapshotHash:'b'.repeat(64),pageCount:1,recordCount:5,pageNumber:1,
   workspace:{publicId:upstream,rootType:'organization',rootPublicId:root,displayName:tag,sourceVersion:'root-v1',active:true},
   entities:[{type:'organization',publicId:root,parentPublicId:null,displayName:tag,sourceVersion:'root-v1',active:true,primaryContact:false}],
   principals:[{publicId:old,emailHint:actor.email,displayName:'Person',sourceVersion:'old-v1',active:true}],entitlements:grants});
  await ingest({...common,sourceSequence:1,kind:'snapshot.activate',deliveryId:`activate-${tag}`,snapshotHash:'b'.repeat(64),pageCount:1,recordCount:5});
  const workspace=await db.prepare('SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?').bind(source,upstream).first<string>('workspace_id');
  expect(workspace).toBeTruthy();
  if(sourceCase==='legacy-primary'){
   await db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id,project_alpha_organization_id) VALUES(?,?,'active',?,?)").bind(upstream,'Legacy',primary,root).run();
   await db.prepare('UPDATE portal_v2_workspaces SET legacy_account_id=? WHERE id=?').bind(upstream,workspace).run();
  }
  const router=createClientPortalRouter({resolvePrincipal:async()=>actor,repository:d1ClientPortalRepository});
  const session=()=>router.request('https://client.test/session',{},env);
  expect((await session()).status).toBe(200);
  const boundIdentity=await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,old).first<string>('identity_id');
  await db.prepare(`INSERT INTO portal_v2_identity_denials (id,identity_id,scope_type,scope_public_id,reason_code,status,created_by_actor_type,created_by_actor_id) VALUES(?,?,'global',NULL,'bound-refresh','active','system','test')`).bind(`bound-deny-${tag}`,boundIdentity).run();
  await ingest({...common,sourceSequence:2,kind:'event',deliveryId:`bound-denied-${tag}`,event:{resource:'principal',action:'upsert',principal:{publicId:old,emailHint:actor.email,displayName:'Person',sourceVersion:'bound-v2',active:true}}});
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND status='active'").bind(workspace).first('n')).toBe(0);
  await db.prepare("UPDATE portal_v2_identity_denials SET status='revoked',revoked_at=datetime('now'),revoked_by_actor_type='system',revoked_by_actor_id='test' WHERE id=?").bind(`bound-deny-${tag}`).run();
  expect((await session()).status).toBe(200);
  await ingest({...common,sourceSequence:3,kind:'event',deliveryId:`revoke-${tag}`,event:{resource:'principal',action:'tombstone',publicId:old,sourceVersion:'revoked-v2'}});
  const oldRow=await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,old).first();
  const oldEligibility=await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,old).all();
  await ingest({...common,sourceSequence:4,kind:'event',deliveryId:`replacement-${tag}`,event:{resource:'principal',action:'upsert',principal:{publicId:current,emailHint:actor.email,displayName:'Person',sourceVersion:'replacement-v1',active:true}}});
  for(const [i,grant] of grants.entries())await ingest({...common,sourceSequence:5+i,kind:'event',deliveryId:`grant-${tag}-${i}`,event:{resource:'entitlement',action:'upsert',entitlement:{...grant,principalPublicId:current,sourceVersion:'new-grant-v1'}}});
  expect((await session()).status).toBe(200);
  expect((await session()).status).toBe(200);
  if(sourceCase!=='legacy-primary'){
   // The current principal cannot take its revoked predecessor's unique identity
   // slot. A complete eligibility witness is already its effective identity.
   expect(await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,current).first('identity_id')).toBeNull();
   const transitionAuthority=vi.fn(async()=>({ok:true}));
   env.SHARED_PROFILE_PORTAL={transitionAuthority} as unknown as Env['SHARED_PROFILE_PORTAL'];
   await db.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=1 WHERE id=1').run();
   try{
    const heads=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspace).all();
    await Promise.all(Array.from({length:3},()=>bindNativePortalEligibility(env,actor,actor.email)));
    expect(transitionAuthority).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspace).all()).results).toEqual(heads.results);
    // Missing/stale witnesses and a revoked derived entitlement still require
    // the normal fenced repair, rather than a blanket NULL-principal skip.
    await db.prepare('DELETE FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,current).run();
    await bindNativePortalEligibility(env,actor,actor.email);
    expect(transitionAuthority).toHaveBeenCalled();transitionAuthority.mockClear();
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,current).first('n')).toBe(1);
    await db.prepare("UPDATE portal_v2_identity_eligibility_bindings SET principal_source_version='stale' WHERE workspace_id=? AND principal_public_id=?").bind(workspace,current).run();
    await bindNativePortalEligibility(env,actor,actor.email);
    expect(transitionAuthority).toHaveBeenCalled();transitionAuthority.mockClear();
    expect(await db.prepare('SELECT principal_source_version FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,current).first('principal_source_version')).toBe('replacement-v1');
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE workspace_id=? AND source_type='project_alpha'").bind(workspace).run();
    await bindNativePortalEligibility(env,actor,actor.email);
    expect(transitionAuthority).toHaveBeenCalled();transitionAuthority.mockClear();
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND source_type='project_alpha' AND status='active' AND revoked_at IS NULL").bind(workspace).first('n')).toBe(1);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND capability='directory.read'").bind(workspace).run();
    await bindNativePortalEligibility(env,actor,actor.email);
    expect(transitionAuthority).toHaveBeenCalled();transitionAuthority.mockClear();
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND capability='directory.read' AND status='active' AND revoked_at IS NULL").bind(workspace).first('n')).toBe(1);
    await bindNativePortalEligibility(env,{...actor,subject:'different-historical-identity'},actor.email);
    expect(transitionAuthority).not.toHaveBeenCalled();
    const identitiesBefore=await db.prepare('SELECT count(*) n FROM portal_v2_identities').first('n');
    expect((await createClientPortalRouter({resolvePrincipal:async()=>({...actor,subject:'different-historical-identity'}),repository:d1ClientPortalRepository}).request('https://client.test/session',{},env)).status).toBe(403);
    expect(await db.prepare('SELECT count(*) n FROM portal_v2_identities').first('n')).toBe(identitiesBefore);
    expect(transitionAuthority).not.toHaveBeenCalled();
   }finally{await db.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=0 WHERE id=1').run();}
  }
  const list=await router.request('https://client.test/v2/workspaces',{},env);
  expect(list.status).toBe(200);expect(await list.json()).toMatchObject({workspaces:[expect.objectContaining({id:workspace})]});
  expect(await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,old).first()).toEqual(oldRow);
  expect((await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,old).all()).results).toEqual(oldEligibility.results);
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND status='active'").bind(workspace).first('n')).toBe(1);
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND status='active'").bind(workspace).first('n')).toBe(3);
  const impostor={...actor,subject:`different-${tag}`};
  const otherRouter=createClientPortalRouter({resolvePrincipal:async()=>impostor,repository:d1ClientPortalRepository});
  expect((await otherRouter.request('https://client.test/session',{},env)).status).toBe(403);
  expect(await db.prepare('SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?').bind(workspace).first('n')).toBe(2);
  expect((await session()).status).toBe(200);
  await ingest({...common,sourceSequence:8,kind:'event',deliveryId:`refresh-${tag}`,event:{resource:'principal',action:'upsert',principal:{publicId:current,emailHint:actor.email,displayName:'Person',sourceVersion:'replacement-v2',active:true}}});
  // Signed projection refresh must keep current authority without relying on a subsequent session repair.
  expect(await db.prepare("SELECT source_version FROM portal_v2_workspace_memberships WHERE workspace_id=? AND status='active'").bind(workspace).first('source_version')).toBe('replacement-v2');
  expect((await session()).status).toBe(200);
  // A new signed generation must preserve the old revoked row, not silently
  // convert it to suspended or drop its historical eligibility witness.
  const latestGrants=grants.map(g=>({...g,principalPublicId:current,sourceVersion:'replacement-v2'}));
  await ingest({...common,sourceGeneration:`resnapshot-${tag}`,sourceSequence:9,kind:'snapshot.page',deliveryId:`repage-${tag}`,snapshotHash:'c'.repeat(64),pageCount:1,recordCount:5,pageNumber:1,
   workspace:{publicId:upstream,rootType:'organization',rootPublicId:root,displayName:tag,sourceVersion:'root-v1',active:true},
   entities:[{type:'organization',publicId:root,parentPublicId:null,displayName:tag,sourceVersion:'root-v1',active:true,primaryContact:false}],
   principals:[{publicId:current,emailHint:actor.email,displayName:'Person',sourceVersion:'replacement-v2',active:true}],entitlements:latestGrants});
  await ingest({...common,sourceGeneration:`resnapshot-${tag}`,sourceSequence:9,kind:'snapshot.activate',deliveryId:`reactivate-${tag}`,snapshotHash:'c'.repeat(64),pageCount:1,recordCount:5});
  expect((await session()).status).toBe(200);
  expect(await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,old).first()).toEqual(oldRow);
  expect((await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,old).all()).results).toEqual(oldEligibility.results);
  if(source===secondary){
   const consumed=await db.prepare('SELECT * FROM portal_pa_membership_reenrollment_receipts WHERE workspace_id=?').bind(workspace).all();
   expect(consumed.results.length).toBeGreaterThanOrEqual(2);expect(consumed.results.every(r=>r.consumed===1)).toBe(true);
   await expect(db.prepare("UPDATE portal_v2_workspace_memberships SET source_version='old-v1' WHERE workspace_id=?").bind(workspace).run()).rejects.toThrow('secondary membership authority is immutable');
   await expect(db.prepare('UPDATE portal_pa_membership_reenrollment_receipts SET consumed=0 WHERE workspace_id=?').bind(workspace).run()).rejects.toThrow('receipt is immutable');
  }
  if(source===secondary){
   const invitation=await createWorkspaceInvitation(env,actor,workspace!,{email:'guest@example.test',organizationWide:true,confirmOrganizationWide:true,capabilities:['workspace.view']},'reenrolled-manager-invite-key',{emailDeliveryAvailable:true});
   expect(invitation.outcome).toBe('created');
   if(!('invitation' in invitation))throw new Error('Expected invitation');
   const payload=await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(invitation.invitation.id).first<string>('payload_json');
   const token=(JSON.parse(payload!) as {token:string}).token;
   expect(await acceptPortalWorkspaceInvitation(env,{issuer:actor.issuer,subject:'invited-person',email:'guest@example.test'},token)).toBe('accepted');
   const invited=await db.prepare("SELECT identity_id FROM portal_v2_workspace_memberships WHERE workspace_id=? AND source_type='client_invitation'").bind(workspace).first<string>('identity_id');
   await expect(db.prepare("UPDATE portal_v2_workspace_memberships SET source_version='forged' WHERE workspace_id=? AND identity_id=?").bind(workspace,invited).run()).rejects.toThrow('secondary membership authority is immutable');
  }
  const identity=await db.prepare('SELECT identity_id FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,current).first<string>('identity_id');
  await db.prepare(`INSERT INTO portal_v2_identity_denials (id,identity_id,scope_type,scope_public_id,reason_code,status,created_by_actor_type,created_by_actor_id) VALUES(?,?,'global',NULL,'reenrollment-test','active','system','test')`).bind(`deny-${tag}`,identity).run();
  await ingest({...common,sourceGeneration:`resnapshot-${tag}`,sourceSequence:10,kind:'event',deliveryId:`denied-refresh-${tag}`,event:{resource:'principal',action:'upsert',principal:{publicId:current,emailHint:actor.email,displayName:'Person',sourceVersion:'replacement-v3',active:true}}});
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND source_type='project_alpha' AND status='active'").bind(workspace).first('n')).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='project_alpha' AND status='active'").bind(workspace).first('n')).toBe(0);
  await ingest({...common,sourceGeneration:`resnapshot-${tag}`,sourceSequence:11,kind:'event',deliveryId:`revoke-current-${tag}`,event:{resource:'principal',action:'tombstone',publicId:current,sourceVersion:'current-revoked-v3'}});
  const closed=await router.request('https://client.test/v2/workspaces',{},env);
  expect(closed.status).toBe(200);expect(await closed.json()).toEqual({workspaces:[]});
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND source_type='project_alpha' AND status='active'").bind(workspace).first('n')).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='project_alpha' AND status='active'").bind(workspace).first('n')).toBe(0);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 },180_000);
});
