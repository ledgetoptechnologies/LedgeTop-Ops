import { HTTPException } from 'hono/http-exception';
import { verifyPilotAccessAssertion } from './ios-pilot-access';
import { readPilotOperations } from './ios-pilot-reads';
import { readPilotBusinessProjects, readPilotBusinessRoots } from './ios-pilot-business-reads';
import { IOS_PILOT_BASE, pilotSessionFromAccessClaims } from './ios-pilot-session';
import { readPilotSessionView } from './ios-pilot-staff-snapshot';
import type { Env } from './types';

/** Private read-service handler. The public edge must first require its direct
 * Access context. This handler independently validates the signed assertion
 * and staff permissions and must not be exposed as a public HTTP entrypoint. */
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
    const rootsPath = url.pathname === `${IOS_PILOT_BASE}/business-roots`;
    const projectsPath = /^\/mobile-pilot\/v1\/business-roots\/(organization|standalone_client)\/([^/]+)\/projects$/.exec(url.pathname);
    if (!sessionPath && !listPath && !detail && !rootsPath && !projectsPath) return missing();
    if ((rootsPath || projectsPath) && (env as Env & { IOS_PILOT_BUSINESS_ENABLED?: string }).IOS_PILOT_BUSINESS_ENABLED !== 'true') return missing();
    if (request.method !== 'GET') return json({ error: 'Read-only pilot', code: 'read_only' }, 405);
    if (listPath || rootsPath || projectsPath ? [...url.searchParams.keys()].some(k => k !== 'cursor') || url.searchParams.getAll('cursor').length > 1 : !!url.search)
      return json({ error: 'Invalid query', code: 'invalid_request' }, 400);
    // These headers are defense in depth, not proof of an OAuth-only request.
    if (request.headers.has('Cookie') || request.headers.has('Origin'))
      return json({ error: 'Native pilot request required', code: 'native_request_required' }, 403);
    const claims = await verifyPilotAccessAssertion(request, { teamDomain: env.TEAM_DOMAIN,
      pilotAudience: config.audience, operationsAudience: env.OPERATIONS_AUD });
    const session = await pilotSessionFromAccessClaims(env, claims);
    if (sessionPath) {
      return json(await readPilotSessionView(env, session));
    }
    if (rootsPath) return json(await readPilotBusinessRoots(env, session, url.searchParams.get('cursor') ?? undefined));
    if (projectsPath) {
      let clientHubRootId: string;
      try { clientHubRootId = decodeURIComponent(projectsPath[2]!); }
      catch { return json({ error: 'Invalid request', code: 'invalid_request' }, 400); }
      const kind = projectsPath[1] as 'organization' | 'standalone_client';
      return json(await readPilotBusinessProjects(env, session, { sourceId: 'project-alpha:staging', kind, clientHubRootId },
        url.searchParams.get('cursor') ?? undefined));
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
