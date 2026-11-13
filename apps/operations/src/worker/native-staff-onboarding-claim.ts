import { jwtVerify } from "jose";
import { accessJwksResolver } from "./access-jwks";
import { isNativeAccessSubject } from "./native-access-subject";

const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const ASSERTION_LIMIT = 16_384;
const encoder = new TextEncoder();
const verifiedClaimants = new WeakSet<object>();

export type NativeStaffClaimConfiguration = Readonly<{
  enabled: boolean; environment: string; issuer: string; staffAudience: string; claimantAudience: string;
}>;
export type VerifiedNativeStaffClaimant = Readonly<{
  issuer: string; audience: string; subject: string; email: string; verifiedUntil: string; assertionSha256: string;
}>;

function snapshot(configuration: NativeStaffClaimConfiguration) {
  if (!configuration || configuration.enabled !== true || configuration.environment !== "staging"
    || typeof configuration.issuer !== "string" || typeof configuration.staffAudience !== "string"
    || typeof configuration.claimantAudience !== "string" || !AUDIENCE.test(configuration.staffAudience)
    || !AUDIENCE.test(configuration.claimantAudience) || configuration.claimantAudience === configuration.staffAudience)
    throw new Error("native_staff_onboarding_claim_denied");
  const issuer = new URL(configuration.issuer);
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com")
    || issuer.hostname === ".cloudflareaccess.com" || issuer.origin !== configuration.issuer || issuer.port
    || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash)
    throw new Error("native_staff_onboarding_claim_denied");
  return Object.freeze({ issuer: issuer.origin, staffAudience: configuration.staffAudience,
    claimantAudience: configuration.claimantAudience });
}

function emailClaim(value: unknown): string {
  if (typeof value !== "string" || /\p{C}/u.test(value)) throw new Error("native_staff_onboarding_claim_denied");
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email) || /\p{C}/u.test(email))
    throw new Error("native_staff_onboarding_claim_denied");
  return email;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Verifies an invitee's dedicated Access assertion without requiring or creating staff admission. */
export async function authenticateNativeStaffOnboardingClaimant(request: Request,
  configuration: NativeStaffClaimConfiguration): Promise<VerifiedNativeStaffClaimant> {
  try {
    const authority = snapshot(configuration);
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion || assertion.length > ASSERTION_LIMIT || /\s/u.test(assertion)) throw Error();
    const { payload } = await jwtVerify(assertion, accessJwksResolver(authority.issuer), {
      issuer: authority.issuer, audience: authority.claimantAudience, algorithms: ["RS256"],
    });
    const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    const now = Math.floor(Date.now() / 1000);
    if (!Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== authority.claimantAudience
      || payload.type !== "app" || !isNativeAccessSubject(payload.sub)
      || Object.hasOwn(payload, "common_name") || Object.hasOwn(payload, "service_token_id")
      || (Object.hasOwn(payload, "service_token_status") && payload.service_token_status !== false)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= now
      || payload.exp > 253_402_300_799 || typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)
      || payload.iat < 0 || payload.iat > now || payload.iat >= payload.exp
      || (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || payload.nbf > now)))
      throw Error();
    const subject = payload.sub, email = emailClaim(payload.email), verifiedUntil = new Date(payload.exp * 1000).toISOString();
    const assertionSha256 = await sha256(encoder.encode(assertion));
    if (Date.now() >= payload.exp * 1000) throw Error();
    const result = Object.freeze({ issuer: authority.issuer, audience: authority.claimantAudience, subject, email,
      verifiedUntil, assertionSha256 });
    verifiedClaimants.add(result);
    return result;
  } catch {
    throw new Error("native_staff_onboarding_claim_denied");
  }
}

function validClaim(value: unknown): value is VerifiedNativeStaffClaimant {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 6) return false;
  const row = value as Record<string, unknown>;
  return typeof row.issuer === "string" && typeof row.audience === "string" && AUDIENCE.test(row.audience)
    && isNativeAccessSubject(row.subject) && typeof row.email === "string" && row.email === row.email.trim().toLowerCase()
    && row.email.length >= 3 && row.email.length <= 254 && EMAIL.test(row.email)
    && typeof row.verifiedUntil === "string" && Number.isFinite(Date.parse(row.verifiedUntil)) && Date.parse(row.verifiedUntil) > Date.now()
    && typeof row.assertionSha256 === "string" && /^[0-9a-f]{64}$/u.test(row.assertionSha256);
}

/** Consumes the bearer secret and binds the pending row to a verified claimant in one CAS update. */
export async function claimNativeStaffOnboarding(database: D1Database, raw: unknown,
  claimantRaw: unknown): Promise<Readonly<{ onboardingId: string; state: "claimed" }>> {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype
      || Reflect.ownKeys(raw).length !== 2) throw Error();
    const input = raw as Record<string, unknown>;
    if (typeof input.onboardingId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.onboardingId)
      || typeof input.invitationSecret !== "string" || !/^[0-9a-f]{64}$/u.test(input.invitationSecret)
    || !validClaim(claimantRaw) || !verifiedClaimants.has(claimantRaw)) throw Error();
    const claimant = claimantRaw;
    const secretDigest = await sha256(encoder.encode(input.invitationSecret));
    const evidence = JSON.stringify(["native-staff-onboarding-claim-v1", input.onboardingId, claimant.issuer,
      claimant.audience, claimant.subject, claimant.email, claimant.assertionSha256, secretDigest]);
    const evidenceSha256 = await sha256(encoder.encode(evidence));
    if (Date.parse(claimant.verifiedUntil) <= Date.now()) throw Error();
    const result = await database.withSession("first-primary").prepare(`UPDATE native_staff_pending_onboarding
      SET state='claimed',version=2,claimed_access_subject=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),claim_evidence_sha256=?
      WHERE onboarding_id=? AND state='pending' AND version=1 AND login_email=?
        AND invitation_secret_sha256=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND ? > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(claimant.subject, evidenceSha256, input.onboardingId, claimant.email, secretDigest, claimant.verifiedUntil).run();
    if (result.meta.changes !== 1) throw Error();
    return Object.freeze({ onboardingId: input.onboardingId, state: "claimed" as const });
  } catch {
    throw new Error("native_staff_onboarding_claim_denied");
  }
}
