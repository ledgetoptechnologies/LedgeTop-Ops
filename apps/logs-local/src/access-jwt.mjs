// Origin verification of Cloudflare Access service-token JWTs (Cf-Access-Jwt-Assertion).
//
// Ported from the reviewed Ops verifier (apps/operations/src/worker/agent-service-auth.ts): the same issuer,
// audience and claim rules, on WebCrypto instead of jose so this host needs no runtime dependencies.
// A service-token assertion has type 'app', an empty sub, no email and common_name = the token's client id.
// Anything else (a human login, a wrong audience, an expired or unsigned token) is refused. Every failure is
// the same opaque error so callers cannot be probed for which check failed.
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const MAX_ASSERTION = 16384;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_EXP = 253402300799;
const MAX_JWKS_BYTES = 64 * 1024;

/** Reads a response body up to `limit` bytes, cancelling it beyond that (no unbounded buffering). */
export async function readBounded(response, limit) {
  if (Number(response.headers.get('Content-Length') ?? 0) > limit) { await response.body?.cancel().catch(() => {}); throw new Error('response_too_large'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error('response_too_large'); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export class AccessDenied extends Error {
  constructor() { super('access_denied'); this.name = 'AccessDenied'; }
}
const deny = () => new AccessDenied();

/** A canonical Cloudflare Access team issuer: https://<team>.cloudflareaccess.com with nothing else. */
export function canonicalIssuer(issuer) {
  let url;
  try { url = new URL(issuer ?? ''); } catch { throw new Error('access_issuer_invalid'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com') || url.hostname === '.cloudflareaccess.com'
    || url.origin !== issuer || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash)
    throw new Error('access_issuer_invalid');
  return url.origin;
}

/**
 * Fetches and caches the issuer's signing keys (/cdn-cgi/access/certs). A known key keeps working for
 * `maxAgeMs` even if a refresh fails; an unknown key id triggers at most one refresh per `cooldownMs`;
 * after `maxAgeMs` without a successful refresh every key is refused (fail closed).
 */
export function accessKeyResolver(issuer, { fetch = globalThis.fetch, now = Date.now, cooldownMs = 60_000, maxAgeMs = 60 * 60_000, timeoutMs = 5000 } = {}) {
  const url = new URL('/cdn-cgi/access/certs', canonicalIssuer(issuer));
  let keys = new Map(), fetchedAt = -Infinity, attemptedAt = -Infinity, inflight = null;
  async function refresh() {
    attemptedAt = now();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('jwks_unavailable'); }
    const body = JSON.parse(await readBounded(response, MAX_JWKS_BYTES));
    const next = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
      next.set(jwk.kid, await subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, ALGORITHM, false, ['verify']));
    }
    if (!next.size) throw new Error('jwks_empty');
    keys = next;
    fetchedAt = now();
  }
  return async function getKey(kid) {
    const fresh = () => now() - fetchedAt < maxAgeMs;
    if (fresh() && keys.has(kid)) return keys.get(kid);
    // Every refresh, including after expiry or a failed first fetch, waits out the cooldown: a stream of
    // bad or unknown-kid tokens during a JWKS outage costs at most one fetch per cooldown.
    if (now() - attemptedAt >= cooldownMs) {
      inflight ??= refresh().finally(() => { inflight = null; });
      try { await inflight; } catch { /* fall through: known, still-fresh keys only */ }
    }
    if (fresh() && keys.has(kid)) return keys.get(kid);
    throw deny();
  };
}

const json = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verifies the request's Access service assertion for exactly one issuer and audience.
 * @returns {Promise<{ clientId: string, expiresAt: number }>}
 */
export async function verifyAccessService(request, { issuer, audience }, getKey, { now = Date.now } = {}) {
  const origin = canonicalIssuer(issuer);
  if (!AUDIENCE.test(audience ?? '')) throw new Error('access_audience_invalid');
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > MAX_ASSERTION || /\s/.test(assertion)) throw deny();
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw deny();
  let header, payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { throw deny(); }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw deny();
  const key = await getKey(header.kid);
  const signed = await subtle.verify(ALGORITHM, key, Buffer.from(parts[2], 'base64url'), Buffer.from(`${parts[0]}.${parts[1]}`));
  if (!signed) throw deny();
  const seconds = Math.floor(now() / 1000);
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  if (payload.iss !== origin || !Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== audience
    || payload.type !== 'app' || payload.sub !== '' || Object.hasOwn(payload, 'email')
    || typeof payload.common_name !== 'string' || !CLIENT_ID.test(payload.common_name)
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat < 0 || payload.iat > seconds || payload.exp <= seconds || payload.exp > MAX_EXP || payload.iat >= payload.exp
    || (payload.nbf !== undefined && !(Number.isSafeInteger(payload.nbf) && payload.nbf <= seconds))) throw deny();
  return Object.freeze({ clientId: payload.common_name, expiresAt: payload.exp });
}
