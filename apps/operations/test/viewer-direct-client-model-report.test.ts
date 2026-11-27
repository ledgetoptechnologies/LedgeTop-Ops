import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:vi.fn()})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,directViewerGrantsStoreModelReport,readDirectViewerClientGrants} from '../src/worker/viewer-direct-client-grants';

// Model report download on a direct client share (2026-11-27). Real D1 (Miniflare), synthetic data only.
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const request=new Request('https://ops.example.test/'),NOW='2026-11-27T12:00:00.000Z',CLIENT={sourceId:'project-alpha:primary',workspaceId:'ws-one'};
const A='00000000-0000-4000-8000-000000000001',only={version:1,mode:'only',folderIds:[A],taskIds:[]};
const CURRENT=['0237_viewer_direct_client_grants.sql','0240_viewer_direct_grant_receipt_immutability.sql','0243_viewer_direct_grant_model_report.sql'];
const instances:Miniflare[]=[];
beforeEach(()=>{vi.clearAllMocks();vi.useFakeTimers({toFake:['Date'],now:Date.parse(NOW)});mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});
 mocks.proof.mockResolvedValue({sourceId:CLIENT.sourceId});mocks.guard.mockReturnValue({sql:'1=1',bindings:[]});
 mocks.catalog.mockImplementation(async(input:{projectId:string;taskId?:string})=>({project:{id:input.projectId,displayName:'Site'},tasks:input.taskId?[{id:input.taskId,displayName:'Task'}]:[]}));});
afterEach(async()=>{vi.useRealTimers();await Promise.all(instances.splice(0).map(instance=>instance.dispose()));});

async function fixture(migrations=CURRENT){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'report'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 for(const statement of [
  `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
  `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
  `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
  `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
  `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
  `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
  `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`])await database.prepare(statement).run();
 await database.batch([
  database.prepare(`INSERT INTO portal_v2_workspaces VALUES('ws-one','project-alpha:primary',NULL,'active','ws-one','standalone_client',NULL,'root-ws-one')`),
  database.prepare(`INSERT INTO pa_portal_workspace_sources VALUES('ws-one','project-alpha:primary','source-ws-one')`),
  database.prepare(`INSERT INTO portal_v2_directory_checkpoints VALUES('ws-one','generation-ws-one',1)`),
  database.prepare(`INSERT INTO portal_v2_directory_generations VALUES('generation-ws-one','ws-one','active',1)`),
  database.prepare(`INSERT INTO portal_v2_directory_entities VALUES('ws-one','generation-ws-one','standalone_client','root-ws-one','v1',1,'ws-one')`)]);
 for(const name of migrations)
  await database.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),'utf8')).map(statement=>database.prepare(statement)));
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};
}
let sequence=0;
const share=(env:Env,permissions:Record<string,unknown>,extra:Record<string,unknown>={},key=`report-key-${String(++sequence).padStart(12,'0')}`)=>
 createDirectViewerClientGrant({env,principal,idempotencyKey:key,request,
  grant:{...CLIENT,viewerProjectId:`project-${key}`,taskId:null,scopeType:'project',includeFuturePublished:true,confirmedScope:true,expiresAt:null,permissions,...extra}});
const stored=async(database:D1Database,id:string)=>(await database.prepare('SELECT can_download_report FROM viewer_direct_client_grants WHERE id=?')
 .bind(id).first<{can_download_report:number|null}>())!.can_download_report;
const count=async(database:D1Database)=>await database.prepare('SELECT count(*) n FROM viewer_direct_client_grants').first<number>('n');

describe('model report choice on a direct client share',()=>{
 it('stores the choice, says it back and replays it; a share without it keeps the older rule (NULL, no field)',async()=>{
  const f=await fixture();
  const off=await share(f.env,{measure:true,cameras:true,download:true,report:false},{},'report-key-off-000001');
  expect(off.grant.permissions).toEqual({measure:true,cameras:true,download:true,report:false});
  expect(await stored(f.database,off.grant.grantId)).toBe(0);
  const replay=await share(f.env,{measure:true,cameras:true,download:true,report:false},{},'report-key-off-000001');
  expect(replay.replayed).toBe(true);expect(replay.grant).toEqual(off.grant);
  const on=await share(f.env,{measure:false,cameras:false,download:false,report:true});
  expect(await stored(f.database,on.grant.grantId)).toBe(1);expect(on.grant.permissions.report).toBe(true);
  const older=await share(f.env,{measure:true,cameras:false,download:true});
  expect(await stored(f.database,older.grant.grantId)).toBeNull();expect('report' in older.grant.permissions).toBe(false);
  const rows=await readDirectViewerClientGrants(f.env,CLIENT);
  expect(rows.map(row=>String(row.can_download_report)).sort()).toEqual(['0','1','null']);
 },120_000);
 it('refuses anything but a boolean before writing, and the stored choice cannot be changed in place',async()=>{
  const f=await fixture();
  for(const report of ['true',1,null])
   await expect(share(f.env,{measure:true,cameras:true,download:true,report})).rejects.toMatchObject({code:'invalid_request'});
  expect(await count(f.database)).toBe(0);
  const made=await share(f.env,{measure:true,cameras:true,download:true,report:false});
  for(const value of ['1','NULL'])
   await expect(f.database.prepare(`UPDATE viewer_direct_client_grants SET can_download_report=${value} WHERE id=?`).bind(made.grant.grantId).run())
    .rejects.toThrow(/direct-viewer-grant-immutable/);
  await expect(f.database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,
   include_future_published,can_measure,can_view_cameras,can_download,can_download_report,created_by_staff_id,created_at,updated_at)
   VALUES('bad','project-alpha:primary','ws-one','p',NULL,'project',1,1,1,1,2,'s','t','t')`).run()).rejects.toThrow();
 },120_000);
 it('a share of chosen folders keeps its report choice through the receipt check',async()=>{
  const f=await fixture();
  const made=await share(f.env,{measure:true,cameras:true,download:false,report:true},{selection:only});
  const [row]=await readDirectViewerClientGrants(f.env,{...CLIENT,grantId:made.grant.grantId});
  expect(row?.can_download_report).toBe(1);expect(row?.selection).toEqual(only);
 },120_000);
 it('before the column exists it says so, refuses a report choice with nothing written, and shares without one as before',async()=>{
  const f=await fixture(CURRENT.slice(0,2));
  expect(await directViewerGrantsStoreModelReport(f.env)).toBe(false);
  await expect(share(f.env,{measure:true,cameras:true,download:true,report:false})).rejects.toMatchObject({code:'model_report_unsupported'});
  expect(await count(f.database)).toBe(0);
  const plain=await share(f.env,{measure:true,cameras:true,download:true});
  expect(plain.grant.permissions).toEqual({measure:true,cameras:true,download:true});
  expect((await readDirectViewerClientGrants(f.env,CLIENT)).length).toBe(1);
  expect(await directViewerGrantsStoreModelReport((await fixture()).env)).toBe(true);
 },120_000);
});

describe('the share list says whether a share can keep a model report choice',()=>{
 it('says modelReport beside the shares once the column exists, never in a client search',async()=>{
  const {listDirectViewerClientGrantWorkspace}=await import('../src/worker/viewer-direct-client-grants');
  const current=await fixture(),older=await fixture(CURRENT.slice(0,2));
  expect((await listDirectViewerClientGrantWorkspace(current.env,principal,{include:'grants',viewerProjectId:'p'} as never)).modelReport).toBe(true);
  expect('modelReport' in await listDirectViewerClientGrantWorkspace(current.env,principal,{include:'clients',q:'ws',viewerProjectId:'p'} as never)).toBe(false);
  expect('modelReport' in await listDirectViewerClientGrantWorkspace(older.env,principal,{include:'grants',viewerProjectId:'p'} as never)).toBe(false);
 },120_000);
});
