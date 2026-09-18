/**
 * Finalizer for the Project Alpha project-v2 evidence chain. It performs no
 * network I/O and is reachable only through the default-off administrator
 * acceptance composition. Do not import it from any other route, queue,
 * scheduler, Durable Object, service entrypoint, or worker index.
 */
export type ProjectAlphaProjectCanonicalActivationEnvironment = Readonly<{ OPS_DB: D1Database }>;

type Operation = "create" | "update" | "bind";
type Candidate = Readonly<{
  settlement_id: string;
  command_id: string;
  operation: Operation;
  external_project_id: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  prior_local_version: number;
  read_json: string;
  expected_local_projection_sha256: string | null;
  expected_mapping_state: "absent" | "exact";
  expected_project_alpha_public_id: string | null;
  expected_grant_generation: number;
  outbox_state: string;
  outbox_operation: string;
  outbox_external_project_id: string;
  outbox_source_id: string;
  outbox_source_instance_id: string;
  outbox_application_id: string;
  outbox_history_epoch_id: string;
  live_grant_generation: number | null;
  scopes_json: string | null;
}>;
type Head = Readonly<{
  current_version: number;
  canonical_projection_sha256: string | null;
  source_id: string | null;
  source_instance_id: string | null;
  application_id: string | null;
  history_epoch_id: string | null;
  project_alpha_public_id: string | null;
}>;
type Mapping = Readonly<{
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  project_alpha_public_id: string;
}>;
type Activation = Readonly<{
  activation_id: string;
  settlement_id: string;
  command_id: string;
  external_project_id: string;
  operation: Operation;
  prior_local_version: number;
  resulting_local_version: number;
}>;
type ProjectData = Readonly<{
  name: string;
  description: string | null;
  status: "not_started" | "active" | "completed" | "cancelled";
  archived: boolean;
  overdueWarning: boolean;
  completedAt: string | null;
  archivedAt: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  clientPublicId: string | null;
  organizationPublicId: string | null;
}>;

export type ProjectAlphaProjectCanonicalActivationOutcome =
  | Readonly<{ status: "activated"; activationId: string; settlementId: string; commandId: string; externalProjectId: string; version: number; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_settlement" }>
  | Readonly<{ status: "blocked"; reason: "missing_settlement" | "authority" | "stale" | "directory" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function replay(value: Activation): ProjectAlphaProjectCanonicalActivationOutcome {
  return { status: "activated", activationId: value.activation_id, settlementId: value.settlement_id,
    commandId: value.command_id, externalProjectId: value.external_project_id,
    version: value.resulting_local_version, replayed: true };
}
async function stored(db: D1Database, settlementId: string): Promise<Activation | null> {
  return db.prepare(`SELECT activation_id,settlement_id,command_id,external_project_id,operation,
      prior_local_version,resulting_local_version
    FROM project_alpha_project_v2_canonical_activation_receipts WHERE settlement_id=?`)
    .bind(settlementId).first<Activation>();
}
async function candidate(db: D1Database, settlementId: string): Promise<Candidate | null> {
  return db.prepare(`SELECT settlement.settlement_id,settlement.command_id,settlement.operation,
      settlement.external_project_id,settlement.source_id,settlement.source_instance_id,
      settlement.application_id,settlement.history_epoch_id,settlement.project_alpha_public_id,
      settlement.project_alpha_revision,settlement.projection_sha256,settlement.prior_local_version,
      settlement.read_json,intent.expected_local_projection_sha256,intent.expected_mapping_state,
      intent.expected_project_alpha_public_id,intent.expected_grant_generation,
      outbox.state outbox_state,outbox.operation outbox_operation,
      outbox.external_project_id outbox_external_project_id,outbox.source_id outbox_source_id,
      outbox.expected_source_instance_id outbox_source_instance_id,
      outbox.application_id outbox_application_id,outbox.expected_history_epoch_id outbox_history_epoch_id,
      proof.grant_generation live_grant_generation,proof.scopes_json
    FROM project_alpha_project_v2_canonical_settlement_receipts settlement
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=settlement.command_id
    LEFT JOIN native_project_live_command_proofs proof ON proof.command_id=settlement.command_id
      AND proof.external_project_id=settlement.external_project_id
      AND proof.grant_generation=intent.expected_grant_generation
      AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE settlement.settlement_id=?`).bind(settlementId).first<Candidate>();
}
async function head(db: D1Database, externalProjectId: string): Promise<Head | null> {
  return db.prepare(`SELECT current_version,canonical_projection_sha256,source_id,source_instance_id,
      application_id,history_epoch_id,project_alpha_public_id
    FROM operations_shared_projects WHERE external_project_id=?`).bind(externalProjectId).first<Head>();
}
async function mapping(db: D1Database, externalProjectId: string): Promise<Mapping | null> {
  return db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
    FROM project_alpha_project_mappings WHERE external_project_id=?`).bind(externalProjectId).first<Mapping>();
}
function sameMapping(value: Mapping | null, source: Candidate): boolean {
  if (source.expected_mapping_state === "absent") return value === null;
  return !!value && value.source_id === source.source_id && value.source_instance_id === source.source_instance_id
    && value.application_id === source.application_id && value.history_epoch_id === source.history_epoch_id
    && value.project_alpha_public_id === source.expected_project_alpha_public_id;
}
function sameHead(value: Head | null, source: Candidate): boolean {
  if (source.prior_local_version === 0) return value === null;
  if (!value || value.current_version !== source.prior_local_version
    || value.canonical_projection_sha256 !== source.expected_local_projection_sha256) return false;
  return source.expected_mapping_state === "absent"
    ? value.source_id === null && value.source_instance_id === null && value.application_id === null
      && value.history_epoch_id === null && value.project_alpha_public_id === null
    : value.source_id === source.source_id && value.source_instance_id === source.source_instance_id
      && value.application_id === source.application_id && value.history_epoch_id === source.history_epoch_id
      && value.project_alpha_public_id === source.expected_project_alpha_public_id;
}
function exactOutbox(source: Candidate): boolean {
  return source.outbox_state === "pending" && source.outbox_operation === source.operation
    && source.outbox_external_project_id === source.external_project_id
    && source.outbox_source_id === source.source_id
    && source.outbox_source_instance_id === source.source_instance_id
    && source.outbox_application_id === source.application_id
    && source.outbox_history_epoch_id === source.history_epoch_id;
}
async function directoryRecord(db: D1Database, source: Candidate, type: "organization" | "client", publicId: string | null): Promise<string | null | "missing"> {
  if (publicId === null) return null;
  const rows = await db.prepare(`SELECT mapping.external_id
    FROM project_alpha_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind=?
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=?
      AND mapping.history_epoch_id=? AND mapping.resource_type=? AND mapping.project_alpha_public_id=?`)
    .bind(type, source.source_id, source.source_instance_id, source.application_id,
      source.history_epoch_id, type, publicId).all<{ external_id: string }>();
  return rows.results.length === 1 ? rows.results[0]!.external_id : "missing";
}
async function state(db: D1Database, source: Candidate): Promise<"ok" | "authority" | "stale"> {
  if (source.live_grant_generation !== source.expected_grant_generation || source.scopes_json === null) return "authority";
  const [liveHead, liveMapping] = await Promise.all([head(db, source.external_project_id), mapping(db, source.external_project_id)]);
  return exactOutbox(source) && sameHead(liveHead, source) && sameMapping(liveMapping, source) ? "ok" : "stale";
}

/**
 * Applies a previously validated private GET settlement. Replays are served
 * solely from the immutable activation receipt; no HTTP client is accepted or
 * used. Every first application rechecks current proof, head, mapping, outbox,
 * and directory identities, then changes all canonical rows in one D1 batch.
 */
export async function activateProjectAlphaProjectV2Canonical(
  env: ProjectAlphaProjectCanonicalActivationEnvironment,
  settlementId: string,
): Promise<ProjectAlphaProjectCanonicalActivationOutcome> {
  if (!UUID.test(settlementId)) return { status: "rejected", reason: "invalid_settlement" };
  try {
    const prior = await stored(env.OPS_DB, settlementId);
    if (prior) return replay(prior);
  } catch { return { status: "uncertain", reason: "database" }; }

  let source: Candidate;
  try {
    const found = await candidate(env.OPS_DB, settlementId);
    if (!found) return { status: "blocked", reason: "missing_settlement" };
    source = found;
  } catch { return { status: "uncertain", reason: "database" }; }
  const before = await state(env.OPS_DB, source).catch(() => "database" as const);
  if (before !== "ok") return before === "database" ? { status: "uncertain", reason: "database" }
    : { status: "blocked", reason: before };

  let data: ProjectData;
  try { data = (JSON.parse(source.read_json) as { data: ProjectData }).data; }
  catch { return { status: "uncertain", reason: "database" }; }
  let organizationRecordId: string | null | "missing", clientRecordId: string | null | "missing";
  try {
    [organizationRecordId, clientRecordId] = await Promise.all([
      directoryRecord(env.OPS_DB, source, "organization", data.organizationPublicId),
      directoryRecord(env.OPS_DB, source, "client", data.clientPublicId),
    ]);
    if (organizationRecordId === "missing" || clientRecordId === "missing") return { status: "blocked", reason: "directory" };
    if (organizationRecordId && clientRecordId) {
      const linked = await env.OPS_DB.prepare(`SELECT 1 linked FROM operations_directory_client_organizations
        WHERE client_record_id=? AND organization_record_id=?`).bind(clientRecordId, organizationRecordId).first("linked");
      if (!linked) return { status: "blocked", reason: "directory" };
    }
  } catch { return { status: "uncertain", reason: "database" }; }

  const activationId = crypto.randomUUID(), leaseToken = crypto.randomUUID();
  const resultingVersion = source.prior_local_version === 0 ? 1 : source.prior_local_version + 1;
  const outcomeJson = JSON.stringify({ projectV2ActivationId: activationId, settlementId: source.settlement_id });
  const statements: D1PreparedStatement[] = [
    env.OPS_DB.prepare(`UPDATE project_alpha_project_outbox SET state='leased',attempts=attempts+1,
      lease_token=?,lease_expires_at=unixepoch('now')+300,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND state='pending' AND operation=? AND external_project_id=? AND source_id=?
        AND expected_source_instance_id=? AND application_id=? AND expected_history_epoch_id=?`)
      .bind(leaseToken, source.command_id, source.operation, source.external_project_id, source.source_id,
        source.source_instance_id, source.application_id, source.history_epoch_id),
  ];
  if (source.expected_mapping_state === "absent") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_project_mappings(
      external_project_id,source_id,source_instance_id,application_id,project_alpha_public_id,
      establishment_kind,establishment_command_id,create_command_id,history_epoch_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(source.external_project_id, source.source_id, source.source_instance_id,
      source.application_id, source.project_alpha_public_id, source.operation, source.command_id,
      source.operation === "create" ? source.command_id : null, source.history_epoch_id));
  }
  if (source.prior_local_version === 0) {
    statements.push(env.OPS_DB.prepare(`INSERT INTO operations_shared_projects(
      external_project_id,source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id,
      pa_revision,current_version,name,lifecycle,planned_start,planned_end,organization_record_id,client_record_id,
      scopes_json,description,completed_at,archived,archived_at,canonical_projection_sha256,overdue_warning)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      source.external_project_id, source.source_id, source.source_instance_id, source.application_id,
      source.history_epoch_id, source.project_alpha_public_id, source.project_alpha_revision, data.name, data.status,
      data.estimatedStart, data.estimatedEnd, organizationRecordId, clientRecordId, source.scopes_json,
      data.description, data.completedAt, data.archived ? 1 : 0, data.archivedAt, source.projection_sha256,
      data.overdueWarning ? 1 : 0));
  } else {
    statements.push(env.OPS_DB.prepare(`UPDATE operations_shared_projects SET
      source_id=?,source_instance_id=?,application_id=?,history_epoch_id=?,project_alpha_public_id=?,
      pa_revision=?,current_version=current_version+1,name=?,lifecycle=?,planned_start=?,planned_end=?,
      organization_record_id=?,client_record_id=?,scopes_json=?,description=?,completed_at=?,archived=?,
      archived_at=?,canonical_projection_sha256=?,overdue_warning=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE external_project_id=? AND current_version=? AND canonical_projection_sha256 IS ?
        AND source_id IS ? AND source_instance_id IS ? AND application_id IS ?
        AND history_epoch_id IS ? AND project_alpha_public_id IS ?`)
      .bind(source.source_id, source.source_instance_id, source.application_id, source.history_epoch_id,
        source.project_alpha_public_id, source.project_alpha_revision, data.name, data.status, data.estimatedStart,
        data.estimatedEnd, organizationRecordId, clientRecordId, source.scopes_json, data.description,
        data.completedAt, data.archived ? 1 : 0, data.archivedAt, source.projection_sha256,
        data.overdueWarning ? 1 : 0, source.external_project_id, source.prior_local_version,
        source.expected_local_projection_sha256,
        source.expected_mapping_state === "exact" ? source.source_id : null,
        source.expected_mapping_state === "exact" ? source.source_instance_id : null,
        source.expected_mapping_state === "exact" ? source.application_id : null,
        source.expected_mapping_state === "exact" ? source.history_epoch_id : null,
        source.expected_mapping_state === "exact" ? source.expected_project_alpha_public_id : null));
  }
  statements.push(
    env.OPS_DB.prepare(`INSERT INTO operations_shared_project_revisions(
      external_project_id,version,pa_revision,read_json,refresh_command_id,v2_settlement_id)
      VALUES(?,?,NULL,?,NULL,?)`).bind(source.external_project_id, resultingVersion,
      source.read_json, source.settlement_id),
    env.OPS_DB.prepare(`UPDATE project_alpha_project_outbox SET state='acknowledged',lease_token=NULL,
      lease_expires_at=NULL,outcome_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND state='leased' AND lease_token=?`).bind(outcomeJson, source.command_id, leaseToken),
    env.OPS_DB.prepare(`INSERT INTO project_alpha_project_v2_canonical_activation_receipts(
      activation_id,settlement_id,command_id,external_project_id,operation,prior_local_version,
      resulting_local_version,organization_record_id,client_record_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(activationId, source.settlement_id, source.command_id,
      source.external_project_id, source.operation, source.prior_local_version, resultingVersion,
      organizationRecordId, clientRecordId),
  );

  try {
    await env.OPS_DB.batch(statements);
    return { status: "activated", activationId, settlementId: source.settlement_id,
      commandId: source.command_id, externalProjectId: source.external_project_id,
      version: resultingVersion, replayed: false };
  } catch {
    let winner = await stored(env.OPS_DB, settlementId).catch(() => null);
    if (winner) return replay(winner);
    const refreshed = await candidate(env.OPS_DB, settlementId).catch(() => null);
    winner = await stored(env.OPS_DB, settlementId).catch(() => null);
    if (winner) return replay(winner);
    const after = refreshed ? await state(env.OPS_DB, refreshed).catch(() => "database" as const) : "database";
    return after === "authority" ? { status: "blocked", reason: "authority" }
      : after === "stale" ? { status: "blocked", reason: "stale" }
        : { status: "uncertain", reason: "database" };
  }
}
