export {blockBusinessProfileWorkspace,blockBusinessProfileSource,blockBusinessProfileIdentity} from './business-profile-fences';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Env } from '../types';
import type { VerifiedClientPrincipal } from './types';
import { authorizeNativePortalReadTarget,resolveNativePortalWorkspaceReadContext } from './workspace-v2';
import { clientPortalRequestOriginAllowed } from '../origin-policy';
import { readBoundedClientJson } from '../bounded-json';
import type { SharedProfilePortalBinding,SharedProfilePortalProof,SharedProfilePortalResult,SharedProfileTarget } from '../../../../../packages/shared/src/shared-business-profile';

export type SharedProfileClientEnvironment=Env & {SHARED_PROFILE_PORTAL?:SharedProfilePortalBinding};
type Head={workspace_id:string;source_id:string;revision:number;state:'active'|'blocked';operation_id:string;pending_operation_id:string|null};
type Bindings={Bindings:SharedProfileClientEnvironment;Variables:{clientPrincipal:VerifiedClientPrincipal}};
const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const update=z.object({grantId:z.string().uuid(),expectedVersion:z.number().int().positive(),mutationId:z.string().uuid(),profile:z.record(z.string(),z.string().max(1000)).refine(v=>Object.keys(v).length<=10)}).strict();
async function hooksReady(env:SharedProfileClientEnvironment):Promise<boolean>{
 try{return !!env.SHARED_PROFILE_PORTAL&&!!await env.DELIVERY_DB.prepare('SELECT 1 FROM portal_shared_profile_runtime WHERE id=1 AND hooks_ready=1').first();}catch{return false;}
}

export async function resolveBusinessProfileProof(env:SharedProfileClientEnvironment,principal:VerifiedClientPrincipal,workspaceId:string,options:{bindTemplates?:boolean}={}):Promise<SharedProfilePortalProof|null>{
 if(!await hooksReady(env))return null;
 if(await env.DELIVERY_DB.prepare('SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id IS NOT NULL').first())return null;
 const db=env.DELIVERY_DB.withSession('first-primary');
 const context=await resolveNativePortalWorkspaceReadContext(env,principal,workspaceId);if(!context)return null;
 let head=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
 if(!head){
  // Reserve locally before registering in Ops. A concurrent revocation then
  // sees this head and must fence Ops before it can change Delivery authority.
  const initialId=crypto.randomUUID();
  try{await db.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,?,1,'blocked',?)").bind(workspaceId,context.sourceId,initialId).run();}catch{return null;}
  const registered=await env.SHARED_PROFILE_PORTAL!.transitionAuthority({protocolVersion:1,operationId:initialId,workspaceId,sourceId:context.sourceId,expectedRevision:0,revision:1,state:'blocked'});
  // An owner may have already registered a blocked template head in Ops.
  // The expected-revision activation below verifies that exact head safely.
  head=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
  if(!head)return null;
 }
 const priorRevision=head.revision,revision=head.revision,operationId=crypto.randomUUID();
 if(head&&(head.source_id!==context.sourceId||head.pending_operation_id))return null;
 if(head.revision===1&&head.state==='blocked'){
  // Replay an interrupted first registration. If Ops already advanced, its
  // normal expected-revision check below remains authoritative.
  await env.SHARED_PROFILE_PORTAL!.transitionAuthority({protocolVersion:1,operationId:head.operation_id,workspaceId,sourceId:head.source_id,expectedRevision:0,revision:1,state:'blocked'});
 }
 // Read the exact principal/public-client entitlement relation. Email is never a client identifier.
 const rows=(await db.prepare(`SELECT DISTINCT p.public_id principalPublicId,i.scope_type scopeType,i.scope_public_id publicId
 FROM pa_portal_principals p JOIN pa_portal_entitlement_intents i ON i.workspace_id=p.workspace_id AND i.principal_public_id=p.public_id
 LEFT JOIN portal_v2_identity_eligibility_bindings eligibility ON eligibility.workspace_id=p.workspace_id
   AND eligibility.principal_public_id=p.public_id AND eligibility.identity_id=? AND eligibility.principal_source_version=p.source_version
 JOIN portal_v2_directory_entities e ON e.workspace_id=p.workspace_id AND e.generation_id=? AND e.public_id=i.scope_public_id AND e.active=1
 WHERE p.workspace_id=? AND (p.identity_id=? OR (p.identity_id IS NULL AND eligibility.identity_id=?)) AND p.status='active' AND i.status='active' AND i.effect='allow'
 AND i.capability IN('workspace.view','directory.read') AND i.scope_type='client' AND e.entity_type IN('client','standalone_client')
 AND (i.valid_from IS NULL OR datetime(i.valid_from)<=datetime('now')) AND (i.expires_at IS NULL OR datetime(i.expires_at)>datetime('now'))
 ORDER BY p.public_id,i.scope_public_id LIMIT 65`).bind(context.identityId,context.generationId,workspaceId,context.identityId,context.identityId).all<SharedProfileTarget>()).results;
 if(rows.length>64)return null;const targets:SharedProfileTarget[]=[];
 for(const row of rows)if(await authorizeNativePortalReadTarget(env,context,'directory.read',{scopeType:'client',publicId:row.publicId}))targets.push(row);
 // This is only a target witness. An explicit owner-issued organization edit
 // grant in Ops is still required; workspace membership grants no profile edit.
 if(context.rootType==='organization'){
  const principals=(await db.prepare(`SELECT p.public_id FROM pa_portal_principals p LEFT JOIN portal_v2_identity_eligibility_bindings eligibility
   ON eligibility.workspace_id=p.workspace_id AND eligibility.principal_public_id=p.public_id AND eligibility.identity_id=? AND eligibility.principal_source_version=p.source_version
   WHERE p.workspace_id=? AND (p.identity_id=? OR (p.identity_id IS NULL AND eligibility.identity_id=?)) AND p.status='active' ORDER BY p.public_id LIMIT 65`)
   .bind(context.identityId,workspaceId,context.identityId,context.identityId).all<{public_id:string}>()).results;
  if(principals.length>64)return null;for(const p of principals)targets.push({principalPublicId:p.public_id,scopeType:'organization',publicId:context.rootPublicId});
 }
 if(targets.length>64)return null;
 const after=await resolveNativePortalWorkspaceReadContext(env,principal,workspaceId);if(after?.contextVersion!==context.contextVersion)return null;
 const expiration=await db.prepare(`SELECT MIN(expires_at) expires_at FROM (
  SELECT datetime(expires_at) expires_at FROM portal_v2_workspace_memberships WHERE workspace_id=? AND identity_id=? AND status='active' AND expires_at IS NOT NULL
  UNION ALL SELECT datetime(expires_at) FROM portal_v2_entitlements WHERE workspace_id=? AND identity_id=? AND status='active' AND expires_at IS NOT NULL)`)
  .bind(workspaceId,context.identityId,workspaceId,context.identityId).first<{expires_at:string|null}>();
 const now=Date.now(),expiry=expiration?.expires_at?Date.parse(expiration.expires_at.replace(' ','T')+'Z'):now+30_000;
 const deadline=Math.min(now+30_000,expiry);if(!Number.isFinite(deadline)||deadline<=now)return null;
 const active=await env.SHARED_PROFILE_PORTAL!.transitionAuthority({protocolVersion:1,operationId,workspaceId,sourceId:context.sourceId,
  expectedRevision:priorRevision,revision,state:'active'});if(!active.ok)return null;
 if(head){const result=await db.prepare("UPDATE portal_shared_profile_authority_heads SET state='active',operation_id=? WHERE workspace_id=? AND revision=? AND pending_operation_id IS NULL AND NOT EXISTS(SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id IS NOT NULL)").bind(operationId,workspaceId,revision).run();if(result.meta.changes!==1)return null;}
 const committedContext=await resolveNativePortalWorkspaceReadContext(env,principal,workspaceId);if(committedContext?.contextVersion!==context.contextVersion)return null;
 head=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
 if(!head||head.revision!==revision||head.state!=='active'||head.pending_operation_id)return null;
 if(await db.prepare('SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id IS NOT NULL').first())return null;
 const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId:context.sourceId,issuer:principal.issuer,subject:principal.subject,authorityRevision:revision,contextVersion:context.contextVersion,verifiedUntil:new Date(deadline).toISOString(),targets};
 if(options.bindTemplates!==false&&!await env.SHARED_PROFILE_PORTAL!.bindProfileIdentity(proof).then(result=>result.ok))return null;
 return proof;
}
export function createBusinessProfileRouter(){
 const router=new Hono<Bindings>();
 router.get('/:workspaceId/business-profile',async c=>{
  c.header('Cache-Control','no-store');const workspaceId=opaque.safeParse(c.req.param('workspaceId'));if(!workspaceId.success)throw new HTTPException(404);
  const proof=await resolveBusinessProfileProof(c.env,c.get('clientPrincipal'),workspaceId.data);if(!proof)return c.json({ok:false,code:'unavailable'} satisfies SharedProfilePortalResult,503);
  return c.json(await c.env.SHARED_PROFILE_PORTAL!.readProfile(proof));
 });
 router.patch('/:workspaceId/business-profile',async c=>{
  c.header('Cache-Control','no-store');if(!clientPortalRequestOriginAllowed(c.req.raw,c.env))throw new HTTPException(403);
  const workspaceId=opaque.safeParse(c.req.param('workspaceId'));
  const value=await readBoundedClientJson(c.req.raw,16384);
  const input=update.safeParse(value);if(!workspaceId.success||!input.success)throw new HTTPException(400);
  const proof=await resolveBusinessProfileProof(c.env,c.get('clientPrincipal'),workspaceId.data);if(!proof)return c.json({ok:false,code:'unavailable'} satisfies SharedProfilePortalResult,503);
  const result=await c.env.SHARED_PROFILE_PORTAL!.updateProfile({...proof,...input.data});return c.json(result,result.ok?200:result.code==='conflict'?409:result.code==='denied'?403:result.code==='invalid'?400:503);
 });return router;
}
