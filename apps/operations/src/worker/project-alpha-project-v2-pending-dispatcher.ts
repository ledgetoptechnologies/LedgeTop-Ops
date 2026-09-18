import {
  canonicalProjectAlphaProjectRequest,
  isProjectAlphaProjectCommand,
  privateProjectAlphaProjectSettlementEvidence,
  sendProjectAlphaProjectBindingCommand,
  sendProjectAlphaProjectCreateCommand,
  sendProjectAlphaProjectUpdateCommand,
  validatedProjectAlphaProjectAcknowledgement,
  type ProjectAlphaProjectCommand,
  type ProjectAlphaProjectCommandType,
  type ProjectAlphaProjectOutcome,
} from "./project-alpha-project-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import { uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";

/**
 * Private, unmounted dispatcher for an already planned Project-v2 command.
 *
 * This module has no default transport and is deliberately not imported by a
 * route, queue, scheduler, worker entrypoint, or index.  Callers must inject
 * a test-only transport.  In particular, an uncertain result is terminal for
 * this dispatcher: a later recovery design must establish PA's receipt before
 * any retry can be authorized.
 */
export type ProjectAlphaProjectV2PendingDispatcherEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type Operation = Extract<ProjectAlphaProjectCommandType, "create" | "update" | "bind">;
type Outbox = Readonly<{
  command_id: string; external_project_id: string; operation: string; command_json: string;
  source_id: string; application_id: string; destination_base_url: string;
  expected_source_instance_id: string; expected_history_epoch_id: string;
  request_sha256: string; expected_local_version: number; expected_local_projection_sha256: string | null;
  expected_mapping_state: "absent" | "exact"; expected_project_alpha_public_id: string | null;
}>;
type Head = Readonly<{ current_version: number; canonical_projection_sha256: string | null; source_id: string | null;
  source_instance_id: string | null; application_id: string | null; history_epoch_id: string | null; project_alpha_public_id: string | null }>;
type Mapping = Readonly<{ source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string; project_alpha_public_id: string }>;
type Receipt = Readonly<{ receipt_id: string; source_id: string; application_id: string; expected_source_instance_id: string; expected_history_epoch_id: string; destination_base_url: string; request_sha256: string }>;
type Terminal = Readonly<{ event_state: string | null; outcome_json: string | null; source_id: string; application_id: string;
  expected_source_instance_id: string; expected_history_epoch_id: string; destination_base_url: string }>;

export type ProjectAlphaProjectV2PendingDispatcherOutcome =
  | Readonly<{ status: "acknowledged"; receiptId: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_command" | "refresh_not_supported" }>
  | Readonly<{ status: "conflict"; reason: "source" | "command" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "destination" | "stale" | "in_progress" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "lost_ack" | "evidence" }>
  | ProjectAlphaProjectFailure;

function operation(value: string): value is Operation { return value === "create" || value === "update" || value === "bind"; }
function origin(value: string): string | null { try { return new URL(value).origin; } catch { return null; } }
async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(result, byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameIdentity(row: Pick<Outbox, "source_id" | "application_id" | "expected_source_instance_id" | "expected_history_epoch_id" | "destination_base_url">, sourceId: string, connection: ProjectAlphaApiV2Connection): boolean {
  return row.source_id === sourceId && row.application_id === connection.expectedApplicationId
    && row.expected_source_instance_id === connection.expectedSourceInstanceId
    && row.expected_history_epoch_id === connection.expectedHistoryEpoch
    && origin(row.destination_base_url) !== null && origin(row.destination_base_url) === origin(connection.baseUrl);
}
async function receipt(db: D1Database, commandId: string): Promise<Receipt | null> {
  return db.prepare(`SELECT receipt.receipt_id,outbox.source_id,outbox.application_id,outbox.expected_source_instance_id,
      outbox.expected_history_epoch_id,outbox.destination_base_url,fingerprint.request_sha256
    FROM project_alpha_project_v2_success_receipts receipt
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=receipt.command_id
    JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=receipt.command_id
    WHERE receipt.command_id=?`).bind(commandId).first<Receipt>();
}
async function terminal(db: D1Database, commandId: string): Promise<Terminal | null> {
  return db.prepare(`SELECT (SELECT state FROM project_alpha_project_v2_events event
      WHERE event.command_id=outbox.command_id ORDER BY state_version DESC LIMIT 1) event_state,outcome_json,
      source_id,application_id,expected_source_instance_id,expected_history_epoch_id,destination_base_url
    FROM project_alpha_project_outbox outbox WHERE command_id=? AND state='terminal'`).bind(commandId).first<Terminal>();
}
function terminalReplay(value: Terminal): ProjectAlphaProjectV2PendingDispatcherOutcome {
  let details: Record<string, unknown> = {};
  try {
    const parsed = value.outcome_json && JSON.parse(value.outcome_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch { /* Event state remains the authoritative terminal discriminator. */ }
  const reason = typeof details.reason === "string" && ["invalid_command", "request_limit", "preflight", "http_status", "timeout", "transport", "response_limit", "invalid_contract"].includes(details.reason)
    ? details.reason as ProjectAlphaProjectFailure["reason"] : "invalid_contract";
  const diagnostic = { ...(Number.isInteger(details.httpStatus) && (details.httpStatus as number) >= 100 && (details.httpStatus as number) <= 599
    ? { httpStatus: details.httpStatus as number } : {}), ...(uuid(details.requestId) ? { requestId: details.requestId } : {}) };
  return value.event_state === "conflict" ? { status: "conflict", reason, ...diagnostic }
    : value.event_state === "rejected" ? { status: "rejected", reason, ...diagnostic }
      : { status: "uncertain", reason, ...diagnostic };
}
async function pending(db: D1Database, commandId: string, state: "pending" | "leased"): Promise<Outbox | null> {
  return db.prepare(`SELECT outbox.command_id,outbox.external_project_id,outbox.operation,outbox.command_json,outbox.source_id,
      outbox.application_id,outbox.destination_base_url,outbox.expected_source_instance_id,outbox.expected_history_epoch_id,
      fingerprint.request_sha256,intent.expected_local_version,intent.expected_local_projection_sha256,
      intent.expected_mapping_state,intent.expected_project_alpha_public_id
    FROM project_alpha_project_outbox outbox
    JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
    JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=outbox.command_id
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=outbox.command_id
    WHERE outbox.command_id=? AND outbox.state=?`).bind(commandId, state).first<Outbox>();
}
function sameMapping(value: Mapping | null, row: Outbox): boolean {
  if (row.expected_mapping_state === "absent") return value === null;
  return !!value && value.source_id === row.source_id && value.source_instance_id === row.expected_source_instance_id
    && value.application_id === row.application_id && value.history_epoch_id === row.expected_history_epoch_id
    && value.project_alpha_public_id === row.expected_project_alpha_public_id;
}
function sameHead(value: Head | null, row: Outbox): boolean {
  if (row.expected_local_version === 0) return value === null;
  if (!value || value.current_version !== row.expected_local_version || value.canonical_projection_sha256 !== row.expected_local_projection_sha256) return false;
  return row.expected_mapping_state === "exact"
    ? value.source_id === row.source_id && value.source_instance_id === row.expected_source_instance_id
      && value.application_id === row.application_id && value.history_epoch_id === row.expected_history_epoch_id
      && value.project_alpha_public_id === row.expected_project_alpha_public_id
    : value.source_id === null && value.source_instance_id === null && value.application_id === null
      && value.history_epoch_id === null && value.project_alpha_public_id === null;
}
async function exactReservation(db: D1Database, row: Outbox, sourceId: string, connection: ProjectAlphaApiV2Connection): Promise<{ command: ProjectAlphaProjectCommand; body: string } | "authority" | "destination" | "stale" | "command"> {
  if (!sameIdentity(row, sourceId, connection)) return row.source_id === sourceId ? "destination" : "authority";
  if (!await db.prepare(`SELECT 1 current_proof FROM native_project_live_command_proofs
      WHERE command_id=? AND external_project_id=?
        AND verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(row.command_id, row.external_project_id).first("current_proof")) return "authority";
  let parsed: unknown;
  try { parsed = JSON.parse(row.command_json); } catch { return "command"; }
  if (!operation(row.operation) || !isProjectAlphaProjectCommand(row.operation, parsed)) return "command";
  const canonical = canonicalProjectAlphaProjectRequest(row.operation, parsed);
  if (!canonical || canonical.body !== row.command_json || canonical.command.commandId !== row.command_id
    || canonical.command.externalId !== row.external_project_id || await digest(canonical.body) !== row.request_sha256) return "command";
  if ((row.operation === "create" && row.expected_local_version !== 0)
    || (row.operation !== "create" && (row.expected_local_version < 1 || row.expected_local_projection_sha256 === null))) return "stale";
  if (row.operation === "update" && (canonical.command as Extract<ProjectAlphaProjectCommand, { expectedProjectionSha256: string }>).expectedProjectionSha256 !== row.expected_local_projection_sha256) return "stale";
  if (row.operation === "bind" && (canonical.command as Extract<ProjectAlphaProjectCommand, { expectedProjectionSha256: string }>).expectedProjectionSha256 !== row.expected_local_projection_sha256) return "stale";
  const [head, mapping] = await Promise.all([
    db.prepare(`SELECT current_version,canonical_projection_sha256,source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
      FROM operations_shared_projects WHERE external_project_id=?`).bind(row.external_project_id).first<Head>(),
    db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
      FROM project_alpha_project_mappings WHERE external_project_id=?`).bind(row.external_project_id).first<Mapping>(),
  ]);
  return sameHead(head, row) && sameMapping(mapping, row) ? canonical : "stale";
}
function eventState(value: ProjectAlphaProjectFailure["status"]): "uncertain" | "conflict" | "rejected" {
  return value === "conflict" ? "conflict" : value === "rejected" ? "rejected" : "uncertain";
}
function outcomeJson(status: string, reason: string, failure?: ProjectAlphaProjectFailure): string {
  return JSON.stringify({ projectV2Dispatcher: status, reason, ...(failure?.httpStatus ? { httpStatus: failure.httpStatus } : {}), ...(failure?.requestId ? { requestId: failure.requestId } : {}) });
}
async function finishFailure(db: D1Database, row: Outbox, failure: ProjectAlphaProjectFailure): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
      VALUES(?,2,?,?,?)`).bind(row.command_id, crypto.randomUUID(), row.request_sha256, eventState(failure.status)),
    db.prepare(`UPDATE project_alpha_project_outbox SET state='terminal',lease_token=NULL,lease_expires_at=NULL,outcome_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased'`)
      .bind(outcomeJson(failure.status, failure.reason, failure), row.command_id),
  ]);
}
async function releasePreflight(db: D1Database, row: Outbox): Promise<void> {
  await db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
    outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND state='leased'`).bind(row.command_id).run();
}
function send(type: Operation, connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectCommand, transport: typeof fetch): Promise<ProjectAlphaProjectOutcome> {
  if (type === "create") return sendProjectAlphaProjectCreateCommand(connection, command as never, transport);
  if (type === "update") return sendProjectAlphaProjectUpdateCommand(connection, command as never, transport);
  return sendProjectAlphaProjectBindingCommand(connection, command as never, transport);
}

/** Runs only after the default-off connection bridge has released one private connection. */
async function dispatchEnabledProjectAlphaProjectV2PendingCommand(
  env: ProjectAlphaProjectV2PendingDispatcherEnvironment,
  sourceId: string,
  commandId: string,
  transport: typeof fetch,
  connection: ProjectAlphaApiV2Connection,
): Promise<ProjectAlphaProjectV2PendingDispatcherOutcome> {
  try {
    const prior = await receipt(env.OPS_DB, commandId);
    if (prior) {
      if (!sameIdentity(prior, sourceId, connection)) return { status: "conflict", reason: "source" };
      return { status: "acknowledged", receiptId: prior.receipt_id, replayed: true };
    }
    const initial = await pending(env.OPS_DB, commandId, "pending");
    if (!initial) {
      const leased = await pending(env.OPS_DB, commandId, "leased");
      if (leased) return { status: "uncertain", reason: "lost_ack" };
      const completed = await terminal(env.OPS_DB, commandId);
      if (!completed) return { status: "blocked", reason: "in_progress" };
      if (completed.source_id !== sourceId) return { status: "conflict", reason: "source" };
      if (!sameIdentity(completed, sourceId, connection)) return { status: "blocked", reason: "destination" };
      return terminalReplay(completed);
    }
    if (initial.source_id !== sourceId) return { status: "conflict", reason: "source" };
    const before = await exactReservation(env.OPS_DB, initial, sourceId, connection);
    if (typeof before === "string") return before === "command" ? { status: "conflict", reason: "command" }
      : { status: "blocked", reason: before };

    const leaseToken = crypto.randomUUID();
    const leased = await env.OPS_DB.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=attempts+1,
      lease_token=?,lease_expires_at=unixepoch('now')+300,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND state='pending' AND source_id=? AND application_id=? AND expected_source_instance_id=?
        AND expected_history_epoch_id=? AND command_json=?`).bind(leaseToken, initial.command_id, initial.source_id,
      initial.application_id, initial.expected_source_instance_id, initial.expected_history_epoch_id, initial.command_json).run();
    if (leased.meta.changes !== 1) {
      const winner = await receipt(env.OPS_DB, commandId);
      if (winner && sameIdentity(winner, sourceId, connection)) return { status: "acknowledged", receiptId: winner.receipt_id, replayed: true };
      return { status: "uncertain", reason: "lost_ack" };
    }
    const current = await pending(env.OPS_DB, commandId, "leased");
    const checked = current ? await exactReservation(env.OPS_DB, current, sourceId, connection) : "authority";
    if (typeof checked === "string") {
      const failure: ProjectAlphaProjectFailure = { status: checked === "command" ? "rejected" : "blocked", reason: "invalid_contract" };
      await finishFailure(env.OPS_DB, initial, failure);
      return checked === "command" ? { status: "conflict", reason: "command" } : { status: "blocked", reason: checked };
    }
    const outcome = await send(current!.operation as Operation, connection, checked.command, transport);
    if (outcome.status !== "acknowledged") {
      // Capability discovery did not issue a POST. Return the lease to its
      // original pending state without an immutable terminal event so a later
      // healthy capability check can make the one authorized dispatch.
      if (outcome.reason === "preflight") {
        await releasePreflight(env.OPS_DB, current!);
        return outcome;
      }
      // Even a syntactically clear non-success response cannot establish that
      // PA did not accept the command before a proxy/client failure.  Preserve
      // only uncertain evidence and require a later receipt-recovery design.
      const uncertain: ProjectAlphaProjectFailure = { status: "uncertain", reason: outcome.reason,
        ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}), ...(outcome.requestId ? { requestId: outcome.requestId } : {}) };
      await finishFailure(env.OPS_DB, current!, uncertain);
      return uncertain;
    }
    const evidence = privateProjectAlphaProjectSettlementEvidence(validatedProjectAlphaProjectAcknowledgement(outcome));
    if (!evidence || evidence.type !== current!.operation || evidence.requestSha256 !== current!.request_sha256 || JSON.stringify(evidence.command) !== current!.command_json) {
      await finishFailure(env.OPS_DB, current!, { status: "uncertain", reason: "invalid_contract" });
      return { status: "uncertain", reason: "evidence" };
    }
    const response = evidence.response, resource = response.result.resource, acknowledgementId = crypto.randomUUID(), receiptId = crypto.randomUUID();
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
        VALUES(?,2,?,?,'acknowledged')`).bind(current!.command_id, crypto.randomUUID(), current!.request_sha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_validated_acknowledgements(acknowledgement_id,command_id,acknowledged_state_version,request_sha256,source_instance_id,application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,pa_request_id,pa_replayed,response_sha256)
        VALUES(?,?,2,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(acknowledgementId, current!.command_id, current!.request_sha256,
        response.sourceInstanceId, response.applicationId, response.historyEpoch, evidence.destinationOrigin, resource.publicId,
        resource.revision, resource.projectionSha256, response.result.authorizationGeneration, response.requestId,
        response.replayed ? 1 : 0, evidence.responseSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_success_receipts(receipt_id,acknowledgement_id,command_id,request_sha256,source_instance_id,application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,pa_request_id,pa_replayed,response_sha256)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptId, acknowledgementId, current!.command_id, current!.request_sha256,
        response.sourceInstanceId, response.applicationId, response.historyEpoch, evidence.destinationOrigin, resource.publicId,
        resource.revision, resource.projectionSha256, response.result.authorizationGeneration, response.requestId,
        response.replayed ? 1 : 0, evidence.responseSha256),
      // 0122 activation deliberately leases a *pending* outbox row while it
      // atomically changes the canonical mapping/head/history. The immutable
      // acknowledgement and success receipt above record POST completion;
      // returning this row to pending leaves that later local-only activation
      // composable without re-dispatching because receipt() wins all replays.
      env.OPS_DB.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
        outcome_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=?`)
        .bind(outcomeJson("acknowledged", "validated"), current!.command_id, leaseToken),
    ]);
    return { status: "acknowledged", receiptId, replayed: outcome.response.replayed };
  } catch {
    const winner = await receipt(env.OPS_DB, commandId).catch(() => null);
    if (winner && sameIdentity(winner, sourceId, connection)) return { status: "acknowledged", receiptId: winner.receipt_id, replayed: true };
    return { status: "uncertain", reason: "database" };
  }
}

/** Dispatches exactly one producer-created pending command through injected test transport. */
export async function dispatchProjectAlphaProjectV2PendingCommand(
  env: ProjectAlphaProjectV2PendingDispatcherEnvironment,
  sourceId: string,
  commandId: string,
  transport: typeof fetch,
): Promise<ProjectAlphaProjectV2PendingDispatcherOutcome> {
  const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId,
    connection => dispatchEnabledProjectAlphaProjectV2PendingCommand(env, sourceId, commandId, transport, connection));
  return selected.status === "enabled" ? selected.value : { status: "blocked", reason: "configuration" };
}
