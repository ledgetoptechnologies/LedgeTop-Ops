import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
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
 * minimal local identity key. Email is checked here because OTP eligibility is
 * email based, but authorization remains the issuer+subject local grant.
 */
export function verifiedClientPrincipalFromAccessPayload(payload: JWTPayload, configuration: ClientAccessConfiguration): VerifiedClientPrincipal | null {
  if (payload.iss !== configuration.issuer || payload.aud !== configuration.audience) return null;
  if (payload.type !== "app" || !nonEmptyString(payload.sub) || !validEmail(payload.email) || payload.email_verified !== true) return null;
  // jwtVerify validates a supplied exp, but the portal never accepts a token
  // without one. This prevents a provider/configuration mistake from creating
  // a long-lived bearer assertion.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  return { issuer: configuration.issuer, subject: payload.sub, email: payload.email.toLowerCase() };
}

export async function resolveCloudflareClientPrincipal(request: Request, env: Env): Promise<VerifiedClientPrincipal | null> {
  const configuration = clientAccessConfiguration(env);
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return null;
  try {
    const verified = await jwtVerify(
      assertion,
      createRemoteJWKSet(new URL(`${configuration.issuer}/cdn-cgi/access/certs`)),
      { issuer: configuration.issuer, audience: configuration.audience, algorithms: ["RS256"], requiredClaims: ["iss", "aud", "sub", "exp"] },
    );
    return verifiedClientPrincipalFromAccessPayload(verified.payload, configuration);
  } catch {
    return null;
  }
}
