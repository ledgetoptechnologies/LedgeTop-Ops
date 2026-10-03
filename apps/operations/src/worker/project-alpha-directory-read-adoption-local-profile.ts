import type { ProjectAlphaDirectoryProfile, ProjectAlphaDirectoryReadKind } from "./project-alpha-directory-read-api-v2";

export type ProjectAlphaDirectoryLocalProfileAdoptionActor = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number;
  grantGeneration: number; selectedProfileGrantId: string;
}>;
export type ProjectAlphaDirectoryLocalProfileAdoptionInput = Readonly<{
  finalizationId: string; idempotencyKey: string; expectedRecordVersion: number;
  expectedLocalProfileSha256: string; projectAlphaProfile: ProjectAlphaDirectoryProfile;
  actor: ProjectAlphaDirectoryLocalProfileAdoptionActor;
}>;
export type ProjectAlphaDirectoryLocalProfileAdoptionOutcome =
  | Readonly<{ status: "applied" | "replayed"; adoptionId: string; mutationId: string; recordId: string;
      recordVersion: number; adoptedFields: readonly string[] }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" | "invalid_profile" }>
  | Readonly<{ status: "blocked"; reason: "prepared_finalization" | "follow_up" | "unsupported_decision" |
      "no_scalar_adoption" | "stale_local" | "stale_source" | "authority" | "storage" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key_reused" | "finalization_already_applied" }>;

type AdoptionEnv = Readonly<{ ENVIRONMENT?: string; PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED?: string; OPS_DB: D1Database }>;
type Selected = Readonly<{
  finalization_id:string; field_review_receipt_id:string; record_id:string; resource_type:ProjectAlphaDirectoryReadKind;
  source_id:string;source_instance_id:string;application_id:string;history_epoch_id:string;reviewed_external_id:string;
  project_alpha_public_id:string;project_alpha_revision:string;authorization_generation:string;
  local_record_version:number; local_profile_sha256:string; project_alpha_profile_sha256:string;
  reviewer_staff_id:string; reviewer_access_subject:string; reviewer_admission_version:number;
  reviewer_profile_version:number; reviewer_grant_generation:number; profile_json:string;
}>;
type Decision = Readonly<{field_name:string;decision:string}>;
type Saved = Readonly<{adoption_id:string;mutation_id:string;idempotency_key:string;request_sha256:string;finalization_id:string;
  record_id:string;result_record_version:number;adopted_fields_json:string}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const SUPPORTED=["name","email","phone","address_line1","address_line2","city","state","postal_code","country"] as const;
type SupportedField=typeof SUPPORTED[number];
const LOCAL_KEY:Record<SupportedField,string>={name:"name",email:"generalEmail",phone:"generalPhone",address_line1:"addressLine1",
  address_line2:"addressLine2",city:"city",state:"state",postal_code:"postalCode",country:"country"};

function plain(value:unknown):value is Record<string,unknown>{
  try{return !!value&&typeof value==="object"&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}catch{return false;}
}
function exact(value:Record<string,unknown>,keys:readonly string[]):boolean{
  try{return Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}catch{return false;}
}
function positive(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=1;}
function text(value:unknown,max=191):value is string{return typeof value==="string"&&value.length>0&&Array.from(value).length<=max&&!/\p{C}/u.test(value);}
function validBase(value:unknown):value is ProjectAlphaDirectoryLocalProfileAdoptionInput{
  return plain(value)&&exact(value,["finalizationId","idempotencyKey","expectedRecordVersion","expectedLocalProfileSha256","projectAlphaProfile","actor"])
    &&typeof value.finalizationId==="string"&&UUID.test(value.finalizationId)&&typeof value.idempotencyKey==="string"&&UUID.test(value.idempotencyKey)
    &&positive(value.expectedRecordVersion)&&typeof value.expectedLocalProfileSha256==="string"&&SHA.test(value.expectedLocalProfileSha256)
    &&plain(value.projectAlphaProfile)&&plain(value.actor)
    &&exact(value.actor,["staffId","accessSubject","admissionVersion","profileVersion","grantGeneration","selectedProfileGrantId"])
    &&text(value.actor.staffId)&&text(value.actor.accessSubject)&&positive(value.actor.admissionVersion)&&positive(value.actor.profileVersion)
    &&positive(value.actor.grantGeneration)&&text(value.actor.selectedProfileGrantId);
}
function nullable(value:unknown,max=512):value is string|null{return value===null||(typeof value==="string"&&Array.from(value).length<=max&&!/\p{C}/u.test(value));}
function canonicalRemote(value:unknown,kind:ProjectAlphaDirectoryReadKind):ProjectAlphaDirectoryProfile|null{
  if(!plain(value)||!exact(value,kind==="client"?["publicId","name","email","phone","address","clientType","organizationPublicId"]
    :["publicId","name","email","phone","address"])||typeof value.publicId!=="string"||!/^[0-9a-f]{32}$/.test(value.publicId)
    ||!text(value.name,512)||!nullable(value.email)||!nullable(value.phone)||!plain(value.address)
    ||!exact(value.address,["line1","line2","city","state","postalCode","country"])
    ||![value.address.line1,value.address.line2,value.address.city,value.address.state,value.address.postalCode,value.address.country].every(v=>nullable(v)))return null;
  const address={line1:value.address.line1 as string|null,line2:value.address.line2 as string|null,city:value.address.city as string|null,
    state:value.address.state as string|null,postalCode:value.address.postalCode as string|null,country:value.address.country as string|null};
  const base={publicId:value.publicId,name:value.name,email:value.email as string|null,phone:value.phone as string|null,address};
  if(kind==="organization")return base;
  if(!["unknown","business","consumer"].includes(String(value.clientType))
    ||!(value.organizationPublicId===null||(typeof value.organizationPublicId==="string"&&/^[0-9a-f]{32}$/.test(value.organizationPublicId))))return null;
  return {...base,clientType:value.clientType as "unknown"|"business"|"consumer",organizationPublicId:value.organizationPublicId as string|null};
}
function localProfile(value:unknown,kind:ProjectAlphaDirectoryReadKind):value is Record<string,unknown>{
  if(!plain(value))return false;
  const required=["name","generalEmail","generalPhone","addressLine1","addressLine2","city","state","postalCode","country"];
  if(!required.every(key=>typeof value[key]==="string"))return false;
  return kind==="organization"||(["unknown","business","consumer"].includes(String(value.clientType))
    &&(value.organizationPublicId===null||typeof value.organizationPublicId==="string"));
}
function remoteScalar(profile:ProjectAlphaDirectoryProfile,field:SupportedField):string{
  const value=field==="name"?profile.name:field==="email"?profile.email:field==="phone"?profile.phone:
    field==="address_line1"?profile.address.line1:field==="address_line2"?profile.address.line2:field==="city"?profile.address.city:
    field==="state"?profile.address.state:field==="postal_code"?profile.address.postalCode:profile.address.country;
  return value??"";
}
function validResult(value:Record<string,unknown>):boolean{
  const limits:Record<string,number>={name:150,generalEmail:255,generalPhone:50,addressLine1:255,addressLine2:255,city:100,state:100,postalCode:32,country:100};
  for(const [key,max]of Object.entries(limits)){const item=value[key];if(typeof item!=="string"||Array.from(item).length>max||/\p{C}/u.test(item)||(key==="name"&&item.length===0))return false;}
  const email=String(value.generalEmail);return email===""||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
async function sha(value:unknown):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify(value));return [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("");}
async function saved(db:D1Database,key:string,finalization:string):Promise<Saved[]>{return(await db.prepare(`SELECT adoption_id,mutation_id,idempotency_key,request_sha256,finalization_id,record_id,result_record_version,adopted_fields_json
  FROM project_alpha_directory_read_adoption_local_profile_receipts WHERE idempotency_key=? OR finalization_id=? ORDER BY created_at,adoption_id`).bind(key,finalization).all<Saved>()).results;}
function replay(rows:Saved[],key:string,finalizationId:string,requestHash:string):ProjectAlphaDirectoryLocalProfileAdoptionOutcome|null{
  if(rows.length===0)return null;const keyed=rows.find(row=>row.idempotency_key===key);
  if(keyed&&keyed.request_sha256===requestHash&&keyed.finalization_id===finalizationId)return{status:"replayed",adoptionId:keyed.adoption_id,mutationId:keyed.mutation_id,recordId:keyed.record_id,
    recordVersion:keyed.result_record_version,adoptedFields:JSON.parse(keyed.adopted_fields_json) as string[]};
  if(keyed)return{status:"conflict",reason:"idempotency_key_reused"};
  return{status:"conflict",reason:"finalization_already_applied"};
}

async function authority(db:D1Database,s:Selected,a:ProjectAlphaDirectoryLocalProfileAdoptionActor):Promise<boolean>{
  const row=await db.prepare(`SELECT 1 ok FROM native_directory_grants grant_row
    JOIN native_staff_admissions admission ON admission.staff_id=grant_row.staff_id AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    JOIN operations_directory_records record ON record.record_id=? AND record.record_kind=? AND record.current_version=?
    WHERE grant_row.id=? AND grant_row.staff_id=? AND grant_row.permission='directory.profile.edit' AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
        OR (grant_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments x WHERE x.record_id=record.record_id AND x.staff_id=? AND x.active=1))
        OR (grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.business_area_id=grant_row.business_area_id))
        OR (grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.division_id=grant_row.division_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=grant_row.staff_id AND deny.permission='directory.profile.edit' AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=record.record_id)
          OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments x WHERE x.record_id=record.record_id AND x.staff_id=? AND x.active=1))
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.division_id=deny.division_id))))`)
    .bind(a.accessSubject,a.admissionVersion,a.profileVersion,a.grantGeneration,s.record_id,s.resource_type,s.local_record_version,
      a.selectedProfileGrantId,a.staffId,a.staffId,a.staffId).first<number>("ok");return row===1;
}
async function sourceCurrent(db:D1Database,s:Selected):Promise<boolean>{
  const row=await db.prepare(`SELECT 1 ok FROM project_alpha_api_v2_directory_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts inventory ON inventory.source_id=observation.source_id
      AND inventory.source_instance_id=observation.source_instance_id AND inventory.application_id=observation.application_id
      AND inventory.history_epoch_id=observation.history_epoch_id AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
    WHERE observation.source_id=? AND observation.source_instance_id=? AND observation.application_id=? AND observation.history_epoch_id=?
      AND observation.resource_type=? AND observation.project_alpha_public_id=? AND observation.resource_revision=?
      AND observation.binding_external_id=? AND observation.binding_status='active' AND observation.binding_resource_revision=?
      AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
      AND inventory.authorization_generation=?
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict WHERE conflict.source_id=? AND conflict.inventory_kind='directory'
        AND (conflict.resource_type='source' OR (conflict.source_instance_id=? AND conflict.application_id=? AND conflict.history_epoch_id=?
          AND conflict.resource_type=? AND (conflict.project_alpha_public_id=? OR conflict.external_id=?))))`)
    .bind(s.source_id,s.source_instance_id,s.application_id,s.history_epoch_id,s.resource_type,s.project_alpha_public_id,s.project_alpha_revision,
      s.reviewed_external_id,s.project_alpha_revision,s.authorization_generation,s.source_id,s.source_instance_id,s.application_id,s.history_epoch_id,
      s.resource_type,s.project_alpha_public_id,s.reviewed_external_id).first<number>("ok");return row===1;
}

/** Staging-only, local-only CAS application. No route imports this primitive. */
export async function applyProjectAlphaDirectoryReadAdoptionLocalProfile(env:AdoptionEnv,inputValue:unknown,
  overrides:Readonly<{uuid?:()=>string;now?:()=>string}>={}):Promise<ProjectAlphaDirectoryLocalProfileAdoptionOutcome>{
  if(env.ENVIRONMENT!=="staging"||env.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED!=="true")return{status:"disabled"};
  if(!validBase(inputValue))return{status:"rejected",reason:"invalid_input"};const input=inputValue;
  const requestHash=await sha({finalizationId:input.finalizationId,idempotencyKey:input.idempotencyKey,expectedRecordVersion:input.expectedRecordVersion,
    expectedLocalProfileSha256:input.expectedLocalProfileSha256,projectAlphaProfile:input.projectAlphaProfile,actor:input.actor});
  const prior=replay(await saved(env.OPS_DB,input.idempotencyKey,input.finalizationId).catch(()=>[]),input.idempotencyKey,input.finalizationId,requestHash);if(prior)return prior;
  const selected=await env.OPS_DB.prepare(`SELECT finalization.finalization_id,finalization.field_review_receipt_id,finalization.record_id,
      finalization.resource_type,finalization.source_id,finalization.source_instance_id,finalization.application_id,finalization.history_epoch_id,
      finalization.reviewed_external_id,finalization.project_alpha_public_id,finalization.project_alpha_revision,finalization.authorization_generation,
      finalization.local_record_version,finalization.local_profile_sha256,finalization.project_alpha_profile_sha256,
      finalization.reviewer_staff_id,finalization.reviewer_access_subject,finalization.reviewer_admission_version,
      finalization.reviewer_profile_version,finalization.reviewer_grant_generation,revision.profile_json
    FROM project_alpha_directory_read_adoption_finalizations finalization
    JOIN project_alpha_directory_read_adoption_field_review_receipts receipt ON receipt.receipt_id=finalization.field_review_receipt_id
    JOIN project_alpha_directory_read_adoption_field_review_audit audit ON audit.receipt_id=receipt.receipt_id AND audit.actor_staff_id=receipt.reviewer_staff_id
    JOIN operations_directory_revisions revision ON revision.record_id=finalization.record_id AND revision.version=finalization.local_record_version
    WHERE finalization.finalization_id=? AND finalization.state='prepared'`).bind(input.finalizationId).first<Selected>().catch(()=>null);
  if(!selected)return{status:"blocked",reason:"prepared_finalization"};
  if(selected.local_record_version!==input.expectedRecordVersion||selected.local_profile_sha256!==input.expectedLocalProfileSha256)return{status:"blocked",reason:"stale_local"};
  if(selected.reviewer_staff_id!==input.actor.staffId||selected.reviewer_access_subject!==input.actor.accessSubject
    ||selected.reviewer_admission_version!==input.actor.admissionVersion||selected.reviewer_profile_version!==input.actor.profileVersion
    ||selected.reviewer_grant_generation!==input.actor.grantGeneration)return{status:"blocked",reason:"authority"};
  const remote=canonicalRemote(input.projectAlphaProfile,selected.resource_type);if(!remote)return{status:"rejected",reason:"invalid_profile"};
  if(await sha(remote)!==selected.project_alpha_profile_sha256)return{status:"rejected",reason:"invalid_profile"};
  const decisions=(await env.OPS_DB.prepare(`SELECT field_name,decision FROM project_alpha_directory_read_adoption_field_decisions WHERE receipt_id=? ORDER BY field_name`)
    .bind(selected.field_review_receipt_id).all<Decision>()).results;
  if(decisions.some(d=>d.decision==="requires_follow_up"))return{status:"blocked",reason:"follow_up"};
  if(decisions.some(d=>d.decision==="adopt_project_alpha"&&!SUPPORTED.includes(d.field_name as SupportedField)))return{status:"blocked",reason:"unsupported_decision"};
  const adopted=decisions.filter(d=>d.decision==="adopt_project_alpha").map(d=>d.field_name as SupportedField).sort();
  if(adopted.length===0)return{status:"blocked",reason:"no_scalar_adoption"};
  let local:unknown;try{local=JSON.parse(selected.profile_json);}catch{return{status:"blocked",reason:"stale_local"};}
  if(!localProfile(local,selected.resource_type)||await sha(local)!==selected.local_profile_sha256)return{status:"blocked",reason:"stale_local"};
  const current=await env.OPS_DB.prepare(`SELECT record.current_version,revision.profile_json FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version WHERE record.record_id=? AND record.record_kind=?`)
    .bind(selected.record_id,selected.resource_type).first<{current_version:number;profile_json:string}>();
  if(!current||current.current_version!==selected.local_record_version||current.profile_json!==selected.profile_json)return{status:"blocked",reason:"stale_local"};
  if(!await sourceCurrent(env.OPS_DB,selected).catch(()=>false))return{status:"blocked",reason:"stale_source"};
  if(!await authority(env.OPS_DB,selected,input.actor).catch(()=>false))return{status:"blocked",reason:"authority"};
  const result={...local};for(const field of adopted)result[LOCAL_KEY[field]]=remoteScalar(remote,field);if(!validResult(result))return{status:"rejected",reason:"invalid_profile"};
  const resultJson=JSON.stringify(result),resultHash=await sha(result),remoteJson=JSON.stringify(remote),fieldsJson=JSON.stringify(adopted);
  const uuid=overrides.uuid??(()=>crypto.randomUUID()),at=(overrides.now??(()=>new Date().toISOString()))();
  const ids={adoption:uuid(),mutation:uuid(),audit:uuid(),event:uuid()};if(Object.values(ids).some(id=>!UUID.test(id))||new Set(Object.values(ids)).size!==4)return{status:"blocked",reason:"storage"};
  const auditJson=JSON.stringify({operation:"project_alpha_local_profile_adoption",finalizationId:selected.finalization_id,
    fieldReviewReceiptId:selected.field_review_receipt_id,expectedRecordVersion:selected.local_record_version,
    expectedLocalProfileSha256:selected.local_profile_sha256,projectAlphaProfileSha256:selected.project_alpha_profile_sha256,
    resultProfileSha256:resultHash,adoptedFields:adopted,actor:input.actor});
  try{await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_local_profile_fences(mutation_id,adoption_id,idempotency_key,request_sha256,
      finalization_id,field_review_receipt_id,record_id,resource_type,expected_record_version,expected_local_profile_sha256,expected_profile_json,
      project_alpha_profile_sha256,project_alpha_profile_json,result_profile_sha256,result_profile_json,adopted_fields_json,
      actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,selected_profile_grant_id,audit_command_json,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ids.mutation,ids.adoption,input.idempotencyKey,requestHash,selected.finalization_id,
      selected.field_review_receipt_id,selected.record_id,selected.resource_type,selected.local_record_version,selected.local_profile_sha256,selected.profile_json,
      selected.project_alpha_profile_sha256,remoteJson,resultHash,resultJson,fieldsJson,input.actor.staffId,input.actor.accessSubject,input.actor.admissionVersion,
      input.actor.profileVersion,input.actor.grantGeneration,input.actor.selectedProfileGrantId,auditJson,at),
    env.OPS_DB.prepare(`UPDATE operations_directory_records SET current_version=current_version+1,updated_at=? WHERE record_id=? AND current_version=?`)
      .bind(at,selected.record_id,selected.local_record_version),
    env.OPS_DB.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,?,?,?)`)
      .bind(selected.record_id,selected.local_record_version+1,ids.mutation,resultJson),
    env.OPS_DB.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject)
      VALUES(?,?,?,?,'staff',?,?,?)`).bind(ids.audit,ids.mutation,selected.record_id,selected.local_record_version+1,input.actor.staffId,auditJson,input.actor.accessSubject),
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_local_profile_receipts(adoption_id,idempotency_key,request_sha256,finalization_id,
      field_review_receipt_id,mutation_id,record_id,resource_type,expected_record_version,expected_local_profile_sha256,project_alpha_profile_sha256,
      result_record_version,result_profile_sha256,adopted_fields_json,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
      actor_grant_generation,selected_profile_grant_id,state,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'applied',?)`).bind(ids.adoption,
      input.idempotencyKey,requestHash,selected.finalization_id,selected.field_review_receipt_id,ids.mutation,selected.record_id,selected.resource_type,
      selected.local_record_version,selected.local_profile_sha256,selected.project_alpha_profile_sha256,selected.local_record_version+1,resultHash,fieldsJson,
      input.actor.staffId,input.actor.accessSubject,input.actor.admissionVersion,input.actor.profileVersion,input.actor.grantGeneration,input.actor.selectedProfileGrantId,at),
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_local_profile_events(adoption_id,state_version,event_id,state,occurred_at)
      VALUES(?,1,?,'applied',?)`).bind(ids.adoption,ids.event,at),
    env.OPS_DB.prepare(`DELETE FROM project_alpha_directory_read_adoption_local_profile_fences WHERE mutation_id=?`).bind(ids.mutation),
  ]);}catch{
    const concurrent=replay(await saved(env.OPS_DB,input.idempotencyKey,input.finalizationId).catch(()=>[]),input.idempotencyKey,input.finalizationId,requestHash);return concurrent??{status:"blocked",reason:"storage"};
  }
  return{status:"applied",adoptionId:ids.adoption,mutationId:ids.mutation,recordId:selected.record_id,recordVersion:selected.local_record_version+1,adoptedFields:adopted};
}
