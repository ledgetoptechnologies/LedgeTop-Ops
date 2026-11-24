import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {ViewerServiceError} from '@ltds/shared';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),revoke:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:mocks.revoke})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,drainDirectViewerClientGrantRevocations,readDirectViewerClientGrants,revokeDirectViewerClientGrant} from '../src/worker/viewer-direct-client-grants';

// A replacement is one D1 batch, proven by an operation-unique marker. Real D1 (Miniflare), synthetic data only.
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const request=new Request('https://ops.example.test/'),NOW='2026-11-23T12:00:00.000Z',CLIENT={sourceId:'project-alpha:primary',workspaceId:'ws-one'};
const A='00000000-0000-4000-8000-000000000001',only={version:1,mode:'only',folderIds:[A],taskIds:[]};
const instances:Miniflare[]=[];
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers({toFake:['Date'],now:Date.parse(NOW)});mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});
 mocks.proof.mockResolvedValue({sourceId:CLIENT.sourceId});mocks.guard.mockReturnValue({sql:'1=1',bindings:[]});mocks.revoke.mockResolvedValue({});
 mocks.catalog.mockImplementation(async(input:{projectId:string;taskId?:string})=>({project:{id:input.projectId},tasks:input.taskId?[{id:input.taskId}]:[]}));});
afterEach(async()=>{vi.useRealTimers();await Promise.all(instances.splice(0).map(instance=>instance.dispose()));});

async function fixture(){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'replace'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 for(const statement of [
  `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
  `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
  `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
  `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
  `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
  `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
  `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`])await database.prepare(statement).run();
 for(const id of ['ws-one','ws-two'])await database.batch([
  database.prepare(`INSERT INTO portal_v2_workspaces VALUES(?,'project-alpha:primary',NULL,'active',?,'standalone_client',NULL,?)`).bind(id,id,`root-${id}`),
  database.prepare(`INSERT INTO pa_portal_workspace_sources VALUES(?,'project-alpha:primary',?)`).bind(id,`source-${id}`),
  database.prepare(`INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,1)`).bind(id,`generation-${id}`),
  database.prepare(`INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)`).bind(`generation-${id}`,id),
  database.prepare(`INSERT INTO portal_v2_directory_entities VALUES(?,?,'standalone_client',?,'v1',1,?)`).bind(id,`generation-${id}`,`root-${id}`,id)]);
 for(const name of ['0237_viewer_direct_client_grants.sql','0240_viewer_direct_grant_receipt_immutability.sql'])
  await database.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),'utf8')).map(statement=>database.prepare(statement)));
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
/** Something else lands, or the answer is lost, around exactly this request's batch. */
function around(f:Fixture,{before=async()=>{},after=async()=>{}}:{before?:()=>Promise<unknown>;after?:()=>Promise<unknown>}):Env{
 let done=false;const session={prepare:(sql:string)=>f.database.prepare(sql),
  batch:async(statements:D1PreparedStatement[])=>{if(done)return f.database.batch(statements);done=true;await before();const result=await f.database.batch(statements);await after();return result;}};
 return {...f.env,DELIVERY_DB:{withSession:()=>session}} as unknown as Env;
}
let sequence=0;
const share=(env:Env,extra:Record<string,unknown>={},key=`replace-key-${String(++sequence).padStart(12,'0')}`)=>createDirectViewerClientGrant({env,principal,idempotencyKey:key,request,
 grant:{...CLIENT,viewerProjectId:'project-one',taskId:null,scopeType:'project',includeFuturePublished:true,confirmedScope:true,expiresAt:null,
  permissions:{measure:true,cameras:false,download:false},...extra}});
const task=(env:Env,taskId:string,extra:Record<string,unknown>={})=>share(env,{scopeType:'task',taskId,includeFuturePublished:false,...extra});
const ref=(grant:{grantId:string;grantVersion?:number})=>({grantId:grant.grantId,grantVersion:grant.grantVersion??1});
const tables=['viewer_direct_client_grants','viewer_direct_client_grant_revocations','viewer_direct_client_grant_mutation_receipts','viewer_direct_client_grant_audit'] as const;
const everything=async(f:Fixture)=>JSON.stringify(await Promise.all(tables.map(async table=>(await f.database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results)));
const row=async(f:Fixture,id:string)=>(await f.database.prepare('SELECT * FROM viewer_direct_client_grants WHERE id=?').bind(id).first<Record<string,unknown>>())!;
const count=async(f:Fixture,sql:string)=>await f.database.prepare(`SELECT count(*) n FROM ${sql}`).first<number>('n');

describe('replacing a client’s shares in a project',()=>{
 it('revokes exactly the listed rows, marks them, queues their tombstones and creates one share, with any mix of kinds',async()=>{
  const f=await fixture();
  const whole=(await share(f.env)).grant,one=(await task(f.env,'task-one')).grant,two=(await task(f.env,'task-two',{expiresAt:'2030-01-01T00:00:00.000Z'})).grant;
  const elsewhere=(await share(f.env,{viewerProjectId:'project-two'})).grant,other=(await share(f.env,{workspaceId:'ws-two'})).grant;
  expect(await f.database.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
  const untouched=[await row(f,elsewhere.grantId),await row(f,other.grantId)];
  const result=await share(f.env,{selection:only,replaces:[ref(two),ref(whole),ref(one)]});
  expect(result).toMatchObject({replayed:false,sessionRevocation:{pending:false,revokedGrants:3}});
  const marker=`replaced:${result.grant.grantId}`;
  for(const grant of [whole,one,two])expect(await row(f,grant.grantId)).toMatchObject({status:'revoked',revoke_reason:marker,revoked_by_staff_id:'staff-one',revoked_at:NOW,updated_at:NOW});
  expect([await row(f,elsewhere.grantId),await row(f,other.grantId)]).toEqual(untouched);
  expect(await count(f,`viewer_direct_client_grant_revocations WHERE status='complete'`)).toBe(3);
  expect(mocks.revoke.mock.calls.map(([input])=>input.sourceAuthorization.id).sort()).toEqual([whole,one,two].map(grant=>grant.grantId).sort());
  expect(await count(f,`viewer_direct_client_grant_mutation_receipts WHERE grant_id='${result.grant.grantId}' AND action='grant.create'`)).toBe(1);
  expect((await f.database.prepare(`SELECT grant_id,json_extract(details_json,'$.replacedBy') by_id FROM viewer_direct_client_grant_audit WHERE action='grant.revoke' ORDER BY grant_id`).all()).results)
   .toEqual([whole,one,two].map(grant=>({grant_id:grant.grantId,by_id:result.grant.grantId})).sort((a,b)=>a.grant_id<b.grant_id?-1:1));
  expect((await readDirectViewerClientGrants(f.env,CLIENT)).map(item=>[item.id,item.selection??null])).toEqual(
   [[elsewhere.grantId,null],[result.grant.grantId,only]].sort((a,b)=>String(a[0])<String(b[0])?-1:1));
  // The new share can be replaced in turn; back to the whole project, and to nothing else.
  const back=await share(f.env,{replaces:[ref(result.grant)]});
  expect((await row(f,result.grant.grantId)).revoke_reason).toBe(`replaced:${back.grant.grantId}`);
 },120_000);

 it('says pending until every tombstone is delivered, and a replay delivers and answers the same',async()=>{
  const f=await fixture(),first=(await share(f.env)).grant;mocks.revoke.mockRejectedValue(new Error('down'));
  const result=await share(f.env,{selection:only,replaces:[ref(first)]},'replace-pending-0001');
  expect(result.sessionRevocation).toEqual({pending:true,revokedGrants:1});
  // Operations stops at once, whatever the Viewer says.
  expect((await readDirectViewerClientGrants(f.env,CLIENT)).map(item=>item.id)).toEqual([result.grant.grantId]);
  expect(await share(f.env,{selection:only,replaces:[ref(first)]},'replace-pending-0001')).toEqual({grant:result.grant,replayed:true,sessionRevocation:{pending:true,revokedGrants:1}});
  mocks.revoke.mockResolvedValue({});
  expect(await share(f.env,{selection:only,replaces:[ref(first)]},'replace-pending-0001')).toEqual({grant:result.grant,replayed:true,sessionRevocation:{pending:false,revokedGrants:1}});
  await expect(share(f.env,{selection:only,replaces:[]},'replace-pending-0001')).rejects.toMatchObject({code:'idempotency_conflict'});
  await expect(share(f.env,{selection:only},'replace-pending-0001')).rejects.toMatchObject({code:'idempotency_conflict'});
 },120_000);

 // Everything below lands after this request's own checks, by the same person in the same millisecond.
 const races:Array<[string,(f:Fixture,grants:Array<{grantId:string}>)=>Promise<unknown>,string]>=[
  ['a listed share is now another version',async(f,grants)=>{const old=await row(f,grants[0]!.grantId);await f.database.batch([
    f.database.prepare('PRAGMA defer_foreign_keys=ON'),
    f.database.prepare('DELETE FROM viewer_direct_client_grants WHERE id=?').bind(old.id),
    f.database.prepare(`INSERT INTO viewer_direct_client_grants(${Object.keys(old).join(',')}) VALUES(${Object.keys(old).map(()=>'?').join(',')})`).bind(...Object.values({...old,grant_version:2}))]);},'share_changed'],
  ['a listed share was just revoked',async(f,grants)=>revokeDirectViewerClientGrant({env:f.env,principal,grantId:grants[0]!.grantId,reason:'Revoked by staff',idempotencyKey:'replace-race-revoke1',request}),'share_changed'],
  ['an older workspace added a task share',async f=>task(f.env,'task-late'),'share_changed'],
  ['another replacement won',async(f,grants)=>share(f.env,{replaces:grants.map(ref)}),'share_changed'],
  ['the client connection changed',async f=>f.database.prepare(`UPDATE portal_v2_directory_checkpoints SET source_sequence=2 WHERE workspace_id='ws-one'`).run(),'relationship_missing'],
  ['the client reached its limit',async f=>f.database.batch(Array.from({length:100},(_,index)=>f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,
    include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,'project-alpha:primary','ws-one',?,NULL,'project',1,1,0,0,NULL,1,'active','staff-one',?,?)`).bind(`filler-${index}`,`filler-project-${index}`,NOW,NOW))),'grant_limit'],
 ];
 for(const [label,land,code] of races)it(`changes nothing at all when ${label}, and says why`,async()=>{
  const f=await fixture(),grants=[(await share(f.env)).grant,(await task(f.env,'task-one')).grant];let landed='';
  const env=around(f,{before:async()=>{await land(f,grants);landed=await everything(f);}});
  const error=await share(env,{selection:only,replaces:grants.map(ref)},'replace-race-key-0001').catch(caught=>caught);
  expect(error).toMatchObject({status:409,code});
  // Full rollback: only what landed on its own is there. No revocation, tombstone, receipt or audit of this request.
  expect(await everything(f)).toBe(landed);
  expect(await count(f,`viewer_direct_client_grant_mutation_receipts WHERE idempotency_key='replace-race-key-0001'`)).toBe(0);
  if(code==='share_changed'){
   const active=(await f.database.prepare(`SELECT id grantId,grant_version grantVersion FROM viewer_direct_client_grants WHERE workspace_id='ws-one' AND viewer_project_id='project-one' AND status='active' ORDER BY id`).all()).results;
   expect(error.grants).toEqual(active);
   // The same key is free, and the answer it got is enough to try again.
   expect(await share(f.env,{selection:only,replaces:error.grants},'replace-race-key-0001')).toMatchObject({replayed:false,sessionRevocation:{revokedGrants:active.length}});
  }
 },120_000);

 it('refuses early, changing nothing, when the list is not exactly this client’s current shares here',async()=>{
  const f=await fixture(),mine=(await share(f.env)).grant,extra=(await task(f.env,'task-one')).grant;
  const elsewhere=(await share(f.env,{viewerProjectId:'project-two'})).grant,other=(await share(f.env,{workspaceId:'ws-two'})).grant,before=await everything(f);
  let batches=0;const env=around(f,{before:async()=>{batches++;}});
  for(const replaces of [[],[ref(mine)],[ref(mine),ref(extra),ref(elsewhere)],[ref(mine),ref(other)],[ref(mine),{grantId:extra.grantId,grantVersion:2}],[ref(mine),ref(extra),{grantId:'unknown-grant',grantVersion:1}]])
   await expect(share(env,{selection:only,replaces})).rejects.toMatchObject({status:409,code:'share_changed',grants:[ref(mine),ref(extra)].sort((a,b)=>a.grantId<b.grantId?-1:1)});
  expect(batches).toBe(0);
  for(const bad of [[ref(mine),ref(mine)],Array.from({length:101},(_,index)=>({grantId:`grant-${index}`,grantVersion:1})),[{grantId:mine.grantId}],[{...ref(mine),note:'x'}],[{grantId:mine.grantId,grantVersion:0}],'all',null])
   await expect(share(f.env,{selection:only,replaces:bad})).rejects.toMatchObject({status:400});
  await expect(task(f.env,'task-two',{replaces:[]})).rejects.toMatchObject({status:400});
  expect(await everything(f)).toBe(before);
  // An empty list is right when there is nothing: the first share through the new dialog.
  expect(await share(f.env,{viewerProjectId:'project-three',selection:only,replaces:[]})).toMatchObject({sessionRevocation:{pending:false,revokedGrants:0}});
 },120_000);

 it('keeps the marker its own: a revocation cannot imitate it, and a revoked row keeps the one it has',async()=>{
  const f=await fixture(),first=(await share(f.env)).grant;
  for(const reason of ['replaced:','replaced:x',' Replaced:00000000-0000-4000-8000-000000000001','REPLACED:y'])
   await expect(revokeDirectViewerClientGrant({env:f.env,principal,grantId:first.grantId,reason,idempotencyKey:'replace-imitate-0001',request})).rejects.toMatchObject({status:400});
  expect((await row(f,first.grantId)).status).toBe('active');
  const next=(await share(f.env,{replaces:[ref(first)]})).grant,marked=await row(f,first.grantId);
  await expect(f.database.prepare(`UPDATE viewer_direct_client_grants SET revoke_reason='other' WHERE id=?`).bind(first.grantId).run()).rejects.toThrow(/immutable/);
  expect(await row(f,first.grantId)).toEqual(marked);
  expect(await revokeDirectViewerClientGrant({env:f.env,principal,grantId:next.grantId,reason:'Replaced by mistake',idempotencyKey:'replace-imitate-0002',request})).toMatchObject({success:true});
 },120_000);

 it('replaces an ended share, which still holds its place, and one at the client’s limit',async()=>{
  const f=await fixture(),ended=(await share(f.env,{expiresAt:'2026-11-23T12:00:01.000Z'})).grant;vi.setSystemTime(Date.parse(NOW)+60_000);
  await expect(share(f.env)).rejects.toMatchObject({code:'duplicate_active_grant'});
  const again=(await share(f.env,{replaces:[ref(ended)]})).grant;
  await f.database.batch(Array.from({length:99},(_,index)=>f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,
   include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
   VALUES(?,'project-alpha:primary','ws-one',?,NULL,'project',1,1,0,0,NULL,1,'active','staff-one',?,?)`).bind(`filler-${index}`,`filler-project-${index}`,NOW,NOW)));
  await expect(share(f.env,{viewerProjectId:'project-new',replaces:[]})).rejects.toMatchObject({code:'grant_limit'});
  expect(await share(f.env,{selection:only,replaces:[ref(again)]})).toMatchObject({replayed:false});
  expect(await readDirectViewerClientGrants(f.env,CLIENT)).toHaveLength(100);
 },120_000);

 it('reports an overflow of 101 expired shares without changing any of them, then replaces 100 after a staff revoke',async()=>{
  const f=await fixture();
  const insert=(index:number)=>f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,can_measure,
   can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
   VALUES(?,'project-alpha:primary','ws-one','project-one',?,'task',0,1,0,0,?,1,'active','staff-one',?,?)`)
   .bind(`legacy-${index}`,`legacy-task-${index}`,'2020-01-02T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
  const listed=Array.from({length:100},(_,index)=>({grantId:`legacy-${index}`,grantVersion:1}));
  for(let start=0;start<100;start+=50)await f.database.batch(Array.from({length:50},(_,offset)=>insert(start+offset)));
  expect(await readDirectViewerClientGrants(f.env,CLIENT)).toEqual([]);
  let landed='';
  const racing=around(f,{before:async()=>{await insert(100).run();landed=await everything(f);}});
  const overflow={status:409,code:'share_replacement_limit',message:expect.stringMatching(/revoke shares/i),grants:undefined};
  await expect(share(racing,{selection:only,replaces:listed})).rejects.toMatchObject(overflow);
  expect(await everything(f)).toBe(landed);
  await expect(share(f.env,{selection:only,replaces:listed})).rejects.toMatchObject(overflow);
  expect(await everything(f)).toBe(landed);
  expect(mocks.revoke).not.toHaveBeenCalled();
  await expect(revokeDirectViewerClientGrant({env:f.env,principal,grantId:'legacy-100',reason:'No longer needed',
   idempotencyKey:'replace-overflow-revoke1',request})).resolves.toMatchObject({success:true});
  const replacement=await share(f.env,{selection:only,replaces:listed});
  expect(replacement).toMatchObject({replayed:false,sessionRevocation:{revokedGrants:100}});
  expect(await count(f,"viewer_direct_client_grants WHERE workspace_id='ws-one' AND viewer_project_id='project-one' AND status='active'")).toBe(1);
 },180_000);

 it('replaces 100 shares with the whole tombstone, receipt and audit batch; a lost answer replays to the same share',async()=>{
  const f=await fixture(),listed:Array<{grantId:string;grantVersion:number}>=[];
  for(let start=0;start<100;start+=50)await f.database.batch(Array.from({length:50},(_,offset)=>{const index=start+offset;listed.push({grantId:`many-${String(index).padStart(3,'0')}`,grantVersion:1});
   return f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,can_measure,can_view_cameras,can_download,
    authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at) VALUES(?,'project-alpha:primary','ws-one','project-one',?,?,?,1,0,0,NULL,1,'active','staff-one',?,?)`)
    .bind(`many-${String(index).padStart(3,'0')}`,index?`task-${index}`:null,index?'task':'project',index?0:1,NOW,NOW);}));
  // One stale among 100 rolls all of it back.
  let landed='';const stale=around(f,{before:async()=>{await revokeDirectViewerClientGrant({env:f.env,principal,grantId:'many-050',reason:'Revoked by staff',idempotencyKey:'replace-many-revoke1',request});landed=await everything(f);}});
  await expect(share(stale,{selection:only,replaces:listed},'replace-many-key-0001')).rejects.toMatchObject({code:'share_changed'});
  expect(await everything(f)).toBe(landed);
  const current=listed.filter(item=>item.grantId!=='many-050'),more=(await task(f.env,'task-more')).grant,all=[...current,ref(more)];expect(all).toHaveLength(100);
  mocks.revoke.mockClear();
  const lost=around(f,{after:async()=>{throw new Error('network: answer lost');}});
  const result=await share(lost,{selection:only,replaces:all},'replace-many-key-0002');
  expect(result).toMatchObject({replayed:true,sessionRevocation:{pending:true,revokedGrants:100}});
  expect(await count(f,`viewer_direct_client_grants WHERE revoke_reason='replaced:${result.grant.grantId}' AND status='revoked'`)).toBe(100);
  expect(await count(f,`viewer_direct_client_grant_revocations r JOIN viewer_direct_client_grants g ON g.id=r.grant_id AND g.grant_version=r.grant_version WHERE g.revoke_reason='replaced:${result.grant.grantId}'`)).toBe(100);
  expect(await count(f,`viewer_direct_client_grant_audit WHERE action='grant.revoke' AND json_extract(details_json,'$.replacedBy')='${result.grant.grantId}'`)).toBe(100);
  expect(await count(f,`viewer_direct_client_grant_mutation_receipts WHERE idempotency_key='replace-many-key-0002'`)).toBe(1);
  expect(await count(f,`viewer_direct_client_grants WHERE workspace_id='ws-one' AND viewer_project_id='project-one' AND status='active'`)).toBe(1);
  // Delivered in bounded turns: 25 with the request, the rest by replays or the existing drain.
  expect(mocks.revoke).toHaveBeenCalledTimes(25);
  expect(await share(f.env,{selection:only,replaces:all},'replace-many-key-0002')).toMatchObject({grant:result.grant,replayed:true,sessionRevocation:{pending:true}});
  await drainDirectViewerClientGrantRevocations(f.env,{limit:100});
  expect(await share(f.env,{selection:only,replaces:all},'replace-many-key-0002')).toEqual({grant:result.grant,replayed:true,sessionRevocation:{pending:false,revokedGrants:100}});
  expect(await count(f,'viewer_direct_client_grants WHERE status=\'active\'')).toBe(1);
 },180_000);

 it('two people replacing at once, or one request sent twice, make one share; the other answer is exact',async()=>{
  const f=await fixture(),first=(await share(f.env)).grant,key='replace-twice-key-0001';
  const answers=await Promise.allSettled([share(f.env,{selection:only,replaces:[ref(first)]}),share(f.env,{replaces:[ref(first)]})]);
  expect(answers.map(answer=>answer.status).sort()).toEqual(['fulfilled','rejected']);
  expect(answers.find(answer=>answer.status==='rejected')).toMatchObject({reason:{code:'share_changed',grants:[{grantVersion:1}]}});
  const now=(await readDirectViewerClientGrants(f.env,CLIENT))[0]!,list=[{grantId:now.id,grantVersion:1}];
  // The same request lands first: this one answers with that share, and has changed nothing itself.
  let won:Awaited<ReturnType<typeof share>>|undefined;
  const twin=around(f,{before:async()=>{won=await share(f.env,{selection:only,replaces:list},key);}});
  expect(await share(twin,{selection:only,replaces:list},key)).toEqual({...won,replayed:true});
  // Another request lands first under the same key, in another project: only the receipt's own key stops this batch.
  const next=[ref(won!.grant)],taken='replace-twice-key-0002';
  const other=around(f,{before:async()=>share(f.env,{viewerProjectId:'project-two',replaces:[]},taken)});
  await expect(share(other,{selection:only,replaces:next},taken)).rejects.toMatchObject({code:'idempotency_conflict'});
  expect((await row(f,won!.grant.grantId)).status).toBe('active');
 },120_000);

 it('a request that was still waiting for the Viewer answers from the receipt its key now has, before any conflict',async()=>{
  // The delayed request read no receipt; the other one commits while it waits for the catalog.
  const delayed=async(f:Fixture,mine:Record<string,unknown>,peer:Record<string,unknown>,key:string)=>{
   let release=()=>{},waiting=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{waiting=resolve;});
   mocks.catalog.mockImplementationOnce(async(input:{projectId:string})=>{waiting();await held;return {project:{id:input.projectId},tasks:[]};});
   const answer=share(f.env,mine,key).then(value=>({value}),error=>({error}));await reached;
   const won=await share(f.env,peer,key),landed=await everything(f);release();
   const result=await answer as {value?:Awaited<ReturnType<typeof share>>;error?:{code:string;grants?:unknown}};
   expect(await everything(f)).toBe(landed);return {won,...result};
  };
  const f=await fixture(),first=(await share(f.env)).grant,list=[ref(first)];
  const same=await delayed(f,{selection:only,replaces:list},{selection:only,replaces:list},'replace-delayed-0001');
  expect(same.value).toEqual({...same.won,replayed:true});
  const next=[ref(same.won.grant)];
  const different=await delayed(f,{replaces:next},{selection:only,replaces:next},'replace-delayed-0002');
  expect(different.error).toMatchObject({code:'idempotency_conflict'});expect(different.error!.grants).toBeUndefined();
  // Another payload under another key is still told the current shares.
  await expect(share(f.env,{replaces:next})).rejects.toMatchObject({code:'share_changed',grants:[ref(different.won.grant)]});
  // The limit too: the other request took the client's last place in another project.
  await f.database.batch(Array.from({length:98},(_,index)=>f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,
   include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
   VALUES(?,'project-alpha:primary','ws-one',?,NULL,'project',1,1,0,0,NULL,1,'active','staff-one',?,?)`).bind(`filler-${index}`,`filler-project-${index}`,NOW,NOW)));
  const limit=await delayed(f,{viewerProjectId:'project-last',replaces:[]},{viewerProjectId:'project-other',replaces:[]},'replace-delayed-0003');
  expect(limit.error).toMatchObject({code:'idempotency_conflict'});
  await expect(share(f.env,{viewerProjectId:'project-last',replaces:[]})).rejects.toMatchObject({code:'grant_limit'});
  // An identical request at the limit it filled itself.
  const seat=(await row(f,'filler-0')),free=[{grantId:String(seat.id),grantVersion:1}];
  const full=await delayed(f,{viewerProjectId:'filler-project-0',replaces:free},{viewerProjectId:'filler-project-0',replaces:free},'replace-delayed-0004');
  expect(full.value).toEqual({...full.won,replayed:true});
 },120_000);

 it.each([
  {identical:true,failure:'unavailable'},
  {identical:false,failure:'unavailable'},
  {identical:true,failure:'wrong project'},
  {identical:false,failure:'wrong project'},
 ])('checks the receipt after a delayed catalog result ($failure, identical: $identical)',async({identical,failure})=>{
  const f=await fixture(),first=(await share(f.env)).grant;
  const mine={selection:only,replaces:[ref(first)]};
  const peer=identical?mine:{replaces:mine.replaces};
  const key='replace-catalog-fail-01';
  let release=()=>{},waiting=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  const reached=new Promise<void>(resolve=>{waiting=resolve;});
  mocks.catalog.mockImplementationOnce(async()=>{
   waiting();await held;
   if(failure==='unavailable')throw new ViewerServiceError('Viewer temporarily unavailable','unavailable',503);
   return {project:{id:'wrong-project'},tasks:[]};
  });
  const pending=share(f.env,mine,key).then(value=>({value}),error=>({error}));
  await reached;
  try{
   const won=await share(f.env,peer,key),landed=await everything(f);
   release();
   if(identical)expect(await pending).toEqual({value:{...won,replayed:true}});
   else expect(await pending).toMatchObject({error:{code:'idempotency_conflict'}});
   expect(await everything(f)).toBe(landed);
  }finally{release();}
 },120_000);

 it('a receipt that appears while a failed batch is being explained still decides',async()=>{
  for(const identical of [true,false]){
   const f=await fixture(),first=(await share(f.env)).grant,list=[ref(first)],key='replace-explained-01';let checks=0,failed=false;
   let won:Awaited<ReturnType<typeof share>>|undefined;
   const session={prepare:(sql:string)=>{const statement=f.database.prepare(sql);
     if(!/^SELECT id grantId,grant_version grantVersion/.test(sql)||++checks!==2)return statement;
     return {bind:(...values:unknown[])=>({all:async()=>{won=await share(f.env,identical?{selection:only,replaces:list}:{replaces:list},key);return statement.bind(...values).all();}})};},
    batch:async(statements:D1PreparedStatement[])=>{if(!failed){failed=true;await f.database.prepare(`UPDATE portal_v2_directory_checkpoints SET source_sequence=2 WHERE workspace_id='ws-one'`).run();}return f.database.batch(statements);}};
   const answer=share({...f.env,DELIVERY_DB:{withSession:()=>session}} as unknown as Env,{selection:only,replaces:list},key);
   if(identical)expect(await answer).toEqual({...won!,replayed:true});
   else await expect(answer).rejects.toMatchObject({code:'idempotency_conflict'});
   expect(checks).toBeGreaterThanOrEqual(2);expect(await readDirectViewerClientGrants(f.env,CLIENT)).toHaveLength(1);
  }
 },120_000);

 it('counts every row that carries its marker, listed or not',async()=>{
  const f=await fixture(),first=(await share(f.env)).grant,fixed='11111111-1111-4111-8111-111111111111';
  await f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,can_measure,can_view_cameras,can_download,
   authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at,revoked_at,revoked_by_staff_id,revoke_reason)
   VALUES('smuggled','project-alpha:primary','ws-two','project-one',NULL,'project',1,1,0,0,NULL,1,'revoked','staff-one',?,?,?,'staff-one',?)`).bind(NOW,NOW,NOW,`replaced:${fixed}`).run();
  const before=await everything(f),uuid=vi.spyOn(crypto,'randomUUID').mockReturnValueOnce(fixed);
  try{await expect(share(f.env,{selection:only,replaces:[ref(first)]})).rejects.toThrow(/FOREIGN KEY/);}finally{uuid.mockRestore();}
  expect(await everything(f)).toBe(before);
  // A row that carries it cannot stand in for a listed one that someone else has just revoked: the total is right, the rows are not.
  let landed='';const env=around(f,{before:async()=>{await revokeDirectViewerClientGrant({env:f.env,principal,grantId:first.grantId,reason:'Revoked by staff',idempotencyKey:'replace-standin-revoke',request});landed=await everything(f);}});
  const again=vi.spyOn(crypto,'randomUUID').mockReturnValueOnce(fixed);
  try{await expect(share(env,{selection:only,replaces:[ref(first)]})).rejects.toMatchObject({code:'share_changed',grants:[]});}finally{again.mockRestore();}
  expect(await everything(f)).toBe(landed);
 },120_000);

 it('passes an unexpected failure on as it is, with nothing written',async()=>{
  const f=await fixture(),first=(await share(f.env)).grant;
  await f.database.prepare(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON viewer_direct_client_grant_audit WHEN NEW.action='grant.revoke' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`).run();
  const before=await everything(f);
  await expect(share(f.env,{selection:only,replaces:[ref(first)]})).rejects.toThrow(/synthetic audit failure/);
  expect(await everything(f)).toBe(before);
 },120_000);

 it('without a list nothing changes: the old rules, and any number of rows read correctly',async()=>{
  const f=await fixture(),whole=(await share(f.env)).grant,one=(await task(f.env,'task-one')).grant;
  const part=(await share(f.env,{selection:{version:1,mode:'except',folderIds:[],taskIds:[A]},replaces:[ref(whole),ref(one)]})).grant;
  // An older workspace may still add a task share beside it. Both are there, each on its own terms.
  const beside=await task(f.env,'task-one');expect(beside).toEqual({grant:beside.grant,replayed:false});
  await expect(share(f.env)).rejects.toMatchObject({code:'duplicate_active_grant'});
  expect((await readDirectViewerClientGrants(f.env,CLIENT)).map(item=>[item.id,item.scope_type,item.selection?.mode??null])).toEqual(
   [[part.grantId,'project','except'],[beside.grant.grantId,'task',null]].sort((a,b)=>String(a[0])<String(b[0])?-1:1));
  const merged=(await share(f.env,{selection:only,replaces:[ref(part),ref(beside.grant)]})).grant;
  expect((await readDirectViewerClientGrants(f.env,CLIENT)).map(item=>item.id)).toEqual([merged.grantId]);
 },120_000);
});
