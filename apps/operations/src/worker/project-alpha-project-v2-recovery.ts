import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

export type ProjectAlphaProjectV2RecoveryEnvironment = Readonly<{
  OPS_DB: D1Database;
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
}>;

export type ProjectAlphaProjectV2RecoveryActor = Readonly<{
  staffId: string;
  accessSubject: string;
  email: string;
  admissionVersion: number;
  profileVersion: number;
  verifiedUntil: string;
}>;

export type ProjectAlphaProjectV2RecoveryRequest = Readonly<{
  authorizationId: string;
  commandId: string;
  sourceId: string;
  expectedApplicationId: string;
  expectedEventVersion: number;
  reason: string;
}>;

export type ProjectAlphaProjectV2RecoveryPreparationOutcome =
  | Readonly<{ status: "prepared"; authorizationId: string; commandId: string; sourceId: string;
    uncertainEventVersion: number; replayed: boolean }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "stale" | "live_lease" | "successful" | "settled" }>
  | Readonly<{ status: "conflict"; reason: "authorization_id" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

type Operation = "create" | "update" | "bind";
type Eligibility = "terminal_uncertain" | "expired_lease_lost_ack";

type Snapshot = Readonly<{
  command_id: string;
  operation: Operation;
  external_project_id: string;
  source_id: string;
  application_id: string;
  destination_base_url: string;
  expected_source_instance_id: string;
  expected_history_epoch_id: string;
  state: string;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  outcome_json: string | null;
  request_sha256: string;
  expected_local_version: number;
  expected_local_projection_sha256: string | null;
  expected_mapping_state: "absent" | "exact";
  expected_project_alpha_public_id: string | null;
  original_actor_staff_id: string;
  original_actor_access_subject: string;
  original_actor_email: string;
  original_actor_admission_version: number;
  original_actor_profile_version: number;
  original_grant_generation: number;
  original_scopes_json: string;
  latest_event_version: number;
  latest_event_state: string;
  success_receipt_count: number;
  settlement_count: number;
}>;

type Existing = Readonly<{
  authorization_id: string;
  command_id: string;
  original_event_state_version: number;
  eligibility_state: Eligibility;
  source_id: string;
  application_id: string;
  actor_staff_id: string;
  actor_access_subject: string;
  actor_email: string;
  actor_admission_version: number;
  actor_profile_version: number;
  reason: string;
  live: number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactActor(row: Pick<Existing, "actor_staff_id" | "actor_access_subject" | "actor_email" |
  "actor_admission_version" | "actor_profile_version">, actor: ProjectAlphaProjectV2RecoveryActor): boolean {
  return row.actor_staff_id === actor.staffId && row.actor_access_subject === actor.accessSubject
    && row.actor_email === actor.email && row.actor_admission_version === actor.admissionVersion
    && row.actor_profile_version === actor.profileVersion;
}

function destinationOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

async function existingAuthorization(db: D1Database, authorizationId: string): Promise<Existing | null> {
  return db.prepare(`SELECT authorization.authorization_id,authorization.command_id,
      authorization.original_event_state_version,authorization.eligibility_state,authorization.source_id,
      authorization.application_id,authorization.actor_staff_id,authorization.actor_access_subject,
      authorization.actor_email,authorization.actor_admission_version,authorization.actor_profile_version,
      authorization.reason,CASE WHEN live.authorization_id IS NULL THEN 0 ELSE 1 END live
    FROM project_alpha_project_v2_recovery_authorizations authorization
    LEFT JOIN project_alpha_project_v2_live_recovery_authorizations live
      ON live.authorization_id=authorization.authorization_id
    WHERE authorization.authorization_id=?`).bind(authorizationId).first<Existing>();
}

function replay(existing: Existing, input: ProjectAlphaProjectV2RecoveryRequest,
  actor: ProjectAlphaProjectV2RecoveryActor): ProjectAlphaProjectV2RecoveryPreparationOutcome | null {
  const expectedVersionMatches = input.expectedEventVersion === existing.original_event_state_version
    || (existing.eligibility_state === "expired_lease_lost_ack"
      && input.expectedEventVersion === existing.original_event_state_version - 1);
  if (existing.command_id !== input.commandId || existing.source_id !== input.sourceId
    || existing.application_id !== input.expectedApplicationId || !expectedVersionMatches
    || existing.reason !== input.reason || !exactActor(existing, actor)) return { status: "conflict", reason: "authorization_id" };
  return existing.live === 1 ? { status: "prepared", authorizationId: existing.authorization_id,
    commandId: existing.command_id, sourceId: existing.source_id,
    uncertainEventVersion: existing.original_event_state_version, replayed: true }
    : { status: "blocked", reason: "authority" };
}

async function snapshot(db: D1Database, commandId: string): Promise<Snapshot | null> {
  return db.prepare(`SELECT outbox.command_id,outbox.operation,outbox.external_project_id,outbox.source_id,
      outbox.application_id,outbox.destination_base_url,outbox.expected_source_instance_id,
      outbox.expected_history_epoch_id,outbox.state,outbox.attempts,outbox.lease_token,
      outbox.lease_expires_at,outbox.outcome_json,fingerprint.request_sha256,
      intent.expected_local_version,intent.expected_local_projection_sha256,intent.expected_mapping_state,
      intent.expected_project_alpha_public_id,proof.actor_staff_id original_actor_staff_id,
      proof.actor_access_subject original_actor_access_subject,proof.actor_email original_actor_email,
      proof.actor_admission_version original_actor_admission_version,
      proof.actor_profile_version original_actor_profile_version,
      proof.grant_generation original_grant_generation,proof.scopes_json original_scopes_json,
      (SELECT event.state_version FROM project_alpha_project_v2_events event
        WHERE event.command_id=outbox.command_id ORDER BY event.state_version DESC LIMIT 1) latest_event_version,
      (SELECT event.state FROM project_alpha_project_v2_events event
        WHERE event.command_id=outbox.command_id ORDER BY event.state_version DESC LIMIT 1) latest_event_state,
      (SELECT count(*) FROM project_alpha_project_v2_success_receipts receipt
        WHERE receipt.command_id=outbox.command_id) success_receipt_count,
      (SELECT count(*) FROM project_alpha_project_v2_canonical_settlement_receipts settlement
        WHERE settlement.command_id=outbox.command_id) settlement_count
    FROM project_alpha_project_outbox outbox
    JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
    JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=outbox.command_id
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=outbox.command_id
    JOIN native_project_command_proofs proof ON proof.command_id=outbox.command_id
      AND proof.external_project_id=outbox.external_project_id
    WHERE outbox.command_id=? AND outbox.operation IN ('create','update','bind')`).bind(commandId).first<Snapshot>();
}

async function currentGeneration(db: D1Database, actor: ProjectAlphaProjectV2RecoveryActor): Promise<number | null> {
  const value = await db.prepare(`SELECT generation.generation
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.login_email=? AND profile.version=?`)
    .bind(actor.staffId, actor.accessSubject, actor.admissionVersion, actor.email, actor.profileVersion)
    .first<number>("generation");
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Mints one short-lived authorization for the exact immutable command and
 * atomically reopens only its terminal-uncertain or expired lost-ack state.
 * No command body, destination, scope, or PA receipt is accepted from HTTP.
 */
export async function prepareProjectAlphaProjectV2Recovery(
  env: ProjectAlphaProjectV2RecoveryEnvironment,
  input: ProjectAlphaProjectV2RecoveryRequest,
  actor: ProjectAlphaProjectV2RecoveryActor,
): Promise<ProjectAlphaProjectV2RecoveryPreparationOutcome> {
  if (!UUID.test(input.authorizationId) || !UUID.test(input.commandId)
    || !Number.isSafeInteger(input.expectedEventVersion) || input.expectedEventVersion < 1
    || input.reason.length < 1 || input.reason.length > 500
    || !Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now())
    return { status: "blocked", reason: "authority" };

  let selected: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { selected = resolveProjectAlphaApiV2Connection(env, input.sourceId); }
  catch { return { status: "blocked", reason: "configuration" }; }
  if (!selected.enabled || selected.connection.expectedApplicationId !== input.expectedApplicationId)
    return { status: "blocked", reason: "configuration" };

  try {
    const prior = await existingAuthorization(env.OPS_DB, input.authorizationId);
    if (prior) return replay(prior, input, actor)!;

    const source = await snapshot(env.OPS_DB, input.commandId);
    if (!source) return { status: "blocked", reason: "stale" };
    if (source.success_receipt_count > 0) return { status: "blocked", reason: "successful" };
    if (source.settlement_count > 0) return { status: "blocked", reason: "settled" };
    if (source.source_id !== input.sourceId || source.application_id !== input.expectedApplicationId
      || source.expected_source_instance_id !== selected.connection.expectedSourceInstanceId
      || source.expected_history_epoch_id !== selected.connection.expectedHistoryEpoch
      || destinationOrigin(source.destination_base_url) !== destinationOrigin(selected.connection.baseUrl))
      return { status: "blocked", reason: "configuration" };
    // The post-ack settlement proof is deliberately bound to the immutable
    // command actor.  Until a separately reviewed manager-through-receipt
    // ledger exists, allowing a different manager here could issue the PA
    // POST and then strand its acknowledgement because settlement could not
    // be authorized.  Fail before reopening the outbox or dispatching.
    if (source.original_actor_staff_id !== actor.staffId
      || source.original_actor_access_subject !== actor.accessSubject
      || source.original_actor_email !== actor.email
      || source.original_actor_admission_version !== actor.admissionVersion
      || source.original_actor_profile_version !== actor.profileVersion)
      return { status: "blocked", reason: "authority" };
    const generation = await currentGeneration(env.OPS_DB, actor);
    if (generation === null) return { status: "blocked", reason: "authority" };

    let eligibility: Eligibility, uncertainEventVersion: number, appendUncertain = false;
    if (source.state === "terminal" && source.latest_event_state === "uncertain") {
      eligibility = "terminal_uncertain";
      uncertainEventVersion = source.latest_event_version;
    } else if (source.state === "leased") {
      if (source.lease_expires_at === null || source.lease_expires_at > Math.floor(Date.now() / 1000))
        return { status: "blocked", reason: "live_lease" };
      eligibility = "expired_lease_lost_ack";
      if (source.latest_event_state === "pending") {
        appendUncertain = true;
        uncertainEventVersion = source.latest_event_version + 1;
      } else if (source.latest_event_state === "uncertain") uncertainEventVersion = source.latest_event_version;
      else return { status: "blocked", reason: "stale" };
    } else return { status: "blocked", reason: "stale" };
    if (source.latest_event_version !== input.expectedEventVersion)
      return { status: "blocked", reason: "stale" };

    const origin = destinationOrigin(source.destination_base_url);
    if (!origin) return { status: "blocked", reason: "configuration" };
    const expiresAt = new Date(Math.min(Date.now() + 10 * 60_000, Date.parse(actor.verifiedUntil))).toISOString();
    const statements: D1PreparedStatement[] = [];
    if (appendUncertain) statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_events(
      command_id,state_version,transition_id,request_sha256,state) VALUES(?,?,?,?,'uncertain')`)
      .bind(source.command_id, uncertainEventVersion, crypto.randomUUID(), source.request_sha256));
    statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_recovery_authorizations(
      authorization_id,command_id,original_event_state_version,eligibility_state,original_outbox_state,
      original_attempts,original_lease_token,original_lease_expires_at,original_outcome_json,
      request_sha256,operation,external_project_id,source_id,source_instance_id,application_id,history_epoch_id,
      destination_origin,expected_local_version,expected_local_projection_sha256,expected_mapping_state,
      expected_project_alpha_public_id,original_actor_staff_id,original_actor_access_subject,
      original_actor_email,original_actor_admission_version,original_actor_profile_version,
      original_actor_project_grant_generation,original_actor_scopes_json,
      actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,
      actor_project_grant_generation,actor_scopes_json,reason,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      input.authorizationId, source.command_id, uncertainEventVersion, eligibility, source.state,
      source.attempts, source.lease_token, source.lease_expires_at, source.outcome_json,
      source.request_sha256, source.operation, source.external_project_id, source.source_id,
      source.expected_source_instance_id, source.application_id, source.expected_history_epoch_id, origin,
      source.expected_local_version, source.expected_local_projection_sha256, source.expected_mapping_state,
      source.expected_project_alpha_public_id, source.original_actor_staff_id,
      source.original_actor_access_subject, source.original_actor_email, source.original_actor_admission_version,
      source.original_actor_profile_version, source.original_grant_generation, source.original_scopes_json,
      actor.staffId, actor.accessSubject, actor.email, actor.admissionVersion, actor.profileVersion,
      generation, source.original_scopes_json, input.reason, expiresAt));
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_events(
        command_id,state_version,transition_id,request_sha256,state) VALUES(?,?,?,?,'pending')`)
        .bind(source.command_id, uncertainEventVersion + 1, crypto.randomUUID(), source.request_sha256),
      env.OPS_DB.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,
        lease_expires_at=NULL,outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=?`).bind(source.command_id),
    );
    await env.OPS_DB.batch(statements);
    return { status: "prepared", authorizationId: input.authorizationId, commandId: source.command_id,
      sourceId: source.source_id, uncertainEventVersion, replayed: false };
  } catch {
    try {
      const prior = await existingAuthorization(env.OPS_DB, input.authorizationId);
      if (prior) return replay(prior, input, actor)!;
    } catch { /* Preserve the original unknown database outcome. */ }
    return { status: "uncertain", reason: "database" };
  }
}
