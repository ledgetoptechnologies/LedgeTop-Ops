import { readConfiguredProjectAlphaDirectoryProfile, type ProjectAlphaDirectoryProfile } from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";

export const DIRECTORY_ADOPTION_ORGANIZATION_FIELDS = ["name","email","phone","address_line1","address_line2","city","state","postal_code","country"] as const;
export const DIRECTORY_ADOPTION_CLIENT_FIELDS = [...DIRECTORY_ADOPTION_ORGANIZATION_FIELDS,"client_type","organization_public_id"] as const;
export type DirectoryAdoptionField = typeof DIRECTORY_ADOPTION_CLIENT_FIELDS[number];
export type DirectoryAdoptionFieldDecision = "unchanged" | "retain_local" | "adopt_project_alpha" | "requires_follow_up";

export type DirectoryAdoptionFieldReviewInput = Readonly<{
  reviewId: string;
  decisions: Readonly<Partial<Record<DirectoryAdoptionField, DirectoryAdoptionFieldDecision>>>;
  actor: Readonly<{ staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number }>;
}>;
export type DirectoryAdoptionFieldReviewOutcome =
  | Readonly<{ status: "sealed" | "replayed"; receiptId: string }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" | "invalid_decisions" }>
  | Readonly<{ status: "blocked"; reason: "reservation_not_current" | "local_profile_contract" | "pa_read" | "pa_profile_changed" | "storage" }>
  | Readonly<{ status: "conflict"; reason: "review_already_sealed" }>;
export type DirectoryAdoptionFieldComparisonOutcome =
  | Readonly<{ status:"compared"; reviewId:string; resourceType:"client"|"organization"; fields:readonly Readonly<{
      field:DirectoryAdoptionField; localValue:string|null; projectAlphaValue:string|null; equal:boolean;
    }>[] }>
  | Readonly<{ status:"disabled" }>
  | Readonly<{ status:"rejected"; reason:"invalid_input" }>
  | Readonly<{ status:"blocked"; reason:"reservation_not_current"|"local_profile_contract"|"pa_read"|"pa_profile_changed" }>;

type Reservation = Readonly<{
  claim_id:string; source_id:string; source_instance_id:string; application_id:string; history_epoch_id:string;
  resource_type:"client"|"organization"; record_id:string; external_id:string; project_alpha_public_id:string;
  project_alpha_revision:string; authorization_generation:string; expected_local_record_version:number;
  reviewer_staff_id:string; reviewer_access_subject:string; reviewer_admission_version:number; reviewer_profile_version:number;
  profile_json:string;
}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECISIONS=new Set<DirectoryAdoptionFieldDecision>(["unchanged","retain_local","adopt_project_alpha","requires_follow_up"]);

async function sha(value: unknown): Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)), b=>b.toString(16).padStart(2,"0")).join("");
}
function object(value: unknown): value is Record<string,unknown> { return !!value && typeof value==="object" && !Array.isArray(value); }
function actorValid(value: DirectoryAdoptionFieldReviewInput["actor"]): boolean {
  return object(value) && typeof value.staffId==="string" && value.staffId.length>0 && typeof value.accessSubject==="string" && value.accessSubject.length>0
    && Number.isInteger(value.admissionVersion) && value.admissionVersion>=1 && Number.isInteger(value.profileVersion) && value.profileVersion>=1;
}
function fields(kind: Reservation["resource_type"]): readonly DirectoryAdoptionField[] {
  return kind==="client" ? DIRECTORY_ADOPTION_CLIENT_FIELDS : DIRECTORY_ADOPTION_ORGANIZATION_FIELDS;
}
function validDecisions(value: unknown, kind: Reservation["resource_type"]): value is Record<DirectoryAdoptionField,DirectoryAdoptionFieldDecision> {
  if (!object(value)) return false;
  const expected=fields(kind), keys=Object.keys(value);
  return keys.length===expected.length && expected.every(key=>Object.hasOwn(value,key) && DECISIONS.has(value[key] as DirectoryAdoptionFieldDecision));
}
function localProfile(raw: string, kind: Reservation["resource_type"]): Record<DirectoryAdoptionField,unknown>|null {
  try {
    const value=JSON.parse(raw) as unknown;
    if (!object(value)) return null;
    const required=["name","generalEmail","generalPhone","addressLine1","addressLine2","city","state","postalCode","country"];
    if (!required.every(key=>typeof value[key]==="string")) return null;
    const result: Record<string,unknown>={ name:value.name,email:value.generalEmail,phone:value.generalPhone,address_line1:value.addressLine1,
      address_line2:value.addressLine2,city:value.city,state:value.state,postal_code:value.postalCode,country:value.country };
    if (kind==="client") {
      if (!(["unknown","business","consumer"] as unknown[]).includes(value.clientType) || !(value.organizationPublicId===null || typeof value.organizationPublicId==="string")) return null;
      result.client_type=value.clientType; result.organization_public_id=value.organizationPublicId;
    }
    return result as Record<DirectoryAdoptionField,unknown>;
  } catch { return null; }
}
function remoteProfile(value: ProjectAlphaDirectoryProfile, kind: Reservation["resource_type"]): Record<DirectoryAdoptionField,unknown> {
  const result:Record<string,unknown>={ name:value.name,email:value.email,phone:value.phone,address_line1:value.address.line1,address_line2:value.address.line2,
    city:value.address.city,state:value.address.state,postal_code:value.address.postalCode,country:value.address.country };
  if(kind==="client"){ result.client_type=value.clientType; result.organization_public_id=value.organizationPublicId; }
  return result as Record<DirectoryAdoptionField,unknown>;
}
function comparisonValue(value:unknown):string|null { return value===null ? null : String(value); }
async function reservation(db:D1Database,input:DirectoryAdoptionFieldReviewInput):Promise<Reservation|null>{
  return db.prepare(`SELECT claim.claim_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
    review.resource_type,review.record_id,review.external_id,review.project_alpha_public_id,review.project_alpha_revision,
    review.authorization_generation,review.expected_local_record_version,review.reviewer_staff_id,review.reviewer_access_subject,
    review.reviewer_admission_version,review.reviewer_profile_version,revision.profile_json
    FROM project_alpha_directory_read_adoption_reviews review
    JOIN project_alpha_directory_read_adoption_claims claim ON claim.review_id=review.review_id AND claim.state='inactive'
    JOIN operations_directory_records record ON record.record_id=review.record_id AND record.record_kind=review.resource_type
      AND record.current_version=review.expected_local_record_version
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    JOIN native_staff_admissions admission ON admission.staff_id=review.reviewer_staff_id AND admission.active=1
      AND admission.bound_access_subject=review.reviewer_access_subject AND admission.version=review.reviewer_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=review.reviewer_profile_version
    WHERE review.review_id=? AND review.reviewer_staff_id=? AND review.reviewer_access_subject=?
      AND review.reviewer_admission_version=? AND review.reviewer_profile_version=?`).bind(input.reviewId,input.actor.staffId,input.actor.accessSubject,input.actor.admissionVersion,input.actor.profileVersion).first<Reservation>();
}

type Compared = Readonly<{ selected:Reservation; observed:Extract<Awaited<ReturnType<typeof readConfiguredProjectAlphaDirectoryProfile>>,{status:"observed"}>["observation"];
  local:Record<DirectoryAdoptionField,unknown>; remote:Record<DirectoryAdoptionField,unknown> }>;
async function compareEvidence(env:Env,reviewId:string,actor:DirectoryAdoptionFieldReviewInput["actor"],readProfile:typeof readConfiguredProjectAlphaDirectoryProfile):Promise<Compared|Exclude<DirectoryAdoptionFieldComparisonOutcome,{status:"compared"}>>{
  if(env.ENVIRONMENT!=="staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED!=="true") return {status:"disabled"};
  if(!UUID.test(reviewId) || !actorValid(actor)) return {status:"rejected",reason:"invalid_input"};
  const selected=await reservation(env.OPS_DB,{reviewId,decisions:{} as DirectoryAdoptionFieldReviewInput["decisions"],actor});
  if(!selected) return {status:"blocked",reason:"reservation_not_current"};
  const local=localProfile(selected.profile_json,selected.resource_type);
  if(!local) return {status:"blocked",reason:"local_profile_contract"};
  const read=await readProfile(env,selected.source_id,selected.resource_type,selected.project_alpha_public_id);
  if(read.status!=="observed") return {status:"blocked",reason:"pa_read"};
  const observed=read.observation;
  if(observed.sourceInstanceId!==selected.source_instance_id || observed.applicationId!==selected.application_id
    || observed.historyEpoch!==selected.history_epoch_id || observed.resource.type!==selected.resource_type
    || observed.resource.id!==selected.project_alpha_public_id || observed.resource.revision!==selected.project_alpha_revision
    || observed.authorizationGeneration!==selected.authorization_generation) return {status:"blocked",reason:"pa_profile_changed"};
  return {selected,observed,local,remote:remoteProfile(observed.profile,selected.resource_type)};
}

/** Returns raw compared values only to its caller; it performs no persistence. */
export async function compareProjectAlphaDirectoryReadAdoptionFields(
  env:Env,reviewId:string,actor:DirectoryAdoptionFieldReviewInput["actor"],
  readProfile:typeof readConfiguredProjectAlphaDirectoryProfile=readConfiguredProjectAlphaDirectoryProfile,
):Promise<DirectoryAdoptionFieldComparisonOutcome>{
  const evidence=await compareEvidence(env,reviewId,actor,readProfile);
  if("status" in evidence) return evidence;
  return {status:"compared",reviewId,resourceType:evidence.selected.resource_type,
    fields:fields(evidence.selected.resource_type).map(field=>Object.freeze({field,localValue:comparisonValue(evidence.local[field]),
      projectAlphaValue:comparisonValue(evidence.remote[field]),equal:Object.is(evidence.local[field],evidence.remote[field])}))};
}

/** Seals enum-only comparison outcomes. It never writes profile values or activation authority. */
export async function sealProjectAlphaDirectoryReadAdoptionFieldReview(
  env:Env,input:DirectoryAdoptionFieldReviewInput,
  readProfile:typeof readConfiguredProjectAlphaDirectoryProfile=readConfiguredProjectAlphaDirectoryProfile,
):Promise<DirectoryAdoptionFieldReviewOutcome>{
  if(env.ENVIRONMENT!=="staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED!=="true") return {status:"disabled"};
  if (!object(input) || !UUID.test(input.reviewId) || !actorValid(input.actor)) return {status:"rejected",reason:"invalid_input"};
  const requestSha=await sha({reviewId:input.reviewId,decisions:input.decisions,actor:input.actor});
  const prior=await env.OPS_DB.prepare(`SELECT receipt_id,request_sha256,resource_type FROM project_alpha_directory_read_adoption_field_review_receipts WHERE review_id=?`).bind(input.reviewId).first<{receipt_id:string;request_sha256:string;resource_type:Reservation["resource_type"]}>();
  if(prior) {
    if(!validDecisions(input.decisions,prior.resource_type)) return {status:"rejected",reason:"invalid_decisions"};
    return prior.request_sha256===requestSha ? {status:"replayed",receiptId:prior.receipt_id}:{status:"conflict",reason:"review_already_sealed"};
  }
  const evidence=await compareEvidence(env,input.reviewId,input.actor,readProfile);
  if("status" in evidence) return evidence;
  const {selected,observed,local,remote}=evidence;
  if(!validDecisions(input.decisions,selected.resource_type)) return {status:"rejected",reason:"invalid_decisions"};
  for(const field of fields(selected.resource_type)) {
    const equal=Object.is(local[field],remote[field]);
    if((input.decisions[field]==="unchanged")!==equal) return {status:"rejected",reason:"invalid_decisions"};
  }
  const receiptId=crypto.randomUUID(),auditId=crypto.randomUUID(),at=new Date().toISOString();
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_review_receipts(
        receipt_id,review_id,claim_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,resource_type,
        record_id,external_id,project_alpha_public_id,project_alpha_revision,authorization_generation,local_record_version,
        local_profile_sha256,project_alpha_profile_sha256,project_alpha_profile_request_id,reviewer_staff_id,reviewer_access_subject,
        reviewer_admission_version,reviewer_profile_version,decision_count,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        receiptId,input.reviewId,selected.claim_id,requestSha,selected.source_id,selected.source_instance_id,selected.application_id,selected.history_epoch_id,
        selected.resource_type,selected.record_id,selected.external_id,selected.project_alpha_public_id,selected.project_alpha_revision,selected.authorization_generation,
        selected.expected_local_record_version,await sha(JSON.parse(selected.profile_json)),await sha(observed.profile),observed.requestId,
        input.actor.staffId,input.actor.accessSubject,input.actor.admissionVersion,input.actor.profileVersion,fields(selected.resource_type).length,at),
      ...fields(selected.resource_type).map(field=>env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_decisions(receipt_id,field_name,decision) VALUES(?,?,?)`).bind(receiptId,field,input.decisions[field])),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_review_audit(audit_id,receipt_id,event,actor_staff_id,occurred_at) VALUES(?,?,'field_review_sealed',?,?)`).bind(auditId,receiptId,input.actor.staffId,at),
    ]);
    return {status:"sealed",receiptId};
  } catch {
    const concurrent=await env.OPS_DB.prepare(`SELECT receipt_id,request_sha256 FROM project_alpha_directory_read_adoption_field_review_receipts WHERE review_id=?`).bind(input.reviewId).first<{receipt_id:string;request_sha256:string}>();
    if(concurrent) return concurrent.request_sha256===requestSha?{status:"replayed",receiptId:concurrent.receipt_id}:{status:"conflict",reason:"review_already_sealed"};
    return {status:"blocked",reason:"storage"};
  }
}
