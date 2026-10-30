import { verifyPilotAccessAssertion } from './ios-pilot-access';

/** Synthetic-only OAuth routing probe. No databases, business APIs, logs,
 * assets, scheduled handlers, or credentials are bound by this module. Only
 * the isolated staging origin is eligible; it returns a fixed marker after
 * Access validation and never serves business data. */
const REVIEWED_PROBE_ORIGINS: readonly string[] = ['https://ios-pilot-staging.ledgetop.app'];
const PROBE_PATH = '/oauth-probe/v1';
type ProbeEnvironment = {
  ENVIRONMENT?: string;
  IOS_OAUTH_PROBE_ENABLED?: string;
  IOS_OAUTH_PROBE_ORIGIN?: string;
  IOS_OAUTH_PROBE_AUDIENCE?: string;
  TEAM_DOMAIN?: string;
  OPERATIONS_AUD?: string;
};
type VerifyAssertion = typeof verifyPilotAccessAssertion;
type ProbeAccess = { aud?: string; getIdentity?: () => Promise<unknown> };
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const marker = (stage: 'unavailable' | 'request-rejected' | 'assertion-missing' | 'assertion-invalid' | 'ok') =>
  ({ ...headers, 'X-LT-Ops-Probe-Stage': stage });
const missing = () => Response.json({ error: 'Not found' }, { status: 404, headers: marker('unavailable') });

/** Separate pure routing surface permits tests without granting the deployed
 * entrypoint a runtime-controlled origin allowlist or bypassing verification. */
export async function handleOAuthProbe(request: Request, env: ProbeEnvironment,
  reviewedOrigins: readonly string[], verify: VerifyAssertion = verifyPilotAccessAssertion,
  access?: ProbeAccess): Promise<Response> {
  if (env.ENVIRONMENT !== 'staging' || env.IOS_OAUTH_PROBE_ENABLED !== 'true'
    || !env.IOS_OAUTH_PROBE_ORIGIN || !env.IOS_OAUTH_PROBE_AUDIENCE
    || !env.TEAM_DOMAIN || !env.OPERATIONS_AUD || !reviewedOrigins.includes(env.IOS_OAUTH_PROBE_ORIGIN)) return missing();
  let url: URL;
  try {
    url = new URL(request.url);
    const expected = new URL(env.IOS_OAUTH_PROBE_ORIGIN);
    if (expected.protocol !== 'https:' || expected.origin !== env.IOS_OAUTH_PROBE_ORIGIN
      || expected.username || expected.password || expected.port || expected.pathname !== '/'
      || expected.search || expected.hash || url.origin !== expected.origin
      || url.pathname !== PROBE_PATH || url.search || url.hash || request.method !== 'GET') return missing();
  } catch { return missing(); }
  if (request.headers.has('Cookie') || request.headers.has('Origin')) {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: marker('request-rejected') });
  }
  // Access resolves the OAuth credential to an application assertion. The
  // original Authorization header is not a documented origin requirement.
  // This synthetic endpoint is not evidence of bearer-only authentication.
  if (!request.headers.get('Cf-Access-Jwt-Assertion')) {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: marker('assertion-missing') });
  }
  let claims: Awaited<ReturnType<VerifyAssertion>>;
  try {
    claims = await verify(request, { teamDomain: env.TEAM_DOMAIN, pilotAudience: env.IOS_OAUTH_PROBE_AUDIENCE,
      operationsAudience: env.OPERATIONS_AUD });
  } catch {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: marker('assertion-invalid') });
  }
  // This is a diagnostic, never an authorization bypass. The successful
  // synthetic marker remains usable if context is missing or unavailable.
  // Only fixed categories are emitted after the signed assertion validates.
  let context: 'missing' | 'audience-mismatch' | 'identity-unavailable' | 'identity-mismatch' | 'match' = 'missing';
  if (access) {
    if (access.aud !== env.IOS_OAUTH_PROBE_AUDIENCE) context = 'audience-mismatch';
    else if (typeof access.getIdentity !== 'function') context = 'identity-unavailable';
    else {
      try {
        const value = await access.getIdentity();
        if (!value || typeof value !== 'object' || Array.isArray(value)) context = 'identity-unavailable';
        else {
          const identity = value as Record<string, unknown>;
          if (typeof identity.user_uuid !== 'string' || typeof identity.email !== 'string') context = 'identity-unavailable';
          else context = identity.user_uuid === claims.subject && identity.email.trim().toLowerCase() === claims.email ? 'match' : 'identity-mismatch';
        }
      } catch { context = 'identity-unavailable'; }
    }
  }
  // Never reflect the bearer, assertion, identity, or any request input.
  return Response.json({ ok: true, kind: 'synthetic-oauth-probe' }, { status: 200,
    headers: { ...marker('ok'), 'X-LT-Ops-Access-Context': context } });
}

export default {
  fetch(request: Request, env: ProbeEnvironment, ctx?: { access?: ProbeAccess }): Promise<Response> {
    return handleOAuthProbe(request, env, REVIEWED_PROBE_ORIGINS, verifyPilotAccessAssertion, ctx?.access);
  },
};
