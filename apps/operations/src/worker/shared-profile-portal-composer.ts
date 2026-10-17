import type { Env } from './types';
import type { SharedProfilePortalProof,SharedProfilePortalUpdate,SharedProfilePortalResult } from '../../../../packages/shared/src/shared-business-profile';
import { authorizedSharedProfilePortalGrants,portalUpdateSchema,prepareSharedProfilePortalWrite,stablePortalRequestFingerprint,
  normalizePortalBusinessProfile,sharedProfileGrantSourceCurrent,type SharedProfilePortalGrant } from './shared-profile-portal-authority';
import { clientUpdateProfile,organizationProfile,updateDestinations,currentClientRelationship } from './native-directory-profile-routes';
import { nativeDirectorySharedProfileDelivery } from './native-directory-shared-profile-routes';
import { probeConfiguredProjectAlphaDirectoryClientContactProfile } from './project-alpha-directory-profile-api-v2';
import { writeNativeDirectorySharedPortalProfiles,type NativeDirectoryPortalUpdateWrite,type NativeDirectoryPortalWriterActor } from './native-directory-profile-writer';

async function contactReady(env:Env,grant:SharedProfilePortalGrant):Promise<boolean>{
  if(grant.kind!=='client')return true;
  const members=JSON.parse(grant.group_membership_json) as string[];
  const sources=new Set<string>();
  for(const id of members){
    const raw=await env.OPS_DB.prepare('SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?').bind(id).first<string>('destinations_json');
    if(!raw)return false;
    const destinations=JSON.parse(raw) as {sourceId:string}[];
    if(!destinations.length||destinations.length>16)return false;
    for(const d of destinations)sources.add(d.sourceId);
  }
  return sources.size>0&&(await Promise.all([...sources].map(source=>probeConfiguredProjectAlphaDirectoryClientContactProfile(env,source)))).every(p=>p.status==='verified');
}
export async function readEditableSharedPortalProfiles(env:Env,proof:SharedProfilePortalProof):Promise<SharedProfilePortalResult>{
  const grants=await authorizedSharedProfilePortalGrants(env,proof);
  if(!grants)return{ok:false,code:'unavailable'};
  try{return{ok:true,profiles:await Promise.all(grants.map(async g=>({grantId:g.id,kind:g.kind,version:g.version,
    profile:JSON.parse(g.profile_json),editable:await contactReady(env,g)
      &&(await nativeDirectorySharedProfileDelivery(env.OPS_DB,g.group_id)).state==='acknowledged'})))};}
  catch{return{ok:false,code:'unavailable'};}
}
/** Only the private Client binding supplies identity/target witnesses. Replay
 * checks current authority, but hashes the stable business request separately. */
export async function updateSharedPortalProfile(env:Env,raw:SharedProfilePortalUpdate):Promise<SharedProfilePortalResult>{
  const parsed=portalUpdateSchema.safeParse(raw);if(!parsed.success)return{ok:false,code:'invalid'};
  const input=parsed.data,{grantId,expectedVersion,mutationId,profile,...proof}=input;
  const grants=await authorizedSharedProfilePortalGrants(env,proof),grant=grants?.find(g=>g.id===grantId);
  if(!grant)return{ok:false,code:'denied'};
  const checked=(grant.kind==='client'?clientUpdateProfile:organizationProfile).safeParse(normalizePortalBusinessProfile(profile));
  if(!checked.success)return{ok:false,code:'invalid'};
  const normalized=normalizePortalBusinessProfile(checked.data);
  const normalizedInput={...input,profile:normalized};
  try{
    const requestSha256=await stablePortalRequestFingerprint(normalizedInput,grant);
    const prior=await env.OPS_DB.prepare(`SELECT c.group_id,c.expected_version,c.request_sha256,c.actor_kind,c.actor_id,
      f.grant_id,f.grant_revision,f.issuer,f.subject FROM native_directory_shared_profile_commands c
      LEFT JOIN shared_profile_portal_write_fences f ON f.mutation_id=c.mutation_id WHERE c.mutation_id=?`).bind(mutationId)
      .first<{group_id:string;expected_version:number;request_sha256:string;actor_kind:string;actor_id:string;grant_id:string;grant_revision:number;issuer:string;subject:string}>();
    if(prior){
      if(prior.group_id!==grant.group_id||prior.expected_version!==expectedVersion||prior.request_sha256!==requestSha256
        ||prior.actor_kind!=='portal'||prior.actor_id!==`portal:${grant.id}`||prior.grant_id!==grant.id
        ||prior.grant_revision!==grant.revision||prior.issuer!==proof.issuer||prior.subject!==proof.subject)return{ok:false,code:'conflict'};
      return readEditableSharedPortalProfiles(env,proof);
    }
    if(grant.version!==expectedVersion)return{ok:false,code:'conflict'};
    if(!await contactReady(env,grant))return{ok:false,code:'unavailable'};
    if((await nativeDirectorySharedProfileDelivery(env.OPS_DB,grant.group_id)).state!=='acknowledged')return{ok:false,code:'conflict'};
    const prepared=await prepareSharedProfilePortalWrite(env,normalizedInput);if(!prepared)return{ok:false,code:'denied'};
    const actor:NativeDirectoryPortalWriterActor={kind:'portal',actorId:`portal:${grant.id}`,issuer:proof.issuer,subject:proof.subject,
      grantId:grant.id,grantRevision:grant.revision,workspaceId:proof.workspaceId,sourceId:proof.sourceId,groupId:grant.group_id,
      groupVersion:expectedVersion,sharedMutationId:mutationId,authorityRevision:proof.authorityRevision,contextVersion:proof.contextVersion,verifiedUntil:proof.verifiedUntil};
    const members=JSON.parse(grant.group_membership_json) as string[],writes:NativeDirectoryPortalUpdateWrite[]=[];
    if(members.length<1||members.length>2)return{ok:false,code:'denied'};
    for(const recordId of members){
      const record=await env.OPS_DB.prepare('SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?')
        .bind(recordId).first<{record_kind:string;current_version:number}>();
      if(!record||record.record_kind!==grant.kind)return{ok:false,code:'conflict'};
      const destinations=await updateDestinations(env,grant.kind,recordId,record.current_version);if(!destinations)return{ok:false,code:'unavailable'};
      if(recordId===grant.record_id&&!destinations.some(d=>d.sourceId===(grant.directory_source_id??grant.source_id)
        &&d.sourceInstanceUUID===grant.source_instance_id&&d.applicationUUID===grant.application_id&&d.historyEpoch===grant.history_epoch_id))return{ok:false,code:'denied'};
      const base={operation:'update' as const,mutationId:await memberMutation(mutationId,recordId),recordId,expectedLocalVersion:record.current_version,actor,destinations};
      if(grant.kind==='client'){
        const relation=await currentClientRelationship(env.OPS_DB,recordId);if(!relation)return{ok:false,code:'unavailable'};
        writes.push({...base,kind:'client',profile:normalized as NativeDirectoryPortalUpdateWrite['profile'],relationship:{organizationRecordId:relation.organization_record_id,expectedRelationshipVersion:relation.relationship_version}} as NativeDirectoryPortalUpdateWrite);
      }else writes.push({...base,kind:'organization',profile:normalized as NativeDirectoryPortalUpdateWrite['profile']} as NativeDirectoryPortalUpdateWrite);
    }
    if(!await sharedProfileGrantSourceCurrent(env,grant))return{ok:false,code:'denied'};
    const result=await writeNativeDirectorySharedPortalProfiles(env.OPS_DB,{groupId:grant.group_id,mutationId,expectedVersion,requestSha256,
      profile:normalized,writes,authorityFence:prepared.statement},env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED==='true');
    if(result.status!=='written')return{ok:false,code:result.status==='conflict'?'conflict':'unavailable'};
    return readEditableSharedPortalProfiles(env,proof);
  }catch{return{ok:false,code:'unavailable'};}
}
async function memberMutation(mutationId:string,recordId:string){
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(mutationId+'\0'+recordId))).slice(0,16);
  b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
