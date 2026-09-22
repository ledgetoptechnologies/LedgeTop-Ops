/**
 * Private, unmounted bridge from one immutable 0124 reservation to one native
 * version-1 head and one complete pending v2 bind plan. Caller input names only
 * the reservation; every identity, Project field, authority fact, destination,
 * and Directory relationship is loaded from D1 and rechecked by the final
 * 0128 receipt trigger in the same atomic batch.
 */
import { canonicalProjectAlphaProjectRequest, type ProjectAlphaProjectBindCommand } from "./project-alpha-project-api-v2";

export type ProjectAlphaProjectAdoptionBindEnvironment = Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaProjectAdoptionBindOutcome =
  | Readonly<{ status: "planned"; bridgeId: string; reservationId: string; commandId: string; requestSha256: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_action" }>
  | Readonly<{ status: "blocked"; reason: "missing_reservation" | "invalid_evidence" | "current_state" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Candidate = Readonly<{
  reservation_id: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  external_project_id: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  authorization_generation: string;
  canonical_detail_read_json: string;
  canonical_detail_read_sha256: string;
  organization_record_id: string | null;
  organization_project_alpha_public_id: string | null;
  client_record_id: string | null;
  client_project_alpha_public_id: string | null;
  reviewer_staff_id: string;
  reviewer_access_subject: string;
  reviewer_admission_version: number;
  reviewer_profile_version: number;
  reviewer_owner_role_id: string;
  project_grant_generation: number;
  normalized_scopes_json: string;
  expires_at: string;
  destination_base_url: string;
  reviewer_email: string;
}>;
type Receipt = Readonly<{ bridge_id: string; reservation_id: string; command_id: string; request_sha256: string }>;
type DetailData = Readonly<{
  name: string;
  description: string | null;
  status: "not_started" | "active" | "completed" | "cancelled";
  archived: boolean;
  overdueWarning: boolean;
  completedAt: string | null;
  archivedAt: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  clientPublicId: string | null;
  organizationPublicId: string | null;
}>;

function action(value: unknown): value is Readonly<{ reservationId: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const record = value as Record<string, unknown>, keys = Reflect.ownKeys(record);
  return keys.length === 1 && keys[0] === "reservationId"
    && Object.getOwnPropertyDescriptor(record, "reservationId")?.enumerable === true
    && "value" in Object.getOwnPropertyDescriptor(record, "reservationId")!
    && typeof record.reservationId === "string" && UUID.test(record.reservationId);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || typeof value === "string" && value.length <= maximum && !value.includes("\0");
}
function nullableInstant(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length >= 20 && value.length <= 32 && !value.includes("\0");
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function detail(candidate: Candidate): Promise<DetailData | null> {
  if (!SHA256.test(candidate.canonical_detail_read_sha256)
    || !SHA256.test(candidate.projection_sha256)
    || await sha256(candidate.canonical_detail_read_json) !== candidate.canonical_detail_read_sha256) return null;
  try {
    const value = JSON.parse(candidate.canonical_detail_read_json) as unknown;
    if (!exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "data"])
      || value.apiVersion !== "2" || value.sourceInstanceId !== candidate.source_instance_id
      || value.applicationId !== candidate.application_id || value.historyEpoch !== candidate.history_epoch_id
      || typeof value.requestId !== "string" || !UUID.test(value.requestId)
      || typeof value.replayed !== "boolean" || value.accepted !== true
      || !exact(value.resource, ["type", "id", "revision", "projectionSha256"])
      || value.resource.type !== "project" || value.resource.id !== candidate.project_alpha_public_id
      || value.resource.revision !== candidate.project_alpha_revision
      || value.resource.projectionSha256 !== candidate.projection_sha256
      || !exact(value.data, ["name", "description", "status", "archived", "overdueWarning", "completedAt",
        "archivedAt", "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"])) return null;
    const data = value.data;
    if (typeof data.name !== "string" || data.name.length < 1 || data.name.length > 150 || data.name.includes("\0")
      || !nullableText(data.description, 10_000)
      || !["not_started", "active", "completed", "cancelled"].includes(typeof data.status === "string" ? data.status : "")
      || typeof data.archived !== "boolean" || typeof data.overdueWarning !== "boolean"
      || !nullableInstant(data.completedAt) || !nullableInstant(data.archivedAt)
      || !nullableText(data.estimatedStart, 10_000) || !nullableText(data.estimatedEnd, 10_000)
      || (data.archived !== (data.archivedAt !== null))
      || data.organizationPublicId !== candidate.organization_project_alpha_public_id
      || data.clientPublicId !== candidate.client_project_alpha_public_id) return null;
    return data as DetailData;
  } catch { return null; }
}
async function stored(db: D1Database, reservationId: string): Promise<Receipt | null> {
  return db.prepare(`SELECT bridge_id,reservation_id,command_id,request_sha256
    FROM project_alpha_project_adoption_bind_receipts WHERE reservation_id=?`)
    .bind(reservationId).first<Receipt>();
}
async function currentReplay(db: D1Database, receipt: Receipt): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 current
    FROM project_alpha_project_adoption_bind_receipts bridge
    JOIN project_alpha_project_adoption_review_reservations reservation
      ON reservation.reservation_id=bridge.reservation_id
    JOIN project_alpha_project_adoption_review_evidence review
      ON review.review_item_id=reservation.review_item_id
    JOIN native_project_live_command_proofs proof ON proof.command_id=bridge.command_id
    WHERE bridge.bridge_id=? AND bridge.reservation_id=? AND bridge.command_id=? AND bridge.request_sha256=?
      AND review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND proof.actor_staff_id=reservation.reviewer_staff_id
      AND proof.grant_generation=reservation.project_grant_generation
      AND EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
        WHERE owner_assignment.staff_id=reservation.reviewer_staff_id
          AND owner_assignment.role_id=reservation.reviewer_owner_role_id AND owner_assignment.scope='global')
      AND (reservation.organization_record_id IS NULL OR (SELECT count(*)
        FROM project_alpha_active_directory_mappings mapping
        JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
        WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
          AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
          AND mapping.resource_type='organization' AND mapping.external_id=reservation.organization_record_id
          AND mapping.project_alpha_public_id=reservation.organization_project_alpha_public_id)=1)
      AND (reservation.client_record_id IS NULL OR (SELECT count(*)
        FROM project_alpha_active_directory_mappings mapping
        JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
        WHERE mapping.source_id=reservation.source_id AND mapping.source_instance_id=reservation.source_instance_id
          AND mapping.application_id=reservation.application_id AND mapping.history_epoch_id=reservation.history_epoch_id
          AND mapping.resource_type='client' AND mapping.external_id=reservation.client_record_id
          AND mapping.project_alpha_public_id=reservation.client_project_alpha_public_id)=1)
      AND (reservation.organization_record_id IS NULL OR reservation.client_record_id IS NULL OR EXISTS (
        SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=reservation.client_record_id
          AND relationship.organization_record_id=reservation.organization_record_id))`)
    .bind(receipt.bridge_id, receipt.reservation_id, receipt.command_id, receipt.request_sha256).first("current");
}
async function candidate(db: D1Database, reservationId: string): Promise<Candidate | null> {
  return db.prepare(`SELECT reservation.reservation_id,reservation.source_id,reservation.source_instance_id,
      reservation.application_id,reservation.history_epoch_id,reservation.external_project_id,
      reservation.project_alpha_public_id,reservation.project_alpha_revision,reservation.projection_sha256,
      reservation.authorization_generation,review.canonical_detail_read_json,reservation.canonical_detail_read_sha256,
      reservation.organization_record_id,reservation.organization_project_alpha_public_id,reservation.client_record_id,
      reservation.client_project_alpha_public_id,reservation.reviewer_staff_id,reservation.reviewer_access_subject,
      reservation.reviewer_admission_version,reservation.reviewer_profile_version,reservation.reviewer_owner_role_id,
      reservation.project_grant_generation,reservation.normalized_scopes_json,review.expires_at,
      destination.destination_base_url,profile.login_email reviewer_email
    FROM project_alpha_project_adoption_review_reservations reservation
    JOIN project_alpha_project_adoption_review_evidence review ON review.review_item_id=reservation.review_item_id
    JOIN project_alpha_project_destinations destination ON destination.external_project_id=reservation.external_project_id
      AND destination.source_id=reservation.source_id AND destination.application_id=reservation.application_id
      AND destination.expected_source_instance_id=reservation.source_instance_id
      AND destination.expected_history_epoch_id=reservation.history_epoch_id
    JOIN native_staff_profiles profile ON profile.staff_id=reservation.reviewer_staff_id
      AND profile.version=reservation.reviewer_profile_version
    WHERE reservation.reservation_id=?`).bind(reservationId).first<Candidate>();
}

export async function planProjectAlphaProjectAdoptionBind(
  env: ProjectAlphaProjectAdoptionBindEnvironment,
  input: unknown,
): Promise<ProjectAlphaProjectAdoptionBindOutcome> {
  if (!action(input)) return { status: "rejected", reason: "invalid_action" };
  const db = env.OPS_DB.withSession("first-primary");
  try {
    const previous = await stored(db, input.reservationId);
    if (previous) return await currentReplay(db, previous)
      ? { status: "planned", bridgeId: previous.bridge_id, reservationId: previous.reservation_id,
        commandId: previous.command_id, requestSha256: previous.request_sha256, replayed: true }
      : { status: "blocked", reason: "current_state" };
    const source = await candidate(db, input.reservationId);
    if (!source) return { status: "blocked", reason: "missing_reservation" };
    const project = await detail(source);
    if (!project) return { status: "blocked", reason: "invalid_evidence" };

    const commandId = crypto.randomUUID(), bridgeId = crypto.randomUUID(), transitionId = crypto.randomUUID();
    const canonical = canonicalProjectAlphaProjectRequest("bind", {
      commandId,
      externalId: source.external_project_id,
      expectedPublicId: source.project_alpha_public_id,
      expectedRevision: source.project_alpha_revision,
      expectedProjectionSha256: source.projection_sha256,
      expectedAuthorizationGeneration: source.authorization_generation,
    } satisfies ProjectAlphaProjectBindCommand);
    if (!canonical) return { status: "blocked", reason: "invalid_evidence" };
    const requestSha256 = await sha256(canonical.body);
    const nextAttemptAt = Math.floor(Date.now() / 1000);
    await db.batch([
      db.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,
        actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,
        grant_generation,scopes_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(commandId, source.external_project_id,
        source.reviewer_staff_id, source.reviewer_access_subject, source.reviewer_admission_version,
        source.reviewer_profile_version, source.reviewer_email, source.expires_at,
        source.project_grant_generation, source.normalized_scopes_json),
      db.prepare(`INSERT INTO operations_shared_projects(external_project_id,current_version,name,description,lifecycle,
        planned_start,planned_end,organization_record_id,client_record_id,scopes_json,completed_at,archived,
        archived_at,canonical_projection_sha256,overdue_warning) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        source.external_project_id, project.name, project.description, project.status, project.estimatedStart,
        project.estimatedEnd, source.organization_record_id, source.client_record_id, source.normalized_scopes_json,
        project.completedAt, project.archived ? 1 : 0, project.archivedAt, source.projection_sha256,
        project.overdueWarning ? 1 : 0),
      db.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,pa_revision,read_json,
        refresh_command_id,v2_settlement_id) VALUES(?,1,NULL,?,NULL,NULL)`)
        .bind(source.external_project_id, source.canonical_detail_read_json),
      db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
        source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
        attempts,next_attempt_at,expected_history_epoch_id) VALUES(?,?, 'bind',?,?,?,?,?,?,'pending',0,?,?)`).bind(
        commandId, source.external_project_id, canonical.body, source.source_id, source.application_id,
        source.destination_base_url, source.source_instance_id, JSON.stringify({ actorId: source.reviewer_staff_id }),
        nextAttemptAt, source.history_epoch_id),
      db.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(commandId),
      db.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)")
        .bind(commandId, requestSha256),
      db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
        VALUES(?,1,?,?,'pending')`).bind(commandId, transitionId, requestSha256),
      db.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(command_id,request_sha256,operation,
        external_project_id,expected_local_version,expected_local_projection_sha256,expected_grant_generation,
        expected_mapping_state,expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id)
        VALUES(?,?,'bind',?,1,?,?,'absent',NULL,?,?,?,?)`).bind(commandId, requestSha256,
        source.external_project_id, source.projection_sha256, source.project_grant_generation, source.source_id,
        source.source_instance_id, source.application_id, source.history_epoch_id),
      db.prepare(`INSERT INTO project_alpha_project_adoption_bind_receipts(bridge_id,reservation_id,command_id,
        request_sha256,external_project_id,local_version,local_projection_sha256) VALUES(?,?,?,?,?,1,?)`).bind(
        bridgeId, source.reservation_id, commandId, requestSha256, source.external_project_id, source.projection_sha256),
    ]);
    const saved = await stored(db, input.reservationId);
    if (!saved || saved.bridge_id !== bridgeId || saved.command_id !== commandId
      || saved.request_sha256 !== requestSha256) return { status: "uncertain", reason: "database" };
    return { status: "planned", bridgeId, reservationId: source.reservation_id, commandId, requestSha256, replayed: false };
  } catch (error) {
    try {
      const winner = await stored(db, input.reservationId);
      if (winner) return await currentReplay(db, winner)
        ? { status: "planned", bridgeId: winner.bridge_id, reservationId: winner.reservation_id,
          commandId: winner.command_id, requestSha256: winner.request_sha256, replayed: true }
        : { status: "blocked", reason: "current_state" };
    } catch { return { status: "uncertain", reason: "database" }; }
    const message = error instanceof Error ? error.message : "";
    return /not current|not exact|requires|authority is invalid|constraint failed|SQLITE_CONSTRAINT|UNIQUE constraint/i.test(message)
      ? { status: "blocked", reason: "current_state" }
      : { status: "uncertain", reason: "database" };
  }
}
