/** A staging-only ingress for the private pilot read service. It carries no D1,
 * connector credentials, or business implementation. This module is not
 * configured or deployed; its source-reviewed hostname list is empty. Access
 * must validate the bearer and inject the assertion at the edge. */
const REVIEWED_ORIGINS: readonly string[] = [];
const RESERVED_ORIGINS = new Set(['https://ops.ledgetop.app', 'https://ops.ledgetopdroneservices.com',
  'https://ops.ledgetoptechnologies.com', 'https://ops-staging.ledgetopdroneservices.com']);
const MAX_REPLY = 1_048_576;
const headers = { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
type ReadBinding = { read(input: string): Promise<string> };
type EdgeEnvironment = { ENVIRONMENT?: string; IOS_MANAGED_PILOT_ENABLED?: string;
  IOS_MANAGED_PILOT_ORIGIN?: string; IOS_PILOT_READ?: ReadBinding };
const reply = (status: number, body: object) => Response.json(body, { status, headers });
const denied = () => reply(404, { error: 'Not found', code: 'not_found' });
const unavailable = () => reply(503, { error: 'Pilot temporarily unavailable', code: 'unavailable' });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',');
const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const optional = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 8192);
function operation(v: unknown): boolean {
  return record(v) && keysAre(v, ['id','title','status','scheduledStart','scheduledEnd','location','projectName','divisionName'])
    && str(v.id) && typeof v.title === 'string' && v.title.length <= 8192 && str(v.status)
    && optional(v.scheduledStart) && optional(v.scheduledEnd) && optional(v.location)
    && optional(v.projectName) && optional(v.divisionName);
}
function validSuccess(body: unknown, kind: 'session' | 'list' | 'detail', detailId?: string): boolean {
  if (!record(body) || body.schemaVersion !== 1) return false;
  if (kind === 'session') return keysAre(body, ['schemaVersion','readOnly','user','expiresAt']) && body.readOnly === true
    && Number.isSafeInteger(body.expiresAt) && record(body.user) && keysAre(body.user, ['id','displayName','email'])
    && str(body.user.id) && str(body.user.displayName) && str(body.user.email);
  if (kind === 'detail') return keysAre(body, ['schemaVersion','operation']) && operation(body.operation)
    && record(body.operation) && body.operation.id === detailId;
  return keysAre(body, ['schemaVersion','operations','nextCursor']) && Array.isArray(body.operations)
    && body.operations.length <= 50 && body.operations.every(operation) && optional(body.nextCursor);
}

/** The injectable list is only for local tests. The exported Worker uses the
 * empty source-controlled list, never an allowlist supplied through env. */
export async function handlePilotEdge(request: Request, env: EdgeEnvironment, reviewed: readonly string[]): Promise<Response> {
  const origin = env.IOS_MANAGED_PILOT_ORIGIN;
  if (env.ENVIRONMENT !== 'staging' || env.IOS_MANAGED_PILOT_ENABLED !== 'true' || !origin
    || RESERVED_ORIGINS.has(origin) || !reviewed.includes(origin)) return denied();
  let url: URL;
  try {
    url = new URL(request.url);
    const configured = new URL(origin);
    if (configured.protocol !== 'https:' || configured.origin !== origin || configured.username || configured.password
      || configured.port || configured.pathname !== '/' || configured.search || configured.hash || url.origin !== origin
      || url.username || url.password || url.hash || request.url.length > 9000) return denied();
  } catch { return denied(); }
  let kind: 'session' | 'list' | 'detail';
  if (url.pathname === '/mobile-pilot/v1/session') kind = 'session';
  else if (url.pathname === '/mobile-pilot/v1/operations') kind = 'list';
  else if (/^\/mobile-pilot\/v1\/operations\/[^/]+$/.test(url.pathname)) kind = 'detail';
  else return denied();
  if (request.method !== 'GET') return reply(405, { error: 'Read-only pilot', code: 'read_only' });
  let detailId: string | undefined;
  if (kind === 'detail') {
    try { detailId = decodeURIComponent(url.pathname.slice('/mobile-pilot/v1/operations/'.length)); }
    catch { return reply(400, { error: 'Invalid request', code: 'invalid_request' }); }
    if (!detailId || detailId.length > 512) return reply(400, { error: 'Invalid request', code: 'invalid_request' });
  }
  if (kind === 'list' ? [...url.searchParams.keys()].some(k => k !== 'cursor') || url.searchParams.getAll('cursor').length > 1
    : !!url.search) return reply(400, { error: 'Invalid query', code: 'invalid_request' });
  const bearer = request.headers.get('Authorization') ?? '';
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
  if (request.headers.has('Cookie') || request.headers.has('Origin') || bearer.length > 4096
    || !/^Bearer oauth:[A-Za-z0-9._~+\/-]+=*$/.test(bearer)
    || assertion.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion))
    return reply(401, { error: 'Authentication required', code: 'sign_in_required' });
  if (!env.IOS_PILOT_READ || typeof env.IOS_PILOT_READ.read !== 'function') return unavailable();
  try {
    // Do not forward the opaque bearer; the private service independently
    // verifies the signed assertion and staff/source/record permissions.
    const result: unknown = await env.IOS_PILOT_READ.read(JSON.stringify({ url: url.toString(), assertion }));
    if (typeof result !== 'string' || result.length > MAX_REPLY || new TextEncoder().encode(result).byteLength > MAX_REPLY) return unavailable();
    const envelope: unknown = JSON.parse(result);
    if (!record(envelope) || !keysAre(envelope, ['version','status','body']) || envelope.version !== 1
      || !Number.isInteger(envelope.status)) return unavailable();
    const status = envelope.status as number;
    if (status === 200) return validSuccess(envelope.body, kind, detailId) ? reply(200, envelope.body as object) : unavailable();
    // Never expose error text received from a misconfigured binding.
    const errors: Record<number, [string,string]> = { 400: ['Invalid request','invalid_request'],
      401: ['Sign in required','sign_in_required'], 403: ['Access denied','access_denied'],
      404: ['Not found','not_found'], 405: ['Read-only pilot','read_only'], 503: ['Pilot temporarily unavailable','unavailable'] };
    const error = errors[status];
    return error ? reply(status, { error: error[0], code: error[1] }) : unavailable();
  } catch { return unavailable(); }
}

export default { fetch(request: Request, env: EdgeEnvironment): Promise<Response> {
  return handlePilotEdge(request, env, REVIEWED_ORIGINS);
} };
