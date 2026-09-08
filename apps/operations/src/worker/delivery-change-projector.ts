import {
  authenticatedDeliveryChangeNotificationsReady,
  authenticatedDeliveryChangeBatchSequenceReady,
  authenticatedDeliveryNotificationsEnabled,
  stageAuthenticatedDeliveryChangeForTarget,
  type AuthenticatedDeliveryChangeTarget,
} from "./authenticated-delivery-change-notifications";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 5;
const PROJECTION_TABLES = [
  "portal_authenticated_delivery_change_receipts",
  "portal_authenticated_delivery_change_receipt_targets",
  "portal_authenticated_delivery_change_receipt_seals",
  "portal_authenticated_delivery_change_projection_jobs",
] as const;

type RecoveryEnv = Env & { AUTHENTICATED_DELIVERY_RECOVERY_ENABLED?: string };
type ProjectionStatus = "pending" | "processing" | "completed" | "failed";
type ProjectionReason = "authority-suppressed" | "staging-fence" | "staging-schema" | "staging-invalid" | "staging-failed";

interface ProjectionJobRow extends AuthenticatedDeliveryChangeTarget {
  receipt_key: string;
  sequence: number;
  r2_key: string;
  provider_object_version: string;
  content_etag: string | null;
  current_present: number;
  observed_event_at: string;
  attempt_count: number;
}

export interface AuthenticatedDeliveryChangeProjectionResult {
  claimed: number;
  completed: number;
  suppressed: number;
  retried: number;
  failed: number;
}

export interface AuthenticatedDeliveryChangeProjectionCounts {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface AuthenticatedDeliveryChangeProjectionOptions {
  /** Bounded number of claims attempted in one recovery invocation. */
  limit?: number;
}

export function authenticatedDeliveryChangeRecoveryEnabled(env: Env): boolean {
  const recovery = env as RecoveryEnv;
  return authenticatedDeliveryNotificationsEnabled(env)
    && recovery.AUTHENTICATED_DELIVERY_RECOVERY_ENABLED === "true";
}

/** Requires both projection storage and the seal fan-out trigger. Checking
 * tables alone would let receipt capture proceed during a partial migration
 * while silently creating no durable jobs. */
export async function deliveryChangeProjectionReady(env: Env): Promise<boolean> {
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))
    || !(await authenticatedDeliveryChangeBatchSequenceReady(env))
    || !(await d1TablesPresent(env.DELIVERY_DB, PROJECTION_TABLES))) return false;
  const trigger = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ready
    FROM sqlite_master WHERE type='trigger' AND name='authenticated_delivery_projection_create_sealed_targets'`)
    .first<number>("ready");
  return Number(trigger) === 1;
}

function limitFor(options: AuthenticatedDeliveryChangeProjectionOptions | undefined): number {
  const value = options?.limit;
  if (value === undefined) return DEFAULT_LIMIT;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT;
}

function isProjectionJob(row: ProjectionJobRow | null): row is ProjectionJobRow {
  if (!row) return false;
  return typeof row.receipt_key === "string" && row.receipt_key.length === 64
    && typeof row.r2_key === "string" && row.r2_key.length > 0
    && typeof row.provider_object_version === "string" && row.provider_object_version.length > 0
    && typeof row.observed_event_at === "string" && Number.isFinite(Date.parse(row.observed_event_at))
    && (row.current_present === 0 || row.current_present === 1)
    && Number.isSafeInteger(row.sequence) && row.sequence > 0
    && Number.isSafeInteger(row.attempt_count) && row.attempt_count >= 0 && row.attempt_count < MAX_ATTEMPTS;
}

function failureReason(error: unknown): ProjectionReason {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("staging-fence-lost")) return "staging-fence";
  if (message.includes("schema-unavailable")) return "staging-schema";
  if (message.includes("notification-sequence")) return "staging-schema";
  return "staging-failed";
}

function retryMinutes(attempt: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attempt - 1));
}

/** Correlates against the candidate selected by the outer query. This keeps
 * candidate discovery fully bound-free; the UPDATE fence below binds its
 * independently read row explicitly. */
function hasEarlierOutstandingForCandidateSql(): string {
  return `NOT EXISTS (
    SELECT 1
    FROM portal_authenticated_delivery_change_projection_jobs earlier_job
    JOIN portal_authenticated_delivery_change_receipt_targets earlier_target
      ON earlier_target.receipt_key=earlier_job.receipt_key
      AND earlier_target.grant_id=earlier_job.grant_id
      AND earlier_target.identity_id=earlier_job.identity_id
    JOIN portal_authenticated_delivery_change_receipts earlier_receipt
      ON earlier_receipt.receipt_key=earlier_job.receipt_key
    WHERE earlier_target.grant_id=target.grant_id AND earlier_target.grant_version=target.grant_version
      AND earlier_target.identity_id=target.identity_id AND earlier_receipt.r2_key=receipt.r2_key
      AND earlier_receipt.sequence<receipt.sequence
      AND earlier_job.status NOT IN ('completed','failed')
  )`;
}

function hasEarlierOutstandingForClaimSql(): string {
  return `NOT EXISTS (
    SELECT 1
    FROM portal_authenticated_delivery_change_projection_jobs earlier_job
    JOIN portal_authenticated_delivery_change_receipt_targets earlier_target
      ON earlier_target.receipt_key=earlier_job.receipt_key
      AND earlier_target.grant_id=earlier_job.grant_id
      AND earlier_target.identity_id=earlier_job.identity_id
    JOIN portal_authenticated_delivery_change_receipts earlier_receipt
      ON earlier_receipt.receipt_key=earlier_job.receipt_key
    WHERE earlier_target.grant_id=? AND earlier_target.grant_version=?
      AND earlier_target.identity_id=? AND earlier_receipt.r2_key=?
      AND earlier_receipt.sequence<?
      AND earlier_job.status NOT IN ('completed','failed')
  )`;
}

async function findClaimableJob(db: D1DatabaseSession): Promise<ProjectionJobRow | null> {
  return db.prepare(`SELECT job.receipt_key,job.grant_id,job.identity_id,job.grant_version,job.attempt_count,
      receipt.sequence,receipt.r2_key,receipt.object_version provider_object_version,receipt.object_etag content_etag,
      receipt.current_present,receipt.observed_event_at,target.logical_grant_id,target.workspace_id,target.source_id,
      target.principal_public_id,target.principal_source_version,target.access_notice_enabled,target.change_mode,
      target.policy_version,target.folder_binding_id,target.binding_source_version,target.owner_scope_type,
      target.owner_public_id,target.r2_prefix
    FROM portal_authenticated_delivery_change_projection_jobs job
    JOIN portal_authenticated_delivery_change_receipt_targets target
      ON target.receipt_key=job.receipt_key AND target.grant_id=job.grant_id AND target.identity_id=job.identity_id
    JOIN portal_authenticated_delivery_change_receipts receipt ON receipt.receipt_key=job.receipt_key
    JOIN portal_authenticated_delivery_change_receipt_seals seal ON seal.receipt_key=receipt.receipt_key
    WHERE job.attempt_count<?
      AND ((job.status='pending' AND julianday(job.next_attempt_at)<=julianday(${NOW}))
        OR (job.status='processing' AND job.lease_expires_at IS NOT NULL AND julianday(job.lease_expires_at)<=julianday(${NOW})))
      AND ${hasEarlierOutstandingForCandidateSql()}
    ORDER BY receipt.sequence,job.receipt_key,job.grant_id,job.identity_id
    LIMIT 1`).bind(MAX_ATTEMPTS).first<ProjectionJobRow>();
}

async function claimJob(db: D1DatabaseSession, row: ProjectionJobRow, leaseToken: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE portal_authenticated_delivery_change_projection_jobs
    SET status='processing',attempt_count=attempt_count+1,lease_token=?,
      lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+${LEASE_MINUTES} minutes'),
      updated_at=${NOW},last_reason_code=NULL
    WHERE receipt_key=? AND grant_id=? AND identity_id=? AND attempt_count=?
      AND ((status='pending' AND julianday(next_attempt_at)<=julianday(${NOW}))
        OR (status='processing' AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<=julianday(${NOW})))
      AND ${hasEarlierOutstandingForClaimSql()}`)
    .bind(leaseToken,row.receipt_key,row.grant_id,row.identity_id,row.attempt_count,
      row.grant_id,row.grant_version,row.identity_id,row.r2_key,row.sequence).run();
  return Number(result.meta.changes) === 1;
}

/** A worker can die after its final claim. That job cannot be retried, but it
 * must become terminal after the lease so it no longer blocks a newer accepted
 * receipt for the same saved target. The CTE preserves a bounded maintenance
 * cost per projector invocation. */
async function terminalizeExpiredExhaustedJobs(db: D1DatabaseSession, limit: number): Promise<number> {
  const result = await db.prepare(`WITH exhausted AS (
      SELECT receipt_key,grant_id,identity_id
      FROM portal_authenticated_delivery_change_projection_jobs
      WHERE status='processing' AND attempt_count>=? AND lease_expires_at IS NOT NULL
        AND julianday(lease_expires_at)<=julianday(${NOW})
      ORDER BY lease_expires_at,receipt_key,grant_id,identity_id
      LIMIT ?
    )
    UPDATE portal_authenticated_delivery_change_projection_jobs
    SET status='failed',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=${NOW},
      last_reason_code='staging-failed',updated_at=${NOW}
    WHERE (receipt_key,grant_id,identity_id) IN (
      SELECT receipt_key,grant_id,identity_id FROM exhausted
    )`).bind(MAX_ATTEMPTS,limit).run();
  return Number(result.meta.changes) || 0;
}

async function completeJob(db: D1DatabaseSession, row: ProjectionJobRow, leaseToken: string,
  reason: ProjectionReason | null): Promise<boolean> {
  const result = await db.prepare(`UPDATE portal_authenticated_delivery_change_projection_jobs
    SET status='completed',completed_at=${NOW},lease_token=NULL,lease_expires_at=NULL,
      next_attempt_at=${NOW},last_reason_code=?,updated_at=${NOW}
    WHERE receipt_key=? AND grant_id=? AND identity_id=? AND status='processing' AND lease_token=?`)
    .bind(reason,row.receipt_key,row.grant_id,row.identity_id,leaseToken).run();
  return Number(result.meta.changes) === 1;
}

async function retryOrFailJob(db: D1DatabaseSession, row: ProjectionJobRow, leaseToken: string,
  reason: ProjectionReason): Promise<"retried" | "failed" | "lost"> {
  // `row` was read immediately before its successful claim. The claim itself
  // increments the persisted counter, so account for that mutation here.
  const attempt = row.attempt_count + 1;
  const terminal = attempt >= MAX_ATTEMPTS;
  const result = await db.prepare(`UPDATE portal_authenticated_delivery_change_projection_jobs
    SET status=?,next_attempt_at=CASE WHEN ? THEN ${NOW}
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' minutes') END,
      lease_token=NULL,lease_expires_at=NULL,last_reason_code=?,updated_at=${NOW}
    WHERE receipt_key=? AND grant_id=? AND identity_id=? AND status='processing' AND lease_token=?`)
    .bind(terminal ? "failed" : "pending",Number(terminal),retryMinutes(attempt),reason,
      row.receipt_key,row.grant_id,row.identity_id,leaseToken).run();
  if (Number(result.meta.changes) !== 1) return "lost";
  return terminal ? "failed" : "retried";
}

/** Projects accepted receipt targets without rediscovering present-day
 * recipients. Work is intentionally bounded; callers schedule subsequent
 * invocations rather than extending a Worker turn with an unbounded drain. */
export async function projectAuthenticatedDeliveryChanges(env: Env,
  options?: AuthenticatedDeliveryChangeProjectionOptions): Promise<AuthenticatedDeliveryChangeProjectionResult> {
  const result: AuthenticatedDeliveryChangeProjectionResult = { claimed: 0, completed: 0, suppressed: 0, retried: 0, failed: 0 };
  if (!authenticatedDeliveryChangeRecoveryEnabled(env)) return result;
  if (!(await deliveryChangeProjectionReady(env))) throw new Error("authenticated-delivery-change-projection-schema-unavailable");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const limit = limitFor(options);
  result.failed += await terminalizeExpiredExhaustedJobs(db,limit);
  for (let count = 0; count < limit; count += 1) {
    const row = await findClaimableJob(db);
    if (!isProjectionJob(row)) break;
    const leaseToken = crypto.randomUUID();
    if (!(await claimJob(db,row,leaseToken))) continue;
    result.claimed += 1;
    try {
      const staged = await stageAuthenticatedDeliveryChangeForTarget(env,row,{
        key: row.r2_key,
        present: row.current_present === 1,
        objectVersion: row.content_etag,
        eventAt: row.observed_event_at,
        acceptedSequence: row.sequence,
        providerObjectVersion: row.provider_object_version,
      });
      const reason = staged === "suppressed" ? "authority-suppressed" as const : null;
      if (await completeJob(db,row,leaseToken,reason)) {
        result.completed += 1;
        if (reason) result.suppressed += 1;
      }
    } catch (error) {
      const outcome = await retryOrFailJob(db,row,leaseToken,failureReason(error));
      if (outcome === "retried") result.retried += 1;
      if (outcome === "failed") result.failed += 1;
    }
  }
  return result;
}

/** Read-only aggregate for recovery monitoring. No route is exposed here. */
export async function getAuthenticatedDeliveryChangeProjectionCounts(
  env: Env,
): Promise<AuthenticatedDeliveryChangeProjectionCounts> {
  const empty: AuthenticatedDeliveryChangeProjectionCounts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  if (!(await deliveryChangeProjectionReady(env))) return empty;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT status,count(*) count
    FROM portal_authenticated_delivery_change_projection_jobs GROUP BY status`).all<{status: ProjectionStatus; count: number}>();
  for (const row of rows.results) if (row.status in empty) empty[row.status] = Number(row.count) || 0;
  return empty;
}
