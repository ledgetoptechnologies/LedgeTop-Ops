import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('cloudflare:workers',()=>({WorkerEntrypoint:class {},WorkflowEntrypoint:class {},DurableObject:class {}}));
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {parsePortalProjectionDelivery} from '../../client/src/worker/project-alpha-portal';
import {ingestOpsSyncPortalProjection} from '../../client/src/worker/ops-sync-portal-entrypoint';
import {createClientPortalRouter} from '../../client/src/worker/client-portal/routes';
import {d1ClientPortalRepository} from '../../client/src/worker/client-portal/repository';
import {createPrimaryWorkspaceBinding,searchPrimaryWorkspaceBindingTargets} from '../src/worker/primary-delivery-workspace-bindings';
import {createAuthenticatedDeliveryGrant,previewAuthenticatedDeliveryGrant,revokeAuthenticatedDeliveryGrant} from '../src/worker/authenticated-delivery-grants';
import type {Env as ClientEnv} from '../../client/src/worker/types';
import type {Env as OpsEnv,StaffPrincipal} from '../src/worker/types';

// Full canonical databases, normal trusted OpsSync projection ingestion and supported Ops
// binding/preview/create. No secondary native publication or fake legacy bridge.
describe('native primary explicit workspace folder delivery',()=>{
 let mf:Miniflare,ops:D1Database,db:D1Database,bucket:R2Bucket,env:ClientEnv,opsEnv:OpsEnv,workspace:string;
 const org='a'.repeat(32),client='b'.repeat(32),person='c'.repeat(32),oldPerson='d'.repeat(32),app='native-primary-explicit-test';
 const principal={issuer:'https://access.test',subject:'native-primary-person',email:'client@example.test'};
 let actor=principal;
 const staff:StaffPrincipal={id:'explicit-test-staff',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
 const common={schemaVersion:3,applicationKey:app,occurredAt:'2026-10-01T00:00:00.000Z',sourceGeneration:'explicit-source',workspaceId:'explicit-upstream'};
 async function ingest(sequence:number,payload:Record<string,unknown>){
  const deliveryId=`explicit-${sequence}-${String(payload.kind)}`;
  parsePortalProjectionDelivery({...common,sourceSequence:sequence,deliveryId,...payload},app,true);
  expect(await ingestOpsSyncPortalProjection(env,{protocolVersion:1,sourceId:'project-alpha:primary',applicationKey:app,deliveryId,projectionKind:'portal',body:JSON.stringify({...common,sourceSequence:sequence,deliveryId,...payload})})).toMatchObject({ok:true,status:'completed'});
 }
 const request=(path:string,method='GET')=>createClientPortalRouter({resolvePrincipal:async()=>actor,repository:d1ClientPortalRepository}).request('https://client.test'+path,{method,headers:path==='/session'?{}:{'X-LTDS-Workspace-ID':workspace}},env);
 beforeAll(async()=>{
  mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS','CLIENT'],r2Buckets:['FILES']});
  ops=await mf.getD1Database('OPS') as unknown as D1Database;db=await mf.getD1Database('CLIENT') as unknown as D1Database;bucket=await mf.getR2Bucket('FILES') as unknown as R2Bucket;
  for(const [database,url] of [[ops,new URL('../migrations/',import.meta.url)],[db,new URL('../../client/migrations/',import.meta.url)]] as const)
   for(const name of readdirSync(url).filter(n=>/^\d+.*\.sql$/.test(n)).sort())await database.batch(splitD1MigrationStatements(readFileSync(new URL(name,url),'utf8')).map(sql=>database.prepare(sql)));
  env={DELIVERY_DB:db,DATA_BUCKET:bucket,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_ORIGIN:'https://client.test',PROJECT_ALPHA_PORTAL_SYNC_ENABLED:'true',PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'false',PROJECT_ALPHA_PORTAL_APPLICATION_KEY:app,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true',CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',DELIVERY_SESSION_SECRET:'native-primary-explicit-folder-secret-at-least-32-bytes',ENVIRONMENT:'development'} as ClientEnv;
  // Optional local verification artifact contains only this synthetic fixture's emitted SQL.
  if(process.env.LTDS_NATIVE_QUERY_CAPTURE){
   const capture=(target:any):any=>new Proxy(target,{get(value,key){
    if(key==='withSession')return (...args:unknown[])=>capture(value.withSession(...args));
    if(key==='prepare')return (sql:string)=>{
     const statement=value.prepare(sql);
     if(!sql.includes("SELECT DISTINCT 'staff' source"))return statement;
     return new Proxy(statement,{get(item,property){
      if(property==='bind')return (...params:unknown[])=>{const destination=process.env.LTDS_NATIVE_QUERY_CAPTURE!;
       if(!existsSync(destination))writeFileSync(destination,JSON.stringify({sql,params}),{flag:'wx'});
       return item.bind(...params);};
      const method=Reflect.get(item,property);return typeof method==='function'?method.bind(item):method;
     }});
    };
    const method=Reflect.get(value,key);return typeof method==='function'?method.bind(value):method;
   }});
   env.DELIVERY_DB=capture(db);
  }
  opsEnv={OPS_DB:ops,DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true',AUTHENTICATED_DELIVERY_CREATION_ENABLED:'true'} as OpsEnv;
  await ops.batch([
   ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
   ops.prepare("INSERT INTO divisions(id,name,code,active) VALUES('explicit-division','Explicit division','EXPLICIT',1)"),
   ...['delivery.share.create','delivery.share.revoke'].map(permission=>ops.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,?,'allow','global','global',?)").bind(permission,staff.id,permission,staff.id)),
  ]);
  const entitlements=[{capability:'workspace.view',scopeType:'workspace',scopePublicId:'explicit-upstream'},{capability:'directory.read',scopeType:'client',scopePublicId:client},{capability:'delivery.view',scopeType:'client',scopePublicId:client}].map((x,i)=>({publicId:`explicit-intent-${i}`,principalPublicId:oldPerson,...x,effect:'allow',sourceVersion:'intent-v1',active:true,validFrom:'2026-01-01T00:00:00.000Z',expiresAt:null}));
  await ingest(1,{kind:'snapshot.page',snapshotHash:'a'.repeat(64),pageCount:1,recordCount:7,pageNumber:1,
   workspace:{publicId:'explicit-upstream',rootType:'organization',rootPublicId:org,displayName:'Explicit QA organization',sourceVersion:'root-version-distinct-from-client',active:true},
   entities:[{type:'organization',publicId:org,parentPublicId:null,displayName:'Explicit QA organization',sourceVersion:'root-version-distinct-from-client',active:true,primaryContact:false},{type:'client',publicId:client,parentPublicId:org,displayName:'Explicit QA client',sourceVersion:'projected-client-version-four',active:true,primaryContact:false}],
   projectLifecycles:[],relations:[{publicId:'explicit-relation',relationType:'contains',from:{type:'organization',publicId:org},to:{type:'client',publicId:client},sourceVersion:'relation-v1',active:true}],
   principals:[{publicId:oldPerson,emailHint:principal.email,displayName:'Client',sourceVersion:'principal-v1',active:true}],entitlements});
  await ingest(1,{kind:'snapshot.activate',snapshotHash:'a'.repeat(64),pageCount:1,recordCount:7});
  workspace=(await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id='project-alpha:primary' AND source_workspace_id='explicit-upstream'").first<string>('workspace_id'))!;
  const session=await request('/session');expect(session.status,await session.clone().text()).toBe(200);
  await ingest(2,{kind:'event',event:{resource:'principal',action:'tombstone',publicId:oldPerson,sourceVersion:'old-revoked-v2'}});
  await ingest(3,{kind:'event',event:{resource:'principal',action:'upsert',principal:{publicId:person,emailHint:principal.email,displayName:'Client',sourceVersion:'principal-v1',active:true}}});
  for(const [i,intent] of entitlements.entries())await ingest(4+i,{kind:'event',event:{resource:'entitlement',action:'upsert',entitlement:{...intent,principalPublicId:person,sourceVersion:'current-intent-v2'}}});
  const reenrolled=await request('/session');expect(reenrolled.status,await reenrolled.clone().text()).toBe(200);
  expect(await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(workspace,person).first('identity_id')).toBeNull();
  expect(await db.prepare('SELECT legacy_account_id FROM portal_v2_workspaces WHERE id=?').bind(workspace).first('legacy_account_id')).toBeNull();
 },180_000);
 afterAll(async()=>mf?.dispose());
 it('lists, opens and downloads an exact own-client Ops grant and revokes old handles',async()=>{
  const folder='Jobs/Clients/_synthetic-native-primary-explicit/';
  const target=(await searchPrimaryWorkspaceBindingTargets(opsEnv,staff,folder,'Explicit QA client',{divisionId:'explicit-division'})).targets.find(x=>x.ownerPublicId===client)!;
  expect(target).toBeDefined();
  const bound=await createPrimaryWorkspaceBinding(opsEnv,staff,folder,{folderRef:'explicit-native-folder',workspaceId:workspace,ownershipMode:'explicit_workspace',divisionId:'explicit-division',ownerScopeType:'client',ownerPublicId:client,reasonCode:'client_workspace_link',expectedContextVersion:target.contextVersion},'explicit-native-bind-once');
  const operation={folderBindingId:bound.binding!.bindingId,audienceType:'principal' as const,audiencePublicId:person,reasonCode:'client_delivery_access'};
  const preview=await previewAuthenticatedDeliveryGrant(opsEnv,staff,operation);expect(preview.recipientCount).toBe(1);
  const created=await createAuthenticatedDeliveryGrant(opsEnv,staff,{...operation,expectedContextVersion:preview.contextVersion},'explicit-native-grant-once');
  expect(await db.prepare('SELECT COUNT(*) n FROM portal_native_staff_grants').first('n')).toBe(0);
  for(const [name,text] of [['one.txt','first synthetic file'],['two.txt','second synthetic file']] as const){
   const key=folder+name,object=await bucket.put(key,text,{httpMetadata:{contentType:'text/plain'}});
   await db.prepare('INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)').bind(key,object!.etag,text.length,new Date().toISOString(),'text/plain','text').run();
  }
  const base=`/v2/workspaces/${workspace}`;
  const list=await request(base+'/deliveries');expect(list.status,await list.clone().text()).toBe(200);
  const deliveries=await list.json() as {items:Array<{id:string}>};expect(deliveries.items).toHaveLength(1);
  const folders=await request(base+'/folders/'+encodeURIComponent(deliveries.items[0]!.id));expect(folders.status,await folders.clone().text()).toBe(200);
  const files=(await folders.json() as {files:Array<{id:string;name:string}>}).files;expect(files.map(x=>x.name)).toEqual(['one.txt','two.txt']);
  const filePath=base+'/files/'+encodeURIComponent(files[0]!.id);
  expect((await request(filePath)).status).toBe(200);
  const previewResponse=await request(filePath+'/preview');expect(previewResponse.status).toBe(200);expect(await previewResponse.text()).toBe('first synthetic file');
  expect((await request(filePath+'/download','HEAD')).status).toBe(200);
  const downloaded=await request(filePath+'/download');expect(downloaded.status).toBe(200);expect(await downloaded.text()).toBe('first synthetic file');
  actor={...principal,subject:'other-person'};expect([403,404]).toContain((await request(filePath+'/download')).status);actor=principal;
  await db.prepare("UPDATE portal_primary_staff_bindings SET state='suspended',version=2 WHERE binding_id=?").bind(bound.binding!.bindingId).run();
  const suspended=await request(base+'/deliveries');expect(suspended.status).toBe(200);expect((await suspended.json() as {items:unknown[]}).items).toEqual([]);expect([403,404]).toContain((await request(filePath+'/download')).status);
  await revokeAuthenticatedDeliveryGrant(opsEnv,staff,created.grant.grantId,1,'test_cleanup','explicit-native-revoke-once');
  expect([403,404]).toContain((await request(filePath+'/download')).status);
  const revoked=await request(base+'/deliveries');expect(revoked.status).toBe(200);expect((await revoked.json() as {items:unknown[]}).items).toEqual([]);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 },180_000);
 it('keeps a whole-organization owner independent from client ownership and requires the same primary receipt',async()=>{
  await ingest(7,{kind:'event',event:{resource:'entitlement',action:'upsert',entitlement:{publicId:'explicit-org-delivery',principalPublicId:person,capability:'delivery.view',effect:'allow',scopeType:'organization',scopePublicId:org,sourceVersion:'org-delivery-v1',active:true,validFrom:'2026-01-01T00:00:00.000Z',expiresAt:null}}});
  const folder='Jobs/Clients/_synthetic-native-primary-organization/';
  const target=(await searchPrimaryWorkspaceBindingTargets(opsEnv,staff,folder,'Explicit QA organization',{divisionId:'explicit-division'})).targets.find(x=>x.ownerPublicId===org)!;
  expect(target).toBeDefined();
  const linked=await createPrimaryWorkspaceBinding(opsEnv,staff,folder,{folderRef:'explicit-native-org-folder',workspaceId:workspace,ownershipMode:'explicit_workspace',divisionId:'explicit-division',ownerScopeType:'organization',ownerPublicId:org,reasonCode:'organization_delivery',expectedContextVersion:target.contextVersion},'explicit-native-org-bind');
  const operation={folderBindingId:linked.binding!.bindingId,audienceType:'principal' as const,audiencePublicId:person,reasonCode:'organization_delivery'};
  const preview=await previewAuthenticatedDeliveryGrant(opsEnv,staff,operation);expect(preview.recipientCount).toBe(1);
  const created=await createAuthenticatedDeliveryGrant(opsEnv,staff,{...operation,expectedContextVersion:preview.contextVersion},'explicit-native-org-grant');
  const object=await bucket.put(folder+'organization.txt','organization synthetic file',{httpMetadata:{contentType:'text/plain'}});
  await db.prepare('INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)').bind(folder+'organization.txt',object!.etag,'organization synthetic file'.length,new Date().toISOString(),'text/plain','text').run();
  const base=`/v2/workspaces/${workspace}`,response=await request(base+'/deliveries');expect(response.status,await response.clone().text()).toBe(200);
  const items=(await response.json() as {items:Array<{id:string}>}).items;expect(items).toHaveLength(1);
  const opened=await request(base+'/folders/'+encodeURIComponent(items[0]!.id));expect(opened.status,await opened.clone().text()).toBe(200);
  const file=(await opened.json() as {files:Array<{id:string}>}).files[0]!;
  const downloaded=await request(base+'/files/'+encodeURIComponent(file.id)+'/download');expect(downloaded.status).toBe(200);expect(await downloaded.text()).toBe('organization synthetic file');
  expect(await db.prepare('SELECT COUNT(*) n FROM portal_native_staff_grants').first('n')).toBe(0);
  await revokeAuthenticatedDeliveryGrant(opsEnv,staff,created.grant.grantId,1,'cleanup','explicit-native-org-revoke');
  expect([403,404]).toContain((await request(base+'/files/'+encodeURIComponent(file.id)+'/download')).status);
 },180_000);

});
