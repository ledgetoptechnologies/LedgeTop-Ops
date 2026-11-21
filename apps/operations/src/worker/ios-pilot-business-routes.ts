import { HTTPException } from 'hono/http-exception';
import { verifyPilotAccessAssertion } from './ios-pilot-access';
import { pilotSessionFromAccessClaims } from './ios-pilot-session';
import { preparePilotStaffSnapshot } from './ios-pilot-staff-snapshot';
import { isReviewedPilotOrigin } from './ios-pilot-managed-entrypoint';
import { createPilotReadBarrier } from './ios-pilot-read-barrier';
import { readPilotBusiness, type PilotBusinessSelection } from './ios-pilot-business-reads';
import type { Env } from './types';

export type PilotBusinessEnvironment = Env & { IOS_PILOT_BUSINESS_ENABLED?: string };
export type PilotBusinessConfig = { enabled: string | undefined; origin: string; audience: string };
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (status: number, body: object) => Response.json(body, { status, headers });
const missing = () => reply(404, { error: 'Not found', code: 'not_found' });
const unavailable = () => reply(503, { error: 'Pilot temporarily unavailable', code: 'unavailable' });

/** Private GET facade, separate from the full staff router and operations
 * reader. No bearer, Cookie, caller identity or writable API is forwarded.
 * Exporting source is not provisioning or enabling the staging pilot. */
export async function handleManagedIosPilotBusiness(request: Request, env: PilotBusinessEnvironment,
  config: PilotBusinessConfig): Promise<Response> {
  if (env.ENVIRONMENT !== 'staging' || env.IOS_PILOT_BUSINESS_ENABLED !== 'true' || config.enabled !== 'true') return missing();
  try {
    const url = new URL(request.url);
    if (!isReviewedPilotOrigin(config.origin, env.PUBLIC_BASE_URL, [config.origin])
      || url.origin !== config.origin || url.username || url.password || url.hash || request.url.length > 9000) return missing();
    const roots = url.pathname === '/mobile-pilot/v1/business-roots';
    const match = /^\/mobile-pilot\/v1\/business-roots\/(organization|standalone_client)\/([^/]+)\/projects$/.exec(url.pathname);
    if (!roots && !match) return missing();
    if (request.method !== 'GET') return reply(405, { error: 'Read-only pilot', code: 'read_only' });
    if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1)
      return reply(400, { error: 'Invalid query', code: 'invalid_request' });
    let selection: PilotBusinessSelection | undefined;
    if (match) {
      let id: string;
      try { id = decodeURIComponent(match[2]!); } catch { return reply(400, { error: 'Invalid root', code: 'invalid_request' }); }
      if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return reply(400, { error: 'Invalid root', code: 'invalid_request' });
      selection = { kind: match[1] as PilotBusinessSelection['kind'], id };
    }
    if (request.headers.has('Cookie') || request.headers.has('Origin') || request.headers.has('Authorization'))
      return reply(403, { error: 'Native pilot request required', code: 'native_request_required' });
    const claims = await verifyPilotAccessAssertion(request, { teamDomain: env.TEAM_DOMAIN,
      pilotAudience: config.audience, operationsAudience: env.OPERATIONS_AUD });
    const ops = createPilotReadBarrier(env.OPS_DB), delivery = createPilotReadBarrier(env.DELIVERY_DB);
    const readEnv: Env = { ...env, OPS_DB: ops.database, DELIVERY_DB: delivery.database };
    const session = await pilotSessionFromAccessClaims(readEnv, claims);
    const body = await readPilotBusiness(readEnv, session, { cursor: url.searchParams.get('cursor'), selection });
    // Client Hub spans two D1 databases: this is not a cross-database atomic
    // snapshot. Keep its existing context/source fences and validate DELIVERY
    // first, then staff/auth/data together in one OPS read batch immediately
    // before release. Replays compare every captured query's rows, not timings.
    await delivery.verify({ session: env.DELIVERY_DB.withSession('first-primary') });
    const transaction = env.OPS_DB.withSession('first-primary');
    const staff = await preparePilotStaffSnapshot(readEnv, transaction, session);
    if (!staff) return reply(401, { error: 'Sign in required', code: 'sign_in_required' });
    await ops.verify({ session: transaction, prefixStatements: staff.statements,
      checkPrefix: results => staff.verify(results, Math.floor(Date.now() / 1000)) });
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) return reply(401, { error: 'Sign in required', code: 'sign_in_required' });
    return reply(200, body);
  } catch (error) {
    if (error instanceof HTTPException && [400, 401, 403, 404, 405].includes(error.status)) {
      const errors: Record<number, [string, string]> = { 400: ['Invalid request', 'invalid_request'],
        401: ['Sign in required', 'sign_in_required'], 403: ['Access denied', 'access_denied'],
        404: ['Not found', 'not_found'], 405: ['Read-only pilot', 'read_only'] };
      const [message, code] = errors[error.status]!;
      return reply(error.status, { error: message, code });
    }
    return unavailable();
  }
}
