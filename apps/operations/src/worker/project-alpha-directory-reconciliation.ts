import {
  readConfiguredProjectAlphaDirectoryInventory,
  type ProjectAlphaDirectoryInventoryOutcome,
  type ProjectAlphaDirectoryInventoryResource,
  type ProjectAlphaDirectoryInventorySuccess,
} from "./project-alpha-directory-inventory-api-v2";
import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
  type ProjectAlphaDirectoryBindingStatusOutcome,
  type ProjectAlphaDirectoryProfileReadOutcome,
} from "./project-alpha-directory-read-api-v2";
import type { ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";

const SOURCE_ID = /^project-alpha:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_PAGE_SIZE = 100, DEFAULT_MAX_PAGES = 8, DEFAULT_MAX_ITEMS = 800, DEFAULT_TIME_BUDGET_MS = 30_000;

export type ProjectAlphaDirectoryDriftClassification =
  | "missing_remote" | "extra_remote" | "public_id_mismatch" | "external_id_mismatch"
  | "revision_mismatch" | "projection_mismatch" | "presence_mismatch" | "binding_mismatch"
  | "relationship_mismatch";

export type ProjectAlphaDirectoryReconciliationResult = Readonly<{
  sourceId: string;
  runId: string;
  status: "complete" | "uncertain";
  reason?: string;
  pages: number;
  items: number;
  findings: number;
  previousCompleteRunId: string | null;
}>;

type ReconciliationEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type InventoryReader = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string,
  query: Readonly<{ type: "all"; cursor: string | null; limit: number }>, send: typeof fetch) => Promise<ProjectAlphaDirectoryInventoryOutcome>;
type ProfileReader = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: "client" | "organization",
  publicId: string, send: typeof fetch) => Promise<ProjectAlphaDirectoryProfileReadOutcome>;
type BindingReader = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: "client" | "organization",
  externalId: string, publicId: string, send: typeof fetch) => Promise<ProjectAlphaDirectoryBindingStatusOutcome>;

export type ProjectAlphaDirectoryReconciliationOptions = Readonly<{
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  timeBudgetMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  runId?: () => string;
  readers?: Readonly<{ inventory: InventoryReader; profile: ProfileReader; binding: BindingReader }>;
}>;

type LocalResource = Readonly<{
  resourceType: "client" | "organization";
  externalId: string;
  publicId: string;
  expectedRevision: string | null;
  relationshipKnown: number;
  relationshipPublicId: string | null;
}>;
type PriorResource = Readonly<{ revision: string; projectionSha256: string }>;
type RemoteResource = ProjectAlphaDirectoryInventoryResource & Readonly<{
  profileOrganizationPublicId?: string | null;
}>;
type Finding = Readonly<{
  classification: ProjectAlphaDirectoryDriftClassification;
  resourceType: "client" | "organization";
  localExternalId: string | null;
  localPublicId: string | null;
  remotePublicId: string | null;
  details: Record<string, unknown>;
}>;

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number | null {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved >= minimum && resolved <= maximum ? resolved : null;
}
function key(type: "client" | "organization", id: string): string { return `${type}:${id}`; }
function iso(now: number): string { return new Date(now).toISOString(); }
function outcomeReason(value: { status: string; reason?: string; httpStatus?: number }): string {
  return value.httpStatus === 429 ? "rate_limited" : value.reason ?? value.status;
}
function findingKey(value: Finding): string {
  return [value.classification, value.resourceType, value.localExternalId ?? "", value.localPublicId ?? "", value.remotePublicId ?? ""].join("\u0000");
}
function addFinding(findings: Map<string, Finding>, value: Finding): void { findings.set(findingKey(value), value); }

async function localResources(db: D1Database, sourceId: string,
  fence: Readonly<{ sourceInstanceId: string; applicationId: string; historyEpoch: string }>,
  maximum: number): Promise<LocalResource[] | null> {
  const rows = await db.prepare(`SELECT mapping.resource_type resourceType,mapping.external_id externalId,
      mapping.project_alpha_public_id publicId,
      COALESCE((SELECT json_extract(evidence.outcome_json,'$.response.result.resource.revision')
        FROM project_alpha_directory_outbox evidence
        WHERE evidence.source_id=mapping.source_id AND evidence.expected_source_instance_id=mapping.source_instance_id
          AND evidence.application_id=mapping.application_id AND evidence.expected_history_epoch_id=mapping.history_epoch_id
          AND evidence.resource_type=mapping.resource_type AND evidence.external_id=mapping.external_id
          AND evidence.state='acknowledged'
          AND json_type(evidence.outcome_json,'$.response.result.resource.revision')='text'
        ORDER BY length(json_extract(evidence.outcome_json,'$.response.result.resource.revision')) DESC,
          json_extract(evidence.outcome_json,'$.response.result.resource.revision') DESC LIMIT 1),
        acquired.project_alpha_revision) expectedRevision,
      CASE WHEN relation.client_record_id IS NULL THEN 0 ELSE 1 END relationshipKnown,
      parent.project_alpha_public_id relationshipPublicId
    FROM project_alpha_active_directory_mappings mapping
    LEFT JOIN project_alpha_existing_directory_binding_activation_receipts acquired
      ON mapping.mapping_kind='acquired' AND acquired.activation_id=mapping.provenance_id
    LEFT JOIN operations_directory_client_organizations relation
      ON mapping.resource_type='client' AND relation.client_record_id=mapping.external_id
    LEFT JOIN project_alpha_active_directory_mappings parent
      ON parent.source_id=mapping.source_id AND parent.source_instance_id=mapping.source_instance_id
      AND parent.application_id=mapping.application_id AND parent.history_epoch_id=mapping.history_epoch_id
      AND parent.resource_type='organization' AND parent.external_id=relation.organization_record_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=?
      AND mapping.history_epoch_id=?
    ORDER BY mapping.resource_type,mapping.project_alpha_public_id LIMIT ?`)
    .bind(sourceId, fence.sourceInstanceId, fence.applicationId, fence.historyEpoch, maximum + 1).all<LocalResource>();
  return rows.results.length > maximum ? null : rows.results;
}

async function priorResources(db: D1Database, runId: string | null): Promise<Map<string, PriorResource>> {
  const result = new Map<string, PriorResource>();
  if (!runId) return result;
  const rows = await db.prepare(`SELECT resource_type resourceType,public_id publicId,revision,
      projection_sha256 projectionSha256 FROM project_alpha_directory_reconciliation_observations WHERE run_id=?`)
    .bind(runId).all<{ resourceType: "client" | "organization"; publicId: string; revision: string; projectionSha256: string }>();
  for (const row of rows.results) result.set(key(row.resourceType, row.publicId), row);
  return result;
}

async function setUncertain(db: D1Database, sourceId: string, runId: string, reason: string,
  pages: number, items: number, cursor: string | null, now: number, previous: string | null): Promise<ProjectAlphaDirectoryReconciliationResult> {
  const at = iso(now);
  await db.batch([
    db.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='uncertain',failure_reason=?,cursor=?,
      pages_observed=?,items_observed=?,completed_at=? WHERE run_id=? AND status='running'`)
      .bind(reason, cursor, pages, items, at, runId),
    db.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=NULL,cursor=NULL,
      pages_observed=?,items_observed=?,updated_at=? WHERE source_id=? AND active_run_id=?`)
      .bind(pages, items, at, sourceId, runId),
  ]);
  return { sourceId, runId, status: "uncertain", reason, pages, items, findings: 0, previousCompleteRunId: previous };
}

function observationStatement(db: D1Database, runId: string, ordinal: number,
  resource: ProjectAlphaDirectoryInventoryResource, observedAt: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO project_alpha_directory_reconciliation_observations(run_id,ordinal,resource_type,
    public_id,revision,present,last_action,projection_sha256,binding_external_id,binding_status,
    binding_resource_revision,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(runId, ordinal,
      resource.type, resource.publicId, resource.revision, resource.present ? 1 : 0, resource.lastAction,
      resource.projectionSha256, resource.binding?.externalId ?? null, resource.binding?.status ?? null,
      resource.binding?.resourceRevision ?? null, observedAt);
}

async function beforeDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T | null> {
  if (remainingMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remainingMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function finishComplete(db: D1Database, sourceId: string, runId: string, previous: string | null,
  fence: Readonly<{ sourceInstanceId: string; applicationId: string; historyEpoch: string; authorizationGeneration: string }>,
  pages: number, items: number, locals: number, findings: Map<string, Finding>, now: number): Promise<ProjectAlphaDirectoryReconciliationResult> {
  const at = iso(now), values = [...findings.values()];
  for (let offset = 0; offset < values.length; offset += 100) {
    await db.batch(values.slice(offset, offset + 100).map(finding => db.prepare(`INSERT INTO
      project_alpha_directory_reconciliation_findings(finding_id,run_id,source_id,classification,resource_type,
      local_external_id,local_public_id,remote_public_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), runId, sourceId, finding.classification, finding.resourceType,
        finding.localExternalId, finding.localPublicId, finding.remotePublicId, JSON.stringify(finding.details), at)));
  }
  try { await db.batch([
    db.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='complete',cursor=NULL,pages_observed=?,
      items_observed=?,local_items_observed=?,completed_at=? WHERE run_id=? AND status='running'`)
      .bind(pages, items, locals, at, runId),
    db.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=NULL,complete_run_id=?,
      cursor=NULL,pages_observed=?,items_observed=?,source_instance_id=?,application_id=?,history_epoch_id=?,
      authorization_generation=?,updated_at=? WHERE source_id=? AND active_run_id=?`)
      .bind(runId, pages, items, fence.sourceInstanceId, fence.applicationId, fence.historyEpoch,
        fence.authorizationGeneration, at, sourceId, runId),
  ]); } catch {
    return { sourceId, runId, status: "uncertain", reason: "ownership_lost", pages, items,
      findings: findings.size, previousCompleteRunId: previous };
  }
  return { sourceId, runId, status: "complete", pages, items, findings: findings.size, previousCompleteRunId: previous };
}

/**
 * Performs a bounded, fail-closed, read-only remote reconciliation. Its only
 * writes are to the 0136 observation/checkpoint/finding ledger.
 */
export async function reconcileProjectAlphaDirectorySource(env: ReconciliationEnvironment, sourceId: string,
  options: ProjectAlphaDirectoryReconciliationOptions = {}): Promise<ProjectAlphaDirectoryReconciliationResult> {
  const pageSize = integer(options.pageSize, DEFAULT_PAGE_SIZE, 1, 200);
  const maxPages = integer(options.maxPages, DEFAULT_MAX_PAGES, 1, 32);
  const maxItems = integer(options.maxItems, DEFAULT_MAX_ITEMS, 1, 5_000);
  const timeBudgetMs = integer(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 1, 120_000);
  // Keep the Web Crypto receiver: Workers may reject an extracted method as an
  // illegal invocation, while injected test ID factories do not exercise it.
  const now = options.now ?? Date.now, runIdFactory = options.runId ?? (() => crypto.randomUUID());
  const fetcher = options.fetcher ?? fetch;
  const readers = options.readers ?? { inventory: readConfiguredProjectAlphaDirectoryInventory,
    profile: readConfiguredProjectAlphaDirectoryProfile, binding: readConfiguredProjectAlphaDirectoryBindingStatus };
  const runId = runIdFactory(), started = now();
  if (!SOURCE_ID.test(sourceId) || !pageSize || !maxPages || !maxItems || !timeBudgetMs) {
    return { sourceId, runId, status: "uncertain", reason: "configuration", pages: 0, items: 0, findings: 0, previousCompleteRunId: null };
  }
  const checkpoint = await env.OPS_DB.prepare(`SELECT checkpoint.active_run_id activeRunId,
      checkpoint.complete_run_id completeRunId,checkpoint.cursor activeCursor,
      checkpoint.pages_observed activePages,checkpoint.items_observed activeItems,
      run.status activeStatus,run.started_at activeStartedAt
    FROM project_alpha_directory_reconciliation_checkpoints checkpoint
    LEFT JOIN project_alpha_directory_reconciliation_runs run ON run.run_id=checkpoint.active_run_id
    WHERE checkpoint.source_id=?`).bind(sourceId)
    .first<{ activeRunId: string | null; completeRunId: string | null; activeCursor: string | null;
      activePages: number; activeItems: number; activeStatus: string | null; activeStartedAt: string | null }>();
  if (checkpoint?.activeRunId && checkpoint.activeStatus === "running") {
    const activeStarted = checkpoint.activeStartedAt ? Date.parse(checkpoint.activeStartedAt) : Number.NaN;
    if (Number.isFinite(activeStarted) && started - activeStarted < timeBudgetMs) {
      return { sourceId, runId: checkpoint.activeRunId, status: "uncertain", reason: "run_in_progress",
        pages: checkpoint.activePages, items: checkpoint.activeItems, findings: 0,
        previousCompleteRunId: checkpoint.completeRunId };
    }
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='uncertain',
        failure_reason='stale_run',completed_at=? WHERE run_id=? AND status='running'`)
        .bind(iso(started), checkpoint.activeRunId),
      env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=NULL,cursor=NULL,
        updated_at=? WHERE source_id=? AND active_run_id=?`).bind(iso(started), sourceId, checkpoint.activeRunId),
    ]);
  }
  const previous = checkpoint?.completeRunId ?? null, at = iso(started);
  const acquisition = await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,
      previous_complete_run_id,started_at) VALUES(?,?,'running',?,?)`).bind(runId, sourceId, previous, at),
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_reconciliation_checkpoints(source_id,active_run_id,
      complete_run_id,cursor,pages_observed,items_observed,updated_at) VALUES(?,NULL,?,NULL,0,0,?)
      ON CONFLICT(source_id) DO NOTHING`).bind(sourceId, previous, at),
    env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=?,cursor=NULL,
      pages_observed=0,items_observed=0,updated_at=? WHERE source_id=? AND active_run_id IS NULL`)
      .bind(runId, at, sourceId),
  ]);
  if (Number(acquisition[2]?.meta.changes ?? 0) !== 1) {
    await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='uncertain',
      failure_reason='ownership_not_acquired',completed_at=? WHERE run_id=? AND status='running'`).bind(at, runId).run();
    const owner = await env.OPS_DB.prepare(`SELECT active_run_id activeRunId FROM
      project_alpha_directory_reconciliation_checkpoints WHERE source_id=?`).bind(sourceId)
      .first<{ activeRunId: string | null }>();
    return { sourceId, runId: owner?.activeRunId ?? runId, status: "uncertain", reason: "run_in_progress",
      pages: 0, items: 0, findings: 0, previousCompleteRunId: previous };
  }

  const prior = await priorResources(env.OPS_DB, previous);
  const remote = new Map<string, RemoteResource>();
  let cursor: string | null = null, pages = 0, ordinal = 0, previousRemoteKey = "";
  const seenCursors = new Set<string>();
  let fence: { sourceInstanceId: string; applicationId: string; historyEpoch: string; authorizationGeneration: string } | null = null;
  for (;;) {
    if (now() - started >= timeBudgetMs) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, cursor, now(), previous);
    if (pages >= maxPages) return setUncertain(env.OPS_DB, sourceId, runId, "page_limit", pages, ordinal, cursor, now(), previous);
    const outcome: ProjectAlphaDirectoryInventoryOutcome | null = await beforeDeadline(readers.inventory(env, sourceId,
      { type: "all", cursor, limit: pageSize }, fetcher), timeBudgetMs - (now() - started));
    if (!outcome) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, cursor, now(), previous);
    if (outcome.status !== "observed") return setUncertain(env.OPS_DB, sourceId, runId, outcomeReason(outcome), pages, ordinal, cursor, now(), previous);
    const inventory: ProjectAlphaDirectoryInventorySuccess = outcome.inventory;
    const observedFence = { sourceInstanceId: inventory.sourceInstanceId, applicationId: inventory.applicationId,
      historyEpoch: inventory.historyEpoch, authorizationGeneration: inventory.authorizationGeneration };
    if (fence && (fence.sourceInstanceId !== observedFence.sourceInstanceId || fence.applicationId !== observedFence.applicationId
      || fence.historyEpoch !== observedFence.historyEpoch || fence.authorizationGeneration !== observedFence.authorizationGeneration)) {
      return setUncertain(env.OPS_DB, sourceId, runId, "fence_changed", pages, ordinal, cursor, now(), previous);
    }
    fence ??= observedFence;
    if (ordinal + inventory.resources.length > maxItems) return setUncertain(env.OPS_DB, sourceId, runId, "item_limit", pages, ordinal, cursor, now(), previous);
    const statements: D1PreparedStatement[] = [];
    for (const item of inventory.resources) {
      const resourceKey = key(item.type, item.publicId);
      if (remote.has(resourceKey) || (previousRemoteKey && resourceKey <= previousRemoteKey))
        return setUncertain(env.OPS_DB, sourceId, runId, "duplicate_or_order", pages, ordinal, cursor, now(), previous);
      previousRemoteKey = resourceKey;
      remote.set(resourceKey, item); statements.push(observationStatement(env.OPS_DB, runId, ordinal++, item, iso(now())));
    }
    pages += 1;
    if (statements.length) {
      try { await env.OPS_DB.batch(statements); }
      catch { return setUncertain(env.OPS_DB, sourceId, runId, "ownership_lost", pages, ordinal, cursor, now(), previous); }
    }
    const progress = await env.OPS_DB.batch([
      env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET source_instance_id=?,application_id=?,
        history_epoch_id=?,authorization_generation=?,cursor=?,pages_observed=?,items_observed=? WHERE run_id=? AND status='running'`)
        .bind(fence.sourceInstanceId, fence.applicationId, fence.historyEpoch, fence.authorizationGeneration,
          inventory.nextCursor, pages, ordinal, runId),
      env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET cursor=?,pages_observed=?,
        items_observed=?,source_instance_id=?,application_id=?,history_epoch_id=?,authorization_generation=?,updated_at=?
        WHERE source_id=? AND active_run_id=?`).bind(inventory.nextCursor, pages, ordinal, fence.sourceInstanceId,
          fence.applicationId, fence.historyEpoch, fence.authorizationGeneration, iso(now()), sourceId, runId),
    ]);
    if (Number(progress[1]?.meta.changes ?? 0) !== 1)
      return setUncertain(env.OPS_DB, sourceId, runId, "ownership_lost", pages, ordinal, cursor, now(), previous);
    if (inventory.nextCursor === null) break;
    if (inventory.nextCursor === cursor || seenCursors.has(inventory.nextCursor))
      return setUncertain(env.OPS_DB, sourceId, runId, "duplicate_or_order", pages, ordinal, cursor, now(), previous);
    seenCursors.add(inventory.nextCursor);
    cursor = inventory.nextCursor;
  }
  if (!fence) return setUncertain(env.OPS_DB, sourceId, runId, "invalid_contract", pages, ordinal, cursor, now(), previous);
  const locals = await localResources(env.OPS_DB, sourceId, fence, maxItems);
  if (!locals) return setUncertain(env.OPS_DB, sourceId, runId, "item_limit", pages, ordinal, null, now(), previous);

  const localByPublic = new Map(locals.map(item => [key(item.resourceType, item.publicId), item]));
  const localByExternal = new Map(locals.map(item => [key(item.resourceType, item.externalId), item]));
  const findings = new Map<string, Finding>();
  for (const local of locals) {
    const found = remote.get(key(local.resourceType, local.publicId));
    if (!found) {
      const byExternal = [...remote.values()].find(item => item.type === local.resourceType && item.binding?.externalId === local.externalId);
      addFinding(findings, { classification: byExternal ? "public_id_mismatch" : "missing_remote", resourceType: local.resourceType,
        localExternalId: local.externalId, localPublicId: local.publicId, remotePublicId: byExternal?.publicId ?? null,
        details: byExternal ? { expected: local.publicId, observed: byExternal.publicId } : { expectedPresent: true } });
      continue;
    }
    if (!found.present) addFinding(findings, { classification: "presence_mismatch", resourceType: local.resourceType,
      localExternalId: local.externalId, localPublicId: local.publicId, remotePublicId: found.publicId,
      details: { expected: true, observed: false, lastAction: found.lastAction } });
    if (local.expectedRevision && found.revision !== local.expectedRevision) addFinding(findings, { classification: "revision_mismatch",
      resourceType: local.resourceType, localExternalId: local.externalId, localPublicId: local.publicId,
      remotePublicId: found.publicId, details: { expected: local.expectedRevision, observed: found.revision } });
    const previousItem = prior.get(key(found.type, found.publicId));
    if (previousItem && previousItem.revision === found.revision && previousItem.projectionSha256 !== found.projectionSha256) {
      addFinding(findings, { classification: "projection_mismatch", resourceType: local.resourceType,
        localExternalId: local.externalId, localPublicId: local.publicId, remotePublicId: found.publicId,
        details: { revision: found.revision, expected: previousItem.projectionSha256, observed: found.projectionSha256 } });
    }
    if (!found.binding || found.binding.externalId !== local.externalId || found.binding.status !== (found.present ? "active" : "tombstoned")
      || found.binding.resourceRevision !== found.revision) {
      if (found.binding?.externalId && found.binding.externalId !== local.externalId) addFinding(findings, {
        classification: "external_id_mismatch", resourceType: local.resourceType, localExternalId: local.externalId,
        localPublicId: local.publicId, remotePublicId: found.publicId,
        details: { expected: local.externalId, observed: found.binding.externalId } });
      addFinding(findings, { classification: "binding_mismatch", resourceType: local.resourceType,
        localExternalId: local.externalId, localPublicId: local.publicId, remotePublicId: found.publicId,
        details: { expectedExternalId: local.externalId, observed: found.binding ?? null, resourceRevision: found.revision } });
    }
    if (!found.present) continue;
    if (now() - started >= timeBudgetMs) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, null, now(), previous);
    const profile = await beforeDeadline(readers.profile(env, sourceId, local.resourceType, local.publicId, fetcher),
      timeBudgetMs - (now() - started));
    if (!profile) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, null, now(), previous);
    if (profile.status !== "observed") return setUncertain(env.OPS_DB, sourceId, runId, outcomeReason(profile), pages, ordinal, null, now(), previous);
    if (profile.observation.sourceInstanceId !== fence.sourceInstanceId || profile.observation.applicationId !== fence.applicationId
      || profile.observation.historyEpoch !== fence.historyEpoch || profile.observation.authorizationGeneration !== fence.authorizationGeneration) {
      return setUncertain(env.OPS_DB, sourceId, runId, "fence_changed", pages, ordinal, null, now(), previous);
    }
    const relationship = local.resourceType === "client" ? profile.observation.profile.organizationPublicId ?? null : null;
    if (local.resourceType === "client" && local.relationshipKnown === 1 && relationship !== local.relationshipPublicId) addFinding(findings, {
      classification: "relationship_mismatch", resourceType: local.resourceType, localExternalId: local.externalId,
      localPublicId: local.publicId, remotePublicId: found.publicId,
      details: { expectedOrganizationPublicId: local.relationshipPublicId, observedOrganizationPublicId: relationship } });
    if (now() - started >= timeBudgetMs) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, null, now(), previous);
    const binding = await beforeDeadline(readers.binding(env, sourceId, local.resourceType, local.externalId,
      local.publicId, fetcher), timeBudgetMs - (now() - started));
    if (!binding) return setUncertain(env.OPS_DB, sourceId, runId, "time_limit", pages, ordinal, null, now(), previous);
    if (binding.status !== "observed") return setUncertain(env.OPS_DB, sourceId, runId, outcomeReason(binding), pages, ordinal, null, now(), previous);
    if (binding.observation.sourceInstanceId !== fence.sourceInstanceId || binding.observation.applicationId !== fence.applicationId
      || binding.observation.historyEpoch !== fence.historyEpoch || binding.observation.authorizationGeneration !== fence.authorizationGeneration) {
      return setUncertain(env.OPS_DB, sourceId, runId, "fence_changed", pages, ordinal, null, now(), previous);
    }
    if (binding.observation.resource.revision !== found.revision) addFinding(findings, { classification: "binding_mismatch",
      resourceType: local.resourceType, localExternalId: local.externalId, localPublicId: local.publicId,
      remotePublicId: found.publicId, details: { inventoryRevision: found.revision,
        bindingRevision: binding.observation.resource.revision } });
    try {
      await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_observations SET profile_json=?,
        profile_revision=?,profile_authorization_generation=?,binding_status_json=?,binding_authorization_generation=?
        WHERE run_id=? AND resource_type=? AND public_id=?`).bind(
          JSON.stringify({ organizationPublicId: relationship }), profile.observation.resource.revision,
          profile.observation.authorizationGeneration, JSON.stringify({ externalId: binding.observation.binding.externalId,
            publicId: binding.observation.binding.publicId, revision: binding.observation.resource.revision,
            present: binding.observation.resource.present }), binding.observation.authorizationGeneration,
          runId, local.resourceType, local.publicId).run();
    } catch { return setUncertain(env.OPS_DB, sourceId, runId, "ownership_lost", pages, ordinal, null, now(), previous); }
  }
  for (const item of remote.values()) {
    if (!localByPublic.has(key(item.type, item.publicId)) && !(item.binding && localByExternal.has(key(item.type, item.binding.externalId)))) {
      addFinding(findings, { classification: "extra_remote", resourceType: item.type,
        localExternalId: null, localPublicId: null, remotePublicId: item.publicId,
        details: { bindingExternalId: item.binding?.externalId ?? null, present: item.present } });
    }
  }
  return finishComplete(env.OPS_DB, sourceId, runId, previous, fence, pages, ordinal, locals.length, findings, now());
}

export async function reconcileProjectAlphaDirectorySources(env: ReconciliationEnvironment, sourceIds: readonly string[],
  options: ProjectAlphaDirectoryReconciliationOptions = {}): Promise<readonly ProjectAlphaDirectoryReconciliationResult[]> {
  const unique = [...new Set(sourceIds)];
  const results: ProjectAlphaDirectoryReconciliationResult[] = [];
  for (const sourceId of unique) results.push(await reconcileProjectAlphaDirectorySource(env, sourceId, options));
  return Object.freeze(results);
}
