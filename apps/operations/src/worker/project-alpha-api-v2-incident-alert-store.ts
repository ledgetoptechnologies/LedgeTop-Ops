import {
  advanceProjectAlphaApiV2Alert,
  parseProjectAlphaApiV2IncidentState,
  projectAlphaApiV2AlertEligible,
  type ProjectAlphaApiV2IncidentIdentity,
  type ProjectAlphaApiV2IncidentState,
} from "./project-alpha-api-v2-incident-policy";
import { readProjectAlphaApiV2Incident } from "./project-alpha-api-v2-incident-store";

const DENIED = "project_alpha_api_v2_incident_alert_denied";
const CONFLICT = "project_alpha_api_v2_incident_alert_conflict";
/** Shared by the durable claim writer and the last pre-send lease check. */
export const PROJECT_ALPHA_API_V2_ALERT_LEASE_MS = 60_000;
const CRASH_BACKOFF_MS = 30_000;
const MAX_RETRY_MS = 900_000;
const WHERE = `source_id=? AND application_id=? AND base_url=?
  AND expected_source_instance_id=? AND expected_history_epoch=?`;
const MONITOR_ACTIVE = `EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads monitor
  JOIN json_each(monitor.identities_json) member
  WHERE monitor.lifecycle_id=1 AND monitor.revision=? AND monitor.enabled=1
    AND json_type(member.value)='object'
    AND (SELECT count(*) FROM json_each(member.value))=5
    AND json_extract(member.value,'$.sourceId')=?
    AND json_extract(member.value,'$.applicationId')=?
    AND json_extract(member.value,'$.baseUrl')=?
    AND json_extract(member.value,'$.expectedSourceInstanceId')=?
    AND json_extract(member.value,'$.expectedHistoryEpoch')=?)`;

export class ProjectAlphaApiV2IncidentAlertConflict extends Error {
  constructor() { super(CONFLICT); this.name = "ProjectAlphaApiV2IncidentAlertConflict"; }
}

type Action = "claim" | "attempt" | "failed" | "sent";
type Input = Readonly<{
  action: Action;
  identity: ProjectAlphaApiV2IncidentIdentity;
  expectedRevision: number;
  at: number;
  monitorRevision?: number;
  incidentSequence?: number;
  claimSequence?: number;
  leaseToken?: string;
}>;
type AlertRow = {
  revision: number;
  status: "leased" | "retry" | "sent" | "cancelled";
  claim_sequence: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  attempt_count: number;
  sent_at: number | null;
};

export type ProjectAlphaApiV2IncidentAlertResult = Readonly<{
  status: "not_due" | "reconciliation_required" | "claimed" | "attempted" | "retry" | "sent";
  headRevision: number;
  incidentSequence: number;
  claimSequence: number;
  leaseToken?: string;
  nextAttemptAt?: number;
  state: ProjectAlphaApiV2IncidentState;
}>;

function data(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw Error();
    const keys = Reflect.ownKeys(raw), descriptors = Object.getOwnPropertyDescriptors(raw);
    const allowed = new Set([...required, ...optional]);
    if (keys.length < required.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) throw Error();
    for (const key of required) if (!descriptors[key]?.enumerable || !("value" in descriptors[key])) throw Error();
    for (const key of optional) if (key in descriptors
      && (!descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw Error();
    return Object.fromEntries(keys.map(key => [key, descriptors[key as string]!.value]));
  } catch { throw Error(DENIED); }
}

function snapshot(raw: unknown): Input {
  const row = data(raw, ["action", "identity", "expectedRevision", "at"],
    ["incidentSequence", "claimSequence", "leaseToken", "monitorRevision"]);
  if (typeof row.action !== "string" || !["claim", "attempt", "failed", "sent"].includes(row.action)
    || typeof row.expectedRevision !== "number" || !Number.isSafeInteger(row.expectedRevision)
    || row.expectedRevision < 1 || typeof row.at !== "number" || !Number.isSafeInteger(row.at)
    || row.at < 0) throw Error(DENIED);
  if (row.action === "claim" || row.action === "attempt") {
    if (typeof row.monitorRevision !== "number" || !Number.isSafeInteger(row.monitorRevision)
      || row.monitorRevision < 1) throw Error(DENIED);
  } else if ("monitorRevision" in row) throw Error(DENIED);
  const identity = data(row.identity,
    ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"]);
  if (Object.values(identity).some(value => typeof value !== "string")) throw Error(DENIED);
  if (row.action === "claim") {
    if ("incidentSequence" in row || "claimSequence" in row || "leaseToken" in row) throw Error(DENIED);
  } else if (typeof row.incidentSequence !== "number" || !Number.isSafeInteger(row.incidentSequence)
    || row.incidentSequence < 1 || typeof row.claimSequence !== "number"
    || !Number.isSafeInteger(row.claimSequence) || row.claimSequence < 1
    || typeof row.leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.leaseToken))
    throw Error(DENIED);
  return Object.freeze({ action: row.action as Action,
    identity: Object.freeze(identity as ProjectAlphaApiV2IncidentIdentity),
    expectedRevision: row.expectedRevision, at: row.at,
    ...(row.action === "claim" || row.action === "attempt"
      ? { monitorRevision: row.monitorRevision as number } : {}),
    ...(row.action === "claim" ? {} : { incidentSequence: row.incidentSequence as number,
      claimSequence: row.claimSequence as number, leaseToken: row.leaseToken as string }) });
}

function bindIdentity(identity: ProjectAlphaApiV2IncidentIdentity): [string,string,string,string,string] {
  return [identity.sourceId,identity.applicationId,identity.baseUrl,
    identity.expectedSourceInstanceId,identity.expectedHistoryEpoch];
}

function validAlert(row: AlertRow): boolean {
  const leaseValid = typeof row.lease_token === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.lease_token)
    && Number.isSafeInteger(row.lease_expires_at) && row.lease_expires_at !== null
    && row.lease_expires_at >= 0 && row.sent_at === null;
  const terminalValid = row.lease_token === null && row.lease_expires_at === null
    && ((row.status === "sent" && row.sent_at !== null && Number.isSafeInteger(row.sent_at)
      && row.sent_at >= 0) || ((row.status === "retry" || row.status === "cancelled")
      && row.sent_at === null));
  return Number.isSafeInteger(row.revision) && row.revision >= 1
    && ["leased", "retry", "sent", "cancelled"].includes(row.status)
    && Number.isSafeInteger(row.claim_sequence) && row.claim_sequence >= 1
    && Number.isSafeInteger(row.next_attempt_at) && row.next_attempt_at >= 0
    && Number.isSafeInteger(row.attempt_count) && row.attempt_count >= 0
    && (row.status === "leased" ? leaseValid : terminalValid);
}

function retryDelay(attemptCount: number): number {
  return Math.min(MAX_RETRY_MS, 60_000 * 2 ** Math.min(4, Math.max(0, attemptCount - 1)));
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw Error(DENIED);
  return result;
}

/** Internal only: no mail call and no recipient selection. */
export async function transitionProjectAlphaApiV2IncidentAlert(database: D1Database,
  rawInput: unknown): Promise<ProjectAlphaApiV2IncidentAlertResult> {
  let input: Input;
  try { input = snapshot(rawInput); } catch { throw Error(DENIED); }
  try {
    const current = await readProjectAlphaApiV2Incident(database, input.identity);
    if (current.revision !== input.expectedRevision) throw new ProjectAlphaApiV2IncidentAlertConflict();
    const state = current.state;
    if (!state) throw Error(DENIED);
    const selected = state.identity;
    const session = database.withSession("first-primary");
    const alert = await session.prepare(`SELECT revision,status,claim_sequence,lease_token,lease_expires_at,
      next_attempt_at,attempt_count,sent_at FROM project_alpha_api_v2_incident_alerts
      WHERE ${WHERE} AND incident_sequence=?`)
      .bind(...bindIdentity(selected),state.incidentSequence).first<AlertRow>();
    if (alert && !validAlert(alert)) throw Error(DENIED);
    if (alert && state.unhealthySince !== null && (alert.claim_sequence !== state.alertClaimSequence
      || (alert.status === "leased" && state.alertClaimedAt === null)
      || (alert.status === "retry" && state.alertClaimedAt !== null)
      || (alert.status === "sent" && state.alertSentAt === null))) {
      const latest = await readProjectAlphaApiV2Incident(database,selected);
      if (latest.revision !== current.revision) throw new ProjectAlphaApiV2IncidentAlertConflict();
      throw Error(DENIED);
    }
    if (input.action === "claim" && (state.unhealthySince === null || state.category === "disabled"
      || state.category === "verified" || state.alertSentAt !== null || input.at < state.lastProbeStartedAt))
      return Object.freeze({ status: "not_due", headRevision: current.revision,
        incidentSequence: state.incidentSequence, claimSequence: state.alertClaimSequence, state });
    let policyAction: "claim" | "reclaim" | "attempt" | "failed" | "sent";
    let nextStatus: AlertRow["status"], leaseToken: string | null, leaseExpiresAt: number | null;
    let nextAttemptAt: number, attemptCount: number, sentAt: number | null;
    if (input.action === "claim") {
      // Once mail was attempted, a lost provider acknowledgement is ambiguous.
      // Never reclaim this current lease automatically, even after its backoff.
      // A fresh post-failure claim resets alertAttemptedAt, so it remains reclaimable
      // if it crashes before its own attempt regardless of cumulative attempt_count.
      if (alert?.status === "leased" && alert.lease_expires_at !== null
        && alert.lease_expires_at <= input.at && state.alertAttemptedAt !== null)
        return Object.freeze({ status: "reconciliation_required", headRevision: current.revision,
          incidentSequence: state.incidentSequence, claimSequence: state.alertClaimSequence, state });
      const due = !alert ? projectAlphaApiV2AlertEligible(state,input.at)
        : alert.status === "retry" && alert.next_attempt_at <= input.at
          && projectAlphaApiV2AlertEligible(state,input.at)
        || alert.status === "leased" && alert.lease_expires_at !== null
          && alert.lease_expires_at <= input.at && alert.next_attempt_at <= input.at
          && state.alertClaimedAt !== null && state.alertSentAt === null;
      if (!due) return Object.freeze({ status: "not_due", headRevision: current.revision,
        incidentSequence: state.incidentSequence, claimSequence: state.alertClaimSequence, state });
      policyAction = alert?.status === "leased" ? "reclaim" : "claim";
      leaseToken = crypto.randomUUID();
      leaseExpiresAt = safeAdd(input.at,PROJECT_ALPHA_API_V2_ALERT_LEASE_MS);
      nextAttemptAt = safeAdd(leaseExpiresAt,CRASH_BACKOFF_MS);
      nextStatus = "leased";
      attemptCount = alert?.attempt_count ?? 0;
      sentAt = null;
    } else {
      if (!alert || alert.status !== "leased" || alert.claim_sequence !== input.claimSequence
        || alert.lease_token !== input.leaseToken || input.incidentSequence !== state.incidentSequence
        || input.claimSequence !== state.alertClaimSequence
        || state.unhealthySince === null || state.alertSentAt !== null || state.alertClaimedAt === null)
        throw Error(DENIED);
      if (input.action === "attempt" && (alert.lease_expires_at === null || input.at >= alert.lease_expires_at))
        throw Error(DENIED);
      policyAction = input.action;
      leaseToken = input.action === "attempt" ? alert.lease_token : null;
      leaseExpiresAt = input.action === "attempt" ? alert.lease_expires_at : null;
      nextStatus = input.action === "failed" ? "retry" : input.action === "sent" ? "sent" : "leased";
      attemptCount = alert.attempt_count + (input.action === "attempt" ? 1 : 0);
      nextAttemptAt = input.action === "failed" ? safeAdd(input.at,retryDelay(attemptCount)) : alert.next_attempt_at;
      sentAt = input.action === "sent" ? input.at : null;
    }
    const next = parseProjectAlphaApiV2IncidentState(advanceProjectAlphaApiV2Alert(state,
      policyAction === "claim"
        ? { action: "claim", at: input.at, incidentSequence: state.incidentSequence }
        : { action: policyAction, at: input.at, incidentSequence: state.incidentSequence,
          claimSequence: state.alertClaimSequence }));
    if (JSON.stringify(next) === JSON.stringify(state)) throw Error(DENIED);
    const nextJson = JSON.stringify(next), nextHeadRevision = current.revision + 1;
    const nextAlertRevision = (alert?.revision ?? 0) + 1;
    if (new TextEncoder().encode(nextJson).byteLength > 8192
      || !Number.isSafeInteger(nextHeadRevision) || !Number.isSafeInteger(nextAlertRevision)) throw Error(DENIED);
    const gated = input.action === "claim" || input.action === "attempt";
    const monitorBinds = gated ? [input.monitorRevision!, ...bindIdentity(selected)] : [];
    const head = session.prepare(`UPDATE project_alpha_api_v2_incident_heads
      SET revision=?,state_json=? WHERE ${WHERE} AND revision=?
        ${gated ? `AND ${MONITOR_ACTIVE}` : ""}`)
      .bind(nextHeadRevision,nextJson,...bindIdentity(selected),current.revision,...monitorBinds);
    const outbox = !alert
      ? session.prepare(`INSERT INTO project_alpha_api_v2_incident_alerts
        (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,
         incident_sequence,revision,status,claim_sequence,lease_token,lease_expires_at,next_attempt_at,
         attempt_count,sent_at)
        VALUES(?,?,?,?,?,?,1,?,?,?,?,?,0,NULL)`)
        .bind(...bindIdentity(selected),state.incidentSequence,nextStatus,next.alertClaimSequence,
          leaseToken,leaseExpiresAt,nextAttemptAt)
      : session.prepare(`UPDATE project_alpha_api_v2_incident_alerts SET revision=?,status=?,claim_sequence=?,
          lease_token=?,lease_expires_at=?,next_attempt_at=?,attempt_count=?,sent_at=?
          WHERE ${WHERE} AND incident_sequence=? AND revision=? AND status=? AND claim_sequence=?
            AND lease_token IS ?`)
        .bind(nextAlertRevision,nextStatus,next.alertClaimSequence,leaseToken,leaseExpiresAt,nextAttemptAt,
          attemptCount,sentAt,...bindIdentity(selected),state.incidentSequence,
          alert.revision,alert.status,alert.claim_sequence,alert.lease_token);
    // A zero-row CAS in either prior statement makes assertion NULL and aborts
    // the entire batch, including the head's immutable history trigger.
    const event = session.prepare(`INSERT INTO project_alpha_api_v2_incident_alert_events
      (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,
       incident_sequence,alert_revision,head_revision,claim_sequence,action,occurred_at,assertion)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,(SELECT CASE WHEN
        EXISTS(SELECT 1 FROM project_alpha_api_v2_incident_heads WHERE ${WHERE}
          AND revision=? AND state_json=? ${gated ? `AND ${MONITOR_ACTIVE}` : ""})
        AND EXISTS(SELECT 1 FROM project_alpha_api_v2_incident_alerts WHERE ${WHERE}
          AND incident_sequence=? AND revision=? AND status=? AND claim_sequence=?
          AND lease_token IS ? AND lease_expires_at IS ? AND next_attempt_at=?
          AND attempt_count=? AND sent_at IS ?)
        THEN 1 ELSE NULL END))`)
      .bind(...bindIdentity(selected),state.incidentSequence,nextAlertRevision,nextHeadRevision,
        next.alertClaimSequence,policyAction,input.at,
        ...bindIdentity(selected),nextHeadRevision,nextJson,...monitorBinds,
        ...bindIdentity(selected),state.incidentSequence,nextAlertRevision,nextStatus,next.alertClaimSequence,
        leaseToken,leaseExpiresAt,nextAttemptAt,attemptCount,sentAt);
    try {
      const results = await session.batch([head,outbox,event]);
      if (results.length !== 3 || results.some(result => !result.success)) throw Error(DENIED);
    } catch (error) {
      const latest = await readProjectAlphaApiV2Incident(database,selected);
      if (latest.revision !== current.revision) throw new ProjectAlphaApiV2IncidentAlertConflict();
      throw error;
    }
    return Object.freeze({ status: policyAction === "claim" || policyAction === "reclaim" ? "claimed"
      : policyAction === "attempt" ? "attempted" : policyAction === "failed" ? "retry" : "sent",
    headRevision: nextHeadRevision, incidentSequence: state.incidentSequence,
    claimSequence: next.alertClaimSequence, state: next,
    ...(leaseToken === null ? {} : { leaseToken }),
    ...(["claim","reclaim","failed"].includes(policyAction) ? { nextAttemptAt } : {}) });
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2IncidentAlertConflict) throw error;
    throw Error(DENIED);
  }
}
