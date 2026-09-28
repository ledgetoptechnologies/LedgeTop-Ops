const BASE = "/api/native-client-portal/recipient-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;

export type EnrollmentState = "issued" | "pending" | "active" | "revoking" | "revoked" | "cancelled";
export type EnrollmentReview = Readonly<{ intentId: string; revision: number; state: EnrollmentState;
  target: { clientRecordId: string; selectionId: string }; principal: { issuer: string; subject: string } | null; expiresAt: string }>;
export type OwnerSession = Readonly<{ csrfToken: string; verifiedUntil: string; recipientOrigin: string }>;
export type CancellationReceipt = Readonly<{ intentId: string; revision: number; state: "cancelled" }>;
export class EnrollmentApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) { super(uncertain ? "uncertain" : "denied"); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function review(value: unknown): EnrollmentReview | null {
  if (!record(value) || typeof value.intentId !== "string" || !UUID.test(value.intentId)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.state !== "string"
    || !["issued", "pending", "active", "revoking", "revoked", "cancelled"].includes(value.state)
    || !record(value.target) || typeof value.target.clientRecordId !== "string"
    || typeof value.target.selectionId !== "string" || !UUID.test(value.target.selectionId)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  const principal = value.principal === null ? null : record(value.principal)
    && typeof value.principal.issuer === "string" && typeof value.principal.subject === "string"
    ? { issuer: value.principal.issuer, subject: value.principal.subject } : undefined;
  if (principal === undefined || (value.state === "issued" && principal !== null)
    || (value.state !== "issued" && value.state !== "cancelled" && principal === null)) return null;
  return { intentId: value.intentId, revision: value.revision, state: value.state as EnrollmentState,
    target: { clientRecordId: value.target.clientRecordId, selectionId: value.target.selectionId }, principal, expiresAt: value.expiresAt };
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", cache: "no-store" });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new EnrollmentApiError(response.status, response.status >= 500 || response.status === 429);
  return payload;
}
export async function openEnrollmentOwnerSession(): Promise<OwnerSession> {
  const value = await request("/session", { headers: { "X-Native-Staff-Request": "1" } });
  if (!record(value) || typeof value.csrfToken !== "string" || !HEX.test(value.csrfToken)
    || typeof value.verifiedUntil !== "string" || !Number.isFinite(Date.parse(value.verifiedUntil))
    || typeof value.recipientOrigin !== "string") throw new EnrollmentApiError(503, true);
  let recipientOrigin: URL;
  try { recipientOrigin = new URL(value.recipientOrigin); } catch { throw new EnrollmentApiError(503, true); }
  if (recipientOrigin.protocol !== "https:" || recipientOrigin.origin !== value.recipientOrigin) throw new EnrollmentApiError(503, true);
  return { csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil, recipientOrigin: recipientOrigin.origin };
}
export async function listEnrollmentIntents(): Promise<EnrollmentReview[]> {
  const value = await request("/intents");
  if (!record(value) || !Array.isArray(value.intents) || value.intents.length > 100) throw new EnrollmentApiError(503, true);
  const parsed = value.intents.map(review);
  if (parsed.some(item => !item)) throw new EnrollmentApiError(503, true);
  return parsed as EnrollmentReview[];
}
export async function issueEnrollmentIntent(csrfToken: string, input: { operationId: string; selectionId: string;
  clientRecordId: string; expiresAt: string }): Promise<{ review: EnrollmentReview; opaqueToken: string | null; replayed: boolean }> {
  const value = await request("/intents", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(input) });
  const parsed = review(value);
  if (!parsed || !record(value) || typeof value.replayed !== "boolean"
    || parsed.revision !== 1 || parsed.state !== "issued" || parsed.principal !== null
    || parsed.target.clientRecordId !== input.clientRecordId || parsed.target.selectionId !== input.selectionId
    || parsed.expiresAt !== input.expiresAt
    || (value.replayed === false && (typeof value.opaqueToken !== "string" || !HEX.test(value.opaqueToken)))
    || (value.replayed === true && value.opaqueToken !== undefined)) throw new EnrollmentApiError(503, true);
  return { review: parsed, opaqueToken: typeof value.opaqueToken === "string" ? value.opaqueToken : null, replayed: value.replayed };
}
export async function mutateEnrollmentIntent(csrfToken: string, intent: EnrollmentReview,
  action: "confirm" | "revoke" | "reconcile" | "cancel", operationId: string): Promise<{ review: EnrollmentReview | null; receipt: CancellationReceipt | null; status: "acknowledged" | "pending" }> {
  const value = await request(`/intents/${encodeURIComponent(intent.intentId)}/${action}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ operationId, expectedRevision: intent.revision }) });
  if (!record(value)) throw new EnrollmentApiError(503, true);
  if (action === "reconcile") {
    const parsed = review(value.review);
    if (!parsed || intent.state !== "revoking" || parsed.state !== "revoked" || parsed.revision !== intent.revision + 1
      || parsed.intentId !== intent.intentId || parsed.target.clientRecordId !== intent.target.clientRecordId
      || parsed.target.selectionId !== intent.target.selectionId || parsed.principal?.issuer !== intent.principal?.issuer
      || parsed.principal?.subject !== intent.principal?.subject || parsed.expiresAt !== intent.expiresAt) throw new EnrollmentApiError(503, true);
    return { review: parsed, receipt: null, status: "acknowledged" };
  }
  if (action === "cancel" && value.intent === null && record(value.receipt)
    && (intent.state === "issued" || intent.state === "pending") && value.replayed === true
    && typeof value.receipt.intentId === "string" && value.receipt.intentId === intent.intentId
    && value.receipt.revision === intent.revision + 1 && value.receipt.state === "cancelled"
    && value.operationId === operationId && value.status === "acknowledged") {
    return { review: null, receipt: { intentId: value.receipt.intentId, revision: value.receipt.revision, state: "cancelled" }, status: "acknowledged" };
  }
  const parsed = review(value.intent);
  const expectedState = action === "confirm" ? "active" : action === "revoke" ? "revoking" : "cancelled";
  const requiredPriorState = action === "confirm" ? "pending" : action === "revoke" ? "active" : null;
  const priorAllowed = action === "cancel" ? (intent.state === "issued" || intent.state === "pending") : intent.state === requiredPriorState;
  if (!parsed || !priorAllowed || (action === "cancel" && (typeof value.replayed !== "boolean" || value.receipt !== null))
    || parsed.state !== expectedState || parsed.revision !== intent.revision + 1
    || parsed.intentId !== intent.intentId || parsed.target.clientRecordId !== intent.target.clientRecordId
    || parsed.target.selectionId !== intent.target.selectionId || parsed.principal?.issuer !== intent.principal?.issuer
    || parsed.principal?.subject !== intent.principal?.subject || parsed.expiresAt !== intent.expiresAt
    || value.operationId !== operationId || (action === "cancel" ? value.status !== "acknowledged" : (value.status !== "acknowledged" && value.status !== "pending"))) throw new EnrollmentApiError(503, true);
  return { review: parsed, receipt: null, status: value.status as "acknowledged" | "pending" };
}

export function newEnrollmentOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
