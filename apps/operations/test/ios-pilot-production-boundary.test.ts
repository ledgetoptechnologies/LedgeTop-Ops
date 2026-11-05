import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/worker/ios-pilot-access', () => ({
  verifyPilotAccessAssertion: async () => ({ subject: 'staff-subject', email: 'staff@example.test' }),
}));
import productionEdge from '../src/worker/ios-pilot-production-edge';
import stagingEdge, { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';
import { handleProductionPilotRead } from '../src/worker/ios-pilot-production-read';
import { PRODUCTION_PILOT_ORIGIN as origin } from '../src/worker/ios-pilot-production-policy';

const assertion = 'aaa.bbb.ccc';
const session = { schemaVersion: 1, readOnly: true,
  user: { id: 'staff', displayName: 'Staff', email: 'staff@example.test' }, expiresAt: 9999999999 };
const access = { aud: 'new-production-pilot-audience',
  getIdentity: async () => ({ user_uuid: 'staff-subject', email: 'staff@example.test' }) };
const env = () => ({ ENVIRONMENT: 'production', IOS_PRODUCTION_READ_PILOT_ENABLED: 'true',
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
  IOS_MANAGED_PILOT_AUDIENCE: access.aud, TEAM_DOMAIN: 'https://synthetic.cloudflareaccess.com',
  PUBLIC_BASE_URL: 'https://ops.ledgetop.app', OPERATIONS_AUD: 'web-audience',
  PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: 'true', PROJECT_ALPHA_CONNECTOR_SOURCES: '{"version":1,"sources":[]}',
  IOS_OAUTH_PROBE_ENABLED: 'true', IOS_OAUTH_PROBE_AUDIENCE: access.aud,
  IOS_PILOT_READ: { read: vi.fn(async (_input: string) => JSON.stringify({ version: 1, status: 200, body: session })) } });
const req = (path = '/mobile-pilot/v1/session', method = 'GET', extra: Record<string, string> = {}) =>
  new Request(origin + path, { method, headers: { 'Cf-Access-Jwt-Assertion': assertion, ...extra } });
type ReadEnv = Parameters<typeof handleProductionPilotRead>[1];
// Tests inject the authoritative handler, so unused general Operations
// bindings are intentionally absent. Fail if code starts accessing one.
const readEnv = (value: Partial<ReadEnv>): ReadEnv => new Proxy(value, {
  get(target, name) {
    if (!(name in target)) throw Error('Unexpected test binding: ' + String(name));
    return Reflect.get(target, name);
  },
}) as ReadEnv;
const input = (url = origin + '/mobile-pilot/v1/session') => JSON.stringify({ url, assertion });
const status = (s: string) => (JSON.parse(s) as { status: number }).status;

describe('separately activated production pilot boundaries', () => {
  it('does not turn either existing staging entrypoint into a production path', async () => {
    const e = env(), handler = vi.fn(async () => Response.json(session));
    expect((await stagingEdge.fetch(req(), e, { access })).status).toBe(404);
    expect((await handlePilotEdge(req(), e, [origin], access)).status).toBe(404);
    expect(status(await readPilotRpc(input(), readEnv(e), [origin], handler))).toBe(404);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('requires a separate activation, production environment, candidate host and non-staging audience', async () => {
    for (const change of [
      { IOS_PRODUCTION_READ_PILOT_ENABLED: undefined }, { IOS_PRODUCTION_READ_PILOT_ENABLED: 'false' },
      { IOS_MANAGED_PILOT_ENABLED: 'false' }, { ENVIRONMENT: 'staging' },
      { IOS_MANAGED_PILOT_ORIGIN: 'https://ios-pilot-staging.ledgetop.app' },
      { IOS_MANAGED_PILOT_ORIGIN: 'https://ops.ledgetop.app' },
      { IOS_MANAGED_PILOT_AUDIENCE: '' }, { IOS_MANAGED_PILOT_AUDIENCE: 'web-audience' },
      { IOS_MANAGED_PILOT_AUDIENCE: 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d' },
    ]) {
      const e = { ...env(), ...change }, handler = vi.fn(async () => Response.json(session));
      expect((await productionEdge.fetch(req(), e, { access })).status).toBe(404);
      expect(status(await handleProductionPilotRead(input(), readEnv(e), handler))).toBe(404);
      expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('never exposes the synthetic probe or general API on production, even with probe flags true', async () => {
    const e = env();
    for (const path of ['/oauth-probe/v1', '/api/operations', '/', '/assets/index.js'])
      expect((await productionEdge.fetch(req(path), e, { access })).status).toBe(404);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });

  it('rejects all mutation and non-GET methods before invoking the private reader', async () => {
    const e = env();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
      expect((await productionEdge.fetch(req('/mobile-pilot/v1/operations', method), e, { access })).status).toBe(405);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });

  it('requires verified direct Access context and matching identity', async () => {
    const e = env();
    expect((await productionEdge.fetch(req(), e)).status).toBe(401);
    expect((await productionEdge.fetch(req(), e, { access: { ...access, aud: 'staging-audience' } })).status).toBe(401);
    expect((await productionEdge.fetch(req(), e, { access: { ...access,
      getIdentity: async () => ({ user_uuid: 'other', email: 'staff@example.test' }) } })).status).toBe(401);
    expect((await productionEdge.fetch(req(), e, { access: { ...access,
      getIdentity: async () => ({ user_uuid: 'staff-subject', email: 'other@example.test' }) } })).status).toBe(401);
    expect(e.IOS_PILOT_READ.read).not.toHaveBeenCalled();
  });

  it('uses the shared bounded facade, forwarding only URL and assertion after identity checks', async () => {
    const e = env();
    const response = await productionEdge.fetch(req(), e, { access });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(session);
    expect(e.IOS_PILOT_READ.read).toHaveBeenCalledExactlyOnceWith(input());
    const browserHeaders: Record<string, string>[] = [{ Cookie: 'browser=x' }, { Origin: origin }, { 'Cf-Access-Jwt-Assertion': 'forged' }];
    for (const extra of browserHeaders)
      expect((await productionEdge.fetch(req('/mobile-pilot/v1/session', 'GET', extra), e, { access })).status).toBe(401);
    expect((await productionEdge.fetch(req('/mobile-pilot/v1/session?unexpected=true'), e, { access })).status).toBe(400);
    expect(e.IOS_PILOT_READ.read).toHaveBeenCalledOnce();
  });

  it('requires a source manifest instead of falling back to legacy scalar source configuration', async () => {
    for (const change of [{ PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: undefined },
      { PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: 'false' }, { PROJECT_ALPHA_CONNECTOR_SOURCES: undefined },
      { PROJECT_ALPHA_CONNECTOR_SOURCES: ' ' }]) {
      const handler = vi.fn(async () => Response.json(session));
      expect(status(await handleProductionPilotRead(input(), readEnv({ ...env(), ...change }), handler))).toBe(404);
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('keeps the authoritative handler and propagates its current staff/source/record denial', async () => {
    const e = env();
    const handler = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('Cf-Access-Jwt-Assertion')).toBe(assertion);
      expect(request.headers.get('Authorization')).toBeNull();
      return Response.json({ error: 'Access denied', code: 'access_denied' }, { status: 403 });
    });
    expect(status(await handleProductionPilotRead(input(), readEnv(e), handler))).toBe(403);
    expect(handler).toHaveBeenCalledOnce();
    for (const value of [input('https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/session'),
      JSON.stringify({ url: origin + '/mobile-pilot/v1/session', assertion, principal: 'owner' })])
      expect(status(await handleProductionPilotRead(value, readEnv(e), handler))).toBe(404);
    expect(handler).toHaveBeenCalledOnce();
  });
});
