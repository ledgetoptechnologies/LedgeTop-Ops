import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import {
  privateProjectAlphaProjectReadEvidence,
  readProjectAlphaProject,
  validatedProjectAlphaProjectRead,
} from "./project-alpha-project-read-api-v2";
import { canonicalConnection, uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";

/**
 * Dormant, authenticated read evidence for a completed 0119 command. This
 * module is intentionally not imported by a route, queue, scheduler, or worker
 * index and 0120 keeps every resulting receipt inactive.
 */
export type ProjectAlphaProjectReadSettlementEnvironment = Readonly<{ OPS_DB: D1Database }>;
type Operation = "create" | "update" | "bind";
type Receipt = Readonly<{
  receipt_id: string;
  command_id: string;
  request_sha256: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  destination_origin: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  external_project_id: string;
  operation: Operation;
  source_id: string;
  outbox_destination: string;
  outbox_source_instance_id: string;
  outbox_application_id: string;
  outbox_history_epoch_id: string;
  grant_generation: number | null;
}>;
type Intent = Readonly<{
  command_id: string;
  request_sha256: string;
  operation: Operation;
  external_project_id: string;
  expected_local_version: number;
  expected_local_projection_sha256: string | null;
  expected_grant_generation: number;
  expected_mapping_state: "absent" | "exact";
  expected_project_alpha_public_id: string | null;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
}>;
type Head = Readonly<{ current_version: number; canonical_projection_sha256: string | null }>;
type Mapping = Readonly<{
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  project_alpha_public_id: string;
}>;
type StoredSettlement = Readonly<{ settlement_id: string; success_receipt_id: string; command_id: string }>;

export type ProjectAlphaProjectReadSettlementOutcome =
  | Readonly<{ status: "settled"; settlementId: string; successReceiptId: string; commandId: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_receipt" }>
  | Readonly<{ status: "blocked"; reason: "missing_receipt" | "authority" | "destination" | "stale" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "evidence" }>
  | ProjectAlphaProjectFailure;

function configuredOrigin(connection: ProjectAlphaApiV2Connection): string | null {
  try { return new URL(connection.baseUrl).origin; } catch { return null; }
}
async function stored(db: D1Database, receiptId: string): Promise<StoredSettlement | null> {
  return db.prepare(`SELECT settlement_id,success_receipt_id,command_id
    FROM project_alpha_project_v2_canonical_settlement_receipts WHERE success_receipt_id=?`)
    .bind(receiptId).first<StoredSettlement>();
}
function replay(value: StoredSettlement): ProjectAlphaProjectReadSettlementOutcome {
  return { status: "settled", settlementId: value.settlement_id, successReceiptId: value.success_receipt_id, commandId: value.command_id, replayed: true };
}
async function receipt(db: D1Database, receiptId: string): Promise<Receipt | null> {
  return db.prepare(`SELECT receipt.receipt_id,receipt.command_id,receipt.request_sha256,
      receipt.source_instance_id,receipt.application_id,receipt.history_epoch_id,receipt.destination_origin,
      receipt.project_alpha_public_id,receipt.project_alpha_revision,receipt.projection_sha256,
      outbox.external_project_id,outbox.operation,outbox.source_id,outbox.destination_base_url outbox_destination,
      outbox.expected_source_instance_id outbox_source_instance_id,outbox.application_id outbox_application_id,
      outbox.expected_history_epoch_id outbox_history_epoch_id,proof.grant_generation
    FROM project_alpha_project_v2_success_receipts receipt
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=receipt.command_id
    LEFT JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
      AND proof.external_project_id=outbox.external_project_id
      AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE receipt.receipt_id=? AND outbox.operation IN ('create','update','bind')`).bind(receiptId).first<Receipt>();
}
async function intent(db: D1Database, commandId: string): Promise<Intent | null> {
  return db.prepare(`SELECT command_id,request_sha256,operation,external_project_id,expected_local_version,
      expected_local_projection_sha256,expected_grant_generation,expected_mapping_state,
      expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id
    FROM project_alpha_project_v2_canonical_intents WHERE command_id=?`).bind(commandId).first<Intent>();
}
async function head(db: D1Database, externalProjectId: string): Promise<Head | null> {
  return db.prepare(`SELECT current_version,canonical_projection_sha256 FROM operations_shared_projects
    WHERE external_project_id=?`).bind(externalProjectId).first<Head>();
}
async function mapping(db: D1Database, externalProjectId: string): Promise<Mapping | null> {
  return db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
    FROM project_alpha_project_mappings WHERE external_project_id=?`).bind(externalProjectId).first<Mapping>();
}
function sameMapping(value: Mapping | null, expected: Intent): boolean {
  if (expected.expected_mapping_state === "absent") return value === null;
  return !!value && value.source_id === expected.source_id && value.source_instance_id === expected.source_instance_id
    && value.application_id === expected.application_id && value.history_epoch_id === expected.history_epoch_id
    && value.project_alpha_public_id === expected.expected_project_alpha_public_id;
}
async function current(db: D1Database, value: Intent): Promise<"ok" | "authority" | "stale"> {
  const proof = await db.prepare(`SELECT 1 present FROM native_project_live_command_proofs proof
    WHERE proof.command_id=? AND proof.external_project_id=? AND proof.grant_generation=?
      AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(value.command_id, value.external_project_id, value.expected_grant_generation).first("present");
  if (!proof) return "authority";
  const [liveHead, liveMapping] = await Promise.all([head(db, value.external_project_id), mapping(db, value.external_project_id)]);
  const exactHead = value.expected_local_version === 0 ? liveHead === null
    : !!liveHead && liveHead.current_version === value.expected_local_version
      && liveHead.canonical_projection_sha256 === value.expected_local_projection_sha256;
  return exactHead && sameMapping(liveMapping, value) ? "ok" : "stale";
}
function exactIntent(value: Intent, source: Receipt): boolean {
  return value.command_id === source.command_id && value.request_sha256 === source.request_sha256
    && value.operation === source.operation && value.external_project_id === source.external_project_id
    && value.source_id === source.source_id && value.source_instance_id === source.source_instance_id
    && value.application_id === source.application_id && value.history_epoch_id === source.history_epoch_id
    && value.expected_grant_generation === source.grant_generation;
}
async function reserveIntent(db: D1Database, source: Receipt): Promise<Intent | "authority" | "stale" | "database"> {
  const existing = await intent(db, source.command_id);
  if (existing) return exactIntent(existing, source) ? existing : "stale";
  if (source.grant_generation === null) return "authority";
  const [liveHead, liveMapping] = await Promise.all([head(db, source.external_project_id), mapping(db, source.external_project_id)]);
  if (liveHead && liveHead.canonical_projection_sha256 === null) return "stale";
  const expectsMapping = source.operation === "update";
  if (expectsMapping !== (liveMapping !== null)) return "stale";
  if (expectsMapping && (!liveMapping || liveMapping.source_id !== source.source_id
    || liveMapping.source_instance_id !== source.source_instance_id || liveMapping.application_id !== source.application_id
    || liveMapping.history_epoch_id !== source.history_epoch_id || liveMapping.project_alpha_public_id !== source.project_alpha_public_id)) return "stale";
  const expectedLocalVersion = liveHead?.current_version ?? 0;
  const candidate: Intent = {
    command_id: source.command_id, request_sha256: source.request_sha256, operation: source.operation,
    external_project_id: source.external_project_id, expected_local_version: expectedLocalVersion,
    expected_local_projection_sha256: liveHead?.canonical_projection_sha256 ?? null,
    expected_grant_generation: source.grant_generation, expected_mapping_state: expectsMapping ? "exact" : "absent",
    expected_project_alpha_public_id: expectsMapping ? source.project_alpha_public_id : null,
    source_id: source.source_id, source_instance_id: source.source_instance_id,
    application_id: source.application_id, history_epoch_id: source.history_epoch_id,
  };
  try {
    await db.prepare(`INSERT INTO project_alpha_project_v2_canonical_intents(
      command_id,request_sha256,operation,external_project_id,expected_local_version,
      expected_local_projection_sha256,expected_grant_generation,expected_mapping_state,
      expected_project_alpha_public_id,source_id,source_instance_id,application_id,history_epoch_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        source.command_id, source.request_sha256, source.operation, source.external_project_id, expectedLocalVersion,
        liveHead?.canonical_projection_sha256 ?? null, source.grant_generation, expectsMapping ? "exact" : "absent",
        expectsMapping ? source.project_alpha_public_id : null, source.source_id, source.source_instance_id,
        source.application_id, source.history_epoch_id,
      ).run();
  } catch {
    const winner = await intent(db, source.command_id).catch(() => null);
    if (!winner) {
      const fence = await current(db, candidate).catch(() => "database" as const);
      return fence === "ok" ? "database" : fence;
    }
    return exactIntent(winner, source) ? winner : "stale";
  }
  return await intent(db, source.command_id) ?? "database";
}

/**
 * Resume only after an immutable 0119 success receipt. It never retries the
 * command POST: the only remote work is capability discovery plus the private
 * authenticated project GET needed to mint exact raw-byte read evidence.
 */
export async function settleProjectAlphaProjectV2Read(
  env: ProjectAlphaProjectReadSettlementEnvironment,
  successReceiptId: string,
  connectionInput: ProjectAlphaApiV2Connection,
  fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaProjectReadSettlementOutcome> {
  if (!uuid(successReceiptId)) return { status: "rejected", reason: "invalid_receipt" };
  try {
    const completed = await stored(env.OPS_DB, successReceiptId);
    if (completed) return replay(completed);
  } catch { return { status: "uncertain", reason: "database" }; }

  const connection = canonicalConnection(connectionInput), destinationOrigin = connection && configuredOrigin(connection);
  if (!connection || !destinationOrigin) return { status: "blocked", reason: "destination" };
  let source: Receipt;
  try {
    const found = await receipt(env.OPS_DB, successReceiptId); if (!found) return { status: "blocked", reason: "missing_receipt" }; source = found;
  } catch { return { status: "uncertain", reason: "database" }; }
  if (source.grant_generation === null) return { status: "blocked", reason: "authority" };
  let outboxOrigin: string | null = null; try { outboxOrigin = new URL(source.outbox_destination).origin; } catch { /* invalid is blocked below */ }
  if (destinationOrigin !== source.destination_origin || outboxOrigin !== source.destination_origin
    || connection.expectedSourceInstanceId !== source.source_instance_id || connection.expectedApplicationId !== source.application_id
    || connection.expectedHistoryEpoch !== source.history_epoch_id || source.outbox_source_instance_id !== source.source_instance_id
    || source.outbox_application_id !== source.application_id || source.outbox_history_epoch_id !== source.history_epoch_id)
    return { status: "blocked", reason: "destination" };

  let reserved: Intent | "authority" | "stale" | "database";
  try { reserved = await reserveIntent(env.OPS_DB, source); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (typeof reserved === "string") return reserved === "database" ? { status: "uncertain", reason: "database" } : { status: "blocked", reason: reserved };
  const before = await current(env.OPS_DB, reserved).catch(() => "database" as const);
  if (before !== "ok") return before === "database" ? { status: "uncertain", reason: "database" } : { status: "blocked", reason: before };

  const outcome = await readProjectAlphaProject(connection, source.project_alpha_public_id, fetcher);
  if (outcome.status !== "read") return outcome;
  const evidence = privateProjectAlphaProjectReadEvidence(validatedProjectAlphaProjectRead(outcome));
  const response = evidence?.response;
  if (!evidence || !response || evidence.destinationOrigin !== source.destination_origin
    || evidence.requestedPublicId !== source.project_alpha_public_id
    || response.sourceInstanceId !== source.source_instance_id || response.applicationId !== source.application_id
    || response.historyEpoch !== source.history_epoch_id || response.resource.id !== source.project_alpha_public_id
    || response.resource.revision !== source.project_alpha_revision || response.resource.projectionSha256 !== source.projection_sha256)
    return { status: "uncertain", reason: "evidence" };

  const settlementId = crypto.randomUUID();
  try {
    await env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_canonical_settlement_receipts(
      settlement_id,success_receipt_id,command_id,operation,external_project_id,source_id,source_instance_id,
      application_id,history_epoch_id,project_alpha_public_id,project_alpha_revision,projection_sha256,
      prior_local_version,resulting_local_version,read_request_id,read_response_sha256,read_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        settlementId, source.receipt_id, source.command_id, source.operation, source.external_project_id, source.source_id,
        source.source_instance_id, source.application_id, source.history_epoch_id, source.project_alpha_public_id,
        source.project_alpha_revision, source.projection_sha256, reserved.expected_local_version,
        reserved.expected_local_version, response.requestId, evidence.responseSha256, evidence.responseJson,
      ).run();
    return { status: "settled", settlementId, successReceiptId: source.receipt_id, commandId: source.command_id, replayed: false };
  } catch {
    const winner = await stored(env.OPS_DB, source.receipt_id).catch(() => null);
    if (winner) return replay(winner);
    const fence = await current(env.OPS_DB, reserved).catch(() => "database" as const);
    return fence === "authority" ? { status: "blocked", reason: "authority" }
      : fence === "stale" ? { status: "blocked", reason: "stale" }
        : { status: "uncertain", reason: "database" };
  }
}
