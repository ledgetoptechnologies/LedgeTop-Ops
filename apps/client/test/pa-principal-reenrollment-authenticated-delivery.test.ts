import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('cloudflare:workers',()=>({WorkerEntrypoint:class {},WorkflowEntrypoint:class {}}));
import {Hono} from 'hono';
import {deliverySecurityHeaders} from '../src/worker/index';
import {ingestOpsSyncPortalProjection} from '../src/worker/ops-sync-portal-entrypoint';
import {createClientPortalRouter} from '../src/worker/client-portal/routes';
import {d1ClientPortalRepository} from '../src/worker/client-portal/repository';
import {encodeAuthenticatedDeliveryHandle} from '../src/worker/client-portal/authenticated-delivery-handles';
import type {Env} from '../src/worker/types';
import {splitD1MigrationStatements} from './helpers/d1-migrations';

// Uses the complete migration chain, private signed-source receiver, real D1/R2,
// and resource HTTP routes. The encrypted handle alone confers no access.
describe.each(['legacy-primary','native-primary','native-secondary'] as const)('reenrolled principal explicit authenticated folder delivery: %s',mode=>{
 let mf:Miniflare,db:D1Database,bucket:R2Bucket,env:Env;
 const source=mode==='native-secondary'?'project-alpha:folder-secondary':'project-alpha:primary',applicationKey='reenrolled-folder-test';
 const actor={issuer:'https://access.test',subject:'reenrolled-delivery-person',email:'delivery@example.test'};
 let currentActor=actor,workspace='',identity='',rootHandle='',fileHandle='';
 let oldRow:unknown,oldEligibility:unknown;
 const common={schemaVersion:3,applicationKey,occurredAt:'2026-10-01T00:00:00.000Z',sourceGeneration:'folder-generation',workspaceId:'folder-upstream'};
 const router=()=>new Hono<{Bindings:Env}>().use('*',deliverySecurityHeaders).route('/api/client',createClientPortalRouter({resolvePrincipal:async()=>currentActor,repository:d1ClientPortalRepository}));
 const request=(path:string,init:RequestInit={})=>router().request('https://client.test/api/client'+path,{...init,headers:{...(path==='/session'?{}:{'X-LTDS-Workspace-ID':workspace}),...init.headers}},env);
 const ingest=async(sequence:number,payload:Record<string,unknown>)=>{
  const deliveryId=`folder-delivery-${sequence}-${String(payload.kind)}`;
  expect(await ingestOpsSyncPortalProjection(env,{protocolVersion:1,sourceId:source,applicationKey,deliveryId,projectionKind:'portal',body:JSON.stringify({...common,sourceSequence:sequence,deliveryId,...payload})})).toMatchObject({ok:true,status:'completed'});
 };
 beforeAll(async()=>{
  mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'reenrolled-folder-'+mode},r2Buckets:{DATA_BUCKET:'reenrolled-folder-'+mode}});
  db=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
  bucket=await mf.getR2Bucket('DATA_BUCKET') as unknown as R2Bucket;
  const directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)));
  env={DELIVERY_DB:db,DATA_BUCKET:bucket,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_ORIGIN:'https://client.test',PROJECT_ALPHA_PORTAL_SYNC_ENABLED:'true',PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'false',PROJECT_ALPHA_PORTAL_APPLICATION_KEY:applicationKey,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true',CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',DELIVERY_SESSION_SECRET:'reenrolled-folder-session-secret-at-least-32-bytes',ENVIRONMENT:'development'} as Env;
  if(mode==='legacy-primary')await db.batch([
   db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id) VALUES('folder-account','Folder organization','active','folder-org','project-alpha:primary')"),
   db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id) VALUES('folder-upstream','organization','folder-org','folder-account','Folder organization','active','project-alpha:primary')"),
  ]);
  if(mode==='native-secondary')await db.batch([
   db.prepare("INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version) VALUES(?,'folder-source-binding','https://pa.test','/portal',?,'active',1,1,1,1)").bind(source,applicationKey),
   db.prepare("INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by) VALUES(?,1,'test-only','https://team.test','test','producer','key',?,'test')").bind(source,'a'.repeat(64)),
  ]);
  const grants=['workspace.view','delivery.view'].map((capability,i)=>({publicId:`folder-entitlement-${i}`,principalPublicId:'folder-old',capability,effect:'allow',scopeType:'workspace',scopePublicId:'folder-upstream',sourceVersion:'entitlement-v1',active:true,validFrom:'2026-01-01T00:00:00.000Z',expiresAt:null}));
  await ingest(1,{kind:'snapshot.page',snapshotHash:'b'.repeat(64),pageCount:1,recordCount:7,pageNumber:1,
   workspace:{publicId:'folder-upstream',rootType:'organization',rootPublicId:'folder-org',displayName:'Folder organization',sourceVersion:'root-v1',active:true},
   entities:[{type:'organization',publicId:'folder-org',parentPublicId:null,displayName:'Organization',sourceVersion:'root-v1',active:true,primaryContact:false},{type:'project',publicId:'folder-project',parentPublicId:'folder-org',displayName:'Project',sourceVersion:'project-v1',active:true,primaryContact:false}],
   relations:[{publicId:'folder-relation',relationType:'contains',from:{type:'organization',publicId:'folder-org'},to:{type:'project',publicId:'folder-project'},sourceVersion:'relation-v1',active:true}],
   projectLifecycles:[{projectPublicId:'folder-project',status:'active',completedAt:null,sourceVersion:'lifecycle-v1'}],
   principals:[{publicId:'folder-old',emailHint:actor.email,displayName:'Person',sourceVersion:'old-v1',active:true}],entitlements:grants});
  await ingest(1,{kind:'snapshot.activate',snapshotHash:'b'.repeat(64),pageCount:1,recordCount:7});
  workspace=(await db.prepare('SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?').bind(source,'folder-upstream').first<string>('workspace_id'))!;
  { const session=await request('/session'); expect(session.status,await session.clone().text()).toBe(200); }
  identity=(await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,'folder-old').first<string>('identity_id'))!;
  await ingest(2,{kind:'event',event:{resource:'principal',action:'tombstone',publicId:'folder-old',sourceVersion:'old-revoked-v2'}});
  oldRow=await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,'folder-old').first();
  oldEligibility=(await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,'folder-old').all()).results;
  await ingest(3,{kind:'event',event:{resource:'principal',action:'upsert',principal:{publicId:'folder-current',emailHint:actor.email,displayName:'Person',sourceVersion:'current-v1',active:true}}});
  for(const [i,grant] of grants.entries())await ingest(4+i,{kind:'event',event:{resource:'entitlement',action:'upsert',entitlement:{...grant,principalPublicId:'folder-current',sourceVersion:'current-entitlement-v1'}}});
  { const session=await request('/session'); expect(session.status,await session.clone().text()).toBe(200); }
  expect(await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,'folder-current').first('identity_id')).toBeNull();
  await db.batch([
   db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status) VALUES('folder-binding',?,'project','folder-project','clients/reenrolled-folder/','project_alpha','project-v1','active')").bind(workspace),
   db.prepare("INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES('folder-grant','folder-logical',1,?,'folder-binding','project-v1','principal','folder-current','current-v1','test','test-staff')").bind(workspace),
   db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES('folder-grant',?,'folder-current',?,'current-v1')").bind(workspace,identity),
   db.prepare("INSERT INTO portal_authenticated_delivery_notification_policies(grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id) VALUES('folder-grant',1,'folder-logical',?,?,?,'folder-current','current-v1',1,'both','test-staff')").bind(workspace,source,identity),
   db.prepare("INSERT INTO portal_authenticated_delivery_change_batches(id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,eligible_at,added_count,removed_count,bell_published_at) VALUES('folder-batch','folder-grant',1,'folder-logical',?,?,'folder-binding','project-v1','project','folder-project','clients/reenrolled-folder/',?,'folder-current','current-v1',1,datetime('now','-1 second'),1,0,datetime('now'))").bind(workspace,source,identity),
   db.prepare("INSERT INTO authenticated_delivery_recipient_events(id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count) SELECT 'folder-event',id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count FROM portal_authenticated_delivery_change_batches WHERE id='folder-batch'"),
  ]);
  if(mode==='native-secondary'){
   await db.batch([
    db.prepare("INSERT INTO portal_native_staff_bindings(binding_id,source_id,workspace_id,project_id,project_public_id,r2_prefix,division_id) VALUES('folder-binding',?,?,'folder-project','folder-project','clients/reenrolled-folder/','test-division')").bind(source,workspace),
    db.prepare("INSERT INTO portal_native_staff_grants(grant_id,binding_id,source_id,authorization_id,actor_id,idempotency_key,fingerprint,state,publication_deadline) VALUES('folder-grant','folder-binding',?,'folder-authorization','test-staff','folder-idempotency',?,'pending',datetime('now','+1 day'))").bind(source,'d'.repeat(64)),
   ]);
   await db.prepare("UPDATE portal_native_staff_grants SET state='active' WHERE grant_id='folder-grant'").run();
  }
  expect(await db.prepare('SELECT legacy_account_id FROM portal_v2_workspaces WHERE id=?').bind(workspace).first('legacy_account_id')).toBe(mode==='legacy-primary'?'folder-account':null);
  const object=await bucket.put('clients/reenrolled-folder/readme.txt','reenrolled private content',{httpMetadata:{contentType:'text/plain'}});
  await db.prepare('INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)').bind('clients/reenrolled-folder/readme.txt',object!.etag,'reenrolled private content'.length,new Date().toISOString(),'text/plain','text').run();
  rootHandle=await encodeAuthenticatedDeliveryHandle(env,{v:1,sourceId:source,workspaceId:workspace,identityId:identity,eventId:'folder-event',grantId:'folder-grant',grantVersion:1,bindingId:'folder-binding',bindingSourceVersion:'project-v1',expires:Date.now()+600_000,kind:'folder',path:''});
 },180_000);
 afterAll(async()=>mf?.dispose());
 it('frames only authorized safe inline previews using the production security middleware',async()=>{
  const frameable=(response:Response)=>{
   expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
   expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
   expect(response.headers.get('Content-Security-Policy')).toContain('https://viewer.ledgetopdroneservices.com');
   expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  };
  const locked=(response:Response)=>{
   expect(response.headers.get('X-Frame-Options')).toBe('DENY');
   expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  };
  const list=await request('/authenticated-deliveries/files?folder='+encodeURIComponent(rootHandle));
  const adFile=(await list.json() as {files:Array<{id:string}>}).files[0]!.id;
  let preview='/authenticated-deliveries/preview?file='+encodeURIComponent(adFile);
  if(mode!=='legacy-primary'){
   const folders=await request(`/v2/workspaces/${workspace}/deliveries`);
   expect(folders.status,await folders.clone().text()).toBe(200);
   const folder=(await folders.json() as {items:Array<{id:string}>}).items[0]!.id;
   const files=await request(`/v2/workspaces/${workspace}/folders/${encodeURIComponent(folder)}`);
   expect(files.status,await files.clone().text()).toBe(200);
   const file=(await files.json() as {files:Array<{id:string}>}).files[0]!.id;
   expect(file).toMatch(/^np1_/);
   preview=`/v2/workspaces/${workspace}/files/${encodeURIComponent(file)}/preview`;
  }
  for(const init of [{},{method:'HEAD'},{headers:{Range:'bytes=0-2'}}]){
   const response=await request(preview,init);expect([200,206]).toContain(response.status);frameable(response);
  }
  const download=await request('/authenticated-deliveries/download?file='+encodeURIComponent(adFile));
  expect(download.status).toBe(200);locked(download);
  currentActor={...actor,subject:'different-subject'};
  const denied=await request(preview);expect([403,404]).toContain(denied.status);locked(denied);currentActor=actor;
  await db.prepare("UPDATE file_index SET content_type='text/html' WHERE r2_key='clients/reenrolled-folder/readme.txt'").run();
  try{const unsafe=await request(preview);expect(unsafe.status).toBe(415);locked(unsafe);}
  finally{await db.prepare("UPDATE file_index SET content_type='text/plain' WHERE r2_key='clients/reenrolled-folder/readme.txt'").run();}
 },180_000);
 it('reads and downloads only while the exact current principal witness is live',async()=>{
  const list=await request('/authenticated-deliveries/files?folder='+encodeURIComponent(rootHandle));
  expect(list.status,await list.clone().text()).toBe(200);
  const body=await list.json() as {files:Array<{id:string;name:string}>};
  expect(body.files.map(file=>file.name)).toEqual(['readme.txt']);fileHandle=body.files[0]!.id;
  const download=await request('/authenticated-deliveries/download?file='+encodeURIComponent(fileHandle));
  expect(download.status,await download.clone().text()).toBe(200);expect(await download.text()).toBe('reenrolled private content');
  currentActor={...actor,subject:'different-subject'};
  expect([403,404]).toContain((await request('/authenticated-deliveries/download?file='+encodeURIComponent(fileHandle))).status);
  currentActor=actor;
  // A stale eligibility witness must not authorize a NULL-identity principal.
  // Disable repair during this read so the test exercises the exact read guard.
  env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED='false';
  await db.prepare("UPDATE portal_v2_identity_eligibility_bindings SET principal_source_version='stale-v0' WHERE workspace_id=? AND principal_public_id='folder-current'").bind(workspace).run();
  expect([403,404]).toContain((await request('/authenticated-deliveries/files?folder='+encodeURIComponent(rootHandle))).status);
  expect([403,404]).toContain((await request('/authenticated-deliveries/download?file='+encodeURIComponent(fileHandle))).status);
  await db.prepare("UPDATE portal_v2_identity_eligibility_bindings SET principal_source_version='current-v1' WHERE workspace_id=? AND principal_public_id='folder-current'").bind(workspace).run();
  env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED='true';
  expect((await request('/authenticated-deliveries/download?file='+encodeURIComponent(fileHandle))).status).toBe(200);
  await ingest(6,{kind:'event',event:{resource:'principal',action:'tombstone',publicId:'folder-current',sourceVersion:'current-revoked-v3'}});
  expect([403,404]).toContain((await request('/authenticated-deliveries/download?file='+encodeURIComponent(fileHandle))).status);
  const revokedPreview=await request('/authenticated-deliveries/preview?file='+encodeURIComponent(fileHandle));
  expect([403,404]).toContain(revokedPreview.status);
  expect(revokedPreview.headers.get('X-Frame-Options')).toBe('DENY');
  expect(revokedPreview.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,'folder-old').first()).toEqual(oldRow);
  expect((await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(workspace,'folder-old').all()).results).toEqual(oldEligibility);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 },180_000);
});
