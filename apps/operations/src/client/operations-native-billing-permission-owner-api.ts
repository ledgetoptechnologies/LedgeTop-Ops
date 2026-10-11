const BASE = "/api/native-client-portal/operations-billing-permissions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/u;
const MAX_BYTES = 65_536;
export type NativeBillingDelegatedPermission = Readonly<{
  grantId: string; effect: "allow" | "deny"; scopeKind: "resource" | "global";
  resourceId: string | null; revoked: boolean;
}>;
export type NativeBillingPermissionReview = Readonly<{
  staffId: string; resourceId: string; generation: number; permissions: readonly NativeBillingDelegatedPermission[];
}>;
export type NativeBillingPermissionSession = Readonly<{ csrfToken: string }>;
export type NativeBillingPermissionResult = Readonly<{
  status: "applied" | "replayed"; operationId: string; grantId: string; generation: number;
}> | Readonly<{ status: "conflict" }>;
export type NativeBillingPermissionIssue = Readonly<{
  operationId: string; grantId: string; expectedGeneration: number; staffId: string;
  effect: "allow" | "deny"; resourceId: string;
}>;
export type NativeBillingPermissionRevoke = Readonly<{
  operationId: string; grantId: string; expectedGeneration: number;
}>;
export class NativeBillingPermissionOwnerApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) { super(uncertain ? "uncertain" : "denied"); }
}
const denied = (status = 503, uncertain = true): never => { throw new NativeBillingPermissionOwnerApiError(status, uncertain); };
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const generation = (value: unknown, minimum = 0): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Reflect.ownKeys(value);
  return names.length === keys.length && names.every(name => typeof name === "string" && keys.includes(name)
    && Object.getOwnPropertyDescriptor(value, name)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, name)!, "value"))
    ? value as Record<string, unknown> : null;
}
function permission(value: unknown): NativeBillingDelegatedPermission {
  const row = exact(value, ["grantId", "effect", "scopeKind", "resourceId", "revoked"]);
  if (!row || !uuid(row.grantId) || row.effect !== "allow" && row.effect !== "deny"
    || row.scopeKind !== "resource" || typeof row.revoked !== "boolean" || row.revoked
    || !identifier(row.resourceId)) return denied();
  return { grantId: row.grantId, effect: row.effect, scopeKind: "resource", resourceId: row.resourceId, revoked: false };
}
function review(value: unknown, expected: Readonly<{ staffId: string; resourceId: string }>): NativeBillingPermissionReview {
  const row = exact(value, ["staffId", "resourceId", "generation", "permissions"]);
  if (!row || row.staffId !== expected.staffId || row.resourceId !== expected.resourceId || !generation(row.generation)
    || !Array.isArray(row.permissions) || row.permissions.length > 100) return denied();
  const permissions = row.permissions.map(permission), ids = new Set<string>();
  for (const item of permissions) {
    if (ids.has(item.grantId) || item.resourceId !== expected.resourceId) return denied();
    ids.add(item.grantId);
  }
  return { staffId: expected.staffId, resourceId: expected.resourceId, generation: row.generation, permissions };
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", redirect: "error", cache: "no-store",
    headers: { "X-Native-Staff-Request": "1", ...init.headers } }); }
  catch { return denied(); }
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? ""))
    denied(response.status, response.ok || response.status >= 500);
  const reader = response.body?.getReader();
  if (!reader) return denied(response.status, response.ok || response.status >= 500);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); denied(response.status); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch { return denied(response.status); }
  finally { reader.releaseLock(); }
}
function csrfHeaders(csrfToken: string) {
  if (!CSRF.test(csrfToken)) return denied(400, false);
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
}
export async function readNativeBillingPermissionSession(): Promise<NativeBillingPermissionSession> {
  const { response, value } = await request("/session");
  if (!response.ok) return denied(response.status, response.status >= 500);
  const row = exact(value, ["csrfToken"]);
  if (!row || typeof row.csrfToken !== "string" || !CSRF.test(row.csrfToken)) return denied();
  return { csrfToken: row.csrfToken };
}
export async function reviewNativeBillingPermission(csrfToken: string, input: Readonly<{ staffId: string; resourceId: string }>) {
  if (!identifier(input.staffId) || !identifier(input.resourceId)) return denied(400, false);
  const { response, value } = await request("/review", { method: "POST", headers: csrfHeaders(csrfToken), body: JSON.stringify(input) });
  if (!response.ok) return denied(response.status, response.status >= 500);
  const row = exact(value, ["review"]); if (!row) return denied();
  return review(row.review, input);
}
async function mutate(path: string, csrfToken: string, input: NativeBillingPermissionIssue | NativeBillingPermissionRevoke): Promise<NativeBillingPermissionResult> {
  if (!uuid(input.operationId) || !uuid(input.grantId) || !generation(input.expectedGeneration)
    || "staffId" in input && (!identifier(input.staffId) || !identifier(input.resourceId)
      || input.effect !== "allow" && input.effect !== "deny")) return denied(400, false);
  const { response, value } = await request(path, { method: "POST", headers: csrfHeaders(csrfToken),
    body: JSON.stringify("staffId" in input ? { confirm: true, ...input }
      : { confirm: true, operationId: input.operationId, expectedGeneration: input.expectedGeneration }) });
  const conflict = exact(value, ["error"]);
  if (response.status === 409 && conflict?.error === "conflict") return { status: "conflict" };
  if (!response.ok) return denied(response.status, response.status >= 500);
  const row = exact(value, ["status", "operationId", "grantId", "generation"]);
  if (!row || row.operationId !== input.operationId || row.grantId !== input.grantId
    || row.status !== "applied" && row.status !== "replayed"
    || !generation(row.generation, input.expectedGeneration + 1) || row.generation !== input.expectedGeneration + 1) return denied();
  return { status: row.status, operationId: input.operationId, grantId: input.grantId, generation: row.generation };
}
export async function issueNativeBillingPermission(csrfToken: string, input: NativeBillingPermissionIssue) {
  return mutate("/grants", csrfToken, input);
}
export async function revokeNativeBillingPermission(csrfToken: string, input: NativeBillingPermissionRevoke) {
  if (!uuid(input.grantId)) return denied(400, false);
  return mutate(`/grants/${encodeURIComponent(input.grantId)}/revoke`, csrfToken, input);
}
