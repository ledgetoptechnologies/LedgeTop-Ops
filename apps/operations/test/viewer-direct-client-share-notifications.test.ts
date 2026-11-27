import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import type {Env,StaffPrincipal} from '../src/worker/types';
import type {OutboundMail} from '../src/worker/mailer';
const mocks=vi.hoisted(()=>({catalog:vi.fn(),scope:vi.fn(),proof:vi.fn(),guard:vi.fn()}));
vi.mock('../src/worker/viewer-integration',()=>({viewerServiceClient:()=>({clientDeliveryCatalog:mocks.catalog,revokePublishedSessionSourceAuthorization:vi.fn()})}));
vi.mock('../src/worker/acl',()=>({sqlScope:mocks.scope}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',()=>({readPortalProjectionSourceProof:mocks.proof,portalProjectionSourceGuard:mocks.guard}));
import {createDirectViewerClientGrant,revokeDirectViewerClientGrant} from '../src/worker/viewer-direct-client-grants';
import {directViewerShareCapabilities,processDirectViewerShareNotices} from '../src/worker/viewer-direct-client-share-notifications';

const instances:Miniflare[]=[];
const principal:StaffPrincipal={id:'staff-one',email:'staff@example.test',displayName:'Staff',accessSubject:'staff-subject',projectAlphaUserId:null};
const request=new Request('https://ops.example.test/api/viewer/direct-client-grants');
const taskGrant=(taskId='task-one',workspaceId='workspace-one')=>({sourceId:'project-alpha:primary',workspaceId,viewerProjectId:'viewer-project',taskId,scopeType:'task',
 includeFuturePublished:false,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:true,download:false}});
const projectGrant=(workspaceId='workspace-one')=>({...taskGrant('x',workspaceId),taskId:null,scopeType:'project',includeFuturePublished:true});
const LATER=Date.now()+5*60_000;
let keys=0;const key=()=>`share-notice-key-${String(++keys).padStart(6,'0')}`;

beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({global:true,deniedGlobal:false});mocks.proof.mockResolvedValue({sourceId:'project-alpha:primary'});
 mocks.guard.mockReturnValue({sql:'1=1',bindings:[]});
 mocks.catalog.mockImplementation(async({taskId}:{taskId?:string})=>({schemaVersion:1,project:{id:'viewer-project',displayName:'Quarry Survey'},
  tasks:taskId?[{id:taskId,displayName:taskId==='task-one'?'North Pit':'South Pit',modelId:'model-one',modelVersionId:'version-one'}]:[],nextCursor:null}));});
afterEach(async()=>{await Promise.all(instances.splice(0).map(m=>m.dispose()));});

async function fixture(){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:'share-notices'}});
 instances.push(mf);const database=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 const sql=[
 `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
 root_type TEXT NOT NULL,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
 `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
 `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
 `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
 `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
 `CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT,client_authority_id TEXT,projection_source_id TEXT,source_workspace_id TEXT,ownership_epoch INTEGER)`,
 `CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT)`,
 `CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,verified_email TEXT,status TEXT,revoked_at TEXT)`,
 `CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT,PRIMARY KEY(workspace_id,identity_id))`,
 `CREATE TABLE portal_v2_identity_denials(identity_id TEXT,workspace_id TEXT,scope_type TEXT,scope_public_id TEXT,status TEXT,valid_from TEXT,expires_at TEXT)`,
 `INSERT INTO pa_connectors VALUES('project-alpha:primary',1,'Drone Services')`,
 `INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Client One','organization','org-one',NULL),
 ('workspace-two','project-alpha:primary',NULL,'active','Client One East','organization','org-two',NULL)`,
 `INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary','source-one'),('workspace-two','project-alpha:primary','source-two')`,
 `INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',1),('workspace-two','generation-two',1)`,
 `INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1),('generation-two','workspace-two','active',1)`,
 `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','organization','org-one','v1',1,'Client One'),
 ('workspace-two','generation-two','organization','org-two','v1',1,'Client One East')`,
 // Members: two current people, one person with two identities, and every kind that must be skipped.
 `INSERT INTO portal_v2_identities VALUES('id-alice','alice@example.test','active',NULL),('id-bob','bob@example.test','active',NULL),
 ('id-alice-2','Alice@Example.test','active',NULL),('id-revoked','revoked@example.test','revoked','2026-01-01T00:00:00Z'),
 ('id-unverified',NULL,'active',NULL),('id-gone','gone@example.test','active',NULL),('id-expired','expired@example.test','active',NULL),
 ('id-denied','denied@example.test','active',NULL)`,
 `INSERT INTO portal_v2_workspace_memberships VALUES('workspace-one','id-alice','active',NULL,NULL),('workspace-one','id-bob','active',NULL,NULL),
 ('workspace-one','id-alice-2','active',NULL,NULL),('workspace-one','id-revoked','active',NULL,NULL),('workspace-one','id-unverified','active',NULL,NULL),
 ('workspace-one','id-gone','revoked','2026-01-01T00:00:00Z',NULL),('workspace-one','id-expired','active',NULL,'2020-01-01T00:00:00Z'),
 ('workspace-one','id-denied','active',NULL,NULL),('workspace-two','id-alice','active',NULL,NULL)`,
 `INSERT INTO portal_v2_identity_denials VALUES('id-denied',NULL,'global',NULL,'active','2020-01-01T00:00:00Z',NULL)`,
 ];for(const statement of sql)await database.prepare(statement).run();
 for(const file of ['0237_viewer_direct_client_grants.sql','0240_viewer_direct_grant_receipt_immutability.sql']){
  const migration=readFileSync(new URL(`../../client/migrations/${file}`,import.meta.url),'utf8');
  await database.batch(splitD1MigrationStatements(migration).map(statement=>database.prepare(statement)));
 }
 const sent:OutboundMail[]=[];
 const env={DELIVERY_DB:database,OPS_DB:database,SMTP_NOTIFICATIONS_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',
  DELIVERY_BASE_URL:'https://portal.example.test'} as unknown as Env;
 const send=vi.fn(async(_env:unknown,mail:OutboundMail)=>{sent.push(mail);});
 return {database,env,sent,send};
}
async function share(env:Env,grant:unknown,notifyClient?:boolean,idempotencyKey=key()){
 return createDirectViewerClientGrant({env,principal,grant,idempotencyKey,request,...(notifyClient===undefined?{}:{notifyClient})});
}
const recipients=(sent:OutboundMail[])=>sent.map(mail=>mail.to.toLowerCase()).sort();

describe('Viewer direct share client email',()=>{
 it('emails every current member once, after the share, with the portal link and Ledge Top sender',async()=>{
  const {env,sent,send}=await fixture();
  const created=await share(env,taskGrant(),true);
  expect(sent).toHaveLength(0);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
  for(const mail of sent){
   expect(mail.fromName).toBe('Ledge Top Client Portal');
   expect(mail.subject).toContain('Quarry Survey');
   expect(mail.text).toContain('North Pit');
   expect(mail.text).toContain(`https://portal.example.test/portal/viewer/${created.grant.grantId}/tasks/task-one?workspace=workspace-one`);
   expect(mail.html).toContain('https://portal.example.test/portal/viewer/');
   expect(mail.messageIdKey).toBeTruthy();
  }
  // Replay of the processor, and of the create request, sends nothing more.
  await processDirectViewerShareNotices(env,{nowMs:LATER+60*60_000,send});
  expect(sent).toHaveLength(2);
 });
 it('sends nothing when the box is unticked or for an older caller that does not ask',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,taskGrant('task-one'),false);
  await share(env,taskGrant('task-two'));
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(sent).toHaveLength(0);
 });
 it('a replayed create does not ask twice',async()=>{
  const {env,database,sent,send}=await fixture();
  const idempotencyKey=key();
  await share(env,taskGrant(),true,idempotencyKey);
  const replay=await share(env,taskGrant(),true,idempotencyKey);
  expect(replay.replayed).toBe(true);
  const rows=await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grant_audit WHERE action='grant.notify.requested'`).first<number>('n');
  expect(rows).toBe(1);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(sent).toHaveLength(2);
 });
 it('one share click of several tasks sends each person one email',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,taskGrant('task-one'),true);await share(env,taskGrant('task-two'),true);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
  expect(sent[0]!.text).toContain('https://portal.example.test/portal');
  expect(sent[0]!.text).not.toContain('/tasks/');
 });
 it('a person in two linked workspaces that both get the share is emailed once',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,projectGrant('workspace-one'),true);await share(env,projectGrant('workspace-two'),true);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
 });
 it('a share still being posted task by task is held until its last task is a minute old',async()=>{
  const {env,database,sent,send}=await fixture();
  const first=await share(env,taskGrant('task-one'),true);await share(env,taskGrant('task-two'),true);
  // The first task was posted two minutes before the second; the run falls between them.
  await database.prepare(`UPDATE viewer_direct_client_grant_audit SET created_at=? WHERE id=?`)
   .bind(new Date(Date.now()-120_000).toISOString(),`vdcg-notify:${first.grant.grantId}`).run();
  await processDirectViewerShareNotices(env,{nowMs:Date.now()+10_000,send});
  expect(sent).toHaveLength(0);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
 });
 it('linked workspaces shared in two clicks under a minute apart still email a shared member once',async()=>{
  const {env,database,sent,send}=await fixture();
  const first=await share(env,projectGrant('workspace-one'),true);await share(env,projectGrant('workspace-two'),true);
  await database.prepare(`UPDATE viewer_direct_client_grant_audit SET created_at=? WHERE id=?`)
   .bind(new Date(Date.now()-90_000).toISOString(),`vdcg-notify:${first.grant.grantId}`).run();
  await processDirectViewerShareNotices(env,{nowMs:Date.now()+10_000,send});
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
 });
 it('waits a short moment so a multi-task share is gathered first',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,taskGrant(),true);
  await processDirectViewerShareNotices(env,{nowMs:Date.now(),send});
  expect(sent).toHaveLength(0);
 });
 it('a revoked or expired share sends nothing',async()=>{
  const {env,sent,send}=await fixture();
  const created=await share(env,taskGrant(),true);
  await revokeDirectViewerClientGrant({env,principal,grantId:created.grant.grantId,reason:'Mistake',idempotencyKey:key(),request});
  await share(env,{...taskGrant('task-two'),expiresAt:new Date(Date.now()+60_000).toISOString()},true);
  await processDirectViewerShareNotices(env,{nowMs:LATER,send});
  expect(sent).toHaveLength(0);
 });
 it('a failed send retries later, never inside the lease, and stops after three attempts',async()=>{
  const {env,sent}=await fixture();
  await share(env,taskGrant(),true);
  const failing=vi.fn(async()=>{throw new Error('smtp down');});
  await processDirectViewerShareNotices(env,{nowMs:LATER,send:failing});
  expect(failing).toHaveBeenCalledTimes(2);
  await processDirectViewerShareNotices(env,{nowMs:LATER+60_000,send:failing});
  expect(failing).toHaveBeenCalledTimes(2);
  await processDirectViewerShareNotices(env,{nowMs:LATER+16*60_000,send:failing});
  await processDirectViewerShareNotices(env,{nowMs:LATER+32*60_000,send:failing});
  expect(failing).toHaveBeenCalledTimes(6);
  const ok=vi.fn(async(_env:unknown,mail:OutboundMail)=>{sent.push(mail);});
  await processDirectViewerShareNotices(env,{nowMs:LATER+48*60_000,send:ok});
  expect(ok).not.toHaveBeenCalled();
 });
 it('a send failure for one person still delivers to the others',async()=>{
  const {env,sent}=await fixture();
  await share(env,taskGrant(),true);
  const flaky=vi.fn(async(_env:unknown,mail:OutboundMail)=>{if(mail.to==='bob@example.test')throw new Error('rejected');sent.push(mail);});
  await processDirectViewerShareNotices(env,{nowMs:LATER,send:flaky});
  expect(recipients(sent)).toEqual(['alice@example.test']);
  const ok=vi.fn(async(_env:unknown,mail:OutboundMail)=>{sent.push(mail);});
  await processDirectViewerShareNotices(env,{nowMs:LATER+16*60_000,send:ok});
  expect(recipients(sent)).toEqual(['alice@example.test','bob@example.test']);
 });
 it('does nothing while notification mail is switched off',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,taskGrant(),true);
  await processDirectViewerShareNotices({...env,SMTP_NOTIFICATIONS_ENABLED:'false'} as Env,{nowMs:LATER,send});
  expect(sent).toHaveLength(0);
 });
 it('gives up on a request older than two days instead of sending a stale email',async()=>{
  const {env,sent,send}=await fixture();
  await share(env,taskGrant(),true);
  await processDirectViewerShareNotices(env,{nowMs:Date.now()+3*24*60*60_000,send});
  expect(sent).toHaveLength(0);
 });
 it('offers the Email client box only while notification mail is on',()=>{
  expect(directViewerShareCapabilities({SMTP_NOTIFICATIONS_ENABLED:'true'} as Env)).toEqual(['notify_client_v1']);
  expect(directViewerShareCapabilities({SMTP_NOTIFICATIONS_ENABLED:'false'} as Env)).toEqual([]);
  expect(directViewerShareCapabilities({} as Env)).toEqual([]);
 });
});
