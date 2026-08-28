import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {splitD1MigrationStatements} from './helpers/d1-migrations';
import {createWorkspaceInvitation,listWorkspaceAccess,type WorkspaceInvitationInput} from '../src/worker/client-portal/workspace-memberships';
import {acceptPortalWorkspaceInvitation,type PortalAuthorizationEnv} from '../src/worker/client-portal/workspace-v2';
import {invitationPublicationAllowed,invitationRequestsReady} from '../src/worker/client-portal/invitation-approval-policy';
import {prepareWorkspaceInvitationDecision,stageApprovedWorkspaceInvitation,publishApprovedWorkspaceInvitation,
 abandonStagedWorkspaceInvitation,reconcileExpiredWorkspaceInvitationApprovals,readWorkspaceInvitationRequest,
 readWorkspaceInvitationPolicyContext,applyWorkspaceInvitationPolicy,readWorkspaceInvitationReviewReplay,
 rejectWorkspaceInvitationRequest,cancelWorkspaceInvitationRequest,listWorkspaceInvitationRequests,listOwnWorkspaceInvitationRequests,
 type WorkspaceInvitationRequestView} from '../src/worker/client-portal/workspace-invitation-requests';
import {readProjectAccessTerms} from '../src/worker/client-portal/project-access-terms';

let mf:Miniflare,db:D1Database,env:PortalAuthorizationEnv,sequence=0;
const source='project-alpha:primary',issuer='https://approval-access.example.test';
const collaborator={kind:'collaborator',mode:'project_end',expiresAt:null} as const;
const authorization=()=>({id:crypto.randomUUID(),actorStaffId:'admin',fingerprint:'a'.repeat(64),publicationDeadline:new Date(Date.now()+240_000).toISOString()});
async function fixture(standalone=false){
 const n=++sequence,id=`approval-${n}`,generation=`generation-${n}`,root=`root-${n}`,project=`project-${n}`,identity=`manager-${n}`;
 const principal={issuer,subject:identity,email:`${identity}@example.test`};
 await db.batch([
  db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status) VALUES(?,?,?,?,?,'active')`)
   .bind(id,standalone?'standalone_client':'organization',standalone?null:root,standalone?root:null,id),
  db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)`).bind(generation,id,generation),
  db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`).bind(generation,id),
  db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,?,?,?,'r1')`).bind(id,generation,standalone?'standalone_client':'organization',root,root),
  db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'p1')`).bind(id,generation,project,root,project),
  db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
   VALUES(?,?,'root-project','contains',?,?,'project',?,'r1')`).bind(id,generation,standalone?'standalone_client':'organization',root,project),
  db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES(?,?,?,'active','p1')`).bind(id,generation,project),
  db.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status) VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(source,`receipt-${n}`,id,'a'.repeat(64)),
  db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(id,generation),
  db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)`).bind(identity,issuer,identity,principal.email),
  db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES(?,?,?,'operations')`).bind(`membership-${n}`,id,identity),
  ...['workspace.view','member.manage','delivery.view','request.create'].map(capability=>db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type) VALUES(?,?,?,?,'workspace',?,'operations')`).bind(`${n}-${capability}`,id,identity,capability,id)),
  db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id) VALUES(?,'require_approval',1,'admin')`).bind(id),
 ]);
 return {id,generation,root,project,identity,principal};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function submit(f:Fixture,scope:{type:'organization'|'department'|'client'|'project'|'workspace';publicId:string}={type:'project',publicId:f.project},key=crypto.randomUUID()){
 const result=await createWorkspaceInvitation(env,f.principal,f.id,{email:`guest-${f.id}@example.test`,capabilities:['delivery.view'],
  ...(scope.type==='workspace'?{organizationWide:true,confirmOrganizationWide:true}:{targetScope:{type:scope.type,publicId:scope.publicId}}),
  ...(scope.type==='project'?{accessTerms:collaborator}:{}),expectedInvitationPolicyVersion:1},key,{emailDeliveryAvailable:false});
 expect(['approval_requested','approval_replayed']).toContain(result.outcome);if(!('request' in result))throw new Error(JSON.stringify(result));return result.request;
}
async function stage(request:WorkspaceInvitationRequestView){
 const coordinates={sourceId:source,workspaceId:request.workspaceId,requestId:request.id};
 const preview=await prepareWorkspaceInvitationDecision(env,{...coordinates,decision:'approve'});expect(preview.canApprove).toBe(true);
 const auth=authorization(),input={...coordinates,expectedVersion:request.version,expectedPolicyVersion:preview.policyVersion,expectedContextVersion:preview.contextVersion,authorization:auth,idempotencyKey:crypto.randomUUID()};
 const result=await stageApprovedWorkspaceInvitation(env,input);return {auth,input,result};
}
async function count(table:string,workspaceId:string){return db.prepare(`SELECT count(*) n FROM ${table} WHERE workspace_id=?`).bind(workspaceId).first<number>('n');}
async function enrolledToken(invitationId:string){
 const payload=JSON.parse((await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(invitationId).first<string>('payload_json'))!) as {token:string};
 await db.prepare(`INSERT INTO portal_v2_invitation_access_enrollment_receipts(invitation_id,workspace_id,invited_email_hash,invitation_token_hash,
  enrollment_version,provider_receipt_hash,enrolled_at,expires_at) SELECT i.id,i.workspace_id,o.recipient_email_hash,i.token_hash,1,?,datetime('now'),i.expires_at
  FROM portal_v2_invitations i JOIN portal_v2_invitation_email_outbox o ON o.invitation_id=i.id WHERE i.id=?`).bind('p'.repeat(43),invitationId).run();
 return payload.token;
}
function beforeInvitationBatch(database:D1Database,action:()=>Promise<void>){
 let fired=false;const statements=new WeakMap<D1PreparedStatement,{raw:D1PreparedStatement;text:string}>();
 const statement=(raw:D1PreparedStatement,text:string):D1PreparedStatement=>{
  const proxy=new Proxy(raw,{get(target,name){if(name==='bind')return(...values:unknown[])=>statement(target.bind(...values),text);
   const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  statements.set(proxy,{raw,text});return proxy;
 };
 const wrap=<T extends D1Database|D1DatabaseSession>(raw:T):T=>new Proxy(raw,{get(target,name){
  if(name==='withSession'&&'withSession' in target)return(...args:Parameters<D1Database['withSession']>)=>wrap(target.withSession(...args));
  if(name==='prepare')return(text:string)=>statement(target.prepare(text),text);
  if(name==='batch')return async(batch:D1PreparedStatement[])=>{
   if(!fired&&batch.some(item=>/INSERT INTO portal_v2_invitations\b/.test(statements.get(item)?.text??''))){fired=true;await action();}
   return target.batch(batch.map(item=>statements.get(item)?.raw??item));
  };
  const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
 }});
 return wrap(database);
}
describe('workspace invitation approval: real migrated D1',{concurrent:false,timeout:60_000},()=>{
 beforeAll(async()=>{
  mf=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('approval')}}",d1Databases:['DB','EMPTY']});
  db=await mf.getD1Database('DB') as D1Database;
  const path=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(path).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)<='0164').sort())
   await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
  env={DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true',CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED:'true',PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true'};
  const old=await fixture();
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='allowed',version=2 WHERE workspace_id=?`).bind(old.id).run();
  const legacy=await createWorkspaceInvitation(env,old.principal,old.id,{email:'preserved@example.test',projectPublicId:old.project,capabilities:['delivery.view']},crypto.randomUUID());
  expect(legacy.outcome).toBe('created');
  const before=await db.prepare('SELECT * FROM portal_v2_invitations').all();
  expect(await invitationRequestsReady(db)).toBe(false);
  await db.batch(splitD1MigrationStatements(readFileSync(new URL('0165_workspace_invitation_approvals.sql',path),'utf8')).map(sql=>db.prepare(sql)));
  for(const name of readdirSync(path).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)>='0166'&&n.slice(0,4)<='0173').sort())
   await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
  expect((await db.prepare('SELECT * FROM portal_v2_invitations').all()).results).toEqual(before.results);
  expect(await invitationRequestsReady(db)).toBe(true);
 },180_000);
 afterAll(async()=>mf.dispose());
 it('keeps reads live while absent or false authority-mutation gates fail closed without writes',async()=>{
  const f=await fixture(),before=await count('portal_v2_invitations',f.id);
  const input:WorkspaceInvitationInput={email:`paused-${f.id}@example.test`,projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator};
  await expect(createWorkspaceInvitation({...env,PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:undefined},f.principal,f.id,input,crypto.randomUUID()))
    .rejects.toMatchObject({status:503});
  await expect(createWorkspaceInvitation({...env,PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'false'},f.principal,f.id,input,crypto.randomUUID()))
    .rejects.toMatchObject({status:503});
  expect(await count('portal_v2_invitations',f.id)).toBe(before);
  await expect(readWorkspaceInvitationPolicyContext(db,{sourceId:source,workspaceId:f.id}))
    .resolves.toMatchObject({workspaceId:f.id,policy:'require_approval'});
 });
 it('submits without email readiness and creates zero invitation, token, grants or outbox; same key replays',async()=>{
  const f=await fixture(),key=crypto.randomUUID(),before=await count('portal_v2_entitlements',f.id),r=await submit(f,undefined,key);
  expect(r.status).toBe('pending');expect(r.invitationId).toBeNull();expect(await count('portal_v2_invitations',f.id)).toBe(0);
  expect(await count('portal_v2_entitlements',f.id)).toBe(before);
  expect(await db.prepare(`SELECT count(*) n FROM portal_v2_invitation_email_outbox o JOIN portal_v2_invitations i ON i.id=o.invitation_id WHERE i.workspace_id=?`).bind(f.id).first('n')).toBe(0);
  expect((await submit(f,undefined,key)).id).toBe(r.id);
 });
 it('stages unsendable/unacceptable artifacts, then explicitly publishes exactly once',async()=>{
  const f=await fixture(),r=await submit(f),s=await stage(r);
  expect(s.result.request.status).toBe('approving');expect(s.result.request.version).toBe(2);
  const invitation=await db.prepare(`SELECT invitation_id FROM portal_workspace_invitation_approvals WHERE id=?`).bind(s.auth.id).first<string>('invitation_id');
  const payload=JSON.parse((await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?').bind(invitation).first<string>('payload_json'))!) as {token:string};
  expect(await invitationPublicationAllowed(db,invitation!)).toBe(false);
  const guest={issuer,subject:'guest-'+f.id,email:r.email};expect(await acceptPortalWorkspaceInvitation(env,guest,payload.token)).toBe('denied');
  await expect(db.prepare(`UPDATE portal_v2_invitation_email_outbox SET status='processing' WHERE invitation_id=?`).bind(invitation).run()).rejects.toThrow();
  const published=await publishApprovedWorkspaceInvitation(env,{authorizationId:s.auth.id});expect(published.status).toBe('approved');expect(published.version).toBe(3);
  expect(await invitationPublicationAllowed(db,invitation!)).toBe(true);
  expect(await acceptPortalWorkspaceInvitation(env,guest,payload.token)).toBe('denied'); // Approved invitations require the real receipt even with legacy flag off.
  await db.prepare(`INSERT INTO portal_v2_invitation_access_enrollment_receipts(invitation_id,workspace_id,invited_email_hash,invitation_token_hash,
    enrollment_version,provider_receipt_hash,enrolled_at,expires_at) SELECT i.id,i.workspace_id,o.recipient_email_hash,i.token_hash,1,?,datetime('now'),i.expires_at
    FROM portal_v2_invitations i JOIN portal_v2_invitation_email_outbox o ON o.invitation_id=i.id WHERE i.id=?`).bind('p'.repeat(43),invitation).run();
  expect(await acceptPortalWorkspaceInvitation(env,guest,payload.token)).toBe('accepted');
  expect((await stageApprovedWorkspaceInvitation(env,s.input)).replayed).toBe(true);
  expect((await publishApprovedWorkspaceInvitation(env,{authorizationId:s.auth.id})).version).toBe(3);
  expect((await readWorkspaceInvitationReviewReplay(db,{sourceId:source,workspaceId:f.id,requestId:r.id,action:'approve',authorizationId:s.auth.id,actorStaffId:'admin',idempotencyKey:s.input.idempotencyKey}))?.request?.status).toBe('approved');
 });
 it('preserves completion latch while pending and cannot restart access after reopening',async()=>{
  const f=await fixture(),r=await submit(f);
  await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z',source_version='p2' WHERE workspace_id=?`).bind(f.id).run();
  await db.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='p3' WHERE workspace_id=?`).bind(f.id).run();
  expect((await readProjectAccessTerms(db,r.accessTerms!.id))?.expired).toBe(true);
  const review=await prepareWorkspaceInvitationDecision(env,{sourceId:source,workspaceId:f.id,requestId:r.id,decision:'approve'});expect(review.canApprove).toBe(false);expect(review.request.status).toBe('stale');
 });
 it('rejects request publication after original inviter loses a requested capability',async()=>{
  const f=await fixture(),r=await submit(f),s=await stage(r);
  await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked' WHERE workspace_id=? AND capability='delivery.view'`).bind(f.id).run();
  await expect(publishApprovedWorkspaceInvitation(env,{authorizationId:s.auth.id})).rejects.toMatchObject({status:409});
  expect((await readWorkspaceInvitationRequest(db,{sourceId:source,workspaceId:f.id,requestId:r.id}))?.status).toBe('approving');
  expect((await abandonStagedWorkspaceInvitation(db,{authorizationId:s.auth.id},true))?.status).toBe('pending');
 });
 it('recovers an expired crashed stage without send, once, and permits a fresh review',async()=>{
  const f=await fixture(),r=await submit(f),s=await stage(r);
  expect(await reconcileExpiredWorkspaceInvitationApprovals(db,new Date(Date.now()+300_000),true)).toBeGreaterThan(0);
  const after=await readWorkspaceInvitationRequest(db,{sourceId:source,workspaceId:f.id,requestId:r.id});expect(after?.status).toBe('pending');expect(after?.version).toBe(3);
  await reconcileExpiredWorkspaceInvitationApprovals(db,new Date(Date.now()+300_000),true);
  expect((await readWorkspaceInvitationRequest(db,{sourceId:source,workspaceId:f.id,requestId:r.id}))?.version).toBe(3);
  expect(await db.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=(SELECT invitation_id FROM portal_workspace_invitation_approvals WHERE id=?)').bind(s.auth.id).first('payload_json')).toBe('{"redacted":true}');
  const fresh=await stage(after!);expect(fresh.result.request.status).toBe('approving');
 });
 it.each(['organization','department','client','workspace'] as const)('supports bounded %s requests with unlimited delegation and no fabricated terms',async(type)=>{
  const f=await fixture();let publicId=type==='workspace'?f.id:f.root;
  if(type==='department'||type==='client'){
   publicId=`${type}-${f.id}`;
   await db.batch([db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,?,?,?,?,'v1')`).bind(f.id,f.generation,type,publicId,f.root,publicId),
    db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version) VALUES(?,?,'root-child','contains','organization',?,?,?,'v1')`).bind(f.id,f.generation,f.root,type,publicId)]);
  }
  const r=await submit(f,{type,publicId});expect(r.accessTerms).toBeNull();expect((await stage(r)).result.request.status).toBe('approving');
 });
 it('supports standalone-client workspace requests without changing the root namespace',async()=>{
  const f=await fixture(true),r=await submit(f,{type:'workspace',publicId:f.id});expect((await stage(r)).result.request.status).toBe('approving');
 });
 it('does not delegate unlimited broad access from a finite manager',async()=>{
  const f=await fixture();await db.prepare(`UPDATE portal_v2_workspace_memberships SET expires_at=? WHERE workspace_id=?`).bind(new Date(Date.now()+86400_000).toISOString(),f.id).run();
  await expect(submit(f,{type:'organization',publicId:f.root})).rejects.toMatchObject({status:403});expect(await count('portal_workspace_invitation_requests',f.id)).toBe(0);
 });
 it('project-only managers receive only authorized scope options and own requests, not roster or invitations',async()=>{
  const f=await fixture();await db.prepare(`UPDATE portal_v2_entitlements SET scope_type='project',scope_public_id=? WHERE workspace_id=? AND capability='member.manage'`).bind(f.project,f.id).run();
  const r=await submit(f),access=await listWorkspaceAccess(env,f.principal,f.id);
  expect(access?.canManageMembers).toBe(false);expect(access?.members).toEqual([]);expect(access?.invitations).toEqual([]);
  expect(access?.inviteScopes.map(s=>s.publicId)).toEqual([f.project]);expect((await listOwnWorkspaceInvitationRequests(env,f.principal,f.id)).items.map(r=>r.id)).toEqual([r.id]);
 });
 it('stale policy requests remain rejectable but never auto-issue after Allowed',async()=>{
  const f=await fixture(),r=await submit(f),context=await readWorkspaceInvitationPolicyContext(db,{sourceId:source,workspaceId:f.id}),auth=authorization(),key=crypto.randomUUID();
  const changed=await applyWorkspaceInvitationPolicy(db,{sourceId:source,workspaceId:f.id,policy:'allowed',expectedVersion:1,expectedContextVersion:context.contextVersion,authorization:auth,idempotencyKey:key});expect(changed.policy.version).toBe(2);
  const review=await prepareWorkspaceInvitationDecision(env,{sourceId:source,workspaceId:f.id,requestId:r.id,decision:'approve'});expect(review.canApprove).toBe(false);
  const rejected=await rejectWorkspaceInvitationRequest(db,{sourceId:source,workspaceId:f.id,requestId:r.id,expectedVersion:r.version,expectedContextVersion:review.contextVersion,authorization:authorization(),idempotencyKey:crypto.randomUUID(),reason:'No longer needed — reviewed.'});expect(rejected.request.status).toBe('rejected');
  expect(await count('portal_v2_invitations',f.id)).toBe(0);
  await expect(createWorkspaceInvitation(env,f.principal,f.id,{email:'race@example.test',projectPublicId:f.project,capabilities:['delivery.view'],accessTerms:collaborator,expectedInvitationPolicyVersion:1},crypto.randomUUID())).rejects.toMatchObject({status:409});
 });
 it('cancels an owned staged request atomically, replays without a new version, and protects other owners',async()=>{
  const f=await fixture(),r=await submit(f),s=await stage(r),key=crypto.randomUUID();
  const result=await cancelWorkspaceInvitationRequest(env,f.principal,{workspaceId:f.id,requestId:r.id,expectedVersion:2,idempotencyKey:key});expect(result.request.status).toBe('cancelled');expect(result.request.version).toBe(3);
  expect((await cancelWorkspaceInvitationRequest(env,f.principal,{workspaceId:f.id,requestId:r.id,expectedVersion:2,idempotencyKey:key})).replayed).toBe(true);
  await expect(publishApprovedWorkspaceInvitation(env,{authorizationId:s.auth.id})).rejects.toMatchObject({status:409});
 });
 it('enforces source isolation, persistent request identity and no policy REPLACE bypass',async()=>{
  const f=await fixture(),r=await submit(f);
  expect(await readWorkspaceInvitationRequest(db,{sourceId:'project-alpha:other',workspaceId:f.id,requestId:r.id})).toBeNull();
  await expect(db.prepare(`UPDATE portal_workspace_invitation_requests SET recipient_email='stolen@example.test',version=version+1,status='cancelled' WHERE id=?`).bind(r.id).run()).rejects.toThrow();
  await expect(db.prepare(`DELETE FROM portal_workspace_invitation_requests WHERE id=?`).bind(r.id).run()).rejects.toThrow();
  await expect(db.prepare(`INSERT OR REPLACE INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id) VALUES(?,'allowed',1,'admin')`).bind(f.id).run()).rejects.toThrow();
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 });
 it('filters stale before LIMIT and returns pending work oldest first',async()=>{
  const f=await fixture(),one=await submit(f),two=await submit(f,undefined,crypto.randomUUID());
  const pending=await listWorkspaceInvitationRequests(db,{workspaceId:f.id,status:'open',limit:1});expect(pending.items[0]?.id).toBe(one.id);expect(pending.hasMore).toBe(true);
  expect((await listWorkspaceInvitationRequests(db,{workspaceId:f.id,status:'open',limit:1,after:pending.nextAfter!})).items[0]?.id).toBe(two.id);
  expect((await listWorkspaceInvitationRequests(db,{workspaceId:f.id,status:'stale'})).items).toEqual([]);
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='disabled',version=2 WHERE workspace_id=?`).bind(f.id).run();
  expect((await listWorkspaceInvitationRequests(db,{workspaceId:f.id,status:'pending'})).items).toEqual([]);
  expect((await listWorkspaceInvitationRequests(db,{workspaceId:f.id,status:'stale',limit:1})).items[0]?.status).toBe('stale');
 });
 it('a newly reviewed broad invitation replaces revoked older allows with a new version, without replay duplication',async()=>{
  const f=await fixture(),first=await submit(f,{type:'organization',publicId:f.root}),one=await stage(first),guest={issuer,subject:`renewed-${f.id}`,email:first.email};
  const issued=await publishApprovedWorkspaceInvitation(env,{authorizationId:one.auth.id});
  expect(await acceptPortalWorkspaceInvitation(env,guest,await enrolledToken(issued.invitationId!))).toBe('accepted');
  const identity=await db.prepare('SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,guest.subject).first<string>('id');
  await db.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=? AND source_type='client_invitation'`).bind(f.id,identity).run();
  const second=await submit(f,{type:'organization',publicId:f.root}),two=await stage(second),published=await publishApprovedWorkspaceInvitation(env,{authorizationId:two.auth.id});
  const token=await enrolledToken(published.invitationId!);expect(await acceptPortalWorkspaceInvitation(env,guest,token)).toBe('accepted');
  const grants=(await db.prepare(`SELECT capability,entitlement_version,access_terms_id FROM portal_v2_entitlements WHERE workspace_id=? AND identity_id=? AND status='active' ORDER BY capability`).bind(f.id,identity).all()).results;
  expect(grants).toEqual([{capability:'delivery.view',entitlement_version:2,access_terms_id:null},{capability:'workspace.view',entitlement_version:2,access_terms_id:null}]);
  const before=await count('portal_v2_entitlements',f.id);expect(await acceptPortalWorkspaceInvitation(env,guest,token)).toBe('replayed');expect(await count('portal_v2_entitlements',f.id)).toBe(before);
 });
 it('does not accept a primary reinvitation through an inactive local membership',async()=>{
  for(const state of ['suspended','revoked','expired'] as const){
   const f=await fixture(),first=await submit(f,{type:'organization',publicId:f.root}),one=await stage(first);
   const guest={issuer,subject:`inactive-${state}-${f.id}`,email:first.email};
   const issued=await publishApprovedWorkspaceInvitation(env,{authorizationId:one.auth.id});
   expect(await acceptPortalWorkspaceInvitation(env,guest,await enrolledToken(issued.invitationId!))).toBe('accepted');
   const identity=await db.prepare('SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?').bind(issuer,guest.subject).first<string>('id');
   if(state==='suspended')await db.prepare(`UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE workspace_id=? AND identity_id=?`).bind(f.id,identity).run();
   if(state==='revoked')await db.prepare(`UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?`).bind(f.id,identity).run();
   if(state==='expired')await db.prepare(`UPDATE portal_v2_workspace_memberships SET expires_at=datetime('now','-1 minute') WHERE workspace_id=? AND identity_id=?`).bind(f.id,identity).run();
   const second=await submit(f,{type:'organization',publicId:f.root}),two=await stage(second);
   const replacement=await publishApprovedWorkspaceInvitation(env,{authorizationId:two.auth.id});
   expect(await acceptPortalWorkspaceInvitation(env,guest,await enrolledToken(replacement.invitationId!))).toBe('denied');
   expect(await db.prepare('SELECT status FROM portal_v2_invitations WHERE id=?').bind(replacement.invitationId).first('status')).toBe('pending');
  }
 },180_000);
 it('keeps one key identity across request/direct policy changes even for old clients omitting the reviewed version',async()=>{
  const f=await fixture(),key=crypto.randomUUID(),input={email:'old-client@example.test',organizationWide:true,confirmOrganizationWide:true,capabilities:['delivery.view'] as const};
  const body={...input,capabilities:[...input.capabilities]};
  const first=await createWorkspaceInvitation(env,f.principal,f.id,body,key);expect(first.outcome).toBe('approval_requested');
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='allowed',version=2 WHERE workspace_id=?`).bind(f.id).run();
  expect((await createWorkspaceInvitation(env,f.principal,f.id,body,key,{emailDeliveryAvailable:false})).outcome).toBe('approval_replayed');
  expect(await count('portal_v2_invitations',f.id)).toBe(0);
  const issuedKey=crypto.randomUUID(),issued=await createWorkspaceInvitation(env,f.principal,f.id,body,issuedKey);expect(issued.outcome).toBe('created');
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='require_approval',version=3 WHERE workspace_id=?`).bind(f.id).run();
  expect((await createWorkspaceInvitation(env,f.principal,f.id,body,issuedKey)).outcome).toBe('replayed');
  expect(await count('portal_workspace_invitation_requests',f.id)).toBe(1);expect(await count('portal_v2_invitations',f.id)).toBe(1);
  await expect(db.prepare(`INSERT INTO portal_workspace_invitation_request_commands(workspace_id,actor_id,idempotency_key,operation,request_hash,request_id,result_json)
    SELECT workspace_id,actor_id,?,'submit',request_hash,request_id,'{}' FROM portal_workspace_invitation_request_commands WHERE workspace_id=? AND actor_id=? AND idempotency_key=?`)
    .bind(issuedKey,f.id,f.identity,key).run()).rejects.toThrow();
 });
 it('atomically rolls back an in-flight direct invitation when a policy-flip request wins the same key',async()=>{
  const f=await fixture(),key=crypto.randomUUID(),body={email:'cross-lane-race@example.test',organizationWide:true,confirmOrganizationWide:true,capabilities:['delivery.view' as const]};
  await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='allowed',version=2 WHERE workspace_id=?`).bind(f.id).run();
  const racedEnv={...env,DELIVERY_DB:beforeInvitationBatch(db,async()=>{
   await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='require_approval',version=3 WHERE workspace_id=?`).bind(f.id).run();
   expect((await createWorkspaceInvitation(env,f.principal,f.id,body,key)).outcome).toBe('approval_requested');
   await db.prepare(`UPDATE portal_workspace_invitation_policies SET policy='allowed',version=4 WHERE workspace_id=?`).bind(f.id).run();
  })};
  expect((await createWorkspaceInvitation(racedEnv,f.principal,f.id,body,key)).outcome).toBe('approval_replayed');
  expect(await count('portal_v2_invitations',f.id)).toBe(0);expect(await count('portal_workspace_invitation_requests',f.id)).toBe(1);
 });
 it('concurrent publication of the same authorization reads the exact winner without duplicate audit or invitation',async()=>{
  const f=await fixture(),request=await submit(f),prepared=await stage(request);
  const results=await Promise.all([publishApprovedWorkspaceInvitation(env,{authorizationId:prepared.auth.id}),publishApprovedWorkspaceInvitation(env,{authorizationId:prepared.auth.id})]);
  expect(results.map(r=>r.status)).toEqual(['approved','approved']);expect(results[0]?.invitationId).toBe(results[1]?.invitationId);
  expect(await count('portal_v2_invitations',f.id)).toBe(1);
  expect(await db.prepare(`SELECT count(*) n FROM portal_workspace_invitation_request_audit WHERE request_id=? AND action='request.approved'`).bind(request.id).first('n')).toBe(1);
 });
 it('keeps the existing ten-per-hour limit for new request keys but never charges replay',async()=>{
  const f=await fixture(),key=crypto.randomUUID(),request=await submit(f,undefined,key);
  expect(await db.prepare(`SELECT request_count n FROM portal_v2_invitation_rate_limits WHERE workspace_id=? AND actor_identity_id=?`).bind(f.id,f.identity).first('n')).toBe(1);
  await db.prepare(`UPDATE portal_v2_invitation_rate_limits SET request_count=10 WHERE workspace_id=? AND actor_identity_id=?`).bind(f.id,f.identity).run();
  expect((await submit(f,undefined,key)).id).toBe(request.id);
  await expect(submit(f)).rejects.toMatchObject({status:429});
  expect(await count('portal_workspace_invitation_requests',f.id)).toBe(1);
  expect(await db.prepare(`SELECT request_count n FROM portal_v2_invitation_rate_limits WHERE workspace_id=? AND actor_identity_id=?`).bind(f.id,f.identity).first('n')).toBe(10);
 });
});
