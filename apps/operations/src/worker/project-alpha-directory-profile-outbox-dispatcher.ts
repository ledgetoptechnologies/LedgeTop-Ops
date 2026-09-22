import {
  isProjectAlphaDirectoryCreateCommand,
  isProjectAlphaDirectoryProfileUpdateCommand,
  sendProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryProfileUpdate,
  validatedProjectAlphaDirectoryProfileAcknowledgement,
  type ProjectAlphaDirectoryCreateCommand,
  type ProjectAlphaDirectoryProfileKind,
  type ProjectAlphaDirectoryProfileUpdateCommand,
  type ProjectAlphaDirectoryProfileTransportFailure,
} from "./project-alpha-directory-profile-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

const LEASE_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type Row = Readonly<Record<string, unknown> & {
  command_id: string; source_id: string; application_id: string; resource_type: ProjectAlphaDirectoryProfileKind;
  external_id: string; command_json: string; destination_base_url: string; expected_source_instance_id: string;
  expected_history_epoch_id: string; state: string; attempts: number; next_attempt_at: number; lease_expires_at: number | null;
  intent_id: string; mutation_id: string; record_id: string; record_version: number; source_instance_uuid: string;
  intent_source_id: string; application_uuid: string; destination_origin: string; external_canonical_id: string; desired_payload_json: string;
  intent_history_epoch_id: string; intent_state: string; materialization_command_json: string; origin_snapshot_json: string;
  disposition_json: string; materialization_history_epoch_id: string; audit_actor_id: string; audit_actor_type: string;
  original_verified_access_subject: string; audit_command_json: string; record_kind: string; current_version: number;
  revision_profile_json: string;
}>;
type Actor = Readonly<{ staffId: string; accessSubject: string; admissionVersion: number; selectedGrantId: string;
  loginEmail: string; profileVersion: number; selectedIdentityGrantId: string }>;
type Grant = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>;
type Internal = Readonly<{ operation: "create" | "update"; transport: ProjectAlphaDirectoryCreateCommand | ProjectAlphaDirectoryProfileUpdateCommand;
  publicId: string | null; actor: Actor }>;

export type ProjectAlphaDirectoryProfileOutboxDispatcherOutcome =
  | Readonly<{ status: "acknowledged"; commandId: string; replayed: boolean; publicId: string; revision: string }>
  | Readonly<{ status: "conflict"; reason: "source" | "command" | "remote"; httpStatus?: number; requestId?: string }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "destination" | "not_due" | "in_progress" }>
  | Readonly<{ status: "uncertain"; reason: string; httpStatus?: number; requestId?: string }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
  catch { return false; }
}
function origin(value: unknown): string | null { try { return typeof value === "string" ? new URL(value).origin : null; } catch { return null; } }
function parse(value: string): Record<string, unknown> | null { try { const result = JSON.parse(value); return plain(result) ? result : null; } catch { return null; } }
function actor(value: unknown): Actor | null {
  if (!plain(value) || !exact(value, ["staffId", "accessSubject", "admissionVersion", "selectedGrantId", "loginEmail", "profileVersion", "selectedIdentityGrantId"])
    || typeof value.staffId !== "string" || typeof value.accessSubject !== "string" || typeof value.selectedGrantId !== "string"
    || typeof value.loginEmail !== "string" || typeof value.selectedIdentityGrantId !== "string"
    || !Number.isSafeInteger(value.admissionVersion) || !Number.isSafeInteger(value.profileVersion)) return null;
  return value as Actor;
}
function sameDestination(row: Row, connection: ProjectAlphaApiV2Connection): boolean {
  return row.application_id === connection.expectedApplicationId && row.expected_source_instance_id === connection.expectedSourceInstanceId
    && row.expected_history_epoch_id === connection.expectedHistoryEpoch && origin(row.destination_base_url) === origin(connection.baseUrl);
}
function applies(grant: Grant, recordId: string, scopes: readonly { business_area_id: string; division_id: string | null }[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || (grant.scope_kind === "resource" && grant.resource_id === recordId)
    || (grant.scope_kind === "assigned" && assigned) || (grant.scope_kind === "business_area" && scopes.some(scope => scope.business_area_id === grant.business_area_id))
    || (grant.scope_kind === "division" && scopes.some(scope => scope.division_id === grant.division_id));
}
async function permitted(db: D1Database, row: Row, value: Actor, permission: "directory.profile.edit" | "directory.identity.link", selectedGrantId: string): Promise<boolean> {
  const selected = await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.id=? AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=? AND staff.status='active' AND staff.access_subject=?`)
    .bind(selectedGrantId, value.staffId, permission, value.accessSubject, value.admissionVersion,
      value.loginEmail, value.profileVersion, value.accessSubject).first<Grant>();
  if (!selected) return false;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(row.record_id).all<{ business_area_id: string; division_id: string | null }>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(row.record_id, value.staffId).first("ok");
  if (!applies(selected, row.record_id, scopes, assigned)) return false;
  const denies = (await db.prepare(`SELECT id,effect,scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(value.staffId, permission).all<Grant>()).results;
  return !denies.some(deny => applies(deny, row.record_id, scopes, assigned));
}
async function activeMapping(db: D1Database, row: Row): Promise<{ project_alpha_public_id: string; mapping_kind: string } | null> {
  return db.prepare(`SELECT project_alpha_public_id,mapping_kind FROM project_alpha_active_directory_mappings
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?`)
    .bind(row.source_id, row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id, row.resource_type, row.external_id)
    .first<{ project_alpha_public_id: string; mapping_kind: string }>();
}
async function exactReservation(db: D1Database, row: Row, connection: ProjectAlphaApiV2Connection): Promise<Internal | "destination" | "command" | "authority"> {
  if (!sameDestination(row, connection)) return "destination";
  if (row.intent_state !== "materialized" || row.command_json !== row.materialization_command_json || row.record_id !== row.external_id
    || row.record_id !== row.external_canonical_id || row.record_kind !== row.resource_type || row.current_version !== row.record_version
    || row.intent_source_id !== row.source_id || row.source_instance_uuid !== row.expected_source_instance_id
    || row.application_uuid !== row.application_id || row.destination_origin !== row.destination_base_url
    || row.intent_history_epoch_id !== row.expected_history_epoch_id || row.materialization_history_epoch_id !== row.expected_history_epoch_id
    || row.audit_actor_type !== "staff") return "command";
  const command = parse(row.command_json), audit = parse(row.audit_command_json), snapshot = parse(row.origin_snapshot_json), disposition = parse(row.disposition_json);
  if (!command || !audit || !snapshot || !disposition || typeof audit.actor === "undefined") return "command";
  const originalActor = actor(audit.actor); if (!originalActor) return "command";
  if (row.audit_actor_id !== originalActor.staffId || row.original_verified_access_subject !== originalActor.accessSubject
    || snapshot.actorId !== originalActor.staffId || snapshot.actorSubject !== originalActor.accessSubject
    || snapshot.authorityRevision !== String(row.record_version) || audit.mutationId !== row.mutation_id || audit.recordId !== row.record_id
    || audit.resourceType !== row.record_kind || audit.expectedLocalVersion !== row.record_version - 1
    || JSON.stringify(audit.fields) !== row.revision_profile_json || disposition.sourceId !== row.source_id
    || disposition.sourceInstanceUUID !== row.expected_source_instance_id || disposition.applicationUUID !== row.application_id
    || disposition.historyEpoch !== row.expected_history_epoch_id || disposition.origin !== row.destination_base_url
    || disposition.externalCanonicalId !== row.external_id) return "command";
  if (!Array.isArray(audit.destinations) || !audit.destinations.some(value => plain(value)
    && value.sourceId === row.source_id && value.sourceInstanceUUID === row.expected_source_instance_id
    && value.applicationUUID === row.application_id && value.historyEpoch === row.expected_history_epoch_id
    && value.origin === row.destination_base_url && value.externalCanonicalId === row.external_id
    && value.expectedAuthorizationGeneration === command.expectedAuthorizationGeneration)) return "command";
  if (!await permitted(db, row, originalActor, "directory.profile.edit", originalActor.selectedGrantId)
    || (row.resource_type === "client" && !await permitted(db, row, originalActor, "directory.identity.link", originalActor.selectedIdentityGrantId))) return "authority";
  const mapping = await activeMapping(db, row);
  if (command.operation === "create") {
    if (mapping || disposition.kind !== "authorized_create" || command.commandId !== row.command_id || command.resourceType !== row.resource_type
      || command.externalId !== row.external_id || command.expectedRevision !== "0" || command.fields === undefined) return "command";
    if (row.resource_type === "organization") {
      const transport = { commandId: row.command_id, externalId: row.external_id,
        expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile: command.fields };
      return typeof command.expectedAuthorizationGeneration === "string" && isProjectAlphaDirectoryCreateCommand("organization", transport)
        ? { operation: "create", transport, publicId: null, actor: originalActor } : "command";
    }
    if (!plain(command.fields) || command.fields.organizationPublicId !== null) return "command";
    const profile = { ...command.fields }; delete profile.organizationPublicId;
    const dependency = await db.prepare(`SELECT 1 ok FROM operations_directory_intent_relationship_dependencies
      WHERE intent_id=? AND client_record_id=? AND client_record_version=? AND source_id=? AND source_instance_uuid=?
        AND application_uuid=? AND history_epoch_id=? AND destination_origin=? AND evidence_kind='unlinked'`)
      .bind(row.intent_id, row.record_id, row.record_version, row.source_id, row.expected_source_instance_id,
        row.application_id, row.expected_history_epoch_id, row.destination_base_url).first("ok");
    const transport = { commandId: row.command_id, externalId: row.external_id,
      expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile, organization: null };
    return dependency && typeof command.expectedAuthorizationGeneration === "string" && isProjectAlphaDirectoryCreateCommand("client", transport)
      ? { operation: "create", transport, publicId: null, actor: originalActor } : "command";
  }
  if (command.operation !== "update" || disposition.kind !== "existing" || !mapping || command.commandId !== row.command_id
    || command.resourceType !== row.resource_type || command.externalId !== row.external_id
    || command.expectedProjectAlphaPublicId !== mapping.project_alpha_public_id || disposition.projectAlphaPublicId !== mapping.project_alpha_public_id
    || command.expectedRevision !== disposition.projectAlphaRevision || command.fields === undefined) return "command";
  const fields = plain(command.fields) && row.resource_type === "client" && Object.hasOwn(command.fields, "organizationPublicId")
    ? (() => { const copy = { ...command.fields }; delete copy.organizationPublicId; return copy; })() : command.fields;
  const transport = { commandId: row.command_id, expectedRevision: command.expectedRevision,
    expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile: fields };
  return typeof command.expectedRevision === "string" && typeof command.expectedAuthorizationGeneration === "string"
    && isProjectAlphaDirectoryProfileUpdateCommand(row.resource_type, transport)
    ? { operation: "update", transport, publicId: mapping.project_alpha_public_id, actor: originalActor } : "command";
}
async function row(db: D1Database, commandId: string): Promise<Row | null> {
  return db.prepare(`SELECT outbox.*,intent.intent_id,intent.mutation_id,intent.record_id,intent.record_version,intent.source_id intent_source_id,intent.source_instance_uuid,
      intent.application_uuid,intent.destination_origin,intent.external_canonical_id,intent.desired_payload_json,
      intent.expected_history_epoch_id intent_history_epoch_id,intent.state intent_state,
      materialization.command_json materialization_command_json,materialization.origin_snapshot_json,
      materialization.disposition_json,materialization.history_epoch_id materialization_history_epoch_id,
      audit.actor_id audit_actor_id,audit.actor_type audit_actor_type,audit.original_verified_access_subject,
      audit.command_json audit_command_json,record.record_kind,record.current_version,revision.profile_json revision_profile_json
    FROM project_alpha_directory_outbox outbox JOIN operations_directory_materializations materialization ON materialization.command_id=outbox.command_id
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
    JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
    JOIN operations_directory_records record ON record.record_id=intent.record_id
    JOIN operations_directory_revisions revision ON revision.record_id=intent.record_id AND revision.version=intent.record_version AND revision.mutation_id=intent.mutation_id
    WHERE outbox.command_id=?`).bind(commandId).first<Row>();
}
function replay(value: Row): ProjectAlphaDirectoryProfileOutboxDispatcherOutcome | null {
  if (value.state !== "acknowledged" && value.state !== "terminal") return null;
  const outcome = value.outcome_json && typeof value.outcome_json === "string" ? parse(value.outcome_json) : null;
  if (value.state === "terminal") return { status: "conflict", reason: "remote",
    ...(typeof outcome?.httpStatus === "number" ? { httpStatus: outcome.httpStatus } : {}),
    ...(typeof outcome?.requestId === "string" ? { requestId: outcome.requestId } : {}) };
  const response = outcome && plain(outcome.response) && plain(outcome.response.result) && plain(outcome.response.result.resource)
    ? outcome.response.result.resource : null;
  return response && typeof response.publicId === "string" && typeof response.revision === "string"
    ? { status: "acknowledged", commandId: value.command_id, replayed: true, publicId: response.publicId, revision: response.revision } : { status: "uncertain", reason: "evidence" };
}
async function release(db: D1Database, value: Row, token: string, now: number, reason: string): Promise<void> {
  const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(12, Math.max(0, value.attempts)));
  await db.prepare(`UPDATE project_alpha_directory_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,
    outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
    .bind(now + delay, value.command_id, token, now).run();
  void reason;
}
function diagnostic(failure: ProjectAlphaDirectoryProfileTransportFailure): { httpStatus?: number; requestId?: string } {
  return { ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}), ...(failure.requestId ? { requestId: failure.requestId } : {}) };
}

/** Dispatches at most one already-materialized writer command. No route, queue,
 * scheduler, or default drain imports this function. */
export async function dispatchProjectAlphaDirectoryProfileOutboxCommand(env: Environment, sourceId: string, commandId: string,
  send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryProfileOutboxDispatcherOutcome> {
  const initial = await row(env.OPS_DB, commandId);
  if (!initial) return { status: "blocked", reason: "in_progress" };
  if (initial.source_id !== sourceId) return { status: "conflict", reason: "source" };
  const done = replay(initial); if (done) return done;
  const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, async connection => {
    const checked = await exactReservation(env.OPS_DB, initial, connection);
    if (typeof checked === "string") return { phase: "invalid" as const, reason: checked };
    const now = Date.now();
    if (initial.state === "pending" && initial.next_attempt_at > now) return { phase: "blocked" as const, reason: "not_due" as const };
    if (initial.state === "leased" && (initial.lease_expires_at === null || initial.lease_expires_at > now)) return { phase: "blocked" as const, reason: "in_progress" as const };
    if (initial.state !== "pending" && initial.state !== "leased") return { phase: "blocked" as const, reason: "in_progress" as const };
    const token = crypto.randomUUID();
    const claim = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND command_json=? AND
      ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
      .bind(token, now + LEASE_MS, initial.command_id, initial.command_json, now, now).run();
    if (claim.meta.changes !== 1) return { phase: "blocked" as const, reason: "in_progress" as const };
    const leased = await row(env.OPS_DB, commandId);
    if (!leased) return { phase: "invalid" as const, reason: "command" as const };
    const current = await exactReservation(env.OPS_DB, leased, connection);
    if (typeof current === "string") {
      await release(env.OPS_DB, leased, token, Date.now(), "pre_send_validation");
      return { phase: "invalid" as const, reason: current };
    }
    const outcome = current.operation === "create"
      ? await sendProjectAlphaDirectoryCreate(connection, leased.resource_type, current.transport as ProjectAlphaDirectoryCreateCommand, send)
      : await sendProjectAlphaDirectoryProfileUpdate(connection, leased.resource_type, current.publicId!, current.transport as ProjectAlphaDirectoryProfileUpdateCommand, send);
    if (outcome.status !== "acknowledged") {
      if (outcome.status === "conflict") {
        const saved = JSON.stringify({ directoryProfileDispatcher: "conflict", reason: outcome.reason, ...diagnostic(outcome) });
        const settled = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json=?,lease_token=NULL,lease_expires_at=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
          .bind(saved, leased.command_id, token, Date.now()).run();
        return settled.meta.changes === 1 ? { phase: "conflict" as const, details: diagnostic(outcome) } : { phase: "uncertain" as const, reason: "lost_lease" };
      }
      await release(env.OPS_DB, leased, token, Date.now(), outcome.reason);
      const preflight = outcome.reason === "preflight" ? outcome.preflight : undefined;
      return { phase: "uncertain" as const,
        reason: preflight && preflight.status !== "verified" ? `preflight:${preflight.status}:${preflight.reason}` : outcome.reason,
        details: diagnostic(outcome) };
    }
    const evidence = validatedProjectAlphaDirectoryProfileAcknowledgement(outcome);
    if (!evidence || JSON.stringify(evidence.command) !== JSON.stringify(current.transport) || origin(evidence.destinationOrigin) !== origin(leased.destination_base_url)) {
      await release(env.OPS_DB, leased, token, Date.now(), "evidence");
      return { phase: "uncertain" as const, reason: "evidence" };
    }
    const after = await exactReservation(env.OPS_DB, leased, connection);
    if (typeof after === "string") {
      await release(env.OPS_DB, leased, token, Date.now(), "post_send_validation");
      return { phase: "invalid" as const, reason: after };
    }
    const response = evidence.response, resource = response.result.resource;
    const outcomeJson = JSON.stringify({ status: "acknowledged", response });
    const statements: D1PreparedStatement[] = [];
    if (current.operation === "create") statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_mappings(
      source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      SELECT source_id,resource_type,external_id,?,expected_source_instance_id,application_id,expected_history_epoch_id,command_id
      FROM project_alpha_directory_outbox WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
      .bind(resource.publicId, leased.command_id, token, Date.now()));
    statements.push(env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
      .bind(outcomeJson, leased.command_id, token, Date.now()));
    statements.push(env.OPS_DB.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE intent_id=? AND state='materialized'
      AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE command_id=? AND state='acknowledged' AND outcome_json=?)`)
      .bind(leased.intent_id, leased.command_id, outcomeJson));
    try {
      const settled = await env.OPS_DB.batch(statements);
      if (settled.some(result => result.meta.changes !== 1)) return { phase: "uncertain" as const, reason: "lost_lease" };
    } catch { return { phase: "uncertain" as const, reason: "database" }; }
    return { phase: "acknowledged" as const, publicId: resource.publicId, revision: resource.revision, replayed: response.replayed };
  });
  if (selected.status !== "enabled") return { status: "blocked", reason: "configuration" };
  const result = selected.value;
  if (result.phase === "acknowledged") return { status: "acknowledged", commandId, publicId: result.publicId, revision: result.revision, replayed: result.replayed };
  if (result.phase === "conflict") return { status: "conflict", reason: "remote", ...result.details };
  if (result.phase === "uncertain") return { status: "uncertain", reason: result.reason, ...(result.details ?? {}) };
  if (result.phase === "blocked") return { status: "blocked", reason: result.reason };
  return result.reason === "destination" ? { status: "blocked", reason: "destination" }
    : result.reason === "authority" ? { status: "blocked", reason: "authority" } : { status: "conflict", reason: "command" };
}
