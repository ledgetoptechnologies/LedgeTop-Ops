import { acquireProjectAlphaExistingDirectoryBinding,
  type ProjectAlphaExistingDirectoryAcquisitionOutcome } from "./project-alpha-existing-directory-acquisition-coordinator";
import { readConfiguredProjectAlphaDirectoryProfile } from "./project-alpha-directory-read-api-v2";
import type { ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";

const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD = /^[^\p{C}]{1,191}$/u;
const ADOPTABLE = new Set(["extra_remote", "public_id_mismatch", "external_id_mismatch", "binding_mismatch"]);

export type ProjectAlphaDirectoryReconciliationReviewEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaDirectoryReconciliationReviewer = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number; grantGeneration: number;
}>;
export type ProjectAlphaDirectoryReconciliationFinding = Readonly<{
  findingId: string; sourceId: string; classification: string; resourceType: "client" | "organization";
  reviewState: "open" | "acknowledged" | "dismissed" | "resolved"; localRecordId: string | null;
  localPublicId: string | null; remotePublicId: string | null; remoteRevision: string | null;
  present: boolean | null; lastAction: "upsert" | "delete" | null; bindingRecordId: string | null;
  bindingStatus: "active" | "tombstoned" | null; bindingRevision: string | null; createdAt: string;
}>;
export type ProjectAlphaDirectoryReconciliationFindingPage = Readonly<{
  items: readonly ProjectAlphaDirectoryReconciliationFinding[]; nextCursor: string | null;
}>;
export type ProjectAlphaDirectoryReconciliationAdoptionInput = Readonly<{
  findingId: string; recordId: string; expectedRecordVersion: number; idempotencyKey: string;
}>;
export type ProjectAlphaDirectoryReconciliationAdoptionOutcome =
  | Readonly<{ status: "acquired"; actionId: string; findingId: string; acquiredReceiptId: string; replayed: boolean }>
  | Readonly<{ status: "uncertain"; reason: "remote" | "database" | "acquisition" }>
  | Readonly<{ status: "blocked"; reason: "stale_snapshot" | "remote" | "acquisition" }>
  | Readonly<{ status: "conflict"; reason: "reservation" | "acquisition" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" }>;

type Cursor = Readonly<{ sourceId: string; findingId: string }>;
type FindingRow = Omit<ProjectAlphaDirectoryReconciliationFinding, "present"> & { present: number | null };
type Action = Readonly<{
  actionId: string; idempotencyKey: string; findingId: string; runId: string; sourceId: string;
  sourceInstanceId: string; applicationId: string; historyEpoch: string; authorizationGeneration: string;
  classification: string; resourceType: "client" | "organization"; remotePublicId: string;
  remoteRevision: string; recordId: string; expectedRecordVersion: number; reviewId: string; commandId: string;
  reviewerStaffId: string; reviewerAccessSubject: string; reviewerAdmissionVersion: number;
  reviewerProfileVersion: number; reviewerGrantGeneration: number;
}>;

function encodeCursor(row: { sourceId: string; findingId: string }): string {
  return btoa(JSON.stringify({ s: row.sourceId, f: row.findingId })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeCursor(value: string | undefined): Cursor | null | undefined {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const object = parsed as Record<string, unknown>;
    if (Reflect.ownKeys(object).length !== 2 || typeof object.s !== "string" || typeof object.f !== "string"
      || !SOURCE.test(object.s) || !UUID.test(object.f)) return undefined;
    return { sourceId: object.s, findingId: object.f };
  } catch { return undefined; }
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

/** Keyset-page only stable complete-run findings; profile evidence and deployment configuration are never selected. */
export async function listProjectAlphaDirectoryReconciliationFindings(
  env: ProjectAlphaDirectoryReconciliationReviewEnvironment,
  input: Readonly<{ sourceIds: readonly string[]; limit: number; cursor?: string }>,
): Promise<ProjectAlphaDirectoryReconciliationFindingPage | null> {
  const sourceIds = [...new Set(input.sourceIds)].sort();
  const cursor = decodeCursor(input.cursor);
  if (sourceIds.length < 1 || sourceIds.length > 2 || sourceIds.some(sourceId => !SOURCE.test(sourceId))
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50 || cursor === undefined
    || (cursor !== null && !sourceIds.includes(cursor.sourceId))) return null;
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await env.OPS_DB.prepare(`SELECT finding.finding_id findingId,finding.source_id sourceId,
      finding.classification,finding.resource_type resourceType,
      CASE WHEN outcome.action_id IS NULL THEN finding.review_state ELSE 'resolved' END reviewState,
      finding.local_external_id localRecordId,finding.local_public_id localPublicId,
      finding.remote_public_id remotePublicId,observation.revision remoteRevision,
      observation.present,observation.last_action lastAction,observation.binding_external_id bindingRecordId,
      observation.binding_status bindingStatus,observation.binding_resource_revision bindingRevision,
      finding.created_at createdAt
    FROM project_alpha_directory_reconciliation_findings finding
    JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
      ON checkpoint.source_id=finding.source_id AND checkpoint.complete_run_id=finding.run_id
    JOIN project_alpha_directory_reconciliation_runs run ON run.run_id=finding.run_id AND run.status='complete'
    LEFT JOIN project_alpha_directory_reconciliation_observations observation
      ON observation.run_id=finding.run_id AND observation.resource_type=finding.resource_type
        AND observation.public_id=finding.remote_public_id
    LEFT JOIN project_alpha_directory_reconciliation_actions action ON action.finding_id=finding.finding_id
    LEFT JOIN project_alpha_directory_reconciliation_action_outcomes outcome ON outcome.action_id=action.action_id
    WHERE finding.source_id IN (${placeholders})
      AND (? IS NULL OR finding.source_id>? OR (finding.source_id=? AND finding.finding_id>?))
    ORDER BY finding.source_id,finding.finding_id LIMIT ?`)
    .bind(...sourceIds, cursor?.sourceId ?? null, cursor?.sourceId ?? "", cursor?.sourceId ?? "",
      cursor?.findingId ?? "", input.limit + 1).all<FindingRow>();
  const selected = rows.results.slice(0, input.limit);
  const items = selected.map(row => Object.freeze({ ...row, present: row.present === null ? null : row.present === 1 }));
  const last = selected.at(-1);
  return Object.freeze({ items: Object.freeze(items), nextCursor: rows.results.length > input.limit && last ? encodeCursor(last) : null });
}

function validAdoption(value: ProjectAlphaDirectoryReconciliationAdoptionInput,
  reviewer: ProjectAlphaDirectoryReconciliationReviewer): boolean {
  return UUID.test(value.findingId) && UUID.test(value.idempotencyKey) && RECORD.test(value.recordId)
    && positive(value.expectedRecordVersion) && RECORD.test(reviewer.staffId) && RECORD.test(reviewer.accessSubject)
    && positive(reviewer.admissionVersion) && positive(reviewer.profileVersion) && positive(reviewer.grantGeneration);
}

async function actionBySelection(db: D1Database, idempotencyKey: string, findingId: string): Promise<Action[]> {
  const rows = await db.prepare(`SELECT action_id actionId,idempotency_key idempotencyKey,finding_id findingId,
      run_id runId,source_id sourceId,source_instance_id sourceInstanceId,application_id applicationId,
      history_epoch_id historyEpoch,authorization_generation authorizationGeneration,classification,
      resource_type resourceType,remote_public_id remotePublicId,remote_revision remoteRevision,record_id recordId,
      expected_record_version expectedRecordVersion,review_id reviewId,command_id commandId,
      reviewer_staff_id reviewerStaffId,reviewer_access_subject reviewerAccessSubject,
      reviewer_admission_version reviewerAdmissionVersion,reviewer_profile_version reviewerProfileVersion,
      reviewer_grant_generation reviewerGrantGeneration
    FROM project_alpha_directory_reconciliation_actions WHERE idempotency_key=? OR finding_id=?`)
    .bind(idempotencyKey, findingId).all<Action>();
  return rows.results;
}
function exactAction(action: Action, input: ProjectAlphaDirectoryReconciliationAdoptionInput,
  reviewer: ProjectAlphaDirectoryReconciliationReviewer): boolean {
  return action.idempotencyKey === input.idempotencyKey && action.findingId === input.findingId
    && action.recordId === input.recordId && action.expectedRecordVersion === input.expectedRecordVersion
    && action.reviewerStaffId === reviewer.staffId && action.reviewerAccessSubject === reviewer.accessSubject
    && action.reviewerAdmissionVersion === reviewer.admissionVersion && action.reviewerProfileVersion === reviewer.profileVersion
    && action.reviewerGrantGeneration === reviewer.grantGeneration;
}

async function priorOutcome(db: D1Database, actionId: string): Promise<{ acquiredReceiptId: string } | null> {
  return db.prepare(`SELECT acquired_receipt_id acquiredReceiptId FROM project_alpha_directory_reconciliation_action_outcomes
    WHERE action_id=?`).bind(actionId).first<{ acquiredReceiptId: string }>();
}

async function markResolved(db: D1Database, action: Action, at: string): Promise<void> {
  await db.prepare(`UPDATE project_alpha_directory_reconciliation_findings SET review_state='resolved',
    reviewed_at=?,reviewed_by=?,review_note=? WHERE finding_id=? AND run_id=? AND review_state='open'`)
    .bind(at, action.reviewerStaffId, action.actionId, action.findingId, action.runId).run();
}

async function currentAction(db: D1Database, actionId: string): Promise<Action | null> {
  return db.prepare(`SELECT action.action_id actionId,action.idempotency_key idempotencyKey,action.finding_id findingId,
      action.run_id runId,action.source_id sourceId,action.source_instance_id sourceInstanceId,
      action.application_id applicationId,action.history_epoch_id historyEpoch,
      action.authorization_generation authorizationGeneration,action.classification,
      action.resource_type resourceType,action.remote_public_id remotePublicId,action.remote_revision remoteRevision,
      action.record_id recordId,action.expected_record_version expectedRecordVersion,action.review_id reviewId,
      action.command_id commandId,action.reviewer_staff_id reviewerStaffId,
      action.reviewer_access_subject reviewerAccessSubject,action.reviewer_admission_version reviewerAdmissionVersion,
      action.reviewer_profile_version reviewerProfileVersion,action.reviewer_grant_generation reviewerGrantGeneration
    FROM project_alpha_directory_reconciliation_actions action
    JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
      ON checkpoint.source_id=action.source_id AND checkpoint.complete_run_id=action.run_id
    JOIN project_alpha_directory_reconciliation_findings finding
      ON finding.finding_id=action.finding_id AND finding.run_id=action.run_id AND finding.review_state='open'
    JOIN operations_directory_records record ON record.record_id=action.record_id
      AND record.record_kind=action.resource_type AND record.current_version=action.expected_record_version
    WHERE action.action_id=?`).bind(actionId).first<Action>();
}

function acquisitionFailure(value: ProjectAlphaExistingDirectoryAcquisitionOutcome): ProjectAlphaDirectoryReconciliationAdoptionOutcome {
  if (value.status === "uncertain") return { status: "uncertain", reason: "acquisition" };
  if (value.status === "conflict") return { status: "conflict", reason: "acquisition" };
  return { status: "blocked", reason: "acquisition" };
}

/** Reserve and acquire one selected existing record. The existing coordinator always leaves it inactive. */
export async function acquireProjectAlphaDirectoryReconciliationFinding(
  env: ProjectAlphaDirectoryReconciliationReviewEnvironment,
  input: ProjectAlphaDirectoryReconciliationAdoptionInput,
  reviewer: ProjectAlphaDirectoryReconciliationReviewer,
  options: Readonly<{
    readProfile?: typeof readConfiguredProjectAlphaDirectoryProfile;
    acquire?: typeof acquireProjectAlphaExistingDirectoryBinding;
    uuid?: () => string;
    now?: () => string;
  }> = {},
): Promise<ProjectAlphaDirectoryReconciliationAdoptionOutcome> {
  if (!validAdoption(input, reviewer)) return { status: "rejected", reason: "invalid_input" };
  let matches: Action[];
  try { matches = await actionBySelection(env.OPS_DB, input.idempotencyKey, input.findingId); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (matches.length > 1 || (matches.length === 1 && !exactAction(matches[0]!, input, reviewer)))
    return { status: "conflict", reason: "reservation" };
  let action = matches[0] ?? null;
  if (action) {
    let prior: Awaited<ReturnType<typeof priorOutcome>>;
    try { prior = await priorOutcome(env.OPS_DB, action.actionId); }
    catch { return { status: "uncertain", reason: "database" }; }
    if (prior) {
      await markResolved(env.OPS_DB, action, (options.now ?? (() => new Date().toISOString()))()).catch(() => undefined);
      return { status: "acquired", actionId: action.actionId, findingId: action.findingId,
        acquiredReceiptId: prior.acquiredReceiptId, replayed: true };
    }
  } else {
    const uuid = options.uuid ?? crypto.randomUUID;
    const ids = { actionId: uuid(), reviewId: uuid(), commandId: uuid() };
    if (!UUID.test(ids.actionId) || !UUID.test(ids.reviewId) || !UUID.test(ids.commandId)
      || new Set(Object.values(ids)).size !== 3) return { status: "uncertain", reason: "database" };
    const at = (options.now ?? (() => new Date().toISOString()))();
    try {
      const inserted = await env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_reconciliation_actions(
        action_id,idempotency_key,finding_id,run_id,source_id,source_instance_id,application_id,history_epoch_id,
        authorization_generation,classification,resource_type,remote_public_id,remote_revision,record_id,
        expected_record_version,review_id,command_id,reviewer_staff_id,reviewer_access_subject,
        reviewer_admission_version,reviewer_profile_version,reviewer_grant_generation,created_at)
        SELECT ?,?,finding.finding_id,finding.run_id,finding.source_id,run.source_instance_id,run.application_id,
          run.history_epoch_id,run.authorization_generation,finding.classification,finding.resource_type,
          finding.remote_public_id,observation.revision,record.record_id,record.current_version,?,?,?,?,?,?,?,?
        FROM project_alpha_directory_reconciliation_findings finding
        JOIN project_alpha_directory_reconciliation_checkpoints checkpoint
          ON checkpoint.source_id=finding.source_id AND checkpoint.complete_run_id=finding.run_id
        JOIN project_alpha_directory_reconciliation_runs run ON run.run_id=finding.run_id AND run.status='complete'
        JOIN project_alpha_directory_reconciliation_observations observation
          ON observation.run_id=finding.run_id AND observation.resource_type=finding.resource_type
            AND observation.public_id=finding.remote_public_id
        JOIN operations_directory_records record ON record.record_id=? AND record.record_kind=finding.resource_type
          AND record.current_version=?
        WHERE finding.finding_id=? AND finding.review_state='open'
          AND finding.classification IN ('extra_remote','public_id_mismatch','external_id_mismatch','binding_mismatch')`)
        .bind(ids.actionId, input.idempotencyKey, ids.reviewId, ids.commandId, reviewer.staffId,
          reviewer.accessSubject, reviewer.admissionVersion, reviewer.profileVersion, reviewer.grantGeneration,
          at, input.recordId, input.expectedRecordVersion, input.findingId).run();
      if (Number(inserted.meta.changes ?? 0) !== 1) return { status: "blocked", reason: "stale_snapshot" };
    } catch {
      let winners: Action[];
      try { winners = await actionBySelection(env.OPS_DB, input.idempotencyKey, input.findingId); }
      catch { return { status: "uncertain", reason: "database" }; }
      if (winners.length !== 1 || !exactAction(winners[0]!, input, reviewer))
        return { status: "conflict", reason: "reservation" };
    }
    let winners: Action[];
    try { winners = await actionBySelection(env.OPS_DB, input.idempotencyKey, input.findingId); }
    catch { return { status: "uncertain", reason: "database" }; }
    if (winners.length !== 1 || !exactAction(winners[0]!, input, reviewer))
      return { status: "conflict", reason: "reservation" };
    action = winners[0]!;
  }
  let current: Action | null;
  try { current = await currentAction(env.OPS_DB, action.actionId); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (!current || !ADOPTABLE.has(current.classification)) return { status: "blocked", reason: "stale_snapshot" };
  const readProfile = options.readProfile ?? readConfiguredProjectAlphaDirectoryProfile;
  let remote: Awaited<ReturnType<typeof readConfiguredProjectAlphaDirectoryProfile>>;
  try { remote = await readProfile(env, current.sourceId, current.resourceType, current.remotePublicId, fetch); }
  catch { return { status: "uncertain", reason: "remote" }; }
  if (remote.status === "uncertain") return { status: "uncertain", reason: "remote" };
  if (remote.status !== "observed") return { status: "blocked", reason: "remote" };
  const observed = remote.observation;
  if (observed.sourceId !== current.sourceId || observed.sourceInstanceId !== current.sourceInstanceId
    || observed.applicationId !== current.applicationId || observed.historyEpoch !== current.historyEpoch
    || observed.authorizationGeneration !== current.authorizationGeneration
    || observed.resource.type !== current.resourceType || observed.resource.id !== current.remotePublicId
    || observed.resource.revision !== current.remoteRevision) return { status: "blocked", reason: "stale_snapshot" };
  const acquire = options.acquire ?? acquireProjectAlphaExistingDirectoryBinding;
  let result: ProjectAlphaExistingDirectoryAcquisitionOutcome;
  try {
    result = await acquire(env, { reviewId: current.reviewId, commandId: current.commandId,
      sourceId: current.sourceId, recordId: current.recordId, resourceType: current.resourceType,
      projectAlphaPublicId: current.remotePublicId, localRecordVersion: current.expectedRecordVersion,
      reviewer: { staffId: current.reviewerStaffId, accessSubject: current.reviewerAccessSubject,
        admissionVersion: current.reviewerAdmissionVersion, profileVersion: current.reviewerProfileVersion,
        grantGeneration: current.reviewerGrantGeneration } }, fetch);
  } catch { return { status: "uncertain", reason: "acquisition" }; }
  if (result.status !== "acquired") return acquisitionFailure(result);
  try {
    await env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_reconciliation_action_outcomes(
      action_id,status,acquired_receipt_id,created_at) VALUES(?,'acquired',?,?)`)
      .bind(current.actionId, result.acquiredReceiptId, (options.now ?? (() => new Date().toISOString()))()).run();
  } catch {
    let winner: Awaited<ReturnType<typeof priorOutcome>>;
    try { winner = await priorOutcome(env.OPS_DB, current.actionId); }
    catch { return { status: "uncertain", reason: "database" }; }
    if (!winner || winner.acquiredReceiptId !== result.acquiredReceiptId) return { status: "uncertain", reason: "database" };
  }
  await markResolved(env.OPS_DB, current, (options.now ?? (() => new Date().toISOString()))()).catch(() => undefined);
  return { status: "acquired", actionId: current.actionId, findingId: current.findingId,
    acquiredReceiptId: result.acquiredReceiptId, replayed: result.replayed };
}
