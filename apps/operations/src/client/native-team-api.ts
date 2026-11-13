/** Native staff uses its own short-lived, identity/version-bound CSRF token.
 * Do not send these requests through api.ts, which replaces mutation tokens. */
export type NativeTeamSession = Readonly<{ csrfToken: string; verifiedUntil: string }>;
export type NativeTeamProfile = Readonly<{
  capability: "staff.profile.read";
  target: { staffId: string; admissionActive: boolean; admissionVersion: number; profileVersion: number };
  authorization: { allowed: true };
  scopedProfile: { loginEmail: string; displayName: string };
  managementSnapshot: null;
}>;
export type NativeTeamCommand = Readonly<{ commandId: string; expectedVersion: number; reason: string }>;
export type NativeTeamReceipt = Readonly<{ commandId: string; contractVersion: 1; capability: string;
  targetStaffId: string; resultVersion: number; replayed: boolean }>;
export type NativeTeamFailure = "setup_required" | "not_found" | "ended" | "denied" | "conflict" | "invalid_request" | "unavailable" | "invalid_response";
export class NativeTeamApiError extends Error {
  readonly code: NativeTeamFailure;
  readonly outcome: "not_sent" | "rejected" | "unknown";
  readonly commandId: string | undefined;
  constructor(code: NativeTeamFailure, outcome: "not_sent" | "rejected" | "unknown", commandId?: string) {
    super(code); this.name = "NativeTeamApiError";
    this.code = code; this.outcome = outcome; this.commandId = commandId;
  }
}
export type NativeTeamFetch = (path: string, init: RequestInit) => Promise<Response>;
export type NativeLogsEligibility = Readonly<{ staffId: string; username: string | null;
  effect: "allow" | "deny" | null; revision: number; admissionVersion: number; eligible: boolean;
  csrfToken: string; verifiedUntil: string }>;
export type NativeLogsCommand = Readonly<{ commandId: string; expectedRevision: number; expectedAdmissionVersion: number; effect: "allow" | "deny"; reason: string }>;
export type NativeTeamOnboardingState = "pending" | "claimed" | "approved" | "cancelled" | "expired";
export type NativeTeamOnboardingCreate = Readonly<{ commandId: string; loginEmail: string; displayName: string; expiresAt: string; reason: string }>;
export type NativeTeamOnboardingReview = Readonly<{ onboardingId: string; proposedStaffId: string; state: "claimed"; version: 2;
  loginEmail: string; displayName: string; expiresAt: string; claimedAccessSubject: string; claimEvidenceSha256: string; proposalSha256: string;
  proposal: { memberships: readonly never[]; directoryGrants: readonly never[]; managementGrants: readonly never[] }; createdByStaffId: string; reason: string }>;
export type NativeTeamOnboardingApproval = Readonly<{ commandId: string; onboardingId: string; expectedVersion: 2;
  proposalSha256: string; claimEvidenceSha256: string; reason: string }>;
export type NativeTeamOnboardingCancellation = Readonly<{ commandId: string; onboardingId: string; expectedVersion: 1 | 2; reason: string }>;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype; }
function exact(v: unknown, fields: string[]): v is Record<string, unknown> {
  return object(v) && Reflect.ownKeys(v).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(v, key);
    return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}
function positive(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
function clean(v: unknown, maximum: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maximum && v === v.trim() && !/\p{C}/u.test(v);
}
function targetId(v: string): string {
  if (!ID.test(v)) throw new NativeTeamApiError("invalid_request", "not_sent");
  return encodeURIComponent(v);
}

/** No persistent tokens, automatic retries, generated replacement command IDs,
 * rebase of expected versions, or account/permission fallback. */
export function createNativeTeamApi(fetcher: NativeTeamFetch = (path, init) => fetch(path, init), now = () => Date.now()) {
  async function send(path: string, init: RequestInit, commandId?: string): Promise<unknown> {
    const mutation = init.method === "POST", outcome = mutation ? "unknown" : "not_sent";
    let response: Response;
    try {
      response = await fetcher(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch { throw new NativeTeamApiError("unavailable", outcome, commandId); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      const code = response.status === 401 ? "ended" : response.status === 403 ? "denied"
        : response.status === 404 ? "not_found" : response.status === 409 ? "conflict"
          : response.status === 400 ? "invalid_request" : "unavailable";
      // These endpoints reject invalid bodies, unavailable routes and revision
      // conflicts before applying this command. Other HTTP failures can still
      // hide a committed write, so keep the original command unresolved.
      throw new NativeTeamApiError(code, mutation && [400, 404, 409].includes(response.status) ? "rejected" : outcome, commandId);
    }
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
      await response.body?.cancel().catch(() => {});
      throw new NativeTeamApiError("invalid_response", outcome, commandId);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new NativeTeamApiError("invalid_response", outcome, commandId);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 128 * 1024) { await reader.cancel(); throw Error(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new NativeTeamApiError("invalid_response", outcome, commandId); }
    finally { reader.releaseLock(); }
  }
  async function readSession(path: string, header: string, signal?: AbortSignal): Promise<NativeTeamSession> {
    let value: unknown;
    try { value = await send(path, { method: "GET", signal, headers: { [header]: "1", Accept: "application/json" } }); }
    catch (error) {
      if (error instanceof NativeTeamApiError && error.code === "not_found") throw new NativeTeamApiError("setup_required", "not_sent");
      throw error;
    }
    if (!exact(value, ["csrfToken", "verifiedUntil"]) || typeof value.csrfToken !== "string"
      || !/^\d{1,12}\.[0-9a-f]{64}$/.test(value.csrfToken) || typeof value.verifiedUntil !== "string"
      || !Number.isFinite(Date.parse(value.verifiedUntil)) || Date.parse(value.verifiedUntil) <= now()) {
      throw new NativeTeamApiError("invalid_response", "not_sent");
    }
    return Object.freeze({ csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil });
  }
  const session = (signal?: AbortSignal) => readSession("/api/native-staff/session", "X-Native-Staff-Request", signal);
  const claimSession = (signal?: AbortSignal) => readSession("/api/native-staff/onboarding/claim/session", "X-Onboarding-Claim-Request", signal);
  async function profile(staffId: string, signal?: AbortSignal): Promise<NativeTeamProfile> {
    const value = await send(`/api/native-staff/${targetId(staffId)}`, { method: "GET", signal,
      headers: { "X-Native-Staff-Request": "1", Accept: "application/json" } });
    if (!exact(value, ["capability", "target", "authorization", "scopedProfile", "managementSnapshot"])
      || value.capability !== "staff.profile.read" || !exact(value.target, ["staffId", "admissionActive", "admissionVersion", "profileVersion"])
      || value.target.staffId !== staffId || typeof value.target.admissionActive !== "boolean"
      || !positive(value.target.admissionVersion) || !positive(value.target.profileVersion)
      || !exact(value.authorization, ["allowed"]) || value.authorization.allowed !== true
      || !exact(value.scopedProfile, ["loginEmail", "displayName"]) || !clean(value.scopedProfile.loginEmail, 254)
      || !clean(value.scopedProfile.displayName, 160) || value.managementSnapshot !== null) {
      throw new NativeTeamApiError("invalid_response", "not_sent");
    }
    return value as unknown as NativeTeamProfile;
  }
  async function lifecycle(staffId: string, action: "profile" | "disable" | "enable",
    input: NativeTeamCommand & Readonly<{ displayName?: string }>, signal?: AbortSignal) {
    const id = targetId(staffId), fields = ["commandId", "expectedVersion", "reason", ...(action === "profile" ? ["displayName"] : [])];
    if (!["profile", "disable", "enable"].includes(action) || !exact(input, fields) || typeof input.commandId !== "string"
      || !UUID.test(input.commandId) || !positive(input.expectedVersion) || input.expectedVersion >= Number.MAX_SAFE_INTEGER
      || !clean(input.reason, 500) || action === "profile" && !clean(input.displayName, 160)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    // Capture every scalar before the first await. An uncertain retry must keep
    // these exact bytes and command ID rather than editing a pending operation.
    const body = JSON.stringify(input), commandId = input.commandId, expectedVersion = input.expectedVersion;
    if (new TextEncoder().encode(body).length > 2_048) throw new NativeTeamApiError("invalid_request", "not_sent", commandId);
    const current = await session(signal);
    if (Date.parse(current.verifiedUntil) <= now()) throw new NativeTeamApiError("ended", "not_sent", commandId);
    const value = await send(`/api/native-staff/${id}/${action}`, { method: "POST", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": current.csrfToken }, body }, commandId);
    const capability = action === "profile" ? "staff.profile.edit" : action === "disable" ? "staff.admission.disable" : "staff.admission.enable";
    if (!exact(value, ["receipt", "accessReconciliation"]) || !exact(value.receipt,
      ["commandId", "contractVersion", "capability", "targetStaffId", "resultVersion", "replayed"])
      || value.receipt.commandId !== commandId || value.receipt.contractVersion !== 1 || value.receipt.capability !== capability
      || value.receipt.targetStaffId !== staffId || value.receipt.resultVersion !== expectedVersion + 1 || typeof value.receipt.replayed !== "boolean"
      || value.accessReconciliation !== (action === "profile" ? "unchanged" : "pending")) {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { receipt: NativeTeamReceipt; accessReconciliation: "unchanged" | "pending" };
  }
  async function logsEligibility(staffId: string, signal?: AbortSignal): Promise<NativeLogsEligibility> {
    const value = await send(`/api/staff-device-eligibility/${targetId(staffId)}`, { method: "GET", signal,
      headers: { Accept: "application/json" } });
    if (!exact(value, ["staffId", "username", "effect", "revision", "admissionVersion", "eligible", "csrfToken", "verifiedUntil"])
      || value.staffId !== staffId || value.username !== null && (typeof value.username !== "string" || !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.username))
      || value.effect !== null && value.effect !== "allow" && value.effect !== "deny"
      || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !positive(value.admissionVersion) || typeof value.eligible !== "boolean"
      || value.eligible && value.effect !== "allow"
      || value.revision === 0 && value.effect !== null || value.revision > 0 && value.effect === null
      || typeof value.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)
      || typeof value.verifiedUntil !== "string" || !Number.isFinite(Date.parse(value.verifiedUntil)) || Date.parse(value.verifiedUntil) <= now()) {
      throw new NativeTeamApiError("invalid_response", "not_sent");
    }
    return value as unknown as NativeLogsEligibility;
  }
  async function setLogsEligibility(staffId: string, input: NativeLogsCommand, signal?: AbortSignal) {
    const path = `/api/staff-device-eligibility/${targetId(staffId)}`;
    if (!exact(input, ["commandId", "expectedRevision", "expectedAdmissionVersion", "effect", "reason"]) || typeof input.commandId !== "string" || !UUID.test(input.commandId)
      || !positive(input.expectedAdmissionVersion)
      || typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || input.expectedRevision >= Number.MAX_SAFE_INTEGER || input.effect !== "allow" && input.effect !== "deny" || !clean(input.reason, 500)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    const body = JSON.stringify(input), { commandId, expectedRevision, effect } = input;
    const current = await logsEligibility(staffId, signal);
    // Never replace the reviewed expected revision with a newer readback.
    // The server may return an existing receipt for this same command ID.
    const value = await send(path, { method: "POST", signal, body,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": current.csrfToken } }, commandId);
    if (!exact(value, ["receipt"]) || !exact(value.receipt, ["commandId", "staffId", "revision", "effect", "replayed"])
      || value.receipt.commandId !== commandId || value.receipt.staffId !== staffId || value.receipt.revision !== expectedRevision + 1
      || value.receipt.effect !== effect || typeof value.receipt.replayed !== "boolean") {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { receipt: { commandId: string; staffId: string; revision: number; effect: "allow" | "deny"; replayed: boolean } };
  }
  async function onboardingMutation(path: string, input: object, commandId?: string, signal?: AbortSignal, claimant = false) {
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).length > (claimant ? 2_048 : 4_096)) throw new NativeTeamApiError("invalid_request", "not_sent", commandId);
    const current = await (claimant ? claimSession(signal) : session(signal));
    if (Date.parse(current.verifiedUntil) <= now()) throw new NativeTeamApiError("ended", "not_sent", commandId);
    return send(path, { method: "POST", signal, body,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": current.csrfToken } }, commandId);
  }
  function validInstant(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function validUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
  function validHex(value: unknown): value is string { return typeof value === "string" && HEX.test(value); }
  function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
  const invitationStates = ["pending", "claimed", "approved", "cancelled", "expired"];
  async function onboardingCreate(input: NativeTeamOnboardingCreate, signal?: AbortSignal, reconcileExisting = false) {
    if (!exact(input, ["commandId", "loginEmail", "displayName", "expiresAt", "reason"]) || !validUuid(input.commandId)
      || !clean(input.loginEmail, 254) || input.loginEmail !== input.loginEmail.toLowerCase() || !/^[^\s@]+@[^\s@]+$/.test(input.loginEmail)
      || !clean(input.displayName, 160) || !clean(input.reason, 500) || !validInstant(input.expiresAt)
      || !reconcileExisting && (Date.parse(input.expiresAt) < now() + 60_000 || Date.parse(input.expiresAt) > now() + 7 * 86_400_000)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    const commandId = input.commandId;
    const value = await onboardingMutation("/api/native-staff/onboarding/create", input, commandId, signal);
    if (!exact(value, ["receipt", "state", "permissionsGranted"]) || value.permissionsGranted !== false
      || !exact(value.receipt, ["commandId", "onboardingId", "proposedStaffId", "resultVersion", "replayed", "state"])
      || value.receipt.commandId !== commandId || !validUuid(value.receipt.onboardingId) || !validId(value.receipt.proposedStaffId)
      || value.receipt.resultVersion !== 1 || typeof value.receipt.replayed !== "boolean" || typeof value.receipt.state !== "string"
      || !invitationStates.includes(value.receipt.state) || value.state !== value.receipt.state) {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { receipt: { commandId: string; onboardingId: string; proposedStaffId: string; resultVersion: 1; replayed: boolean; state: NativeTeamOnboardingState }; state: NativeTeamOnboardingState; permissionsGranted: false };
  }
  async function onboardingReveal(commandId: string, signal?: AbortSignal) {
    if (!validUuid(commandId)) throw new NativeTeamApiError("invalid_request", "not_sent");
    const value = await onboardingMutation("/api/native-staff/onboarding/reveal", { commandId }, commandId, signal);
    if (!exact(value, ["commandId", "onboardingId", "proposedStaffId", "expiresAt", "invitationSecret"])
      || value.commandId !== commandId || !validUuid(value.onboardingId) || !validId(value.proposedStaffId)
      || !validInstant(value.expiresAt) || Date.parse(value.expiresAt) <= now() || !validHex(value.invitationSecret)) {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { commandId: string; onboardingId: string; proposedStaffId: string; expiresAt: string; invitationSecret: string };
  }
  async function onboardingReview(onboardingId: string, signal?: AbortSignal): Promise<NativeTeamOnboardingReview> {
    if (!validUuid(onboardingId)) throw new NativeTeamApiError("invalid_request", "not_sent");
    const value = await send(`/api/native-staff/onboarding/${onboardingId}/review`, { method: "GET", signal,
      headers: { Accept: "application/json", "X-Native-Staff-Request": "1" } });
    if (!exact(value, ["review"]) || !exact(value.review, ["onboardingId", "proposedStaffId", "state", "version", "loginEmail", "displayName",
      "expiresAt", "claimedAccessSubject", "claimEvidenceSha256", "proposalSha256", "proposal", "createdByStaffId", "reason"])) {
      throw new NativeTeamApiError("invalid_response", "not_sent");
    }
    const review = value.review;
    if (review.onboardingId !== onboardingId || !validId(review.proposedStaffId) || review.state !== "claimed" || review.version !== 2
      || !clean(review.loginEmail, 254) || !clean(review.displayName, 160) || !validInstant(review.expiresAt) || Date.parse(review.expiresAt) <= now()
      || typeof review.claimedAccessSubject !== "string" || !review.claimedAccessSubject.trim() || review.claimedAccessSubject.length > 382
      || Array.from(review.claimedAccessSubject).length > 191 || /\p{C}/u.test(review.claimedAccessSubject)
      || new TextEncoder().encode(review.claimedAccessSubject).byteLength > 764 || !validHex(review.claimEvidenceSha256) || !validHex(review.proposalSha256)
      || !validId(review.createdByStaffId) || !clean(review.reason, 500) || !exact(review.proposal, ["memberships", "directoryGrants", "managementGrants"])
      || !Object.values(review.proposal).every(value => Array.isArray(value) && value.length === 0)) {
      throw new NativeTeamApiError("invalid_response", "not_sent");
    }
    return review as unknown as NativeTeamOnboardingReview;
  }
  async function onboardingApprove(input: NativeTeamOnboardingApproval, signal?: AbortSignal) {
    if (!exact(input, ["commandId", "onboardingId", "expectedVersion", "proposalSha256", "claimEvidenceSha256", "reason"])
      || !validUuid(input.commandId) || !validUuid(input.onboardingId) || input.expectedVersion !== 2
      || !validHex(input.proposalSha256) || !validHex(input.claimEvidenceSha256) || !clean(input.reason, 500)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    const { commandId, onboardingId } = input;
    const value = await onboardingMutation("/api/native-staff/onboarding/approve", input, commandId, signal);
    if (!exact(value, ["receipt", "permissionsGranted", "accessReconciliation"]) || value.permissionsGranted !== false || value.accessReconciliation !== "pending"
      || !exact(value.receipt, ["commandId", "onboardingId", "proposedStaffId", "resultVersion", "state", "replayed"])
      || value.receipt.commandId !== commandId || value.receipt.onboardingId !== onboardingId || !validId(value.receipt.proposedStaffId)
      || value.receipt.resultVersion !== 3 || value.receipt.state !== "approved" || typeof value.receipt.replayed !== "boolean") {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { receipt: { commandId: string; onboardingId: string; proposedStaffId: string; resultVersion: 3; state: "approved"; replayed: boolean }; permissionsGranted: false; accessReconciliation: "pending" };
  }
  async function onboardingCancel(input: NativeTeamOnboardingCancellation, signal?: AbortSignal) {
    if (!exact(input, ["commandId", "onboardingId", "expectedVersion", "reason"]) || !validUuid(input.commandId)
      || !validUuid(input.onboardingId) || ![1, 2].includes(input.expectedVersion) || !clean(input.reason, 500)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    const { commandId, onboardingId, expectedVersion } = input;
    const value = await onboardingMutation("/api/native-staff/onboarding/cancel", input, commandId, signal);
    if (!exact(value, ["receipt"]) || !exact(value.receipt, ["commandId", "onboardingId", "resultVersion", "state", "replayed"])
      || value.receipt.commandId !== commandId || value.receipt.onboardingId !== onboardingId
      || value.receipt.resultVersion !== expectedVersion + 1 || value.receipt.state !== "cancelled" || typeof value.receipt.replayed !== "boolean") {
      throw new NativeTeamApiError("invalid_response", "unknown", commandId);
    }
    return value as unknown as { receipt: { commandId: string; onboardingId: string; resultVersion: 2 | 3; state: "cancelled"; replayed: boolean } };
  }
  async function onboardingClaim(input: Readonly<{ onboardingId: string; invitationSecret: string }>, signal?: AbortSignal) {
    if (!exact(input, ["onboardingId", "invitationSecret"]) || !validUuid(input.onboardingId) || !validHex(input.invitationSecret)) {
      throw new NativeTeamApiError("invalid_request", "not_sent");
    }
    const onboardingId = input.onboardingId;
    const value = await onboardingMutation("/api/native-staff/onboarding/claim", input, undefined, signal, true);
    if (!exact(value, ["onboardingId", "state"]) || value.onboardingId !== onboardingId || value.state !== "claimed") {
      throw new NativeTeamApiError("invalid_response", "unknown");
    }
    return value as unknown as { onboardingId: string; state: "claimed" };
  }
  return Object.freeze({ session, profile, lifecycle, logsEligibility, setLogsEligibility, claimSession,
    onboardingCreate, onboardingReveal, onboardingReview, onboardingApprove, onboardingCancel, onboardingClaim });
}
