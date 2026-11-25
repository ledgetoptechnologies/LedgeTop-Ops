import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/worker/ios-pilot-access', () => ({
  verifyPilotAccessAssertion: async () => ({ subject: 'staff-subject', email: 'staff@example.test' }),
}));
import edge, { handlePilotEdge as actualHandlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

const origin = 'https://pilot-staging.example.test';
const auth = { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': 'aaa.bbb.ccc' };
const envelope = (body: object, status = 200) => JSON.stringify({ version: 1, status, body });
const session = { schemaVersion: 1, readOnly: true, user: { id: 'staff', displayName: 'Staff', email: 'staff@example.test' }, expiresAt: 9999999999 };
const op = { id: 'one', title: 'Example', status: 'scheduled', scheduledStart: null, scheduledEnd: null,
  location: null, projectName: null, divisionName: null };
const binding = () => ({ read: vi.fn(async (_input: string) => envelope(session)) });
const env = (read = binding(), businessRead = binding()) => ({ ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'true',
  IOS_MANAGED_PILOT_ORIGIN: origin, IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience',
  IOS_OAUTH_PROBE_ENABLED: 'true', IOS_OAUTH_PROBE_AUDIENCE: 'pilot-audience',
  TEAM_DOMAIN: 'https://synthetic.cloudflareaccess.com', OPERATIONS_AUD: 'web-audience', IOS_PILOT_READ: read,
  IOS_PILOT_BUSINESS_READ: businessRead });
const req = (path: string, init: RequestInit = { headers: auth }) => new Request(origin + path, init);
const access = { aud: 'pilot-audience', getIdentity: async () => ({ user_uuid: 'staff-subject', email: 'staff@example.test' }) };
const handlePilotEdge = (request: Request, environment: Parameters<typeof actualHandlePilotEdge>[1], reviewed: readonly string[]) =>
  actualHandlePilotEdge(request, environment, reviewed, access);

describe('isolated pilot edge bridge', () => {
  it('keeps business reads independently gated and accepts only bounded allowlisted responses', async () => {
    const service = binding(), businessService = binding(), e = env(service, businessService);
    const rootsPath = '/mobile-pilot/v1/business-roots';
    const projectsPath = '/mobile-pilot/v1/business-roots/organization/root-1/projects';
    expect((await handlePilotEdge(req(rootsPath), e, [origin])).status).toBe(404);
    expect(service.read).not.toHaveBeenCalled();
    const enabled = { ...e, IOS_PILOT_BUSINESS_ENABLED: 'true' };
    expect((await handlePilotEdge(req(rootsPath, { method: 'POST', headers: auth }), enabled, [origin])).status).toBe(405);
    expect((await handlePilotEdge(req(rootsPath + '?cursor=a&cursor=b'), enabled, [origin])).status).toBe(400);
    const root = { sourceId: 'project-alpha:staging', rootNamespace: 'business', kind: 'organization', clientHubRootId: 'root-1', name: 'Example' };
    businessService.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, roots: [root], nextCursor: null }));
    expect((await handlePilotEdge(req(rootsPath), enabled, [origin])).status).toBe(200);
    expect(businessService.read).toHaveBeenCalledOnce();
    expect(service.read).not.toHaveBeenCalled();
    businessService.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, roots: [{ ...root, email: 'private' }], nextCursor: null }));
    const extra = await handlePilotEdge(req(rootsPath), enabled, [origin]);
    expect(extra.status).toBe(503);
    expect(await extra.text()).not.toContain('private');
    businessService.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, roots: [{ ...root, sourceId: 'project-alpha:primary' }], nextCursor: null }));
    expect((await handlePilotEdge(req(rootsPath), enabled, [origin])).status).toBe(503);
    const project = { id: 'one', origin: 'pa', name: 'Example project', status: null, startDate: null, endDate: null };
    businessService.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, projects: [project], nextCursor: null }));
    expect((await handlePilotEdge(req(projectsPath), enabled, [origin])).status).toBe(200);
    businessService.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, projects: [{ ...project, manager: 'private' }], nextCursor: null }));
    expect((await handlePilotEdge(req(projectsPath), enabled, [origin])).status).toBe(503);
  });
  it('is closed by default and for unknown origins, settings, and paths', async () => {
    const e = env();
    expect((await edge.fetch(req('/mobile-pilot/v1/session'), e)).status).toBe(404);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), e, [])).status).toBe(404);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), { ...e, ENVIRONMENT: 'production' }, [origin])).status).toBe(404);
    expect((await handlePilotEdge(req('/api/operations'), e, [origin])).status).toBe(404);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });
  it('routes business calls only to the named binding and keeps missing bindings closed', async () => {
    const read = binding(), businessRead = binding();
    const e = env(read, businessRead), enabled = { ...e, IOS_PILOT_BUSINESS_ENABLED: 'true' };
    const root = { sourceId: 'project-alpha:staging', rootNamespace: 'business', kind: 'organization', clientHubRootId: 'root-1', name: 'Example' };
    businessRead.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, roots: [root], nextCursor: null }));
    expect((await handlePilotEdge(req('/mobile-pilot/v1/business-roots'), enabled, [origin])).status).toBe(200);
    expect(businessRead.read).toHaveBeenCalledOnce();
    expect(read.read).not.toHaveBeenCalled();

    read.read.mockResolvedValueOnce(envelope(session));
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), enabled, [origin])).status).toBe(200);
    expect(read.read).toHaveBeenCalledOnce();
    expect(businessRead.read).toHaveBeenCalledOnce();

    expect((await handlePilotEdge(req('/mobile-pilot/v1/business-roots'),
      { ...enabled, IOS_PILOT_BUSINESS_READ: undefined }, [origin])).status).toBe(503);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'),
      { ...enabled, IOS_PILOT_READ: undefined }, [origin])).status).toBe(503);
    expect(read.read).toHaveBeenCalledOnce();
    expect(businessRead.read).toHaveBeenCalledOnce();
  });
  it('rejects writes, unwanted queries, browser headers and malformed assertion', async () => {
    const e = env();
    for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])
      expect((await handlePilotEdge(req('/mobile-pilot/v1/operations', { method, headers: auth }), e, [origin])).status).toBe(405);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session?x=1'), e, [origin])).status).toBe(400);
    for (const h of [{ ...auth, Cookie: 'other=x' }, { ...auth, Origin: 'https://other.test' },
      { ...auth, 'Cf-Access-Jwt-Assertion': 'bad' }])
      expect((await handlePilotEdge(req('/mobile-pilot/v1/session', { headers: h }), e, [origin])).status).toBe(401);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });
  it('requires matching runtime Access context even if a client supplies an assertion', async () => {
    const e = env();
    const request = req('/mobile-pilot/v1/session');
    expect((await actualHandlePilotEdge(request, e, [origin])).status).toBe(401);
    expect((await actualHandlePilotEdge(request, e, [origin], { aud: 'wrong-audience' })).status).toBe(401);
    expect((await actualHandlePilotEdge(request, { ...e, IOS_MANAGED_PILOT_AUDIENCE: '' }, [origin], { aud: '' })).status).toBe(401);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });
  it('keeps the diagnostic sign-in probe on the same protected hostname without reading business data', async () => {
    const e = env();
    const request = req('/oauth-probe/v1');
    expect((await actualHandlePilotEdge(request, e, [origin])).status).toBe(401);
    const verified = await actualHandlePilotEdge(request, e, [origin], access);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ ok: true, kind: 'synthetic-oauth-probe' });
    expect(verified.headers.get('X-LT-Ops-Access-Context')).toBe('match');
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
    const liveDisabled = { ...e, IOS_MANAGED_PILOT_ENABLED: 'false' };
    expect((await actualHandlePilotEdge(request, liveDisabled, [origin], access)).status).toBe(200);
    expect((await actualHandlePilotEdge(req('/mobile-pilot/v1/session'), liveDisabled, [origin], access)).status).toBe(404);
    const reviewedOrigin = 'https://ios-pilot-staging.ledgetop.app';
    const reviewedRequest = new Request(reviewedOrigin + '/oauth-probe/v1', { headers: auth });
    expect((await edge.fetch(reviewedRequest, { ...e, IOS_MANAGED_PILOT_ORIGIN: reviewedOrigin }, { access })).status).toBe(200);
  });
  it('rejects missing or mismatched runtime identity without consulting the private service', async () => {
    const e = env(), request = req('/mobile-pilot/v1/session');
    for (const identity of [null, {}, { user_uuid: 'someone-else', email: 'staff@example.test' },
      { user_uuid: 'staff-subject', email: 'someone-else@example.test' }]) {
      expect((await actualHandlePilotEdge(request, e, [origin], { aud: 'pilot-audience', getIdentity: async () => identity })).status).toBe(401);
    }
    expect((await actualHandlePilotEdge(request, e, [origin], { aud: 'pilot-audience', getIdentity: async () => { throw Error('private'); } })).status).toBe(401);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });
  it('forwards a signed assertion without requiring the original bearer header', async () => {
    const e = env();
    const response = await handlePilotEdge(req('/mobile-pilot/v1/session', {
      headers: { 'Cf-Access-Jwt-Assertion': auth['Cf-Access-Jwt-Assertion'] },
    }), e, [origin]);
    expect(response.status).toBe(200);
    expect(e.IOS_PILOT_READ.read).toHaveBeenCalledOnce();
  });
  it('forwards only the URL and assertion, never the bearer, and validates each success shape', async () => {
    const service = binding(), e = env(service);
    const response = await handlePilotEdge(req('/mobile-pilot/v1/session'), e, [origin]);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(session);
    const call = service.read.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('Expected one private service call');
    const message = call[0];
    expect(JSON.parse(message)).toEqual({ url: origin + '/mobile-pilot/v1/session', assertion: auth['Cf-Access-Jwt-Assertion'] });
    expect(message).not.toContain('oauth:synthetic');
    service.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, operations: [op], nextCursor: null }));
    expect((await handlePilotEdge(req('/mobile-pilot/v1/operations'), e, [origin])).status).toBe(200);
    service.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, operation: op }));
    expect((await handlePilotEdge(req('/mobile-pilot/v1/operations/one'), e, [origin])).status).toBe(200);
    service.read.mockResolvedValueOnce(envelope({ schemaVersion: 1, operation: { ...op, id: 'different' } }));
    expect((await handlePilotEdge(req('/mobile-pilot/v1/operations/one'), e, [origin])).status).toBe(503);
  });
  it('fails closed for missing, failed, oversized, malformed or mismatched binding responses', async () => {
    const e = env();
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), { ...e, IOS_PILOT_READ: undefined }, [origin])).status).toBe(503);
    for (const result of ['x'.repeat(1_048_577), '{', envelope({ ...session, extra: 'secret' }),
      envelope({ schemaVersion: 1, operation: op }), JSON.stringify({ version: 2, status: 200, body: session })]) {
      const service = { read: vi.fn(async () => result) };
      const response = await handlePilotEdge(req('/mobile-pilot/v1/session'), env(service), [origin]);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret');
    }
    const failure = { read: vi.fn(async () => { throw Error('sensitive internal failure'); }) };
    const response = await handlePilotEdge(req('/mobile-pilot/v1/session'), env(failure), [origin]);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sensitive');
  });
  it('maps remote errors without reflecting internal data', async () => {
    const service = { read: vi.fn(async () => envelope({ error: 'secret' }, 403)) };
    const response = await handlePilotEdge(req('/mobile-pilot/v1/session'), env(service), [origin]);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('secret');
  });
});
