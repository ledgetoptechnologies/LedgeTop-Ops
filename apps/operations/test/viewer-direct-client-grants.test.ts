import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';
import {ViewerServiceError} from '@ltds/shared';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),revoke:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:mocks.revoke})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,
 portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,listDirectViewerClientGrantWorkspace,readDirectViewerClientGrants,
 revokeDirectViewerClientGrant,drainDirectViewerClientGrantRevocations} from '../src/worker/viewer-direct-client-grants';
const instances:Miniflare[]=[];
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const request=new Request('https://ops.example.test/api/viewer/direct-client-grants');
const grant={sourceId:'project-alpha:primary',workspaceId:'workspace-one',viewerProjectId:'viewer-project',taskId:'task-one',scopeType:'task',
 includeFuturePublished:false,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:true,download:false}};
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});mocks.proof.mockResolvedValue({sourceId:'project-alpha:primary'});
 mocks.guard.mockReturnValue({sql:'1=1',bindings:[]});
 mocks.catalog.mockResolvedValue({schemaVersion:1,project:{id:'viewer-project',displayName:'Map'},tasks:[{id:'task-one',modelId:'model-one',modelVersionId:'version-one'}],nextCursor:null});
 mocks.revoke.mockResolvedValue({revokedGrants:1,revokedSessions:1});});
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.dispose()));});
async function fixture(){const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'direct-viewer'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 const sql=[
 `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
 root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
 `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT)`,
 `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
 `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
 `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
 `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT)`,
 `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`,
 `INSERT INTO pa_connectors VALUES('project-alpha:primary',1,'Drone Services')`,
 `INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Client One','standalone_client',NULL,'client-one'),
 ('workspace-two','project-alpha:secondary',NULL,'active','Client Two','standalone_client',NULL,'client-two')`,
 `INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary'),('workspace-two','project-alpha:secondary')`,
 `INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',1),('workspace-two','generation-two',1)`,
 `INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1),('generation-two','workspace-two','active',1)`,
 `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','standalone_client','client-one','v1',1,'Client One'),
 ('workspace-two','generation-two','standalone_client','client-two','v1',1,'Client Two')`,
 ];for(const statement of sql)await database.prepare(statement).run();
 const migration=readFileSync(new URL('../../client/migrations/0237_viewer_direct_client_grants.sql',import.meta.url),'utf8');
 // D1 exec supports complete SQL migration statements, including trigger bodies.
 await database.batch(splitD1MigrationStatements(migration).map(statement=>database.prepare(statement)));
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};}
describe('direct Viewer grants independent of PA projects',()=>{
 it('creates exact task authority without a PA project or delivery entitlement and replays once',async()=>{
  const {env,database}=await fixture(),input={env,principal,grant,idempotencyKey:'direct-create-one-0001',request};
  const created=await createDirectViewerClientGrant(input),replay=await createDirectViewerClientGrant(input);
  expect(replay).toEqual({grant:created.grant,replayed:true});expect(mocks.catalog).toHaveBeenCalledTimes(1);
  expect(await readDirectViewerClientGrants(env,{sourceId:grant.sourceId,workspaceId:grant.workspaceId})).toHaveLength(1);
  expect(await readDirectViewerClientGrants(env,{sourceId:'project-alpha:secondary',workspaceId:grant.workspaceId})).toHaveLength(0);
  expect(await database.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('projects','portal_v2_entitlements','viewer_model_associations')").first<number>('n')).toBe(0);
  await expect(createDirectViewerClientGrant({...input,grant:{...grant,permissions:{...grant.permissions,download:true}}})).rejects.toMatchObject({code:'idempotency_conflict'});
 });
 it('rejects unrelated recipients, unpublished siblings, absent consent and unhealthy authority',async()=>{
  const {env}=await fixture();const create=(value:unknown)=>createDirectViewerClientGrant({env,principal,grant:value,idempotencyKey:crypto.randomUUID(),request});
  await expect(create({...grant,workspaceId:'workspace-two'})).rejects.toMatchObject({code:'relationship_missing'});
  mocks.catalog.mockResolvedValueOnce({project:{id:'viewer-project'},tasks:[{id:'task-two'}]});
  await expect(create(grant)).rejects.toMatchObject({code:'task_not_published'});
  await expect(create({...grant,confirmedScope:false})).rejects.toMatchObject({code:'invalid_request'});
  mocks.proof.mockResolvedValue(null);await expect(create(grant)).rejects.toMatchObject({code:'relationship_missing'});
 });
 it('permits an empty active project with future tasks and keeps task scope exact',async()=>{
  const {env}=await fixture();mocks.catalog.mockResolvedValue({project:{id:'viewer-project'},tasks:[]});
  const result=await createDirectViewerClientGrant({env,principal,grant:{...grant,taskId:null,scopeType:'project',includeFuturePublished:true},
   idempotencyKey:'direct-project-future-01',request});expect(result.grant.includeFuturePublished).toBe(true);
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-task-unpublished',request})).rejects.toMatchObject({code:'task_not_published'});
 });
 it('rolls back the receipt and audit if the pinned source guard changes at insertion',async()=>{
  const {env,database}=await fixture();mocks.guard.mockReturnValue({sql:'0=1',bindings:[]});
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-source-race-001',request})).rejects.toMatchObject({code:'relationship_missing'});
  for(const table of ['viewer_direct_client_grants','viewer_direct_client_grant_mutation_receipts','viewer_direct_client_grant_audit'])
   expect(await database.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n')).toBe(0);
 });
 it('returns a safe actionable error if the selected task was unpublished before sharing',async()=>{
  const {env,database}=await fixture();mocks.catalog.mockRejectedValueOnce(new ViewerServiceError('Upstream missing','not_found',404));
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-task-vanished-01',request}))
   .rejects.toMatchObject({status:409,code:'task_not_published'});
  expect(await database.prepare('SELECT count(*) n FROM viewer_direct_client_grants').first<number>('n')).toBe(0);
 });
 it('invalidates local access before remote tombstone, persists failure, and retries idempotently',async()=>{
  const {env,database}=await fixture();const created=await createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-create-revoke-01',request});
  mocks.revoke.mockImplementation(async()=>{
   expect(await readDirectViewerClientGrants(env,{sourceId:grant.sourceId,workspaceId:grant.workspaceId})).toHaveLength(0);throw new Error('network');});
  const input={env,principal,grantId:created.grant.grantId,reason:'Owner request',idempotencyKey:'direct-revoke-retry-01',request};
  expect(await revokeDirectViewerClientGrant(input)).toMatchObject({success:true,sessionRevocation:{pending:true}});
  expect(await database.prepare('SELECT grant_version,status FROM viewer_direct_client_grants').first()).toEqual({grant_version:1,status:'revoked'});
  mocks.revoke.mockResolvedValue({revokedSessions:1,revokedGrants:1});
  expect(await revokeDirectViewerClientGrant(input)).toMatchObject({success:true,replayed:true,sessionRevocation:{pending:false}});
  await drainDirectViewerClientGrantRevocations(env);expect(mocks.revoke).toHaveBeenCalledTimes(2);
  expect(mocks.revoke.mock.calls[1]?.[0]).toMatchObject({sourceAuthorization:{type:'direct_client_grant',id:created.grant.grantId,version:1}});
 });
 it('checks root status and healthy generation and bounds the native picker',async()=>{
  const {env,database}=await fixture();await database.prepare("UPDATE portal_v2_directory_generations SET complete=0 WHERE workspace_id='workspace-two'").run();
  const result=await listDirectViewerClientGrantWorkspace(env,principal,{q:'Client',limit:1});
  expect(result.clients).toEqual([{sourceId:grant.sourceId,workspaceId:grant.workspaceId,displayName:'Client One',businessName:'Drone Services'}]);
  expect(result.clientsNextCursor).toBeNull();
  await expect(listDirectViewerClientGrantWorkspace(env,principal,{limit:51})).rejects.toMatchObject({code:'invalid_request'});
  mocks.scope.mockResolvedValue({global:false,deniedGlobal:false});
  await expect(listDirectViewerClientGrantWorkspace(env,principal)).rejects.toMatchObject({status:403});
 });
});
