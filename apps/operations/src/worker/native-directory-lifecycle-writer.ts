import { PROJECT_ALPHA_PROJECT_MAX_INTEGER } from "./project-alpha-project-transport";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;

export type NativeDirectoryLifecycleActor = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; loginEmail: string; profileVersion: number;
  selectedProfileGrantId: string; selectedEnrollmentGrantId: string; verifiedUntil: string;
}>;
export type NativeDirectoryLifecycleWrite = Readonly<{
  mutationId: string; recordId: string; kind: "organization" | "client"; action: "archive" | "restore";
  expectedLifecycleVersion: number; expectedRecordVersion: number; actor: NativeDirectoryLifecycleActor;
}>;
export type NativeDirectoryLifecycleReservation = Readonly<{
  commandId: string; sourceId: string; command: Readonly<{
    commandId: string; expectedRevision: string; expectedAuthorizationGeneration: string;
  }>;
}>;
export type NativeDirectoryLifecycleWriteOutcome =
  | Readonly<{ status: "written"; replayed: boolean; recordId: string; lifecycleVersion: number;
      lifecycleStatus: "archive_pending" | "restore_pending"; reservations: readonly NativeDirectoryLifecycleReservation[] }>
  | Readonly<{ status: "blocked"; reason: "baseline_review_required" | "authority" | "destination" | "unsettled_work" | "atomic_write" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_body_conflict" | "stale_lifecycle" | "stale_record" | "state" }>
  | Readonly<{ status: "rejected"; reason: "invalid_write" }>;

type Destination = Readonly<{ sourceId: string; sourceInstanceUUID: string; applicationUUID: string;
  historyEpoch: string; origin: string; externalCanonicalId: string }>;
type Mapping = Readonly<{ project_alpha_public_id: string }>;
type ArchivedMapping = Mapping&Readonly<{revision:string;authorization_generation:string;archive_command_id:string}>;
type Grant = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null;
  division_id: string | null; resource_id: string | null }>;
type Observation = Readonly<{ request_id:string;observed_at:string;public_id:string;revision:string;authorization_generation:string }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)); } catch { return false; }
}
function canonicalDecimal(value: unknown, zero = false): value is string {
  return typeof value === "string" && DECIMAL.test(value) && (zero || value !== "0")
    && (value.length < PROJECT_ALPHA_PROJECT_MAX_INTEGER.length || value <= PROJECT_ALPHA_PROJECT_MAX_INTEGER);
}
function greater(left: string, right: string): string {
  return left.length > right.length || (left.length === right.length && left > right) ? left : right;
}
function validActor(value: NativeDirectoryLifecycleActor): boolean {
  const verifiedUntil=typeof value.verifiedUntil==="string"?Date.parse(value.verifiedUntil):NaN;
  return plain(value) && typeof value.staffId === "string" && typeof value.accessSubject === "string"
    && typeof value.loginEmail === "string" && typeof value.selectedProfileGrantId === "string"
    && typeof value.selectedEnrollmentGrantId === "string" && Number.isSafeInteger(value.admissionVersion)
    && value.admissionVersion > 0 && Number.isSafeInteger(value.profileVersion) && value.profileVersion > 0
    && Number.isSafeInteger(verifiedUntil) && new Date(verifiedUntil).toISOString()===value.verifiedUntil;
}
function validInput(value: NativeDirectoryLifecycleWrite): boolean {
  return plain(value) && UUID.test(value.mutationId) && typeof value.recordId === "string" && value.recordId.length>0
    && value.recordId.length <= 191 && !/\p{C}/u.test(value.recordId)
    && (value.kind === "organization" || value.kind === "client") && (value.action === "archive" || value.action === "restore")
    && Number.isSafeInteger(value.expectedLifecycleVersion) && value.expectedLifecycleVersion >= 0
    && value.expectedLifecycleVersion<Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(value.expectedRecordVersion) && value.expectedRecordVersion > 0 && validActor(value.actor);
}
function parseDestinations(value: string): readonly Destination[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) return null;
    const result: Destination[] = [], identities = new Set<string>(),sources=new Set<string>();
    for (const item of parsed) {
      if (!plain(item) || Object.keys(item).some(key => !["sourceId","sourceInstanceUUID","applicationUUID","historyEpoch","origin","externalCanonicalId"].includes(key))
        || typeof item.sourceId !== "string" || !SOURCE.test(item.sourceId)
        || typeof item.sourceInstanceUUID !== "string" || !UUID.test(item.sourceInstanceUUID)
        || typeof item.applicationUUID !== "string" || !UUID.test(item.applicationUUID)
        || typeof item.historyEpoch !== "string" || !UUID.test(item.historyEpoch)
        || typeof item.origin !== "string" || typeof item.externalCanonicalId !== "string") return null;
      let origin: string; try { const url = new URL(item.origin); if (url.protocol !== "https:" || url.origin !== item.origin) return null; origin = url.origin; } catch { return null; }
      const destination = { sourceId: item.sourceId, sourceInstanceUUID: item.sourceInstanceUUID,
        applicationUUID: item.applicationUUID, historyEpoch: item.historyEpoch, origin,
        externalCanonicalId: item.externalCanonicalId };
      const identity = JSON.stringify(destination); if (identities.has(identity)||sources.has(destination.sourceId)) return null;
      identities.add(identity);sources.add(destination.sourceId); result.push(destination);
    }
    return result.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } catch { return null; }
}
function applies(grant: Grant, recordId: string, scopes: readonly { business_area_id: string; division_id: string | null }[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || (grant.scope_kind === "resource" && grant.resource_id === recordId)
    || (grant.scope_kind === "assigned" && assigned)
    || (grant.scope_kind === "business_area" && scopes.some(scope => scope.business_area_id === grant.business_area_id))
    || (grant.scope_kind === "division" && scopes.some(scope => scope.division_id === grant.division_id));
}
async function permitted(db: D1Database, input: NativeDirectoryLifecycleWrite, permission: "directory.profile.edit" | "directory.enrollment.manage", grantId: string): Promise<boolean> {
  const actor = input.actor;
  const selected = await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.id=? AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=? AND staff.status='active' AND staff.access_subject=?`)
    .bind(grantId,actor.staffId,permission,actor.accessSubject,actor.admissionVersion,
      actor.loginEmail,actor.profileVersion,actor.accessSubject).first<Grant>();
  if (!selected) return false;
  const scopes=(await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(input.recordId).all<{business_area_id:string;division_id:string|null}>()).results;
  const assigned=!!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(input.recordId,actor.staffId).first("ok");
  if (!applies(selected,input.recordId,scopes,assigned)) return false;
  const denies=(await db.prepare(`SELECT id,effect,scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(actor.staffId,permission).all<Grant>()).results;
  return !denies.some(deny=>applies(deny,input.recordId,scopes,assigned));
}
async function authorizationGeneration(db:D1Database,destination:Destination):Promise<string|null>{
  const rows=(await db.prepare(`SELECT generation FROM (
      SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration') generation
        FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=? AND application_id=?
          AND expected_history_epoch_id=? AND destination_base_url=? AND state='acknowledged'
      UNION ALL SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration')
        FROM project_alpha_directory_relationship_outbox WHERE source_id=? AND source_instance_id=? AND application_id=?
          AND history_epoch_id=? AND destination_origin=? AND state='acknowledged'
      UNION ALL SELECT authorization_generation FROM project_alpha_existing_directory_binding_revision_refresh_receipts
        WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      UNION ALL SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration')
        FROM project_alpha_directory_lifecycle_outbox WHERE source_id=? AND source_instance_id=? AND application_id=?
          AND history_epoch_id=? AND destination_origin=? AND state='acknowledged')`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin)
    .all<{generation:unknown}>()).results;
  const values=rows.map(row=>row.generation); if(!values.length||values.some(value=>!canonicalDecimal(value,true)))return null;
  return (values as string[]).reduce(greater,"0");
}
async function freshActiveObservation(db:D1Database,input:NativeDirectoryLifecycleWrite,destination:Destination,
  mapping:Mapping,now:number):Promise<Observation|null>{
  return db.prepare(`SELECT observation.request_id,receipt.observed_at,observation.project_alpha_public_id public_id,
      observation.resource_revision revision,receipt.authorization_generation
    FROM project_alpha_api_v2_directory_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
      AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
      AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory'
      AND receipt.request_id=observation.request_id
    WHERE observation.source_id=? AND observation.source_instance_id=? AND observation.application_id=?
      AND observation.history_epoch_id=? AND observation.resource_type=? AND observation.project_alpha_public_id=?
      AND observation.resource_revision=observation.binding_resource_revision
      AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
      AND observation.binding_external_id=? AND observation.binding_status='active'
      AND receipt.observed_at>=? AND receipt.observed_at<=?`).bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,
      destination.historyEpoch,input.kind,mapping.project_alpha_public_id,destination.externalCanonicalId,
      new Date(now-5*60_000).toISOString(),new Date(now).toISOString()).first<Observation>();
}
async function unsettled(db:D1Database,recordId:string):Promise<boolean>{
  const value=await db.prepare(`SELECT 1 ok WHERE
    EXISTS(SELECT 1 FROM operations_directory_intents intent JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      WHERE intent.record_id=? AND (intent.state<>'acknowledged' OR outbox.state<>'acknowledged'))
    OR EXISTS(SELECT 1 FROM project_alpha_directory_relationship_command_resources resource
      JOIN project_alpha_directory_relationship_outbox outbox ON outbox.command_id=resource.command_id
      WHERE resource.record_id=? AND outbox.state<>'acknowledged')
    OR EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox WHERE record_id=? AND state<>'acknowledged')`)
    .bind(recordId,recordId,recordId).first("ok");
  return !!value;
}
async function derivedUuid(seed:string):Promise<string>{
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed))).slice(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function writeNativeDirectoryLifecycle(db:D1Database,input:NativeDirectoryLifecycleWrite,now=Date.now()):Promise<NativeDirectoryLifecycleWriteOutcome>{
  if(!validInput(input)||!Number.isSafeInteger(now)||now<0||Date.parse(input.actor.verifiedUntil)<=now)
    return{status:"rejected",reason:"invalid_write"};
  const actor=input.actor;
  if(!await permitted(db,input,"directory.profile.edit",actor.selectedProfileGrantId)
    ||!await permitted(db,input,"directory.enrollment.manage",actor.selectedEnrollmentGrantId))return{status:"blocked",reason:"authority"};
  const replay=await db.prepare(`SELECT event.* FROM operations_directory_lifecycle_events event
    WHERE event.mutation_id=?`).bind(input.mutationId).first<Record<string,unknown>>();
  if(replay){
    const matches=replay.record_id===input.recordId&&replay.record_kind===input.kind&&replay.action===input.action
      &&replay.expected_lifecycle_version===input.expectedLifecycleVersion&&replay.expected_record_version===input.expectedRecordVersion
      &&replay.actor_staff_id===actor.staffId&&replay.actor_access_subject===actor.accessSubject
      &&replay.actor_admission_version===actor.admissionVersion&&replay.actor_email===actor.loginEmail
      &&replay.actor_profile_version===actor.profileVersion&&replay.selected_profile_grant_id===actor.selectedProfileGrantId
      &&replay.selected_enrollment_grant_id===actor.selectedEnrollmentGrantId;
    if(!matches)return{status:"conflict",reason:"idempotency_body_conflict"};
    const reservations=(await db.prepare(`SELECT command_id,source_id,command_json FROM project_alpha_directory_lifecycle_outbox
      WHERE mutation_id=? ORDER BY source_id,command_id`).bind(input.mutationId).all<{command_id:string;source_id:string;command_json:string}>()).results;
    return{status:"written",replayed:true,recordId:input.recordId,lifecycleVersion:Number(replay.lifecycle_version),
      lifecycleStatus:replay.action==="archive"?"archive_pending":"restore_pending",reservations:reservations.map(row=>({commandId:row.command_id,sourceId:row.source_id,command:JSON.parse(row.command_json)}))};
  }
  const record=await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?`).bind(input.recordId)
    .first<{record_kind:string;current_version:number}>();
  if(!record||record.record_kind!==input.kind)return{status:"conflict",reason:"stale_record"};
  if(record.current_version!==input.expectedRecordVersion)return{status:"conflict",reason:"stale_record"};
  const state=await db.prepare(`SELECT lifecycle_version,status,last_mutation_id FROM operations_directory_lifecycle_state WHERE record_id=?`).bind(input.recordId)
    .first<{lifecycle_version:number;status:string;last_mutation_id:string|null}>();
  // Revision evidence cannot prove that an older/imported PA resource is
  // presently active. Until the coordinator supplies a fresh, exact-destination
  // lifecycle observation, absent baselines remain deliberately unenrolled.
  const establishingBaseline=!state;
  if(establishingBaseline&&(input.action!=="archive"||input.expectedLifecycleVersion!==0))
    return{status:"blocked",reason:"baseline_review_required"};
  if(state&&state.lifecycle_version!==input.expectedLifecycleVersion)return{status:"conflict",reason:"stale_lifecycle"};
  if(state&&((input.action==="archive"&&state.status!=="active")||(input.action==="restore"&&state.status!=="archived")))
    return{status:"conflict",reason:"state"};
  if(await unsettled(db,input.recordId))return{status:"blocked",reason:"unsettled_work"};
  const enrollment=await db.prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`).bind(input.recordId).first<string>("destinations_json");
  const destinations=typeof enrollment==="string"?parseDestinations(enrollment):null;
  if(!destinations)return{status:"blocked",reason:"destination"};
  const reservations:Array<NativeDirectoryLifecycleReservation&{destination:Destination;publicId:string}> = [];
  const observations:Array<Destination&{publicId:string;revision:string;authorizationGeneration:string;requestId:string;observedAt:string}> = [];
  for(const destination of destinations){
    const mapping=input.action==="archive"?await db.prepare(`SELECT project_alpha_public_id FROM project_alpha_active_directory_mappings
      WHERE record_id=? AND resource_type=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND external_id=?`).bind(input.recordId,input.kind,destination.sourceId,destination.sourceInstanceUUID,
          destination.applicationUUID,destination.historyEpoch,destination.externalCanonicalId).first<Mapping>()
      :await db.prepare(`SELECT project_alpha_public_id,json_extract(outcome_json,'$.response.result.resource.revision') revision,
          json_extract(outcome_json,'$.response.result.authorizationGeneration') authorization_generation,command_id archive_command_id
        FROM project_alpha_directory_lifecycle_outbox WHERE record_id=? AND mutation_id=? AND action='archive' AND state='acknowledged'
          AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND destination_origin=? AND external_id=?
        ORDER BY lifecycle_version DESC LIMIT 1`).bind(input.recordId,state?.last_mutation_id,destination.sourceId,destination.sourceInstanceUUID,
          destination.applicationUUID,destination.historyEpoch,destination.origin,destination.externalCanonicalId).first<ArchivedMapping>();
    if(!mapping||!PUBLIC_ID.test(mapping.project_alpha_public_id))return{status:"blocked",reason:"destination"};
    const [observed,generation]=await Promise.all([input.action==="archive"
      ? freshActiveObservation(db,input,destination,mapping,now) : Promise.resolve(null),authorizationGeneration(db,destination)]);
    const archived=input.action==="restore"?mapping as ArchivedMapping:null;
    const evidence=input.action==="archive"&&observed?{public_id:observed.public_id,revision:observed.revision}
      :archived&&canonicalDecimal(archived.revision)?{public_id:archived.project_alpha_public_id,revision:archived.revision}:null;
    if(!evidence||generation===null)return{status:"blocked",reason:"destination"};
    if(observed&&!canonicalDecimal(observed.authorization_generation,true))return{status:"blocked",reason:"destination"};
    if(input.action==="archive"&&(!observed||greater(generation,observed.authorization_generation)===generation
      &&generation!==observed.authorization_generation))return{status:"blocked",reason:"destination"};
    const expectedGeneration=observed?.authorization_generation??generation;
    const commandId=await derivedUuid(`${input.mutationId}\0${JSON.stringify(destination)}`);
    reservations.push({commandId,sourceId:destination.sourceId,destination,publicId:mapping.project_alpha_public_id,
      command:{commandId,expectedRevision:evidence.revision,expectedAuthorizationGeneration:expectedGeneration}});
    if(observed)observations.push({...destination,publicId:observed.public_id,revision:observed.revision,
      authorizationGeneration:expectedGeneration,requestId:observed.request_id,observedAt:observed.observed_at});
    else if(archived)observations.push({...destination,publicId:archived.project_alpha_public_id,revision:archived.revision,
      authorizationGeneration:expectedGeneration,requestId:archived.archive_command_id,observedAt:"archive-ack"});
  }
  const lifecycleVersion=input.expectedLifecycleVersion+1,status=input.action==="archive"?"archive_pending":"restore_pending";
  // Preserve the enrollment's authoritative JSON byte ordering for the live
  // fence. Parsing above validates and de-duplicates; sorted values are used
  // only to produce deterministic reservation order and command identifiers.
  const destinationsJson=enrollment,observationsJson=JSON.stringify(observations),
    verifiedUntil=new Date(Math.min(Date.parse(actor.verifiedUntil),now+5*60_000)).toISOString();
  const statements:D1PreparedStatement[]=[db.prepare(`INSERT INTO operations_directory_lifecycle_observation_sets
    (mutation_id,record_id,record_kind,action,observations_json,verified_until) VALUES(?,?,?,?,?,?)`)
    .bind(input.mutationId,input.recordId,input.kind,input.action,observationsJson,verifiedUntil),
    db.prepare(`INSERT INTO operations_directory_lifecycle_fences
    (mutation_id,record_id,record_kind,action,expected_lifecycle_version,expected_record_version,actor_staff_id,actor_access_subject,
      actor_admission_version,actor_email,actor_profile_version,selected_profile_grant_id,selected_enrollment_grant_id,destinations_json,observations_json,verified_until)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.mutationId,input.recordId,input.kind,input.action,input.expectedLifecycleVersion,
      input.expectedRecordVersion,actor.staffId,actor.accessSubject,actor.admissionVersion,actor.loginEmail,actor.profileVersion,
      actor.selectedProfileGrantId,actor.selectedEnrollmentGrantId,destinationsJson,observationsJson,verifiedUntil),
    db.prepare(`INSERT INTO operations_directory_lifecycle_events
      (mutation_id,record_id,record_kind,lifecycle_version,action,expected_lifecycle_version,expected_record_version,actor_staff_id,actor_access_subject,
       actor_admission_version,actor_email,actor_profile_version,selected_profile_grant_id,selected_enrollment_grant_id,destinations_json,observations_json,
       actor_verified_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.mutationId,input.recordId,input.kind,lifecycleVersion,input.action,input.expectedLifecycleVersion,
      input.expectedRecordVersion,actor.staffId,actor.accessSubject,actor.admissionVersion,actor.loginEmail,actor.profileVersion,
      actor.selectedProfileGrantId,actor.selectedEnrollmentGrantId,destinationsJson,observationsJson,actor.verifiedUntil),
    ...(establishingBaseline?[db.prepare(`INSERT INTO operations_directory_lifecycle_state(record_id,lifecycle_version,status)
      VALUES(?,0,'active')`).bind(input.recordId)]:[])];
  for(const reservation of reservations){const request={resourceType:input.kind,publicId:reservation.publicId,action:input.action,...reservation.command};
    statements.push(db.prepare(`INSERT INTO project_alpha_directory_lifecycle_outbox
      (command_id,mutation_id,record_id,lifecycle_version,action,source_id,source_instance_id,application_id,history_epoch_id,
       destination_origin,external_id,project_alpha_public_id,expected_revision,expected_authorization_generation,command_json,request_json,next_attempt_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(reservation.commandId,input.mutationId,input.recordId,lifecycleVersion,input.action,
      reservation.destination.sourceId,reservation.destination.sourceInstanceUUID,reservation.destination.applicationUUID,
      reservation.destination.historyEpoch,reservation.destination.origin,reservation.destination.externalCanonicalId,reservation.publicId,
      reservation.command.expectedRevision,reservation.command.expectedAuthorizationGeneration,JSON.stringify(reservation.command),JSON.stringify(request),now));}
  statements.push(db.prepare(`UPDATE operations_directory_lifecycle_state SET lifecycle_version=?,status=?,last_mutation_id=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE record_id=? AND lifecycle_version=?`).bind(lifecycleVersion,status,input.mutationId,input.recordId,input.expectedLifecycleVersion));
  statements.push(db.prepare(`DELETE FROM operations_directory_lifecycle_fences WHERE mutation_id=?`).bind(input.mutationId));
  try{const results=await db.batch(statements);if(results.some(result=>result.meta.changes<1))return{status:"blocked",reason:"atomic_write"};}
  catch{return{status:"blocked",reason:"atomic_write"};}
  return{status:"written",replayed:false,recordId:input.recordId,lifecycleVersion,lifecycleStatus:status,reservations};
}
