const BASE = "/api/native-client-portal/operations-billing-authority";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/u;
const MAX_BYTES = 65_536;
export type NativeBillingEntity = Readonly<{ kind: "organization" | "client" | "project"; nativeId: string }>;
export type NativeBillingSelection = Readonly<{
  targetId: string; recipientBindingId: string; entity: NativeBillingEntity; expiresAt: string | null;
}>;
export type NativeBillingReview = NativeBillingSelection & Readonly<{
  expectedRevision: number; reviewFingerprint: string; grantId: string | null;
}>;
export type NativeBillingAuthority = NativeBillingSelection & Readonly<{
  grantId: string; revision: number; state: "active" | "revoked"; live: boolean;
}>;
export type NativeBillingGrant = NativeBillingSelection & Readonly<{
  operationId: string; grantId: string; expectedRevision: number; reviewFingerprint: string;
}>;
export type NativeBillingResult = Readonly<{
  status: "applied" | "replayed"; operationId: string; authority: NativeBillingAuthority;
}> | Readonly<{ status: "conflict"; reason: "conflict" }>;
export class NativeBillingOwnerApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) { super(uncertain ? "uncertain" : "denied"); }
}
const denied = (status = 503, uncertain = true): never => { throw new NativeBillingOwnerApiError(status, uncertain); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return null;
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    ? value as Record<string, unknown> : null;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 191
    && value === value.trim() && !/\p{C}/u.test(value);
}
function instant(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const integer = (value: unknown, minimum: number): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
function entity(value: unknown): value is NativeBillingEntity {
  const row = record(value, ["kind", "nativeId"]);
  return Boolean(row && ["organization", "client", "project"].includes(String(row.kind)) && text(row.nativeId));
}
function selection(value: Record<string, unknown>): boolean {
  return uuid(value.targetId) && uuid(value.recipientBindingId) && entity(value.entity) && instant(value.expiresAt);
}
function review(value: unknown): NativeBillingReview {
  const row = record(value, ["targetId", "recipientBindingId", "entity", "expiresAt", "expectedRevision", "reviewFingerprint", "grantId"]);
  if (!row || !selection(row) || !integer(row.expectedRevision, 0)
    || typeof row.reviewFingerprint !== "string" || !HASH.test(row.reviewFingerprint)
    || row.grantId !== null && !uuid(row.grantId) || (row.grantId === null) !== (row.expectedRevision === 0)) denied();
  return row as NativeBillingReview;
}
function authority(value: unknown): NativeBillingAuthority {
  const row = record(value, ["targetId", "recipientBindingId", "entity", "expiresAt", "grantId", "revision", "state", "live"]);
  if (!row || !selection(row) || !uuid(row.grantId) || !integer(row.revision, 1)
    || row.state !== "active" && row.state !== "revoked" || typeof row.live !== "boolean"
    || row.state === "revoked" && row.live) denied();
  return row as NativeBillingAuthority;
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", redirect: "error",
    cache: "no-store", headers: { "X-Native-Staff-Request": "1", ...init.headers } }); }
  catch { return denied(); }
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? ""))
    denied(response.status, response.ok || response.status >= 500);
  const reader = response.body?.getReader();
  if (!reader) throw new NativeBillingOwnerApiError(response.status, response.ok || response.status >= 500);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); denied(response.status); } chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch { return denied(response.status); }
  finally { reader.releaseLock(); }
}
function headers(csrfToken: string) {
  if (!CSRF.test(csrfToken)) denied(400, false);
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
}
export async function readNativeBillingOwnerSession(): Promise<Readonly<{ csrfToken: string }>> {
  const { response, value } = await request("/session");
  if (!response.ok) denied(response.status, response.status >= 500);
  const row = record(value, ["csrfToken"]);
  if (!row) return denied();
  if (typeof row.csrfToken !== "string" || !CSRF.test(row.csrfToken)) return denied();
  return { csrfToken: row.csrfToken };
}
export async function reviewNativeBillingSelection(csrfToken: string, input: NativeBillingSelection) {
  if (!selection(input)) denied(400, false);
  const { response, value } = await request("/review", { method: "POST", headers: headers(csrfToken), body: JSON.stringify(input) });
  if (!response.ok) denied(response.status, response.status >= 500);
  const row = record(value, ["review"]); if (!row) return denied();
  const result = review(row.review);
  if (result.targetId !== input.targetId || result.recipientBindingId !== input.recipientBindingId
    || result.entity.kind !== input.entity.kind || result.entity.nativeId !== input.entity.nativeId
    || result.expiresAt !== input.expiresAt) denied();
  return result;
}
export async function readNativeBillingAuthority(grantId: string) {
  if (!uuid(grantId)) denied(400, false);
  const { response, value } = await request(`/grants/${encodeURIComponent(grantId)}`);
  if (!response.ok) denied(response.status, response.status >= 500);
  const row = record(value, ["authority"]); if (!row) return denied();
  const result = authority(row.authority); if (result.grantId !== grantId) denied(); return result;
}
async function mutation(path: string, csrfToken: string, input: Readonly<{ operationId: string; grantId: string; expectedRevision: number }>, body: unknown): Promise<NativeBillingResult> {
  if (!uuid(input.operationId) || !uuid(input.grantId) || !integer(input.expectedRevision, 0)) denied(400, false);
  const { response, value } = await request(path, { method: "POST", headers: headers(csrfToken), body: JSON.stringify(body) });
  const conflict = record(value, ["error"]);
  if (response.status === 409 && conflict?.error === "conflict")
    return { status: "conflict", reason: "conflict" };
  if (!response.ok) denied(response.status, response.status >= 500);
  const row = record(value, ["status", "operationId", "authority"]);
  if (!row) return denied();
  if ((row.status !== "applied" && row.status !== "replayed") || row.operationId !== input.operationId) return denied();
  const result = authority(row.authority);
  if (result.grantId !== input.grantId || result.revision < input.expectedRevision + 1) denied();
  return { status: row.status as "applied" | "replayed", operationId: input.operationId, authority: result };
}
export async function grantNativeBillingAuthority(csrfToken: string, input: NativeBillingGrant) {
  if (!selection(input) || !HASH.test(input.reviewFingerprint)) denied(400, false);
  const result = await mutation("/grants", csrfToken, input, { confirm: true, ...input });
  if (result.status !== "conflict" && (result.authority.targetId !== input.targetId
    || result.authority.recipientBindingId !== input.recipientBindingId || result.authority.entity.kind !== input.entity.kind
    || result.authority.entity.nativeId !== input.entity.nativeId)) denied();
  return result;
}
export function revokeNativeBillingAuthority(csrfToken: string, input: Readonly<{ operationId: string; grantId: string; expectedRevision: number }>) {
  return mutation(`/grants/${encodeURIComponent(input.grantId)}/revoke`, csrfToken, input,
    { confirm: true, operationId: input.operationId, expectedRevision: input.expectedRevision });
}
