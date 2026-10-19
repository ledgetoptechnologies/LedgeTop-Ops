import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { readClientOnboardingSubmissionForReview } from "./client-onboarding-review";
import { parseClientOnboardingEnrollmentSourceIds } from "./client-onboarding-enrollment-selection";
import type { NativeDirectoryOrganizationProfile, NativeDirectoryDestinationAuthority } from "./native-directory-profile-writer";
import { selectGrant, updateDestinations, organizationProfile, normalizeProfile } from "./native-directory-profile-routes";
import type { Env } from "./types";

export type ClientOnboardingOrganizationSelection = Readonly<{kind:"new"}>
  | Readonly<{kind:"existing";recordId:string;expectedVersion:number}>;
const denied = ():never => {throw Error("client_onboarding_approval_denied");};
export function parseClientOnboardingOrganizationSelection(value:unknown):ClientOnboardingOrganizationSelection|null {
  if (!value || typeof value!=="object" || Array.isArray(value)) return null;
  const row=value as Record<string,unknown>;
  if (row.kind==="new" && Object.keys(row).length===1) return {kind:"new"};
  return row.kind==="existing" && Object.keys(row).length===3 && typeof row.recordId==="string"
    && row.recordId.length>0 && Array.from(row.recordId).length<=191 && !/\p{C}/u.test(row.recordId)
    && new TextEncoder().encode(row.recordId).byteLength<=764
    && typeof row.expectedVersion==="number" && Number.isSafeInteger(row.expectedVersion) && row.expectedVersion>=1
    ? {kind:"existing",recordId:row.recordId,expectedVersion:row.expectedVersion}:null;
}
function profile(value:unknown):NativeDirectoryOrganizationProfile|null {
  try {
    const original=JSON.parse(String(value)) as NativeDirectoryOrganizationProfile;
    const checked=organizationProfile.safeParse(original);
    if(!checked.success) return null;
    const normalized=normalizeProfile(checked.data);
    return Object.keys(checked.data).every(key=>normalized[key]===checked.data[key as keyof typeof checked.data])
      ? original:null;
  } catch {return null;}
}
/** Reusing a company preserves its business fields and every existing PA enrollment.
 * Its normal guarded writer creates an audited no-op revision, atomically linking
 * the new contact. Grouped parent aliases need a separate reviewed contract. */
export async function existingOnboardingCompany(database:D1Database,
  authenticated:AuthenticatedNativeStaffWithAdmissionVersion,
  selected:Extract<ClientOnboardingOrganizationSelection,{kind:"existing"}>,
  sourceIds:readonly string[], mutationId:string, connections:string|undefined) {
  const grants=await Promise.all((["directory.profile.view","directory.profile.edit","directory.identity.link"] as const)
    .map(permission=>selectGrant(database,authenticated.identity.staffId,permission,selected.recordId,[],false)));
  if (grants.some(value=>value===null)) return denied();
  // Exact replay uses the immutable original snapshot. The composer revalidates
  // today's writer authority before returning the saved receipt, without reading
  // a newly changed company or reserving a second mutation.
  const saved=await database.withSession("first-primary").prepare(`SELECT command_json FROM operations_directory_audit
    WHERE mutation_id=? AND record_id=?`).bind(mutationId,selected.recordId).first<{command_json:string}>();
  if(saved) {const command=JSON.parse(saved.command_json) as Record<string,unknown>;
    const original=profile(JSON.stringify(command.fields));
    if(command.operation!=="update" || command.expectedLocalVersion!==selected.expectedVersion || !original
      || !Array.isArray(command.destinations)) return denied();
    return {profile:original,destinations:command.destinations as NativeDirectoryDestinationAuthority[],
      selectedGrantId:grants[1]!,selectedIdentityGrantId:grants[2]!};
  }
  const row=await database.withSession("first-primary").prepare(`SELECT revision.profile_json profileJson,
      enrollment.destinations_json destinationsJson FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
    LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
    WHERE record.record_id=? AND record.record_kind='organization' AND record.current_version=?
      AND (lifecycle.record_id IS NULL OR lifecycle.status='active')
      AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members member WHERE member.record_id=record.record_id)`)
    .bind(selected.recordId,selected.expectedVersion).first<{profileJson:string;destinationsJson:string}>();
  const original=profile(row?.profileJson);
  if(!row || !original) return denied();
  const enrolled=JSON.parse(row.destinationsJson) as {sourceId:string;externalCanonicalId:string}[];
  if(!Array.isArray(enrolled) || sourceIds.some(source=>!enrolled.some(value=>value.sourceId===source))) return denied();
  const destinations=enrolled.length===0 ? [] : await updateDestinations({OPS_DB:database,
    PROJECT_ALPHA_API_V2_CONNECTIONS:connections} as Env,"organization",selected.recordId,selected.expectedVersion);
  if(destinations===null || destinations.some(value=>!enrolled.some(snapshot=>
    snapshot.sourceId===value.sourceId && snapshot.externalCanonicalId===value.externalCanonicalId))) return denied();
  return {profile:original,destinations,selectedGrantId:grants[1]!,selectedIdentityGrantId:grants[2]!};
}

/** Conservative, paged staff review only. It deliberately requires current global
 * view/edit/link allows and rejects any active deny before returning names. This
 * bounded first slice does not infer identities from submitted names or emails. */
export async function readClientOnboardingExistingCompanies(database:D1Database,
  authenticated:AuthenticatedNativeStaffWithAdmissionVersion, input:Record<string,unknown>) {
  const sources=parseClientOnboardingEnrollmentSourceIds(input.sourceIds);
  if(sources===null || typeof input.query!=="string" || input.query.length>150 || /\p{C}/u.test(input.query)
    || !(input.afterRecordId===null || (typeof input.afterRecordId==="string" && input.afterRecordId.length<=191))) return denied();
  const review=await readClientOnboardingSubmissionForReview(database,authenticated,input.submissionId);
  if(review.targetClientRecordId!==null || review.fields.clientType!=="business") return denied();
  const currentAuthority=`SELECT 1 ok FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active'
    WHERE admission.staff_id=? AND admission.active=1 AND admission.version=? AND admission.bound_access_subject=?
      AND profile.version=? AND profile.login_email=? AND staff.access_subject=admission.bound_access_subject
      AND ? > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS(SELECT 1 FROM json_each('["directory.profile.view","directory.profile.edit","directory.identity.link"]') required
        WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants allowed WHERE allowed.staff_id=admission.staff_id
          AND allowed.permission=required.value AND allowed.effect='allow' AND allowed.scope_kind='global' AND allowed.active=1))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=admission.staff_id
        AND denied.permission IN ('directory.profile.view','directory.profile.edit','directory.identity.link')
        AND denied.effect='deny' AND denied.active=1)`;
  const authorityParameters=[authenticated.identity.staffId,authenticated.admissionVersion,authenticated.identity.verifiedAccessSubject,authenticated.identity.profileVersion,authenticated.identity.email,authenticated.verifiedUntil];
  const row=await database.withSession("first-primary").prepare(currentAuthority).bind(...authorityParameters).first();
  if(!row) return denied();
  const rows=(await database.withSession("first-primary").prepare(`SELECT record.record_id recordId,
      record.current_version expectedVersion,json_extract(revision.profile_json,'$.name') name,
      enrollment.destinations_json destinationsJson,lifecycle.status lifecycle,
      EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) enrolled
        JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=record.record_id
          AND mapping.resource_type='organization' AND mapping.source_id=json_extract(enrolled.value,'$.sourceId')
          AND mapping.source_instance_id=json_extract(enrolled.value,'$.sourceInstanceUUID')
          AND mapping.application_id=json_extract(enrolled.value,'$.applicationUUID')
          AND mapping.history_epoch_id=json_extract(enrolled.value,'$.historyEpoch')
        WHERE mapping.external_id<>json_extract(enrolled.value,'$.externalCanonicalId')) parentAlias,
      EXISTS(SELECT 1 FROM native_directory_shared_profile_members member WHERE member.record_id=record.record_id) grouped
    FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
    LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id
    WHERE EXISTS(${currentAuthority}) AND record.record_kind='organization' AND (? IS NULL OR record.record_id>?)
      AND instr(lower(json_extract(revision.profile_json,'$.name')),lower(?))>0
    ORDER BY record.record_id LIMIT 21`).bind(...authorityParameters,input.afterRecordId,input.afterRecordId,input.query)
    .all<{recordId:string;expectedVersion:number;name:string;destinationsJson:string;lifecycle:string|null;grouped:number;parentAlias:number}>()).results;
  return {companies:rows.slice(0,20).map(row=>{
    const enrolled=JSON.parse(row.destinationsJson) as {sourceId:string;externalCanonicalId:string}[];
    const sourceIds=Array.isArray(enrolled)?enrolled.map(value=>value.sourceId).sort():[];
    const reason=row.grouped ? "grouped_parent_alias_unsupported" : row.parentAlias ? "acquired_parent_alias_unsupported" : row.lifecycle!==null && row.lifecycle!=="active"
      ? "company_not_active" : sources.some(source=>!sourceIds.includes(source)) ? "selected_sources_not_covered" : null;
    return {recordId:row.recordId,expectedVersion:row.expectedVersion,name:row.name,sourceIds,reusable:reason===null,reason};
  }),nextAfterRecordId:rows.length>20 ? rows[19]!.recordId:null,existingContactReuse:"unsupported" as const};
}
