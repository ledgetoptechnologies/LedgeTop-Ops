import { createRemoteJWKSet, jwtVerify } from "jose";
import { isNativeAccessSubject } from "./native-access-subject";
import { resolveNativeStaffIdentityWithAdmissionVersion, type NativeStaffIdentity } from "./native-staff-identity";

export type NativeStaffAccessConfiguration = Readonly<{
  enabled: boolean;
  issuer: string;
  staffAudience: string;
  onboardingAudience: string;
}>;

export type AuthenticatedNativeStaff = Readonly<{
  identity: NativeStaffIdentity;
  verifiedUntil: string;
}>;

export type AuthenticatedNativeStaffWithAdmissionVersion = AuthenticatedNativeStaff & Readonly<{
  admissionVersion: number;
}>;

const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ASSERTION_LIMIT = 16_384;

function configurationSnapshot(value: NativeStaffAccessConfiguration): {
  issuer: string; staffAudience: string; onboardingAudience: string; jwksUrl: URL;
} {
  if (value === null || typeof value !== "object") throw Error();
  const enabled = value.enabled;
  const issuer = value.issuer;
  const staffAudience = value.staffAudience;
  const onboardingAudience = value.onboardingAudience;
  if (enabled !== true || typeof issuer !== "string"
    || typeof staffAudience !== "string" || typeof onboardingAudience !== "string"
    || !AUDIENCE.test(staffAudience) || !AUDIENCE.test(onboardingAudience)
    || staffAudience === onboardingAudience) throw Error();

  const url = new URL(issuer);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")
    || url.hostname === ".cloudflareaccess.com" || url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.origin !== issuer) throw Error();
  return { issuer, staffAudience, onboardingAudience: onboardingAudience,
    jwksUrl: new URL("/cdn-cgi/access/certs", url) };
}

function emailClaim(value: unknown): string {
  if (typeof value !== "string" || /\p{C}/u.test(value)) throw Error();
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !EMAIL.test(normalized)
    || /\p{C}/u.test(normalized)) throw Error();
  return normalized;
}

/** Authenticates only an existing native staff admission. No email binding, provisioning,
 * legacy StaffPrincipal, or authorization grant is inferred from the Access assertion. */
export async function authenticateNativeStaff(
  request: Request,
  database: D1Database,
  configuration: NativeStaffAccessConfiguration,
): Promise<AuthenticatedNativeStaff> {
  const authenticated = await authenticateNativeStaffWithAdmissionVersion(request, database, configuration);
  return Object.freeze({ identity: authenticated.identity, verifiedUntil: authenticated.verifiedUntil });
}

/** Includes the admission version observed with the exact native identity.
 * A later command must recheck this version atomically with its write. */
export async function authenticateNativeStaffWithAdmissionVersion(
  request: Request,
  database: D1Database,
  configuration: NativeStaffAccessConfiguration,
): Promise<AuthenticatedNativeStaffWithAdmissionVersion> {
  try {
    const authority = configurationSnapshot(configuration);
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion || assertion.length > ASSERTION_LIMIT || /\s/.test(assertion)) throw Error();

    const { payload } = await jwtVerify(assertion, createRemoteJWKSet(authority.jwksUrl), {
      issuer: authority.issuer,
      audience: authority.staffAudience,
      algorithms: ["RS256"],
    });
    const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    const now = Math.floor(Date.now() / 1000);
    if (!Array.isArray(audiences) || audiences.length !== 1
      || audiences[0] !== authority.staffAudience
      || audiences.includes(authority.onboardingAudience)
      || payload.type !== "app" || !isNativeAccessSubject(payload.sub)
      || Object.hasOwn(payload, "service_token_id")
      || (Object.hasOwn(payload, "service_token_status") && payload.service_token_status !== false)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)
      || payload.exp <= now || payload.exp > 253_402_300_799
      || typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)
      || payload.iat < 0 || payload.iat > now || payload.iat >= payload.exp
      || (payload.nbf !== undefined && (typeof payload.nbf !== "number"
        || !Number.isSafeInteger(payload.nbf) || payload.nbf > now))) throw Error();

    const verifiedUntil = new Date(payload.exp * 1000).toISOString();
    const verifiedEmail = emailClaim(payload.email);
    const verifiedAccessSubject = payload.sub;
    const resolved = await resolveNativeStaffIdentityWithAdmissionVersion(database, {
      verifiedEmail, verifiedAccessSubject,
    });
    if (resolved === null || Date.now() >= payload.exp * 1000) throw Error();
    return Object.freeze({ identity: resolved.identity, admissionVersion: resolved.admissionVersion, verifiedUntil });
  } catch {
    throw Error("native_staff_access_denied");
  }
}
