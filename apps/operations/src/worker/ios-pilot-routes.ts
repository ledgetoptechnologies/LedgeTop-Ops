import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readBoundedJson } from './bounded-json';
import { admittedOperationsRequestOrigin } from './host-admission';
import { readPilotOperations } from './ios-pilot-reads';
import { authenticatePilotSession, IOS_PILOT_AUTHORIZE, IOS_PILOT_BASE, issuePilotCode, redeemPilotCode, recheckPilotSession } from './ios-pilot-session';
import type { Env } from './types';

const exchange = z.object({ code: z.string().max(128), codeVerifier: z.string().max(128), state: z.string().max(128), redirectUri: z.string().max(128) }).strict();
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

/** Deliberately isolated from /api staff middleware. Only the browser bootstrap
 * accepts Access; opaque mobile tokens are never translated to Access headers.
 * Cloudflare ingress activation is a separate deployment prerequisite. */
export async function handleIosPilot(request: Request, env: Env): Promise<Response> {
  if (env.IOS_PILOT_ENABLED !== 'true') return json({ error: 'Not found', code: 'not_found' }, 404);
  try {
    const url = new URL(request.url);
    const origin = admittedOperationsRequestOrigin(request.url, env, env.PUBLIC_BASE_URL);
    // One fixed origin per deployment; credentials never move between aliases.
    if (!origin || origin !== env.PUBLIC_BASE_URL || url.protocol !== 'https:') return json({ error: 'Not found', code: 'not_found' }, 404);
    if (url.pathname === IOS_PILOT_AUTHORIZE) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
      const callback = await issuePilotCode(request, env, origin);
      return new Response(null, { status: 302, headers: { ...headers, Location: callback } });
    }
    // Native requests cannot use browser cookies or ambient browser identity.
    if (request.headers.has('Cookie') || request.headers.has('Origin'))
      return json({ error: 'Native pilot request required', code: 'native_request_required' }, 403);
    if (url.pathname === `${IOS_PILOT_BASE}/token`) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
      if (url.search || request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json')
        return json({ error: 'Invalid exchange request', code: 'invalid_request' }, 400);
      const input = exchange.safeParse(await readBoundedJson(request, 2048, 'Pilot exchange'));
      if (!input.success) return json({ error: 'Invalid exchange request', code: 'invalid_request' }, 400);
      return json(await redeemPilotCode(env, origin, input.data));
    }
    const sessionPath = url.pathname === `${IOS_PILOT_BASE}/session`;
    const listPath = url.pathname === `${IOS_PILOT_BASE}/operations`;
    const detail = /^\/mobile-pilot\/v1\/operations\/([^/]+)$/.exec(url.pathname);
    if (!sessionPath && !listPath && !detail) return json({ error: 'Not found', code: 'not_found' }, 404);
    if (request.method !== 'GET' && !(sessionPath && request.method === 'DELETE'))
      return json({ error: 'Read-only pilot', code: 'read_only' }, 405);
    if (listPath ? [...url.searchParams.keys()].some(k => k !== 'cursor') || url.searchParams.getAll('cursor').length > 1 : !!url.search)
      return json({ error: 'Invalid query', code: 'invalid_request' }, 400);
    const session = await authenticatePilotSession(request, env, origin);
    if (sessionPath && request.method === 'DELETE') {
      await env.OPS_DB.withSession('first-primary').prepare('DELETE FROM ios_pilot_sessions WHERE token_hash=?').bind(session.tokenHash!).run();
      return new Response(null, { status: 204, headers });
    }
    if (sessionPath) {
      await recheckPilotSession(env, session);
      const { id, displayName, email } = session.principal;
      return json({ schemaVersion: 1, readOnly: true, user: { id, displayName, email }, expiresAt: session.expiresAt });
    }
    let id: string | undefined;
    try { id = detail ? decodeURIComponent(detail[1]!) : undefined; } catch { return json({ error: 'Invalid operation', code: 'invalid_request' }, 400); }
    return json(await readPilotOperations(env, session, { id, cursor: url.searchParams.get('cursor') }));
  } catch (error) {
    if (error instanceof HTTPException) {
      const code = error.status === 401 ? 'sign_in_required' : error.status === 403 ? 'access_denied' : error.status === 404 ? 'not_found' : 'request_failed';
      return json({ error: error.status >= 500 ? 'Pilot temporarily unavailable' : error.message, code }, error.status);
    }
    // Never leak token material, SQL, staff proofs or upstream exception text.
    return json({ error: 'Pilot temporarily unavailable', code: 'unavailable' }, 503);
  }
}
