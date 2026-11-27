import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Env,StaffPrincipal} from '../src/worker/types';
const mocks=vi.hoisted(()=>({scope:vi.fn(),identities:vi.fn()}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
// The deployed connection settings name each source's current tuple; the SQL predicate is the real one.
vi.mock('../src/worker/client-hub-source',async importOriginal=>({...await importOriginal<typeof import('../src/worker/client-hub-source')>(),
 clientHubActiveDirectoryIdentities:mocks.identities}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({})}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:vi.fn(),portalProjectionSourceGuard:vi.fn()}));
import {listDirectViewerClientGroups} from '../src/worker/viewer-direct-client-groups';

// Synthetic data only: two divisions (sources) of one business.
const A='project-alpha:division-a',B='project-alpha:division-b',C='project-alpha:division-c';
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const instances:Miniflare[]=[];
const tuple=(source:string,instance='00000000-0000-4000-8000-00000000000a')=>({sourceId:source,sourceInstanceId:instance,
 applicationId:'00000000-0000-4000-8000-0000000000b1',historyEpochId:'00000000-0000-4000-8000-0000000000c1'});
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});
 mocks.identities.mockResolvedValue([tuple(A),tuple(B),tuple(C)]);});
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.dispose()));});

type Workspace={id:string;source:string;publicId:string;root?:'organization'|'standalone_client';status?:string;legacy?:boolean};
type Mapping={record:string;source:string;publicId:string;kind?:'organization'|'client';instance?:string};
async function fixture({groups=[],members,mappings=[],workspaces=[],lifecycle=[]}:{groups?:Array<{id:string;kind?:'organization'|'client';records:string[]}>;
 members?:Array<[record:string,group:string]>;mappings?:Mapping[];workspaces?:Workspace[];lifecycle?:Array<[record:string,status:string]>}){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:'groups'}});
 instances.push(mf);const database=await mf.getD1Database('DB') as unknown as D1Database;
 for(const statement of [
  `CREATE TABLE native_directory_shared_profiles(id TEXT PRIMARY KEY,kind TEXT,membership_json TEXT)`,
  `CREATE TABLE native_directory_shared_profile_members(record_id TEXT PRIMARY KEY,group_id TEXT)`,
  `CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,
   source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT)`,
  `CREATE TABLE operations_directory_lifecycle_state(record_id TEXT PRIMARY KEY,status TEXT)`,
  `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
   root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
 ])await database.prepare(statement).run();
 for(const group of groups)await database.prepare(`INSERT INTO native_directory_shared_profiles VALUES(?,?,?)`)
  .bind(group.id,group.kind??'organization',JSON.stringify(group.records)).run();
 for(const [record,group] of members??groups.flatMap(group=>group.records.map(record=>[record,group.id] as [string,string])))
  await database.prepare(`INSERT INTO native_directory_shared_profile_members VALUES(?,?)`).bind(record,group).run();
 for(const mapping of mappings){const current=tuple(mapping.source,mapping.instance);
  await database.prepare(`INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?,?,?,?,?)`)
  .bind(mapping.source,mapping.kind??'organization',mapping.record,`external-${mapping.record}-${mapping.instance??'now'}`,mapping.publicId,
   current.sourceInstanceId,current.applicationId,current.historyEpochId).run();}
 for(const [record,status] of lifecycle)await database.prepare(`INSERT INTO operations_directory_lifecycle_state VALUES(?,?)`).bind(record,status).run();
 for(const workspace of workspaces){const root=workspace.root??'organization';
  await database.prepare(`INSERT INTO portal_v2_workspaces VALUES(?,?,?,?,?,?,?,?)`).bind(workspace.id,workspace.source,workspace.legacy?'legacy':null,
   workspace.status??'active','Acme Survey',root,root==='organization'?workspace.publicId:null,root==='organization'?null:workspace.publicId).run();}
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};
}
// One reviewed link between record r1 (division A) and r2 (division B), plus an unlinked same-named record r3 in division A.
const linked={groups:[{id:'group-1',records:['r1','r2']}],
 mappings:[{record:'r1',source:A,publicId:'pa-1'},{record:'r2',source:B,publicId:'pa-2'},{record:'r3',source:A,publicId:'pa-3'}],
 workspaces:[{id:'ws-1',source:A,publicId:'pa-1'},{id:'ws-2',source:B,publicId:'pa-2'},{id:'ws-3',source:A,publicId:'pa-3'}]};

describe('direct Viewer client groups',()=>{
 it('groups only workspaces joined by a reviewed shared-profile link; a same-named unlinked client stays out',async()=>{
  const {env}=await fixture(linked);
  expect(await listDirectViewerClientGroups(env,principal)).toEqual({groups:[[[A,'ws-1'],[B,'ws-2']]]});
 });
 it('needs global Viewer management permission',async()=>{
  const {env}=await fixture(linked);mocks.scope.mockResolvedValue({global:false,deniedGlobal:false});
  await expect(listDirectViewerClientGroups(env,principal)).rejects.toMatchObject({status:403});
 });
 it('a link whose membership is incomplete or no longer matches (revoked) groups nothing',async()=>{
  for(const members of [[['r1','group-1']],[['r1','group-1'],['r9','group-1']]] as Array<Array<[string,string]>>){
   const {env}=await fixture({...linked,members});
   expect(await listDirectViewerClientGroups(env,principal)).toEqual({groups:[]});
  }
 });
 it('an inactive, legacy or missing workspace leaves the other one ungrouped',async()=>{
  for(const change of [{status:'archived'},{legacy:true},{id:'ws-2',source:C}]){
   const {env}=await fixture({...linked,workspaces:[linked.workspaces[0]!,{...linked.workspaces[1]!,...change},linked.workspaces[2]!]});
   expect(await listDirectViewerClientGroups(env,principal)).toEqual({groups:[]});
  }
 });
 it('ambiguity groups nothing: two public IDs in one source, both members in one source, or two workspaces for one record',async()=>{
  const twoIds=await fixture({...linked,mappings:[...linked.mappings,{record:'r1',source:A,publicId:'pa-1b'}],
   workspaces:[...linked.workspaces,{id:'ws-1b',source:A,publicId:'pa-1b'}]});
  expect(await listDirectViewerClientGroups(twoIds.env,principal)).toEqual({groups:[]});
  const sameSource=await fixture({...linked,mappings:[{record:'r1',source:A,publicId:'pa-1'},{record:'r2',source:A,publicId:'pa-3'}]});
  expect(await listDirectViewerClientGroups(sameSource.env,principal)).toEqual({groups:[]});
  const twoWorkspaces=await fixture({...linked,workspaces:[...linked.workspaces,{id:'ws-2b',source:B,publicId:'pa-2'}]});
  expect(await listDirectViewerClientGroups(twoWorkspaces.env,principal)).toEqual({groups:[]});
 });
 it('only the current source instance links: an old-instance mapping never pulls in another client',async()=>{
  // r2's only division-B mapping is from an old instance; its public ID now belongs to an unrelated client's workspace.
  const {env}=await fixture({...linked,mappings:[{record:'r1',source:A,publicId:'pa-1'},
   {record:'r2',source:B,publicId:'pa-2',instance:'00000000-0000-4000-8000-0000000000ff'}]});
  expect(await listDirectViewerClientGroups(env,principal)).toEqual({groups:[]});
  // A source with no current connection settings links nothing either.
  mocks.identities.mockResolvedValue([tuple(A)]);
  const unconfigured=await fixture(linked);
  expect(await listDirectViewerClientGroups(unconfigured.env,principal)).toEqual({groups:[]});
 });
 it('a public ID shared by two records in one source, or an archived member, links nothing',async()=>{
  const shared=await fixture({...linked,mappings:[...linked.mappings,{record:'r4',source:B,publicId:'pa-2'}]});
  expect(await listDirectViewerClientGroups(shared.env,principal)).toEqual({groups:[]});
  const archived=await fixture({...linked,lifecycle:[['r2','archived']]});
  expect(await listDirectViewerClientGroups(archived.env,principal)).toEqual({groups:[]});
  const active=await fixture({...linked,lifecycle:[['r1','active'],['r2','active']]});
  expect((await listDirectViewerClientGroups(active.env,principal)).groups).toHaveLength(1);
 });
 it('a record kind must match its workspace root: a client link does not group organisation workspaces',async()=>{
  const {env}=await fixture({...linked,groups:[{id:'group-1',kind:'client',records:['r1','r2']}],
   mappings:linked.mappings.map(mapping=>({...mapping,kind:'client' as const}))});
  expect(await listDirectViewerClientGroups(env,principal)).toEqual({groups:[]});
  const standalone=await fixture({...linked,groups:[{id:'group-1',kind:'client',records:['r1','r2']}],
   mappings:linked.mappings.map(mapping=>({...mapping,kind:'client' as const})),
   workspaces:linked.workspaces.map(workspace=>({...workspace,root:'standalone_client' as const}))});
  expect(await listDirectViewerClientGroups(standalone.env,principal)).toEqual({groups:[[[A,'ws-1'],[B,'ws-2']]]});
 });
 it('a failing or stalled read answers with no groups',async()=>{
  const failing={OPS_DB:{withSession:()=>({prepare:()=>{throw new Error('no such table');}})},DELIVERY_DB:{}} as unknown as Env;
  expect(await listDirectViewerClientGroups(failing,principal)).toEqual({groups:[]});
  const stalled={OPS_DB:{withSession:()=>({prepare:()=>({bind:()=>({all:()=>new Promise(()=>{})})})})},DELIVERY_DB:{}} as unknown as Env;
  const started=Date.now();
  expect(await listDirectViewerClientGroups(stalled,principal,{deadlineMs:50})).toEqual({groups:[]});
  expect(Date.now()-started).toBeLessThan(1000);
 });
 it('a group cut off by the row limit is left out, never shown with part of its members',async()=>{
  const groups=[],mappings=[],workspaces=[];
  for(let index=0;index<3;index++){groups.push({id:`group-${index}`,records:[`a${index}`,`b${index}`]});
   mappings.push({record:`a${index}`,source:A,publicId:`pa-a${index}`},{record:`b${index}`,source:B,publicId:`pa-b${index}`});
   workspaces.push({id:`wa-${index}`,source:A,publicId:`pa-a${index}`},{id:`wb-${index}`,source:B,publicId:`pa-b${index}`});}
  const {env}=await fixture({groups,mappings,workspaces});
  // Five rows fit: groups 0 and 1 whole, group 2 cut after its first member.
  expect(await listDirectViewerClientGroups(env,principal,{rowLimit:5})).toEqual({groups:[[[A,'wa-0'],[B,'wb-0']],[[A,'wa-1'],[B,'wb-1']]]});
 });
 it('the answer stays small: at most 250 groups',async()=>{
  const count=260,groups=[],mappings=[],workspaces=[];
  for(let index=0;index<count;index++){const id=`group-${String(index).padStart(3,'0')}`;
   groups.push({id,records:[`a${index}`,`b${index}`]});
   mappings.push({record:`a${index}`,source:A,publicId:`pa-a${index}`},{record:`b${index}`,source:B,publicId:`pa-b${index}`});
   workspaces.push({id:`wa-${index}`,source:A,publicId:`pa-a${index}`},{id:`wb-${index}`,source:B,publicId:`pa-b${index}`});}
  const {env}=await fixture({groups,mappings,workspaces});
  const result=await listDirectViewerClientGroups(env,principal);
  expect(result.groups.length).toBe(250);
  expect(result.groups.every(group=>group.length===2)).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThan(128*1024);
 });
});
