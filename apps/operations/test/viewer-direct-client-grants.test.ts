import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
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
 readDirectViewerClientGrantAuthorityPin,revokeDirectViewerClientGrant,drainDirectViewerClientGrantRevocations} from '../src/worker/viewer-direct-client-grants';
const {validDirectSnapshot}=createRequire(import.meta.url)('../../viewer/server/directClientGrantContract.js');
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
async function fixture(options:{receiptImmutability?:boolean}={}){const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'direct-viewer'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 const sql=[
 `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
 root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
 `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
 `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
 `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
 `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
 `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
 `CREATE TABLE operations_portal_native_workspace_authority_heads(target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,
  root_kind TEXT,root_record_id TEXT,ownership_epoch INTEGER,state TEXT)`,
 `CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,
  root_kind TEXT,root_record_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT,latest_operation_id TEXT)`,
 `CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT,operation_id TEXT,target_id TEXT,revision INTEGER,
  source_sequence INTEGER,snapshot_sha256 TEXT)`,
 `CREATE TABLE operations_portal_workspace_publication_receipts(operation_id TEXT,target_id TEXT,resulting_revision INTEGER,
  source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT)`,
 `CREATE TABLE operations_portal_workspace_publication_history(operation_id TEXT,target_id TEXT,revision INTEGER,
  source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT)`,
 `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`,
 `INSERT INTO pa_connectors VALUES('project-alpha:primary',1,'Drone Services')`,
 `INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Client One','standalone_client',NULL,'client-one'),
 ('workspace-two','project-alpha:secondary',NULL,'active','Client Two','standalone_client',NULL,'client-two')`,
 `INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary','source-workspace-one'),('workspace-two','project-alpha:secondary','source-workspace-two')`,
 `INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',1),('workspace-two','generation-two',1)`,
 `INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1),('generation-two','workspace-two','active',1)`,
 `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','standalone_client','client-one','v1',1,'Client One'),
 ('workspace-two','generation-two','standalone_client','client-two','v1',1,'Client Two')`,
 ];for(const statement of sql)await database.prepare(statement).run();
 const migration=readFileSync(new URL('../../client/migrations/0237_viewer_direct_client_grants.sql',import.meta.url),'utf8');
 // D1 exec supports complete SQL migration statements, including trigger bodies.
 await database.batch(splitD1MigrationStatements(migration).map(statement=>database.prepare(statement)));
 if(options.receiptImmutability!==false){
  const receiptImmutability=readFileSync(new URL('../../client/migrations/0240_viewer_direct_grant_receipt_immutability.sql',import.meta.url),'utf8');
  await database.batch(splitD1MigrationStatements(receiptImmutability).map(statement=>database.prepare(statement)));
 }
 return {database,env:{DELIVERY_DB:database,OPS_DB:database} as Env};}
async function claimWithCurrentOpsHome(database:D1Database,opts:{epoch?:number;authorityId?:string;sourceId?:string;sourceWorkspaceId?:string;targetRevision?:number;publication?:boolean}={}){
 const epoch=opts.epoch??1,authorityId=opts.authorityId??'10000000-0000-4000-8000-000000000001';
 await database.prepare(`INSERT INTO portal_client_authority_workspace_claims VALUES(?,?,?,?,?,?)`).bind('workspace-one','active',authorityId,
  opts.sourceId??grant.sourceId,opts.sourceWorkspaceId??'source-workspace-one',epoch).run();
 await database.prepare(`INSERT INTO operations_portal_native_workspace_authority_heads VALUES(?,?,?,?,?,?,?,?)`).bind(
  'ops-target-one',3,authorityId,'workspace-one','standalone_client','client-one',4,'active').run();
 if(opts.publication!==false){
  const sha='a'.repeat(64);
  await database.prepare(`INSERT INTO operations_portal_workspace_publication_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
   'ops-target-one',3,authorityId,'workspace-one','standalone_client','client-one',2,7,'ops-snapshot-one',sha,'ops-operation-one').run();
  await database.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots VALUES(?,?,?,?,?,?)`).bind(
   'ops-snapshot-one','ops-operation-one','ops-target-one',2,7,sha).run();
  await database.prepare(`INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,?,?,?)`).bind(
   'ops-operation-one','ops-target-one',2,7,'ops-snapshot-one',sha).run();
  await database.prepare(`INSERT INTO operations_portal_workspace_publication_history VALUES(?,?,?,?,?,?)`).bind(
   'ops-operation-one','ops-target-one',2,7,'ops-snapshot-one',sha).run();
 }
 return {authorityId,epoch};
}
describe('direct Viewer grants independent of PA projects',()=>{
 it('creates exact task authority without a PA project or delivery entitlement and replays once',async()=>{
  const {env,database}=await fixture(),input={env,principal,grant,idempotencyKey:'direct-create-one-0001',request};
  const created=await createDirectViewerClientGrant(input),replay=await createDirectViewerClientGrant(input);
  expect(replay).toEqual({grant:created.grant,replayed:true});expect(mocks.catalog).toHaveBeenCalledTimes(1);
  expect(await readDirectViewerClientGrantAuthorityPin(env,created.grant.grantId)).toEqual({version:1,mode:'native_source',
   sourceId:grant.sourceId,workspaceId:grant.workspaceId,sourceWorkspaceId:'source-workspace-one',rootType:'standalone_client',rootPublicId:'client-one'});
  expect(await readDirectViewerClientGrants(env,{sourceId:grant.sourceId,workspaceId:grant.workspaceId})).toHaveLength(1);
  expect(await readDirectViewerClientGrants(env,{sourceId:'project-alpha:secondary',workspaceId:grant.workspaceId})).toHaveLength(0);
  expect(await database.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('projects','portal_v2_entitlements','viewer_model_associations')").first<number>('n')).toBe(0);
  await expect(createDirectViewerClientGrant({...input,grant:{...grant,permissions:{...grant.permissions,download:true}}})).rejects.toMatchObject({code:'idempotency_conflict'});
 });
 it('does not reinterpret a malformed versioned authority receipt as an old native grant',async()=>{
  const {env,database}=await fixture({receiptImmutability:false});const created=await createDirectViewerClientGrant({env,principal,grant,
   idempotencyKey:'direct-create-malformed-pin-01',request});
  await database.prepare(`UPDATE viewer_direct_client_grant_mutation_receipts SET response_json=? WHERE grant_id=?`)
   .bind(JSON.stringify({version:1,grant:created.grant,recipientAuthorityPin:{mode:'native_source'}}),created.grant.grantId).run();
  await expect(readDirectViewerClientGrantAuthorityPin(env,created.grant.grantId)).rejects.toThrow('direct-viewer-grant-authority-receipt-invalid');
 });
 it.each([
  ['grantId','not-the-receipt-grant'],['sourceId','project-alpha:secondary'],['workspaceId','workspace-two'],
 ] as const)('rejects an idempotent replay whose receipt grant %s is not bound to its row and authority pin',async(field,value)=>{
  const {env,database}=await fixture({receiptImmutability:false}),input={env,principal,grant,idempotencyKey:`direct-create-replay-binding-${field}`,request};
  const created=await createDirectViewerClientGrant(input),pin=await readDirectViewerClientGrantAuthorityPin(env,created.grant.grantId);
  expect(pin).not.toBeNull();
  const malformed={...created.grant,[field]:value};
  await database.prepare(`UPDATE viewer_direct_client_grant_mutation_receipts SET response_json=? WHERE grant_id=?`)
   .bind(JSON.stringify({version:1,grant:malformed,recipientAuthorityPin:pin}),created.grant.grantId).run();
  await expect(createDirectViewerClientGrant(input)).rejects.toMatchObject({status:503,code:'grant_receipt_unavailable'});
  expect(await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants`).first<number>('n')).toBe(1);
 });
 it('keeps the authority-bearing create receipt immutable',async()=>{
  const {env,database}=await fixture();const created=await createDirectViewerClientGrant({env,principal,grant,
   idempotencyKey:'direct-create-immutable-pin-01',request});
  await expect(database.prepare(`UPDATE viewer_direct_client_grant_mutation_receipts SET response_json=? WHERE grant_id=?`)
   .bind('{}',created.grant.grantId).run()).rejects.toThrow('direct-viewer-grant-receipt-immutable');
  await expect(database.prepare(`DELETE FROM viewer_direct_client_grant_mutation_receipts WHERE grant_id=?`)
   .bind(created.grant.grantId).run()).rejects.toThrow('direct-viewer-grant-receipt-immutable');
  expect(await readDirectViewerClientGrantAuthorityPin(env,created.grant.grantId)).toEqual({version:1,mode:'native_source',
   sourceId:grant.sourceId,workspaceId:grant.workspaceId,sourceWorkspaceId:'source-workspace-one',rootType:'standalone_client',rootPublicId:'client-one'});
 });
 it('shares an Operations-claimed recipient only from the current acknowledged authority publication and pins ownership',async()=>{
  const {env,database}=await fixture(),ops=await claimWithCurrentOpsHome(database);
  const input={env,principal,grant,idempotencyKey:'direct-ops-create-one-001',request};
  const created=await createDirectViewerClientGrant(input);
  expect(await readDirectViewerClientGrantAuthorityPin(env,created.grant.grantId)).toEqual({version:1,mode:'operations_native',
   sourceId:grant.sourceId,workspaceId:grant.workspaceId,sourceWorkspaceId:'source-workspace-one',rootType:'standalone_client',
   rootPublicId:'client-one',authorityId:ops.authorityId,ownershipEpoch:4,claimOwnershipEpoch:ops.epoch});
  expect((await createDirectViewerClientGrant(input)).replayed).toBe(true);
  await database.prepare(`UPDATE operations_portal_native_workspace_authority_heads SET ownership_epoch=5 WHERE workspace_id='workspace-one'`).run();
  await expect(createDirectViewerClientGrant(input)).rejects.toMatchObject({code:'relationship_missing'});
 });
 it.each(['active','released'] as const)('does not replay a legacy raw receipt on a workspace with %s claim history',async state=>{
  const {env,database}=await fixture({receiptImmutability:false});
  if(state==='active')await claimWithCurrentOpsHome(database);
  else await database.prepare(`INSERT INTO portal_client_authority_workspace_claims VALUES(?,?,?,?,?,?)`).bind(
   'workspace-one','released','10000000-0000-4000-8000-000000000001',grant.sourceId,'source-workspace-one',1).run();
  const input={env,principal,grant,idempotencyKey:`direct-legacy-${state}-claim-001`,request};
  const created=await createDirectViewerClientGrant(input);
  await database.prepare(`UPDATE viewer_direct_client_grant_mutation_receipts SET response_json=? WHERE grant_id=?`)
   .bind(JSON.stringify(created.grant),created.grant.grantId).run();
  await expect(createDirectViewerClientGrant(input)).rejects.toMatchObject({code:'relationship_missing'});
 });
 it('fails closed for stale or wrong-source Operations claims before inserting a grant',async()=>{
  const {env,database}=await fixture();await claimWithCurrentOpsHome(database,{publication:false});
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-ops-no-proof-001',request}))
   .rejects.toMatchObject({code:'relationship_missing'});
  await database.prepare(`DELETE FROM portal_client_authority_workspace_claims`).run();
  await claimWithCurrentOpsHome(database,{sourceId:'project-alpha:secondary'});
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-ops-wrong-source-01',request}))
   .rejects.toMatchObject({code:'relationship_missing'});
  expect(await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants`).first<number>('n')).toBe(0);
 });
 it('omits and rejects an Ops claim whose source-workspace pin differs from the PA mapping',async()=>{
  const {env,database}=await fixture();await claimWithCurrentOpsHome(database,{sourceWorkspaceId:'other-source-workspace'});
  const picker=await listDirectViewerClientGrantWorkspace(env,principal,{limit:10});
  expect(picker.clients.some(client=>client.workspaceId==='workspace-one')).toBe(false);
  expect(picker.clients.map(client=>client.workspaceId)).toEqual(['workspace-two']);
  await expect(createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-ops-mapping-mismatch-01',request}))
   .rejects.toMatchObject({code:'relationship_missing'});
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
 it('returns a nonempty grant list accepted by the Viewer contract',async()=>{
  const {env}=await fixture();
  await createDirectViewerClientGrant({env,principal,grant,idempotencyKey:'direct-contract-list-01',request});
  const result=await listDirectViewerClientGrantWorkspace(env,principal,{viewerProjectId:grant.viewerProjectId});
  expect(result.clients.length).toBeGreaterThan(0);
  expect(result.grants).toHaveLength(1);
  expect(validDirectSnapshot(result,'list')).toBe(true);
 });
});
