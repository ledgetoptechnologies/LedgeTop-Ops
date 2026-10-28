import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

const MAX_ACCESS_ISSUERS = 32;
const resolvers = new Map<string, JWTVerifyGetKey>();

/** Reuse jose's JWKS resolver (which maintains its own key cache) per canonical
 * Cloudflare Access issuer. This caches no token, claim, identity, or authority
 * decision; callers must still run jwtVerify and their live authorization reads
 * for every request. */
export function accessJwksResolver(issuer: string): JWTVerifyGetKey {
  const parsed = new URL(issuer);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== "/" || parsed.origin !== issuer.replace(/\/$/, "")) throw new Error("access_jwks_issuer_invalid");
  const canonicalIssuer = parsed.origin;
  const cached = resolvers.get(canonicalIssuer);
  if (cached) {
    resolvers.delete(canonicalIssuer);
    resolvers.set(canonicalIssuer, cached);
    return cached;
  }

  const resolver = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", parsed));
  if (resolvers.size >= MAX_ACCESS_ISSUERS) {
    const oldest = resolvers.keys().next().value;
    if (oldest !== undefined) resolvers.delete(oldest);
  }
  resolvers.set(canonicalIssuer, resolver);
  return resolver;
}
