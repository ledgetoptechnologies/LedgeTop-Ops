import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {ViewerServiceError} from '@ltds/shared';
import {sha256} from '../src/worker/crypto';
import type {Env,StaffPrincipal} from '../src/worker/types';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:vi.fn()})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,
 portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,decodeDirectViewerClientCursor,encodeDirectViewerClientCursor,readDirectViewerClientGrants,
 listDirectViewerClientGrantWorkspace} from '../src/worker/viewer-direct-client-grants';

// Synthetic data only.
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const instances:Miniflare[]=[];
type Member={identity?:string;identityRevoked?:boolean;membership?:string;membershipRevoked?:boolean;membershipExpiresAt?:string|null;verifiedEmail?:string};
type Client={id:string;source?:string;name:string;workspaceName?:string;rootType?:'organization'|'standalone_client';status?:string;
 emails?:Array<[string,string]|[string,string,Member]>};
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});
 mocks.proof.mockResolvedValue({sourceId:'project-alpha:primary'});mocks.guard.mockReturnValue({sql:'1=1',bindings:[]});
 mocks.catalog.mockResolvedValue({project:{id:'viewer-project'},tasks:[]});});
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.dispose()));});

async function fixture(clients:Client[],{principals=true}:{principals?:boolean}={}){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'picker'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 for(const statement of [
  `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
   root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
  `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
  `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
  `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
  `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
  `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
  `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`,
  `INSERT INTO pa_connectors VALUES('project-alpha:primary',1,'Division A'),('project-alpha:secondary',1,'Division B')`,
  ...(principals?[`CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,email_hint TEXT,display_name TEXT,status TEXT)`,
   `CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,verified_email TEXT,status TEXT,revoked_at TEXT)`,
   `CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT)`]:[]),
 ])await database.prepare(statement).run();
 for(const client of clients){
  const source=client.source??'project-alpha:primary',root=client.rootType??'standalone_client',publicId=`root-${client.id}`;
  await database.prepare(`INSERT INTO portal_v2_workspaces VALUES(?,?,NULL,?,?,?,?,?)`).bind(client.id,source,client.status??'active',client.workspaceName??client.name,root,
   root==='organization'?publicId:null,root==='organization'?null:publicId).run();
  await database.prepare(`INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)`).bind(client.id,source,`source-${client.id}`).run();
  await database.prepare(`INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,1)`).bind(client.id,`generation-${client.id}`).run();
  await database.prepare(`INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)`).bind(`generation-${client.id}`,client.id).run();
  await database.prepare(`INSERT INTO portal_v2_directory_entities VALUES(?,?,?,?,'v1',1,?)`).bind(client.id,`generation-${client.id}`,root,publicId,client.name).run();
  for(const [email,status,member={}] of client.emails??[]){
   await database.prepare(`INSERT INTO pa_portal_principals VALUES(?,?,?,?,?,?)`)
    .bind(client.id,`principal-${email}`,`identity-${email}`,email,'Contact',status).run();
   await database.prepare(`INSERT INTO portal_v2_identities VALUES(?,?,?,?)`).bind(`identity-${email}`,member.verifiedEmail??email,
    member.identity??'active',member.identityRevoked?'2026-01-01T00:00:00Z':null).run();
   await database.prepare(`INSERT INTO portal_v2_workspace_memberships VALUES(?,?,?,?,?,?)`).bind(`membership-${email}`,client.id,`identity-${email}`,
    member.membership??'active',member.membershipRevoked?'2026-01-01T00:00:00Z':null,member.membershipExpiresAt??null).run();
  }
 }
 const migration=readFileSync(new URL('../../client/migrations/0237_viewer_direct_client_grants.sql',import.meta.url),'utf8');
 await database.batch(splitD1MigrationStatements(migration).map(statement=>database.prepare(statement)));
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};
}
const list=(env:Env,query:Record<string,unknown>)=>listDirectViewerClientGrantWorkspace(env,principal,{include:'clients',...query});
async function every(env:Env,query:Record<string,unknown>){
 const seen:string[]=[];let cursor:string|null=null,pages=0;
 do{const page=await list(env,{...query,...(cursor?{cursor}:{})});seen.push(...page.clients.map(client=>client.workspaceId));cursor=page.clientsNextCursor;pages++;}
 while(cursor&&pages<100);
 return {seen,pages};
}

describe('direct Viewer client picker search',()=>{
 it('matches the client name, the business or organisation name, and an active member email, case-insensitively',async()=>{
  const {env}=await fixture([
   {id:'ws-name',name:'Harbor Survey Group'},
   {id:'ws-org',name:'Pat Example',workspaceName:'Lakeside Builders',rootType:'organization'},
   {id:'ws-email',name:'Quiet Client',emails:[['owner@lakes-mail.example','active']]},
   {id:'ws-old-email',name:'Former Client',emails:[['someone@retired.example','revoked']]},
  ]);
  expect((await list(env,{q:'HARBOR'})).clients.map(client=>client.workspaceId)).toEqual(['ws-name']);
  const org=(await list(env,{q:'lakeside'})).clients;
  expect(org).toEqual([{sourceId:'project-alpha:primary',workspaceId:'ws-org',displayName:'Pat Example',businessName:'Division A',
   rootType:'organization',organizationName:'Lakeside Builders'}]);
  const email=await list(env,{q:'Owner@Lakes-Mail'});
  expect(email.clients.map(client=>client.workspaceId)).toEqual(['ws-email']);
  // The email is matched, never returned.
  expect(JSON.stringify(email)).not.toContain('lakes-mail');
  expect((await list(env,{q:'retired.example'})).clients).toEqual([]);
 });
 it('matches an email only for a current member, using the Client Hub contact rules',async()=>{
  const {env}=await fixture([
   {id:'ws-current',name:'Current',emails:[['person@current.example','active']]},
   {id:'ws-verified',name:'Verified',emails:[['hint@other.example','active',{verifiedEmail:'login@verified.example'}]]},
   {id:'ws-revoked-member',name:'Revoked Member',emails:[['person@revoked-member.example','active',{membershipRevoked:true}]]},
   {id:'ws-inactive-member',name:'Inactive Member',emails:[['person@inactive-member.example','active',{membership:'suspended'}]]},
   {id:'ws-expired-member',name:'Expired Member',emails:[['person@expired-member.example','active',{membershipExpiresAt:'2001-01-01 00:00:00'}]]},
   {id:'ws-future-member',name:'Future Member',emails:[['person@future-member.example','active',{membershipExpiresAt:'2999-01-01 00:00:00'}]]},
   {id:'ws-revoked-identity',name:'Revoked Identity',emails:[['person@revoked-identity.example','active',{identityRevoked:true}]]},
   {id:'ws-disabled-identity',name:'Disabled Identity',emails:[['person@disabled-identity.example','active',{identity:'disabled'}]]},
   {id:'ws-closed',name:'Closed Workspace',status:'closed',emails:[['person@closed.example','active']]},
   {id:'ws-suspended',name:'Suspended Workspace',status:'suspended',emails:[['person@suspended.example','active']]},
  ]);
  const ids=async(q:string)=>(await list(env,{q})).clients.map(client=>client.workspaceId);
  expect(await ids('person@current')).toEqual(['ws-current']);
  expect(await ids('login@verified')).toEqual(['ws-verified']);
  expect(await ids('future-member.example')).toEqual(['ws-future-member']);
  for(const q of ['revoked-member.example','inactive-member.example','expired-member.example','revoked-identity.example',
   'disabled-identity.example','closed.example','suspended.example'])expect(await ids(q),q).toEqual([]);
  // Archived or closed workspaces never appear, whatever matches.
  expect(await ids('workspace')).toEqual([]);
  // A workspace name equal to the client name is not repeated as an organisation name.
  expect((await list(env,{q:'current'})).clients[0]).toMatchObject({organizationName:null,rootType:'standalone_client'});
 });
 it('still searches names when the principal table is unavailable',async()=>{
  const {env}=await fixture([{id:'ws-one',name:'Alpha Client'}],{principals:false});
  expect((await list(env,{q:'alpha'})).clients.map(client=>client.workspaceId)).toEqual(['ws-one']);
 });
 it('orders by name then a stable id and pages across ties with no duplicates or gaps',async()=>{
  const clients:Client[]=[
   {id:'ws-08',name:'zeta works'},{id:'ws-03',name:'Same Name'},{id:'ws-01',name:'same name',source:'project-alpha:secondary'},
   {id:'ws-07',name:'Same Name'},{id:'ws-02',name:'Alpha'},{id:'ws-05',name:'Same Name',source:'project-alpha:secondary'},
   {id:'ws-04',name:'beta'},{id:'ws-06',name:'Same Name'},{id:'ws-09',name:'Same Namf'}];
  const {env}=await fixture(clients);
  const expected=['ws-02','ws-04','ws-01','ws-03','ws-05','ws-06','ws-07','ws-09','ws-08'];
  for(const limit of [1,2,3,4,50]){
   const {seen,pages}=await every(env,{limit});
   expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(seen.length);
   expect(pages).toBe(Math.ceil(expected.length/limit));
  }
  const filtered=await every(env,{q:'same name',limit:2});
  expect(filtered.seen).toEqual(['ws-01','ws-03','ws-05','ws-06','ws-07']);
  // Same-named clients stay distinguishable by division.
  const page=(await list(env,{q:'same name',limit:2})).clients;
  expect(page.map(client=>client.businessName)).toEqual(['Division B','Division A']);
 });
 it('treats LIKE wildcards, quotes and backslashes in the query literally',async()=>{
  const {env}=await fixture([
   {id:'ws-pct',name:'100% Fill'},{id:'ws-pcx',name:'100X Fill'},{id:'ws-under',name:'a_b Ltd'},{id:'ws-axb',name:'axb Ltd'},
   {id:'ws-quote',name:"O'Neil Farms"},{id:'ws-slash',name:'Back\\slash Co'},
  ]);
  const ids=async(q:string)=>(await list(env,{q})).clients.map(client=>client.workspaceId);
  expect(await ids('%')).toEqual(['ws-pct']);
  expect(await ids('0% f')).toEqual(['ws-pct']);
  expect(await ids('_')).toEqual(['ws-under']);
  expect(await ids("o'n")).toEqual(['ws-quote']);
  expect(await ids('k\\s')).toEqual(['ws-slash']);
  expect(await ids("' OR 1=1 --")).toEqual([]);
 });
 it('rejects mixed or tampered cursors instead of guessing a position',async()=>{
  const {env}=await fixture([{id:'ws-one',name:'One'},{id:'ws-two',name:'Two'}]);
  await expect(list(env,{cursor:'ws-one'})).rejects.toMatchObject({status:400,code:'invalid_request'});
  await expect(listDirectViewerClientGrantWorkspace(env,principal,{cursor:encodeDirectViewerClientCursor('one','ws-one')}))
   .rejects.toMatchObject({status:400});
  await expect(list(env,{cursor:'v1.not-json'})).rejects.toMatchObject({status:400,code:'invalid_request'});
  expect(decodeDirectViewerClientCursor(encodeDirectViewerClientCursor('ünïcode name','ws-one'))).toEqual(['ünïcode name','ws-one']);
  // The legacy (no include) picker keeps its id order and id cursor for a not-yet-updated Viewer.
  const legacy=await listDirectViewerClientGrantWorkspace(env,principal,{limit:1});
  expect(legacy.clients).toEqual([{sourceId:'project-alpha:primary',workspaceId:'ws-one',displayName:'One',businessName:'Division A'}]);
  expect(legacy.clientsNextCursor).toBe('ws-one');
 });
});

describe('direct Viewer grant listing',()=>{
 async function seedGrants(database:D1Database,count:number){
  const now=new Date().toISOString();
  for(let start=0;start<count;start+=50)await database.batch(Array.from({length:Math.min(50,count-start)},(_,offset)=>{
   const index=start+offset;
   return database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
    can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,?,?,?,?,'task',0,1,0,0,NULL,1,'active','staff-one',?,?)`)
    .bind(`grant-${String(index).padStart(4,'0')}`,'project-alpha:primary',index%2?'ws-one':'ws-two','viewer-project',`task-${index}`,now,now);
  }));
 }
 it('pages more than 100 grants instead of failing, with no duplicates or gaps',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'},{id:'ws-two',name:'Two'}]);await seedGrants(database,250);
  const ids:string[]=[];let cursor:string|null=null,pages=0;
  do{const page=await listDirectViewerClientGrantWorkspace(env,principal,{include:'grants',viewerProjectId:'viewer-project',...(cursor?{grantsCursor:cursor}:{})});
   expect(page.clients).toEqual([]);expect(page.grants.length).toBeLessThanOrEqual(100);
   ids.push(...page.grants.map(grant=>grant.grantId));cursor=page.grantsNextCursor;pages++;}while(cursor);
  expect(pages).toBe(3);expect(ids).toHaveLength(250);expect(new Set(ids).size).toBe(250);
  expect(ids).toEqual([...ids].sort());
  // A caller that does not page (no include) keeps the old visible failure instead of a silently short list.
  await expect(listDirectViewerClientGrantWorkspace(env,principal,{})).rejects.toMatchObject({status:503,code:'grant_limit'});
  expect((await listDirectViewerClientGrantWorkspace(env,principal,{include:'all'})).grants).toHaveLength(100);
  const other=await listDirectViewerClientGrantWorkspace(env,principal,{include:'grants',viewerProjectId:'other-project'});
  expect(other).toMatchObject({grants:[],grantsNextCursor:null});
 });
 it('holds the per-client limit when another share lands between the count and the insert',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'},{id:'ws-two',name:'Two'}]);await seedGrants(database,198);// 99 per client
  const now=new Date().toISOString();let raced=false;
  const countSql=/SELECT count\(\*\) n FROM viewer_direct_client_grants WHERE source_id=\? AND workspace_id=\? AND status='active'/;
  const racing={prepare(sql:string){const statement=database.prepare(sql);
   if(!countSql.test(sql)||raced)return statement;
   return {bind:(...values:unknown[])=>{const bound=statement.bind(...values);return {first:async(column:string)=>{const value=await bound.first(column);raced=true;
    // A concurrent create commits after this request counted 99.
    await database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
     can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
     VALUES('grant-race','project-alpha:primary','ws-one','viewer-project','task-race','task',0,1,0,0,NULL,1,'active','staff-two',?,?)`).bind(now,now).run();
    return value;}};}};},
   batch:(statements:D1PreparedStatement[])=>database.batch(statements)};
  const raceEnv={...env,DELIVERY_DB:{withSession:()=>racing}} as unknown as Env;
  await expect(createDirectViewerClientGrant({env:raceEnv,principal,idempotencyKey:'picker-limit-race-00001',request:new Request('https://ops.example.test/'),
   grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:'viewer-project',taskId:null,scopeType:'project',
    includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}}}))
   .rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(raced).toBe(true);
  expect(await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants WHERE workspace_id='ws-one' AND status='active'`).first<number>('n')).toBe(100);
  for(const table of ['viewer_direct_client_grant_mutation_receipts','viewer_direct_client_grant_audit'])
   expect(await database.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n')).toBe(0);
 });
 it('keeps the per-client limit of 100 active shares on create',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'},{id:'ws-two',name:'Two'}]);await seedGrants(database,200);
  await expect(createDirectViewerClientGrant({env,principal,idempotencyKey:'picker-limit-check-0001',request:new Request('https://ops.example.test/'),
   grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:'viewer-project',taskId:null,scopeType:'project',
    includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}}}))
   .rejects.toMatchObject({status:409,code:'grant_limit'});
 });

 // The cap counts effective grants: the same active, unrevoked, unexpired rows the client portal reads.
 const PAST='2020-01-01T00:00:00.000Z',FUTURE='2099-01-01T00:00:00.000Z';
 async function seedClientGrants(database:D1Database,workspaceId:string,prefix:string,count:number,expiresAt:string|null){
  const now=new Date().toISOString();
  for(let start=0;start<count;start+=50)await database.batch(Array.from({length:Math.min(50,count-start)},(_,offset)=>
   database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
    can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,'project-alpha:primary',?,?,NULL,'project',1,1,0,0,?,1,'active','staff-one',?,?)`)
    .bind(`${prefix}-${String(start+offset).padStart(4,'0')}`,workspaceId,`${prefix}-project-${start+offset}`,expiresAt,now,now)));
 }
 const createFor=(env:Env,idempotencyKey:string,viewerProjectId='viewer-project')=>createDirectViewerClientGrant({env,principal,idempotencyKey,
  request:new Request('https://ops.example.test/'),grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId,taskId:null,scopeType:'project',
   includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}}});
 const effective=(database:D1Database)=>database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants WHERE workspace_id='ws-one'
  AND status='active' AND revoked_at IS NULL AND (authorization_expires_at IS NULL OR datetime(authorization_expires_at)>datetime('now'))`).first<number>('n');
 it('does not count expired grants toward the per-client limit',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedClientGrants(database,'ws-one','expired',100,PAST);
  expect(await effective(database)).toBe(0);
  const created=await createFor(env,'picker-expired-cap-00001');
  expect(created.replayed).toBe(false);expect(await effective(database)).toBe(1);
 });
 it('still blocks at exactly 100 effective grants, whether or not expired grants are present',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  await seedClientGrants(database,'ws-one','live',99,FUTURE);await seedClientGrants(database,'ws-one','open',1,null);
  await seedClientGrants(database,'ws-one','expired',20,PAST);expect(await effective(database)).toBe(100);
  await expect(createFor(env,'picker-effective-cap-0001')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(await effective(database)).toBe(100);
  for(const table of ['viewer_direct_client_grant_mutation_receipts','viewer_direct_client_grant_audit'])
   expect(await database.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n')).toBe(0);
 });
 it('lets the insert guard and the post-write diagnosis ignore an expired grant that lands after the count',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedClientGrants(database,'ws-one','live',99,FUTURE);
  const now=new Date().toISOString();let raced=false;
  const countSql=/SELECT count\(\*\) n FROM viewer_direct_client_grants WHERE source_id=\? AND workspace_id=\? AND status='active'/;
  const racing={prepare(sql:string){const statement=database.prepare(sql);
   if(!countSql.test(sql)||raced)return statement;
   return {bind:(...values:unknown[])=>{const bound=statement.bind(...values);return {first:async(column:string)=>{const value=await bound.first(column);raced=true;
    // An already-expired row commits after this request counted 99 effective grants.
    await database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
     can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
     VALUES('grant-expired-race','project-alpha:primary','ws-one','expired-race-project',NULL,'project',1,1,0,0,?,1,'active','staff-two',?,?)`).bind(PAST,now,now).run();
    return value;}};}};},
   batch:(statements:D1PreparedStatement[])=>database.batch(statements)};
  const raceEnv={...env,DELIVERY_DB:{withSession:()=>racing}} as unknown as Env;
  const created=await createFor(raceEnv,'picker-expired-race-0001');
  expect(raced).toBe(true);expect(created.replayed).toBe(false);expect(await effective(database)).toBe(100);
 });
 it('replays a create unchanged, even once the client is at the limit',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedClientGrants(database,'ws-one','expired',100,PAST);
  const first=await createFor(env,'picker-replay-cap-000001');expect(first.replayed).toBe(false);
  await seedClientGrants(database,'ws-one','live',99,FUTURE);expect(await effective(database)).toBe(100);
  const again=await createFor(env,'picker-replay-cap-000001');
  expect(again).toEqual({grant:first.grant,replayed:true});expect(await effective(database)).toBe(100);
  mocks.catalog.mockResolvedValueOnce({project:{id:'another-project'},tasks:[]});
  await expect(createFor(env,'picker-replay-cap-000002','another-project')).rejects.toMatchObject({status:409,code:'grant_limit'});
  // Same-scope uniqueness is unchanged: an active row for the same scope still answers duplicate_active_grant.
  await expect(createFor(env,'picker-replay-cap-000003')).rejects.toMatchObject({status:409,code:'duplicate_active_grant'});
 });
});

// Grants with a selection keep the fail-closed 1970 sentinel on the row; their real lifetime is
// in the single v2 or v3 creation receipt. The cap counts them only while that receipt matches and is unexpired.
describe('direct Viewer per-client cap with restricted grants',()=>{
 const PAST='2020-01-01T00:00:00.000Z',FUTURE='2099-01-01T00:00:00.000Z',SENTINEL='1970-01-01T00:00:00.000Z';
 type Receipt='v3'|'v3-except'|'v3-unsorted'|'v3-extra'|'v3-mixed'|'v2-selection'|'v3-exclusions'|'v3-no-selection'|'v3-bad-mode'|'live'|'live-no-expiry'|'expired'|'missing'|'duplicate'|'wrong-version'|'wrong-workspace'|'wrong-permissions'|'v1';
 let receiptSequence=0;
 function envelope(id:string,viewerProjectId:string,expiresAt:string|null,kind:Receipt){
  const now=new Date().toISOString();
  const grant={grantId:id,sourceId:'project-alpha:primary',workspaceId:kind==='wrong-workspace'?'ws-other':'ws-one',viewerProjectId,taskId:null,
   scopeType:'project',includeFuturePublished:true,permissions:{measure:true,cameras:false,download:kind==='wrong-permissions'},expiresAt,
   grantVersion:kind==='wrong-version'?2:1,revokedAt:null,createdAt:now,clientDisplayName:'One'};
  const pin={version:1,mode:'native_source',sourceId:'project-alpha:primary',workspaceId:'ws-one',sourceWorkspaceId:'source-ws-one',
   rootType:'standalone_client',rootPublicId:'root-ws-one'};
  const one='00000000-0000-4000-8000-000000000001',two='00000000-0000-4000-8000-000000000002';
  const exclusions={version:1,folderIds:[],taskIds:[one]},only={version:1,mode:'only',folderIds:[one],taskIds:[two]};
  const shapes:Record<string,unknown>={'v3':{selection:only},'v3-except':{selection:{...only,mode:'except'}},'v3-unsorted':{selection:{...only,folderIds:[two,one]}},
   'v3-extra':{selection:only,note:'x'},'v3-mixed':{selection:only,exclusions},'v3-exclusions':{exclusions},'v3-no-selection':{},'v3-bad-mode':{selection:{...only,mode:'all'}}};
  if(kind in shapes)return {version:3,grant,recipientAuthorityPin:pin,...shapes[kind] as object};
  if(kind==='v2-selection')return {version:2,grant,recipientAuthorityPin:pin,selection:only};
  return kind==='v1'?{version:1,grant,recipientAuthorityPin:pin}
   :{version:2,grant,recipientAuthorityPin:pin,exclusions:{version:1,folderIds:[],taskIds:['00000000-0000-4000-8000-000000000001']}};
 }
 async function seedRestricted(database:D1Database,prefix:string,count:number,kind:Receipt,expiry?:string){
  const now=new Date().toISOString();let statements:D1PreparedStatement[]=[];
  for(let index=0;index<count;index++){
   const id=`${prefix}-${String(index).padStart(4,'0')}`,project=`${prefix}-project-${index}`;
   const expiresAt=expiry??(kind==='expired'?PAST:kind==='live-no-expiry'?null:FUTURE);
   statements.push(database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
    can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,'project-alpha:primary','ws-one',?,NULL,'project',1,1,0,0,?,1,'active','staff-one',?,?)`).bind(id,project,SENTINEL,now,now));
   const receipts=kind==='missing'?0:kind==='duplicate'?2:1;
   for(let copy=0;copy<receipts;copy++)statements.push(database.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts
    (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json,created_at) VALUES('staff-one',?,'grant.create','fingerprint',?,?,?)`)
    .bind(`restricted-receipt-${++receiptSequence}`,id,JSON.stringify(envelope(id,project,expiresAt,kind)),now));
   // Seed in batches: one D1 round trip per row is too slow for 100-row fixtures.
   if(statements.length>=100||index===count-1){await database.batch(statements);statements=[];}
  }
 }
 async function seedOrdinary(database:D1Database,prefix:string,count:number,expiresAt:string|null){
  const now=new Date().toISOString();
  if(count>0)await database.batch(Array.from({length:count},(_,index)=>database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
   can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
   VALUES(?,'project-alpha:primary','ws-one',?,NULL,'project',1,1,0,0,?,1,'active','staff-one',?,?)`)
   .bind(`${prefix}-${String(index).padStart(4,'0')}`,`${prefix}-project-${index}`,expiresAt,now,now)));
 }
 const createFor=(env:Env,idempotencyKey:string,viewerProjectId='viewer-project')=>createDirectViewerClientGrant({env,principal,idempotencyKey,
  request:new Request('https://ops.example.test/'),grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId,taskId:null,scopeType:'project',
   includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}}});
 const issuable=async(env:Env)=>(await readDirectViewerClientGrants(env,{sourceId:'project-alpha:primary',workspaceId:'ws-one'})).map(row=>row.id).sort();
 const counts=async(database:D1Database)=>({
  grants:await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants`).first<number>('n'),
  receipts:await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grant_mutation_receipts`).first<number>('n'),
  audit:await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grant_audit`).first<number>('n')});
 const countSql=/SELECT count\(\*\) n FROM viewer_direct_client_grants WHERE source_id=\? AND workspace_id=\? AND status='active'/;
 // A restricted grant (with its receipt) commits after this request has run the precheck count.
 function racingEnv(env:Env,database:D1Database,land:()=>Promise<void>){
  const state={raced:false};
  const racing={prepare(sql:string){const statement=database.prepare(sql);
   if(!countSql.test(sql)||state.raced)return statement;
   return {bind:(...values:unknown[])=>{const bound=statement.bind(...values);return {first:async(column:string)=>{const value=await bound.first(column);
    state.raced=true;await land();return value;}};}};},
   batch:(statements:D1PreparedStatement[])=>database.batch(statements)};
  return {state,env:{...env,DELIVERY_DB:{withSession:()=>racing}} as unknown as Env};
 }

 it('does not count 100 restricted grants whose receipt lifetime has expired, and does not issue them',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedRestricted(database,'restricted-expired',100,'expired');
  expect(await issuable(env)).toEqual([]);
  const created=await createFor(env,'restricted-expired-cap-01');
  expect(created.replayed).toBe(false);expect(await issuable(env)).toEqual([created.grant.grantId]);
 },120_000);
 it('refuses at 100 live restricted grants with no writes, and still issues them',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  await seedRestricted(database,'restricted-live',99,'live');await seedRestricted(database,'restricted-open',1,'live-no-expiry');
  expect(await issuable(env)).toHaveLength(100);
  const before=await counts(database);
  await expect(createFor(env,'restricted-live-cap-00001')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(await counts(database)).toEqual(before);
 },120_000);
 it('neither counts nor issues restricted grants with a missing, duplicated or mismatched receipt',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  for(const kind of ['missing','duplicate','wrong-version','wrong-workspace','wrong-permissions','v1'] as const)
   await seedRestricted(database,`restricted-${kind}`,20,kind);
  expect(await issuable(env)).toEqual([]);
  const created=await createFor(env,'restricted-invalid-cap-01');
  expect(created.replayed).toBe(false);expect(await issuable(env)).toEqual([created.grant.grantId]);
 },120_000);
 it('holds the boundary across ordinary and restricted grants together',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  await seedOrdinary(database,'ordinary-live',50,FUTURE);await seedOrdinary(database,'ordinary-open',9,null);
  await seedOrdinary(database,'ordinary-expired',15,PAST);
  await seedRestricted(database,'restricted-live',40,'live');await seedRestricted(database,'restricted-expired',15,'expired');
  await seedRestricted(database,'restricted-bad',10,'wrong-version');
  expect(await issuable(env)).toHaveLength(99);
  const created=await createFor(env,'mixed-boundary-cap-00001');expect(created.replayed).toBe(false);
  expect(await issuable(env)).toHaveLength(100);
  mocks.catalog.mockResolvedValueOnce({project:{id:'another-project'},tasks:[]});
  const before=await counts(database);
  await expect(createFor(env,'mixed-boundary-cap-00002','another-project')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(await counts(database)).toEqual(before);
 },120_000);
 it('counts a live restricted grant inside the INSERT when it lands after the precheck',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedRestricted(database,'restricted-live',99,'live');
  const before=await counts(database);
  const race=racingEnv(env,database,()=>seedRestricted(database,'restricted-race',1,'live'));
  await expect(createFor(race.env,'restricted-race-cap-00001')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(race.state.raced).toBe(true);
  // Only the racing grant and its receipt were written; this request wrote nothing.
  expect(await counts(database)).toEqual({grants:before.grants!+1,receipts:before.receipts!+1,audit:before.audit});
 },120_000);
 // Expiries with an offset. The create schema accepts ±HH:MM up to ±23:59; SQLite's parser rejects offsets above
 // 14 hours, so storage is canonical UTC and older stored offsets are applied by hand on read.
 const OFFSET_FUTURE='2099-01-01T00:00:00+15:00',OFFSET_FUTURE_UTC='2098-12-31T09:00:00.000Z';
 const OFFSET_FAR='2099-01-01T00:00:00-23:59',OFFSET_FAR_UTC='2099-01-01T23:59:00.000Z';
 const selection={version:1 as const,mode:'except' as const,folderIds:[],taskIds:['00000000-0000-4000-8000-000000000002']};
 const createWith=(env:Env,idempotencyKey:string,viewerProjectId:string,expiresAt:string|null,restricted:boolean)=>createDirectViewerClientGrant({env,principal,
  idempotencyKey,request:new Request('https://ops.example.test/'),grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId,taskId:null,
   scopeType:'project',includeFuturePublished:true,confirmedScope:true,expiresAt,permissions:{measure:true,cameras:false,download:false},
   ...(restricted?{selection}:{})}});
 const issuableExpiry=async(env:Env)=>Object.fromEntries((await readDirectViewerClientGrants(env,{sourceId:'project-alpha:primary',workspaceId:'ws-one'}))
  .map(row=>[row.id,row.authorization_expires_at]));
 it('stores a non-UTC offset expiry as canonical UTC, and list, mint selection, replay and the cap agree on it',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedRestricted(database,'restricted-live',98,'live');
  mocks.catalog.mockResolvedValueOnce({project:{id:'offset-restricted'},tasks:[]});
  const restricted=await createWith(env,'offset-restricted-key-01','offset-restricted',OFFSET_FUTURE,true);
  mocks.catalog.mockResolvedValueOnce({project:{id:'offset-ordinary'},tasks:[]});
  const ordinary=await createWith(env,'offset-ordinary-key-0001','offset-ordinary',OFFSET_FAR,false);
  expect(restricted.grant.expiresAt).toBe(OFFSET_FUTURE_UTC);expect(ordinary.grant.expiresAt).toBe(OFFSET_FAR_UTC);
  const stored=await database.prepare(`SELECT id,authorization_expires_at expiry FROM viewer_direct_client_grants WHERE id IN (?,?)`)
   .bind(restricted.grant.grantId,ordinary.grant.grantId).all<{id:string;expiry:string}>();
  expect(Object.fromEntries(stored.results.map(row=>[row.id,row.expiry]))).toEqual({[restricted.grant.grantId]:SENTINEL,[ordinary.grant.grantId]:OFFSET_FAR_UTC});
  const receipt=await database.prepare(`SELECT json_extract(response_json,'$.grant.expiresAt') expiry FROM viewer_direct_client_grant_mutation_receipts WHERE grant_id=?`)
   .bind(restricted.grant.grantId).first<string>('expiry');
  expect(receipt).toBe(OFFSET_FUTURE_UTC);
  // Mint selection (the issuer's read) and the staff listing both see the canonical instant.
  const selected=await issuableExpiry(env);
  expect(Object.keys(selected)).toHaveLength(100);
  expect(selected[restricted.grant.grantId]).toBe(OFFSET_FUTURE_UTC);expect(selected[ordinary.grant.grantId]).toBe(OFFSET_FAR_UTC);
  const listed=(await listDirectViewerClientGrantWorkspace(env,principal,{include:'grants'})).grants;
  expect(listed.find(grant=>grant.grantId===restricted.grant.grantId)?.expiresAt).toBe(OFFSET_FUTURE_UTC);
  expect(listed.find(grant=>grant.grantId===ordinary.grant.grantId)?.expiresAt).toBe(OFFSET_FAR_UTC);
  // The same request replays to the same stored grant.
  expect(await createWith(env,'offset-restricted-key-01','offset-restricted',OFFSET_FUTURE,true)).toEqual({grant:restricted.grant,replayed:true});
  expect(await createWith(env,'offset-ordinary-key-0001','offset-ordinary',OFFSET_FAR,false)).toEqual({grant:ordinary.grant,replayed:true});
  // Both count: the client is now at 100.
  const before=await counts(database);
  mocks.catalog.mockResolvedValueOnce({project:{id:'another-project'},tasks:[]});
  await expect(createFor(env,'offset-cap-key-00000001','another-project')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(await counts(database)).toEqual(before);
 },120_000);
 it('counts and issues legacy receipts and rows stored with a large offset, and drops past or unparseable ones',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  await seedRestricted(database,'legacy-offset',97,'live',OFFSET_FUTURE);
  await seedRestricted(database,'legacy-offset-past',5,'live','2020-01-01T00:00:00-23:59');
  await seedRestricted(database,'legacy-no-suffix',5,'live','2099-01-01T00:00:00');
  await seedRestricted(database,'legacy-garbage',5,'live','not-a-date');
  await seedOrdinary(database,'ordinary-offset',2,OFFSET_FAR);
  await seedOrdinary(database,'ordinary-offset-past',5,'2020-01-01T00:00:00+15:00');
  const selected=await issuableExpiry(env);
  expect(Object.keys(selected)).toHaveLength(99);
  expect(new Set(Object.entries(selected).map(([id,expiry])=>id.startsWith('legacy-offset-')?expiry:null))).toEqual(new Set([OFFSET_FUTURE_UTC,null]));
  const created=await createFor(env,'legacy-offset-cap-000001');expect(created.replayed).toBe(false);
  expect(Object.keys(await issuableExpiry(env))).toHaveLength(100);
  mocks.catalog.mockResolvedValueOnce({project:{id:'another-project'},tasks:[]});
  const before=await counts(database);
  await expect(createFor(env,'legacy-offset-cap-000002','another-project')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(await counts(database)).toEqual(before);
 },120_000);
 it('counts a legacy large-offset restricted grant inside the INSERT and the diagnosis when it lands after the precheck',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedRestricted(database,'legacy-offset',99,'live',OFFSET_FUTURE);
  const before=await counts(database);
  const race=racingEnv(env,database,()=>seedRestricted(database,'legacy-offset-race',1,'live',OFFSET_FUTURE));
  await expect(createFor(race.env,'legacy-offset-race-00001')).rejects.toMatchObject({status:409,code:'grant_limit'});
  expect(race.state.raced).toBe(true);
  expect(await counts(database)).toEqual({grants:before.grants!+1,receipts:before.receipts!+1,audit:before.audit});
 },120_000);
 // Year-9999 boundary: 9999-12-31T23:59:59-01:00 passes the create schema, but its UTC instant is in year
 // 10000, which has no YYYY form for the issuer schema or SQLite. It is refused before any write.
 const BEYOND='9999-12-31T23:59:59-01:00',LARGEST='9999-12-31T23:59:59.999Z';
 const ledger=async(database:D1Database)=>({...await counts(database),
  revocations:await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grant_revocations`).first<number>('n')});
 it('refuses an expiry whose UTC instant is beyond year 9999 with no writes, restricted or not',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  const before=await ledger(database);
  for(const restricted of [false,true])
   await expect(createWith(env,`beyond-9999-key-${restricted?'r':'o'}0001`,'viewer-project',BEYOND,restricted))
    .rejects.toMatchObject({status:400,code:'expired_at_invalid'});
  expect(mocks.catalog).not.toHaveBeenCalled();
  expect(await ledger(database)).toEqual(before);
 },120_000);
 it('accepts the largest representable expiry and stores it in a form the issuer schema and SQLite both read',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  const ordinary=await createWith(env,'largest-expiry-key-o0001','viewer-project',LARGEST,false);
  mocks.catalog.mockResolvedValueOnce({project:{id:'largest-restricted'},tasks:[]});
  const restricted=await createWith(env,'largest-expiry-key-r0001','largest-restricted','9999-12-31T23:59:59Z',true);
  expect(ordinary.grant.expiresAt).toBe(LARGEST);expect(restricted.grant.expiresAt).toBe('9999-12-31T23:59:59.000Z');
  for(const value of [ordinary.grant.expiresAt,restricted.grant.expiresAt]){
   expect(value).toMatch(/^\d{4}-\d\d-\d\dT/);
   expect(await database.prepare(`SELECT julianday(?) IS NOT NULL ok`).bind(value).first<number>('ok')).toBe(1);
  }
  expect(await issuableExpiry(env)).toEqual({[ordinary.grant.grantId]:LARGEST,[restricted.grant.grantId]:'9999-12-31T23:59:59.000Z'});
  expect(await createWith(env,'largest-expiry-key-o0001','viewer-project',LARGEST,false)).toEqual({grant:ordinary.grant,replayed:true});
 },120_000);
 it('still replays a grant committed with that expiry before the range check, with no new writes',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  // A pre-pin receipt, as an earlier build stored it: the raw public result with the request's original expiry.
  const request={sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:'viewer-project',taskId:null,scopeType:'project' as const,
   includeFuturePublished:true,confirmedScope:true as const,expiresAt:BEYOND,permissions:{measure:true,cameras:false,download:false}};
  const id='committed-beyond-9999',now=new Date().toISOString();
  const committed={grantId:id,sourceId:request.sourceId,workspaceId:'ws-one',viewerProjectId:'viewer-project',taskId:null,scopeType:'project',
   includeFuturePublished:true,permissions:request.permissions,expiresAt:BEYOND,grantVersion:1,revokedAt:null,createdAt:now,clientDisplayName:'One'};
  await database.batch([
   database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
    can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,'project-alpha:primary','ws-one','viewer-project',NULL,'project',1,1,0,0,?,1,'active','staff-one',?,?)`).bind(id,BEYOND,now,now),
   database.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts(actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json,created_at)
    VALUES('staff-one','committed-beyond-key-001','grant.create',?,?,?,?)`)
    .bind(await sha256(JSON.stringify(['direct.create',request])),id,JSON.stringify(committed),now)]);
  const before=await ledger(database);
  expect(await createDirectViewerClientGrant({env,principal,idempotencyKey:'committed-beyond-key-001',request:new Request('https://ops.example.test/'),grant:request}))
   .toEqual({grant:committed,replayed:true});
  expect(await ledger(database)).toEqual(before);
  // A new key with the same body is a new create, and is refused.
  await expect(createDirectViewerClientGrant({env,principal,idempotencyKey:'committed-beyond-key-002',request:new Request('https://ops.example.test/'),grant:request}))
   .rejects.toMatchObject({status:400,code:'expired_at_invalid'});
  expect(await ledger(database)).toEqual(before);
 },120_000);
 it('ignores an expired restricted grant inside the INSERT when it lands after the precheck',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);await seedRestricted(database,'restricted-live',99,'live');
  const race=racingEnv(env,database,()=>seedRestricted(database,'restricted-race-expired',1,'expired'));
  const created=await createFor(race.env,'restricted-race-cap-00002');
  expect(race.state.raced).toBe(true);expect(created.replayed).toBe(false);expect(await issuable(env)).toHaveLength(100);
 },120_000);
});
describe('direct Viewer selections in receipts',()=>{
 const SENTINEL='1970-01-01T00:00:00.000Z',one='00000000-0000-4000-8000-000000000001',two='00000000-0000-4000-8000-000000000002';
 const pin={version:1,mode:'native_source',sourceId:'project-alpha:primary',workspaceId:'ws-one',sourceWorkspaceId:'source-ws-one',rootType:'standalone_client',rootPublicId:'root-ws-one'};
 const only={version:1,mode:'only',folderIds:[one],taskIds:[two]},exclusions={version:1,folderIds:[one],taskIds:[]};
 const read=(env:Env)=>readDirectViewerClientGrants(env,{sourceId:'project-alpha:primary',workspaceId:'ws-one'});
 async function seed(database:D1Database,id:string,expiry:string|null,receipt:((grant:object)=>unknown)|null,scope:'project'|'task'='project'){
  const now=new Date().toISOString(),task=scope==='task'?'viewer-task':null;
  const grant={grantId:id,sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:`project-${id}`,taskId:task,scopeType:scope,includeFuturePublished:scope==='project',
   permissions:{measure:true,cameras:false,download:false},expiresAt:null,grantVersion:1,revokedAt:null,createdAt:now,clientDisplayName:'One'};
  await database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
   can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
   VALUES(?,'project-alpha:primary','ws-one',?,?,?,?,1,0,0,?,1,'active','staff-one',?,?)`).bind(id,grant.viewerProjectId,task,scope,scope==='project'?1:0,expiry,now,now).run();
  if(receipt)await database.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts VALUES('staff-one',?,'grant.create','fingerprint',?,?,?)`)
   .bind(`selection-${id}`,id,JSON.stringify(receipt(grant)),now).run();
 }
 it('reads v2 as except, reads and writes v3, and refuses every mixed or malformed shape, on both sides of the sentinel',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  const envelope=(version:number,extra:object)=>(grant:object)=>({version,grant,recipientAuthorityPin:pin,...extra});
  await seed(database,'a-v2',SENTINEL,envelope(2,{exclusions}));
  await seed(database,'b-v3-only',SENTINEL,envelope(3,{selection:only}));
  await seed(database,'c-v3-except',SENTINEL,envelope(3,{selection:{...only,mode:'except'}}));
  await seed(database,'d-plain-raw',null,grant=>grant);
  await seed(database,'e-plain-v1',null,envelope(1,{}));
  await seed(database,'f-task',null,envelope(1,{}),'task');
  await seed(database,'g-plain-none',null,null);
  const refused:Array<[string,string|null,((grant:object)=>unknown)|null]>=[
   ['r-v2-selection',SENTINEL,envelope(2,{selection:only})],['r-v3-exclusions',SENTINEL,envelope(3,{exclusions})],
   ['r-v3-both',SENTINEL,envelope(3,{selection:only,exclusions})],['r-v2-both',SENTINEL,envelope(2,{selection:only,exclusions})],
   ['r-v3-neither',SENTINEL,envelope(3,{})],['r-v2-neither',SENTINEL,envelope(2,{})],['r-v3-extra',SENTINEL,envelope(3,{selection:only,note:'x'})],
   ['r-v3-unsorted',SENTINEL,envelope(3,{selection:{...only,folderIds:[two,one]}})],['r-v3-mode',SENTINEL,envelope(3,{selection:{...only,mode:'all'}})],
   ['r-v3-empty',SENTINEL,envelope(3,{selection:{...only,folderIds:[],taskIds:[]}})],['r-v4',SENTINEL,envelope(4,{selection:only})],
   ['r-sentinel-v1',SENTINEL,envelope(1,{})],['r-sentinel-raw',SENTINEL,grant=>grant],['r-sentinel-none',SENTINEL,null],
   ['r-open-v2',null,envelope(2,{exclusions})],['r-open-v3',null,envelope(3,{selection:only})],['r-open-keys',null,grant=>({...grant,selection:only})],
   ['r-dated-v3','2099-01-01T00:00:00.000Z',envelope(3,{selection:only})]];
  for(const [id,expiry,receipt] of refused)await seed(database,id,expiry,receipt);
  const rows=await read(env);
  expect(Object.fromEntries(rows.map(row=>[row.id,row.selection??null]))).toEqual({'a-v2':{...exclusions,mode:'except'},'b-v3-only':only,
   'c-v3-except':{...only,mode:'except'},'d-plain-raw':null,'e-plain-v1':null,'f-task':null,'g-plain-none':null});
  // Staff see the selection of the shares that have one; refused rows are listed as ended, never as a whole project.
  const listed=(await listDirectViewerClientGrantWorkspace(env,principal,{include:'grants'})).grants;
  const by=Object.fromEntries(listed.map(grant=>[grant.grantId,grant]));
  expect(by['b-v3-only']).toMatchObject({selection:only,expiresAt:null});expect(by['a-v2']).toMatchObject({selection:{...exclusions,mode:'except'}});
  expect(by['d-plain-raw']).not.toHaveProperty('selection');
  for(const [id] of refused){expect(by[id]).not.toHaveProperty('selection');}
  for(const id of ['r-v3-both','r-sentinel-v1'])expect(by[id]!.expiresAt).toBe(SENTINEL);
  for(const id of ['r-open-v2','r-open-v3','r-open-keys','r-dated-v3'])expect(Date.parse(by[id]!.expiresAt!)).toBeLessThan(Date.now());
 },120_000);
 it('writes v3 with the sentinel, replays only the same selection, and reports what the Viewer refused',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);
  const create=(key:string,selection:unknown,project='viewer-project')=>createDirectViewerClientGrant({env,principal,idempotencyKey:key,request:new Request('https://ops.example.test/'),
   grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:project,taskId:null,scopeType:'project',includeFuturePublished:true,confirmedScope:true,
    expiresAt:null,permissions:{measure:true,cameras:false,download:false},...(selection===undefined?{}:{selection})}});
  mocks.catalog.mockResolvedValueOnce({project:{id:'viewer-project'},tasks:[]});
  const created=await create('selection-create-00001',only);
  expect(mocks.catalog).toHaveBeenLastCalledWith({projectId:'viewer-project',selection:only,validateSelection:true});
  const row=await database.prepare('SELECT authorization_expires_at expiry,scope_type scope,include_future_published future FROM viewer_direct_client_grants WHERE id=?').bind(created.grant.grantId).first();
  expect(row).toEqual({expiry:SENTINEL,scope:'project',future:1});
  const stored=JSON.parse((await database.prepare('SELECT response_json FROM viewer_direct_client_grant_mutation_receipts WHERE grant_id=?').bind(created.grant.grantId).first<string>('response_json'))!);
  expect(Object.keys(stored).sort()).toEqual(['grant','recipientAuthorityPin','selection','version']);expect(stored.version).toBe(3);expect(stored.selection).toEqual(only);
  expect((await read(env)).map(item=>item.selection)).toEqual([only]);
  expect(await create('selection-create-00001',only)).toEqual({grant:created.grant,replayed:true});
  await expect(create('selection-create-00001',{...only,mode:'except'})).rejects.toMatchObject({code:'idempotency_conflict'});
  for(const broken of [{...only,mode:'all'},{...only,folderIds:[two,one]},{...only,folderIds:[one,one]},{...only,folderIds:[],taskIds:[]},{...only,extra:1},{...exclusions}])
   await expect(create('selection-broken-00001',broken,'another-project')).rejects.toMatchObject({status:400});
  mocks.catalog.mockRejectedValueOnce(new ViewerServiceError('old','unsupported'));
  await expect(create('selection-unsupported-1',only,'another-project')).rejects.toMatchObject({status:409,code:'selection_unsupported'});
  mocks.catalog.mockRejectedValueOnce(new ViewerServiceError('gone','not_found',404));
  await expect(create('selection-elsewhere-01',only,'another-project')).rejects.toMatchObject({status:409,code:'selection_not_in_project'});
  expect(await database.prepare('SELECT count(*) n FROM viewer_direct_client_grants').first<number>('n')).toBe(1);
 },120_000);
});

describe('direct Viewer picker authorization is unchanged',()=>{
 for(const include of [undefined,'all','clients','grants'] as const)
  for(const denied of ['viewer.view','viewer.manage'] as const)for(const kind of ['not-global','denied-global'] as const)
   it(`a caller without global ${denied} (${kind}) cannot list with include=${include??'none'}`,async()=>{
    const {env}=await fixture([{id:'ws-one',name:'One',emails:[['person@example.test','active']]}]);
    mocks.scope.mockImplementation(async(_env:Env,_principal:StaffPrincipal,permission:string)=>permission===denied
     ?{global:kind!=='not-global',deniedGlobal:kind==='denied-global'}:{global:true,deniedGlobal:false});
    await expect(listDirectViewerClientGrantWorkspace(env,principal,{...(include?{include}:{}),q:'person@'}))
     .rejects.toMatchObject({status:403,code:'forbidden'});
   });
 it('a caller without global management still cannot create a share',async()=>{
  const {env,database}=await fixture([{id:'ws-one',name:'One'}]);mocks.scope.mockResolvedValue({global:false,deniedGlobal:false});
  await expect(createDirectViewerClientGrant({env,principal,idempotencyKey:'picker-auth-check-00001',request:new Request('https://ops.example.test/'),
   grant:{sourceId:'project-alpha:primary',workspaceId:'ws-one',viewerProjectId:'viewer-project',taskId:null,scopeType:'project',
    includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}}}))
   .rejects.toMatchObject({status:403});
  expect(await database.prepare('SELECT count(*) n FROM viewer_direct_client_grants').first<number>('n')).toBe(0);
 });
 it('omits clients whose source authority is not ready, exactly as before',async()=>{
  const {env}=await fixture([{id:'ws-one',name:'One'},{id:'ws-two',name:'Two',source:'project-alpha:secondary'}]);
  mocks.proof.mockImplementation(async(_env:Env,_db:unknown,sourceId:string)=>sourceId==='project-alpha:primary'?{sourceId}:null);
  const {seen}=await every(env,{limit:1});expect(seen).toEqual(['ws-one']);
 });
});
