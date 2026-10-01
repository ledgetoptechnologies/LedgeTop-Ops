import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";

const BASE = "/api/client/operations/recipient-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
type Proof = { principal: VerifiedClientPrincipal; verifiedUntil: string };
export type NativeRecipientConsentTarget = Readonly<{ targetId: string; targetRevision: number; clientRecordId: string }>;
export interface OperationsNativeRecipientEnrollmentBinding {
  inspectNativeEnrollment(input: { protocolVersion: 1; intentId: string; opaqueToken: string }): Promise<unknown>;
  redeemNativeEnrollment(input: { protocolVersion: 1; intentId: string; opaqueToken: string; operationId: string;
    acknowledged: true; acknowledgedTarget: NativeRecipientConsentTarget;
    principal: { issuer: string; subject: string }; recipientLabel: string; verifiedUntil: string }): Promise<unknown>;
}
export interface OperationsNativeRecipientEnrollmentHttpDependencies {
  env: Env; enabled: boolean; environment: string; origin: string; csrfSecret: string;
  binding?: OperationsNativeRecipientEnrollmentBinding;
  /** Deterministic test adapter only. Production uses signed Access proof. */
  resolveProof?: (request: Request, env: Env) => Promise<Proof | null>;
}
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function opaque(input: unknown, maximum = 191): input is string {
  if (typeof input !== "string" || !input || Array.from(input).length > maximum || /\p{C}/u.test(input)) return false;
  const bytes = new TextEncoder().encode(input);
  return bytes.byteLength <= maximum * 4 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === input;
}
function accessAssertedRecipientLabel(email: string): string | null {
  if (!opaque(email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  const characters = Array.from(email.toLowerCase());
  if (characters.length <= 160) return characters.join("");
  const separator = email.lastIndexOf("@");
  const domain = separator > 0 ? `@${email.slice(separator + 1).toLowerCase()}` : "";
  const domainCharacters = Array.from(domain);
  if (domainCharacters.length < 120) {
    const local = Array.from(email.slice(0, separator).toLowerCase());
    return `${local.slice(0, 159 - domainCharacters.length).join("")}…${domain}`;
  }
  return `${characters.slice(0, 159).join("")}…`;
}
function instant(input: unknown): input is string {
  if (typeof input !== "string" || input.length !== 24) return false;
  const time = Date.parse(input);
  return Number.isFinite(time) && new Date(time).toISOString() === input;
}
function target(input: unknown): NativeRecipientConsentTarget | null {
  const value = exact(input, ["targetId", "targetRevision", "clientRecordId"]);
  return value && typeof value.targetId === "string" && UUID.test(value.targetId)
    && typeof value.targetRevision === "number" && Number.isSafeInteger(value.targetRevision) && value.targetRevision > 0
    && opaque(value.clientRecordId) ? { targetId: value.targetId, targetRevision: value.targetRevision,
      clientRecordId: value.clientRecordId } : null;
}
function response(input: unknown, status = 200): Response {
  return Response.json(input, { status, headers: { "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store" } });
}
async function csrfKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function csrfPayload(proof: Proof, bucket: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["operations-native-recipient-consent-v1", proof.principal.issuer, proof.principal.subject, bucket]));
}
async function csrf(secret: string, proof: Proof): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await csrfKey(secret), csrfPayload(proof, bucket)));
  return `${bucket}.${[...signature].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function csrfValid(secret: string, proof: Proof, input: string | null): Promise<boolean> {
  const match = input?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  if (!match) return false;
  const bucket = Number(match[1]), current = Math.floor(Date.now() / 600_000);
  if (bucket !== current && bucket !== current - 1) return false;
  const signature = Uint8Array.from(match[2]!.match(/../gu)!, byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await csrfKey(secret), signature, csrfPayload(proof, bucket));
}
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw Error("invalid");
  const reader = request.body?.getReader();
  if (!reader) throw Error("invalid");
  let size = 0, source = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) throw Error("invalid");
      source += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(source + decoder.decode());
  } catch {
    await reader.cancel().catch(() => undefined);
    throw Error("invalid");
  } finally { reader.releaseLock(); }
}
async function boundedRpc(call: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([call(), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("transport")), 1500);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
function canonicalRpc(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof input !== "string" || new TextEncoder().encode(input).byteLength > 4096) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return null; }
  return JSON.stringify(parsed) === input ? exact(parsed, keys) : null;
}

/** Separately named native consent path: never translates a native target into
 * a PA selection. Consent becomes pending review, not home or file access. */
export async function handleOperationsNativeRecipientEnrollmentHttp(request: Request,
  dependencies: OperationsNativeRecipientEnrollmentHttpDependencies): Promise<Response> {
  if (!dependencies.enabled || dependencies.environment !== "staging") return response({ error: "Not found" }, 404);
  let url: URL, origin: URL;
  try { url = new URL(request.url); origin = new URL(dependencies.origin); }
  catch { return response({ error: "Unavailable" }, 503); }
  if (origin.protocol !== "https:" || origin.origin !== dependencies.origin || !/(?:^|[-.])staging(?:[-.]|$)/u.test(origin.hostname)
    || dependencies.csrfSecret.length < 32 || dependencies.csrfSecret.length > 512 || !dependencies.binding)
    return response({ error: "Unavailable" }, 503);
  const presentedOrigin = request.headers.get("Origin");
  if (url.origin !== origin.origin || (request.method === "GET" ? presentedOrigin !== null && presentedOrigin !== origin.origin : presentedOrigin !== origin.origin)
    || request.headers.get("Sec-Fetch-Site") !== "same-origin" || request.headers.get("X-Operations-Enrollment-Request") !== "1")
    return response({ error: "Not allowed" }, 403);
  if (![`${BASE}/session`, `${BASE}/inspect`, `${BASE}/redeem`].includes(url.pathname) || url.search || url.hash)
    return response({ error: "Not found" }, 404);
  let proof: Proof | null;
  try { proof = await (dependencies.resolveProof ?? resolveCloudflareRecipientEnrollmentProof)(request, dependencies.env); }
  catch { return response({ error: "Unavailable" }, 503); }
  const fresh = () => proof !== null && instant(proof.verifiedUntil) && Date.parse(proof.verifiedUntil) > Date.now();
  if (!fresh()) return response({ error: "Sign-in required" }, 401);
  const verified = proof!;
  try {
    if (url.pathname === `${BASE}/session`) {
      if (request.method !== "GET") return response({ error: "Not allowed" }, 405);
      const token = await csrf(dependencies.csrfSecret, verified);
      return fresh() ? response({ csrfToken: token }) : response({ error: "Sign-in required" }, 401);
    }
    if (request.method !== "POST") return response({ error: "Not allowed" }, 405);
    if (!await csrfValid(dependencies.csrfSecret, verified, request.headers.get("X-CSRF-Token"))) return response({ error: "Not allowed" }, 403);
    const inspect = url.pathname === `${BASE}/inspect`;
    const input = exact(await readBody(request), inspect ? ["intentId", "opaqueToken"]
      : ["intentId", "opaqueToken", "operationId", "acknowledged", "acknowledgedTarget"]);
    if (!input || typeof input.intentId !== "string" || !UUID.test(input.intentId)
      || typeof input.opaqueToken !== "string" || !TOKEN.test(input.opaqueToken)) return response({ error: "Invalid request" }, 400);
    if (!fresh()) return response({ error: "Sign-in required" }, 401);
    if (inspect) {
      const result = canonicalRpc(await boundedRpc(() => dependencies.binding!.inspectNativeEnrollment({ protocolVersion: 1,
        intentId: input.intentId as string, opaqueToken: input.opaqueToken as string })), ["intentId", "revision", "state", "target", "expiresAt"]);
      if (!fresh()) return response({ error: "Sign-in required" }, 401);
      const selected = result && exact(result.target, ["targetId", "targetRevision", "clientRecordId", "displayLabel"]);
      const selectedTarget = selected && target({ targetId: selected.targetId, targetRevision: selected.targetRevision, clientRecordId: selected.clientRecordId });
      if (!result || result.intentId !== input.intentId || result.revision !== 1 || result.state !== "issued"
        || !selectedTarget || typeof selected?.displayLabel !== "string" || !selected.displayLabel.trim()
        || selected.displayLabel.length > 300 || /\p{C}/u.test(selected.displayLabel)
        || !instant(result.expiresAt) || Date.parse(result.expiresAt) <= Date.now()) return response({ error: "Enrollment is unavailable" }, 403);
      return response({ intentId: result.intentId, revision: 1, state: "issued",
        target: { ...selectedTarget, displayLabel: selected.displayLabel }, expiresAt: result.expiresAt });
    }
    const selected = target(input.acknowledgedTarget);
    if (!selected || input.acknowledged !== true || typeof input.operationId !== "string" || !UUID.test(input.operationId))
      return response({ error: "Invalid request" }, 400);
    const recipientLabel = accessAssertedRecipientLabel(verified.principal.email);
    if (!recipientLabel) return response({ error: "Enrollment is unavailable" }, 403);
    const intentId = input.intentId, opaqueToken = input.opaqueToken, operationId = input.operationId;
    const result = canonicalRpc(await boundedRpc(() => dependencies.binding!.redeemNativeEnrollment({ protocolVersion: 1,
      intentId, opaqueToken, operationId, acknowledged: true, acknowledgedTarget: selected,
      principal: { issuer: verified.principal.issuer, subject: verified.principal.subject }, recipientLabel,
      verifiedUntil: verified.verifiedUntil })),
      ["intentId", "revision", "state"]);
    if (!fresh()) return response({ error: "Sign-in required" }, 401);
    return result?.intentId === intentId && result.revision === 2 && result.state === "pending"
      ? response({ intentId, revision: 2, state: "pending" }) : response({ error: "Enrollment is unavailable" }, 403);
  } catch (error) {
    return response({ error: "Enrollment is unavailable" }, error instanceof Error && error.message === "invalid" ? 400 : 503);
  }
}
