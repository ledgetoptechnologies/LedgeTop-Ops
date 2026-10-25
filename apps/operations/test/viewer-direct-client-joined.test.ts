import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {Server} from 'node:http';
import {Miniflare} from 'miniflare';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ViewerServiceError} from '@ltds/shared';
import type {Env} from '../src/worker/types';
import type {Env as ClientEnv} from '../../client/src/worker/types';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';

// Adapter boundaries only: transport, staff authentication/ACL, grant mutations,
// issuer, receipts and SQL migrations below are their real implementations.
const boundary=vi.hoisted(()=>({proof:vi.fn(),context:vi.fn(),catalog:vi.fn(),createSession:vi.fn(),revoke:vi.fn()}));
vi.mock('../../client/src/worker/project-alpha-portal-authority',async original=>({
 ...await original<typeof import('../../client/src/worker/project-alpha-portal-authority')>(),
 readPortalProjectionSourceProof:boundary.proof,portalProjectionSourceGuard:()=>({sql:'1=1',bindings:[]})}));
vi.mock('../../client/src/worker/client-portal/workspace-v2',async original=>({
 ...await original<typeof import('../../client/src/worker/client-portal/workspace-v2')>(),
 resolveNativePortalWorkspaceReadContext:boundary.context}));
vi.mock('../src/worker/viewer-integration',async original=>({
 ...await original<typeof import('../src/worker/viewer-integration')>(),viewerServiceClient:()=>({
  clientDeliveryCatalog:boundary.catalog,createSession:boundary.createSession,revokePublishedSessionSourceAuthorization:boundary.revoke})}));
import {registerViewerProcessingRoutes} from '../src/worker/viewer-processing';
import {readDirectViewerClientGrants} from '../src/worker/viewer-direct-client-grants';
import {issueDirectClientViewerSession,listDirectClientViewerItems} from '../src/worker/viewer-direct-client-session-issuer';
import {createNativePortalWorkspaceRouter} from '../../client/src/worker/client-portal/native-portal-resources';

const viewerRequire=createRequire(new URL('../../viewer/package.json',import.meta.url));
const express=viewerRequire('express');
const {createClientGrantProxy}=viewerRequire('./server/clientGrantProxy.js');
const instances:Miniflare[]=[],servers:Server[]=[];
const secret='joined-synthetic-viewer-signing-secret-32-characters';
const publicPath='/api/v1/workspace/direct-client-grants';
const browserPrincipal={issuer:'https://access.example.test',subject:'client-subject-one',email:'synthetic@example.test'};
const context={sourceId:'project-alpha:primary',workspaceId:'workspace-one',identityId:'identity-one',contextVersion:'a'.repeat(64),
 displayName:'Synthetic Client One',workspace:{membership_expires_at:null},grants:[],denials:[]};
const task={id:'task-one',displayName:'Property map',modelId:'model-one',modelVersionId:'version-one',modelTitle:'Model one',publishedAt:'2026-10-01T00:00:00Z'};
const taskGrant={sourceId:context.sourceId,workspaceId:context.workspaceId,viewerProjectId:'viewer-project',taskId:task.id,
 scopeType:'task',includeFuturePublished:false,confirmedScope:true,expiresAt:null,permissions:{measure:true,cameras:false,download:false}};
beforeEach(()=>{
 vi.resetAllMocks();boundary.proof.mockResolvedValue({sourceId:context.sourceId});boundary.context.mockResolvedValue(context);
 boundary.catalog.mockImplementation(async(input:{projectId:string;taskId?:string})=>{
  if(input.projectId!=='viewer-project'||input.taskId&&input.taskId!==task.id)throw new ViewerServiceError('Not published','not_found');
  return {schemaVersion:1,project:{id:'viewer-project',displayName:'Property survey'},tasks:[task],nextCursor:null};});
 boundary.createSession.mockResolvedValue({grant:'viewer-session-one',grantExpiresAt:new Date(Date.now()+120_000).toISOString(),
  sessionTtlSeconds:1800,redeemUrl:'https://viewer.example.test/redeem',embedUrl:'https://viewer.example.test/session'});
 boundary.revoke.mockResolvedValue({sourceAuthorization:{type:'direct_client_grant',id:'unused',version:1},revokedGrants:1,revokedSessions:1});
});
afterEach(async()=>{
 await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));
 await Promise.all(instances.splice(0).map(instance=>instance.dispose()));
});
async function fixture(){
 const mf=new Miniflare({compatibilityDate:'2026-08-06',modules:true,script:"export default {fetch(){return new Response('ok')}}",
  d1Databases:{OPS_DB:'joined-viewer-ops',DELIVERY_DB:'joined-viewer-delivery'}});instances.push(mf);
 const ops=await mf.getD1Database('OPS_DB') as unknown as D1Database,delivery=await mf.getD1Database('DELIVERY_DB') as unknown as D1Database;
 await ops.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,project_alpha_user_id TEXT,status TEXT);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE viewer_event_nonces(key_id TEXT,nonce TEXT,expires_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(key_id,nonce));
 CREATE TABLE viewer_workspace_client_grant_rate_limits(window_start TEXT PRIMARY KEY,request_count INTEGER CHECK(request_count>=1));
 CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER,display_name TEXT);
 INSERT INTO staff_users VALUES('staff-one','staff@example.test','Real rehydrated staff','access-subject-one',NULL,'active');
 INSERT INTO staff_role_assignments VALUES('staff-one','viewer-manager','global',NULL);
 INSERT INTO role_permissions VALUES('viewer-manager','viewer.view'),('viewer-manager','viewer.manage');
 INSERT INTO pa_connectors VALUES('project-alpha:primary',1,'Drone Services'),('project-alpha:secondary',1,'Technologies');`.replace(/\s*\n\s*/g,' '));
 await delivery.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT,
 root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),pa_organization_public_id TEXT,pa_client_public_id TEXT);
 CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT);
 CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER);
 CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER);
 CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT);
 CREATE TABLE portal_client_authority_workspace_claims(workspace_id TEXT,state TEXT);
 CREATE TABLE viewer_session_issuance_receipts(actor_id TEXT,audience TEXT,idempotency_key TEXT,request_fingerprint TEXT,response_json TEXT,expires_at TEXT,
 PRIMARY KEY(actor_id,audience,idempotency_key));
 INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Synthetic Client One','standalone_client',NULL,'client-one'),
 ('workspace-two','project-alpha:secondary',NULL,'active','Synthetic Client Two','standalone_client',NULL,'client-two');
 INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary'),('workspace-two','project-alpha:secondary');
 INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',1),('workspace-two','generation-two',1);
 INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1),('generation-two','workspace-two','active',1);
 INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','standalone_client','client-one','v1',1,'Synthetic Client One'),
 ('workspace-two','generation-two','standalone_client','client-two','v1',1,'Synthetic Client Two');`.replace(/\s*\n\s*/g,' '));
 for(const name of ['0237_viewer_direct_client_grants.sql','0238_viewer_direct_session_intents.sql']){
  const sql=readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),'utf8');
  await delivery.batch(splitD1MigrationStatements(sql).map(statement=>delivery.prepare(statement)));
 }
 const env={OPS_DB:ops,DELIVERY_DB:delivery,VIEWER_INTEGRATION_ENABLED:'true',CLIENT_VIEWER_SESSION_ISSUER_ENABLED:'true',
  VIEWER_EVENT_KEY_ID:'viewer-v1',VIEWER_EVENT_HMAC_SECRET:secret,VIEWER_SERVICE_HMAC_SECRET:secret,INCOMING_EXPECTED_HOST:'incoming.example.test'} as unknown as Env;
 const machine=new Hono<any>();
 // Match the production worker's JSON HTTP-error boundary, without replacing
 // authentication or any route handler. The Viewer proxy requires JSON errors.
 machine.onError((error,c)=>{if(error instanceof HTTPException)return c.json({error:error.message},error.status);throw error;});
 registerViewerProcessingRoutes(machine);
 const execution={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
 let replaySigned:(()=>ReturnType<typeof machine.fetch>)|undefined,tamper=false;
 const proxy=express();proxy.use(express.json());
 createClientGrantProxy({config:{opsAutomationBaseUrl:'https://incoming.example.test',viewerEventSecret:secret,viewerEventKeyId:'viewer-v1'},
  authorize:(permission:string)=>(req:any,_res:any,next:()=>void)=>{
   expect(permission).toBe('viewer.client_grants.manage');req.adminPrincipal={subject:'ops:staff-one'};next();},diagnostic(){},
  fetchImpl:async(url:URL,init:RequestInit)=>{
   const signed=new Request(url,init),original=signed.clone();
   // Node's cloned Request has no Cloudflare cf metadata; adapt that test boundary
   // to Hono's generated Workers Request generic without changing any bytes.
   replaySigned=()=>machine.fetch(original.clone() as unknown as Parameters<typeof machine.fetch>[0],env,execution);
   if(tamper)signed.headers.set('X-LTDS-Viewer-Signature','0'.repeat(64));
   return machine.fetch(signed,env,execution);
  }}).mount(proxy);
 const server=await new Promise<Server>(resolve=>{const server=proxy.listen(0,'127.0.0.1',()=>resolve(server));});servers.push(server);
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test listener');
 const request=(path=publicPath,{method='GET',body,key='joined-viewer-idempotency-0001'}:{method?:string;body?:unknown;key?:string}={})=>fetch(`http://127.0.0.1:${address.port}${path}`,{
  method,headers:{'Content-Type':'application/json','Idempotency-Key':key},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const portal=new Hono<any>();portal.use('*',async(c,next)=>{c.set('clientPrincipal',browserPrincipal);await next();});
 portal.route('/api/client/v2/workspaces',createNativePortalWorkspaceRouter());
 const clientEnv={...env,CLIENT_VIEWER_ENABLED:'true',CLIENT_PORTAL_ORIGIN:'https://portal.example.test',CLIENT_PORTAL_ORIGINS:'https://portal.example.test',
  VIEWER_SESSION_ISSUER:{listDirectClientViewerItems:(input:any)=>listDirectClientViewerItems(env,input),
   issueDirectClientViewerSession:(input:any)=>issueDirectClientViewerSession(env,input)}} as unknown as ClientEnv;
 const client=(path:string,init?:RequestInit)=>portal.request(`https://portal.example.test/api/client/v2/workspaces/workspace-one${path}`,init,clientEnv);
 return {ops,delivery,env,request,client,setTamper(value:boolean){tamper=value;},
  replay:()=>{if(!replaySigned)throw new Error('No signed request');return replaySigned();}};
}
describe('joined direct Viewer transport, native Client RPC and real D1 authority',()=>{
 it('creates through signed Viewer transport and exposes only the recipient exact task through the native Client issuer',async()=>{
  const f=await fixture();const created=await f.request(publicPath,{method:'POST',body:{grant:taskGrant}});
  expect(created.status).toBe(201);const {grant}=await created.json() as any;
  expect(grant).toMatchObject({sourceId:context.sourceId,workspaceId:context.workspaceId,taskId:task.id,scopeType:'task'});
  expect(await f.delivery.prepare('SELECT created_by_staff_id FROM viewer_direct_client_grants').first<string>('created_by_staff_id')).toBe('staff-one');
  expect(await readDirectViewerClientGrants(f.env,{sourceId:'project-alpha:secondary',workspaceId:'workspace-two'})).toHaveLength(0);
  const list=await f.request(publicPath+'?q=Synthetic&viewerProjectId=viewer-project');expect(list.status).toBe(200);
  expect((await list.json() as any).grants).toHaveLength(1);
  const clientList=await f.client('/viewer');expect(clientList.status).toBe(200);
  expect((await clientList.json() as any).items).toMatchObject([{taskId:task.id,grantId:grant.grantId}]);
  const open=(taskId:string)=>f.client(`/viewer/${grant.grantId}/tasks/${taskId}/session`,{method:'POST',headers:{Origin:'https://portal.example.test',
   'Content-Type':'application/json','Idempotency-Key':'joined-client-session-0001'},body:JSON.stringify({displayUnits:'imperial'})});
  expect((await open('task-sibling')).status).toBe(404);expect(boundary.createSession).not.toHaveBeenCalled();
  expect((await open(task.id)).status).toBe(201);expect(boundary.createSession).toHaveBeenCalledWith(expect.objectContaining({
   subject:'client:identity-one',sourceAuthorization:{type:'direct_client_grant',id:grant.grantId,version:1},
   permissions:{view:true,measure:true,cameras:false,download:false,personalMeasurements:true}}));
  expect(await f.delivery.prepare('SELECT count(*) n FROM viewer_direct_client_session_intents').first<number>('n')).toBe(1);
  expect(await f.delivery.prepare('SELECT count(*) n FROM viewer_session_issuance_receipts').first<number>('n')).toBe(1);
  expect(await f.delivery.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('projects','portal_v2_entitlements','viewer_model_associations')").first<number>('n')).toBe(0);
 });
 it('rejects tampered HMAC and replayed machine nonces before new grant writes, and rehydrates current staff status',async()=>{
  const f=await fixture();f.setTamper(true);
  expect((await f.request(publicPath,{method:'POST',body:{grant:taskGrant}})).status).toBe(401);
  expect(await f.delivery.prepare('SELECT count(*) n FROM viewer_direct_client_grants').first<number>('n')).toBe(0);
  expect(await f.ops.prepare('SELECT count(*) n FROM viewer_event_nonces').first<number>('n')).toBe(0);
  f.setTamper(false);expect((await f.request(publicPath,{method:'POST',body:{grant:taskGrant}})).status).toBe(201);
  expect((await f.replay()).status).toBe(409);
  expect(await f.delivery.prepare('SELECT count(*) n FROM viewer_direct_client_grant_audit').first<number>('n')).toBe(1);
  await f.ops.prepare("UPDATE staff_users SET status='inactive' WHERE id='staff-one'").run();
  expect((await f.request()).status).toBe(403);
 });
 it('shares the whole Viewer project without a PA project and dynamically includes later publication',async()=>{
  const f=await fixture(),projectGrant={...taskGrant,scopeType:'project',taskId:null,includeFuturePublished:true};
  boundary.catalog.mockResolvedValue({schemaVersion:1,project:{id:'viewer-project',displayName:'Property survey'},tasks:[],nextCursor:null});
  expect((await f.request(publicPath,{method:'POST',body:{grant:projectGrant}})).status).toBe(201);
  expect((await (await f.client('/viewer')).json() as any).items).toEqual([]);
  boundary.catalog.mockResolvedValue({schemaVersion:1,project:{id:'viewer-project',displayName:'Property survey'},tasks:[task,{...task,id:'future-task',displayName:'Later flight'}],nextCursor:null});
  expect((await (await f.client('/viewer')).json() as any).items.map((item:any)=>item.taskId)).toEqual(['task-one','future-task']);
  boundary.catalog.mockResolvedValueOnce({schemaVersion:1,project:{id:'viewer-project',displayName:'Property survey'},tasks:[task],nextCursor:null});
  const wrong=await f.request(publicPath,{method:'POST',key:'joined-wrong-recipient-01',body:{grant:{...taskGrant,workspaceId:'workspace-two'}}});
  expect(wrong.status).toBe(409);expect(await wrong.json()).toMatchObject({code:'relationship_missing'});
 });
 it('propagates pending202 and completed200 revocation across the real signed bridge and denies local reads immediately',async()=>{
  const f=await fixture();const {grant}=await (await f.request(publicPath,{method:'POST',body:{grant:taskGrant}})).json() as any;
  boundary.revoke.mockRejectedValueOnce(new Error('Controlled remote outage'));
  const revoke=()=>f.request(`${publicPath}/${grant.grantId}`,{method:'DELETE',key:'joined-revoke-key-0001',body:{reason:'Synthetic owner revoke'}});
  const pending=await revoke();expect(pending.status).toBe(202);expect(await pending.json()).toMatchObject({sessionRevocation:{pending:true}});
  expect(await readDirectViewerClientGrants(f.env,{sourceId:context.sourceId,workspaceId:context.workspaceId})).toHaveLength(0);
  expect((await (await f.client('/viewer')).json() as any).items).toEqual([]);
  const completed=await revoke();expect(completed.status).toBe(200);expect(await completed.json()).toMatchObject({replayed:true,sessionRevocation:{pending:false}});
  expect(boundary.revoke).toHaveBeenCalledTimes(2);expect(boundary.revoke).toHaveBeenLastCalledWith(expect.objectContaining({
   sourceAuthorization:{type:'direct_client_grant',id:grant.grantId,version:1}}));
  expect(await f.delivery.prepare('SELECT status,attempts FROM viewer_direct_client_grant_revocations').first()).toEqual({status:'complete',attempts:2});
 });
});
