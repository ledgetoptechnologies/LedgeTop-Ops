import { parseDuplicateFreeJson } from "./bounded-json";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { selectGrant } from "./native-directory-profile-routes";
import { isProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-api-v2";
import { collectDirectoryRelationshipGenerationRecoveryEvidence } from "./project-alpha-directory-relationship-generation-recovery-evidence";
import { persistProjectAlphaDirectoryInventoryPage } from "./project-alpha-v2-sync";
import { currentDirectoryRelationshipRecoveryAdministrator, type DirectoryRelationshipRecoveryActor,
  type DirectoryRelationshipRecoveryEnvironment } from "./project-alpha-directory-relationship-generation-recovery";

type Actor = DirectoryRelationshipRecoveryActor & Readonly<{ verifiedUntil: string }>;
type Failure = { status: "blocked"; reason: string } | { status: "uncertain"; reason: string };
type Discovery = {
  command_id: string; client_record_id: string; relationship_version: number; organization_record_id: string;
  client_record_version: number; organization_record_version: number; source_id: string;
  source_instance_id: string; application_id: string; history_epoch_id: string; destination_origin: string;
  client_external_id: string; client_public_id: string; organization_external_id: string; organization_public_id: string;
  expected_client_revision: string; expected_organization_revision: string; command_json: string; request_json: string;
};
type SelectedGrant = { recordId: string; permission: string; grantId: string };
type SqlValue = string | number | null;
type Review = Record<string, SqlValue> & {
  review_id: string; client_record_id: string; source_id: string; source_instance_id: string;
  application_id: string; history_epoch_id: string; destination_origin: string; predecessor_command_id: string;
  root_command_id: string; relationship_version: number; intended_organization_record_id: string;
  client_record_version: number; organization_record_version: number; client_external_id: string; client_public_id: string;
  organization_external_id: string; organization_public_id: string; expected_client_revision: string;
  expected_organization_revision: string; observed_authorization_generation: string;
  replay_conflict_sha256: string; evidence_sha256: string; reviewer_staff_id: string;
  reviewer_access_subject: string; reviewer_email: string; reviewer_admission_version: number;
  reviewer_profile_version: number; selected_grants_json: string; created_at: string; expires_at: string; state: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PERMISSIONS = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"] as const;
const REVIEW_COLUMNS = ["review_id", "client_record_id", "source_id", "source_instance_id", "application_id", "history_epoch_id",
  "destination_origin", "predecessor_command_id", "root_command_id", "relationship_version", "action",
  "local_previous_organization_record_id", "intended_organization_record_id", "client_record_version", "organization_record_version",
  "client_external_id", "client_public_id", "organization_external_id", "organization_public_id", "expected_client_revision",
  "expected_organization_revision", "remote_client_revision", "remote_parent_public_id", "target_binding_active", "target_binding_revision",
  "observed_authorization_generation", "client_inventory_request_id", "organization_inventory_request_id", "replay_request_path",
  "replay_conflict_json", "replay_request_sha256", "replay_conflict_sha256", "evidence_sha256", "reviewer_staff_id",
  "reviewer_access_subject", "reviewer_email", "reviewer_admission_version", "reviewer_profile_version", "selected_grants_json",
  "created_at", "expires_at", "state"] as const;

function recordId(value: string): boolean {
  return value.length > 0 && Array.from(value).length <= 191 && !/\p{C}/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 764;
}
function actorFresh(actor: Actor): boolean {
  return Number.isFinite(Date.parse(actor.verifiedUntil)) && Date.parse(actor.verifiedUntil) > Date.now();
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function selectGrants(db: D1Database, actor: Actor, client: string, organization: string): Promise<SelectedGrant[] | null> {
  if (!actorFresh(actor) || client === organization || !await currentDirectoryRelationshipRecoveryAdministrator(db, actor)) return null;
  const result: SelectedGrant[] = [];
  for (const resource of [client, organization]) for (const permission of PERMISSIONS) {
    const grantId = await selectGrant(db, actor.staffId, permission, resource, [], false);
    if (!grantId) return null;
    result.push({ recordId: resource, permission, grantId });
  }
  return actorFresh(actor) ? result : null;
}
function configured(env: DirectoryRelationshipRecoveryEnvironment, row: Discovery): boolean {
  const resolved = resolveProjectAlphaApiV2Connection(env, row.source_id);
  return resolved.enabled && resolved.connection.expectedSourceInstanceId === row.source_instance_id
    && resolved.connection.expectedApplicationId === row.application_id
    && resolved.connection.expectedHistoryEpoch === row.history_epoch_id
    && new URL(resolved.connection.baseUrl).origin === row.destination_origin;
}
/** Derives the immediate terminal command from the current canonical client;
 * accepting an arbitrary predecessor from the browser is intentionally impossible. */
async function discover(db: D1Database, record: string, source: string): Promise<Discovery | null> {
  const rows = await db.withSession("first-primary").prepare(`SELECT predecessor.command_id,predecessor.client_record_id,
      predecessor.relationship_version,predecessor.organization_record_id,history.client_record_version,
      history.organization_record_version,predecessor.source_id,predecessor.source_instance_id,predecessor.application_id,
      predecessor.history_epoch_id,predecessor.destination_origin,client_mapping.external_id client_external_id,
      predecessor.client_public_id,organization_mapping.external_id organization_external_id,predecessor.organization_public_id,
      predecessor.expected_client_revision,predecessor.expected_organization_revision,predecessor.command_json,predecessor.request_json
    FROM project_alpha_directory_relationship_outbox predecessor
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=predecessor.client_record_id
      AND relation.relationship_version=predecessor.relationship_version AND relation.organization_record_id=predecessor.organization_record_id
    JOIN operations_directory_client_organization_history history ON history.client_record_id=relation.client_record_id
      AND history.relationship_version=relation.relationship_version AND history.mutation_id=predecessor.mutation_id
      AND history.previous_organization_record_id IS NULL AND history.organization_record_id=relation.organization_record_id
    JOIN operations_directory_records client ON client.record_id=relation.client_record_id AND client.record_kind='client'
      AND client.current_version=history.client_record_version
    JOIN operations_directory_records organization ON organization.record_id=relation.organization_record_id
      AND organization.record_kind='organization' AND organization.current_version=history.organization_record_version
    JOIN project_alpha_active_directory_mappings client_mapping ON client_mapping.record_id=client.record_id
      AND client_mapping.resource_type='client' AND client_mapping.project_alpha_public_id=predecessor.client_public_id
      AND client_mapping.source_id=predecessor.source_id AND client_mapping.source_instance_id=predecessor.source_instance_id
      AND client_mapping.application_id=predecessor.application_id AND client_mapping.history_epoch_id=predecessor.history_epoch_id
    JOIN project_alpha_active_directory_mappings organization_mapping ON organization_mapping.record_id=organization.record_id
      AND organization_mapping.resource_type='organization' AND organization_mapping.project_alpha_public_id=predecessor.organization_public_id
      AND organization_mapping.source_id=predecessor.source_id AND organization_mapping.source_instance_id=predecessor.source_instance_id
      AND organization_mapping.application_id=predecessor.application_id AND organization_mapping.history_epoch_id=predecessor.history_epoch_id
    WHERE predecessor.client_record_id=? AND predecessor.source_id=? AND predecessor.state='terminal' AND predecessor.action='assign'
      AND predecessor.expected_current_organization_record_id IS NULL AND predecessor.expected_current_organization_public_id IS NULL
      AND json_extract(predecessor.outcome_json,'$.status')='conflict' AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_generation_recoveries recovery
        WHERE recovery.predecessor_command_id=predecessor.command_id)
      AND EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
        WHERE enrollment.record_id=client.record_id AND json_extract(destination.value,'$.sourceId')=predecessor.source_id
          AND json_extract(destination.value,'$.sourceInstanceUUID')=predecessor.source_instance_id
          AND json_extract(destination.value,'$.applicationUUID')=predecessor.application_id
          AND json_extract(destination.value,'$.historyEpoch')=predecessor.history_epoch_id
          AND json_extract(destination.value,'$.origin')=predecessor.destination_origin
          AND json_extract(destination.value,'$.externalCanonicalId')=client_mapping.external_id)
      AND EXISTS(SELECT 1 FROM native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
        WHERE enrollment.record_id=organization.record_id AND json_extract(destination.value,'$.sourceId')=predecessor.source_id
          AND json_extract(destination.value,'$.sourceInstanceUUID')=predecessor.source_instance_id
          AND json_extract(destination.value,'$.applicationUUID')=predecessor.application_id
          AND json_extract(destination.value,'$.historyEpoch')=predecessor.history_epoch_id
          AND json_extract(destination.value,'$.origin')=predecessor.destination_origin
          AND json_extract(destination.value,'$.externalCanonicalId')=organization_mapping.external_id)
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox later WHERE later.client_record_id=predecessor.client_record_id
        AND later.source_id=predecessor.source_id AND later.source_instance_id=predecessor.source_instance_id
        AND later.application_id=predecessor.application_id AND later.history_epoch_id=predecessor.history_epoch_id
        AND (later.relationship_version>predecessor.relationship_version OR later.created_at>predecessor.created_at))
    LIMIT 2`).bind(record, source).all<Discovery>();
  return rows.results.length === 1 ? rows.results[0] ?? null : null;
}
async function seal(row: Review, predecessor: Discovery): Promise<string> {
  return hash(JSON.stringify([REVIEW_COLUMNS.filter(key => key !== "evidence_sha256" && key !== "state")
    .map(key => [key, row[key]]), predecessor.command_json, predecessor.request_json]));
}
function insert(db: D1Database, table: string, values: Readonly<Record<string, SqlValue>>): D1PreparedStatement {
  // table and columns are internal literals, never sourced from an HTTP payload.
  const keys = Object.keys(values);
  return db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
    .bind(...keys.map(key => values[key]));
}
function reviewResponse(row: Review) {
  return { reviewId: row.review_id, recordId: row.client_record_id, sourceId: row.source_id,
    predecessorCommandId: row.predecessor_command_id, evidenceSha256: row.evidence_sha256,
    clientRevision: row.expected_client_revision, organizationRevision: row.expected_organization_revision,
    organizationRecordId: row.intended_organization_record_id, remoteParentPublicId: null,
    observedAuthorizationGeneration: row.observed_authorization_generation, expiresAt: row.expires_at } as const;
}

export async function createDirectoryRelationshipRecoveryReview(env: DirectoryRelationshipRecoveryEnvironment,
  input: Readonly<{ recordId: string; sourceId: string }>, actor: Actor, send: typeof fetch = fetch):
  Promise<{ status: "review"; review: ReturnType<typeof reviewResponse> } | Failure> {
  if (env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true") return { status: "blocked", reason: "disabled" };
  if (!recordId(input.recordId) || !SOURCE.test(input.sourceId) || !actorFresh(actor)) return { status: "blocked", reason: "authority" };
  const configuration = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  try {
    if (!await currentDirectoryRelationshipRecoveryAdministrator(env.OPS_DB, actor)) return { status: "blocked", reason: "authority" };
    const predecessor = await discover(env.OPS_DB, input.recordId, input.sourceId);
    if (!predecessor || !configured(env, predecessor)) return { status: "blocked", reason: "not_eligible" };
    const selected = await selectGrants(env.OPS_DB, actor, input.recordId, predecessor.organization_record_id);
    if (!selected) return { status: "blocked", reason: "authority" };
    const command: unknown = parseDuplicateFreeJson(predecessor.command_json);
    if (!isProjectAlphaDirectoryRelationshipCommand("assign", command) || command.commandId !== predecessor.command_id
      || JSON.stringify(command) !== predecessor.command_json) return { status: "blocked", reason: "not_eligible" };
    // This network boundary may only replay the exact already-terminal request.
    const collected = await collectDirectoryRelationshipGenerationRecoveryEvidence({ PROJECT_ALPHA_API_V2_CONNECTIONS: configuration }, {
      sourceId: input.sourceId, clientExternalId: predecessor.client_external_id, clientPublicId: predecessor.client_public_id,
      targetOrganizationExternalId: predecessor.organization_external_id, targetOrganizationPublicId: predecessor.organization_public_id,
      predecessorCommandJson: predecessor.command_json, successorCommandId: crypto.randomUUID(),
    }, send);
    if (collected.status !== "observed") return collected;
    if (env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true"
      || env.PROJECT_ALPHA_API_V2_CONNECTIONS !== configuration) return { status: "blocked", reason: "configuration" };
    const current = await discover(env.OPS_DB, input.recordId, input.sourceId);
    const currentGrants = await selectGrants(env.OPS_DB, actor, input.recordId, predecessor.organization_record_id);
    if (!current || JSON.stringify(current) !== JSON.stringify(predecessor)
      || JSON.stringify(currentGrants) !== JSON.stringify(selected)) return { status: "blocked", reason: "stale" };
    let cursor: string | null = null;
    for (const page of collected.inventoryPagesForRootPersistence) {
      const persisted = await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB, page, cursor);
      if (persisted.status !== "persisted") return { status: "uncertain", reason: "storage" };
      cursor = page.nextCursor;
    }
    const evidence = collected.evidence, created = Date.now();
    const row: Review = { review_id: crypto.randomUUID(), client_record_id: input.recordId, source_id: input.sourceId,
      source_instance_id: predecessor.source_instance_id, application_id: predecessor.application_id,
      history_epoch_id: predecessor.history_epoch_id, destination_origin: predecessor.destination_origin,
      predecessor_command_id: predecessor.command_id, root_command_id: predecessor.command_id,
      relationship_version: predecessor.relationship_version, action: "assign", local_previous_organization_record_id: null,
      intended_organization_record_id: predecessor.organization_record_id, client_record_version: predecessor.client_record_version,
      organization_record_version: predecessor.organization_record_version, client_external_id: predecessor.client_external_id,
      client_public_id: predecessor.client_public_id, organization_external_id: predecessor.organization_external_id,
      organization_public_id: predecessor.organization_public_id, expected_client_revision: predecessor.expected_client_revision,
      expected_organization_revision: predecessor.expected_organization_revision, remote_client_revision: evidence.clientRevision,
      remote_parent_public_id: null, target_binding_active: 1, target_binding_revision: evidence.targetOrganizationRevision,
      observed_authorization_generation: evidence.observedAuthorizationGeneration,
      client_inventory_request_id: evidence.readRequestIds.clientInventory, organization_inventory_request_id: evidence.readRequestIds.organizationInventory,
      replay_request_path: evidence.replayRequestPath, replay_conflict_json: evidence.replayConflictJson,
      replay_request_sha256: await hash(predecessor.command_json), replay_conflict_sha256: await hash(evidence.replayConflictJson),
      evidence_sha256: "", reviewer_staff_id: actor.staffId, reviewer_access_subject: actor.accessSubject, reviewer_email: actor.email,
      reviewer_admission_version: actor.admissionVersion, reviewer_profile_version: actor.profileVersion,
      selected_grants_json: JSON.stringify(selected), created_at: new Date(created).toISOString(),
      expires_at: new Date(Math.min(created + 5 * 60_000, Date.parse(actor.verifiedUntil))).toISOString(), state: "open" };
    row.evidence_sha256 = await seal(row, predecessor);
    if (!actorFresh(actor) || Date.parse(row.expires_at) <= Date.now()
      || env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true"
      || env.PROJECT_ALPHA_API_V2_CONNECTIONS !== configuration) return { status: "blocked", reason: "stale" };
    const finalGrants = await selectGrants(env.OPS_DB, actor, input.recordId, predecessor.organization_record_id);
    if (JSON.stringify(finalGrants) !== row.selected_grants_json) return { status: "blocked", reason: "authority" };
    await insert(env.OPS_DB, "project_alpha_directory_relationship_generation_recovery_reviews", row).run();
    return { status: "review", review: reviewResponse(row) };
  } catch { return { status: "uncertain", reason: "storage_or_contract" }; }
}

type AuthorizationInput = Readonly<{ recordId: string; reviewId: string; evidenceSha256: string;
  authorizationId: string; successorCommandId: string; reason: string }>;
type Prepared = { status: "prepared"; successorCommandId: string; generation: string; replayed: boolean };
type AuthorizationOutcome = Prepared | Failure | { status: "conflict"; reason: string };

export async function authorizeDirectoryRelationshipRecoveryReview(env: DirectoryRelationshipRecoveryEnvironment,
  input: AuthorizationInput, actor: Actor): Promise<AuthorizationOutcome> {
  if (env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true") return { status: "blocked", reason: "disabled" };
  if (!recordId(input.recordId) || !UUID.test(input.reviewId) || !UUID.test(input.authorizationId)
    || !UUID.test(input.successorCommandId) || !/^[a-f0-9]{64}$/.test(input.evidenceSha256)
    || !input.reason.trim() || input.reason !== input.reason.trim() || input.reason.length > 500 || /\p{C}/u.test(input.reason)
    || !actorFresh(actor)) return { status: "blocked", reason: "authority" };
  const configuration = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  try {
    if (!await currentDirectoryRelationshipRecoveryAdministrator(env.OPS_DB, actor)) return { status: "blocked", reason: "authority" };
    const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT ${REVIEW_COLUMNS.join(",")}
      FROM project_alpha_directory_relationship_generation_recovery_reviews WHERE review_id=? AND client_record_id=?`)
      .bind(input.reviewId, input.recordId).first<Review>();
    if (!row || row.evidence_sha256 !== input.evidenceSha256 || row.reviewer_staff_id !== actor.staffId
      || row.reviewer_access_subject !== actor.accessSubject || row.reviewer_email !== actor.email
      || row.reviewer_admission_version !== actor.admissionVersion || row.reviewer_profile_version !== actor.profileVersion)
      return { status: "blocked", reason: "authority" };
    const selected = await selectGrants(env.OPS_DB, actor, row.client_record_id, row.intended_organization_record_id);
    if (!selected || JSON.stringify(selected) !== row.selected_grants_json) return { status: "blocked", reason: "authority" };
    const connection = resolveProjectAlphaApiV2Connection(env, row.source_id);
    if (!connection.enabled || connection.connection.expectedSourceInstanceId !== row.source_instance_id
      || connection.connection.expectedApplicationId !== row.application_id
      || connection.connection.expectedHistoryEpoch !== row.history_epoch_id
      || new URL(connection.connection.baseUrl).origin !== row.destination_origin)
      return { status: "blocked", reason: "configuration" };
    const prior = await env.OPS_DB.withSession("first-primary").prepare(`SELECT authorization_id,successor_command_id,review_id,
      evidence_sha256,reason,observed_authorization_generation FROM project_alpha_directory_relationship_generation_recoveries WHERE authorization_id=?`)
      .bind(input.authorizationId).first<{ authorization_id: string; successor_command_id: string; review_id: string;
        evidence_sha256: string; reason: string; observed_authorization_generation: string }>();
    if (prior) return prior.review_id === input.reviewId && prior.evidence_sha256 === input.evidenceSha256
      && prior.successor_command_id === input.successorCommandId && prior.reason === input.reason
      ? { status: "prepared", successorCommandId: prior.successor_command_id, generation: prior.observed_authorization_generation, replayed: true }
      : { status: "conflict", reason: "authorization_id" };
    if (row.state !== "open" || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now())
      return { status: "blocked", reason: "review_expired" };
    const predecessor = await discover(env.OPS_DB, input.recordId, row.source_id);
    if (!predecessor || predecessor.command_id !== row.predecessor_command_id || !configured(env, predecessor)
      || await seal(row, predecessor) !== row.evidence_sha256) return { status: "blocked", reason: "stale" };
    const command: unknown = parseDuplicateFreeJson(predecessor.command_json);
    if (!isProjectAlphaDirectoryRelationshipCommand("assign", command) || JSON.stringify(command) !== predecessor.command_json
      || command.commandId === input.successorCommandId) return { status: "blocked", reason: "not_eligible" };
    const successor = { ...command, commandId: input.successorCommandId, expectedAuthorizationGeneration: row.observed_authorization_generation };
    if (!isProjectAlphaDirectoryRelationshipCommand("assign", successor)) return { status: "blocked", reason: "not_eligible" };
    const successorJson = JSON.stringify(successor), authorized = new Date().toISOString();
    if (!actorFresh(actor) || env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true"
      || env.PROJECT_ALPHA_API_V2_CONNECTIONS !== configuration) return { status: "blocked", reason: "stale" };
    const ledger = { authorization_id: input.authorizationId, successor_command_id: input.successorCommandId,
      predecessor_command_id: row.predecessor_command_id, root_command_id: row.root_command_id, review_id: row.review_id,
      recovery_depth: 1, client_record_id: row.client_record_id, relationship_version: row.relationship_version,
      source_id: row.source_id, source_instance_id: row.source_instance_id, application_id: row.application_id,
      history_epoch_id: row.history_epoch_id, destination_origin: row.destination_origin,
      observed_authorization_generation: row.observed_authorization_generation, evidence_sha256: row.evidence_sha256,
      predecessor_command_json: predecessor.command_json, predecessor_outcome_sha256: row.replay_conflict_sha256,
      successor_command_json: successorJson, successor_request_json: predecessor.request_json, reason: input.reason,
      actor_staff_id: actor.staffId, actor_access_subject: actor.accessSubject, actor_email: actor.email,
      actor_admission_version: actor.admissionVersion, actor_profile_version: actor.profileVersion,
      selected_grants_json: row.selected_grants_json, authorized_at: authorized, expires_at: row.expires_at };
    const outbox = { command_id: input.successorCommandId, authorization_id: input.authorizationId,
      predecessor_command_id: row.predecessor_command_id, source_id: row.source_id, source_instance_id: row.source_instance_id,
      application_id: row.application_id, history_epoch_id: row.history_epoch_id, destination_origin: row.destination_origin,
      client_record_id: row.client_record_id, relationship_version: row.relationship_version, client_public_id: row.client_public_id,
      action: "assign", expected_client_revision: row.expected_client_revision,
      expected_authorization_generation: row.observed_authorization_generation, expected_current_organization_public_id: null,
      organization_record_id: row.intended_organization_record_id, organization_public_id: row.organization_public_id,
      expected_organization_revision: row.expected_organization_revision, command_json: successorJson, request_json: predecessor.request_json,
      state: "pending", attempts: 0, next_attempt_at: Date.now(), created_at: authorized, updated_at: authorized };
    // Deferred foreign keys require all three writes at COMMIT. A post-batch
    // affected-row check alone would not protect against a partial reservation.
    await env.OPS_DB.batch([insert(env.OPS_DB, "project_alpha_directory_relationship_generation_recoveries", ledger),
      insert(env.OPS_DB, "project_alpha_directory_relationship_recovery_outbox", outbox),
      env.OPS_DB.prepare(`UPDATE project_alpha_directory_relationship_generation_recovery_reviews SET state='authorized'
        WHERE review_id=? AND state='open' AND evidence_sha256=?`).bind(row.review_id, row.evidence_sha256)]);
    return { status: "prepared", successorCommandId: input.successorCommandId, generation: row.observed_authorization_generation, replayed: false };
  } catch { return { status: "uncertain", reason: "storage_or_state_changed" }; }
}
