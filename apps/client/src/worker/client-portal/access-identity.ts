import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";

/** Values required by the dedicated, human Client Portal Access application. */
export interface ClientAccessConfiguration {
  issuer: string;
  audience: string;
}

export class ClientAccessConfigurationError extends Error {
  constructor() { super("client-access-configuration-invalid"); }
}

function nonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEmail(value: unknown): value is string {
  return nonEmptyString(value, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function includesExpectedAudience(audience: JWTPayload["aud"], expected: string): boolean {
  return audience === expected || (Array.isArray(audience) && audience.includes(expected));
}

/**
 * Access normally injects the assertion header before invoking a Worker.
 * Browsers also receive the same signed application token in the
 * CF_Authorization cookie. Use the cookie only when the injected header is
 * absent, then subject it to the identical issuer, audience, expiry, and
 * signature checks below.
 */
function accessAuthorizationCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== "CF_Authorization") continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * Validates configuration before a request reaches an identity or grant
 * lookup. The client application gets a distinct audience and issuer so an
 * Operations or service assertion can never be replayed at this boundary.
 */
export function clientAccessConfiguration(env: Pick<Env, "CLIENT_ACCESS_TEAM_DOMAIN" | "CLIENT_ACCESS_AUD">): ClientAccessConfiguration {
  const issuer = env.CLIENT_ACCESS_TEAM_DOMAIN?.replace(/\/$/, "") ?? "";
  const audience = env.CLIENT_ACCESS_AUD?.trim() ?? "";
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash || !nonEmptyString(audience)) throw new Error("invalid");
  } catch {
    throw new ClientAccessConfigurationError();
  }
  return { issuer, audience };
}

/**
 * Turns a cryptographically verified Cloudflare Access app assertion into the
 * minimal local identity key. Cloudflare Access and its configured IdP verify
 * the human email before issuing an application token; the token supplies the
 * email claim but does not promise a separate email_verified claim.
 * Authorization remains the issuer+subject local grant.
 */
export function verifiedClientPrincipalFromAccessPayload(payload: JWTPayload, configuration: ClientAccessConfiguration): VerifiedClientPrincipal | null {
  if (payload.iss !== configuration.issuer || !includesExpectedAudience(payload.aud, configuration.audience)) return null;
  if (payload.type !== "app" || !nonEmptyString(payload.sub) || !validEmail(payload.email)) return null;
  // jwtVerify validates a supplied exp, but the portal never accepts a token
  // without one. This prevents a provider/configuration mistake from creating
  // a long-lived bearer assertion.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  return { issuer: configuration.issuer, subject: payload.sub, email: payload.email.toLowerCase() };
}

/** Safe diagnostic category only; no value from a token is logged. */
function principalMappingRejection(payload: JWTPayload, configuration: ClientAccessConfiguration): string | null {
  if (payload.iss !== configuration.issuer) return "issuer";
  if (!includesExpectedAudience(payload.aud, configuration.audience)) return "audience";
  if (payload.type !== "app") return "type";
  if (!nonEmptyString(payload.sub)) return "subject";
  if (!validEmail(payload.email)) return "email";
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return "expiry";
  return null;
}

export async function resolveCloudflareClientPrincipal(
  request: Request,
  env: Env,
  getKey?: JWTVerifyGetKey,
): Promise<VerifiedClientPrincipal | null> {
  const configuration = clientAccessConfiguration(env);
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")
    ?? accessAuthorizationCookie(request.headers.get("Cookie"));
  if (!assertion) {
    console.warn("client-portal-access: assertion missing");
    return null;
  }
  try {
    const verified = await jwtVerify(
      assertion,
      getKey ?? createRemoteJWKSet(new URL(`${configuration.issuer}/cdn-cgi/access/certs`)),
      { issuer: configuration.issuer, audience: configuration.audience, algorithms: ["RS256"], requiredClaims: ["iss", "aud", "sub", "exp"] },
    );
    const principal = verifiedClientPrincipalFromAccessPayload(verified.payload, configuration);
    const rejection = principalMappingRejection(verified.payload, configuration);
    if (rejection) console.warn(`client-portal-access: verified assertion did not map (${rejection})`);
    return principal;
  } catch (error) {
    // Deliberately expose only the verifier category: assertion contents and
    // identity claims must never reach Worker logs.
    const category = error instanceof Error ? error.name : "unknown";
    console.warn(`client-portal-access: assertion rejected (${category})`);
    return null;
  }
}
