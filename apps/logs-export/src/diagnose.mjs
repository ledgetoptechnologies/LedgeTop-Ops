// TEMPORARY diagnostics for the raw export Worker. NOT for normal use: the export answers every refusal with the same
// 404 on purpose, so a live 404 cannot be explained from outside. This walks the same checks in the same order and
// returns the FIRST one that fails, as a safe code plus aggregate facts:
//   - claim NAMES (never values), booleans and counts only;
//   - never the assertion, headers, client id, audience, keys, object key or object bytes.
// Use: an operator deploys a separate temporary copy whose fetch handler logs `await diagnose(request, env)` (with
// console.log) and still returns the normal answer. Remove it after the cause is found.
import { canonicalIssuer } from '../../logs-local/src/access-jwt.mjs';
import { webcrypto } from 'node:crypto';

const PATH = /^\/telemetry\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$/;
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** @returns {Promise<{ stage: string, facts: object }>} stage 'ok' when every check passes */
export async function diagnose(request, env, { fetch: fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  const facts = {};
  const fail = stage => ({ stage, facts });
  const url = new URL(request.url);
  facts.hostMatches = url.hostname === env?.EXPORT_HOST;
  facts.method = request.method;
  facts.pathShape = PATH.test(url.pathname);
  facts.hasQuery = Boolean(url.search);
  if (!facts.hostMatches) return fail('host_mismatch');
  if (request.method !== 'GET' || url.search || url.hash || !facts.pathShape) return fail('request_shape');

  let issuer;
  try { issuer = canonicalIssuer(env.ACCESS_ISSUER); } catch { return fail('config_issuer_invalid'); }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  facts.assertionPresent = Boolean(assertion);
  facts.assertionLength = assertion ? assertion.length : 0;
  facts.cookieAuthorizationPresent = /(^|;\s*)CF_Authorization=/.test(request.headers.get('Cookie') ?? '');
  if (!assertion) return fail('assertion_missing');
  const parts = assertion.split('.');
  if (parts.length !== 3) return fail('assertion_malformed');
  let header, payload;
  try { header = decode(parts[0]); payload = decode(parts[1]); } catch { return fail('assertion_not_json'); }
  facts.headerAlg = header?.alg === 'RS256' ? 'RS256' : 'other';
  facts.headerKidPresent = typeof header?.kid === 'string';
  facts.claimNames = Object.keys(payload ?? {}).sort();
  const seconds = Math.floor(now() / 1000);
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  facts.claims = {
    issMatches: payload.iss === issuer,
    issIsCloudflareAccess: typeof payload.iss === 'string' && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(payload.iss),
    audIsArray: Array.isArray(payload.aud), audCount: Array.isArray(audiences) ? audiences.length : 0,
    audContainsConfigured: Array.isArray(audiences) && audiences.includes(env.ACCESS_AUDIENCE),
    type: typeof payload.type === 'string' ? (payload.type === 'app' ? 'app' : 'other') : typeof payload.type,
    subIsEmptyString: payload.sub === '', subType: typeof payload.sub,
    emailPresent: Object.hasOwn(payload, 'email'),
    commonNamePresent: typeof payload.common_name === 'string',
    commonNameMatchesConfiguredClientId: payload.common_name === env.EXPORT_CLIENT_ID,
    commonNameEndsWithAccess: typeof payload.common_name === 'string' && payload.common_name.endsWith('.access'),
    configuredClientIdEndsWithAccess: typeof env.EXPORT_CLIENT_ID === 'string' && env.EXPORT_CLIENT_ID.endsWith('.access'),
    iatInteger: Number.isSafeInteger(payload.iat), expInteger: Number.isSafeInteger(payload.exp),
    iatNotInFuture: Number.isSafeInteger(payload.iat) && payload.iat <= seconds,
    notExpired: Number.isSafeInteger(payload.exp) && payload.exp > seconds,
    nbfOk: payload.nbf === undefined || (Number.isSafeInteger(payload.nbf) && payload.nbf <= seconds),
  };

  // Keys: fetched the same way the verifier does.
  let jwks;
  try {
    const response = await fetchImpl(new URL('/cdn-cgi/access/certs', issuer), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    facts.jwksStatus = response.status;
    jwks = await response.json();
  } catch { return fail('jwks_fetch_failed'); }
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find(k => k.kid === header.kid) : null;
  facts.jwksKeyCount = Array.isArray(jwks?.keys) ? jwks.keys.length : 0;
  facts.kidFound = Boolean(jwk);
  if (!jwk) return fail('kid_unknown');
  let signed = false;
  try {
    const key = await webcrypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, ALGORITHM, false, ['verify']);
    signed = await webcrypto.subtle.verify(ALGORITHM, key, Buffer.from(parts[2], 'base64url'), Buffer.from(`${parts[0]}.${parts[1]}`));
  } catch { return fail('signature_check_error'); }
  facts.signatureValid = signed;
  if (!signed) return fail('signature_invalid');

  const c = facts.claims;
  if (!c.issMatches) return fail('claim_iss');
  if (c.audCount !== 1) return fail('claim_aud_count');
  if (!c.audContainsConfigured) return fail('claim_aud');
  if (c.type !== 'app') return fail('claim_type');
  if (!c.subIsEmptyString) return fail('claim_sub');
  if (c.emailPresent) return fail('claim_email_present');
  if (!c.commonNamePresent) return fail('claim_common_name_missing');
  if (!c.iatInteger || !c.expInteger || !c.iatNotInFuture || !c.notExpired || !c.nbfOk) return fail('claim_time');
  if (!c.commonNameMatchesConfiguredClientId) return fail('client_id_mismatch');

  const object = await env.EXPORT_BUCKET?.head?.(url.pathname.slice(1));
  facts.objectFound = Boolean(object);
  if (!object) return fail('object_not_found');
  return fail('ok');
}
