import { readClientOnboardingSubmissionForReview } from "./client-onboarding-review";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import type { Env, StaffPrincipal } from "./types";
import { d1TablesPresent } from "./schema-readiness";
import { portalAutomaticEligibilityEnabled } from "./portal-automatic-eligibility";
import { readNativeDirectoryDurableRemoteHead, type NativeDirectoryDestinationAuthority } from "./native-directory-profile-writer";
import { readConfiguredProjectAlphaDirectoryClientPortalIdentity, type ProjectAlphaDirectoryBindingObservation } from "./project-alpha-directory-read-api-v2";
import { probeConfiguredProjectAlphaDirectoryClientContactProfile } from "./project-alpha-directory-profile-api-v2";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { currentClientRelationship, normalizeProfile, clientUpdateProfile } from "./native-directory-profile-routes";
import { sharedProfileCreationFence, sharedProfileCreationStatements, readSharedProfilePortalSetup, type SharedProfileMember, type SharedProfilePortalSetupCandidate } from "./native-directory-shared-profile-routes";
import { manageSharedProfilePortalGrant, type SharedProfilePortalGrant } from "./shared-profile-portal-authority";

type Destination = Omit<NativeDirectoryDestinationAuthority,"expectedAuthorizationGeneration">;
type Intent = { decision_id:string;client_record_id:string;version:number;reviewer_staff_id:string;reviewer_subject:string;
 reviewer_email:string;original_admission_version:number;original_profile_version:number;client_destinations_json:string };
type ActivationState = "awaiting_pa"|"awaiting_portal"|"authority_changed"|"identity_changed"|"enrollment_required"|"active"|"activation_failed";
export const CLIENT_ONBOARDING_PORTAL_ACTIVATION_CRON="13-58/15 * * * *";
const tables=["client_onboarding_portal_activation_intents","client_onboarding_portal_activation_proofs","client_onboarding_portal_activation_scan"];
async function digest(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,"0")).join("");}
async function uuid(seed:string){const value=await digest(seed);return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;}
function identityFingerprint(observation:ProjectAlphaDirectoryBindingObservation){
 return JSON.stringify([observation.sourceId,observation.sourceInstanceId,observation.applicationId,observation.historyEpoch,
  observation.authorizationGeneration,observation.binding,observation.resource,observation.clientPortalIdentity]);
}
async function approver(env:Env,intent:Intent):Promise<StaffPrincipal|null>{
 const row=await env.OPS_DB.withSession("first-primary").prepare(`SELECT staff.id,staff.email,staff.display_name displayName,
  staff.access_subject accessSubject,staff.project_alpha_user_id projectAlphaUserId
  FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id
  JOIN native_staff_profiles profile ON profile.staff_id=staff.id
  WHERE staff.id=? AND staff.status='active' AND staff.access_subject=? AND admission.bound_access_subject=staff.access_subject
  AND admission.active=1 AND admission.version=? AND profile.version=? AND profile.login_email=? AND staff.email=profile.login_email
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=staff.id AND role.role_id IN('role-owner','role-admin') AND role.scope='global')
  AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission='directory.profile.edit' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
  AND EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission='directory.identity.link' AND g.effect='allow' AND g.scope_kind='global' AND g.active=1)
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=staff.id AND g.permission IN('directory.profile.edit','directory.identity.link') AND g.effect='deny' AND g.active=1)`)
 .bind(intent.reviewer_staff_id,intent.reviewer_subject,intent.original_admission_version,intent.original_profile_version,intent.reviewer_email).first<StaffPrincipal>();
 return row;
}
function destinations(env:Env,raw:string):Destination[]|null{
 try{const values:unknown=JSON.parse(raw);if(!Array.isArray(values)||values.length>16)return null;
  const result:Destination[]=[];for(const value of values){
   if(!value||typeof value!=="object"||Array.isArray(value))return null;
   const d=value as Destination,configured=resolveProjectAlphaApiV2Connection(env,d.sourceId);
   if(!configured.enabled||d.origin!==configured.connection.baseUrl||d.sourceInstanceUUID!==configured.connection.expectedSourceInstanceId
    ||d.applicationUUID!==configured.connection.expectedApplicationId||d.historyEpoch!==configured.connection.expectedHistoryEpoch
    ||typeof d.externalCanonicalId!=="string")return null;
   result.push({sourceId:d.sourceId,sourceInstanceUUID:d.sourceInstanceUUID,applicationUUID:d.applicationUUID,
    historyEpoch:d.historyEpoch,origin:d.origin,externalCanonicalId:d.externalCanonicalId});
  }return new Set(result.map(d=>d.sourceId)).size===result.length?result.sort((a,b)=>a.sourceId.localeCompare(b.sourceId)):null;
 }catch{return null;}
}
async function member(env:Env,intent:Intent,selected:Destination[]):Promise<SharedProfileMember|null>{
 const record=await env.OPS_DB.withSession("first-primary").prepare(`SELECT r.current_version version,v.profile_json
  FROM operations_directory_records r JOIN operations_directory_revisions v ON v.record_id=r.record_id AND v.version=r.current_version
  WHERE r.record_id=? AND r.record_kind='client'`).bind(intent.client_record_id).first<{version:number;profile_json:string}>();
 if(!record)return null;
 const relation=await currentClientRelationship(env.OPS_DB,intent.client_record_id);if(!relation)return null;
 const raw=JSON.parse(record.profile_json) as Record<string,string>;delete raw.clientType;
 const checked=clientUpdateProfile.safeParse(raw);if(!checked.success)return null;
 const parentVersion=relation.organization_record_id?await env.OPS_DB.prepare("SELECT current_version FROM operations_directory_records WHERE record_id=? AND record_kind='organization'")
  .bind(relation.organization_record_id).first<number>("current_version"):null;
 if(relation.organization_record_id&&!parentVersion)return null;
 return {recordId:intent.client_record_id,kind:"client",version:record.version,profile:normalizeProfile(checked.data),
  sourceIds:selected.map(d=>d.sourceId).sort(),parentRecordId:relation.organization_record_id,relationshipVersion:relation.relationship_version,parentVersion};
}
async function observations(env:Env,record:SharedProfileMember,selected:Destination[],deadline:number):Promise<ProjectAlphaDirectoryBindingObservation[]|null>{
 const results:ProjectAlphaDirectoryBindingObservation[]=[];
 for(const destination of selected){
  if(Date.now()>deadline)return null;
  const head=await readNativeDirectoryDurableRemoteHead(env.OPS_DB,"client",record.recordId,record.version,destination,
   env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED==='true');
  if(!head)return null;
  const value=await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,destination.sourceId,head.externalCanonicalId,head.projectAlphaPublicId);
  if(value.status!=="observed"||value.observation.resource.revision!==head.revision
   ||value.observation.clientPortalIdentity?.state!=="eligible")return null;
  results.push(value.observation);
 }return results;
}
async function activeClientLineage(env:Env,recordId:string):Promise<boolean>{
 return Boolean(await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 FROM operations_directory_records client
  JOIN operations_directory_client_organizations relation ON relation.client_record_id=client.record_id
  LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=client.record_id
  LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'
  LEFT JOIN operations_directory_lifecycle_state parent_state ON parent_state.record_id=parent.record_id
  WHERE client.record_id=? AND client.record_kind='client' AND (lifecycle.record_id IS NULL OR lifecycle.status='active')
  AND (relation.organization_record_id IS NULL OR (parent.record_id IS NOT NULL AND (parent_state.record_id IS NULL OR parent_state.status='active')))`)
  .bind(recordId).first());
}
type SharedApproval={plan_id:string;client_profile_json:string;child_count:number};
type SharedChild={client_record_id:string;parent_record_id:string;destinations_json:string};
type OwnCandidate={member:SharedProfileMember;observed:ProjectAlphaDirectoryBindingObservation;candidate:SharedProfilePortalSetupCandidate;grantId:string};
function ownFingerprint(observation:ProjectAlphaDirectoryBindingObservation){
 return JSON.stringify([observation.sourceId,observation.sourceInstanceId,observation.applicationId,observation.historyEpoch,
  observation.binding,observation.resource,observation.clientPortalIdentity]);
}
/** A reviewed shared company has one new source-owned contact per parent alias.
 * Every child must have its exact ACK and own-principal proof before grouping
 * or issuing any template. This is approval authority, never an interactive merge. */
async function activateSharedCompany(env:Env,intent:Intent,approval:SharedApproval,actor:StaffPrincipal,deadline:number):Promise<ActivationState>{
 if(approval.plan_id!==intent.decision_id||approval.child_count<1||approval.child_count>2)return"identity_changed";
 const children=(await env.OPS_DB.withSession("first-primary").prepare(`SELECT child.client_record_id,child.parent_record_id,child.destinations_json
  FROM client_onboarding_shared_company_plan_children child JOIN client_onboarding_shared_company_child_receipts receipt
  ON receipt.plan_id=child.plan_id AND receipt.client_record_id=child.client_record_id
  WHERE child.plan_id=? ORDER BY child.client_record_id`).bind(approval.plan_id).all<SharedChild>()).results;
 if(children.length!==approval.child_count||children[0]?.client_record_id!==intent.client_record_id)return"identity_changed";
 const raw=JSON.parse(approval.client_profile_json) as Record<string,string>;delete raw.clientType;
 const checked=clientUpdateProfile.safeParse(raw);if(!checked.success)return"identity_changed";
 const profile=normalizeProfile(checked.data),members:SharedProfileMember[]=[],witnesses:{member:SharedProfileMember;observed:ProjectAlphaDirectoryBindingObservation}[]=[];
 const allDestinations:Destination[]=[];
 for(const child of children){
  const selected=destinations(env,child.destinations_json);if(!selected?.length)return"identity_changed";
  const enrolled=await env.OPS_DB.withSession("first-primary").prepare("SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?")
   .bind(child.client_record_id).first<string>("destinations_json");
  if(!enrolled||JSON.stringify(destinations(env,enrolled))!==JSON.stringify(selected))return"identity_changed";
  const m=await member(env,{...intent,client_record_id:child.client_record_id},selected);
  if(!m||m.version!==1||m.parentRecordId!==child.parent_record_id||m.relationshipVersion!==1
   ||JSON.stringify(m.profile)!==JSON.stringify(profile)||!await activeClientLineage(env,m.recordId))return"identity_changed";
  const observed=await observations(env,m,selected,deadline);if(!observed)return"awaiting_pa";
  members.push(m);allDestinations.push(...selected);witnesses.push(...observed.map(value=>({member:m,observed:value})));
 }
 const approved=destinations(env,intent.client_destinations_json);
 allDestinations.sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
 if(!approved||new Set(allDestinations.map(d=>d.sourceId)).size!==allDestinations.length
  ||JSON.stringify(approved)!==JSON.stringify(allDestinations))return"identity_changed";
 for(const source of allDestinations.map(d=>d.sourceId)){
  if(Date.now()>deadline)return"awaiting_pa";
  if((await probeConfiguredProjectAlphaDirectoryClientContactProfile(env,source)).status!=="verified")return"awaiting_pa";
 }
 const groupId=intent.decision_id,membership=JSON.stringify(members.map(m=>m.recordId));
 const linked=(await env.OPS_DB.prepare("SELECT record_id,group_id FROM native_directory_shared_profile_members WHERE record_id IN(SELECT value FROM json_each(?))")
  .bind(membership).all<{record_id:string;group_id:string}>()).results;
 if(linked.some(row=>row.group_id!==groupId))return"identity_changed";
 const group=await env.OPS_DB.prepare("SELECT kind,version,profile_json,membership_json FROM native_directory_shared_profiles WHERE id=?")
  .bind(groupId).first<{kind:string;version:number;profile_json:string;membership_json:string}>();
 if(group&&(group.kind!=="client"||group.version!==1||group.profile_json!==JSON.stringify(profile)
  ||group.membership_json!==membership||linked.length!==members.length))return"identity_changed";
 if(!group&&linked.length)return"identity_changed";
 // Candidate discovery is read-only and works before a group exists.
 const setup=await readSharedProfilePortalSetup(env,groupId,members,true);if(!setup.available)return"awaiting_portal";
 const chosen:OwnCandidate[]=[];
 for(const witness of witnesses){
  const observed=witness.observed,own=observed.clientPortalIdentity!;
  const matches=setup.candidates.filter(c=>c.sourceId===observed.sourceId&&c.recordId===witness.member.recordId
   &&c.targetPublicId===observed.binding.publicId&&c.principalPublicId===own.principalPublicId);
  if(matches.length!==1)return"awaiting_portal";
  const candidate=matches[0]!;
  if(candidate.state==='revoked'||candidate.state==='suspended')return"identity_changed";
  const grantId=await uuid(`onboarding-profile-grant:${intent.decision_id}:${candidate.sourceId}:${candidate.workspaceId}:${candidate.principalPublicId}`);
  if(candidate.state==='enabled'&&candidate.currentGrantId!==grantId)return"identity_changed";
  chosen.push({...witness,candidate,grantId});
 }
 // Recheck every remote witness before reserving any proof or creating a group.
 for(const {observed} of chosen){
  if(Date.now()>deadline)return"awaiting_pa";
  const second=await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,observed.sourceId,observed.binding.externalId,observed.binding.publicId);
  if(second.status!=="observed"||identityFingerprint(second.observation)!==identityFingerprint(observed))return"awaiting_pa";
 }
 if(!await approver(env,intent))return"authority_changed";
 await env.OPS_DB.batch(chosen.map(({member:m,observed,candidate,grantId})=>env.OPS_DB.prepare(`INSERT OR IGNORE INTO client_onboarding_portal_activation_proofs
  (grant_id,decision_id,source_id,record_id,principal_public_id,association_version,binding_observation_json) VALUES(?,?,?,?,?,?,?)`)
  .bind(grantId,intent.decision_id,candidate.sourceId,m.recordId,candidate.principalPublicId,
   observed.clientPortalIdentity!.associationVersion,JSON.stringify(observed))));
 for(const {member:m,observed,candidate,grantId} of chosen){
  const proof=await env.OPS_DB.prepare(`SELECT decision_id,source_id,record_id,principal_public_id,association_version,binding_observation_json
   FROM client_onboarding_portal_activation_proofs WHERE grant_id=?`).bind(grantId)
   .first<{decision_id:string;source_id:string;record_id:string;principal_public_id:string;association_version:string;binding_observation_json:string}>();
  if(!proof||proof.decision_id!==intent.decision_id||proof.source_id!==candidate.sourceId||proof.record_id!==m.recordId
   ||proof.principal_public_id!==candidate.principalPublicId||proof.association_version!==observed.clientPortalIdentity!.associationVersion
   ||ownFingerprint(JSON.parse(proof.binding_observation_json))!==ownFingerprint(observed))return"identity_changed";
 }
 if(!group){
  await env.OPS_DB.batch([
   env.OPS_DB.prepare(`INSERT INTO client_onboarding_shared_contact_creation_fences(decision_id,mutation_id,actor_id,profile_json,membership_json)
    VALUES(?,?,?,?,?)`).bind(groupId,await uuid(`onboarding-profile-group:${groupId}`),actor.id,JSON.stringify(profile),membership),
   ...sharedProfileCreationStatements(env.OPS_DB,groupId,"client",profile,members,actor.id),
   env.OPS_DB.prepare("DELETE FROM client_onboarding_shared_contact_creation_fences WHERE decision_id=?").bind(groupId),
  ]);
 }
 for(const {member:m,candidate,grantId} of chosen){
  if(Date.now()>deadline)return"awaiting_pa";
  if(!await approver(env,intent))return"authority_changed";
  if(!await activeClientLineage(env,m.recordId))return"identity_changed";
  if(candidate.state==='enabled')continue;
  const result=await manageSharedProfilePortalGrant(env,actor,{operationId:await uuid(`onboarding-profile-issue:${grantId}`),id:grantId,
   workspaceId:candidate.workspaceId,sourceId:candidate.sourceId,
   ...(candidate.portalSourceId?{portalSourceId:candidate.portalSourceId,correspondenceRevisionId:candidate.correspondenceRevisionId}:{}),
   recipientMode:"first_verified_identity",issuer:null,subject:null,principalPublicId:candidate.principalPublicId,
   targetType:"client",targetPublicId:candidate.targetPublicId,recordId:m.recordId,groupId,expectedRevision:0,state:"active"},
   {admissionVersion:intent.original_admission_version,profileVersion:intent.original_profile_version});
  if(!result.ok)return"awaiting_portal";
 }
 // Status is a last observation, not an authorization token. Read authoritative
 // grant states again so a revocation during issuance is not reported active.
 const finalGrants=(await env.OPS_DB.withSession("first-primary").prepare(`SELECT id,state FROM shared_profile_portal_grants
  WHERE group_id=? AND id IN(SELECT value FROM json_each(?))`).bind(groupId,JSON.stringify(chosen.map(c=>c.grantId)))
  .all<{id:string;state:string}>()).results;
 if(finalGrants.length!==chosen.length)return"awaiting_portal";
 if(finalGrants.some(grant=>grant.state!=="active"))return"identity_changed";
 return"active";
}
async function activate(env:Env,intent:Intent,deadline:number):Promise<ActivationState>{
 const actor=await approver(env,intent);if(!actor)return"authority_changed";
 if(await d1TablesPresent(env.OPS_DB,["client_onboarding_shared_company_approvals"])){
  const shared=await env.OPS_DB.withSession("first-primary").prepare(`SELECT approval.plan_id,plan.client_profile_json,seal.child_count
   FROM client_onboarding_shared_company_approvals approval JOIN client_onboarding_shared_company_plans plan ON plan.plan_id=approval.plan_id
   JOIN client_onboarding_shared_company_plan_seals seal ON seal.plan_id=plan.plan_id WHERE approval.decision_id=?`)
   .bind(intent.decision_id).first<SharedApproval>();
  if(shared)return activateSharedCompany(env,intent,shared,actor,deadline);
 }
 const selected=destinations(env,intent.client_destinations_json);if(!selected)return"identity_changed";
 if(!selected.length)return"enrollment_required";
 const enrolled=await env.OPS_DB.prepare("SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?")
  .bind(intent.client_record_id).first<string>("destinations_json");
 if(!enrolled||JSON.stringify(destinations(env,enrolled))!==JSON.stringify(selected))return"identity_changed";
 const m=await member(env,intent,selected);if(!m)return"identity_changed";
 const witnessed=await observations(env,m,selected,deadline);if(!witnessed)return"awaiting_pa";
 for(const source of m.sourceIds){if(Date.now()>deadline)return"awaiting_pa";if((await probeConfiguredProjectAlphaDirectoryClientContactProfile(env,source)).status!=="verified")return"awaiting_pa";}
 const groupId=intent.decision_id;
 const group=await env.OPS_DB.prepare("SELECT group_id FROM native_directory_shared_profile_members WHERE record_id=?")
  .bind(m.recordId).first<string>("group_id");
 if(group&&group!==groupId)return"identity_changed";
 if(!group){
  const mutationId=await uuid(`onboarding-profile-group:${intent.decision_id}`);
  await env.OPS_DB.batch([sharedProfileCreationFence(env.OPS_DB,{groupId,mutationId,mode:"single",
   requestSha256:await digest(JSON.stringify([intent.decision_id,m])),actor:{staffId:actor.id,accessSubject:actor.accessSubject,
   admissionVersion:intent.original_admission_version,profileVersion:intent.original_profile_version,loginEmail:actor.email},
   kind:"client",profile:m.profile,members:[m],previewToken:null}),
   ...sharedProfileCreationStatements(env.OPS_DB,groupId,"client",m.profile,[m],actor.id)]);
 }
 const setup=await readSharedProfilePortalSetup(env,groupId,[m],true);
 if(!setup.available)return"awaiting_portal";
 const chosen=[];
 for(const observed of witnessed){
  const matches=setup.candidates.filter(c=>c.sourceId===observed.sourceId&&c.recordId===m.recordId
   &&c.targetPublicId===observed.binding.publicId&&c.principalPublicId===observed.clientPortalIdentity!.principalPublicId);
  if(matches.length!==1)return"awaiting_portal";
  if(matches[0]!.state==='revoked'||matches[0]!.state==='suspended')return"identity_changed";
  chosen.push({candidate:matches[0]!,observed});
 }
 for(const {candidate,observed} of chosen){
  if(Date.now()>deadline)return"awaiting_pa";
  const grantId=await uuid(`onboarding-profile-grant:${intent.decision_id}:${candidate.sourceId}:${candidate.workspaceId}:${candidate.principalPublicId}`);
  if(candidate.state==='enabled'&&candidate.currentGrantId!==grantId)return"identity_changed";
  const second=await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,candidate.sourceId,observed.binding.externalId,observed.binding.publicId);
  if(second.status!=="observed"||identityFingerprint(second.observation)!==identityFingerprint(observed))return"awaiting_pa";
  if(!await approver(env,intent))return"authority_changed";
  // Reserve the auto marker first. Even an interrupted grant response cannot
  // leave a template without the ongoing exact own-identity check below.
  await env.OPS_DB.prepare(`INSERT OR IGNORE INTO client_onboarding_portal_activation_proofs
   (grant_id,decision_id,source_id,record_id,principal_public_id,association_version,binding_observation_json) VALUES(?,?,?,?,?,?,?)`)
   .bind(grantId,intent.decision_id,candidate.sourceId,m.recordId,candidate.principalPublicId,
    observed.clientPortalIdentity!.associationVersion,JSON.stringify(observed)).run();
  const reserved=await env.OPS_DB.prepare("SELECT association_version FROM client_onboarding_portal_activation_proofs WHERE grant_id=?")
   .bind(grantId).first<string>("association_version");
  if(reserved!==observed.clientPortalIdentity!.associationVersion)return"identity_changed";
  // A first login may have bound this exact template while another selected
  // source was still pending. Never replay an old unbound revision over it.
  if(candidate.state==='enabled')continue;
  const result=await manageSharedProfilePortalGrant(env,actor,{operationId:await uuid(`onboarding-profile-issue:${grantId}`),id:grantId,
   workspaceId:candidate.workspaceId,sourceId:candidate.sourceId,
   ...(candidate.portalSourceId?{portalSourceId:candidate.portalSourceId,correspondenceRevisionId:candidate.correspondenceRevisionId}:{}),
   recipientMode:"first_verified_identity",issuer:null,subject:null,principalPublicId:candidate.principalPublicId,
   targetType:"client",targetPublicId:candidate.targetPublicId,recordId:m.recordId,groupId,expectedRevision:0,state:"active"},
   {admissionVersion:intent.original_admission_version,profileVersion:intent.original_profile_version});
  if(!result.ok)return"awaiting_portal";
 }
 return"active";
}

/** Default deployment gates and durable approved decisions provide service
 * authority; no human Access session is fabricated or kept alive. */
export async function processClientOnboardingPortalActivation(env:Env){
 if(env.CLIENT_ONBOARDING_ADMIN_ENABLED!=="true"||!portalAutomaticEligibilityEnabled(env)||!await d1TablesPresent(env.OPS_DB,tables))return{processed:0,active:0};
 const db=env.OPS_DB.withSession("first-primary"),scan=await db.prepare("SELECT after_decision_id,version FROM client_onboarding_portal_activation_scan WHERE singleton=1")
  .first<{after_decision_id:string;version:number}>();if(!scan)throw Error("onboarding_activation_schema_unavailable");
 const pendingAfter=async(after:string)=>(await db.prepare(`SELECT intent.decision_id,intent.client_record_id,intent.version,decision.reviewer_staff_id,
  decision.reviewer_subject,decision.reviewer_email,decision.original_admission_version,decision.original_profile_version,intent.destinations_json client_destinations_json
  FROM client_onboarding_portal_activation_intents intent JOIN client_onboarding_decisions decision ON decision.decision_id=intent.decision_id AND decision.outcome='approved'
  WHERE intent.state='pending' AND intent.decision_id>? ORDER BY intent.decision_id LIMIT 4`).bind(after).all<Intent>()).results;
 let rows=await pendingAfter(scan.after_decision_id);
 // A decision inserted below the cursor must not wait for an empty reset tick.
 // Wrap only after exhausting the tail, then process one bounded batch once.
 if(!rows.length&&scan.after_decision_id)rows=await pendingAfter("");
 let processed=0,active=0,last="";const started=Date.now();
 for(const intent of rows){if(Date.now()-started>50_000)break;last=intent.decision_id;let reason:ActivationState;
  try{reason=await activate(env,intent,started+50_000);}catch{reason="activation_failed";}
  const state=reason==='active'?'active':['authority_changed','identity_changed','enrollment_required'].includes(reason)?'blocked':'pending';
  await db.prepare(`UPDATE client_onboarding_portal_activation_intents SET state=?,reason=?,version=version+1,
   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE decision_id=? AND state='pending' AND version=?`)
   .bind(state,reason,intent.decision_id,intent.version).run();processed++;if(reason==='active')active++;
 }
 await db.prepare("UPDATE client_onboarding_portal_activation_scan SET after_decision_id=?,version=version+1 WHERE singleton=1 AND version=?")
  .bind(last,scan.version).run();return{processed,active};
}

/** Auto-issued templates require their exact PA own-client association on
 * every edit/readiness check. Manual reviewed grants retain their own policy. */
export async function onboardingPortalGrantIdentityCurrent(env:Env,grant:SharedProfilePortalGrant):Promise<boolean>{
 if(!await d1TablesPresent(env.OPS_DB,["client_onboarding_portal_activation_proofs"]))return true;
 const proof=await env.OPS_DB.prepare("SELECT source_id,record_id,principal_public_id,association_version,binding_observation_json FROM client_onboarding_portal_activation_proofs WHERE grant_id=?")
  .bind(grant.id).first<{source_id:string;record_id:string;principal_public_id:string;association_version:string;binding_observation_json:string}>();
 if(!proof)return true;
 if(proof.record_id!==grant.record_id||proof.principal_public_id!==grant.principal_public_id)return false;
 try{if(!await activeClientLineage(env,proof.record_id))return false;
  const before=JSON.parse(proof.binding_observation_json) as ProjectAlphaDirectoryBindingObservation;
  if(before.binding.publicId!==grant.target_public_id||before.sourceId!==proof.source_id
   ||proof.source_id!==(grant.directory_source_id??grant.source_id))return false;
  const value=await readConfiguredProjectAlphaDirectoryClientPortalIdentity(env,proof.source_id,before.binding.externalId,before.binding.publicId);
  return value.status==='observed'&&value.observation.sourceInstanceId===grant.source_instance_id&&value.observation.applicationId===grant.application_id
   &&value.observation.historyEpoch===grant.history_epoch_id&&value.observation.clientPortalIdentity?.state==='eligible'
   &&value.observation.clientPortalIdentity.principalPublicId===proof.principal_public_id
   &&value.observation.clientPortalIdentity.associationVersion===proof.association_version;
 }catch{return false;}
}


export async function readClientOnboardingPortalActivationStatus(database:D1Database,
  authenticated:AuthenticatedNativeStaffWithAdmissionVersion,submissionId:unknown){
 const review=await readClientOnboardingSubmissionForReview(database,authenticated,submissionId);
 const activation=await database.withSession("first-primary").prepare(`SELECT intent.client_record_id clientRecordId,
  intent.state,intent.reason,intent.updated_at updatedAt FROM client_onboarding_portal_activation_intents intent
  JOIN client_onboarding_decisions decision ON decision.decision_id=intent.decision_id WHERE decision.submission_id=?`)
  .bind(review.submissionId).first<{clientRecordId:string;state:string;reason:string;updatedAt:string}>();
 if(Date.parse(authenticated.verifiedUntil)<=Date.now())throw Error("client_onboarding_review_denied");
 return{activation:activation??null};
}
