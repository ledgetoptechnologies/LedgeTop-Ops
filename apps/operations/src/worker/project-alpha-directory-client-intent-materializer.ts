const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;

type Actor = Readonly<{ staffId: string; accessSubject: string; admissionVersion: number; selectedGrantId: string;
  loginEmail: string; profileVersion: number; selectedIdentityGrantId: string }>;
type Scope = Readonly<{ businessAreaId: string; divisionId: string | null }>;
type Destination = Readonly<{ sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string;
  origin: string; externalCanonicalId: string; expectedAuthorizationGeneration: string }>;
type Audit = Readonly<{ operation: string; mutationId: string; resourceType: string; recordId: string;
  expectedLocalVersion: number; actor: Actor; fields: unknown; scopes: readonly Scope[]; destinations: readonly Destination[];
  createAdmissionId: string | null; relationship: { organizationRecordId: string | null; expectedRelationshipVersion: number } }>;
type Candidate = Readonly<{ intent_id: string; mutation_id: string; record_id: string; record_version: number; source_id: string;
  source_instance_uuid: string; application_uuid: string; destination_origin: string; external_canonical_id: string;
  desired_payload_json: string; expected_history_epoch_id: string; audit_command_json: string; audit_actor_id: string;
  original_verified_access_subject: string; relationship_version: number; relationship_mutation_id: string;
  organization_record_id: string; organization_record_version: number; parent_external_canonical_id: string;
  resolved_parent_public_id: string; parent_intent_id: string }>;

export type ClientIntentMaterializationResult = Readonly<{ examined: number; materialized: number; blocked: number }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function parse(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(value); return plain(parsed) ? parsed : null; } catch { return null; }
}
function origin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.origin === value; } catch { return false; }
}
function destinationKey(value: Pick<Destination, "sourceId" | "sourceInstanceUUID" | "applicationUUID">): string {
  return `${value.sourceId}\0${value.sourceInstanceUUID}\0${value.applicationUUID}`;
}
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function exactActor(value: unknown): value is Actor {
  return plain(value) && Object.keys(value).length === 7 && typeof value.staffId === "string"
    && typeof value.accessSubject === "string" && Number.isSafeInteger(value.admissionVersion) && Number(value.admissionVersion) >= 1
    && typeof value.selectedGrantId === "string" && typeof value.loginEmail === "string"
    && Number.isSafeInteger(value.profileVersion) && Number(value.profileVersion) >= 1
    && typeof value.selectedIdentityGrantId === "string";
}
function exactScope(value: unknown): value is Scope {
  return plain(value) && Object.keys(value).length === 2 && typeof value.businessAreaId === "string"
    && (value.divisionId === null || typeof value.divisionId === "string");
}
function exactDestination(value: unknown): value is Destination {
  return plain(value) && Object.keys(value).length === 7 && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId)
    && typeof value.sourceInstanceUUID === "string" && UUID.test(value.sourceInstanceUUID)
    && typeof value.applicationUUID === "string" && UUID.test(value.applicationUUID)
    && typeof value.historyEpoch === "string" && UUID.test(value.historyEpoch) && origin(value.origin)
    && typeof value.externalCanonicalId === "string" && typeof value.expectedAuthorizationGeneration === "string"
    && REVISION.test(value.expectedAuthorizationGeneration);
}
function audit(value: string, row: Candidate): Audit | null {
  const parsed = parse(value);
  if (!parsed || parsed.operation !== "create" || parsed.mutationId !== row.mutation_id || parsed.resourceType !== "client"
    || parsed.recordId !== row.record_id || parsed.expectedLocalVersion !== 0 || parsed.createAdmissionId === null
    || !exactActor(parsed.actor) || !Array.isArray(parsed.scopes) || !parsed.scopes.every(exactScope)
    || !Array.isArray(parsed.destinations) || !parsed.destinations.every(exactDestination) || !plain(parsed.relationship)
    || parsed.relationship.organizationRecordId !== row.organization_record_id || parsed.relationship.expectedRelationshipVersion !== 0
    || JSON.stringify(parsed.fields) !== row.desired_payload_json) return null;
  return parsed as unknown as Audit;
}

async function permitted(db: D1Database, row: Candidate, actor: Actor, scopes: readonly Scope[],
  permission: string, selectedGrantId: string, exactSelected = true): Promise<boolean> {
  const selected = (await db.prepare(`SELECT grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant
    JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN staff_users staff ON staff.id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id
    WHERE (?=0 OR grant.id=?) AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND staff.status='active' AND staff.access_subject=? AND profile.login_email=? AND profile.version=?`)
    .bind(exactSelected ? 1 : 0, selectedGrantId, actor.staffId, permission, actor.accessSubject, actor.admissionVersion,
      actor.accessSubject, actor.loginEmail, actor.profileVersion)
    .all<{ scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>()).results;
  const applies = (grant: { scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }) =>
    grant.scope_kind === "global"
      || (grant.scope_kind === "business_area" && scopes.some(scope => scope.businessAreaId === grant.business_area_id))
      || (grant.scope_kind === "division" && scopes.some(scope => scope.divisionId === grant.division_id));
  if (!selected.some(applies)) return false;
  const denies = (await db.prepare(`SELECT scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(actor.staffId, permission)
    .all<{ scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>()).results;
  if (denies.some(applies)) return false;
  const activeScopes = (await db.prepare(`SELECT scope.business_area_id businessAreaId,scope.division_id divisionId
    FROM native_directory_resource_scopes scope
    JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
    LEFT JOIN native_business_divisions division ON division.id=scope.division_id
      AND division.business_area_id=scope.business_area_id AND division.active=1
    WHERE scope.record_id=? AND scope.active=1 AND (scope.division_id IS NULL OR division.id IS NOT NULL)
    ORDER BY scope.business_area_id,scope.division_id`).bind(row.record_id).all<Scope>()).results;
  return JSON.stringify(activeScopes) === JSON.stringify(scopes);
}

async function exactReservation(db: D1Database, row: Candidate): Promise<Readonly<{
  commandId: string; commandJson: string; originSnapshotJson: string; dispositionJson: string
}> | null> {
  if (!PUBLIC_ID.test(row.resolved_parent_public_id) || row.record_version !== 1 || row.relationship_version !== 1
    || row.organization_record_version !== 1 || row.record_id !== row.external_canonical_id
    || row.organization_record_id !== row.parent_external_canonical_id) return null;
  const value = audit(row.audit_command_json, row); if (!value) return null;
  if (value.actor.staffId !== row.audit_actor_id || value.actor.accessSubject !== row.original_verified_access_subject) return null;
  const matching = value.destinations.filter(destination => destination.sourceId === row.source_id
    && destination.sourceInstanceUUID === row.source_instance_uuid && destination.applicationUUID === row.application_uuid
    && destination.historyEpoch === row.expected_history_epoch_id && destination.origin === row.destination_origin
    && destination.externalCanonicalId === row.external_canonical_id);
  if (matching.length !== 1) return null;
  const enrolled = (await db.prepare(`SELECT 1 ok FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
    WHERE enrollment.record_id=? AND json_extract(destination.value,'$.sourceId')=?
      AND json_extract(destination.value,'$.sourceInstanceUUID')=? AND json_extract(destination.value,'$.applicationUUID')=?
      AND json_extract(destination.value,'$.historyEpoch')=? AND json_extract(destination.value,'$.origin')=?
      AND json_extract(destination.value,'$.externalCanonicalId')=? LIMIT 2`).bind(row.record_id,row.source_id,row.source_instance_uuid,
      row.application_uuid,row.expected_history_epoch_id,row.destination_origin,row.external_canonical_id).all()).results;
  if (enrolled.length !== 1 || !await permitted(db,row,value.actor,value.scopes,"directory.profile.edit",value.actor.selectedGrantId)
    || !await permitted(db,row,value.actor,value.scopes,"directory.identity.link",value.actor.selectedIdentityGrantId)
    || !await permitted(db,row,value.actor,value.scopes,"directory.enrollment.manage",value.actor.selectedGrantId, false)) return null;
  const destination = matching[0]!;
  const commandId = await deterministicUuid(`${row.mutation_id}\0${destinationKey(destination)}`);
  const commandJson = JSON.stringify({ operation:"create",commandId,resourceType:"client",externalId:row.record_id,
    expectedRevision:"0",expectedAuthorizationGeneration:destination.expectedAuthorizationGeneration,
    fields:{ ...(value.fields as Record<string, unknown>),organizationPublicId:row.resolved_parent_public_id },scopes:value.scopes });
  return { commandId, commandJson,
    originSnapshotJson: JSON.stringify({ actorId:value.actor.staffId,authorityRevision:"1",actorSubject:value.actor.accessSubject }),
    dispositionJson: JSON.stringify({ kind:"authorized_create",sourceId:row.source_id,sourceInstanceUUID:row.source_instance_uuid,
      applicationUUID:row.application_uuid,historyEpoch:row.expected_history_epoch_id,origin:row.destination_origin,
      externalCanonicalId:row.external_canonical_id }) };
}

/** Materializes only already-authorized client creates whose pinned parent intent has exact acknowledged PA evidence. */
export async function materializeResolvedProjectAlphaDirectoryClientIntents(db: D1Database,
  sourceIds: readonly string[], limit = 12, now = Date.now()): Promise<ClientIntentMaterializationResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12 || !Number.isSafeInteger(now) || now < 0
    || sourceIds.length < 1 || sourceIds.length > 64 || sourceIds.some(source => !SOURCE_ID.test(source)))
    return { examined:0,materialized:0,blocked:0 };
  const placeholders = sourceIds.map(() => "?").join(",");
  const query = `SELECT intent.intent_id,intent.mutation_id,intent.record_id,intent.record_version,intent.source_id,
      intent.source_instance_uuid,intent.application_uuid,intent.destination_origin,intent.external_canonical_id,
      intent.desired_payload_json,intent.expected_history_epoch_id,audit.command_json audit_command_json,
      audit.actor_id audit_actor_id,audit.original_verified_access_subject,dependency.relationship_version,
      dependency.relationship_mutation_id,dependency.organization_record_id,dependency.organization_record_version,
      dependency.parent_external_canonical_id,resolved.resolved_parent_public_id,dependency.parent_intent_id
    FROM operations_directory_intents intent
    JOIN operations_directory_records client ON client.record_id=intent.record_id AND client.record_kind='client'
      AND client.current_version=intent.record_version
    JOIN operations_directory_revisions revision ON revision.record_id=intent.record_id
      AND revision.version=intent.record_version AND revision.mutation_id=intent.mutation_id
    JOIN operations_directory_audit audit ON audit.record_id=intent.record_id
      AND audit.record_version=intent.record_version AND audit.mutation_id=intent.mutation_id AND audit.actor_type='staff'
    JOIN operations_directory_intent_relationship_dependencies dependency ON dependency.intent_id=intent.intent_id
      AND dependency.evidence_kind='parent_intent' AND dependency.client_record_id=intent.record_id
      AND dependency.client_record_version=intent.record_version AND dependency.source_id=intent.source_id
      AND dependency.source_instance_uuid=intent.source_instance_uuid AND dependency.application_uuid=intent.application_uuid
      AND dependency.history_epoch_id=intent.expected_history_epoch_id AND dependency.destination_origin=intent.destination_origin
    JOIN operations_directory_intent_relationship_resolved resolved ON resolved.intent_id=intent.intent_id
    JOIN operations_directory_client_organization_history history ON history.client_record_id=dependency.client_record_id
      AND history.relationship_version=dependency.relationship_version AND history.mutation_id=dependency.relationship_mutation_id
      AND history.organization_record_id=dependency.organization_record_id
    JOIN operations_directory_client_organizations current_relationship ON current_relationship.client_record_id=history.client_record_id
      AND current_relationship.relationship_version=history.relationship_version
      AND current_relationship.organization_record_id=history.organization_record_id
    JOIN operations_directory_records parent ON parent.record_id=dependency.organization_record_id
      AND parent.record_kind='organization' AND parent.current_version=dependency.organization_record_version
    JOIN operations_directory_revisions parent_revision ON parent_revision.record_id=parent.record_id
      AND parent_revision.version=parent.current_version
    WHERE intent.state='waiting' AND intent.source_id IN (${placeholders})
      AND (intent.created_at>? OR (intent.created_at=? AND intent.intent_id>?))
      AND NOT EXISTS(SELECT 1 FROM operations_directory_materializations materialization WHERE materialization.intent_id=intent.intent_id)
    ORDER BY intent.created_at,intent.intent_id LIMIT ?`;
  const cursor = await db.prepare(`SELECT after_created_at,after_intent_id FROM operations_directory_client_materialization_cursor
    WHERE singleton=1`).first<{after_created_at:string;after_intent_id:string}>();
  if (!cursor) return { examined:0,materialized:0,blocked:0 };
  const load = async (created: string, intent: string) => (await db.prepare(query)
    .bind(...sourceIds,created,created,intent,limit).all<Candidate>()).results;
  let rows = await load(cursor.after_created_at,cursor.after_intent_id);
  if (rows.length === 0 && (cursor.after_created_at !== "" || cursor.after_intent_id !== "")) rows = await load("","");
  let materialized=0,blocked=0;
  for (const row of rows) {
    const reservation = await exactReservation(db,row);
    if (!reservation) { blocked+=1; continue; }
    try {
      await db.batch([
        db.prepare("UPDATE operations_directory_intents SET state='ready' WHERE intent_id=? AND state='waiting'").bind(row.intent_id),
        db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,
          disposition_json,next_attempt_at,history_epoch_id) VALUES(?,?,?,?,?,?,?)`).bind(row.intent_id,reservation.commandId,
          reservation.commandJson,reservation.originSnapshotJson,reservation.dispositionJson,now,row.expected_history_epoch_id),
      ]);
      const settled=await db.prepare(`SELECT 1 ok FROM operations_directory_intents intent
        JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
        WHERE intent.intent_id=? AND intent.state='materialized' AND materialization.command_id=?
          AND outbox.state='pending' AND outbox.command_json=?`).bind(row.intent_id,reservation.commandId,reservation.commandJson).first();
      if (settled) materialized+=1; else blocked+=1;
    } catch { blocked+=1; }
  }
  if (rows.length > 0) {
    const last=rows[rows.length-1]!;
    await db.prepare(`UPDATE operations_directory_client_materialization_cursor SET after_created_at=(SELECT created_at
      FROM operations_directory_intents WHERE intent_id=?),after_intent_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE singleton=1`).bind(last.intent_id,last.intent_id).run();
  }
  return { examined:rows.length,materialized,blocked };
}
