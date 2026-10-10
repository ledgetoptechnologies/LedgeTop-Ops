const BASE = "/api/native-client-portal/operations-recipient-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;

export type OperationsNativeRecipientState =
  | "issued" | "pending" | "confirming" | "active" | "revoking" | "revoked" | "cancelled";
export type OperationsNativeRecipientReview = Readonly<{
  intentId: string;
  revision: number;
  state: OperationsNativeRecipientState;
  target: Readonly<{ targetId: string; targetRevision: number; clientRecordId: string }>;
  principal: Readonly<{ issuer: string; subject: string }> | null;
  /** Presentation only. Authorization and identity remain issuer + subject. */
  recipientLabel: string;
  recipientBindingId: string | null;
  expiresAt: string;
  /** Present only after an owner-authorized read exposes a recoverable durable operation. */
  recoveryOperationId: string | null;
}>;
export type OperationsNativeRecipientOwnerSession = Readonly<{
  csrfToken: string;
  verifiedUntil: string;
  recipientOrigin: string;
}>;
export type OperationsNativeRecipientIssueInput = Readonly<{
  operationId: string;
  targetId: string;
  targetClientRecordId: string;
  expiresAt: string;
}>;
export type OperationsNativeRecipientMutationAction = "confirm" | "revoke" | "cancel" | "recover";
export type OperationsNativeRecipientMutationInput = Readonly<{
  operationId: string;
  expectedRevision: number;
}>;
export type OperationsNativeRecipientMutationResult =
  | Readonly<{ kind: "cancel"; review: OperationsNativeRecipientReview; replayed: boolean }>
  | Readonly<{ kind: "transport"; operationId: string; status: "acknowledged" | "pending";
      intent: OperationsNativeRecipientReview; replayed: boolean | null }>;
export type OperationsNativeWorkspaceCleanupReview = Readonly<{
  targetId: string;
  state: "active" | "revoking" | "revoked";
  ownershipEpoch: number;
  recoveryOperationId: string | null;
}>;
export type OperationsNativeWorkspaceCleanupAction = "revoke" | "recover";
export type OperationsNativeWorkspaceCleanupInput = Readonly<{
  operationId: string;
  expectedOwnershipEpoch: number;
  reason?: string;
}>;
export type OperationsNativeWorkspaceCleanupResult = Readonly<{
  operationId: string;
  status: "acknowledged" | "pending";
  workspace: OperationsNativeWorkspaceCleanupReview;
  replayed: boolean | null;
}>;

export class OperationsNativeRecipientApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) {
    super(uncertain ? "uncertain" : "denied");
  }
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Object.keys(value);
  if (required.some(name => !Object.hasOwn(value, name))
    || names.some(name => !required.includes(name) && !optional.includes(name))
    || names.length < required.length || names.length > required.length + optional.length) return null;
  return value as Record<string, unknown>;
}
function canonicalInstant(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/\p{C}/u.test(value);
}
function accessIssuer(value: unknown): value is string {
  if (!bounded(value, 512)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port
      && url.hostname.endsWith(".cloudflareaccess.com") && url.hostname !== ".cloudflareaccess.com";
  } catch { return false; }
}
function parseReview(value: unknown): OperationsNativeRecipientReview | null {
  const row = exactRecord(value,
    ["intentId", "revision", "state", "target", "principal", "recipientBindingId", "expiresAt"],
    ["recipientLabel", "recoveryOperationId"]);
  const target = row && exactRecord(row.target, ["targetId", "targetRevision", "clientRecordId"]);
  if (!row || typeof row.intentId !== "string" || !UUID.test(row.intentId)
    || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.state !== "string" || !["issued", "pending", "confirming", "active", "revoking", "revoked", "cancelled"].includes(row.state)
    || !target || typeof target.targetId !== "string" || !UUID.test(target.targetId)
    || typeof target.targetRevision !== "number" || !Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1
    || !bounded(target.clientRecordId, 191) || !canonicalInstant(row.expiresAt)
    || row.recipientBindingId !== null && (typeof row.recipientBindingId !== "string" || !UUID.test(row.recipientBindingId))) return null;
  const principalRecord = row.principal === null ? null : exactRecord(row.principal, ["issuer", "subject"]);
  const principal = row.principal === null ? null
    : principalRecord && accessIssuer(principalRecord.issuer) && bounded(principalRecord.subject, 512)
      ? { issuer: principalRecord.issuer, subject: principalRecord.subject } : undefined;
  if (principal === undefined) return null;
  const recovery = row.recoveryOperationId === undefined || row.recoveryOperationId === null ? null
    : typeof row.recoveryOperationId === "string" && UUID.test(row.recoveryOperationId) ? row.recoveryOperationId : undefined;
  if (recovery === undefined
    || row.state === "issued" && (principal !== null || row.recipientBindingId !== null || recovery !== null)
    || row.state === "pending" && (principal === null || row.recipientBindingId !== null || recovery !== null)
    || ["confirming", "active", "revoking", "revoked"].includes(row.state)
      && (principal === null || row.recipientBindingId === null)) return null;
  const recipientLabel = row.recipientLabel === undefined
    ? `Recipient ${(row.intentId as string).slice(0, 8)}`
    : bounded(row.recipientLabel, 160) ? row.recipientLabel : null;
  if (!recipientLabel) return null;
  return Object.freeze({ intentId: row.intentId, revision: row.revision, state: row.state as OperationsNativeRecipientState,
    target: Object.freeze({ targetId: target.targetId as string, targetRevision: target.targetRevision as number,
      clientRecordId: target.clientRecordId as string }), principal: principal ? Object.freeze(principal) : null,
    recipientLabel, recipientBindingId: row.recipientBindingId as string | null, expiresAt: row.expiresAt,
    recoveryOperationId: recovery });
}
function sameReviewIdentity(actual: OperationsNativeRecipientReview, expected: OperationsNativeRecipientReview,
  allowInitialBindingAllocation = false) {
  return actual.intentId === expected.intentId && actual.target.targetId === expected.target.targetId
    && actual.target.targetRevision === expected.target.targetRevision
    && actual.target.clientRecordId === expected.target.clientRecordId
    && actual.principal?.issuer === expected.principal?.issuer && actual.principal?.subject === expected.principal?.subject
    && actual.recipientLabel === expected.recipientLabel
    && (allowInitialBindingAllocation
      ? expected.recipientBindingId === null && actual.recipientBindingId !== null
      : actual.recipientBindingId === expected.recipientBindingId)
    && actual.expiresAt === expected.expiresAt;
}
function parseWorkspaceCleanup(value: unknown): OperationsNativeWorkspaceCleanupReview | null {
  const row = exactRecord(value, ["targetId", "state", "ownershipEpoch", "recoveryOperationId"]);
  if (!row || typeof row.targetId !== "string" || !UUID.test(row.targetId)
    || typeof row.state !== "string" || !["active", "revoking", "revoked"].includes(row.state)
    || typeof row.ownershipEpoch !== "number" || !Number.isSafeInteger(row.ownershipEpoch) || row.ownershipEpoch < 1
    || row.recoveryOperationId !== null
      && (typeof row.recoveryOperationId !== "string" || !UUID.test(row.recoveryOperationId))
    || row.state === "active" && row.recoveryOperationId !== null
    || row.state !== "active" && row.recoveryOperationId === null) return null;
  return Object.freeze({ targetId: row.targetId, state: row.state as OperationsNativeWorkspaceCleanupReview["state"],
    ownershipEpoch: row.ownershipEpoch, recoveryOperationId: row.recoveryOperationId as string | null });
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new OperationsNativeRecipientApiError(503, true);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new OperationsNativeRecipientApiError(response.status,
    response.status >= 500 || response.status === 429);
  if (payload === null) throw new OperationsNativeRecipientApiError(503, true);
  return payload;
}

export async function openOperationsNativeRecipientOwnerSession(): Promise<OperationsNativeRecipientOwnerSession> {
  const value = exactRecord(await request("/session", { headers: { "X-Native-Staff-Request": "1" } }),
    ["csrfToken", "verifiedUntil", "recipientOrigin"]);
  if (!value || typeof value.csrfToken !== "string" || !CSRF.test(value.csrfToken)
    || !canonicalInstant(value.verifiedUntil) || Date.parse(value.verifiedUntil) <= Date.now()
    || typeof value.recipientOrigin !== "string") throw new OperationsNativeRecipientApiError(503, true);
  let recipient: URL;
  try { recipient = new URL(value.recipientOrigin); } catch { throw new OperationsNativeRecipientApiError(503, true); }
  if (recipient.protocol !== "https:" || recipient.origin !== value.recipientOrigin || recipient.pathname !== "/"
    || recipient.search || recipient.hash || recipient.username || recipient.password || recipient.port)
    throw new OperationsNativeRecipientApiError(503, true);
  return Object.freeze({ csrfToken: value.csrfToken, verifiedUntil: value.verifiedUntil,
    recipientOrigin: recipient.origin });
}

export async function issueOperationsNativeRecipientIntent(csrfToken: string, input: OperationsNativeRecipientIssueInput) {
  if (!CSRF.test(csrfToken) || !UUID.test(input.operationId) || !UUID.test(input.targetId)
    || !bounded(input.targetClientRecordId, 191) || !canonicalInstant(input.expiresAt))
    throw new OperationsNativeRecipientApiError(400, false);
  const value = exactRecord(await request("/intents", { method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(input) }),
  ["review", "replayed"], ["opaqueToken"]);
  const review = value && parseReview(value.review);
  if (!value || !review || typeof value.replayed !== "boolean" || review.revision !== 1 || review.state !== "issued"
    || review.target.targetId !== input.targetId || review.target.clientRecordId !== input.targetClientRecordId
    || review.expiresAt !== input.expiresAt
    || value.replayed === false && (typeof value.opaqueToken !== "string" || !TOKEN.test(value.opaqueToken))
    || value.replayed === true && value.opaqueToken !== undefined) throw new OperationsNativeRecipientApiError(503, true);
  return Object.freeze({ review, opaqueToken: typeof value.opaqueToken === "string" ? value.opaqueToken : null,
    replayed: value.replayed });
}

export async function readOperationsNativeRecipientIntent(intentId: string) {
  if (!UUID.test(intentId)) throw new OperationsNativeRecipientApiError(400, false);
  const value = exactRecord(await request(`/intents/${encodeURIComponent(intentId)}`), ["intent"]);
  const intent = value && parseReview(value.intent);
  if (!intent || intent.intentId !== intentId) throw new OperationsNativeRecipientApiError(503, true);
  return intent;
}

export async function readOperationsNativeWorkspaceCleanup(targetId: string) {
  if (!UUID.test(targetId)) throw new OperationsNativeRecipientApiError(400, false);
  const value = exactRecord(await request(`/workspaces/${encodeURIComponent(targetId)}`), ["workspace"]);
  const workspace = value && parseWorkspaceCleanup(value.workspace);
  if (!workspace || workspace.targetId !== targetId) throw new OperationsNativeRecipientApiError(503, true);
  return workspace;
}

export async function mutateOperationsNativeWorkspaceCleanup(csrfToken: string,
  workspace: OperationsNativeWorkspaceCleanupReview, action: OperationsNativeWorkspaceCleanupAction,
  input: OperationsNativeWorkspaceCleanupInput): Promise<OperationsNativeWorkspaceCleanupResult> {
  const reasonValid = action === "revoke" ? bounded(input.reason, 500) : input.reason === undefined;
  if (!CSRF.test(csrfToken) || !UUID.test(input.operationId) || !Number.isSafeInteger(input.expectedOwnershipEpoch)
    || input.expectedOwnershipEpoch !== workspace.ownershipEpoch || !reasonValid
    || action === "revoke" && workspace.state !== "active"
    || action === "recover" && (workspace.state !== "revoking" && workspace.state !== "revoked"
      || workspace.recoveryOperationId !== input.operationId)) throw new OperationsNativeRecipientApiError(400, false);
  const body = action === "revoke"
    ? { operationId: input.operationId, expectedOwnershipEpoch: input.expectedOwnershipEpoch, reason: input.reason }
    : { operationId: input.operationId, expectedOwnershipEpoch: input.expectedOwnershipEpoch };
  const raw = await request(`/workspaces/${encodeURIComponent(workspace.targetId)}/${action}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) });
  const value = exactRecord(raw, ["operationId", "status", "workspace"], ["replayed"]);
  const current = value && parseWorkspaceCleanup(value.workspace);
  if (!value || !current || value.operationId !== input.operationId
    || value.status !== "acknowledged" && value.status !== "pending"
    || value.replayed !== undefined && typeof value.replayed !== "boolean"
    || current.targetId !== workspace.targetId
    || action === "revoke" && (current.ownershipEpoch !== workspace.ownershipEpoch + 1
      || value.status === "pending" && current.state !== "revoking"
      || value.status === "acknowledged" && current.state !== "revoked"
      || current.recoveryOperationId !== input.operationId)
    || action === "recover" && (current.ownershipEpoch !== workspace.ownershipEpoch
      || value.status === "pending" && current.state !== workspace.state
      || value.status === "acknowledged" && current.state !== "revoked"
      || current.recoveryOperationId !== input.operationId)) throw new OperationsNativeRecipientApiError(503, true);
  return Object.freeze({ operationId: input.operationId, status: value.status as "acknowledged" | "pending",
    workspace: current, replayed: typeof value.replayed === "boolean" ? value.replayed : null });
}

export async function mutateOperationsNativeRecipientIntent(csrfToken: string,
  intent: OperationsNativeRecipientReview, action: OperationsNativeRecipientMutationAction,
  input: OperationsNativeRecipientMutationInput): Promise<OperationsNativeRecipientMutationResult> {
  if (!CSRF.test(csrfToken) || !UUID.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision !== intent.revision) throw new OperationsNativeRecipientApiError(400, false);
  const raw = await request(`/intents/${encodeURIComponent(intent.intentId)}/${action}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(input) });
  if (action === "cancel") {
    const value = exactRecord(raw, ["review", "replayed"]), review = value && parseReview(value.review);
    if (!value || !review || typeof value.replayed !== "boolean" || review.state !== "cancelled"
      || review.revision !== intent.revision + 1 || !sameReviewIdentity(review, intent))
      throw new OperationsNativeRecipientApiError(503, true);
    return Object.freeze({ kind: "cancel", review, replayed: value.replayed });
  }
  const value = exactRecord(raw, ["operationId", "status", "intent"], ["replayed"]);
  const current = value && parseReview(value.intent);
  const initialBindingAllocation = action === "confirm" && intent.state === "pending"
    && intent.recipientBindingId === null;
  if (!value || !current || value.operationId !== input.operationId
    || value.status !== "acknowledged" && value.status !== "pending"
    || value.replayed !== undefined && typeof value.replayed !== "boolean"
    || !sameReviewIdentity(current, intent, initialBindingAllocation))
    throw new OperationsNativeRecipientApiError(503, true);
  const allowed = action === "confirm"
    ? value.status === "pending" && current.state === "confirming" && current.revision === intent.revision + 1
      || value.status === "acknowledged" && current.state === "active"
        && (current.revision === intent.revision + 1 || current.revision === intent.revision + 2)
    : action === "revoke"
      ? value.status === "pending" && current.state === "revoking" && current.revision === intent.revision + 1
        || value.status === "acknowledged" && current.state === "revoked"
          && (current.revision === intent.revision + 1 || current.revision === intent.revision + 2)
      : value.status === "pending" && current.state === intent.state && current.revision === intent.revision
        || value.status === "acknowledged"
          && ((intent.state === "confirming" && current.state === "active" && current.revision === intent.revision + 1)
            || (intent.state === "active" && current.state === "active" && current.revision === intent.revision)
            || (intent.state === "revoking" && current.state === "revoked" && current.revision === intent.revision + 1)
            || (intent.state === "revoked" && current.state === "revoked" && current.revision === intent.revision));
  if (!allowed) throw new OperationsNativeRecipientApiError(503, true);
  return Object.freeze({ kind: "transport", operationId: input.operationId,
    status: value.status as "acknowledged" | "pending", intent: current,
    replayed: typeof value.replayed === "boolean" ? value.replayed : null });
}

export function newOperationsNativeRecipientOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
