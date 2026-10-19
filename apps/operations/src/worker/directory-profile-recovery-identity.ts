import type {ProjectAlphaApiV2ConnectionEnvironment} from './project-alpha-api-v2-connections';
import {readConfiguredProjectAlphaDirectoryClientPortalIdentity,type ProjectAlphaDirectoryBindingObservation} from './project-alpha-directory-read-api-v2';
import {sharedProfileCorrespondenceColumns,sharedProfileGrantSourceCurrent,type SharedProfilePortalGrant} from './shared-profile-portal-authority';

type Environment=ProjectAlphaApiV2ConnectionEnvironment&{OPS_DB:D1Database;DELIVERY_DB?:D1Database};
type Target={sourceId:string;sourceInstanceId:string;applicationId:string;historyEpoch:string;recordId:string;externalId:string;publicId:string;expectedRevision:string};
type ProofGrant=SharedProfilePortalGrant&{proof_grant_id:string;decision_id:string;proof_source_id:string;proof_record_id:string;
 proof_principal:string;association_version:string;binding_observation_json:string;external_id:string};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const descriptor=(g:ProofGrant)=>({grantId:g.id,grantRevision:g.revision,decisionId:g.decision_id,recordId:g.record_id,
 sourceId:g.proof_source_id,sourceInstanceId:g.source_instance_id,applicationId:g.application_id,historyEpoch:g.history_epoch_id,
 externalId:g.external_id,publicId:g.target_public_id,principalPublicId:g.proof_principal,associationVersion:g.association_version});

/** Automatic grants are decision-owned. The login grant and the destination
 * can belong to different PA instances and therefore have different principals.
 * A manual reviewed grant never enters this function or borrows an auto proof. */
export async function readAutomaticProfileRecoveryIdentity(env:Environment,grant:SharedProfilePortalGrant,target:Target,send:typeof fetch){
 const denied=()=>({status:'denied' as const});
 try{
  const original=await env.OPS_DB.prepare('SELECT decision_id FROM client_onboarding_portal_activation_proofs WHERE grant_id=?')
   .bind(grant.id).first<{decision_id:string}>();
  if(!original||original.decision_id!==grant.group_id)return denied();
  const bridge=await sharedProfileCorrespondenceColumns(env.OPS_DB),source=bridge?'COALESCE(g.directory_source_id,g.source_id)':'g.source_id';
  const load=()=>env.OPS_DB.prepare(`SELECT g.*,p.grant_id proof_grant_id,p.decision_id,p.source_id proof_source_id,p.record_id proof_record_id,
   p.principal_public_id proof_principal,p.association_version,p.binding_observation_json,mapping.external_id
   FROM client_onboarding_portal_activation_proofs p JOIN shared_profile_portal_grants g ON g.id=p.grant_id
   JOIN native_directory_shared_profile_members member ON member.group_id=g.group_id AND member.record_id=p.record_id
   JOIN operations_directory_records client ON client.record_id=p.record_id AND client.record_kind='client'
   JOIN operations_directory_client_organizations relation ON relation.client_record_id=client.record_id
   LEFT JOIN operations_directory_lifecycle_state client_state ON client_state.record_id=client.record_id
   LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'
   LEFT JOIN operations_directory_lifecycle_state parent_state ON parent_state.record_id=parent.record_id
   JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=p.record_id AND mapping.source_id=p.source_id
    AND mapping.resource_type='client' AND mapping.project_alpha_public_id=g.target_public_id
    AND mapping.source_instance_id=g.source_instance_id AND mapping.application_id=g.application_id AND mapping.history_epoch_id=g.history_epoch_id
   WHERE g.group_id=? AND g.group_id=p.decision_id AND p.decision_id=? AND g.state='active' AND g.target_type='client'
    AND(client_state.record_id IS NULL OR client_state.status='active')
    AND(relation.organization_record_id IS NULL OR(parent.record_id IS NOT NULL AND(parent_state.record_id IS NULL OR parent_state.status='active')))
    AND g.record_id=p.record_id AND g.principal_public_id=p.principal_public_id AND ${source}=p.source_id
    AND json(g.group_membership_json)=json(?) AND(g.id=? OR(p.source_id=? AND p.record_id=?)) ORDER BY g.id LIMIT 3`)
   .bind(grant.group_id,original.decision_id,grant.group_membership_json,grant.id,target.sourceId,target.recordId).all<ProofGrant>();
  const rows=(await load()).results;
  const originals=rows.filter(g=>g.id===grant.id),targets=rows.filter(g=>g.proof_source_id===target.sourceId&&g.record_id===target.recordId);
  if(originals.length!==1||targets.length!==1)return denied();
  const actor=originals[0]!,destination=targets[0]!;
  if(actor.revision!==grant.revision||actor.issuer!==grant.issuer||actor.subject!==grant.subject
   ||actor.record_id!==grant.record_id||actor.target_public_id!==grant.target_public_id||actor.proof_principal!==grant.principal_public_id
   ||actor.proof_source_id!==(grant.directory_source_id??grant.source_id)
   ||destination.source_instance_id!==target.sourceInstanceId||destination.application_id!==target.applicationId
   ||destination.history_epoch_id!==target.historyEpoch||destination.target_public_id!==target.publicId||destination.external_id!==target.externalId)return denied();
  for(const value of [actor,destination]){
   const stored=JSON.parse(value.binding_observation_json)as unknown;
   if(!plain(stored)||!plain(stored.binding)||stored.sourceId!==value.proof_source_id||stored.sourceInstanceId!==value.source_instance_id
    ||stored.applicationId!==value.application_id||stored.historyEpoch!==value.history_epoch_id
    ||stored.binding.externalId!==value.external_id||stored.binding.publicId!==value.target_public_id
    ||!await sharedProfileGrantSourceCurrent(env,value))return denied();
  }
  const matches=(g:ProofGrant,v:ProjectAlphaDirectoryBindingObservation)=>v.sourceId===g.proof_source_id&&v.sourceInstanceId===g.source_instance_id
   &&v.applicationId===g.application_id&&v.historyEpoch===g.history_epoch_id&&v.binding.externalId===g.external_id&&v.binding.publicId===g.target_public_id
   &&v.clientPortalIdentity?.state==='eligible'&&v.clientPortalIdentity.principalPublicId===g.proof_principal
   &&v.clientPortalIdentity.associationVersion===g.association_version;
  const actorRead=await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,actor.proof_source_id,actor.external_id,actor.target_public_id,send);
  if(actorRead.status!=='observed')return{status:'unavailable' as const};
  if(!matches(actor,actorRead.observation))return denied();
  const targetRead=actor.proof_source_id===destination.proof_source_id&&actor.external_id===destination.external_id&&actor.target_public_id===destination.target_public_id
   ?actorRead:await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,destination.proof_source_id,destination.external_id,destination.target_public_id,send);
  if(targetRead.status!=='observed')return{status:'unavailable' as const};
  if(!matches(destination,targetRead.observation)||targetRead.observation.resource.revision!==target.expectedRevision)return denied();
  if(JSON.stringify((await load()).results)!==JSON.stringify(rows))return denied();
  return{status:'observed' as const,observation:{...targetRead.observation,
   recoveryProofs:{original:descriptor(actor),destination:descriptor(destination)},originalGrantObservation:actorRead.observation}};
 }catch{return{status:'unavailable' as const};}
}
