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
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import type { ProjectAlphaProjectFailure } from "./project-alpha-project-transport";

/**
 * This is deliberately an unmounted adapter.  It is the sole consumer of the
 * transport's private evidence handoff and writes only the dormant 0119
 * ledger.  It must never be imported by a route, queue, scheduler, or index.
 */
export type ProjectAlphaProjectSettlementEnvironment = Readonly<{ OPS_DB: D1Database }>;
type EligibleOperation = Extract<ProjectAlphaProjectCommandType, "create" | "update" | "bind">;
type Outbox = Readonly<{
  command_id: string;
  external_project_id: string;
  operation: string;
  command_json: string;
  application_id: string;
  destination_base_url: string;
  expected_source_instance_id: string;
  expected_history_epoch_id: string;
}>;
type Prior = Readonly<{ request_sha256: string; state: string | null; receipt_id: string | null }>;
export type ProjectAlphaProjectSettlementOutcome =
  | Readonly<{ status: "acknowledged"; receiptId: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_command" | "refresh_not_supported" }>
  | Readonly<{ status: "blocked"; reason: "authority" | "destination" | "in_progress" | "lost_ack" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "evidence" | "prior_uncertain" }>
  | ProjectAlphaProjectFailure;

function hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer).then(buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join(""));
}
function origin(value: string): string | null { try { return new URL(value).origin; } catch { return null; } }
function eligible(value: ProjectAlphaProjectCommandType): value is EligibleOperation { return value === "create" || value === "update" || value === "bind"; }
function terminal(state: ProjectAlphaProjectFailure["status"]): "uncertain" | "conflict" | "rejected" {
  return state === "conflict" ? "conflict" : state === "rejected" ? "rejected" : "uncertain";
}
async function prior(db: D1Database, commandId: string): Promise<Prior | null> {
  return db.prepare(`SELECT fingerprint.request_sha256,
      (SELECT event.state FROM project_alpha_project_v2_events event WHERE event.command_id=fingerprint.command_id ORDER BY event.state_version DESC LIMIT 1) state,
      (SELECT receipt.receipt_id FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=fingerprint.command_id) receipt_id
    FROM project_alpha_project_v2_request_fingerprints fingerprint WHERE fingerprint.command_id=?`).bind(commandId).first<Prior>();
}
async function alreadyReserved(db: D1Database, commandId: string, requestSha256: string): Promise<ProjectAlphaProjectSettlementOutcome | null> {
  const value = await prior(db, commandId);
  if (!value) return null;
  if (value.request_sha256 !== requestSha256) return { status: "blocked", reason: "authority" };
  if (value.receipt_id) return { status: "acknowledged", receiptId: value.receipt_id, replayed: true };
  return value.state === "acknowledged" ? { status: "blocked", reason: "lost_ack" } : value.state === "uncertain" ? { status: "uncertain", reason: "prior_uncertain" } : { status: "blocked", reason: "in_progress" };
}
async function currentOutbox(db: D1Database, type: EligibleOperation, command: ProjectAlphaProjectCommand, body: string, connection: ProjectAlphaApiV2Connection): Promise<"ok" | "authority" | "destination"> {
  const row = await db.prepare(`SELECT outbox.command_id,outbox.external_project_id,outbox.operation,outbox.command_json,outbox.application_id,outbox.destination_base_url,outbox.expected_source_instance_id,outbox.expected_history_epoch_id
    FROM project_alpha_project_outbox outbox
    JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
    JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id
    WHERE outbox.command_id=?`).bind(command.commandId).first<Outbox>();
  if (!row || row.operation !== type || row.external_project_id !== command.externalId || row.command_json !== body) return "authority";
  const configured = origin(connection.baseUrl), reserved = origin(row.destination_base_url);
  if (!configured || !reserved || configured !== reserved) return "destination";
  return row.application_id === connection.expectedApplicationId
    && row.expected_source_instance_id === connection.expectedSourceInstanceId
    && row.expected_history_epoch_id === connection.expectedHistoryEpoch ? "ok" : "authority";
}
function send(type: EligibleOperation, connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectCommand, fetcher: typeof fetch): Promise<ProjectAlphaProjectOutcome> {
  if (type === "create") return sendProjectAlphaProjectCreateCommand(connection, command as never, fetcher);
  if (type === "update") return sendProjectAlphaProjectUpdateCommand(connection, command as never, fetcher);
  return sendProjectAlphaProjectBindingCommand(connection, command as never, fetcher);
}
async function appendFailure(db: D1Database, commandId: string, requestSha256: string, failure: ProjectAlphaProjectFailure): Promise<void> {
  await db.batch([db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
    VALUES (?,2,?,?,?)`).bind(commandId, crypto.randomUUID(), requestSha256, terminal(failure.status))]);
}

/**
 * Reserve the exact canonical bytes before even the capability preflight can
 * issue a request, then settle a transport-minted acknowledgement atomically.
 * Existing in-flight or uncertain attempts are never re-dispatched: recovery
 * needs a separately reviewed operator workflow because PA may have received
 * the request after a lost response.
 */
export async function settleProjectAlphaProjectV2Command(
  env: ProjectAlphaProjectSettlementEnvironment,
  type: ProjectAlphaProjectCommandType,
  connection: ProjectAlphaApiV2Connection,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaProjectSettlementOutcome> {
  if (!eligible(type)) return { status: "rejected", reason: "refresh_not_supported" };
  if (!isProjectAlphaProjectCommand(type, input)) return { status: "rejected", reason: "invalid_command" };
  const canonical = canonicalProjectAlphaProjectRequest(type, input);
  if (!canonical) return { status: "rejected", reason: "invalid_command" };
  const { command, body } = canonical, requestSha256 = await hex(new TextEncoder().encode(body));

  const existing = await alreadyReserved(env.OPS_DB, command.commandId, requestSha256);
  if (existing) return existing;
  const authority = await currentOutbox(env.OPS_DB, type, command, body, connection);
  if (authority !== "ok") return { status: "blocked", reason: authority };
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare("INSERT INTO project_alpha_project_v2_request_fingerprints(command_id,request_sha256) VALUES(?,?)").bind(command.commandId, requestSha256),
      env.OPS_DB.prepare("INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state) VALUES(?,1,?,?,'pending')").bind(command.commandId, crypto.randomUUID(), requestSha256),
    ]);
  } catch {
    // A competing invocation may have won the reservation.  Re-read once and
    // never dispatch when that winner is incomplete or has a different hash.
    const won = await alreadyReserved(env.OPS_DB, command.commandId, requestSha256).catch(() => null);
    return won ?? { status: "blocked", reason: "authority" };
  }

  // The reservation trigger proves native authority at insertion time, but
  // destination metadata can still change between the first read and the
  // completed batch. Recheck the complete outbox fence after winning the
  // reservation and immediately before any Project Alpha network request.
  const reservedAuthority = await currentOutbox(env.OPS_DB, type, command, body, connection);
  if (reservedAuthority !== "ok") {
    try { await appendFailure(env.OPS_DB, command.commandId, requestSha256, { status: "rejected", reason: "invalid_contract" }); }
    catch { return { status: "uncertain", reason: "database" }; }
    return { status: "blocked", reason: reservedAuthority };
  }

  const outcome = await send(type, connection, command, fetcher);
  if (outcome.status !== "acknowledged") {
    try { await appendFailure(env.OPS_DB, command.commandId, requestSha256, outcome); }
    catch { return { status: "uncertain", reason: "database" }; }
    return outcome;
  }
  const evidence = privateProjectAlphaProjectSettlementEvidence(validatedProjectAlphaProjectAcknowledgement(outcome));
  if (!evidence || evidence.type !== type || evidence.requestSha256 !== requestSha256 || JSON.stringify(evidence.command) !== body) {
    try { await appendFailure(env.OPS_DB, command.commandId, requestSha256, { status: "uncertain", reason: "invalid_contract" }); } catch { /* fail closed below */ }
    return { status: "uncertain", reason: "evidence" };
  }
  const response = evidence.response, resource = response.result.resource, acknowledgementId = crypto.randomUUID(), receiptId = crypto.randomUUID();
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
        VALUES (?,2,?,?,'acknowledged')`).bind(command.commandId, crypto.randomUUID(), requestSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_validated_acknowledgements(acknowledgement_id,command_id,acknowledged_state_version,request_sha256,source_instance_id,application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,pa_request_id,pa_replayed,response_sha256)
        VALUES (?,?,2,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(acknowledgementId, command.commandId, requestSha256, response.sourceInstanceId, response.applicationId, response.historyEpoch, evidence.destinationOrigin, resource.publicId, resource.revision, resource.projectionSha256, response.result.authorizationGeneration, response.requestId, response.replayed ? 1 : 0, evidence.responseSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_success_receipts(receipt_id,acknowledgement_id,command_id,request_sha256,source_instance_id,application_id,history_epoch_id,destination_origin,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,pa_request_id,pa_replayed,response_sha256)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptId, acknowledgementId, command.commandId, requestSha256, response.sourceInstanceId, response.applicationId, response.historyEpoch, evidence.destinationOrigin, resource.publicId, resource.revision, resource.projectionSha256, response.result.authorizationGeneration, response.requestId, response.replayed ? 1 : 0, evidence.responseSha256),
    ]);
    return { status: "acknowledged", receiptId, replayed: response.replayed };
  } catch {
    // D1 batch is transactional.  Do not fabricate a terminal acknowledgement
    // or retry the PA call after a failed receipt commit.
    const winner = await alreadyReserved(env.OPS_DB, command.commandId, requestSha256).catch(() => null);
    return winner?.status === "acknowledged" ? winner : { status: "uncertain", reason: "database" };
  }
}
