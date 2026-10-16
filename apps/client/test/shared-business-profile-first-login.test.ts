import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { splitD1MigrationStatements } from './helpers/d1-migrations';
import {blockBusinessProfileWorkspace,businessProfileAuthorityBatch,reserveBusinessProfileBulkLatch} from '../src/worker/client-portal/business-profile-fences';
import { resolveBusinessProfileProof } from '../src/worker/client-portal/business-profile';
import { readSharedProfilePortalAuthority } from '../src/worker/shared-profile-portal-authority-entrypoint';
const contextControl=vi.hoisted(()=>({beforeRead:null as null|(()=>Promise<void>),revoked:false}));
vi.mock('cloudflare:workers',()=>({WorkerEntrypoint:class{}}));
vi.mock('../src/worker/client-portal/workspace-v2',()=>({resolveNativePortalWorkspaceReadContext:async()=>{await contextControl.beforeRead?.();return contextControl.revoked?null:({workspaceId:'workspace',sourceId:'project-alpha:primary',identityId:'verified-identity',generationId:'generation',rootType:'organization',rootPublicId:'org',contextVersion:'a'.repeat(64)});},authorizeNativePortalReadTarget:async()=>true}));
let mf:Miniflare,db:D1Database;
beforeAll(async()=>{mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-06',d1Databases:['DB']});db=await mf.getD1Database('DB');
 for(const sql of splitD1MigrationStatements(readFileSync(new URL('../migrations/0232_shared_profile_edit_authority.sql',import.meta.url),'utf8')))await db.prepare(sql).run();
 await db.exec("UPDATE portal_shared_profile_runtime SET hooks_ready=1; CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,status TEXT,source_version TEXT); CREATE TABLE pa_portal_entitlement_intents(workspace_id TEXT,principal_public_id TEXT,scope_type TEXT,scope_public_id TEXT,effect TEXT,capability TEXT,status TEXT,valid_from TEXT,expires_at TEXT); CREATE TABLE portal_v2_identity_eligibility_bindings(workspace_id TEXT,principal_public_id TEXT,identity_id TEXT,principal_source_version TEXT); CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,public_id TEXT,active INTEGER,entity_type TEXT); CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,expires_at TEXT); CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,status TEXT,expires_at TEXT)");
 await db.exec("INSERT INTO pa_portal_principals VALUES('workspace','own-principal',NULL,'active','v1'); INSERT INTO pa_portal_principals VALUES('workspace','foreign-principal',NULL,'active','v1'); INSERT INTO portal_v2_identity_eligibility_bindings VALUES('workspace','own-principal','verified-identity','v1'); INSERT INTO pa_portal_entitlement_intents VALUES('workspace','own-principal','client','own-client','allow','directory.read','active',NULL,NULL); INSERT INTO pa_portal_entitlement_intents VALUES('workspace','foreign-principal','client','foreign-client','allow','directory.read','active',NULL,NULL); INSERT INTO portal_v2_directory_entities VALUES('workspace','generation','own-client',1,'client'); INSERT INTO portal_v2_directory_entities VALUES('workspace','generation','foreign-client',1,'client')");
 await db.exec("CREATE TABLE portal_v2_identities(id TEXT,issuer TEXT,subject TEXT,verified_email TEXT,status TEXT,revoked_at TEXT); CREATE TABLE portal_v2_workspaces(id TEXT,project_alpha_source_id TEXT,status TEXT); INSERT INTO portal_v2_identities VALUES('verified-identity','verified-issuer','verified-subject','login@example.test','active',NULL); INSERT INTO portal_v2_workspaces VALUES('workspace','project-alpha:primary','active')");
});afterAll(async()=>{await mf.dispose();});
it('uses the existing verified eligibility binding for first sign-in; never infers another client',async()=>{
 const bound:unknown[]=[];const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:async()=>({ok:true}),bindProfileIdentity:async(proof:unknown)=>{bound.push(proof);return{ok:true,bound:1};}}};
 const proof=await resolveBusinessProfileProof(env as never,{issuer:'verified-issuer',subject:'verified-subject',email:'login@example.test'},'workspace');
 expect(proof).not.toBeNull();expect(proof?.targets).toContainEqual({principalPublicId:'own-principal',scopeType:'client',publicId:'own-client'});
 expect(proof?.targets.some(target=>target.publicId==='foreign-client'||target.principalPublicId==='foreign-principal')).toBe(false);expect(bound).toHaveLength(1);
 expect(await db.prepare('SELECT revision,state FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind('workspace').first()).toEqual({revision:1,state:'active'});
});
it('reauthorizes queued dispatch from live identity without a browser JWT or new template binding',async()=>{
 const bind=vi.fn(async()=>({ok:true,bound:0}));const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:async()=>({ok:true}),bindProfileIdentity:bind}};
 const input={protocolVersion:1 as const,workspaceId:'workspace',sourceId:'project-alpha:primary',issuer:'verified-issuer',subject:'verified-subject',principalPublicId:'own-principal',scopeType:'client' as const,publicId:'own-client'};
 const result=await readSharedProfilePortalAuthority(env as never,input);expect(result.ok).toBe(true);
 if(result.ok){expect(result.proof.targets).toEqual([{principalPublicId:'own-principal',scopeType:'client',publicId:'own-client'}]);expect(Date.parse(result.proof.verifiedUntil)).toBeGreaterThan(Date.now());expect(Date.parse(result.proof.verifiedUntil)).toBeLessThanOrEqual(Date.now()+30_000);}
 expect(bind).not.toHaveBeenCalled();expect((await readSharedProfilePortalAuthority(env as never,{...input,publicId:'foreign-client'})).ok).toBe(false);
 await db.prepare("UPDATE portal_v2_identities SET status='revoked' WHERE id='verified-identity'").run();expect((await readSharedProfilePortalAuthority(env as never,input)).ok).toBe(false);
});

it('keeps the mirrored block pending across the real authority commit and denies concurrent proof reactivation',async()=>{
 await db.prepare("UPDATE portal_v2_identities SET status='active' WHERE id='verified-identity'").run();
 const activate=vi.fn(async()=>({ok:true}));const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:activate,bindProfileIdentity:async()=>({ok:true,bound:0})}};
 const receipt=await blockBusinessProfileWorkspace(env as never,'workspace','identity-revocation-fixture');
 activate.mockClear();
 const principal={issuer:'verified-issuer',subject:'verified-subject',email:'login@example.test'};
 expect(await resolveBusinessProfileProof(env as never,principal,'workspace')).toBeNull();expect(activate).not.toHaveBeenCalled();
 expect(await db.prepare("SELECT status FROM portal_v2_identities WHERE id='verified-identity'").first('status')).toBe('active');
 await businessProfileAuthorityBatch(db,[receipt],[db.prepare("UPDATE portal_v2_identities SET status='revoked' WHERE id='verified-identity'")]);
 expect(await db.prepare("SELECT pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='workspace'").first('pending_operation_id')).toBeNull();
 expect((await readSharedProfilePortalAuthority(env as never,{protocolVersion:1,workspaceId:'workspace',sourceId:'project-alpha:primary',issuer:principal.issuer,subject:principal.subject,principalPublicId:'own-principal',scopeType:'client',publicId:'own-client'})).ok).toBe(false);
});

it('denies concurrent proof resolution while bulk enumeration is latched even before individual head blocks',async()=>{
 const activate=vi.fn(async()=>({ok:true}));const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:activate,bindProfileIdentity:async()=>({ok:true,bound:0})}};
 const latch=await reserveBusinessProfileBulkLatch(env,'bulk-inflight-proof');
 expect(await resolveBusinessProfileProof(env as never,{issuer:'verified-issuer',subject:'verified-subject',email:'login@example.test'},'workspace')).toBeNull();
 expect(activate).not.toHaveBeenCalled();await businessProfileAuthorityBatch(db,[],[],latch);
});

it('SQL excludes a new head when an already-running resolver resumes after bulk enumeration starts',async()=>{
 const activate=vi.fn(async()=>({ok:true}));const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:activate,bindProfileIdentity:async()=>({ok:true,bound:0})}};
 let latch:Awaited<ReturnType<typeof reserveBusinessProfileBulkLatch>>=null;
 contextControl.beforeRead=async()=>{contextControl.beforeRead=null;latch=await reserveBusinessProfileBulkLatch(env,'bulk-paused-resolver');};
 try{expect(await resolveBusinessProfileProof(env as never,{issuer:'verified-issuer',subject:'verified-subject',email:'login@example.test'},'new-head-after-enumeration')).toBeNull();
  expect(activate).not.toHaveBeenCalled();expect(await db.prepare("SELECT 1 FROM portal_shared_profile_authority_heads WHERE workspace_id='new-head-after-enumeration'").first()).toBeNull();
 }finally{contextControl.beforeRead=null;await businessProfileAuthorityBatch(db,[],[],latch);}
});
it('rechecks committed live context after Ops activation before minting an in-flight proof',async()=>{
 await db.prepare("UPDATE portal_v2_identities SET status='active' WHERE id='verified-identity'").run();
 const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:{transitionAuthority:async(input:{state:string})=>{if(input.state==='active')contextControl.revoked=true;return{ok:true};},bindProfileIdentity:vi.fn(async()=>({ok:true,bound:0}))}};
 try{expect(await resolveBusinessProfileProof(env as never,{issuer:'verified-issuer',subject:'verified-subject',email:'login@example.test'},'workspace')).toBeNull();expect(env.SHARED_PROFILE_PORTAL.bindProfileIdentity).not.toHaveBeenCalled();}
 finally{contextControl.revoked=false;}
});
