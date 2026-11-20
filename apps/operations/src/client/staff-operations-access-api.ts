/** Client transport for the native staff Operations-access writer
 * (/api/staff-operations-access/:staffId). Like native-team-api.ts: the token
 * is the route's own short-lived CSRF token, there are no automatic retries, an
 * uncertain command keeps its commandId, and the reviewed expected revision is
 * never rebased onto a newer readback. */
export type OperationsAccessReason = "self" | "protected_owner" | "not_native_hire" | "target_identity_mismatch"
  | "actor_not_administrator" | "actor_lacks_roles_manage" | "actor_denied" | "actor_lacks_permission"
  | "target_denied" | "inherited" | "target_inactive" | "not_command_managed";
export type OperationsAccessEntry = Readonly<{ permission: string; state: "none" | "allow" | "deny" | "inherited";
  operation: "grant" | "revoke" | null; editable: boolean; reason: OperationsAccessReason | null }>;
export type OperationsAccessState = Readonly<{ staffId: string; targetAdmissionVersion: number | null; revision: number;
  targetEditable: boolean; targetReason: OperationsAccessReason | null; permissions: readonly OperationsAccessEntry[];
  csrfToken: string; verifiedUntil: string }>;
export type OperationsAccessCommand = Readonly<{ commandId: string; permission: string; operation: "grant" | "revoke";
  expectedRevision: number; expectedAdmissionVersion: number; reason: string }>;
export type OperationsAccessReceipt = Readonly<{ commandId: string; staffId: string; permission: string;
  operation: "grant" | "revoke"; revision: number; replayed: boolean }>;
export type OperationsAccessFailure = "not_found" | "denied" | "conflict" | "invalid_request" | "unavailable" | "invalid_response";
export class OperationsAccessApiError extends Error {
  readonly code: OperationsAccessFailure;
  readonly outcome: "not_sent" | "rejected" | "unknown";
  readonly serverError: string | null;
  readonly reason: OperationsAccessReason | null;
  constructor(code: OperationsAccessFailure, outcome: "not_sent" | "rejected" | "unknown", serverError: string | null = null, reason: OperationsAccessReason | null = null) {
    super(code); this.name = "OperationsAccessApiError";
    this.code = code; this.outcome = outcome; this.serverError = serverError; this.reason = reason;
  }
}
export type OperationsAccessFetch = (path: string, init: RequestInit) => Promise<Response>;

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(["none", "allow", "deny", "inherited"]);
const REASONS = new Set(["self", "protected_owner", "not_native_hire", "target_identity_mismatch", "actor_not_administrator",
  "actor_lacks_roles_manage", "actor_denied", "actor_lacks_permission", "target_denied", "inherited", "target_inactive", "not_command_managed"]);
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype; }
function exact(v: unknown, fields: string[]): v is Record<string, unknown> {
  return object(v) && Reflect.ownKeys(v).length === fields.length && fields.every(key => Object.hasOwn(v, key));
}
const whole = (v: unknown, minimum: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= minimum;
const reasonOf = (v: unknown): v is OperationsAccessReason | null => v === null || typeof v === "string" && REASONS.has(v);
function path(staffId: string): string {
  if (!ID.test(staffId)) throw new OperationsAccessApiError("invalid_request", "not_sent");
  return `/api/staff-operations-access/${encodeURIComponent(staffId)}`;
}

export function createOperationsAccessApi(fetcher: OperationsAccessFetch = (url, init) => fetch(url, init), now = () => Date.now()) {
  async function send(url: string, init: RequestInit): Promise<unknown> {
    const mutation = init.method === "POST", outcome = mutation ? "unknown" : "not_sent";
    let response: Response;
    try {
      response = await fetcher(url, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch { throw new OperationsAccessApiError("unavailable", outcome); }
    if (response.status !== 200) {
      let body: unknown = null;
      try { body = /^application\/json/i.test(response.headers.get("Content-Type") ?? "") ? await response.json() : null; } catch { body = null; }
      const serverError = object(body) && typeof body.error === "string" ? body.error : null;
      const reason = object(body) && reasonOf(body.reason) ? body.reason as OperationsAccessReason | null : null;
      const code = response.status === 403 || response.status === 401 ? "denied" : response.status === 404 ? "not_found"
        : response.status === 409 ? "conflict" : response.status === 400 ? "invalid_request" : "unavailable";
      // 400/403/404/409 are decided before the command is inserted; any other
      // failure may hide a committed write, so the command stays unresolved.
      // receipt_exists_reauthorize: this command id DID commit; it is never "not changed".
      const rejected = mutation && [400, 403, 404, 409].includes(response.status) && serverError !== "receipt_exists_reauthorize";
      throw new OperationsAccessApiError(code, rejected ? "rejected" : outcome, serverError, reason);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? ""))
      throw new OperationsAccessApiError("invalid_response", outcome);
    try { return await response.json(); } catch { throw new OperationsAccessApiError("invalid_response", outcome); }
  }

  async function read(staffId: string, signal?: AbortSignal): Promise<OperationsAccessState> {
    const value = await send(path(staffId), { method: "GET", signal, headers: { Accept: "application/json" } });
    if (!exact(value, ["staffId", "targetAdmissionVersion", "revision", "targetEditable", "targetReason", "permissions", "csrfToken", "verifiedUntil"])
      || value.staffId !== staffId || !(value.targetAdmissionVersion === null || whole(value.targetAdmissionVersion, 1))
      || !whole(value.revision, 0) || typeof value.targetEditable !== "boolean" || !reasonOf(value.targetReason)
      || !Array.isArray(value.permissions) || typeof value.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)
      || typeof value.verifiedUntil !== "string" || !(Date.parse(value.verifiedUntil) > now())
      || !value.permissions.every(entry => exact(entry, ["permission", "state", "operation", "editable", "reason"])
        && typeof entry.permission === "string" && STATES.has(entry.state as string)
        && (entry.operation === null || entry.operation === "grant" || entry.operation === "revoke")
        && typeof entry.editable === "boolean" && reasonOf(entry.reason) && (!entry.editable || entry.operation !== null && entry.reason === null)))
      throw new OperationsAccessApiError("invalid_response", "not_sent");
    return value as unknown as OperationsAccessState;
  }

  /** Sends exactly the given command. A retry of an uncertain command must pass
   * the same object again; nothing here generates or rebases a command. */
  async function change(staffId: string, input: OperationsAccessCommand, signal?: AbortSignal): Promise<OperationsAccessReceipt> {
    if (!exact(input, ["commandId", "permission", "operation", "expectedRevision", "expectedAdmissionVersion", "reason"])
      || typeof input.commandId !== "string" || !UUID.test(input.commandId) || typeof input.permission !== "string"
      || input.operation !== "grant" && input.operation !== "revoke" || !whole(input.expectedRevision, 0)
      || !whole(input.expectedAdmissionVersion, 1) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
      throw new OperationsAccessApiError("invalid_request", "not_sent");
    const body = JSON.stringify(input), { commandId, permission, operation, expectedRevision } = input;
    const current = await read(staffId, signal);
    const value = await send(path(staffId), { method: "POST", signal, body,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": current.csrfToken } });
    if (!exact(value, ["receipt"]) || !exact(value.receipt, ["commandId", "staffId", "permission", "operation", "revision", "replayed"])
      || value.receipt.commandId !== commandId || value.receipt.staffId !== staffId || value.receipt.permission !== permission
      || value.receipt.operation !== operation || value.receipt.revision !== expectedRevision + 1 || typeof value.receipt.replayed !== "boolean")
      throw new OperationsAccessApiError("invalid_response", "unknown");
    return value.receipt as unknown as OperationsAccessReceipt;
  }
  return Object.freeze({ read, change });
}
