import { describe, expect, it, vi } from 'vitest';
import edge, { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

const origin = 'https://pilot-staging.example.test';
const auth = { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': 'aaa.bbb.ccc' };
const envelope = (body: object, status = 200) => JSON.stringify({ version: 1, status, body });
const session = { schemaVersion: 1, readOnly: true, user: { id: 'staff', displayName: 'Staff', email: 'staff@example.test' }, expiresAt: 9999999999 };
const op = { id: 'one', title: 'Example', status: 'scheduled', scheduledStart: null, scheduledEnd: null,
  location: null, projectName: null, divisionName: null };
const binding = () => ({ read: vi.fn(async (_input: string) => envelope(session)) });
const env = (read = binding()) => ({ ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'true',
  IOS_MANAGED_PILOT_ORIGIN: origin, IOS_PILOT_READ: read });
const req = (path: string, init: RequestInit = { headers: auth }) => new Request(origin + path, init);

describe('isolated pilot edge bridge', () => {
  it('is closed by default and for unknown origins, settings, and paths', async () => {
    const e = env();
    expect((await edge.fetch(req('/mobile-pilot/v1/session'), e)).status).toBe(404);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), e, [])).status).toBe(404);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session'), { ...e, ENVIRONMENT: 'production' }, [origin])).status).toBe(404);
    expect((await handlePilotEdge(req('/api/operations'), e, [origin])).status).toBe(404);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });
  it('rejects writes, unwanted queries, browser credentials, missing bearer and malformed assertion', async () => {
    const e = env();
    for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])
      expect((await handlePilotEdge(req('/mobile-pilot/v1/operations', { method, headers: auth }), e, [origin])).status).toBe(405);
    expect((await handlePilotEdge(req('/mobile-pilot/v1/session?x=1'), e, [origin])).status).toBe(400);
    for (const h of [{ ...auth, Cookie: 'other=x' }, { ...auth, Origin: 'https://other.test' },
      { 'Cf-Access-Jwt-Assertion': 'aaa.bbb.ccc' }, { ...auth, 'Cf-Access-Jwt-Assertion': 'bad' }])
      expect((await handlePilotEdge(req('/mobile-pilot/v1/session', { headers: h }), e, [origin])).status).toBe(401);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
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
