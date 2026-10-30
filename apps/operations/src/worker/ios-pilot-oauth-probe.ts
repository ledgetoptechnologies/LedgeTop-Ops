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
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const marker = (stage: 'unavailable' | 'request-rejected' | 'assertion-missing' | 'assertion-invalid' | 'ok') =>
  ({ ...headers, 'X-LT-Ops-Probe-Stage': stage });
const missing = () => Response.json({ error: 'Not found' }, { status: 404, headers: marker('unavailable') });

/** Separate pure routing surface permits tests without granting the deployed
 * entrypoint a runtime-controlled origin allowlist or bypassing verification. */
export async function handleOAuthProbe(request: Request, env: ProbeEnvironment,
  reviewedOrigins: readonly string[], verify: VerifyAssertion = verifyPilotAccessAssertion): Promise<Response> {
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
  try {
    await verify(request, { teamDomain: env.TEAM_DOMAIN, pilotAudience: env.IOS_OAUTH_PROBE_AUDIENCE,
      operationsAudience: env.OPERATIONS_AUD });
  } catch {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: marker('assertion-invalid') });
  }
  // Never reflect the bearer, assertion, identity, or any request input.
  return Response.json({ ok: true, kind: 'synthetic-oauth-probe' }, { status: 200, headers: marker('ok') });
}

export default {
  fetch(request: Request, env: ProbeEnvironment): Promise<Response> {
    return handleOAuthProbe(request, env, REVIEWED_PROBE_ORIGINS);
  },
};
