import { HTTPException } from 'hono/http-exception';
import { verifyPilotAccessAssertion } from './ios-pilot-access';
import { readPilotOperations } from './ios-pilot-reads';
import { IOS_PILOT_BASE, pilotSessionFromAccessClaims, recheckPilotSession } from './ios-pilot-session';
import type { Env } from './types';

/** This handler has a separate staging entrypoint but is not deployed. Before
 * deployment, route only its dedicated hostname to it and keep the flag disabled until
 * Access, OAuth redirects and cross-host token isolation have been validated. */
export type ManagedPilotConfig = {
  enabled: string | undefined;
  origin: string;
  audience: string;
};
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const missing = () => json({ error: 'Not found', code: 'not_found' }, 404);

export async function handleManagedIosPilot(request: Request, env: Env, config: ManagedPilotConfig): Promise<Response> {
  if (config.enabled !== 'true') return missing();
  try {
    const url = new URL(request.url), pilotOrigin = new URL(config.origin), webOrigin = new URL(env.PUBLIC_BASE_URL);
    // Exact origin, no paths/userinfo/query and a distinct hostname. Never
    // serve this facade on the shared web application's origin or an alias.
    if (pilotOrigin.protocol !== 'https:' || pilotOrigin.origin !== config.origin || pilotOrigin.username || pilotOrigin.password
      || pilotOrigin.hostname === webOrigin.hostname || url.origin !== pilotOrigin.origin) return missing();
    const sessionPath = url.pathname === `${IOS_PILOT_BASE}/session`;
    const listPath = url.pathname === `${IOS_PILOT_BASE}/operations`;
    const detail = /^\/mobile-pilot\/v1\/operations\/([^/]+)$/.exec(url.pathname);
    if (!sessionPath && !listPath && !detail) return missing();
    if (request.method !== 'GET') return json({ error: 'Read-only pilot', code: 'read_only' }, 405);
    if (listPath ? [...url.searchParams.keys()].some(k => k !== 'cursor') || url.searchParams.getAll('cursor').length > 1 : !!url.search)
      return json({ error: 'Invalid query', code: 'invalid_request' }, 400);
    // Do not accept ambient browser sessions. Access must verify a presented
    // bearer and inject a signed assertion for the pilot application.
    if (request.headers.has('Cookie') || request.headers.has('Origin'))
      return json({ error: 'Native pilot request required', code: 'native_request_required' }, 403);
    if (!/^Bearer [A-Za-z0-9:._~+\/-]+=*$/.test(request.headers.get('Authorization') ?? '')
      || (request.headers.get('Authorization')?.length ?? 0) > 4096)
      return json({ error: 'Sign in to the read-only pilot', code: 'sign_in_required' }, 401);
    const claims = await verifyPilotAccessAssertion(request, { teamDomain: env.TEAM_DOMAIN,
      pilotAudience: config.audience, operationsAudience: env.OPERATIONS_AUD });
    const session = await pilotSessionFromAccessClaims(env, claims);
    if (sessionPath) {
      await recheckPilotSession(env, session);
      const { id, displayName, email } = session.principal;
      return json({ schemaVersion: 1, readOnly: true, user: { id, displayName, email }, expiresAt: session.expiresAt });
    }
    let id: string | undefined;
    try { id = detail ? decodeURIComponent(detail[1]!) : undefined; }
    catch { return json({ error: 'Invalid operation', code: 'invalid_request' }, 400); }
    return json(await readPilotOperations(env, session, { id, cursor: url.searchParams.get('cursor') }));
  } catch (error) {
    if (error instanceof HTTPException) {
      const code = error.status === 401 ? 'sign_in_required' : error.status === 403 ? 'access_denied' : error.status === 404 ? 'not_found' : 'request_failed';
      return json({ error: error.status >= 500 ? 'Pilot temporarily unavailable' : error.message, code }, error.status);
    }
    return json({ error: 'Pilot temporarily unavailable', code: 'unavailable' }, 503);
  }
}
