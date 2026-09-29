import type { Env } from "../types";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import type { VerifiedClientPrincipal } from "./types";

const BASE = "/api/client/v2/recipient-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
type Proof = { principal: VerifiedClientPrincipal; verifiedUntil: string };
export interface RecipientEnrollmentBinding {
  inspectEnrollment(input: { protocolVersion: 1; intentId: string; opaqueToken: string }): Promise<unknown>;
  redeemEnrollment(input: { protocolVersion: 1; intentId: string; opaqueToken: string; operationId: string;
    acknowledged: true; acknowledgedTarget: { clientRecordId: string; selectionId: string };
    principal: { issuer: string; subject: string }; verifiedUntil: string }): Promise<unknown>;
}
export interface RecipientEnrollmentHttpDependencies {
  env: Env;
  enabled: boolean;
  environment: string;
  origin: string;
  csrfSecret: string;
  binding?: RecipientEnrollmentBinding;
  /** Test-only verifier adapter; production uses the signed Access assertion. */
  resolveProof?: (request: Request, env: Env) => Promise<Proof | null>;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.length !== keys.length || names.some(key => !keys.includes(key) || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(names.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function bounded(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store" } });
}
async function key(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function csrfPayload(proof: Proof, bucket: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["recipient-enrollment-csrf-v1", proof.principal.issuer, proof.principal.subject, bucket]));
}
async function csrfToken(secret: string, proof: Proof) {
  const bucket = Math.floor(Date.now() / 600_000);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), csrfPayload(proof, bucket)));
  return `${bucket}.${Array.from(signature).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function csrfValid(secret: string, proof: Proof, token: string | null) {
  const match = token?.match(/^(\d{1,12})\.([0-9a-f]{64})$/);
  if (!match) return false;
  const bucket = Number(match[1]), current = Math.floor(Date.now() / 600_000);
  if (bucket !== current && bucket !== current - 1) return false;
  const signature = Uint8Array.from(match[2]!.match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await key(secret), signature, csrfPayload(proof, bucket));
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw Error("invalid");
  const reader = request.body?.getReader();
  if (!reader) throw Error("invalid");
  let bytes = 0, source = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw Error("invalid"); }
      source += decoder.decode(next.value, { stream: true });
    }
    source += decoder.decode();
    return JSON.parse(source);
  } finally { reader.releaseLock(); }
}

/** Staging-only recipient consent boundary. No GET issues or redeems an intent.
 * Browser identity fields are rejected; only current verified proof crosses RPC. */
export async function handleRecipientEnrollmentHttp(request: Request, dependencies: RecipientEnrollmentHttpDependencies): Promise<Response> {
  if (!dependencies.enabled || dependencies.environment !== "staging") return json({ error: "Not found" }, 404);
  let url: URL, origin: URL;
  try { url = new URL(request.url); origin = new URL(dependencies.origin); } catch { return json({ error: "Unavailable" }, 503); }
  if (origin.protocol !== "https:" || origin.origin !== dependencies.origin || !/(?:^|[-.])staging(?:[-.]|$)/.test(origin.hostname)
    || dependencies.csrfSecret.length < 32 || dependencies.csrfSecret.length > 512 || !dependencies.binding) return json({ error: "Unavailable" }, 503);
  const presentedOrigin = request.headers.get("Origin");
  if (url.origin !== origin.origin || (request.method === "GET" ? presentedOrigin !== null && presentedOrigin !== origin.origin : presentedOrigin !== origin.origin)
    || request.headers.get("Sec-Fetch-Site") !== "same-origin" || request.headers.get("X-Recipient-Enrollment-Request") !== "1") return json({ error: "Not allowed" }, 403);
  if (!([`${BASE}/session`, `${BASE}/inspect`, `${BASE}/redeem`].includes(url.pathname)) || url.search) return json({ error: "Not found" }, 404);
  let proof: Proof | null;
  try { proof = await (dependencies.resolveProof ?? resolveCloudflareRecipientEnrollmentProof)(request, dependencies.env); }
  catch { return json({ error: "Unavailable" }, 503); }
  if (!proof || Date.parse(proof.verifiedUntil) <= Date.now() || !Number.isFinite(Date.parse(proof.verifiedUntil))) return json({ error: "Sign-in required" }, 401);
  if (url.pathname === `${BASE}/session`) {
    if (request.method !== "GET") return json({ error: "Not allowed" }, 405);
    const token = await csrfToken(dependencies.csrfSecret, proof);
    if (Date.parse(proof.verifiedUntil) <= Date.now()) return json({ error: "Sign-in required" }, 401);
    return json({ csrfToken: token });
  }
  if (request.method !== "POST") return json({ error: "Not allowed" }, 405);
  if (!await csrfValid(dependencies.csrfSecret, proof, request.headers.get("X-CSRF-Token"))) return json({ error: "Not allowed" }, 403);
  try {
    const inspect = url.pathname === `${BASE}/inspect`;
    const input = record(await body(request), inspect ? ["intentId", "opaqueToken"]
      : ["intentId", "opaqueToken", "operationId", "acknowledged", "acknowledgedTarget"]);
    if (!input || typeof input.intentId !== "string" || !UUID.test(input.intentId)
      || typeof input.opaqueToken !== "string" || !TOKEN.test(input.opaqueToken)) return json({ error: "Invalid request" }, 400);
    if (Date.parse(proof.verifiedUntil) <= Date.now()) return json({ error: "Sign-in required" }, 401);
    if (inspect) {
      const response = record(await dependencies.binding.inspectEnrollment({ protocolVersion: 1, intentId: input.intentId, opaqueToken: input.opaqueToken }),
        ["intentId", "revision", "state", "target", "expiresAt"]);
      if (Date.parse(proof.verifiedUntil) <= Date.now()) return json({ error: "Sign-in required" }, 401);
      const target = response && record(response.target, ["clientRecordId", "selectionId", "displayLabel"]);
      if (!response || response.intentId !== input.intentId || response.revision !== 1 || response.state !== "issued"
        || !target || !bounded(target.clientRecordId) || typeof target.selectionId !== "string" || !UUID.test(target.selectionId)
        || !bounded(target.displayLabel, 300) || typeof response.expiresAt !== "string" || !Number.isFinite(Date.parse(response.expiresAt))
        || Date.parse(response.expiresAt) <= Date.now()) return json({ error: "Enrollment is unavailable" }, 403);
      return json(response);
    }
    const target = record(input.acknowledgedTarget, ["clientRecordId", "selectionId"]);
    if (input.acknowledged !== true || typeof input.operationId !== "string" || !UUID.test(input.operationId)
      || !target || !bounded(target.clientRecordId) || typeof target.selectionId !== "string" || !UUID.test(target.selectionId)) return json({ error: "Invalid request" }, 400);
    const result = await dependencies.binding.redeemEnrollment({ protocolVersion: 1, intentId: input.intentId,
      opaqueToken: input.opaqueToken, operationId: input.operationId, acknowledged: true,
      acknowledgedTarget: { clientRecordId: target.clientRecordId, selectionId: target.selectionId },
      principal: { issuer: proof.principal.issuer, subject: proof.principal.subject }, verifiedUntil: proof.verifiedUntil });
    if (Date.parse(proof.verifiedUntil) <= Date.now()) return json({ error: "Sign-in required" }, 401);
    const response = record(result, ["intentId", "revision", "state"]);
    if (!response || response.intentId !== input.intentId || response.revision !== 2 || response.state !== "pending") return json({ error: "Enrollment is unavailable" }, 403);
    return json({ intentId: response.intentId, revision: 2, state: "pending" });
  } catch (error) {
    return json({ error: "Enrollment is unavailable" }, error instanceof Error && error.message === "invalid" ? 400 : 503);
  }
}
