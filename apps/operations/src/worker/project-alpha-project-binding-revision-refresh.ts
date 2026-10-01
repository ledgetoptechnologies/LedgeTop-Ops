import {
  canonicalProjectAlphaProjectRequest,
  isProjectAlphaProjectRefreshAcknowledgement,
  isProjectAlphaProjectRefreshCommand,
  sendProjectAlphaProjectRefreshCommand,
  type ProjectAlphaProjectRefreshCommand,
} from "./project-alpha-project-api-v2";
import {
  readConfiguredProjectAlphaProjectBindingStatus,
} from "./project-alpha-project-binding-status-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

export type ProjectAlphaProjectBindingRefreshEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaProjectBindingRefreshInput = Readonly<{ sourceId: string; externalProjectId: string; commandId: string }>;
export type ProjectAlphaProjectBindingRefreshOutcome =
  | Readonly<{ status: "acknowledged"; receiptId: string; replayed: boolean; postStatusConfirmed: boolean }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "not_stale" | "in_progress" | "prior_uncertain" | "mapping" | "identity" | "no_send_preflight" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" | "binding_stale_contract" }>
  | Readonly<{ status: "uncertain"; reason: "transport" | "database" | "post_status" | "invalid_contract" }>;

type Existing = Readonly<{ command_id: string; request_sha256: string; external_project_id: string; source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string; destination_base_url: string; receipt_id: string | null; state: string | null; state_version: number | null }>;

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const output = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(output, byte => byte.toString(16).padStart(2, "0")).join("");
}

function increment(value: string): string {
  const digits = value.split("");
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry; index -= 1) {
    const next = digits[index]!.charCodeAt(0) - 48 + carry;
    digits[index] = String(next % 10);
    carry = next === 10 ? 1 : 0;
  }
  return (carry ? "1" : "") + digits.join("");
}

async function existing(db: D1Database, commandId: string): Promise<Existing | null> {
  return db.prepare(`SELECT command.command_id,command.request_sha256,command.external_project_id,command.source_id,
      command.source_instance_id,command.application_id,command.history_epoch_id,command.destination_base_url,
      receipt.receipt_id,
      (SELECT event.state FROM project_alpha_project_binding_revision_refresh_events event
        WHERE event.command_id=command.command_id ORDER BY event.state_version DESC LIMIT 1) state,
      (SELECT event.state_version FROM project_alpha_project_binding_revision_refresh_events event
        WHERE event.command_id=command.command_id ORDER BY event.state_version DESC LIMIT 1) state_version
    FROM project_alpha_project_binding_revision_refresh_commands command
    LEFT JOIN project_alpha_project_binding_revision_refresh_receipts receipt ON receipt.command_id=command.command_id
    WHERE command.command_id=?`).bind(commandId).first<Existing>();
}

async function priorOutcome(db: D1Database, input: ProjectAlphaProjectBindingRefreshInput, connection: ProjectAlphaApiV2Connection): Promise<ProjectAlphaProjectBindingRefreshOutcome | null> {
  const row = await existing(db, input.commandId);
  if (!row) return null;
  if (row.source_id !== input.sourceId || row.external_project_id !== input.externalProjectId
    || row.source_instance_id !== connection.expectedSourceInstanceId
    || row.application_id !== connection.expectedApplicationId
    || row.history_epoch_id !== connection.expectedHistoryEpoch
    || row.destination_base_url !== connection.baseUrl) return { status: "blocked", reason: "identity" };
  if (row.receipt_id) {
    const receipt = await db.prepare("SELECT pa_replayed,post_status_confirmed FROM project_alpha_project_binding_revision_refresh_receipts WHERE receipt_id=?").bind(row.receipt_id).first<{ pa_replayed: number; post_status_confirmed: number }>();
    return { status: "acknowledged", receiptId: row.receipt_id, replayed: true, postStatusConfirmed: receipt?.post_status_confirmed === 1 };
  }
  if (row.state === "preflight_blocked") return null;
  return row.state === "uncertain" ? { status: "blocked", reason: "prior_uncertain" } : { status: "blocked", reason: "in_progress" };
}

async function appendUncertain(db: D1Database, commandId: string, requestSha256: string, stateVersion = 2): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_events
    (command_id,state_version,transition_id,request_sha256,state) SELECT ?,?,?,?, 'uncertain'
    WHERE NOT EXISTS (SELECT 1 FROM project_alpha_project_binding_revision_refresh_events WHERE command_id=? AND state_version=?)`)
    .bind(commandId, stateVersion, crypto.randomUUID(), requestSha256, commandId, stateVersion).run();
}

async function appendPreflightBlocked(db: D1Database, commandId: string, requestSha256: string, stateVersion: number): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_events
    (command_id,state_version,transition_id,request_sha256,state)
    SELECT ?,?,?,?, 'preflight_blocked'
    WHERE NOT EXISTS (SELECT 1 FROM project_alpha_project_binding_revision_refresh_events WHERE command_id=? AND state_version=?)`)
    .bind(commandId, stateVersion, crypto.randomUUID(), requestSha256, commandId, stateVersion).run();
}

/**
 * Refreshes one explicitly selected existing project binding. This is kept out
 * of the project content outbox: the only durable local state is an immutable
 * command/event/receipt chain, and no Operations project or delivery row is
 * modified.
 */
export async function refreshProjectAlphaProjectBinding(
  env: ProjectAlphaProjectBindingRefreshEnvironment,
  input: ProjectAlphaProjectBindingRefreshInput,
  fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaProjectBindingRefreshOutcome> {
  if (!SOURCE.test(input.sourceId) || !UUID.test(input.commandId)
    || input.externalProjectId.length < 1 || input.externalProjectId.length > 191 || /\p{C}/u.test(input.externalProjectId))
    return { status: "rejected", reason: "invalid_input" };
  let selectedConnection: ProjectAlphaApiV2Connection | null = null;
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, input.sourceId, async connection => {
    selectedConnection = connection;
    return true;
  });
  if (configured.status !== "enabled" || !selectedConnection) return { status: "blocked", reason: "configuration" };
  // The bridge invokes the callback synchronously before returning its
  // result; the explicit assertion keeps the secret-bearing value local.
  const selected = selectedConnection as ProjectAlphaApiV2Connection;
  const prior = await priorOutcome(env.OPS_DB, input, selected);
  if (prior) return prior;

  // Read the PA status immediately before reservation. The caller cannot
  // provide or override the stale revisions, public ID, projection, or epoch.
  const status = await readConfiguredProjectAlphaProjectBindingStatus(env, input.sourceId, input.externalProjectId, fetcher);
  if (status.status !== "binding_stale") return status.status === "observed" ? { status: "blocked", reason: "not_stale" }
    : status.status === "not_found" ? { status: "blocked", reason: "mapping" } : { status: "uncertain", reason: "transport" };
  const stale = status.response;
  const command: ProjectAlphaProjectRefreshCommand = {
    commandId: input.commandId,
    externalId: input.externalProjectId,
    expectedPublicId: stale.binding.publicId,
    expectedPriorRevision: stale.binding.revision,
    expectedRevision: stale.resource.revision,
    expectedProjectionSha256: stale.resource.projectionSha256,
    expectedAuthorizationGeneration: stale.authorizationGeneration,
  };
  if (!isProjectAlphaProjectRefreshCommand(command)) return { status: "rejected", reason: "binding_stale_contract" };
  const canonical = canonicalProjectAlphaProjectRequest("refresh", command);
  if (!canonical) return { status: "rejected", reason: "binding_stale_contract" };
  const mapping = await env.OPS_DB.prepare(`SELECT mapping.project_alpha_public_id
    FROM project_alpha_project_mappings mapping
    JOIN project_alpha_project_destinations destination ON destination.external_project_id=mapping.external_project_id
    WHERE mapping.external_project_id=? AND mapping.source_id=? AND mapping.source_instance_id=?
      AND mapping.application_id=? AND mapping.project_alpha_public_id=?
      AND destination.destination_base_url=? AND destination.expected_source_instance_id=?`)
    .bind(input.externalProjectId, input.sourceId, selected.expectedSourceInstanceId, selected.expectedApplicationId,
      command.expectedPublicId, selected.baseUrl, selected.expectedSourceInstanceId).first("project_alpha_public_id");
  if (!mapping) return { status: "blocked", reason: "mapping" };
  const requestSha256 = await digest(canonical.body);
  let outcomeStateVersion = 2;
  try {
    const priorReservation = await existing(env.OPS_DB, input.commandId);
    if (priorReservation?.state === "preflight_blocked") {
      const pendingStateVersion = (priorReservation.state_version ?? 0) + 1;
      outcomeStateVersion = pendingStateVersion + 1;
      await env.OPS_DB.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_events
        (command_id,state_version,transition_id,request_sha256,state) VALUES(?,?,?,?, 'pending')`)
        .bind(input.commandId, pendingStateVersion, crypto.randomUUID(), requestSha256).run();
    } else await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_commands
        (command_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,external_project_id,
         project_alpha_public_id,expected_prior_revision,expected_live_revision,expected_projection_sha256,
         expected_authorization_generation,destination_base_url)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId, requestSha256, input.sourceId,
        selected.expectedSourceInstanceId, selected.expectedApplicationId,
        selected.expectedHistoryEpoch, command.externalId, command.expectedPublicId,
        command.expectedPriorRevision, command.expectedRevision, command.expectedProjectionSha256,
        command.expectedAuthorizationGeneration, selected.baseUrl),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_events
        (command_id,state_version,transition_id,request_sha256,state) VALUES(?,1,?,?, 'pending')`)
        .bind(input.commandId, crypto.randomUUID(), requestSha256),
    ]);
  } catch {
    return (await priorOutcome(env.OPS_DB, input, selected)) ?? { status: "uncertain", reason: "database" };
  }

  const outcome = await sendProjectAlphaProjectRefreshCommand(selected, command, fetcher);
  if (outcome.status === "blocked" && outcome.reason === "preflight") {
    try { await appendPreflightBlocked(env.OPS_DB, input.commandId, requestSha256, outcomeStateVersion); } catch { return { status: "uncertain", reason: "database" }; }
    return { status: "blocked", reason: "no_send_preflight" };
  }
  if (outcome.status !== "acknowledged" || !isProjectAlphaProjectRefreshAcknowledgement(outcome, command, selected)) {
    try { await appendUncertain(env.OPS_DB, input.commandId, requestSha256, outcomeStateVersion); } catch { return { status: "uncertain", reason: "database" }; }
    return { status: "uncertain", reason: outcome.status === "uncertain" ? "transport" : "invalid_contract" };
  }
  const response = outcome.response;
  let postStatusConfirmed = false;
  const after = await readConfiguredProjectAlphaProjectBindingStatus(env, input.sourceId, input.externalProjectId, fetcher);
  if (after.status === "observed") {
    postStatusConfirmed = after.response.binding.publicId === command.expectedPublicId
      && after.response.resource.revision === command.expectedRevision
      && after.response.resource.projectionSha256 === command.expectedProjectionSha256;
  }
  const responseSha256 = await digest(JSON.stringify(response));
  const receiptId = crypto.randomUUID();
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_events
        (command_id,state_version,transition_id,request_sha256,state) VALUES(?,?,?,?, 'acknowledged')`)
        .bind(input.commandId, outcomeStateVersion, crypto.randomUUID(), requestSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_binding_revision_refresh_receipts
        (receipt_id,command_id,request_sha256,source_instance_id,application_id,history_epoch_id,external_project_id,
         project_alpha_public_id,prior_revision,live_revision,projection_sha256,authorization_generation,pa_request_id,
         pa_replayed,response_sha256,post_status_confirmed)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptId, input.commandId, requestSha256,
        response.sourceInstanceId, response.applicationId, response.historyEpoch, response.result.resource.id,
        response.result.resource.publicId, command.expectedPriorRevision, response.result.resource.revision,
        response.result.resource.projectionSha256, response.result.authorizationGeneration, response.requestId,
        response.replayed ? 1 : 0, responseSha256, postStatusConfirmed ? 1 : 0),
    ]);
  } catch { return { status: "uncertain", reason: "database" }; }
  return { status: "acknowledged", receiptId, replayed: response.replayed, postStatusConfirmed };
}
