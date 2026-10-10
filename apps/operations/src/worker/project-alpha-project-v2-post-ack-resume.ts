import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaProjectV2RecoveryActor } from "./project-alpha-project-v2-recovery";

export type ProjectAlphaProjectV2PostAckEnvironment = Readonly<{
  OPS_DB: D1Database;
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
}>;

export type ProjectAlphaProjectV2PostAckRequest = Readonly<{
  authorizationId: string;
  commandId: string;
  sourceId: string;
  expectedApplicationId: string;
  reason: string;
  /** Present only when /recover is retrying the original uncertain request. */
  expectedRecoveryEventVersion?: number;
}>;

export type ProjectAlphaProjectV2PostAckOutcome =
  | Readonly<{ status: "prepared"; authorizationId: string; commandId: string; sourceId: string;
    successReceiptId: string; settlementId: string | null; replayed: boolean }>
  | Readonly<{ status: "activated"; activationId: string; settlementId: string; commandId: string;
    externalProjectId: string; version: number; replayed: true }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "stale" | "live_authorization" | "activated" }>
  | Readonly<{ status: "conflict"; reason: "authorization_id" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

type Snapshot = Readonly<{
  success_receipt_id: string;
  acknowledgement_id: string;
  command_id: string;
  acknowledged_state_version: number;
  request_sha256: string;
  response_sha256: string;
  operation: "create" | "update" | "bind";
  external_project_id: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  destination_origin: string;
  destination_base_url: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  expected_local_version: number;
  expected_local_projection_sha256: string | null;
  expected_mapping_state: "absent" | "exact";
  expected_project_alpha_public_id: string | null;
  actor_staff_id: string;
  actor_access_subject: string;
  actor_email: string;
  actor_admission_version: number;
  actor_profile_version: number;
  grant_generation: number;
  scopes_json: string;
  outbox_state: string;
  lease_token: string | null;
  lease_expires_at: number | null;
  settlement_id: string | null;
  activation_count: number;
  live_authorization_count: number;
}>;

type Existing = Readonly<{
  authorization_id: string;
  command_id: string;
  source_id: string;
  application_id: string;
  reason: string;
  success_receipt_id: string;
  settlement_id: string | null;
  actor_staff_id: string;
  actor_access_subject: string;
  actor_email: string;
  actor_admission_version: number;
  actor_profile_version: number;
  actor_project_grant_generation: number;
  actor_scopes_json: string;
  external_project_id: string;
  live: number;
  recovery_match: number;
  recovery_event_state_version: number | null;
  recovery_eligibility_state: "terminal_uncertain" | "expired_lease_lost_ack" | null;
  chain_complete: number;
  activation_id: string | null;
  activation_settlement_id: string | null;
  activation_command_id: string | null;
  activation_external_project_id: string | null;
  activation_version: number | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactActor(row: Pick<Snapshot | Existing, "actor_staff_id" | "actor_access_subject" | "actor_email" |
  "actor_admission_version" | "actor_profile_version">, actor: ProjectAlphaProjectV2RecoveryActor): boolean {
  return row.actor_staff_id === actor.staffId && row.actor_access_subject === actor.accessSubject
    && row.actor_email === actor.email && row.actor_admission_version === actor.admissionVersion
    && row.actor_profile_version === actor.profileVersion;
}

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

async function existing(db: D1Database, authorizationId: string): Promise<Existing | null> {
  return db.prepare(`SELECT authorization.authorization_id,authorization.command_id,authorization.source_id,
      authorization.application_id,authorization.reason,authorization.success_receipt_id,
      settlement.settlement_id,authorization.actor_staff_id,authorization.actor_access_subject,
      authorization.actor_email,authorization.actor_admission_version,authorization.actor_profile_version,
      authorization.actor_project_grant_generation,authorization.actor_scopes_json,
      authorization.external_project_id,
      CASE WHEN live.authorization_id IS NULL THEN 0 ELSE 1 END live,
      CASE WHEN recovery.authorization_id IS NOT NULL
        AND recovery.command_id=authorization.command_id
        AND recovery.source_id=authorization.source_id
        AND recovery.application_id=authorization.application_id
        AND recovery.reason=authorization.reason
        AND recovery.actor_staff_id=authorization.actor_staff_id
        AND recovery.actor_access_subject=authorization.actor_access_subject
        AND recovery.actor_email=authorization.actor_email
        AND recovery.actor_admission_version=authorization.actor_admission_version
        AND recovery.actor_profile_version=authorization.actor_profile_version
        AND recovery.actor_project_grant_generation=authorization.actor_project_grant_generation
        AND json(recovery.actor_scopes_json)=json(authorization.actor_scopes_json)
        THEN 1 ELSE 0 END recovery_match,
      recovery.original_event_state_version recovery_event_state_version,
      recovery.eligibility_state recovery_eligibility_state,
      CASE WHEN receipt.receipt_id IS NOT NULL AND acknowledgement.acknowledgement_id IS NOT NULL
        AND fingerprint.command_id IS NOT NULL AND intent.command_id IS NOT NULL
        AND outbox.command_id IS NOT NULL AND proof.command_id IS NOT NULL
        AND settlement.settlement_id IS NOT NULL AND activation.activation_id IS NOT NULL
        THEN 1 ELSE 0 END chain_complete,
      activation.activation_id,activation.settlement_id activation_settlement_id,
      activation.command_id activation_command_id,
      activation.external_project_id activation_external_project_id,
      activation.resulting_local_version activation_version
    FROM project_alpha_project_v2_post_ack_authorizations authorization
    LEFT JOIN project_alpha_project_v2_live_post_ack_authorizations live
      ON live.authorization_id=authorization.authorization_id
    LEFT JOIN project_alpha_project_v2_recovery_authorizations recovery
      ON recovery.authorization_id=authorization.authorization_id
    LEFT JOIN project_alpha_project_v2_success_receipts receipt
      ON receipt.receipt_id=authorization.success_receipt_id
     AND receipt.acknowledgement_id=authorization.acknowledgement_id
     AND receipt.command_id=authorization.command_id
     AND receipt.request_sha256=authorization.request_sha256
     AND receipt.response_sha256=authorization.response_sha256
     AND receipt.source_instance_id=authorization.source_instance_id
     AND receipt.application_id=authorization.application_id
     AND receipt.history_epoch_id=authorization.history_epoch_id
     AND receipt.destination_origin=authorization.destination_origin
     AND receipt.project_alpha_public_id=authorization.project_alpha_public_id
     AND receipt.project_alpha_revision=authorization.project_alpha_revision
     AND receipt.projection_sha256=authorization.projection_sha256
    LEFT JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
      ON acknowledgement.acknowledgement_id=authorization.acknowledgement_id
     AND acknowledgement.command_id=authorization.command_id
     AND acknowledgement.acknowledged_state_version=authorization.acknowledged_state_version
     AND acknowledgement.request_sha256=authorization.request_sha256
     AND acknowledgement.response_sha256=authorization.response_sha256
     AND acknowledgement.source_instance_id=authorization.source_instance_id
     AND acknowledgement.application_id=authorization.application_id
     AND acknowledgement.history_epoch_id=authorization.history_epoch_id
     AND acknowledgement.destination_origin=authorization.destination_origin
     AND acknowledgement.project_alpha_public_id=authorization.project_alpha_public_id
     AND acknowledgement.project_alpha_revision=authorization.project_alpha_revision
     AND acknowledgement.projection_sha256=authorization.projection_sha256
    LEFT JOIN project_alpha_project_v2_request_fingerprints fingerprint
      ON fingerprint.command_id=authorization.command_id
     AND fingerprint.request_sha256=authorization.request_sha256
    LEFT JOIN project_alpha_project_v2_canonical_intents intent
      ON intent.command_id=authorization.command_id
     AND intent.request_sha256=authorization.request_sha256
     AND intent.operation=authorization.operation
     AND intent.external_project_id=authorization.external_project_id
     AND intent.source_id=authorization.source_id
     AND intent.source_instance_id=authorization.source_instance_id
     AND intent.application_id=authorization.application_id
     AND intent.history_epoch_id=authorization.history_epoch_id
     AND intent.expected_local_version=authorization.expected_local_version
     AND intent.expected_local_projection_sha256 IS authorization.expected_local_projection_sha256
     AND intent.expected_mapping_state=authorization.expected_mapping_state
     AND intent.expected_project_alpha_public_id IS authorization.expected_project_alpha_public_id
     AND intent.expected_grant_generation=authorization.actor_project_grant_generation
    LEFT JOIN project_alpha_project_outbox outbox
      ON outbox.command_id=authorization.command_id
     AND outbox.operation=authorization.operation
     AND outbox.external_project_id=authorization.external_project_id
     AND outbox.source_id=authorization.source_id
     AND outbox.expected_source_instance_id=authorization.source_instance_id
     AND outbox.application_id=authorization.application_id
     AND outbox.expected_history_epoch_id=authorization.history_epoch_id
     AND rtrim(outbox.destination_base_url,'/')=authorization.destination_origin
    LEFT JOIN native_project_command_proofs proof
      ON proof.command_id=authorization.command_id
     AND proof.external_project_id=authorization.external_project_id
     AND proof.actor_staff_id=authorization.actor_staff_id
     AND proof.actor_access_subject=authorization.actor_access_subject
     AND proof.actor_admission_version=authorization.actor_admission_version
     AND proof.actor_profile_version=authorization.actor_profile_version
     AND proof.actor_email=authorization.actor_email
     AND proof.grant_generation=authorization.actor_project_grant_generation
     AND json(proof.scopes_json)=json(authorization.actor_scopes_json)
    LEFT JOIN project_alpha_project_v2_canonical_settlement_receipts settlement
      ON settlement.success_receipt_id=authorization.success_receipt_id
     AND settlement.command_id=authorization.command_id
     AND settlement.operation=authorization.operation
     AND settlement.external_project_id=authorization.external_project_id
     AND settlement.source_id=authorization.source_id
     AND settlement.source_instance_id=authorization.source_instance_id
     AND settlement.application_id=authorization.application_id
     AND settlement.history_epoch_id=authorization.history_epoch_id
     AND settlement.project_alpha_public_id=authorization.project_alpha_public_id
     AND settlement.project_alpha_revision=authorization.project_alpha_revision
     AND settlement.projection_sha256=authorization.projection_sha256
    LEFT JOIN project_alpha_project_v2_canonical_activation_receipts activation
      ON activation.settlement_id=settlement.settlement_id
     AND activation.command_id=authorization.command_id
     AND activation.operation=authorization.operation
     AND activation.external_project_id=authorization.external_project_id
     AND activation.prior_local_version=authorization.expected_local_version
     AND activation.resulting_local_version=authorization.expected_local_version+1
    WHERE authorization.authorization_id=?`).bind(authorizationId).first<Existing>();
}

async function currentReplayAuthority(db: D1Database, value: Existing): Promise<boolean> {
  const current = await db.prepare(`SELECT 1 current_authority
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.login_email=? AND profile.version=? AND generation.generation=?
      AND EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.permission_key='integrations.manage'
          AND permission.effect='allow' AND permission.scope='global')
      AND NOT EXISTS (SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.permission_key='integrations.manage'
          AND permission.effect='deny' AND permission.scope='global')
      AND NOT EXISTS (SELECT 1 FROM json_each(?) scope
        WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
          WHERE grant_row.staff_id=admission.staff_id AND grant_row.capability='project.shared.sync'
            AND grant_row.effect='allow' AND grant_row.active=1
            AND (grant_row.scope_kind='global'
              OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=?)
              OR (grant_row.scope_kind='business_area'
                AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
              OR (grant_row.scope_kind='division'
                AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
      AND (json_array_length(?)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
        WHERE grant_row.staff_id=admission.staff_id AND grant_row.capability='project.shared.sync'
          AND grant_row.effect='allow' AND grant_row.active=1
          AND (grant_row.scope_kind='global'
            OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=?))))
      AND NOT EXISTS (SELECT 1 FROM native_project_grants denied
        WHERE denied.staff_id=admission.staff_id AND denied.capability='project.shared.sync'
          AND denied.effect='deny' AND denied.active=1
          AND (denied.scope_kind='global'
            OR (denied.scope_kind='exact_project' AND denied.external_project_id=?)
            OR EXISTS (SELECT 1 FROM json_each(?) scope
              WHERE (denied.scope_kind='business_area'
                  AND denied.business_area_id=json_extract(scope.value,'$.businessAreaId'))
                OR (denied.scope_kind='division'
                  AND denied.division_id=json_extract(scope.value,'$.divisionId')))))`)
    .bind(value.actor_staff_id, value.actor_access_subject, value.actor_admission_version,
      value.actor_email, value.actor_profile_version, value.actor_project_grant_generation,
      value.actor_scopes_json, value.external_project_id, value.actor_scopes_json,
      value.external_project_id, value.external_project_id, value.actor_scopes_json)
    .first("current_authority");
  return current === 1;
}

async function replay(db: D1Database, value: Existing, input: ProjectAlphaProjectV2PostAckRequest,
  actor: ProjectAlphaProjectV2RecoveryActor): Promise<ProjectAlphaProjectV2PostAckOutcome> {
  if (value.command_id !== input.commandId || value.source_id !== input.sourceId
    || value.application_id !== input.expectedApplicationId || value.reason !== input.reason
    || !exactActor(value, actor)) return { status: "conflict", reason: "authorization_id" };
  if (input.expectedRecoveryEventVersion !== undefined) {
    const versionMatches = input.expectedRecoveryEventVersion === value.recovery_event_state_version
      || (value.recovery_eligibility_state === "expired_lease_lost_ack"
        && input.expectedRecoveryEventVersion === (value.recovery_event_state_version ?? 0) - 1);
    if (value.recovery_match !== 1 || !versionMatches)
      return { status: "conflict", reason: "authorization_id" };
  }
  if (value.activation_id !== null && value.activation_settlement_id !== null
    && value.activation_command_id === value.command_id && value.activation_external_project_id !== null
    && value.activation_version !== null) {
    if (value.chain_complete !== 1) return { status: "blocked", reason: "stale" };
    if (!await currentReplayAuthority(db, value)) return { status: "blocked", reason: "authority" };
    return { status: "activated", activationId: value.activation_id,
      settlementId: value.activation_settlement_id, commandId: value.activation_command_id,
      externalProjectId: value.activation_external_project_id, version: value.activation_version,
      replayed: true };
  }
  return value.live === 1 ? { status: "prepared", authorizationId: value.authorization_id,
    commandId: value.command_id, sourceId: value.source_id, successReceiptId: value.success_receipt_id,
    settlementId: value.settlement_id, replayed: true } : { status: "blocked", reason: "authority" };
}

async function snapshot(db: D1Database, commandId: string): Promise<Snapshot | null> {
  return db.prepare(`SELECT receipt.receipt_id success_receipt_id,receipt.acknowledgement_id,
      receipt.command_id,acknowledgement.acknowledged_state_version,receipt.request_sha256,
      receipt.response_sha256,outbox.operation,outbox.external_project_id,outbox.source_id,
      receipt.source_instance_id,receipt.application_id,receipt.history_epoch_id,receipt.destination_origin,
      outbox.destination_base_url,receipt.project_alpha_public_id,receipt.project_alpha_revision,
      receipt.projection_sha256,intent.expected_local_version,intent.expected_local_projection_sha256,
      intent.expected_mapping_state,intent.expected_project_alpha_public_id,
      proof.actor_staff_id,proof.actor_access_subject,proof.actor_email,proof.actor_admission_version,
      proof.actor_profile_version,proof.grant_generation,proof.scopes_json,outbox.state outbox_state,
      outbox.lease_token,outbox.lease_expires_at,settlement.settlement_id,
      (SELECT count(*) FROM project_alpha_project_v2_canonical_activation_receipts activation
        WHERE activation.command_id=receipt.command_id) activation_count,
      (SELECT count(*) FROM project_alpha_project_v2_live_post_ack_authorizations authorization
        WHERE authorization.success_receipt_id=receipt.receipt_id) live_authorization_count
    FROM project_alpha_project_v2_success_receipts receipt
    JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
      ON acknowledgement.acknowledgement_id=receipt.acknowledgement_id
     AND acknowledgement.command_id=receipt.command_id
     AND acknowledgement.response_sha256=receipt.response_sha256
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=receipt.command_id
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=receipt.command_id
    JOIN native_project_command_proofs proof ON proof.command_id=receipt.command_id
      AND proof.external_project_id=outbox.external_project_id
    LEFT JOIN project_alpha_project_v2_canonical_settlement_receipts settlement
      ON settlement.success_receipt_id=receipt.receipt_id
    WHERE receipt.command_id=? AND outbox.operation IN ('create','update','bind')`)
    .bind(commandId).first<Snapshot>();
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
 * Issues a short-lived, receipt-bound authority for private GET settlement and
 * local activation only.  It does not mutate the outbox or event chain and its
 * proof is intentionally invisible to every command producer and dispatcher.
 */
export async function prepareProjectAlphaProjectV2PostAckResume(
  env: ProjectAlphaProjectV2PostAckEnvironment,
  input: ProjectAlphaProjectV2PostAckRequest,
  actor: ProjectAlphaProjectV2RecoveryActor,
): Promise<ProjectAlphaProjectV2PostAckOutcome> {
  if (!UUID.test(input.authorizationId) || !UUID.test(input.commandId)
    || (input.expectedRecoveryEventVersion !== undefined
      && (!Number.isSafeInteger(input.expectedRecoveryEventVersion) || input.expectedRecoveryEventVersion < 1))
    || input.reason.length < 1 || input.reason.length > 500
    || !Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now())
    return { status: "blocked", reason: "authority" };

  let selected: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { selected = resolveProjectAlphaApiV2Connection(env, input.sourceId); }
  catch { return { status: "blocked", reason: "configuration" }; }
  if (!selected.enabled || selected.connection.expectedApplicationId !== input.expectedApplicationId)
    return { status: "blocked", reason: "configuration" };

  try {
    const prior = await existing(env.OPS_DB, input.authorizationId);
    if (prior) return await replay(env.OPS_DB, prior, input, actor);
    const source = await snapshot(env.OPS_DB, input.commandId);
    if (!source) return { status: "blocked", reason: "stale" };
    if (source.activation_count > 0) return { status: "blocked", reason: "activated" };
    if (source.live_authorization_count > 0) return { status: "blocked", reason: "live_authorization" };
    if (source.source_id !== input.sourceId || source.application_id !== input.expectedApplicationId
      || source.source_instance_id !== selected.connection.expectedSourceInstanceId
      || source.history_epoch_id !== selected.connection.expectedHistoryEpoch
      || origin(source.destination_base_url) !== source.destination_origin
      || origin(selected.connection.baseUrl) !== source.destination_origin)
      return { status: "blocked", reason: "configuration" };
    if (source.outbox_state !== "pending" || source.lease_token !== null || source.lease_expires_at !== null)
      return { status: "blocked", reason: "stale" };
    if (!exactActor(source, actor)) return { status: "blocked", reason: "authority" };
    const generation = await currentGeneration(env.OPS_DB, actor);
    if (generation === null || generation !== source.grant_generation) return { status: "blocked", reason: "authority" };

    const expiresAt = new Date(Math.min(Date.now() + 10 * 60_000, Date.parse(actor.verifiedUntil))).toISOString();
    await env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_post_ack_authorizations(
      authorization_id,success_receipt_id,acknowledgement_id,command_id,acknowledged_state_version,
      request_sha256,response_sha256,operation,external_project_id,source_id,source_instance_id,
      application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,
      projection_sha256,expected_local_version,expected_local_projection_sha256,expected_mapping_state,
      expected_project_alpha_public_id,actor_staff_id,actor_access_subject,actor_email,
      actor_admission_version,actor_profile_version,actor_project_grant_generation,actor_scopes_json,
      reason,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      input.authorizationId, source.success_receipt_id, source.acknowledgement_id, source.command_id,
      source.acknowledged_state_version, source.request_sha256, source.response_sha256, source.operation,
      source.external_project_id, source.source_id, source.source_instance_id, source.application_id,
      source.history_epoch_id, source.destination_origin, source.project_alpha_public_id,
      source.project_alpha_revision, source.projection_sha256, source.expected_local_version,
      source.expected_local_projection_sha256, source.expected_mapping_state,
      source.expected_project_alpha_public_id, actor.staffId, actor.accessSubject, actor.email,
      actor.admissionVersion, actor.profileVersion, generation, source.scopes_json, input.reason, expiresAt,
    ).run();
    return { status: "prepared", authorizationId: input.authorizationId, commandId: source.command_id,
      sourceId: source.source_id, successReceiptId: source.success_receipt_id,
      settlementId: source.settlement_id, replayed: false };
  } catch {
    try {
      const prior = await existing(env.OPS_DB, input.authorizationId);
      if (prior) return await replay(env.OPS_DB, prior, input, actor);
    } catch { /* Preserve the original unknown database outcome. */ }
    return { status: "uncertain", reason: "database" };
  }
}
