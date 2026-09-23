import type { ProjectAlphaDirectoryRelationshipAction, ProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-api-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REVISION = "9223372036854775807";

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
  supersedeTerminalCommandIds?: readonly string[];
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
  | Readonly<{ status: "blocked"; reason: "destination_mismatch" | "mapping_evidence" | "terminal_predecessor" | "authority_or_race" }>;
type NativeDirectoryRelationshipWritePlan = Readonly<{ status: "planned";
  outcome: Extract<NativeDirectoryRelationshipWriteOutcome, { status: "written" }>; statements: readonly D1PreparedStatement[] }>;
type NativeDirectoryRelationshipWritePlanningResult = NativeDirectoryRelationshipWriteOutcome | NativeDirectoryRelationshipWritePlan;

type Destination = Readonly<{ sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string; origin: string; externalCanonicalId: string }>;
type Head = Readonly<{ publicId: string; revision: string }>;
type DirectoryWriteD1 = Pick<D1Database, "prepare" | "batch">;

function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function canonicalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value
    && new TextEncoder().encode(value).byteLength <= 764; } catch { return false; }
}
function revision(value: unknown, zero=false): value is string { return typeof value === "string"
  && (zero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value)
  && (value.length<MAX_REVISION.length || value<=MAX_REVISION); }
function endpoint(value: unknown): value is NativeDirectoryRelationshipEndpoint {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && canonicalId((value as NativeDirectoryRelationshipEndpoint).recordId)
    && integer((value as NativeDirectoryRelationshipEndpoint).expectedRecordVersion);
}
function normalize(input: NativeDirectoryRelationshipWrite): NativeDirectoryRelationshipWrite | null {
  if (!input || typeof input !== "object" || !UUID.test(input.mutationId) || !canonicalId(input.clientRecordId)
    || !Number.isSafeInteger(input.expectedRelationshipVersion) || input.expectedRelationshipVersion < 1
    || !integer(input.expectedClientRecordVersion) || (input.previousOrganization !== null && !endpoint(input.previousOrganization))
    || (input.organization !== null && !endpoint(input.organization)) || !input.actor || typeof input.actor !== "object"
    || typeof input.actor.staffId !== "string" || !input.actor.staffId || typeof input.actor.accessSubject !== "string" || !input.actor.accessSubject
    || typeof input.actor.email !== "string" || !input.actor.email || !integer(input.actor.admissionVersion) || !integer(input.actor.profileVersion)
    || (input.supersedeTerminalCommandIds !== undefined && (!Array.isArray(input.supersedeTerminalCommandIds)
      || input.supersedeTerminalCommandIds.length < 1 || input.supersedeTerminalCommandIds.length > 16
      || input.supersedeTerminalCommandIds.some(value => typeof value !== "string" || !UUID.test(value))
      || new Set(input.supersedeTerminalCommandIds).size !== input.supersedeTerminalCommandIds.length))) return null;
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
    previousOrganization: input.previousOrganization, organization: input.organization,
    supersedeTerminalCommandIds: input.supersedeTerminalCommandIds ? [...input.supersedeTerminalCommandIds].sort() : [], actor: input.actor });
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
function representsDestinations(required: Destination[], available: Destination[]): boolean {
  const keys = new Set(available.map(destinationKey));
  return required.every(value => keys.has(destinationKey(value)));
}
async function deterministicCommandId(mutationId: string, destination: Destination): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mutationId}\u0000${destinationKey(destination)}`))).slice(0,16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function greater(left: string, right: string): boolean {
  return left.length > right.length || (left.length === right.length && left > right);
}
export function maximumDirectoryRevisionEvidence(values: readonly unknown[], zero=false): string | null {
  if (!values.length || values.some(value => !revision(value,zero))) return null;
  let head=values[0] as string;
  for (const value of values.slice(1) as string[]) if (greater(value,head)) head=value;
  return head;
}
async function activeHead(db: DirectoryWriteD1, recordId: string, kind: "client" | "organization", localVersion: number,
  destination: Destination): Promise<Head | null> {
  const record = await db.prepare("SELECT record_kind kind,current_version version FROM operations_directory_records WHERE record_id=?")
    .bind(recordId).first<{ kind: string; version: number }>();
  if (!record || record.kind !== kind || record.version !== localVersion) return null;
  const mappings = (await db.prepare(`SELECT project_alpha_public_id publicId FROM project_alpha_active_directory_mappings
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId)
    .all<{ publicId: string }>()).results;
  if (mappings.length !== 1 || !/^[0-9a-f]{32}$/.test(mappings[0]!.publicId)) return null;
  const mapping = mappings[0]!;
  const evidence: { publicId: unknown; revision: unknown; assertedPublicId?: unknown; coherent?: unknown }[] = [];
  if (kind === "client") {
    evidence.push(...(await db.prepare(`SELECT json_extract(outbox.outcome_json,'$.response.result.client.publicId') publicId,
        json_extract(outbox.outcome_json,'$.response.result.client.revision') revision,outbox.client_public_id assertedPublicId,
        CASE WHEN json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=outbox.source_instance_id
          AND json_extract(outbox.outcome_json,'$.response.applicationId')=outbox.application_id
          AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=outbox.history_epoch_id
          AND json_extract(outbox.outcome_json,'$.response.result.action')=outbox.action
          AND json_extract(outbox.outcome_json,'$.response.result.organizationPublicId') IS outbox.organization_public_id THEN 1 ELSE 0 END coherent
      FROM project_alpha_directory_relationship_outbox outbox
      JOIN operations_directory_client_organization_history history ON history.client_record_id=outbox.client_record_id
        AND history.relationship_version=outbox.relationship_version
      WHERE outbox.client_record_id=? AND history.client_record_version=? AND outbox.source_id=? AND outbox.source_instance_id=?
        AND outbox.application_id=? AND outbox.history_epoch_id=? AND outbox.destination_origin=? AND outbox.state='acknowledged'`)
      .bind(recordId,localVersion,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,
        destination.historyEpoch,destination.origin).all()).results as { publicId: unknown; revision: unknown; assertedPublicId: unknown; coherent: unknown }[]);
  }
  evidence.push(...(await db.prepare(`SELECT json_extract(outbox.outcome_json,'$.response.result.resource.publicId') publicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
      CASE WHEN json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
        AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
        AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
        AND json_extract(outbox.outcome_json,'$.response.result.resource.type')=outbox.resource_type
        AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=outbox.external_id
        AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
          json_extract(outbox.outcome_json,'$.response.result.resource.publicId') THEN 1 ELSE 0 END coherent
    FROM operations_directory_intents intent
    JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    WHERE intent.record_id=? AND intent.record_version=? AND intent.source_id=? AND intent.source_instance_uuid=?
      AND intent.application_uuid=? AND intent.expected_history_epoch_id=? AND intent.destination_origin=?
      AND intent.external_canonical_id=? AND intent.state='acknowledged' AND outbox.state='acknowledged'
      AND outbox.source_id=intent.source_id AND outbox.expected_source_instance_id=intent.source_instance_uuid
      AND outbox.application_id=intent.application_uuid AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id
      AND outbox.destination_base_url=intent.destination_origin AND outbox.resource_type=? AND outbox.external_id=intent.external_canonical_id`)
    .bind(recordId,localVersion,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,
      destination.historyEpoch,destination.origin,recordId,kind).all()).results as { publicId: unknown; revision: unknown; coherent: unknown }[]);
  evidence.push(...(await db.prepare(`SELECT refresh.project_alpha_public_id publicId,refresh.live_revision revision
    FROM project_alpha_existing_directory_binding_revision_refresh_receipts refresh
    JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=refresh.native_owner_claim_id
    JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
    JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
    WHERE refresh.record_id=? AND refresh.source_id=? AND refresh.source_instance_id=? AND refresh.application_id=? AND refresh.history_epoch_id=?
      AND refresh.resource_type=? AND refresh.external_id=? AND refresh.local_record_version=? AND response.destination_origin=?`)
    .bind(recordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId,localVersion,destination.origin)
    .all()).results as { publicId: unknown; revision: unknown }[]);
  evidence.push(...(await db.prepare(`SELECT activation.project_alpha_public_id publicId,activation.project_alpha_revision revision
    FROM project_alpha_existing_directory_binding_activation_receipts activation
    JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=activation.acquired_receipt_id
    JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
    WHERE activation.record_id=? AND activation.source_id=? AND activation.source_instance_id=? AND activation.application_id=? AND activation.history_epoch_id=?
      AND activation.resource_type=? AND activation.external_id=? AND activation.local_record_version=? AND response.destination_origin=?`)
    .bind(recordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,kind,recordId,localVersion,destination.origin)
    .all()).results as { publicId: unknown; revision: unknown }[]);
  if (!evidence.length || evidence.some(value => (value.coherent !== undefined && value.coherent !== 1) || value.publicId !== mapping.publicId
    || (value.assertedPublicId !== undefined && value.assertedPublicId !== mapping.publicId))) return null;
  const head=maximumDirectoryRevisionEvidence(evidence.map(value => value.revision));if(head===null)return null;
  return { publicId: mapping.publicId, revision: head };
}
async function currentGeneration(db: DirectoryWriteD1, destination: Destination): Promise<string | null> {
  const rows = (await db.prepare(`SELECT generation FROM (
      SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration') generation
      FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=? AND application_id=?
        AND expected_history_epoch_id=? AND destination_base_url=? AND state='acknowledged'
      UNION ALL SELECT refresh.authorization_generation
        FROM project_alpha_existing_directory_binding_revision_refresh_receipts refresh
        JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=refresh.native_owner_claim_id
        JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=claim.receipt_id
        JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
        WHERE refresh.source_id=? AND refresh.source_instance_id=? AND refresh.application_id=? AND refresh.history_epoch_id=?
          AND response.destination_origin=?
      UNION ALL SELECT json_extract(outcome_json,'$.response.result.authorizationGeneration')
        FROM project_alpha_directory_relationship_outbox WHERE source_id=? AND source_instance_id=? AND application_id=?
          AND history_epoch_id=? AND destination_origin=? AND state='acknowledged'
    )`)
    .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
      destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin)
    .all<{ generation: string }>()).results;
  if (rows.some(row => row.generation === MAX_REVISION)) return null;
  return maximumDirectoryRevisionEvidence(rows.map(row=>row.generation),true);
}
async function loadEnrollment(db: DirectoryWriteD1, recordId: string): Promise<Destination[] | null> {
  const row = await db.prepare("SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?").bind(recordId).first<{ destinations_json: string }>();
  return row ? destinations(row.destinations_json, recordId) : null;
}

/** Canonically changes an existing native client relationship and reserves the
 * exact PA work in the same D1 batch.  This function performs no HTTP work. */
async function planNativeDirectoryRelationshipWriteInternal(db: DirectoryWriteD1,
  input: NativeDirectoryRelationshipWrite): Promise<NativeDirectoryRelationshipWritePlanningResult> {
  const write = normalize(input); if (!write) return { status: "rejected", reason: "invalid_write" };
  const relationshipAction = action(write); if (!relationshipAction) return { status: "rejected", reason: "no_change" };
  const body = requestJson(write);
  const replayRows = (await db.prepare(`SELECT command_id,source_id,action,command_json,request_json,relationship_version
    FROM project_alpha_directory_relationship_outbox WHERE mutation_id=? ORDER BY source_id,source_instance_id,application_id,history_epoch_id`)
    .bind(write.mutationId).all<Record<string, unknown>>()).results;
  if (replayRows.length) {
    if (replayRows.some(row => row.request_json !== body || row.action !== relationshipAction || typeof row.command_json !== "string"
      || typeof row.command_id !== "string" || typeof row.source_id !== "string" || typeof row.relationship_version !== "number"
      || row.relationship_version !== replayRows[0]!.relationship_version))
      return { status: "conflict", reason: "idempotency_body_conflict" };
    // A replay is a fresh disclosure of still-actionable reservation IDs. Do
    // not return them from stale history: every destination must still satisfy
    // the same live admission, profile, deny-aware grants, relationship and
    // exact mapping evidence used by the dispatcher.
    const current = await db.prepare(`SELECT count(*) total FROM project_alpha_directory_live_relationship_commands
      WHERE mutation_id=?`).bind(write.mutationId).first<number>("total");
    if (current !== replayRows.length) return { status: "blocked", reason: "authority_or_race" };
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
    if (!organizationDestinations || !representsDestinations(enrolled,organizationDestinations)) return { status: "blocked", reason: "destination_mismatch" };
  }
  const nextVersion = write.expectedRelationshipVersion+1;
  const requestedSupersessions = new Set(write.supersedeTerminalCommandIds ?? []), usedSupersessions = new Set<string>();
  const prepared: { destination: Destination; reservation: NativeDirectoryRelationshipReservation; clientPublicId: string;
    supersededTerminalCommandId: string | null }[] = [];
  for (const destination of enrolled) {
    const client = await activeHead(db,write.clientRecordId,"client",write.expectedClientRecordVersion,destination);
    const previous = write.previousOrganization ? await activeHead(db,write.previousOrganization.recordId,"organization",
      write.previousOrganization.expectedRecordVersion,destination) : null;
    const organization = write.organization ? await activeHead(db,write.organization.recordId,"organization",
      write.organization.expectedRecordVersion,destination) : null;
    const generation = await currentGeneration(db,destination);
    if (!client || (write.previousOrganization && !previous) || (write.organization && !organization) || generation === null)
      return { status: "blocked", reason: "mapping_evidence" };
    const predecessor = await db.prepare(`SELECT command_id commandId,state FROM project_alpha_directory_relationship_outbox
      WHERE client_record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND relationship_version<? ORDER BY relationship_version DESC,command_id DESC LIMIT 1`)
      .bind(write.clientRecordId,destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,
        destination.historyEpoch,nextVersion).first<{ commandId: string; state: string }>();
    if (predecessor && predecessor.state !== "acknowledged" && predecessor.state !== "terminal")
      return { status: "blocked", reason: "authority_or_race" };
    if (predecessor?.state === "terminal" && !requestedSupersessions.has(predecessor.commandId))
      return { status: "blocked", reason: "terminal_predecessor" };
    if (predecessor?.state === "terminal") usedSupersessions.add(predecessor.commandId);
    const commandId = await deterministicCommandId(write.mutationId,destination);
    const command: ProjectAlphaDirectoryRelationshipCommand = { commandId, expectedClientRevision: client.revision,
      expectedAuthorizationGeneration: generation, expectedCurrentOrganizationPublicId: previous?.publicId ?? null,
      organization: organization ? { externalId: write.organization!.recordId, publicId: organization.publicId, expectedRevision: organization.revision } : null };
    prepared.push({ destination, clientPublicId: client.publicId, supersededTerminalCommandId: predecessor?.state === "terminal" ? predecessor.commandId : null,
      reservation: { commandId, sourceId: destination.sourceId, action: relationshipAction, command } });
  }
  if (usedSupersessions.size !== requestedSupersessions.size) return { status: "blocked", reason: "terminal_predecessor" };
  const reservations = prepared.map(value => value.reservation);
  const verifiedUntil = new Date(Date.now()+60_000).toISOString();
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
    const { destination, reservation, clientPublicId, supersededTerminalCommandId }=value, command=reservation.command;
    statements.push(db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,
      relationship_version,action,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,
      client_public_id,expected_client_revision,expected_authorization_generation,expected_current_organization_record_id,
      expected_current_organization_public_id,organization_record_id,organization_public_id,expected_organization_revision,
      supersedes_terminal_command_id,command_json,request_json,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(reservation.commandId,write.mutationId,write.clientRecordId,nextVersion,relationshipAction,destination.sourceId,
        destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,destination.origin,
        clientPublicId,
        command.expectedClientRevision,command.expectedAuthorizationGeneration,write.previousOrganization?.recordId ?? null,
        command.expectedCurrentOrganizationPublicId,write.organization?.recordId ?? null,command.organization?.publicId ?? null,
        command.organization?.expectedRevision ?? null,supersededTerminalCommandId,JSON.stringify(command),body,Date.now()));
  }
  statements.push(db.prepare("DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?").bind(write.mutationId));
  return { status: "planned", outcome: { status: "written", replayed: false,
    mutationId: write.mutationId, relationshipVersion: nextVersion, reservations }, statements };
}

export async function writeNativeDirectoryRelationship(db: D1Database,
  input: NativeDirectoryRelationshipWrite): Promise<NativeDirectoryRelationshipWriteOutcome> {
  const planned = await planNativeDirectoryRelationshipWriteInternal(db, input);
  if (planned.status !== "planned") return planned;
  try { await db.batch([...planned.statements]); }
  catch { return { status: "blocked", reason: "authority_or_race" }; }
  return planned.outcome;
}
