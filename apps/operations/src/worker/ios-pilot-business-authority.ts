import { HTTPException } from 'hono/http-exception';
import { parseDuplicateFreeJson } from './bounded-json';
import { verifyPilotAccessAssertion } from './ios-pilot-access';
import { readPilotBusinessProjects, readPilotBusinessRoots } from './ios-pilot-business-reads';
import { pilotSessionFromAccessClaims } from './ios-pilot-session';
import type { Env } from './types';

type AuthorityEnv = Env & { IOS_PILOT_BUSINESS_AUTHORITY_ENABLED?: string };
const ORIGIN = 'https://ios-pilot-staging.ledgetop.app';
const TEAM = 'https://ledgetoptechnologies.cloudflareaccess.com';
const PILOT_AUDIENCE = 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d';
const OPERATIONS_AUDIENCE = '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b';
const MAX_INPUT = 24_576, MAX_OUTPUT = 1_048_576;
const wire = (status: number, body: object) => JSON.stringify({ version: 1, status, body });
const missing = () => wire(404, { error: 'Not found', code: 'not_found' });
const unavailable = () => wire(503, { error: 'Pilot temporarily unavailable', code: 'unavailable' });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const optionalText = (value: unknown, max: number) => value === null || text(value, max);
const cursorIsSafe = (value: unknown) => value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(value));
function safeBody(value: unknown, roots: boolean): boolean {
  if (!record(value) || value.schemaVersion !== 1 || !cursorIsSafe(value.nextCursor)) return false;
  if (roots) return keys(value, ['schemaVersion', 'roots', 'nextCursor']) && Array.isArray(value.roots)
    && value.roots.length <= 20 && value.roots.every(root => record(root)
      && keys(root, ['sourceId', 'rootNamespace', 'kind', 'clientHubRootId', 'name'])
      && root.sourceId === 'project-alpha:staging' && root.rootNamespace === 'business'
      && (root.kind === 'organization' || root.kind === 'standalone_client')
      && text(root.clientHubRootId, 512) && text(root.name, 512));
  return keys(value, ['schemaVersion', 'projects', 'nextCursor']) && Array.isArray(value.projects)
    && value.projects.length <= 20 && value.projects.every(project => record(project)
      && keys(project, ['id', 'origin', 'name', 'status', 'startDate', 'endDate'])
      && text(project.id, 512) && (project.origin === 'pa' || project.origin === 'canonical')
      && text(project.name, 512) && optionalText(project.status, 128)
      && optionalText(project.startDate, 64) && optionalText(project.endDate, 64));
}

/** Private business-only service method. A service binding is not user
 * authentication: independently verify the signed pilot assertion and the
 * current human staff, root, source and project authority on every call. */
export async function readPilotBusinessAuthority(input: unknown, env: AuthorityEnv): Promise<string> {
  if (env.ENVIRONMENT !== 'staging' || env.IOS_PILOT_BUSINESS_AUTHORITY_ENABLED !== 'true'
    || env.PUBLIC_BASE_URL !== 'https://ops-staging.ledgetopdroneservices.com'
    || env.TEAM_DOMAIN !== TEAM || env.OPERATIONS_AUD !== OPERATIONS_AUDIENCE) return missing();
  if (typeof input !== 'string' || input.length > MAX_INPUT || new TextEncoder().encode(input).byteLength > MAX_INPUT) return missing();
  try {
    const value = parseDuplicateFreeJson(input);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return missing();
    const message = value as Record<string, unknown>;
    if (Object.keys(message).sort().join(',') !== 'assertion,url' || typeof message.url !== 'string'
      || message.url.length > 9000 || typeof message.assertion !== 'string' || message.assertion.length > 16_384
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(message.assertion)) return missing();
    const url = new URL(message.url);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) return missing();
    const roots = url.pathname === '/mobile-pilot/v1/business-roots';
    const projects = /^\/mobile-pilot\/v1\/business-roots\/(organization|standalone_client)\/([^/]+)\/projects$/.exec(url.pathname);
    if (!roots && !projects) return missing();
    if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) return missing();
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) return missing();
    let clientHubRootId: string | undefined;
    if (projects) {
      try { clientHubRootId = decodeURIComponent(projects[2]!); } catch { return missing(); }
      if (!clientHubRootId || clientHubRootId.length > 512 || /[\u0000-\u001f\u007f]/.test(clientHubRootId)) return missing();
    }
    const request = new Request(url, { method: 'GET', headers: { 'Cf-Access-Jwt-Assertion': message.assertion } });
    const claims = await verifyPilotAccessAssertion(request, { teamDomain: TEAM,
      pilotAudience: PILOT_AUDIENCE, operationsAudience: OPERATIONS_AUDIENCE });
    const session = await pilotSessionFromAccessClaims(env, claims);
    const body = roots ? await readPilotBusinessRoots(env, session, cursor ?? undefined)
      : await readPilotBusinessProjects(env, session, { sourceId: 'project-alpha:staging',
        kind: projects![1] as 'organization' | 'standalone_client', clientHubRootId: clientHubRootId! }, cursor ?? undefined);
    if (!safeBody(body, roots)) return unavailable();
    const result = wire(200, body);
    return new TextEncoder().encode(result).byteLength <= MAX_OUTPUT ? result : unavailable();
  } catch (error) {
    if (error instanceof HTTPException && [400, 401, 403, 404].includes(error.status)) {
      const code = error.status === 401 ? 'sign_in_required' : error.status === 403 ? 'access_denied'
        : error.status === 400 ? 'invalid_request' : 'not_found';
      return wire(error.status, { error: error.status === 401 ? 'Sign in required' : error.status === 403 ? 'Access denied'
        : error.status === 400 ? 'Invalid request' : 'Not found', code });
    }
    return unavailable();
  }
}
