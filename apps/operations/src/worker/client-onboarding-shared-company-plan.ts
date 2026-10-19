import type {AuthenticatedNativeStaffWithAdmissionVersion} from "./native-staff-auth";
import {readClientOnboardingSubmissionForReview} from "./client-onboarding-review";
import {parseClientOnboardingEnrollmentSourceIds} from "./client-onboarding-enrollment-selection";
import {canonicalRecordId,clientUpdateProfile,normalizeProfile,updateDestinations} from "./native-directory-profile-routes";
import {readNativeDirectoryDurableRemoteHead,type NativeDirectoryDestinationAuthority} from "./native-directory-profile-writer";
import {readConfiguredProjectAlphaDirectoryBindingStatus,type ProjectAlphaDirectoryBindingObservation} from "./project-alpha-directory-read-api-v2";
import type {Env} from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const deny=():never=>{throw Error("client_onboarding_shared_company_plan_denied");};
type Auth=AuthenticatedNativeStaffWithAdmissionVersion;
export type SharedCompanySelection=Readonly<{kind:"shared_existing";groupId:string;expectedVersion:number;
 members:readonly Readonly<{recordId:string;expectedVersion:number}>[]}>;
type CompanyMember={recordId:string;expectedVersion:number;destinationsJson:string};
type PlannedChild={clientRecordId:string;mutationId:string;relationshipMutationId:string;createAdmissionId:string;
 parentRecordId:string;parentRecordVersion:number;destinations:readonly NativeDirectoryDestinationAuthority[];
 parentEnrollmentJson:string;bindings:readonly ProjectAlphaDirectoryBindingObservation[]};

export function parseSharedCompanySelection(value:unknown):SharedCompanySelection|null {
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const row=value as Record<string,unknown>;
 if(Object.keys(row).length!==4||row.kind!=="shared_existing"||typeof row.groupId!=="string"||!UUID.test(row.groupId)
  ||typeof row.expectedVersion!=="number"||!Number.isSafeInteger(row.expectedVersion)||row.expectedVersion<1
  ||!Array.isArray(row.members)||row.members.length<1||row.members.length>2)return null;
 const members:SharedCompanySelection["members"][number][]=[];
 for(const member of row.members){
  if(!member||typeof member!=="object"||Array.isArray(member))return null;
  const m=member as Record<string,unknown>;
  if(Object.keys(m).length!==2||!canonicalRecordId.safeParse(m.recordId).success
   ||typeof m.expectedVersion!=="number"||!Number.isSafeInteger(m.expectedVersion)||m.expectedVersion<1)return null;
  members.push({recordId:m.recordId as string,expectedVersion:m.expectedVersion});
 }
 if(members.some((m,index)=>index>0&&members[index-1]!.recordId>=m.recordId))return null;
 return {kind:"shared_existing",groupId:row.groupId,expectedVersion:row.expectedVersion,members};
}
async function textHash(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
 .map(n=>n.toString(16).padStart(2,"0")).join("");}
async function hash(value:unknown){return textHash(JSON.stringify(value));}
function uuidDigest(h:string){return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${((parseInt(h[16]!,16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;}
async function uuid(value:unknown){return uuidDigest(await hash(value));}
async function relationshipUuid(seed:string){return uuidDigest(await textHash(seed));}
const authoritySql=`SELECT 1 FROM native_staff_admissions admission
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active'
 WHERE admission.staff_id=? AND admission.active=1 AND admission.version=? AND admission.bound_access_subject=?
 AND profile.version=? AND profile.login_email=? AND staff.access_subject=admission.bound_access_subject AND staff.email=profile.login_email
 AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM json_each('["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"]') required
   WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allowed WHERE allowed.staff_id=admission.staff_id AND allowed.permission=required.value
    AND allowed.effect='allow' AND allowed.active=1 AND allowed.scope_kind='global'))
 AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=admission.staff_id AND denied.effect='deny'
   AND denied.active=1 AND denied.permission IN('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage'))`;
function authorityParameters(auth:Auth){return [auth.identity.staffId,auth.admissionVersion,auth.identity.verifiedAccessSubject,
 auth.identity.profileVersion,auth.identity.email,auth.verifiedUntil];}
async function authorize(db:D1Database,auth:Auth){if(!await db.withSession("first-primary").prepare(authoritySql).bind(...authorityParameters(auth)).first())return deny();}
async function companyMembers(db:D1Database,selection:SharedCompanySelection):Promise<CompanyMember[]> {
 const rows=(await db.withSession("first-primary").prepare(`SELECT record.record_id recordId,record.current_version expectedVersion,
  enrollment.destinations_json destinationsJson FROM native_directory_shared_profiles company
  JOIN native_directory_shared_profile_members member ON member.group_id=company.id
  JOIN operations_directory_records record ON record.record_id=member.record_id AND record.record_kind='organization'
  JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
  JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
  LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
  WHERE company.id=? AND company.version=? AND company.kind='organization' AND (lifecycle.record_id IS NULL OR lifecycle.status='active')
   AND (SELECT count(*) FROM native_directory_shared_profile_members actual WHERE actual.group_id=company.id)=json_array_length(company.membership_json)
   AND EXISTS(SELECT 1 FROM json_each(company.membership_json) id WHERE id.value=member.record_id)
  ORDER BY record.record_id LIMIT 3`).bind(selection.groupId,selection.expectedVersion).all<CompanyMember>()).results;
 if(JSON.stringify(rows.map(({recordId,expectedVersion})=>({recordId,expectedVersion})))!==JSON.stringify(selection.members))return deny();
 return rows;
}
function receipt(planId:string,submissionId:string,selection:SharedCompanySelection,sourceIds:readonly string[],expiresAt:string,children:readonly PlannedChild[],approvalAvailable:boolean) {
 return {planId,submissionId,companyGroupId:selection.groupId,companyGroupVersion:selection.expectedVersion,
  sourceIds,expiresAt,state:"reviewed" as const,approvalAvailable,
  children:children.map(c=>({clientRecordId:c.clientRecordId,parentRecordId:c.parentRecordId,
   parentRecordVersion:c.parentRecordVersion,sourceIds:c.destinations.map(d=>d.sourceId)}))};
}

// A reviewed 0217 plan is not sufficient: 0218 must supply the complete
// composed approval protocol. Checking each object also fails closed during a
// partial migration, without writing an execution fence merely to test it.
const approvalProtocolObjects = [
 "client_onboarding_shared_company_parent_heads", "client_onboarding_shared_company_execution_fences",
 "client_onboarding_live_shared_company_execution_fences", "client_onboarding_shared_company_execution_insert",
 "client_onboarding_shared_company_child_receipts", "client_onboarding_shared_company_child_receipt_insert",
 "client_onboarding_shared_company_child_delivery_guard", "client_onboarding_shared_company_child_receipt_consume",
 "client_onboarding_shared_company_child_receipt_immutable", "client_onboarding_shared_company_child_receipt_durable",
 "client_onboarding_shared_company_execution_update", "client_onboarding_shared_company_member_admission",
 "client_onboarding_shared_company_approvals", "client_onboarding_shared_company_approval_insert",
 "client_onboarding_shared_company_approval_immutable", "client_onboarding_shared_company_approval_durable",
 "client_onboarding_shared_company_approval_stage", "client_onboarding_shared_company_execution_complete",
 "client_onboarding_shared_contact_creation_fences", "client_onboarding_live_shared_contact_creation_fences",
 "client_onboarding_shared_contact_creation_insert", "client_onboarding_shared_contact_creation_immutable",
 "client_onboarding_shared_contact_creation_complete", "client_onboarding_decisions_protocol_exclusive",
 "client_onboarding_decisions_insert_guard", "client_onboarding_decisions_legacy_insert_guard",
 "client_onboarding_decisions_shared_insert_guard", "native_directory_shared_group_insert",
 "client_onboarding_portal_activation_proof_insert", "client_onboarding_shared_execution_live_plan",
 "client_onboarding_shared_child_live_plan", "client_onboarding_shared_child_live_evidence",
 "client_onboarding_shared_decision_live_plan", "client_onboarding_shared_decision_live_evidence",
 "client_onboarding_shared_admission_live_plan", "client_onboarding_shared_admission_live_evidence",
];

/** Advisory, read-only final check, used only after prepare's fresh remote
 * proofs. It confers no authority and does not replace approve's revalidation. */
async function approvalAvailable(database:D1Database,auth:Auth,planId:string,children:readonly PlannedChild[]){
 const db=database.withSession("first-primary");
 const supported=await db.prepare(`SELECT 1 supported WHERE NOT EXISTS(
  SELECT 1 FROM json_each(?) required LEFT JOIN sqlite_master object ON object.name=required.value
   AND object.type IN('table','view','trigger') WHERE object.name IS NULL)`)
  .bind(JSON.stringify(approvalProtocolObjects)).first();
 if(!supported)return false;
 // The 0218 SQL head view is deliberately execution-fence scoped. Use the
 // normal read-only head resolver here; never open a mutation fence for UI.
 for(const child of children)for(const destination of child.destinations){
  const proof=child.bindings.find(p=>p.sourceId===destination.sourceId);
  if(!proof)return false;
  const head=await readNativeDirectoryDurableRemoteHead(database,"organization",child.parentRecordId,child.parentRecordVersion,
   {...destination,externalCanonicalId:proof.binding.externalId});
  if(!head||!proof||head.externalCanonicalId!==proof.binding.externalId||head.projectAlphaPublicId!==proof.binding.publicId
   ||head.revision!==proof.resource.revision||!proof.resource.present)return false;
 }
 return !!await db.prepare(`SELECT 1 FROM client_onboarding_live_shared_company_plans plan
  JOIN client_onboarding_shared_company_plan_seals seal ON seal.plan_id=plan.plan_id
  WHERE plan.plan_id=? AND plan.reviewer_staff_id=? AND plan.reviewer_subject=? AND plan.reviewer_email=?
   AND plan.reviewer_admission_version=? AND plan.reviewer_profile_version=?
   AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND seal.child_count=(SELECT count(*) FROM client_onboarding_shared_company_plan_children child WHERE child.plan_id=plan.plan_id)
   AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child
    LEFT JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=child.parent_record_id
    WHERE child.plan_id=plan.plan_id AND(enrollment.record_id IS NULL OR json(enrollment.destinations_json)<>json(child.parent_enrollment_json)))
   AND NOT EXISTS(SELECT 1 FROM client_onboarding_shared_company_plan_children child JOIN json_each(child.destinations_json) destination
    WHERE child.plan_id=plan.plan_id AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
     WHERE receipt.source_id=json_extract(destination.value,'$.sourceId')
      AND receipt.source_instance_id=json_extract(destination.value,'$.sourceInstanceUUID')
      AND receipt.application_id=json_extract(destination.value,'$.applicationUUID') AND receipt.history_epoch_id=json_extract(destination.value,'$.historyEpoch')
      AND receipt.inventory_kind='directory' AND receipt.authorization_generation=json_extract(destination.value,'$.expectedAuthorizationGeneration')
      AND receipt.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') AND receipt.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))` )
  .bind(planId,auth.identity.staffId,auth.identity.verifiedAccessSubject,auth.identity.email,auth.admissionVersion,
   auth.identity.profileVersion,auth.verifiedUntil).first();
}
function bindingFingerprint(value:ProjectAlphaDirectoryBindingObservation){return {sourceId:value.sourceId,
 sourceInstanceId:value.sourceInstanceId,applicationId:value.applicationId,historyEpoch:value.historyEpoch,
 authorizationGeneration:value.authorizationGeneration,binding:value.binding,resource:value.resource};}

/** Captures reviewed evidence only; there is intentionally no create-admission,
 * client/profile writer, approval receipt, portal template, email or file grant. */
export async function prepareClientOnboardingSharedCompanyPlan(database:D1Database,auth:Auth,input:Record<string,unknown>,connections:string|undefined){
 const selected=parseSharedCompanySelection(input.organizationSelection),sources=parseClientOnboardingEnrollmentSourceIds(input.sourceIds);
 if(typeof input.commandId!=="string"||!UUID.test(input.commandId)||typeof input.fieldsSha256!=="string"||!SHA.test(input.fieldsSha256)
  ||!selected||!sources||sources.length<1||sources.length>2)return deny();
 const review=await readClientOnboardingSubmissionForReview(database,auth,input.submissionId);
 if(review.targetClientRecordId!==null||review.fields.clientType!=="business"||review.fieldsSha256!==input.fieldsSha256)return deny();
 await authorize(database,auth);
 const members=await companyMembers(database,selected),deadline=Date.now()+40_000,children:PlannedChild[]=[];
 const {organizationName:_company,organizationEmail:_email,organizationPhone:_phone,clientType,...contact}=review.fields;
 const parsed=clientUpdateProfile.safeParse(contact);if(!parsed.success)return deny();
 const profile={...normalizeProfile(parsed.data),clientType};
 const env={OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections} as Env;
 for(const parent of members){
  const enrollment=JSON.parse(parent.destinationsJson) as {sourceId:string}[];
  if(!Array.isArray(enrollment))return deny();
  const chosen=sources.filter(source=>enrollment.some(d=>d.sourceId===source));if(!chosen.length)continue;
  for(const source of chosen)if(members.filter(m=>(JSON.parse(m.destinationsJson) as {sourceId:string}[]).some(d=>d.sourceId===source)).length!==1)return deny();
  if(Date.now()>deadline)return deny();
  const all=await updateDestinations(env,"organization",parent.recordId,parent.expectedVersion);if(!all)return deny();
  const destinations=all.filter(d=>chosen.includes(d.sourceId)),bindings:ProjectAlphaDirectoryBindingObservation[]=[];
  if(destinations.length!==chosen.length)return deny();
  for(const destination of destinations){
   if(Date.now()>deadline)return deny();
   const head=await readNativeDirectoryDurableRemoteHead(database,"organization",parent.recordId,parent.expectedVersion,destination);
   if(!head)return deny();
   const bound=await readConfiguredProjectAlphaDirectoryBindingStatus(env,destination.sourceId,"organization",head.externalCanonicalId,head.projectAlphaPublicId);
   if(bound.status!=="observed"||bound.observation.resource.revision!==head.revision
    ||bound.observation.authorizationGeneration!==destination.expectedAuthorizationGeneration)return deny();
   bindings.push(bound.observation);
  }
  const clientRecordId=await uuid(["onboarding-shared-company-child-v1",input.commandId,parent.recordId]);
  const mutationId=await uuid(["onboarding-shared-company-mutation-v1",input.commandId,parent.recordId]);
  children.push({clientRecordId,mutationId,
   relationshipMutationId:await relationshipUuid(`${mutationId}\0client-relationship\0${parent.recordId}`),
   createAdmissionId:`client-onboarding-member:${input.commandId}:${clientRecordId}`,
   parentRecordId:parent.recordId,parentRecordVersion:parent.expectedVersion,parentEnrollmentJson:parent.destinationsJson,
   destinations:destinations.map(d=>({...d,externalCanonicalId:clientRecordId})),bindings});
 }
 if(children.length<1||children.length>2||children.reduce((n,c)=>n+c.destinations.length,0)!==sources.length)return deny();
 const requestSha=await hash(["onboarding-shared-company-plan-v1",input.commandId,review.invitationId,review.submissionId,review.fieldsSha256,
  selected,sources,review.scopes,profile,auth.identity.staffId,auth.identity.verifiedAccessSubject,auth.admissionVersion,auth.identity.profileVersion,
  children.map(c=>({...c,bindings:c.bindings.map(bindingFingerprint)}))]);
 const saved=await database.withSession("first-primary").prepare(`SELECT plan.request_sha256 requestSha,plan.verified_until expiresAt
  FROM client_onboarding_live_shared_company_plans plan JOIN client_onboarding_shared_company_plan_seals seal ON seal.plan_id=plan.plan_id
  WHERE plan.plan_id=?`).bind(input.commandId).first<{requestSha:string;expiresAt:string}>();
 if(saved){if(saved.requestSha!==requestSha)return deny();return {...receipt(input.commandId,review.submissionId,selected,sources,saved.expiresAt,children,
  await approvalAvailable(database,auth,input.commandId,children)),replayed:true};}
 const expiresAt=new Date(Math.min(Date.parse(auth.verifiedUntil),Date.now()+15*60_000)).toISOString();
 await database.withSession("first-primary").batch([
  database.prepare(`INSERT INTO client_onboarding_shared_company_plans(plan_id,submission_id,invitation_id,fields_sha256,request_sha256,
   company_group_id,company_group_version,company_members_json,source_ids_json,scopes_json,client_profile_json,
   reviewer_staff_id,reviewer_subject,reviewer_email,reviewer_admission_version,reviewer_profile_version,verified_until)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId,review.submissionId,review.invitationId,review.fieldsSha256,requestSha,
    selected.groupId,selected.expectedVersion,JSON.stringify(selected.members),JSON.stringify(sources),JSON.stringify(review.scopes),JSON.stringify(profile),
    auth.identity.staffId,auth.identity.verifiedAccessSubject,auth.identity.email,auth.admissionVersion,auth.identity.profileVersion,expiresAt),
  ...children.map(child=>database.prepare(`INSERT INTO client_onboarding_shared_company_plan_children(plan_id,client_record_id,mutation_id,
   relationship_mutation_id,create_admission_id,parent_record_id,parent_record_version,destinations_json,parent_enrollment_json,parent_bindings_json)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId,child.clientRecordId,child.mutationId,child.relationshipMutationId,child.createAdmissionId,
    child.parentRecordId,child.parentRecordVersion,JSON.stringify(child.destinations),child.parentEnrollmentJson,JSON.stringify(child.bindings))),
  database.prepare("INSERT INTO client_onboarding_shared_company_plan_seals(plan_id,child_count) VALUES(?,?)").bind(input.commandId,children.length),
 ]);
 return {...receipt(input.commandId,review.submissionId,selected,sources,expiresAt,children,
  await approvalAvailable(database,auth,input.commandId,children)),replayed:false};
}

/** Credential-free exact group choices for review. No email/name matching is
 * used to choose an identity; authorization is inside the bounded SQL query. */
export async function readClientOnboardingSharedCompanyChoices(database:D1Database,auth:Auth,input:Record<string,unknown>){
 const sources=parseClientOnboardingEnrollmentSourceIds(input.sourceIds);
 if(!sources||sources.length>2||typeof input.query!=="string"||input.query.length>150||/\p{C}/u.test(input.query)
  ||!(input.afterGroupId===null||(typeof input.afterGroupId==="string"&&UUID.test(input.afterGroupId))))return deny();
 const review=await readClientOnboardingSubmissionForReview(database,auth,input.submissionId);
 if(review.fields.clientType!=="business"||review.targetClientRecordId!==null)return deny();
 await authorize(database,auth);
 const rows=(await database.withSession("first-primary").prepare(`SELECT company.id groupId,company.version expectedVersion,
  json_extract(company.profile_json,'$.name') name,
  (SELECT json_group_array(json_object('recordId',recordId,'expectedVersion',expectedVersion,'destinations',json(destinations),'lifecycle',lifecycle))
   FROM (SELECT record.record_id recordId,record.current_version expectedVersion,enrollment.destinations_json destinations,lifecycle.status lifecycle
    FROM native_directory_shared_profile_members member
    JOIN operations_directory_records record ON record.record_id=member.record_id AND record.record_kind='organization'
    JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
    LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
    WHERE member.group_id=company.id ORDER BY record.record_id)) membersJson,
  json_array_length(company.membership_json) expectedCount
  FROM native_directory_shared_profiles company
  WHERE EXISTS(${authoritySql}) AND company.kind='organization' AND (? IS NULL OR company.id>?)
   AND instr(lower(json_extract(company.profile_json,'$.name')),lower(?))>0
  ORDER BY company.id LIMIT 21`).bind(...authorityParameters(auth),input.afterGroupId,input.afterGroupId,input.query)
  .all<{groupId:string;expectedVersion:number;name:string;membersJson:string;expectedCount:number}>()).results;
 return {companies:rows.slice(0,20).map(row=>{
  const members=JSON.parse(row.membersJson) as {recordId:string;expectedVersion:number;destinations:{sourceId:string}[];lifecycle:string|null}[];
  const reason=members.length!==row.expectedCount||members.length<1||members.length>2?"membership_unavailable"
   :members.some(m=>m.lifecycle!==null&&m.lifecycle!=="active")?"company_not_active"
   :sources.length===0?"select_destination":sources.some(source=>members.filter(m=>m.destinations.some(d=>d.sourceId===source)).length!==1)
    ?"selected_sources_not_unique":null;
  return {groupId:row.groupId,expectedVersion:row.expectedVersion,name:row.name,
   members:members.map(m=>({recordId:m.recordId,expectedVersion:m.expectedVersion,sourceIds:m.destinations.map(d=>d.sourceId).sort()})),
   reviewAvailable:reason===null,reason};
 }),nextAfterGroupId:rows.length>20?rows[19]!.groupId:null,approvalAvailable:false as const};
}
