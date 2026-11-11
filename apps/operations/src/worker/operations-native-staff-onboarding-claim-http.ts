import { readBoundedJson } from "./bounded-json";
import { admittedOperationsRequestOrigin } from "./host-admission";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding,
  type VerifiedNativeStaffClaimant } from "./native-staff-onboarding-claim";
import { consumeNativeStaffOnboardingRateLimit } from "./native-staff-onboarding-rate-limit";

const BASE = "/api/native-staff/onboarding/claim";
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const HEADERS = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
const encoder = new TextEncoder();
type Dependencies = Readonly<{ enabledFlag: string; environment?: string; expectedHost: string; operationsOrigins?: string;
  issuer: string; staffAudience: string; claimantAudience: string; origin: string; csrfSecret: string; database: D1Database;
  claim?: typeof claimNativeStaffOnboarding }>;
class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const response = (status: number, value: unknown) => new Response(JSON.stringify(value),
  { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}
function snapshot(d: Dependencies) {
  try {
    const origin = new URL(d.origin), issuer = new URL(d.issuer);
    if (d.enabledFlag !== "true" || d.environment !== "staging" || !/(?:^|[-.])staging(?:[-.]|$)/u.test(d.expectedHost)
      || origin.protocol !== "https:" || origin.origin !== d.origin || origin.hostname !== d.expectedHost
      || origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || issuer.protocol !== "https:" || issuer.origin !== d.issuer || issuer.port || issuer.username || issuer.password
      || issuer.pathname !== "/" || issuer.search || issuer.hash || !issuer.hostname.endsWith(".cloudflareaccess.com")
      || issuer.hostname === ".cloudflareaccess.com" || !AUDIENCE.test(d.staffAudience)
      || !AUDIENCE.test(d.claimantAudience) || d.claimantAudience === d.staffAudience
      || encoder.encode(d.csrfSecret).byteLength < 32 || encoder.encode(d.csrfSecret).byteLength > 512) throw Error();
    return Object.freeze({ origin: origin.origin, issuer: issuer.origin, staffAudience: d.staffAudience,
      claimantAudience: d.claimantAudience, secret: d.csrfSecret });
  } catch { throw new Failure(404, "not_found"); }
}
function message(config: ReturnType<typeof snapshot>, subject: string, bucket: number) {
  return encoder.encode(JSON.stringify(["native-staff-onboarding-claim-csrf-v1", config.issuer,
    config.claimantAudience, config.origin, subject, bucket]));
}
async function csrf(config: ReturnType<typeof snapshot>, subject: string, request?: Request): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000), key = await crypto.subtle.importKey("raw", encoder.encode(config.secret),
    { name: "HMAC", hash: "SHA-256" }, false, request ? ["verify"] : ["sign"]);
  if (request) {
    const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u), supplied = Number(token?.[1]);
    const signature = token && Uint8Array.from(token[2]!.match(/../gu)!, byte => Number.parseInt(byte, 16));
    if (!token || supplied !== bucket && supplied !== bucket - 1 || !signature
      || !await crypto.subtle.verify("HMAC", key, signature, message(config, subject, supplied))) throw new Failure(403, "denied");
    return "";
  }
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message(config, subject, bucket)));
  return `${bucket}.${[...signature].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function quotaKey(secret: string, label: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${label}\0${value}`)));
  let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte);
  return `${label}:${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}

/** Exact staging-only claimant session/claim boundary. It never creates a staff admission. */
export async function handleOperationsNativeStaffOnboardingClaimHttp(request: Request, d: Dependencies): Promise<Response> {
  try {
    const config = snapshot(d), url = new URL(request.url);
    const session = request.method === "GET" && url.pathname === `${BASE}/session`;
    const claim = request.method === "POST" && url.pathname === BASE;
    if (!session && !claim || url.search || url.hash || url.username || url.password || url.port) throw new Failure(404, "not_found");
    const requestOrigin = admittedOperationsRequestOrigin(request.url, { ENVIRONMENT: d.environment ?? "",
      EXPECTED_HOST: d.expectedHost, OPERATIONS_ORIGINS: d.operationsOrigins }, config.origin);
    if (!requestOrigin || url.origin !== requestOrigin || request.headers.get("Sec-Fetch-Site") !== "same-origin"
      || request.headers.has("Origin") && request.headers.get("Origin") !== requestOrigin
      || (claim && request.headers.get("Origin") !== requestOrigin)
      || (session && request.headers.get("X-Onboarding-Claim-Request") !== "1")) throw new Failure(403, "denied");
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || ip.length > 128 || /[\p{C}]/u.test(ip)
      || !await consumeNativeStaffOnboardingRateLimit(d.database, await quotaKey(config.secret, "ip", ip), 60, 60))
      throw new Failure(429, "rate_limited");
    let claimant;
    try { claimant = await authenticateNativeStaffOnboardingClaimant(request, { enabled: true, environment: d.environment ?? "",
      issuer: config.issuer, staffAudience: config.staffAudience, claimantAudience: config.claimantAudience }); }
    catch { throw new Failure(403, "denied"); }
    const subjectKey = await quotaKey(config.secret, "subject", claimant.subject);
    if (!await consumeNativeStaffOnboardingRateLimit(d.database, subjectKey, 30, 60)) throw new Failure(429, "rate_limited");
    if (Date.parse(claimant.verifiedUntil) <= Date.now()) throw new Failure(403, "denied");
    if (session) {
      const csrfToken = await csrf(config, claimant.subject);
      if (Date.parse(claimant.verifiedUntil) <= Date.now()) throw new Failure(403, "denied");
      return response(200, { csrfToken, verifiedUntil: claimant.verifiedUntil });
    }
    await csrf(config, claimant.subject, request);
    if (Date.parse(claimant.verifiedUntil) <= Date.now()) throw new Failure(403, "denied");
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
      throw new Failure(400, "invalid_request");
    let value: unknown;
    try { value = await readBoundedJson(request, 2_048, "native staff onboarding claim"); }
    catch { throw new Failure(400, "invalid_request"); }
    if (!exact(value, ["onboardingId", "invitationSecret"]) || typeof value.onboardingId !== "string"
      || typeof value.invitationSecret !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.onboardingId)
      || !HEX.test(value.invitationSecret)) throw new Failure(400, "invalid_request");
    const result = await (d.claim ?? claimNativeStaffOnboarding)(d.database, value, claimant as VerifiedNativeStaffClaimant);
    // The claim CAS checks that the verified deadline is still future at the
    // mutation itself. Do not turn a committed claim into a misleading 403 if
    // the token expires while D1 is acknowledging the write.
    return response(200, result);
  } catch (error) {
    if (error instanceof Failure) return response(error.status, { error: error.code });
    if (error instanceof Error && error.message === "native_staff_onboarding_claim_denied")
      return response(403, { error: "denied" });
    return response(503, { error: "unavailable" });
  }
}
