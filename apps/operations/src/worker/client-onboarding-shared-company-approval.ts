import type {AuthenticatedNativeStaffWithAdmissionVersion} from "./native-staff-auth";
import {readClientOnboardingSubmissionForReview} from "./client-onboarding-review";
import {updateDestinations} from "./native-directory-profile-routes";
import {readNativeDirectoryDurableRemoteHead,writeSharedCompanyOnboardingMemberProfile,
 type NativeDirectoryDestinationAuthority,type NativeDirectoryClientCreateProfile,type NativeDirectoryScope} from "./native-directory-profile-writer";
import {readConfiguredProjectAlphaDirectoryBindingStatus,type ProjectAlphaDirectoryBindingObservation} from "./project-alpha-directory-read-api-v2";
import type {Env} from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const deny=():never=>{throw Error("client_onboarding_shared_company_approval_denied");};
type Plan={plan_id:string;submission_id:string;invitation_id:string;fields_sha256:string;request_sha256:string;
 client_profile_json:string;scopes_json:string;verified_until:string;reviewer_staff_id:string;reviewer_subject:string;
 reviewer_email:string;reviewer_admission_version:number;reviewer_profile_version:number};
type Child={client_record_id:string;mutation_id:string;relationship_mutation_id:string;create_admission_id:string;
 parent_record_id:string;parent_record_version:number;destinations_json:string;parent_bindings_json:string};
const fingerprint=(v:ProjectAlphaDirectoryBindingObservation)=>({sourceId:v.sourceId,sourceInstanceId:v.sourceInstanceId,
 applicationId:v.applicationId,historyEpoch:v.historyEpoch,authorizationGeneration:v.authorizationGeneration,binding:v.binding,resource:v.resource});
const identity=(d:NativeDirectoryDestinationAuthority)=>({sourceId:d.sourceId,sourceInstanceUUID:d.sourceInstanceUUID,
 applicationUUID:d.applicationUUID,historyEpoch:d.historyEpoch,origin:d.origin,externalCanonicalId:d.externalCanonicalId});
async function digest(v:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(v))))]
 .map(n=>n.toString(16).padStart(2,"0")).join("");}

/** All regular writer batches stay private to this high-level composer. */
function recording(session:D1DatabaseSession){
 let captured:readonly D1PreparedStatement[]|null=null;
 const db=new Proxy(session,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
  if(captured!==null)throw Error("onboarding member writer issued multiple batches");captured=[...statements];return[];};
  const value=target[key as keyof D1DatabaseSession];return typeof value==='function'?value.bind(target):value;}}) as unknown as D1Database;
 return{db,statements:()=>captured};
}

/** One reviewed exact company group, one atomic decision, only selected PA
 * destinations. No parent mutation, email matching, invitation or file grant. */
export async function approveClientOnboardingSharedCompany(database:D1Database,auth:AuthenticatedNativeStaffWithAdmissionVersion,
 input:Record<string,unknown>,connections:string|undefined){
 if(typeof input.planId!=='string'||!UUID.test(input.planId)||typeof input.fieldsSha256!=='string'||!SHA.test(input.fieldsSha256))return deny();
 const review=await readClientOnboardingSubmissionForReview(database,auth,input.submissionId);
 if(review.fieldsSha256!==input.fieldsSha256||review.fields.clientType!=='business'||review.targetClientRecordId!==null)return deny();
 const session=database.withSession('first-primary');
 const plan=await session.prepare(`SELECT * FROM client_onboarding_shared_company_plans WHERE plan_id=? AND submission_id=? AND fields_sha256=?`)
  .bind(input.planId,review.submissionId,review.fieldsSha256).first<Plan>();
 if(!plan||plan.reviewer_staff_id!==auth.identity.staffId||plan.reviewer_subject!==auth.identity.verifiedAccessSubject
  ||plan.reviewer_email!==auth.identity.email||plan.reviewer_admission_version!==auth.admissionVersion
  ||plan.reviewer_profile_version!==auth.identity.profileVersion)return deny();
 const grants=(await session.prepare(`SELECT permission,id FROM native_directory_grants WHERE staff_id=? AND effect='allow' AND active=1
  AND scope_kind='global' AND permission IN('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=? AND denied.effect='deny' AND denied.active=1
   AND denied.permission IN('directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage')) ORDER BY id`)
  .bind(auth.identity.staffId,auth.identity.staffId).all<{permission:string;id:string}>()).results;
 if(new Set(grants.map(g=>g.permission)).size!==4||Date.parse(auth.verifiedUntil)<=Date.now())return deny();
 const children=(await session.prepare(`SELECT * FROM client_onboarding_shared_company_plan_children WHERE plan_id=? ORDER BY client_record_id`)
  .bind(plan.plan_id).all<Child>()).results;
 if(!children.length||children.length>2)return deny();
 const requestSha=await digest(['onboarding-shared-company-approval-v1',plan.plan_id,plan.request_sha256]);
 const saved=await session.prepare(`SELECT decision.receipt_json,activation.state activation_state FROM client_onboarding_shared_company_approvals approval
  JOIN client_onboarding_decisions decision ON decision.decision_id=approval.decision_id
  JOIN client_onboarding_portal_activation_intents activation ON activation.decision_id=decision.decision_id
  WHERE approval.plan_id=? AND decision.request_sha256=?`).bind(plan.plan_id,requestSha).first<{receipt_json:string;activation_state:"pending"|"active"|"blocked"}>();
 const response=(receipt:Record<string,unknown>,replayed:boolean,portalActivation:"pending"|"active"|"blocked"="pending")=>({...receipt,replayed,planId:plan.plan_id,
  members:children.map(c=>({clientRecordId:c.client_record_id,clientRecordVersion:1,parentRecordId:c.parent_record_id,
   parentRecordVersion:c.parent_record_version,sourceIds:(JSON.parse(c.destinations_json) as NativeDirectoryDestinationAuthority[]).map(d=>d.sourceId)})),
  portalActivation});
 if(saved)return response(JSON.parse(saved.receipt_json) as Record<string,unknown>,true,saved.activation_state);
 if(!await session.prepare('SELECT 1 FROM client_onboarding_live_shared_company_plans WHERE plan_id=?').bind(plan.plan_id).first())return deny();
 const environment={OPS_DB:database,PROJECT_ALPHA_API_V2_CONNECTIONS:connections} as Env;
 const proofs:ReturnType<typeof fingerprint>[]=[],configurations:Record<string,string>[]=[],generationReceipts:{sourceId:string;requestId:string}[]=[];
 const childStatements:D1PreparedStatement[]=[];
 const deadline=Date.now()+40_000;
 const actor={staffId:auth.identity.staffId,accessSubject:auth.identity.verifiedAccessSubject,admissionVersion:auth.admissionVersion,
  profileVersion:auth.identity.profileVersion,loginEmail:auth.identity.email,
  selectedGrantId:grants.find(g=>g.permission==='directory.profile.edit')!.id,
  selectedIdentityGrantId:grants.find(g=>g.permission==='directory.identity.link')!.id};
 for(const child of children){
  if(Date.now()>deadline)return deny();
  const reviewed=JSON.parse(child.destinations_json) as NativeDirectoryDestinationAuthority[];
  const bindings=JSON.parse(child.parent_bindings_json) as ProjectAlphaDirectoryBindingObservation[];
  const current=await updateDestinations(environment,'organization',child.parent_record_id,child.parent_record_version);if(!current)return deny();
  for(const d of reviewed){
   if(Date.now()>deadline)return deny();
   const live=current.find(c=>c.sourceId===d.sourceId);
   if(!live||JSON.stringify({...live,externalCanonicalId:child.client_record_id})!==JSON.stringify(d))return deny();
   const head=await readNativeDirectoryDurableRemoteHead(database,'organization',child.parent_record_id,child.parent_record_version,live);
   if(!head)return deny();
   const bound=await readConfiguredProjectAlphaDirectoryBindingStatus(environment,d.sourceId,'organization',head.externalCanonicalId,head.projectAlphaPublicId);
   const prior=bindings.find(b=>b.sourceId===d.sourceId);
   if(bound.status!=='observed'||!prior||bound.observation.resource.revision!==head.revision
    ||JSON.stringify(fingerprint(bound.observation))!==JSON.stringify(fingerprint(prior)))return deny();
   proofs.push(fingerprint(bound.observation));
   configurations.push({sourceId:d.sourceId,sourceInstanceUUID:d.sourceInstanceUUID,applicationUUID:d.applicationUUID,historyEpoch:d.historyEpoch,origin:d.origin});
   const observed=await session.prepare(`SELECT request_id FROM project_alpha_api_v2_inventory_receipts WHERE source_id=? AND source_instance_id=?
    AND application_id=? AND history_epoch_id=? AND inventory_kind='directory' AND authorization_generation=?
    AND observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes') ORDER BY observed_at DESC,request_id DESC LIMIT 1`)
    .bind(d.sourceId,d.sourceInstanceUUID,d.applicationUUID,d.historyEpoch,d.expectedAuthorizationGeneration).first<{request_id:string}>();
   if(!observed)return deny();generationReceipts.push({sourceId:d.sourceId,requestId:observed.request_id});
  }
  const captured=recording(session),destinations=JSON.stringify(reviewed.map(identity));
  const written=await writeSharedCompanyOnboardingMemberProfile(captured.db,plan.plan_id,{operation:'create',kind:'client',expectedLocalVersion:0,
   mutationId:child.mutation_id,recordId:child.client_record_id,createAdmissionId:child.create_admission_id,
   actor,profile:JSON.parse(plan.client_profile_json) as NativeDirectoryClientCreateProfile,scopes:JSON.parse(plan.scopes_json) as NativeDirectoryScope[],
   destinations:reviewed,relationship:{organizationRecordId:child.parent_record_id,expectedRelationshipVersion:0}});
  const statements=captured.statements();if(written.status!=='written'||!statements?.length)return deny();
  childStatements.push(session.prepare(`INSERT INTO native_directory_create_admissions
   (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,'client',?,?,?,?)`)
   .bind(child.create_admission_id,actor.staffId,actor.accessSubject,child.client_record_id,plan.scopes_json,plan.client_profile_json,destinations,actor.staffId),
   session.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,organization_record_version)
    VALUES(?,?,?,?)`).bind(child.create_admission_id,child.client_record_id,child.parent_record_id,child.parent_record_version),...statements,
   session.prepare(`INSERT INTO client_onboarding_shared_company_child_receipts(decision_id,plan_id,client_record_id) VALUES(?,?,?)`)
    .bind(plan.plan_id,plan.plan_id,child.client_record_id));
 }
 const primary=children[0]!;
 const receipt={decisionId:plan.plan_id,outcome:'approved',invitationId:plan.invitation_id,submissionId:plan.submission_id,
  clientRecordId:primary.client_record_id,clientRecordVersion:1,organizationRecordId:primary.parent_record_id,
  organizationRecordVersion:primary.parent_record_version,relationshipVersion:1};
 await session.batch([
  session.prepare(`INSERT INTO client_onboarding_shared_company_execution_fences(plan_id,decision_id,request_sha256,verified_until,
   configuration_json,parent_proofs_json,generation_receipts_json,remaining_children) VALUES(?,?,?,?,?,?,?,?)`)
   .bind(plan.plan_id,plan.plan_id,requestSha,new Date(Math.min(Date.parse(auth.verifiedUntil),Date.parse(plan.verified_until),Date.now()+60_000)).toISOString(),
    JSON.stringify(configurations),JSON.stringify(proofs),JSON.stringify(generationReceipts),children.length),
  ...childStatements,
  session.prepare(`INSERT INTO client_onboarding_decisions(decision_id,invitation_id,submission_id,fields_sha256,request_sha256,outcome,
   reviewer_staff_id,reviewer_subject,reviewer_email,original_admission_version,original_profile_version,reason,reviewed_fields_json,
   client_record_id,client_record_version,organization_record_id,organization_record_version,relationship_version,receipt_json)
   VALUES(?,?,?,?,?,'approved',?,?,?,?,?,'Approved reviewed shared company onboarding',?,?,1,?,?,1,?)`)
   .bind(plan.plan_id,plan.invitation_id,plan.submission_id,plan.fields_sha256,requestSha,actor.staffId,actor.accessSubject,actor.loginEmail,
    actor.admissionVersion,actor.profileVersion,JSON.stringify(review.fields),primary.client_record_id,primary.parent_record_id,primary.parent_record_version,JSON.stringify(receipt)),
  session.prepare('INSERT INTO client_onboarding_shared_company_approvals(decision_id,plan_id) VALUES(?,?)').bind(plan.plan_id,plan.plan_id),
  session.prepare('DELETE FROM client_onboarding_shared_company_execution_fences WHERE plan_id=?').bind(plan.plan_id),
 ]);
 return response(receipt,false);
}
