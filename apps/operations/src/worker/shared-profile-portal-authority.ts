import { z } from 'zod';
import { isAdministrator } from './acl';
import type { Env,StaffPrincipal } from './types';
import type { SharedProfileAuthorityTransition,SharedProfilePortalProof,SharedProfilePortalResult,SharedProfilePortalUpdate } from '../../../../packages/shared/src/shared-business-profile';

const text=z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const source=z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const target=z.object({principalPublicId:text,scopeType:z.enum(['client','organization']),publicId:text}).strict();
export const portalProofSchema=z.object({protocolVersion:z.literal(1),workspaceId:text,sourceId:source,
 issuer:text,subject:text,authorityRevision:z.number().int().positive(),contextVersion:z.string().regex(/^[a-f0-9]{64}$/),verifiedUntil:z.string().datetime(),targets:z.array(target).max(64)}).strict();
export const portalUpdateSchema=portalProofSchema.extend({grantId:z.string().uuid(),expectedVersion:z.number().int().positive(),mutationId:z.string().uuid(),
 profile:z.record(z.string(),z.string().max(1000)).refine(value=>Object.keys(value).length<=10)}).strict();
const transitionSchema=z.object({protocolVersion:z.literal(1),operationId:z.string().uuid(),workspaceId:text,sourceId:source,
 expectedRevision:z.number().int().nonnegative(),revision:z.number().int().positive(),state:z.enum(['active','blocked'])}).strict();
export const portalGrantSchema=z.object({operationId:z.string().uuid(),id:z.string().uuid(),workspaceId:text,sourceId:source,
 recipientMode:z.enum(['verified_identity','first_verified_identity']).default('verified_identity'),issuer:text.nullable(),subject:text.nullable(),principalPublicId:text,targetType:z.enum(['client','organization']),targetPublicId:text,
 recordId:text,groupId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),state:z.enum(['active','revoked'])}).strict()
 .refine(v=>v.recipientMode==='verified_identity'?v.issuer!==null&&v.subject!==null:v.issuer===null&&v.subject===null&&v.targetType==='client');
export type SharedProfilePortalGrant={id:string;workspace_id:string;source_id:string;source_instance_id:string;application_id:string;history_epoch_id:string;issuer:string;subject:string;principal_public_id:string;
 target_type:'client'|'organization';target_public_id:string;record_id:string;group_id:string;revision:number;profile_json:string;version:number;kind:'client'|'organization';group_membership_json:string};
type Grant=SharedProfilePortalGrant;

/** Private Client service binding only. A monotonic block must precede Delivery authority changes. */
export async function transitionSharedProfilePortalAuthority(env:Pick<Env,'OPS_DB'>,raw:SharedProfileAuthorityTransition):Promise<{ok:boolean;revision?:number}>{
 const parsed=transitionSchema.safeParse(raw);if(!parsed.success)return{ok:false};const v=parsed.data,db=env.OPS_DB.withSession('first-primary');
 if(v.expectedRevision===0&&v.state!=='blocked')return{ok:false};
 if(v.revision!==v.expectedRevision+(v.state==='blocked'?1:0)&&!(v.expectedRevision===0&&v.revision===1))return{ok:false};
 try{
  const prior=await db.prepare('SELECT source_id,revision,state,operation_id FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(v.workspaceId).first<{source_id:string;revision:number;state:string;operation_id:string}>();
  if(prior?.operation_id===v.operationId)return{ok:prior.source_id===v.sourceId&&prior.revision===v.revision&&prior.state===v.state,revision:prior.revision};
  if(prior?(prior.source_id!==v.sourceId||prior.revision!==v.expectedRevision):v.expectedRevision!==0)return{ok:false};
  const result=prior?await db.prepare("UPDATE shared_profile_portal_authority_heads SET revision=?,state=?,operation_id=?,updated_at=datetime('now') WHERE workspace_id=? AND source_id=? AND revision=?")
   .bind(v.revision,v.state,v.operationId,v.workspaceId,v.sourceId,v.expectedRevision).run():await db.prepare('INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,?,?,?,?)').bind(v.workspaceId,v.sourceId,v.revision,v.state,v.operationId).run();
  return{ok:result.success&&result.meta.changes===1,revision:v.revision};
 }catch{return{ok:false};}
}

/** Explicit owner action. The source/workspace/principal/client tuple is verified without email matching. */
export async function manageSharedProfilePortalGrant(env:Env,actor:StaffPrincipal,raw:unknown):Promise<{ok:boolean;revision?:number}>{
 const parsed=portalGrantSchema.safeParse(raw);if(!parsed.success||!await isAdministrator(env,actor))return{ok:false};const v=parsed.data;
 const db=env.OPS_DB.withSession('first-primary');
 try{
  const nativeOwner=await db.prepare(`SELECT admission.version admission_version,profile.version profile_version
   FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id
   JOIN native_staff_profiles profile ON profile.staff_id=staff.id
   WHERE staff.id=? AND staff.access_subject=? AND staff.status='active' AND admission.active=1
   AND admission.bound_access_subject=staff.access_subject AND profile.login_email=?`)
   .bind(actor.id,actor.accessSubject,actor.email).first<{admission_version:number;profile_version:number}>();
  if(!nativeOwner)return{ok:false};
  const ownerAuthority=`SELECT 1 FROM staff_users staff JOIN staff_role_assignments role ON role.staff_id=staff.id
   JOIN native_staff_admissions admission ON admission.staff_id=staff.id JOIN native_staff_profiles profile ON profile.staff_id=staff.id
   WHERE staff.id=? AND staff.access_subject=? AND profile.login_email=? AND admission.version=? AND profile.version=?
   AND staff.status='active' AND admission.active=1 AND admission.bound_access_subject=staff.access_subject
   AND role.role_id IN('role-owner','role-admin') AND role.scope='global'
   AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission='directory.profile.edit' AND g.scope_kind='global' AND g.effect='allow' AND g.active=1)
   AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission='directory.identity.link' AND g.scope_kind='global' AND g.effect='allow' AND g.active=1)
   AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission IN('directory.profile.edit','directory.identity.link') AND g.effect='deny' AND g.active=1)`;
  const ownerParameters=[actor.id,actor.accessSubject,actor.email,nativeOwner.admission_version,nativeOwner.profile_version];
  if(!await db.prepare(ownerAuthority).bind(...ownerParameters).first())return{ok:false};
  const requestSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const receipt=await db.prepare('SELECT grant_id,actor_kind,actor_id,detail_json FROM shared_profile_portal_audit WHERE operation_id=?')
   .bind(v.operationId).first<{grant_id:string;actor_kind:string;actor_id:string;detail_json:string}>();
  if(receipt){const detail=JSON.parse(receipt.detail_json) as {requestSha256?:string;revision?:number};return{ok:receipt.grant_id===v.id
   &&receipt.actor_kind==='staff'&&receipt.actor_id===actor.id&&detail.requestSha256===requestSha256,revision:detail.revision};}
  const prior=await db.prepare('SELECT * FROM shared_profile_portal_grants WHERE id=?').bind(v.id).first<Record<string,unknown>>();
  if(v.state==='revoked'){
   if(!prior||prior.revision!==v.expectedRevision)return{ok:false};
   const result=await db.batch([db.prepare(`UPDATE shared_profile_portal_grants SET state='revoked',revision=revision+1 WHERE id=? AND revision=?
    AND EXISTS(${ownerAuthority})`).bind(v.id,v.expectedRevision,...ownerParameters),
    db.prepare("INSERT INTO shared_profile_portal_audit(operation_id,grant_id,workspace_id,action,actor_kind,actor_id,detail_json) SELECT ?,?,?, 'grant.revoked','staff',?,? WHERE changes()=1").bind(v.operationId,v.id,String(prior.workspace_id),actor.id,JSON.stringify({revision:v.expectedRevision+1,requestSha256}))]);
   return{ok:result[0]!.meta.changes===1,revision:v.expectedRevision+1};
  }
  if(prior||v.expectedRevision!==0)return{ok:false};
  const owner=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT 1 ok FROM portal_v2_workspaces w
   JOIN pa_portal_workspace_sources s ON s.workspace_id=w.id AND s.projection_source_id=w.project_alpha_source_id
   JOIN portal_v2_directory_checkpoints c ON c.workspace_id=w.id
   JOIN portal_v2_directory_generations g ON g.id=c.active_generation_id AND g.workspace_id=w.id AND g.status='active' AND g.complete=1
   JOIN pa_portal_principals p ON p.workspace_id=w.id AND p.public_id=? AND p.status='active'
   LEFT JOIN portal_v2_identities i ON i.id=p.identity_id AND i.status='active' AND i.revoked_at IS NULL
   LEFT JOIN portal_v2_workspace_memberships m ON m.workspace_id=w.id AND m.identity_id=i.id AND m.status='active' AND m.revoked_at IS NULL
   JOIN portal_v2_directory_entities e ON e.workspace_id=w.id AND e.generation_id=g.id AND e.public_id=? AND e.active=1
   WHERE w.id=? AND w.project_alpha_source_id=? AND w.status='active'
   AND (?='first_verified_identity' OR (i.issuer=? AND i.subject=? AND m.id IS NOT NULL))
   AND ((?='organization' AND e.entity_type='organization' AND e.parent_public_id IS NULL AND w.pa_organization_public_id=e.public_id)
     OR (?='client' AND e.entity_type IN('client','standalone_client')))
   AND (?='organization' OR EXISTS(SELECT 1 FROM pa_portal_entitlement_intents intent WHERE intent.workspace_id=w.id
     AND intent.principal_public_id=p.public_id AND intent.scope_type='client' AND intent.scope_public_id=e.public_id
     AND intent.effect='allow' AND intent.capability='directory.read' AND intent.status='active'
     AND (intent.valid_from IS NULL OR datetime(intent.valid_from)<=datetime('now'))
     AND (intent.expires_at IS NULL OR datetime(intent.expires_at)>datetime('now'))))
   LIMIT 1`).bind(v.principalPublicId,v.targetPublicId,v.workspaceId,v.sourceId,v.recipientMode,v.issuer,v.subject,v.targetType,v.targetType,v.targetType).first();
  if(!owner)return{ok:false};
  const membership=await db.prepare(`SELECT p.membership_json,mapping.source_instance_id,mapping.application_id,mapping.history_epoch_id FROM native_directory_shared_profiles p
   JOIN native_directory_shared_profile_members member ON member.group_id=p.id AND member.record_id=?
   JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=member.record_id AND mapping.source_id=?
   WHERE p.id=? AND mapping.project_alpha_public_id=? AND mapping.resource_type=?
   AND EXISTS(SELECT 1 FROM staff_users staff WHERE staff.id=? AND staff.access_subject=? AND staff.status='active')`).bind(v.recordId,v.sourceId,v.groupId,v.targetPublicId,v.targetType,actor.id,actor.accessSubject).first<{membership_json:string;source_instance_id:string;application_id:string;history_epoch_id:string}>();
  if(!membership)return{ok:false};
  const results=await db.batch([db.prepare(`INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id)
   SELECT ?,?,1,'blocked',? WHERE EXISTS(${ownerAuthority})
   ON CONFLICT(workspace_id) DO NOTHING`).bind(v.workspaceId,v.sourceId,v.operationId,...ownerParameters),db.prepare(`INSERT INTO shared_profile_portal_grants
   (id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,recipient_mode,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'active',? WHERE EXISTS(SELECT 1 FROM shared_profile_portal_authority_heads WHERE workspace_id=? AND source_id=?)
   AND EXISTS(${ownerAuthority})
   AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
    JOIN native_directory_shared_profile_members member ON member.record_id=mapping.record_id
    JOIN native_directory_shared_profiles p ON p.id=member.group_id
    WHERE mapping.record_id=? AND mapping.source_id=? AND mapping.resource_type=? AND mapping.project_alpha_public_id=?
    AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=? AND p.id=? AND json(p.membership_json)=json(?))`)
   .bind(v.id,v.workspaceId,v.sourceId,membership.source_instance_id,membership.application_id,membership.history_epoch_id,v.recipientMode,v.issuer,v.subject,v.principalPublicId,v.targetType,v.targetPublicId,v.recordId,v.groupId,membership.membership_json,actor.id,v.workspaceId,v.sourceId,...ownerParameters,
    v.recordId,v.sourceId,v.targetType,v.targetPublicId,membership.source_instance_id,membership.application_id,membership.history_epoch_id,v.groupId,membership.membership_json),
   db.prepare("INSERT INTO shared_profile_portal_audit(operation_id,grant_id,workspace_id,action,actor_kind,actor_id,detail_json) SELECT ?,?,?, 'grant.issued','staff',?,? WHERE changes()=1").bind(v.operationId,v.id,v.workspaceId,actor.id,JSON.stringify({scope:v.targetType,groupId:v.groupId,revision:1,requestSha256}))]);
  return{ok:results[1]!.meta.changes===1,revision:1};
 }catch{return{ok:false};}
}

/** Bind a reviewed own-client template exactly once to an already verified identity.
 * Client supplies trusted principal/client scope witnesses; no email lookup is performed.
 */
export async function bindSharedProfilePortalIdentity(env:Pick<Env,'OPS_DB'>,raw:SharedProfilePortalProof):Promise<{ok:boolean;bound?:number}>{
 const parsed=portalProofSchema.safeParse(raw);if(!parsed.success)return{ok:false};const v=parsed.data,db=env.OPS_DB.withSession('first-primary');
 if(!fresh(v.verifiedUntil))return{ok:false};
 try{
  const rows=(await db.prepare(`SELECT grant_row.id,grant_row.revision,grant_row.principal_public_id,grant_row.target_public_id
   FROM shared_profile_portal_grants grant_row JOIN shared_profile_portal_authority_heads h ON h.workspace_id=grant_row.workspace_id AND h.source_id=grant_row.source_id
   WHERE grant_row.workspace_id=? AND grant_row.source_id=? AND grant_row.state='active' AND grant_row.recipient_mode='first_verified_identity'
   AND grant_row.issuer IS NULL AND grant_row.subject IS NULL AND grant_row.target_type='client' AND h.state='active' AND h.revision=? LIMIT 65`)
   .bind(v.workspaceId,v.sourceId,v.authorityRevision).all<{id:string;revision:number;principal_public_id:string;target_public_id:string}>()).results;
  if(rows.length>64)return{ok:false};let bound=0;
  for(const row of rows){
   if(!v.targets.some(target=>target.scopeType==='client'&&target.principalPublicId===row.principal_public_id&&target.publicId===row.target_public_id))continue;
   const operationId=crypto.randomUUID();
   const results=await db.batch([db.prepare(`UPDATE shared_profile_portal_grants SET issuer=?,subject=?,revision=revision+1
    WHERE id=? AND revision=? AND state='active' AND recipient_mode='first_verified_identity' AND issuer IS NULL AND subject IS NULL
    AND datetime(?)>datetime('now') AND datetime(?)<=datetime('now','+60 seconds')
    AND EXISTS(SELECT 1 FROM shared_profile_portal_authority_heads h WHERE h.workspace_id=shared_profile_portal_grants.workspace_id
      AND h.source_id=shared_profile_portal_grants.source_id AND h.state='active' AND h.revision=?)
    AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings mapping
      JOIN native_directory_shared_profile_members member ON member.record_id=mapping.record_id
      JOIN native_directory_shared_profiles p ON p.id=member.group_id
      WHERE mapping.record_id=shared_profile_portal_grants.record_id AND mapping.source_id=shared_profile_portal_grants.source_id
      AND mapping.resource_type='client' AND mapping.project_alpha_public_id=shared_profile_portal_grants.target_public_id
      AND mapping.source_instance_id=shared_profile_portal_grants.source_instance_id AND mapping.application_id=shared_profile_portal_grants.application_id
      AND mapping.history_epoch_id=shared_profile_portal_grants.history_epoch_id AND p.id=shared_profile_portal_grants.group_id
      AND json(p.membership_json)=json(shared_profile_portal_grants.group_membership_json))`)
    .bind(v.issuer,v.subject,row.id,row.revision,v.verifiedUntil,v.verifiedUntil,v.authorityRevision),
    db.prepare(`INSERT INTO shared_profile_portal_audit(operation_id,grant_id,workspace_id,action,actor_kind,actor_id,detail_json)
     SELECT ?,?,?,'identity.bound','portal',?,? WHERE changes()=1`).bind(operationId,row.id,v.workspaceId,JSON.stringify([v.issuer,v.subject]),JSON.stringify({principalPublicId:row.principal_public_id,targetPublicId:row.target_public_id,revision:row.revision+1}))]);
   bound+=results[0]!.meta.changes;
  }return{ok:true,bound};
 }catch{return{ok:false};}
}

export async function authorizedSharedProfilePortalGrants(env:Pick<Env,'OPS_DB'>,raw:SharedProfilePortalProof):Promise<Grant[]|null>{
 const parsed=portalProofSchema.safeParse(raw);if(!parsed.success)return null;const v=parsed.data;
 if(!fresh(v.verifiedUntil))return null;
 try{
  const rows=(await env.OPS_DB.withSession('first-primary').prepare(`SELECT grant_row.*,p.profile_json,p.version,p.kind FROM shared_profile_portal_grants grant_row
   JOIN shared_profile_portal_authority_heads h ON h.workspace_id=grant_row.workspace_id AND h.source_id=grant_row.source_id
   JOIN native_directory_shared_profiles p ON p.id=grant_row.group_id AND json(p.membership_json)=json(grant_row.group_membership_json)
   JOIN native_directory_shared_profile_members member ON member.group_id=p.id AND member.record_id=grant_row.record_id
   JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=member.record_id AND mapping.source_id=grant_row.source_id
     AND mapping.project_alpha_public_id=grant_row.target_public_id AND mapping.resource_type=grant_row.target_type
     AND mapping.source_instance_id=grant_row.source_instance_id AND mapping.application_id=grant_row.application_id AND mapping.history_epoch_id=grant_row.history_epoch_id
   WHERE grant_row.workspace_id=? AND grant_row.source_id=? AND grant_row.issuer=? AND grant_row.subject=? AND grant_row.state='active'
   AND h.state='active' AND h.revision=? AND datetime(?)>datetime('now') ORDER BY grant_row.id LIMIT 65`).bind(v.workspaceId,v.sourceId,v.issuer,v.subject,v.authorityRevision,v.verifiedUntil).all<Grant>()).results;
  if(rows.length>64||new Set(rows.map(row=>row.id)).size!==rows.length)return null;
  return rows.filter(row=>v.targets.some(t=>t.principalPublicId===row.principal_public_id&&t.scopeType===row.target_type&&t.publicId===row.target_public_id));
 }catch{return null;}
}
export async function readSharedProfilePortalProfiles(env:Pick<Env,'OPS_DB'>,input:SharedProfilePortalProof):Promise<SharedProfilePortalResult>{
 const grants=await authorizedSharedProfilePortalGrants(env,input);if(!grants)return{ok:false,code:'unavailable'};
 return{ok:true,profiles:grants.map(row=>({grantId:row.id,kind:row.kind,version:row.version,profile:JSON.parse(row.profile_json),editable:false}))};
}
/** The portal composer must add this guard to its SAME atomic batch as canonical revision + every PA outbox. */
export async function prepareSharedProfilePortalWrite(env:Pick<Env,'OPS_DB'>,raw:SharedProfilePortalUpdate){
 const parsed=portalUpdateSchema.safeParse(raw);if(!parsed.success)return null;const v=parsed.data;
 const {grantId,expectedVersion,mutationId,profile,...proof}=v;
 const grants=await authorizedSharedProfilePortalGrants(env,proof);const grant=grants?.find(g=>g.id===grantId&&g.version===expectedVersion);if(!grant)return null;
 // The private composer verifies the identity-neutral PA descriptor for every
 // client destination before adding this fence to its atomic native write.
 const normalized=normalizePortalBusinessProfile(profile);
 const hash=await stablePortalRequestFingerprint({...v,profile:normalized},grant);
 return{grant,input:{...v,profile:normalized},requestSha256:hash,statement:env.OPS_DB.prepare(`INSERT INTO shared_profile_portal_write_fences
  (mutation_id,grant_id,grant_revision,authority_revision,group_id,expected_group_version,issuer,subject,context_version,verified_until,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(v.mutationId,grant.id,grant.revision,v.authorityRevision,grant.group_id,v.expectedVersion,v.issuer,v.subject,v.contextVersion,v.verifiedUntil,hash)};
}
function fresh(until:string){const value=Date.parse(until),now=Date.now();return Number.isFinite(value)&&value>now&&value<=now+60_000;}
export function normalizePortalBusinessProfile(profile:Readonly<Record<string,string>>):Record<string,string>{
 return Object.fromEntries(Object.keys(profile).sort().map(key=>{let value=profile[key]!.normalize('NFC').trim();if(key==='email'||key==='generalEmail')value=value.toLowerCase();return[key,value];}));
}
/** Stable business intent only. Refreshed authority heads, context and TTL are audit witnesses, not idempotency input. */
export async function stablePortalRequestFingerprint(input:SharedProfilePortalUpdate,grant:SharedProfilePortalGrant):Promise<string>{
 const members=JSON.parse(grant.group_membership_json) as unknown;
 if(!Array.isArray(members)||members.some(member=>typeof member!=='string'))throw new Error('shared-profile-membership-invalid');
 const value={schemaVersion:1,groupId:grant.group_id,grantId:grant.id,grantRevision:grant.revision,actor:[input.issuer,input.subject],expectedVersion:input.expectedVersion,
  ownScope:[grant.workspace_id,grant.source_id,grant.source_instance_id,grant.application_id,grant.history_epoch_id,grant.principal_public_id,grant.target_type,grant.target_public_id,grant.record_id],
  members:[...members].sort(),profile:normalizePortalBusinessProfile(input.profile)};
 return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
