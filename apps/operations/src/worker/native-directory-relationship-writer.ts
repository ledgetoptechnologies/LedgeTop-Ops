import type { ProjectAlphaDirectoryRelationshipAction, ProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-api-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;

export type NativeDirectoryRelationshipActor = Readonly<{
  staffId: string;
  accessSubject: string;
  email: string;
  admissionVersion: number;
  profileVersion: number;
}>;
export type NativeDirectoryRelationshipEndpoint = Readonly<{ recordId: string; expectedRecordVersion: number }>;
export type NativeDirectoryRelationshipWrite = Readonly<{
  mutationId: string;
  clientRecordId: string;
  expectedRelationshipVersion: number;
  expectedClientRecordVersion: number;
  previousOrganization: NativeDirectoryRelationshipEndpoint | null;
  organization: NativeDirectoryRelationshipEndpoint | null;
  actor: NativeDirectoryRelationshipActor;
}>;
export type NativeDirectoryRelationshipReservation = Readonly<{
  commandId: string;
  sourceId: string;
  action: ProjectAlphaDirectoryRelationshipAction;
  command: ProjectAlphaDirectoryRelationshipCommand;
}>;
export type NativeDirectoryRelationshipWriteOutcome =
  | Readonly<{ status: "written"; replayed: boolean; mutationId: string; relationshipVersion: number; reservations: readonly NativeDirectoryRelationshipReservation[] }>
  | Readonly<{ status: "rejected"; reason: "invalid_write" | "no_change" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_body_conflict" | "stale_relationship" | "stale_record" }>
  | Readonly<{ status: "blocked"; reason: "destination_mismatch" | "mapping_evidence" | "authority_or_race" }>;

type Destination = Readonly<{ sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string; origin: string; externalCanonicalId: string }>;
type Head = Readonly<{ publicId: string; revision: string }>;

function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function endpoint(value: unknown): value is NativeDirectoryRelationshipEndpoint {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && UUID.test(String((value as NativeDirectoryRelationshipEndpoint).recordId))
    && integer((value as NativeDirectoryRelationshipEndpoint).expectedRecordVersion);
}
function normalize(input: NativeDirectoryRelationshipWrite): NativeDirectoryRelationshipWrite | null {
  if (!input || typeof input !== "object" || !UUID.test(input.mutationId) || !UUID.test(input.clientRecordId)
    || !Number.isSafeInteger(input.expectedRelationshipVersion) || input.expectedRelationshipVersion < 1
    || !integer(input.expectedClientRecordVersion) || (input.previousOrganization !== null && !endpoint(input.previousOrganization))
    || (input.organization !== null && !endpoint(input.organization)) || !input.actor || typeof input.actor !== "object"
    || typeof input.actor.staffId !== "string" || !input.actor.staffId || typeof input.actor.accessSubject !== "string" || !input.actor.accessSubject
    || typeof input.actor.email !== "string" || !input.actor.email || !integer(input.actor.admissionVersion) || !integer(input.actor.profileVersion)) return null;
  return JSON.parse(JSON.stringify(input)) as NativeDirectoryRelationshipWrite;
}
function action(input: NativeDirectoryRelationshipWrite): ProjectAlphaDirectoryRelationshipAction | null {
  if (input.previousOrganization === null && input.organization !== null) return "assign";
  if (input.previousOrganization !== null && input.organization === null) return "remove";
  if (input.previousOrganization !== null && input.organization !== null
    && input.previousOrganization.recordId !== input.organization.recordId) return "move";
  return null;
}
function requestJson(input: NativeDirectoryRelationshipWrite): string {
  return JSON.stringify({ mutationId: input.mutationId, clientRecordId: input.clientRecordId,
    expectedRelationshipVersion: input.expectedRelationshipVersion, expectedClientRecordVersion: input.expectedClientRecordVersion,
    previousOrganization: input.previousOrganization, organization: input.organization, actor: input.actor });
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function destinations(value: unknown, recordId: string): Destination[] | null {
  let parsed: unknown; try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const result: Destination[] = [], seen = new Set<string>();
  for (const candidate of parsed) {
    if (!plain(candidate) || Object.keys(candidate).length !== 6 || typeof candidate.sourceId !== "string"
      || !candidate.sourceId.startsWith("project-alpha:") || typeof candidate.sourceInstanceUUID !== "string" || !UUID.test(candidate.sourceInstanceUUID)
      || typeof candidate.applicationUUID !== "string" || !UUID.test(candidate.applicationUUID)
      || typeof candidate.historyEpoch !== "string" || !UUID.test(candidate.historyEpoch)
      || typeof candidate.origin !== "string" || typeof candidate.externalCanonicalId !== "string" || candidate.externalCanonicalId !== recordId) return null;
    try { if (new URL(candidate.origin).origin !== candidate.origin) return null; } catch { return null; }
    const item = candidate as Destination, key = destinationKey(item); if (seen.has(key)) return null; seen.add(key); result.push(item);
  }
  return result.sort((left, right) => destinationKey(left).localeCompare(destinationKey(right)));
}
function destinationKey(value: Omit<Destination,"externalCanonicalId">): string {
  return [value.sourceId,value.sourceInstanceUUID,value.applicationUUID,value.historyEpoch,value.origin].join("\u0000");
}
function sameDestinations(left: Destination[], right: Destination[]): boolean {
  return left.length === right.length && left.every((value, index) => destinationKey(value) === destinationKey(right[index]!));
}
async function deterministicCommandId(mutationId: string, destination: Destination): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mutationId}\u0000${destinationKey(destination)}`))).slice(0,16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function activeHead(db: D1Database, recordId: string, kind: "client" | "organization", destination: Destination): Promise<Head | null> {
  const mapping = await db.prepare(`SELECT project_alpha_public_id publicId FROM project_alpha_active_directory_mappings
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId)
    .first<{ publicId: string }>();
  if (!mapping || !/^[0-9a-f]{32}$/.test(mapping.publicId)) return null;
  if (kind === "client") {
    const relationship = await db.prepare(`SELECT json_extract(outcome_json,'$.response.result.client.revision') revision
      FROM project_alpha_directory_relationship_outbox WHERE client_record_id=? AND source_id=? AND source_instance_id=?
        AND application_id=? AND history_epoch_id=? AND client_public_id=? AND state='acknowledged'
      ORDER BY relationship_version DESC,created_at DESC,command_id DESC LIMIT 1`)
      .bind(recordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,mapping.publicId)
      .first<{ revision: string }>();
    if (relationship && REVISION.test(relationship.revision) && relationship.revision !== "0") return { publicId: mapping.publicId, revision: relationship.revision };
  }
  const profile = await db.prepare(`SELECT json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision
    FROM project_alpha_directory_outbox outbox WHERE outbox.source_id=? AND outbox.expected_source_instance_id=?
      AND outbox.application_id=? AND outbox.expected_history_epoch_id=? AND outbox.destination_base_url=?
      AND outbox.resource_type=? AND outbox.external_id=? AND outbox.state='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
    ORDER BY outbox.created_at DESC,outbox.command_id DESC LIMIT 1`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,kind,recordId,mapping.publicId)
    .first<{ revision: string }>();
  if (profile && REVISION.test(profile.revision) && profile.revision !== "0") return { publicId: mapping.publicId, revision: profile.revision };
  const refresh = await db.prepare(`SELECT live_revision revision FROM project_alpha_existing_directory_binding_revision_refresh_receipts
    WHERE record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND resource_type=? AND external_id=? AND project_alpha_public_id=? ORDER BY received_at DESC,receipt_id DESC LIMIT 1`)
    .bind(recordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId,mapping.publicId)
    .first<{ revision: string }>();
  if (refresh && REVISION.test(refresh.revision) && refresh.revision !== "0") return { publicId: mapping.publicId, revision: refresh.revision };
  const activation = await db.prepare(`SELECT project_alpha_revision revision FROM project_alpha_existing_directory_binding_activation_receipts
    WHERE record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND resource_type=? AND external_id=? AND project_alpha_public_id=?`)
    .bind(recordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId,mapping.publicId)
    .first<{ revision: string }>();
  return activation && REVISION.test(activation.revision) && activation.revision !== "0" ? { publicId: mapping.publicId, revision: activation.revision } : null;
}
async function currentGeneration(db: D1Database, destination: Destination): Promise<string | null> {
  const row = await db.prepare(`SELECT generation FROM (
      SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration') generation
      FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=? AND application_id=?
        AND expected_history_epoch_id=? AND state='acknowledged'
      UNION ALL SELECT authorization_generation FROM project_alpha_existing_directory_binding_revision_refresh_receipts
        WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      UNION ALL SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration')
        FROM project_alpha_directory_relationship_outbox WHERE source_id=? AND source_instance_id=? AND application_id=?
          AND history_epoch_id=? AND state='acknowledged'
    ) WHERE generation GLOB '[0-9]*' AND generation NOT GLOB '*[^0-9]*'
    ORDER BY length(generation) DESC,generation DESC LIMIT 1`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch)
    .first<{ generation: string }>();
  return row && REVISION.test(row.generation) && row.generation !== "9223372036854775807" ? row.generation : null;
}
async function loadEnrollment(db: D1Database, recordId: string): Promise<Destination[] | null> {
  const row = await db.prepare("SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?").bind(recordId).first<{ destinations_json: string }>();
  return row ? destinations(row.destinations_json, recordId) : null;
}

/** Canonically changes an existing native client relationship and reserves the
 * exact PA work in the same D1 batch.  This function performs no HTTP work. */
export async function writeNativeDirectoryRelationship(db: D1Database, input: NativeDirectoryRelationshipWrite): Promise<NativeDirectoryRelationshipWriteOutcome> {
  const write = normalize(input); if (!write) return { status: "rejected", reason: "invalid_write" };
  const relationshipAction = action(write); if (!relationshipAction) return { status: "rejected", reason: "no_change" };
  const body = requestJson(write);
  const replayRows = (await db.prepare(`SELECT command_id,source_id,action,command_json,request_json,relationship_version
    FROM project_alpha_directory_relationship_outbox WHERE mutation_id=? ORDER BY source_id,source_instance_id,application_id,history_epoch_id`)
    .bind(write.mutationId).all<Record<string, unknown>>()).results;
  if (replayRows.length) {
    if (replayRows.some(row => row.request_json !== body || row.action !== relationshipAction || typeof row.command_json !== "string"
      || typeof row.command_id !== "string" || typeof row.source_id !== "string" || typeof row.relationship_version !== "number"))
      return { status: "conflict", reason: "idempotency_body_conflict" };
    return { status: "written", replayed: true, mutationId: write.mutationId,
      relationshipVersion: replayRows[0]!.relationship_version as number,
      reservations: replayRows.map(row => ({ commandId: row.command_id as string, sourceId: row.source_id as string,
        action: relationshipAction, command: JSON.parse(row.command_json as string) as ProjectAlphaDirectoryRelationshipCommand })) };
  }
  if (await db.prepare("SELECT 1 present FROM operations_directory_client_organization_history WHERE mutation_id=?").bind(write.mutationId).first())
    return { status: "conflict", reason: "idempotency_body_conflict" };
  const relation = await db.prepare(`SELECT relationship.organization_record_id,relationship.relationship_version,
      client.record_kind client_kind,client.current_version client_version
    FROM operations_directory_client_organizations relationship
    JOIN operations_directory_records client ON client.record_id=relationship.client_record_id
    WHERE relationship.client_record_id=?`).bind(write.clientRecordId).first<Record<string, unknown>>();
  if (!relation || relation.client_kind !== "client" || relation.relationship_version !== write.expectedRelationshipVersion
    || relation.organization_record_id !== (write.previousOrganization?.recordId ?? null)) return { status: "conflict", reason: "stale_relationship" };
  if (relation.client_version !== write.expectedClientRecordVersion) return { status: "conflict", reason: "stale_record" };
  for (const value of [write.previousOrganization,write.organization]) if (value) {
    const record = await db.prepare("SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?").bind(value.recordId)
      .first<{ record_kind: string; current_version: number }>();
    if (!record || record.record_kind !== "organization" || record.current_version !== value.expectedRecordVersion)
      return { status: "conflict", reason: "stale_record" };
  }
  const enrolled = await loadEnrollment(db, write.clientRecordId); if (!enrolled) return { status: "blocked", reason: "destination_mismatch" };
  for (const value of [write.previousOrganization,write.organization]) if (value) {
    const organizationDestinations = await loadEnrollment(db,value.recordId);
    if (!organizationDestinations || !sameDestinations(enrolled,organizationDestinations)) return { status: "blocked", reason: "destination_mismatch" };
  }
  const prepared: { destination: Destination; reservation: NativeDirectoryRelationshipReservation; clientPublicId: string }[] = [];
  for (const destination of enrolled) {
    const client = await activeHead(db,write.clientRecordId,"client",destination);
    const previous = write.previousOrganization ? await activeHead(db,write.previousOrganization.recordId,"organization",destination) : null;
    const organization = write.organization ? await activeHead(db,write.organization.recordId,"organization",destination) : null;
    const generation = await currentGeneration(db,destination);
    if (!client || (write.previousOrganization && !previous) || (write.organization && !organization) || generation === null)
      return { status: "blocked", reason: "mapping_evidence" };
    const commandId = await deterministicCommandId(write.mutationId,destination);
    const command: ProjectAlphaDirectoryRelationshipCommand = { commandId, expectedClientRevision: client.revision,
      expectedAuthorizationGeneration: generation, expectedCurrentOrganizationPublicId: previous?.publicId ?? null,
      organization: organization ? { externalId: write.organization!.recordId, publicId: organization.publicId, expectedRevision: organization.revision } : null };
    prepared.push({ destination, clientPublicId: client.publicId,
      reservation: { commandId, sourceId: destination.sourceId, action: relationshipAction, command } });
  }
  const reservations = prepared.map(value => value.reservation);
  const verifiedUntil = new Date(Date.now()+60_000).toISOString(), nextVersion = write.expectedRelationshipVersion+1;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,
      previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
      organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(write.mutationId,write.clientRecordId,write.expectedRelationshipVersion,
        write.previousOrganization?.recordId ?? null,write.organization?.recordId ?? null,write.expectedClientRecordVersion,
        write.previousOrganization?.expectedRecordVersion ?? null,write.organization?.expectedRecordVersion ?? null,
        write.actor.staffId,write.actor.accessSubject,write.actor.email,write.actor.admissionVersion,write.actor.profileVersion,verifiedUntil),
    db.prepare(`UPDATE operations_directory_client_organizations SET organization_record_id=?,relationship_version=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE client_record_id=? AND relationship_version=? AND organization_record_id IS ?`)
      .bind(write.organization?.recordId ?? null,nextVersion,write.clientRecordId,write.expectedRelationshipVersion,write.previousOrganization?.recordId ?? null),
  ];
  for (const value of prepared) {
    const { destination, reservation, clientPublicId }=value, command=reservation.command;
    statements.push(db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,
      relationship_version,action,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
      client_public_id,expected_client_revision,expected_authorization_generation,expected_current_organization_record_id,
      expected_current_organization_public_id,organization_record_id,organization_public_id,expected_organization_revision,
      command_json,request_json,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(reservation.commandId,write.mutationId,write.clientRecordId,nextVersion,relationshipAction,destination.sourceId,
        destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
        clientPublicId,
        command.expectedClientRevision,command.expectedAuthorizationGeneration,write.previousOrganization?.recordId ?? null,
        command.expectedCurrentOrganizationPublicId,write.organization?.recordId ?? null,command.organization?.publicId ?? null,
        command.organization?.expectedRevision ?? null,JSON.stringify(command),body,Date.now()));
  }
  statements.push(db.prepare("DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?").bind(write.mutationId));
  try {
    await db.batch(statements);
  } catch { return { status: "blocked", reason: "authority_or_race" }; }
  return { status: "written", replayed: false, mutationId: write.mutationId, relationshipVersion: nextVersion, reservations };
}
