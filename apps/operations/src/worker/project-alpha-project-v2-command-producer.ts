/**
 * Private, unmounted planner for Project Alpha project-v2 commands.
 *
 * This deliberately has no fetcher, route, queue, scheduler, or transport
 * dependency.  It only reserves a canonical request for a deliberately
 * selected configured source.  A later reviewed dispatcher may consume the
 * pending outbox row; an outage therefore leaves this exact command pending.
 */
import { canonicalProjectAlphaProjectRequest, type ProjectAlphaProjectBindCommand, type ProjectAlphaProjectCreateCommand, type ProjectAlphaProjectUpdateCommand } from "./project-alpha-project-api-v2";
import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";

export type ProjectAlphaProjectV2CommandProducerEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type Operation = "create" | "update" | "bind";
type Scope = Readonly<{ scopeKind: "business_area"; businessAreaId: string; divisionId: null } | { scopeKind: "division"; businessAreaId: string; divisionId: string }>;
type Actor = Readonly<{ staffId: string; accessSubject: string; verifiedUntil: string; scopes: readonly Scope[] }>;
type LocalExpectation = Readonly<{ expectedLocalVersion: number; expectedLocalProjectionSha256: string | null }>;

export type ProjectAlphaProjectV2CommandProducerAction =
  | Readonly<{ sourceId: string; actor: Actor; operation: "create"; command: ProjectAlphaProjectCreateCommand; directory: Readonly<{ organizationRecordId: string; clientRecordId: string | null }>; local: Readonly<{ expectedLocalVersion: 0; expectedLocalProjectionSha256: null }> }>
  | Readonly<{ sourceId: string; actor: Actor; operation: "update"; command: ProjectAlphaProjectUpdateCommand; local: LocalExpectation }>
  | Readonly<{ sourceId: string; actor: Actor; operation: "bind"; command: ProjectAlphaProjectBindCommand; local: LocalExpectation }>;

export type ProjectAlphaProjectV2CommandProducerOutcome =
  | Readonly<{ status: "queued"; commandId: string; requestSha256: string; replayed: boolean }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "destination" | "stale" | "directory" | "invalid_action" }>
  | Readonly<{ status: "conflict"; reason: "command_id" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

type Connection = Readonly<{ sourceId: string; baseUrl: string; sourceInstanceId: string; applicationId: string; historyEpochId: string }>;
type Head = Readonly<{ current_version: number; canonical_projection_sha256: string | null; organization_record_id: string | null; client_record_id: string | null; source_id: string | null; source_instance_id: string | null; application_id: string | null; history_epoch_id: string | null }>;
type Mapping = Readonly<{ source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string; project_alpha_public_id: string }>;
type ActorState = Readonly<{ admission_version: number; profile_version: number; email: string; generation: number }>;

function validScope(value: unknown): value is Scope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== 3 || !["scopeKind", "businessAreaId", "divisionId"].every(key => Object.hasOwn(record, key))
    || typeof record.businessAreaId !== "string" || record.businessAreaId.length === 0) return false;
  return record.scopeKind === "business_area" ? record.divisionId === null
    : record.scopeKind === "division" && typeof record.divisionId === "string" && record.divisionId.length > 0;
}
function validActor(value: Actor): boolean {
  return typeof value.staffId === "string" && value.staffId.length > 0 && value.staffId.length <= 191
    && typeof value.accessSubject === "string" && value.accessSubject.length > 0 && value.accessSubject.length <= 764
    && typeof value.verifiedUntil === "string" && INSTANT.test(value.verifiedUntil)
    && Number.isFinite(Date.parse(value.verifiedUntil)) && Date.parse(value.verifiedUntil) > Date.now()
    && Array.isArray(value.scopes) && value.scopes.length <= 128 && value.scopes.every(validScope);
}
function validLocal(value: LocalExpectation, create: boolean): boolean {
  return Number.isSafeInteger(value.expectedLocalVersion) && value.expectedLocalVersion >= 0
    && (create ? value.expectedLocalVersion === 0 && value.expectedLocalProjectionSha256 === null
      : value.expectedLocalVersion >= 1 && typeof value.expectedLocalProjectionSha256 === "string" && SHA256.test(value.expectedLocalProjectionSha256));
}
function identity(connection: Connection, value: Mapping): boolean {
  return value.source_id === connection.sourceId && value.source_instance_id === connection.sourceInstanceId
    && value.application_id === connection.applicationId && value.history_epoch_id === connection.historyEpochId;
}
function headMatches(head: Head | null, local: LocalExpectation, connection: Connection, mapped: boolean): boolean {
  if (!head || head.current_version !== local.expectedLocalVersion || head.canonical_projection_sha256 !== local.expectedLocalProjectionSha256) return false;
  return mapped ? head.source_id === connection.sourceId && head.source_instance_id === connection.sourceInstanceId
    && head.application_id === connection.applicationId && head.history_epoch_id === connection.historyEpochId
    : head.source_id === null && head.source_instance_id === null && head.application_id === null && head.history_epoch_id === null;
}
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
function configured(env: ProjectAlphaProjectV2CommandProducerEnvironment, sourceId: string): Connection | null {
  try {
    const value = resolveProjectAlphaApiV2Connection(env, sourceId);
    return { sourceId: value.sourceId, baseUrl: value.connection.baseUrl,
      sourceInstanceId: value.connection.expectedSourceInstanceId, applicationId: value.connection.expectedApplicationId,
      historyEpochId: value.connection.expectedHistoryEpoch! };
  } catch { return null; }
}
async function readState(db: D1Database, externalProjectId: string) {
  const [head, mapping] = await Promise.all([
    db.prepare(`SELECT current_version,canonical_projection_sha256,organization_record_id,client_record_id,
      source_id,source_instance_id,application_id,history_epoch_id FROM operations_shared_projects WHERE external_project_id=?`)
      .bind(externalProjectId).first<Head>(),
    db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
      FROM project_alpha_project_mappings WHERE external_project_id=?`).bind(externalProjectId).first<Mapping>(),
  ]);
  return { head, mapping };
}
async function directoryReady(db: D1Database, connection: Connection, organizationRecordId: string | null, clientRecordId: string | null, expected?: Readonly<{ organizationPublicId: string; clientPublicId: string | null }>): Promise<boolean> {
  async function record(kind: "organization" | "client", recordId: string | null, publicId?: string | null): Promise<boolean> {
    if (recordId === null) return publicId === undefined || publicId === null;
    const row = await db.prepare(`SELECT mapping.project_alpha_public_id FROM operations_directory_records record
      JOIN project_alpha_directory_mappings mapping ON mapping.external_id=record.record_id
      WHERE record.record_id=? AND record.record_kind=? AND mapping.source_id=? AND mapping.source_instance_id=?
        AND mapping.application_id=? AND mapping.history_epoch_id=? AND mapping.resource_type=?`)
      .bind(recordId, kind, connection.sourceId, connection.sourceInstanceId, connection.applicationId, connection.historyEpochId, kind)
      .all<{ project_alpha_public_id: string }>();
    return row.results.length === 1 && (publicId === undefined || row.results[0]!.project_alpha_public_id === publicId);
  }
  if (organizationRecordId === null || !(await record("organization", organizationRecordId, expected?.organizationPublicId))
    || !(await record("client", clientRecordId, expected?.clientPublicId))) return false;
  if (clientRecordId === null) return true;
  return !!await db.prepare(`SELECT 1 present FROM operations_directory_client_organizations
    WHERE client_record_id=? AND organization_record_id=?`).bind(clientRecordId, organizationRecordId).first("present");
}
async function actorState(db: D1Database, actor: Actor): Promise<ActorState | null> {
  return db.prepare(`SELECT admission.version admission_version,profile.version profile_version,profile.login_email email,generation.generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(actor.staffId, actor.accessSubject).first<ActorState>();
}
async function prior(db: D1Database, commandId: string) {
  return db.prepare(`SELECT outbox.command_json,outbox.operation,outbox.source_id,outbox.application_id,outbox.destination_base_url,
      outbox.expected_source_instance_id,outbox.expected_history_epoch_id,fingerprint.request_sha256,
      (SELECT count(*) FROM native_project_command_reservations reservation WHERE reservation.command_id=outbox.command_id) reservation,
      (SELECT count(*) FROM project_alpha_project_v2_canonical_intents intent WHERE intent.command_id=outbox.command_id) intent
    FROM project_alpha_project_outbox outbox LEFT JOIN project_alpha_project_v2_request_fingerprints fingerprint
      ON fingerprint.command_id=outbox.command_id WHERE outbox.command_id=?`).bind(commandId).first<{
        command_json: string; operation: string; source_id: string; application_id: string; destination_base_url: string;
        expected_source_instance_id: string; expected_history_epoch_id: string; request_sha256: string | null; reservation: number; intent: number;
      }>();
}

/** Plans one canonical pending request. It is intentionally the only export. */
export async function planProjectAlphaProjectV2Command(
  env: ProjectAlphaProjectV2CommandProducerEnvironment,
  action: ProjectAlphaProjectV2CommandProducerAction,
): Promise<ProjectAlphaProjectV2CommandProducerOutcome> {
  const connection = configured(env, action.sourceId);
  if (!connection || !validActor(action.actor) || !validLocal(action.local, action.operation === "create")) return { status: "blocked", reason: connection ? "invalid_action" : "configuration" };
  const canonical = canonicalProjectAlphaProjectRequest(action.operation, action.command);
  if (!canonical || canonical.command.commandId !== action.command.commandId) return { status: "blocked", reason: "invalid_action" };
  const requestSha256 = await sha256(canonical.body).catch(() => null);
  if (!requestSha256) return { status: "uncertain", reason: "database" };

  try {
    const previous = await prior(env.OPS_DB, canonical.command.commandId);
    if (previous) {
      const same = previous.command_json === canonical.body && previous.operation === action.operation
        && previous.source_id === connection.sourceId && previous.application_id === connection.applicationId
        && previous.destination_base_url === connection.baseUrl && previous.expected_source_instance_id === connection.sourceInstanceId
        && previous.expected_history_epoch_id === connection.historyEpochId && previous.request_sha256 === requestSha256
        && previous.reservation === 1 && previous.intent === 1;
      return same ? { status: "queued", commandId: canonical.command.commandId, requestSha256, replayed: true }
        : { status: "conflict", reason: "command_id" };
    }

    const destination = await env.OPS_DB.prepare(`SELECT source_id,application_id,destination_base_url,expected_source_instance_id,
      expected_history_epoch_id FROM project_alpha_project_destinations WHERE external_project_id=?`).bind(canonical.command.externalId)
      .first<{ source_id: string; application_id: string; destination_base_url: string; expected_source_instance_id: string; expected_history_epoch_id: string }>();
    if (destination && (destination.source_id !== connection.sourceId || destination.application_id !== connection.applicationId
      || destination.destination_base_url !== connection.baseUrl || destination.expected_source_instance_id !== connection.sourceInstanceId
      || destination.expected_history_epoch_id !== connection.historyEpochId)) return { status: "blocked", reason: "destination" };

    const { head, mapping } = await readState(env.OPS_DB, canonical.command.externalId);
    let organizationRecordId: string | null, clientRecordId: string | null;
    if (action.operation === "create") {
      if (head || mapping) return { status: "blocked", reason: "stale" };
      organizationRecordId = action.directory.organizationRecordId; clientRecordId = action.directory.clientRecordId;
      const command = canonical.command as ProjectAlphaProjectCreateCommand;
      if (!await directoryReady(env.OPS_DB, connection, organizationRecordId, clientRecordId,
        { organizationPublicId: command.organization.expectedPublicId, clientPublicId: command.client?.expectedPublicId ?? null })) return { status: "blocked", reason: "directory" };
    } else if (action.operation === "update") {
      if (!mapping || !identity(connection, mapping) || !headMatches(head, action.local, connection, true)) return { status: "blocked", reason: "stale" };
      organizationRecordId = head!.organization_record_id; clientRecordId = head!.client_record_id;
      if (!await directoryReady(env.OPS_DB, connection, organizationRecordId, clientRecordId)) return { status: "blocked", reason: "directory" };
    } else {
      // A bind establishes a mapping from an existing native head, so it must
      // be checked separately from update's exact existing mapping requirement.
      if (mapping || !headMatches(head, action.local, connection, false)) return { status: "blocked", reason: "stale" };
      organizationRecordId = head!.organization_record_id; clientRecordId = head!.client_record_id;
      if (!await directoryReady(env.OPS_DB, connection, organizationRecordId, clientRecordId)) return { status: "blocked", reason: "directory" };
    }
    const actor = await actorState(env.OPS_DB, action.actor);
    if (!actor) return { status: "blocked", reason: "authority" };
    const scopesJson = JSON.stringify(action.actor.scopes.map(scope => scope.scopeKind === "business_area"
      ? { scopeKind: "business_area", businessAreaId: scope.businessAreaId, divisionId: null }
      : { scopeKind: "division", businessAreaId: scope.businessAreaId, divisionId: scope.divisionId }));
    const originSnapshot = JSON.stringify({ actorId: action.actor.staffId });
    const nextAttemptAt = Math.floor(Date.now() / 1000);
    const mappingState = action.operation === "update" ? "exact" : "absent";
    const expectedPublicId = action.operation === "update" ? mapping!.project_alpha_public_id : null;
    const statements: D1PreparedStatement[] = [];
    if (!destination) statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
      destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`).bind(
      canonical.command.externalId, connection.sourceId, connection.applicationId, connection.baseUrl, connection.sourceInstanceId, connection.historyEpochId));
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,
        actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(canonical.command.commandId, canonical.command.externalId, action.actor.staffId,
        action.actor.accessSubject, actor.admission_version, actor.profile_version, actor.email, action.actor.verifiedUntil, actor.generation, scopesJson),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,source_id,
        application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,expected_history_epoch_id)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?,?)`).bind(canonical.command.commandId, canonical.command.externalId,
        action.operation, canonical.body, connection.sourceId, connection.applicationId, connection.baseUrl, connection.sourceInstanceId,
        originSnapshot, nextAttemptAt, connection.historyEpochId),
      env.OPS_DB.prepare("INSERT INTO native_project_command_reservations(command_id) VALUES(?)").bind(canonical.command.commandId),
      env.OPS_DB.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)").bind(canonical.command.commandId, requestSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
        VALUES(?,1,? ,?,'pending')`).bind(canonical.command.commandId, crypto.randomUUID(), requestSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(command_id,request_sha256,operation,external_project_id,
        expected_local_version,expected_local_projection_sha256,expected_grant_generation,expected_mapping_state,
        expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(canonical.command.commandId, requestSha256, action.operation,
        canonical.command.externalId, action.local.expectedLocalVersion, action.local.expectedLocalProjectionSha256,
        actor.generation, mappingState, expectedPublicId, connection.sourceId, connection.sourceInstanceId,
        connection.applicationId, connection.historyEpochId),
    );
    await env.OPS_DB.batch(statements);
    return { status: "queued", commandId: canonical.command.commandId, requestSha256, replayed: false };
  } catch {
    try {
      const replay = await prior(env.OPS_DB, canonical.command.commandId);
      if (replay && replay.command_json === canonical.body && replay.request_sha256 === requestSha256 && replay.reservation === 1 && replay.intent === 1)
        return { status: "queued", commandId: canonical.command.commandId, requestSha256, replayed: true };
    } catch { /* preserve the unknown outcome */ }
    return { status: "uncertain", reason: "database" };
  }
}
