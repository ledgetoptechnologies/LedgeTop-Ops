import { withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import {
  activateProjectAlphaProjectV2Canonical,
  type ProjectAlphaProjectCanonicalActivationOutcome,
} from "./project-alpha-project-canonical-activation-adapter";
import {
  settleProjectAlphaProjectV2Read,
  type ProjectAlphaProjectReadSettlementOutcome,
} from "./project-alpha-project-read-settlement-adapter";
import {
  prepareProjectAlphaProjectV2PostAckResume,
  type ProjectAlphaProjectV2PostAckOutcome,
} from "./project-alpha-project-v2-post-ack-resume";
import {
  dispatchProjectAlphaProjectV2PendingCommand,
  type ProjectAlphaProjectV2PendingDispatcherOutcome,
} from "./project-alpha-project-v2-pending-dispatcher";
import { planProjectAlphaProjectAdoptionBind } from "./project-alpha-project-adoption-bind-consumer";

export type ProjectAlphaProjectAdoptionFinalizerEnvironment = Readonly<{
  OPS_DB: D1Database;
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
  PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED?: string;
}>;

export type ProjectAlphaProjectAdoptionFinalizerActor = Readonly<{
  staffId: string;
  accessSubject: string;
  email: string;
  admissionVersion: number;
  profileVersion: number;
  verifiedUntil: string;
}>;

export type ProjectAlphaProjectAdoptionFinalizerInput = Readonly<{
  reservationId: string;
  commandId: string;
}>;

type PreflightOutcome =
  | Readonly<{ status: "rejected"; reason: "invalid_action" | "invalid_actor" }>
  | Readonly<{ status: "blocked"; reason: "disabled" | "missing_bind" | "authority" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;
type ConfigurationOutcome = Readonly<{ status: "blocked"; reason: "configuration" }>;

export type ProjectAlphaProjectAdoptionFinalizationResult =
  | Readonly<{ stage: "preflight"; outcome: PreflightOutcome }>
  | Readonly<{ stage: "dispatch"; outcome: ProjectAlphaProjectV2PendingDispatcherOutcome }>
  | Readonly<{ stage: "authorize_settlement"; outcome: ProjectAlphaProjectV2PostAckOutcome }>
  | Readonly<{ stage: "settle"; outcome: ProjectAlphaProjectReadSettlementOutcome | ConfigurationOutcome }>
  | Readonly<{ stage: "activate"; outcome: ProjectAlphaProjectCanonicalActivationOutcome |
      Extract<ProjectAlphaProjectV2PostAckOutcome, { status: "activated" }> }>;

type Binding = Readonly<{
  bridge_id: string;
  reservation_id: string;
  command_id: string;
  source_id: string;
  application_id: string;
  external_project_id: string;
  reviewer_staff_id: string;
  reviewer_access_subject: string;
  reviewer_admission_version: number;
  reviewer_profile_version: number;
  reviewer_owner_role_id: string;
  project_grant_generation: number;
  normalized_scopes_json: string;
  reviewer_email: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POST_ACK_REASON = "Complete exact Project Alpha adoption";

function plain(value: unknown): value is Record<string, unknown> {
  try {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function action(value: unknown): value is ProjectAlphaProjectAdoptionFinalizerInput {
  if (!plain(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "reservationId") || !Object.hasOwn(value, "commandId")) return false;
  return typeof value.reservationId === "string" && UUID.test(value.reservationId)
    && typeof value.commandId === "string" && UUID.test(value.commandId);
}

function actor(value: unknown): value is ProjectAlphaProjectAdoptionFinalizerActor {
  if (!plain(value) || Object.keys(value).length !== 6
    || !["staffId", "accessSubject", "email", "admissionVersion", "profileVersion", "verifiedUntil"]
      .every(key => Object.hasOwn(value, key))) return false;
  return typeof value.staffId === "string" && value.staffId.length >= 1 && value.staffId.length <= 191
    && typeof value.accessSubject === "string" && value.accessSubject.length >= 1 && value.accessSubject.length <= 764
    && typeof value.email === "string" && value.email.length >= 3 && value.email.length <= 254
    && Number.isSafeInteger(value.admissionVersion) && (value.admissionVersion as number) >= 1
    && Number.isSafeInteger(value.profileVersion) && (value.profileVersion as number) >= 1
    && typeof value.verifiedUntil === "string" && Number.isFinite(Date.parse(value.verifiedUntil))
    && Date.parse(value.verifiedUntil) > Date.now()
    && !/[\u0000-\u001f\u007f]/.test(`${value.staffId}${value.accessSubject}${value.email}`);
}

async function binding(db: D1Database, input: ProjectAlphaProjectAdoptionFinalizerInput): Promise<Binding | null> {
  return db.prepare(`SELECT bridge.bridge_id,bridge.reservation_id,bridge.command_id,reservation.source_id,
      reservation.application_id,reservation.external_project_id,reservation.reviewer_staff_id,
      reservation.reviewer_access_subject,reservation.reviewer_admission_version,
      reservation.reviewer_profile_version,reservation.reviewer_owner_role_id,
      reservation.project_grant_generation,reservation.normalized_scopes_json,
      proof.actor_email reviewer_email
    FROM project_alpha_project_adoption_bind_receipts bridge
    JOIN project_alpha_project_adoption_review_reservations reservation
      ON reservation.reservation_id=bridge.reservation_id
     AND reservation.external_project_id=bridge.external_project_id
     AND reservation.projection_sha256=bridge.local_projection_sha256
    JOIN project_alpha_project_v2_request_fingerprints fingerprint
      ON fingerprint.command_id=bridge.command_id AND fingerprint.request_sha256=bridge.request_sha256
    JOIN project_alpha_project_v2_canonical_intents intent
      ON intent.command_id=bridge.command_id AND intent.request_sha256=bridge.request_sha256
     AND intent.operation='bind' AND intent.external_project_id=reservation.external_project_id
     AND intent.expected_local_version=bridge.local_version
     AND intent.expected_local_projection_sha256=reservation.projection_sha256
     AND intent.expected_grant_generation=reservation.project_grant_generation
     AND intent.expected_mapping_state='absent' AND intent.expected_project_alpha_public_id IS NULL
     AND intent.source_id=reservation.source_id AND intent.source_instance_id=reservation.source_instance_id
     AND intent.application_id=reservation.application_id AND intent.history_epoch_id=reservation.history_epoch_id
    JOIN project_alpha_project_outbox outbox
      ON outbox.command_id=bridge.command_id AND outbox.operation='bind'
     AND outbox.external_project_id=reservation.external_project_id
     AND outbox.source_id=reservation.source_id
     AND outbox.expected_source_instance_id=reservation.source_instance_id
     AND outbox.application_id=reservation.application_id
     AND outbox.expected_history_epoch_id=reservation.history_epoch_id
    JOIN native_project_command_proofs proof
      ON proof.command_id=bridge.command_id AND proof.external_project_id=reservation.external_project_id
     AND proof.actor_staff_id=reservation.reviewer_staff_id
     AND proof.actor_access_subject=reservation.reviewer_access_subject
     AND proof.actor_admission_version=reservation.reviewer_admission_version
     AND proof.actor_profile_version=reservation.reviewer_profile_version
     AND proof.grant_generation=reservation.project_grant_generation
     AND json(proof.scopes_json)=json(reservation.normalized_scopes_json)
    WHERE bridge.reservation_id=? AND bridge.command_id=?`)
    .bind(input.reservationId, input.commandId).first<Binding>();
}

function exactActor(value: Binding, current: ProjectAlphaProjectAdoptionFinalizerActor): boolean {
  return value.reviewer_staff_id === current.staffId
    && value.reviewer_access_subject === current.accessSubject
    && value.reviewer_email === current.email
    && value.reviewer_admission_version === current.admissionVersion
    && value.reviewer_profile_version === current.profileVersion;
}

async function currentAuthority(db: D1Database, value: Binding): Promise<boolean> {
  const found = await db.prepare(`SELECT 1 current_authority
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.login_email=? AND profile.version=? AND generation.generation=?
      AND EXISTS (SELECT 1 FROM staff_role_assignments owner_assignment
        WHERE owner_assignment.staff_id=admission.staff_id AND owner_assignment.role_id=?
          AND owner_assignment.scope='global')
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
    .bind(value.reviewer_staff_id, value.reviewer_access_subject, value.reviewer_admission_version,
      value.reviewer_email, value.reviewer_profile_version, value.project_grant_generation,
      value.reviewer_owner_role_id, value.normalized_scopes_json, value.external_project_id,
      value.normalized_scopes_json, value.external_project_id, value.external_project_id,
      value.normalized_scopes_json).first<number>("current_authority");
  return found === 1;
}

type CurrentOutcome = Readonly<{ status: "blocked"; reason: "authority" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

/**
 * Reuse the bind consumer's durable-replay predicate instead of maintaining a
 * second, weaker copy of its review-expiry, live-proof, active-scope,
 * directory-mapping, and organization/client relationship checks here.
 */
async function current(
  env: ProjectAlphaProjectAdoptionFinalizerEnvironment,
  selected: Binding,
  actorValue: ProjectAlphaProjectAdoptionFinalizerActor,
): Promise<CurrentOutcome | null> {
  let planned: Awaited<ReturnType<typeof planProjectAlphaProjectAdoptionBind>>;
  try {
    planned = await planProjectAlphaProjectAdoptionBind(env, {
      staffId: actorValue.staffId, accessSubject: actorValue.accessSubject,
    }, { reservationId: selected.reservation_id });
  } catch { return { status: "uncertain", reason: "database" }; }
  if (planned.status !== "planned" || !planned.replayed || planned.bridgeId !== selected.bridge_id
    || planned.reservationId !== selected.reservation_id || planned.commandId !== selected.command_id)
    return planned.status === "uncertain" ? { status: "uncertain", reason: "database" }
      : { status: "blocked", reason: "authority" };
  try {
    return await currentAuthority(env.OPS_DB, selected) ? null
      : { status: "blocked", reason: "authority" };
  } catch { return { status: "uncertain", reason: "database" }; }
}

/**
 * Completes one server-created adoption bind plan through the existing v2
 * dispatcher, authenticated canonical read settler, and atomic activator.
 * Caller input cannot select a PA source, application, destination, project,
 * receipt, settlement, or activation: all coordinates come from the immutable
 * reservation/bridge/intent chain. An uncertain dispatch is returned as-is;
 * this function never opens recovery authority or redrives a terminal POST.
 */
export async function finalizeProjectAlphaProjectAdoption(
  env: ProjectAlphaProjectAdoptionFinalizerEnvironment,
  currentActor: unknown,
  input: unknown,
  transport: typeof fetch = fetch,
): Promise<ProjectAlphaProjectAdoptionFinalizationResult> {
  if (env.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED !== "true")
    return { stage: "preflight", outcome: { status: "blocked", reason: "disabled" } };
  if (!actor(currentActor))
    return { stage: "preflight", outcome: { status: "rejected", reason: "invalid_actor" } };
  if (!action(input))
    return { stage: "preflight", outcome: { status: "rejected", reason: "invalid_action" } };

  let selected: Binding | null;
  try { selected = await binding(env.OPS_DB, input); }
  catch { return { stage: "preflight", outcome: { status: "uncertain", reason: "database" } }; }
  if (!selected)
    return { stage: "preflight", outcome: { status: "blocked", reason: "missing_bind" } };
  if (!exactActor(selected, currentActor))
    return { stage: "preflight", outcome: { status: "blocked", reason: "authority" } };
  const preflight = await current(env, selected, currentActor);
  if (preflight) return { stage: "preflight", outcome: preflight };

  const postAckInput = { authorizationId: selected.bridge_id, commandId: selected.command_id,
    sourceId: selected.source_id, expectedApplicationId: selected.application_id, reason: POST_ACK_REASON };
  let prepared = await prepareProjectAlphaProjectV2PostAckResume(env, postAckInput, currentActor);
  if (prepared.status === "activated") {
    const replayAuthority = await current(env, selected, currentActor);
    return replayAuthority ? { stage: "activate", outcome: replayAuthority } : { stage: "activate", outcome: prepared };
  }
  if (prepared.status !== "prepared") {
    if (!(prepared.status === "blocked" && prepared.reason === "stale"))
      return { stage: "authorize_settlement", outcome: prepared };
    const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(
      env, selected.source_id, selected.command_id, transport,
    );
    if (dispatched.status !== "acknowledged") return { stage: "dispatch", outcome: dispatched };
    const dispatchAuthority = await current(env, selected, currentActor);
    if (dispatchAuthority) return { stage: "authorize_settlement", outcome: dispatchAuthority };
    prepared = await prepareProjectAlphaProjectV2PostAckResume(env, postAckInput, currentActor);
    if (prepared.status === "activated") {
      const replayAuthority = await current(env, selected, currentActor);
      return replayAuthority ? { stage: "activate", outcome: replayAuthority } : { stage: "activate", outcome: prepared };
    }
    if (prepared.status !== "prepared") return { stage: "authorize_settlement", outcome: prepared };
  }

  let settlementId = prepared.settlementId;
  if (settlementId === null) {
    const settlementAuthority = await current(env, selected, currentActor);
    if (settlementAuthority) return { stage: "authorize_settlement", outcome: settlementAuthority };
    const successReceiptId = prepared.successReceiptId;
    const settledSelection = await withEnabledConfiguredProjectAlphaApiV2Connection(env, selected.source_id,
      connection => settleProjectAlphaProjectV2Read(env, successReceiptId, connection, transport));
    if (settledSelection.status !== "enabled")
      return { stage: "settle", outcome: { status: "blocked", reason: "configuration" } };
    if (settledSelection.value.status !== "settled")
      return { stage: "settle", outcome: settledSelection.value };
    settlementId = settledSelection.value.settlementId;
  }

  const activationAuthority = await current(env, selected, currentActor);
  if (activationAuthority) return { stage: "activate", outcome: activationAuthority };
  return { stage: "activate", outcome: await activateProjectAlphaProjectV2Canonical(env, settlementId) };
}
