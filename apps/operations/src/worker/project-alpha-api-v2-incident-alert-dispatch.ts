import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-config";
import { PROJECT_ALPHA_API_V2_ALERT_LEASE_MS, ProjectAlphaApiV2IncidentAlertConflict,
  transitionProjectAlphaApiV2IncidentAlert,
  type ProjectAlphaApiV2IncidentAlertResult } from "./project-alpha-api-v2-incident-alert-store";
import { type ProjectAlphaApiV2IncidentIdentity,
  type ProjectAlphaApiV2IncidentState } from "./project-alpha-api-v2-incident-policy";
import { readProjectAlphaApiV2Incident,
  type ProjectAlphaApiV2IncidentSnapshot } from "./project-alpha-api-v2-incident-store";
import { isProjectAlphaApiV2MonitorIdentityActive } from "./project-alpha-api-v2-monitor-lifecycle";
import { NotificationMailDeliveryUncertain, sendNotificationMail, validateNotificationMailTransport, type OutboundMail } from "./mailer";
import type { Env } from "./types";

type Configuration = Readonly<{ enabled: string | undefined; connections: string | undefined }>;
type AlertAction = Readonly<{ action: "claim" | "attempt" | "failed" | "sent";
  identity: ProjectAlphaApiV2IncidentIdentity; expectedRevision: number; at: number;
  monitorRevision?: number;
  incidentSequence?: number; claimSequence?: number; leaseToken?: string }>;
export type ProjectAlphaApiV2AlertDispatchDependencies = Readonly<{
  active: (identity: ProjectAlphaApiV2IncidentIdentity, monitorRevision: number) => Promise<boolean>;
  read: (identity: ProjectAlphaApiV2IncidentIdentity) => Promise<ProjectAlphaApiV2IncidentSnapshot>;
  transition: (action: AlertAction) => Promise<ProjectAlphaApiV2IncidentAlertResult>;
  send: (mail: OutboundMail) => Promise<void>;
  /** Non-sending preflight. A missing transport must never create an outbox claim. */
  transportReady: () => void | Promise<void>;
}>;
export type ProjectAlphaApiV2AlertDispatchInput = Readonly<{
  identity: ProjectAlphaApiV2IncidentIdentity;
  /** Pinned authorized monitor lifecycle revision, not read-and-upgraded by this worker. */
  monitorRevision: number;
  /** Deployment-owned owner mailbox, never derived from PA or a client record. */
  recipient: string | undefined;
  /** Re-read this invocation's configuration; cross-deployment fencing is separate. */
  currentConfiguration: () => Configuration;
  clock?: () => number;
}>;
export type ProjectAlphaApiV2AlertDispatchResult = Readonly<{
  status: "disabled" | "configuration_unavailable" | "recipient_unavailable" | "transport_unavailable" | "not_due"
    | "reconciliation_required"
    | "suppressed" | "contended" | "storage_error" | "mail_failed_retryable"
    | "mail_failed_unrecorded" | "sent" | "accepted_ack_unknown";
}>;

const MAX_CAS_ATTEMPTS = 3;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const unhealthy = (state: ProjectAlphaApiV2IncidentState | null): state is ProjectAlphaApiV2IncidentState =>
  state !== null && state.unhealthySince !== null && state.category !== "verified"
    && state.category !== "disabled" && state.alertSentAt === null;

function address(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 254
    || value.trim() !== value || !EMAIL.test(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value.toLowerCase();
}

function detachedIdentity(raw: ProjectAlphaApiV2IncidentIdentity): ProjectAlphaApiV2IncidentIdentity {
  const keys = ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"] as const;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== keys.length) throw Error();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = keys.map(key => {
    const item = descriptors[key];
    if (!item?.enumerable || !("value" in item) || typeof item.value !== "string") throw Error();
    return item.value as string;
  });
  return Object.freeze({ sourceId: values[0]!, applicationId: values[1]!, baseUrl: values[2]!,
    expectedSourceInstanceId: values[3]!, expectedHistoryEpoch: values[4]! });
}

function configured(input: ProjectAlphaApiV2AlertDispatchInput,
  identity: ProjectAlphaApiV2IncidentIdentity): "enabled" | "disabled" | "unavailable" {
  try {
    const current = input.currentConfiguration();
    if (current.enabled !== "true") return "disabled";
    resolveProjectAlphaApiV2Connection(current.connections, identity);
    return "enabled";
  } catch { return "unavailable"; }
}

function live(state: ProjectAlphaApiV2IncidentState | null,
  claim: ProjectAlphaApiV2IncidentAlertResult, attempted: boolean, at: number,
  requireLease = true): boolean {
  return unhealthy(state) && state.incidentSequence === claim.incidentSequence
    && state.alertClaimSequence === claim.claimSequence && state.alertClaimedAt !== null
    && (!requireLease || at < state.alertClaimedAt + PROJECT_ALPHA_API_V2_ALERT_LEASE_MS)
    && (!attempted || state.alertAttemptedAt !== null);
}

function time(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw Error("invalid_alert_clock");
  return value;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;" })[character]!);
}

async function mailFor(state: ProjectAlphaApiV2IncidentState, recipient: string): Promise<OutboundMail> {
  // Message-ID is stable across retries of one logical incident, not a secret.
  const bytes = new TextEncoder().encode(`pa-v2-incident-v1\0${JSON.stringify(state.identity)}\0${state.incidentSequence}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const source = state.identity.sourceId;
  const plain = `Project Alpha API v2 connection ${source} has remained unhealthy for more than 10 minutes.\n`
    + `Status: ${state.category}\nReason: ${state.reason ?? "unknown"}\n`
    + `Source instance: ${state.identity.expectedSourceInstanceId}\n`
    + `Application: ${state.identity.applicationId}\nHistory epoch: ${state.identity.expectedHistoryEpoch}\n`
    + `Incident: ${state.incidentSequence}\n`;
  return Object.freeze({ to: recipient, fromName: "Ledge Top Operations", subject: `Project Alpha API v2 connection unhealthy: ${source}`,
    text: plain, html: `<p>Project Alpha API v2 connection <strong>${html(source)}</strong> has remained unhealthy for more than 10 minutes.</p>`
      + `<p>Status: ${html(state.category)}<br>Reason: ${html(state.reason ?? "unknown")}<br>`
      + `Source instance: ${html(state.identity.expectedSourceInstanceId)}<br>`
      + `Application: ${html(state.identity.applicationId)}<br>History epoch: ${html(state.identity.expectedHistoryEpoch)}<br>`
      + `Incident: ${state.incidentSequence}</p>`, messageIdKey: `pa-v2-incident-${key}` });
}

/** Isolated, bounded dispatcher. An expired attempted lease requires explicit
 * reconciliation: provider acceptance followed by a crash cannot be inferred
 * from local state, and the stable Message-ID is not an exactly-once guarantee. */
export async function dispatchProjectAlphaApiV2IncidentAlert(input: ProjectAlphaApiV2AlertDispatchInput,
  dependencies: ProjectAlphaApiV2AlertDispatchDependencies): Promise<ProjectAlphaApiV2AlertDispatchResult> {
  const recipient = address(input.recipient);
  if (!recipient) return Object.freeze({ status: "recipient_unavailable" });
  const monitorRevision = input.monitorRevision;
  if (!Number.isSafeInteger(monitorRevision) || monitorRevision < 1)
    return Object.freeze({ status: "configuration_unavailable" });
  let identity: ProjectAlphaApiV2IncidentIdentity;
  try { identity = detachedIdentity(input.identity); }
  catch { return Object.freeze({ status: "configuration_unavailable" }); }
  const firstConfig = configured(input, identity);
  if (firstConfig !== "enabled") return Object.freeze({ status: firstConfig === "disabled" ? "disabled" : "configuration_unavailable" });
  try { await dependencies.transportReady(); }
  catch { return Object.freeze({ status: "transport_unavailable" }); }
  const clock = input.clock ?? Date.now;
  let claim: ProjectAlphaApiV2IncidentAlertResult | null = null;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    try {
      if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" });
      const current = await dependencies.read(identity);
      if (!unhealthy(current.state)) return Object.freeze({ status: "not_due" });
      claim = await dependencies.transition({ action: "claim", identity,
        expectedRevision: current.revision, monitorRevision, at: time(clock) });
      break;
    } catch (error) {
      if (!(error instanceof ProjectAlphaApiV2IncidentAlertConflict)) return Object.freeze({ status: "storage_error" });
      if (attempt === MAX_CAS_ATTEMPTS - 1) return Object.freeze({ status: "contended" });
    }
  }
  if (claim?.status === "reconciliation_required")
    return Object.freeze({ status: "reconciliation_required" });
  if (!claim || claim.status !== "claimed" || !claim.leaseToken) return Object.freeze({ status: "not_due" });
  const token = claim.leaseToken;
  const fence = { identity, incidentSequence: claim.incidentSequence,
    claimSequence: claim.claimSequence, leaseToken: token } as const;
  if (configured(input, identity) !== "enabled") return Object.freeze({ status: "suppressed" });
  try { if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" }); }
  catch { return Object.freeze({ status: "storage_error" }); }
  let attempted: ProjectAlphaApiV2IncidentAlertResult | null = null;
  for (let retry = 0; retry < MAX_CAS_ATTEMPTS; retry++) {
    try {
      if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" });
      const current = await dependencies.read(identity);
      if (!live(current.state,claim,false,time(clock))) return Object.freeze({ status: "suppressed" });
      attempted = await dependencies.transition({ action: "attempt", ...fence,
        expectedRevision: current.revision, monitorRevision, at: time(clock) });
      break;
    } catch (error) {
      if (!(error instanceof ProjectAlphaApiV2IncidentAlertConflict)) return Object.freeze({ status: "storage_error" });
      if (retry === MAX_CAS_ATTEMPTS - 1) return Object.freeze({ status: "contended" });
    }
  }
  if (!attempted || attempted.status !== "attempted") return Object.freeze({ status: "storage_error" });
  let mail: OutboundMail;
  try {
    if (configured(input, identity) !== "enabled") return Object.freeze({ status: "suppressed" });
    if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" });
    const current = await dependencies.read(identity);
    if (!current.state || !live(current.state,claim,true,time(clock))) return Object.freeze({ status: "suppressed" });
    mail = await mailFor(current.state,recipient);
    // Hashing and database reads are async: check both fences once more immediately before send.
    if (configured(input, identity) !== "enabled") return Object.freeze({ status: "suppressed" });
    if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" });
    const final = await dependencies.read(identity);
    if (!live(final.state,claim,true,time(clock))) return Object.freeze({ status: "suppressed" });
    // Re-read the deployment-owned gate after the final awaited database call.
    if (configured(input, identity) !== "enabled") return Object.freeze({ status: "suppressed" });
    if (!await dependencies.active(identity,monitorRevision)) return Object.freeze({ status: "suppressed" });
    // The active read itself can cross the lease deadline or a local gate change.
    if (configured(input, identity) !== "enabled"
      || !live(final.state,claim,true,time(clock))) return Object.freeze({ status: "suppressed" });
  } catch {
    return Object.freeze({ status: "storage_error" });
  }
  try {
    await dependencies.send(mail);
  } catch (error) {
    // The provider may have accepted the message. Keep the attempted claim
    // intact for explicit reconciliation instead of authorizing another send.
    if (error instanceof NotificationMailDeliveryUncertain)
      return Object.freeze({ status: "reconciliation_required" });
    return await acknowledge("failed", "mail_failed_retryable", "mail_failed_unrecorded");
  }
  return await acknowledge("sent", "sent", "accepted_ack_unknown");

  async function acknowledge(action: "failed" | "sent", success: ProjectAlphaApiV2AlertDispatchResult["status"],
    unknown: ProjectAlphaApiV2AlertDispatchResult["status"]): Promise<ProjectAlphaApiV2AlertDispatchResult> {
    for (let retry = 0; retry < MAX_CAS_ATTEMPTS; retry++) {
      try {
        const current = await dependencies.read(identity);
        if (action === "sent" && current.state?.incidentSequence === claim!.incidentSequence
          && current.state.alertClaimSequence === claim!.claimSequence
          && current.state.alertSentAt !== null) return Object.freeze({ status: "sent" });
        // Mail may have been accepted after the pre-send lease check. The
        // durable transition still fences the exact token against a reclaimer.
        if (!live(current.state,claim!,true,time(clock),false)) return Object.freeze({ status: unknown });
        const result = await dependencies.transition({ action, ...fence,
          expectedRevision: current.revision, at: time(clock) });
        if (result.status !== (action === "sent" ? "sent" : "retry")) return Object.freeze({ status: unknown });
        return Object.freeze({ status: success });
      } catch (error) {
        if (!(error instanceof ProjectAlphaApiV2IncidentAlertConflict)) break;
      }
    }
    return Object.freeze({ status: unknown });
  }
}

/** Production dependency adapter; no scheduler or configuration gate is wired here. */
export function projectAlphaApiV2IncidentAlertDispatchDependencies(database: D1Database,
  mailerEnv: Env): ProjectAlphaApiV2AlertDispatchDependencies {
  return Object.freeze({ read: (identity: ProjectAlphaApiV2IncidentIdentity) => readProjectAlphaApiV2Incident(database,identity),
    active: (identity: ProjectAlphaApiV2IncidentIdentity, revision: number) =>
      isProjectAlphaApiV2MonitorIdentityActive(database,revision,identity),
    transition: (action: AlertAction) => transitionProjectAlphaApiV2IncidentAlert(database,action),
    send: (mail: OutboundMail) => sendNotificationMail(mailerEnv,mail),
    transportReady: () => validateNotificationMailTransport(mailerEnv) });
}
