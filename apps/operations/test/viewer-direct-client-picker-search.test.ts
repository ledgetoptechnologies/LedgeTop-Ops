import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:vi.fn()})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,
 portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,decodeDirectViewerClientCursor,encodeDirectViewerClientCursor,
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
