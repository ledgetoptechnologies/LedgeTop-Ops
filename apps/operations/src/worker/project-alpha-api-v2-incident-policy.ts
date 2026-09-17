import type { ProjectAlphaApiV2Probe } from "./project-alpha-api-v2";
import type { ProjectAlphaApiV2ConnectionIdentity } from "./project-alpha-api-v2-config";

export type ProjectAlphaApiV2IncidentIdentity = ProjectAlphaApiV2ConnectionIdentity;

type FailureStatus = Exclude<ProjectAlphaApiV2Probe["status"], "verified">;
type FailureReason = Exclude<ProjectAlphaApiV2Probe, { status: "verified" }>["reason"];
export type ProjectAlphaApiV2IncidentCategory = "verified" | "disabled" | FailureStatus;

/** A pure, persistence-ready snapshot. No email or remote request is made here. */
export type ProjectAlphaApiV2IncidentState = Readonly<{
  identity: ProjectAlphaApiV2IncidentIdentity;
  category: ProjectAlphaApiV2IncidentCategory;
  reason: FailureReason | null;
  lastProbeStartedAt: number;
  lastAlertActionAt: number | null;
  lastVerifiedAt: number | null;
  incidentSequence: number;
  unhealthySince: number | null;
  unavailableSince: number | null;
  alertClaimedAt: number | null;
  alertClaimSequence: number;
  alertAttemptedAt: number | null;
  alertSentAt: number | null;
}>;

export type ProjectAlphaApiV2IncidentObservation =
  | Readonly<{ kind: "probe"; startedAt: number; probe: ProjectAlphaApiV2Probe }>
  | Readonly<{ kind: "disabled"; startedAt: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const DENIED = "project_alpha_api_v2_incident_denied";
const ALERT_AFTER_MS = 600_000;

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameIdentity(left: ProjectAlphaApiV2IncidentIdentity, right: ProjectAlphaApiV2IncidentIdentity): boolean {
  return left.sourceId === right.sourceId && left.applicationId === right.applicationId
    && left.baseUrl === right.baseUrl && left.expectedSourceInstanceId === right.expectedSourceInstanceId
    && left.expectedHistoryEpoch === right.expectedHistoryEpoch;
}

function snapshotIdentity(value: ProjectAlphaApiV2IncidentIdentity): ProjectAlphaApiV2IncidentIdentity {
  let baseUrl: URL;
  try { baseUrl = new URL(value.baseUrl); } catch { throw Error(DENIED); }
  if (!SOURCE.test(value.sourceId) || !UUID.test(value.applicationId)
    || !UUID.test(value.expectedSourceInstanceId) || !UUID.test(value.expectedHistoryEpoch)
    || baseUrl.protocol !== "https:" || baseUrl.origin !== value.baseUrl) throw Error(DENIED);
  return Object.freeze({ sourceId: value.sourceId, applicationId: value.applicationId,
    baseUrl: value.baseUrl, expectedSourceInstanceId: value.expectedSourceInstanceId,
    expectedHistoryEpoch: value.expectedHistoryEpoch });
}

function freeze(value: ProjectAlphaApiV2IncidentState): ProjectAlphaApiV2IncidentState {
  return Object.freeze(value);
}

function exactRecord(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) throw Error(DENIED);
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw Error(DENIED);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw Error(DENIED);
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Reject malformed persisted snapshots rather than manufacturing healthy or sent state. */
export function parseProjectAlphaApiV2IncidentState(raw: unknown): ProjectAlphaApiV2IncidentState {
  try {
    const row = exactRecord(raw, ["identity", "category", "reason", "lastProbeStartedAt", "lastAlertActionAt",
      "lastVerifiedAt", "incidentSequence", "unhealthySince", "unavailableSince", "alertClaimedAt",
      "alertClaimSequence", "alertAttemptedAt", "alertSentAt"]);
    const identityRow = exactRecord(row.identity,
      ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"]);
    if (Object.values(identityRow).some(value => typeof value !== "string")) throw Error(DENIED);
    const identity = snapshotIdentity(identityRow as ProjectAlphaApiV2IncidentIdentity);
    if (typeof row.category !== "string" || !["verified", "disabled", "misconfigured", "unavailable", "unauthorized", "incompatible", "rate_limited"].includes(row.category)) throw Error(DENIED);
    if (row.reason !== null && (typeof row.reason !== "string" || ![
      "configuration", "transport", "timeout", "credentials_or_scope", "http_status", "rate_limit",
      "response_limit", "invalid_contract", "source_mismatch", "application_mismatch", "history_epoch_mismatch",
      "missing_capability", "missing_endpoint",
    ].includes(row.reason))) throw Error(DENIED);
    for (const key of ["lastProbeStartedAt", "incidentSequence", "alertClaimSequence"] as const) {
      if (typeof row[key] !== "number" || !validTime(row[key])) throw Error(DENIED);
    }
    for (const key of ["lastAlertActionAt", "lastVerifiedAt", "unhealthySince", "unavailableSince",
      "alertClaimedAt", "alertAttemptedAt", "alertSentAt"] as const) {
      if (row[key] !== null && (typeof row[key] !== "number" || !validTime(row[key]))) throw Error(DENIED);
    }
    const state = { ...row, identity } as ProjectAlphaApiV2IncidentState;
    const healthyOrDisabled = state.category === "verified" || state.category === "disabled";
    if (state.lastVerifiedAt !== null && state.lastVerifiedAt > state.lastProbeStartedAt) throw Error(DENIED);
    if (healthyOrDisabled) {
      if (state.reason !== null || state.unhealthySince !== null || state.unavailableSince !== null
        || state.alertClaimedAt !== null || state.alertAttemptedAt !== null || state.alertSentAt !== null) throw Error(DENIED);
      if (state.category === "verified" && state.lastVerifiedAt !== state.lastProbeStartedAt) throw Error(DENIED);
    } else {
      if (state.reason === null || state.unhealthySince === null || state.incidentSequence < 1
        || state.unhealthySince > state.lastProbeStartedAt
        || (state.lastVerifiedAt !== null && state.lastVerifiedAt >= state.unhealthySince)) throw Error(DENIED);
      if (state.category === "unavailable") {
        if (state.unavailableSince === null || state.unavailableSince < state.unhealthySince
          || state.unavailableSince > state.lastProbeStartedAt) throw Error(DENIED);
      } else if (state.unavailableSince !== null) throw Error(DENIED);
    }
    if ((state.alertClaimSequence === 0) !== (state.lastAlertActionAt === null)) throw Error(DENIED);
    for (const at of [state.alertClaimedAt, state.alertAttemptedAt, state.alertSentAt]) {
      if (at !== null && (state.lastAlertActionAt === null || at > state.lastAlertActionAt
        || state.unhealthySince === null || at - state.unhealthySince <= ALERT_AFTER_MS)) throw Error(DENIED);
    }
    if (state.alertClaimedAt !== null && state.alertAttemptedAt !== null
      && state.alertAttemptedAt < state.alertClaimedAt) throw Error(DENIED);
    if (state.alertSentAt !== null && (state.alertClaimedAt !== null || state.alertAttemptedAt === null
      || state.alertSentAt < state.alertAttemptedAt)) throw Error(DENIED);
    return freeze(state);
  } catch { throw Error(DENIED); }
}

/** An observation older than the current state cannot undo a newer failure or recovery. */
export function observeProjectAlphaApiV2Incident(
  current: ProjectAlphaApiV2IncidentState | null,
  rawIdentity: ProjectAlphaApiV2IncidentIdentity,
  observation: ProjectAlphaApiV2IncidentObservation,
): ProjectAlphaApiV2IncidentState {
  const identity = snapshotIdentity(rawIdentity);
  if (!validTime(observation.startedAt) || (current && !sameIdentity(current.identity, identity))) throw Error(DENIED);
  if (current && observation.startedAt <= current.lastProbeStartedAt) return current;
  const previousSequence = current?.incidentSequence ?? 0;
  const base = {
    identity, lastProbeStartedAt: observation.startedAt, lastVerifiedAt: current?.lastVerifiedAt ?? null,
    lastAlertActionAt: current?.lastAlertActionAt ?? null, incidentSequence: previousSequence,
    alertClaimSequence: current?.alertClaimSequence ?? 0,
  };
  if (observation.kind === "disabled") return freeze({ ...base, category: "disabled", reason: null,
    unhealthySince: null, unavailableSince: null, alertClaimedAt: null, alertAttemptedAt: null, alertSentAt: null });
  const probe = observation.probe;
  if (probe.status === "verified" && probe.sourceInstanceId === identity.expectedSourceInstanceId
    && probe.applicationId === identity.applicationId
    && probe.historyEpoch === identity.expectedHistoryEpoch) return freeze({ ...base, category: "verified", reason: null,
      lastVerifiedAt: observation.startedAt, unhealthySince: null, unavailableSince: null,
      alertClaimedAt: null, alertAttemptedAt: null, alertSentAt: null });
  const category: FailureStatus = probe.status === "verified" ? "incompatible" : probe.status;
  const reason: FailureReason = probe.status !== "verified" ? probe.reason
    : probe.sourceInstanceId !== identity.expectedSourceInstanceId ? "source_mismatch"
    : probe.applicationId !== identity.applicationId ? "application_mismatch" : "history_epoch_mismatch";
  const continuing = current?.unhealthySince !== null && current?.unhealthySince !== undefined;
  return freeze({ ...base, category, reason,
    incidentSequence: continuing ? previousSequence : previousSequence + 1,
    unhealthySince: continuing ? current!.unhealthySince : observation.startedAt,
    unavailableSince: category === "unavailable"
      ? (current?.category === "unavailable" ? current.unavailableSince : observation.startedAt) : null,
    alertClaimedAt: continuing ? current!.alertClaimedAt : null,
    alertAttemptedAt: continuing ? current!.alertAttemptedAt : null,
    alertSentAt: continuing ? current!.alertSentAt : null });
}

/** Eligibility is strictly after ten continuous unhealthy minutes, including degraded auth/contract failures. */
export function projectAlphaApiV2AlertEligible(state: ProjectAlphaApiV2IncidentState, at: number): boolean {
  return validTime(at) && (state.lastAlertActionAt === null || at >= state.lastAlertActionAt)
    && at >= state.lastProbeStartedAt && state.unhealthySince !== null
    && at - state.unhealthySince > ALERT_AFTER_MS && state.alertClaimedAt === null && state.alertSentAt === null;
}

export type ProjectAlphaApiV2AlertEvent =
  | Readonly<{ action: "claim"; at: number; incidentSequence: number }>
  | Readonly<{ action: "reclaim" | "attempt" | "failed" | "sent"; at: number; incidentSequence: number; claimSequence: number }>;

/** Claim, attempt, and successful delivery are distinct for a future durable outbox. */
export function advanceProjectAlphaApiV2Alert(
  current: ProjectAlphaApiV2IncidentState,
  event: ProjectAlphaApiV2AlertEvent,
): ProjectAlphaApiV2IncidentState {
  if (!validTime(event.at) || event.incidentSequence !== current.incidentSequence
    || (current.lastAlertActionAt !== null && event.at < current.lastAlertActionAt)) return current;
  if (event.action === "claim") {
    if (!projectAlphaApiV2AlertEligible(current, event.at)) return current;
    return freeze({ ...current, lastAlertActionAt: event.at, alertClaimedAt: event.at,
      alertClaimSequence: current.alertClaimSequence + 1, alertAttemptedAt: null });
  }
  if (current.unhealthySince === null || current.alertClaimedAt === null || current.alertSentAt !== null
    || event.claimSequence !== current.alertClaimSequence) return current;
  // Only the durable store may use this after verifying lease expiry/backoff.
  // A crash before attempt must not be recorded as a fabricated send failure.
  if (event.action === "reclaim") return freeze({ ...current, lastAlertActionAt: event.at,
    alertClaimedAt: event.at, alertClaimSequence: current.alertClaimSequence + 1, alertAttemptedAt: null });
  if (event.action === "attempt") {
    if (current.alertAttemptedAt !== null && current.alertAttemptedAt >= current.alertClaimedAt) return current;
    return freeze({ ...current, lastAlertActionAt: event.at, alertAttemptedAt: event.at });
  }
  if (current.alertAttemptedAt === null || current.alertAttemptedAt < current.alertClaimedAt) return current;
  if (event.action === "failed") return freeze({ ...current, lastAlertActionAt: event.at, alertClaimedAt: null });
  if (event.action === "sent") return freeze({ ...current, lastAlertActionAt: event.at, alertClaimedAt: null, alertSentAt: event.at });
  throw Error(DENIED);
}
