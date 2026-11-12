import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ verify: vi.fn(), session: vi.fn(), roots: vi.fn(), projects: vi.fn() }));
vi.mock('../src/worker/ios-pilot-access', () => ({ verifyPilotAccessAssertion: f.verify }));
vi.mock('../src/worker/ios-pilot-session', () => ({ pilotSessionFromAccessClaims: f.session }));
vi.mock('../src/worker/ios-pilot-business-reads', () => ({ readPilotBusinessRoots: f.roots, readPilotBusinessProjects: f.projects }));
import { readPilotBusinessAuthority } from '../src/worker/ios-pilot-business-authority';

const origin = 'https://ios-pilot-staging.ledgetop.app';
const env = { ENVIRONMENT: 'staging', IOS_PILOT_BUSINESS_AUTHORITY_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://ops-staging.ledgetopdroneservices.com',
  TEAM_DOMAIN: 'https://ledgetoptechnologies.cloudflareaccess.com',
  OPERATIONS_AUD: '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b' } as unknown as Env;
const input = (path = '/mobile-pilot/v1/business-roots') => JSON.stringify({ url: origin + path, assertion: 'a.b.c' });
const result = async (message: unknown, settings = env) => JSON.parse(await readPilotBusinessAuthority(message, settings)) as { status: number; body: unknown };

beforeEach(() => {
  vi.resetAllMocks();
  f.verify.mockResolvedValue({ subject: 'synthetic' });
  f.session.mockResolvedValue({ principal: { id: 'staff' } });
  f.roots.mockResolvedValue({ schemaVersion: 1, roots: [], nextCursor: null });
  f.projects.mockResolvedValue({ schemaVersion: 1, projects: [], nextCursor: null });
});

describe('staging business authority boundary', () => {
  it('defaults closed and pins the staging environment, web origin, issuer and Ops audience', async () => {
    for (const change of [{ IOS_PILOT_BUSINESS_AUTHORITY_ENABLED: undefined }, { ENVIRONMENT: 'production' },
      { PUBLIC_BASE_URL: 'https://ops.ledgetop.app' }, { TEAM_DOMAIN: 'https://wrong.example' }, { OPERATIONS_AUD: 'wrong' }]) {
      expect((await result(input(), { ...env, ...change } as Env)).status).toBe(404);
    }
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('rejects duplicate fields, supplied authority, foreign routes and unsafe queries before authentication', async () => {
    const bad = [
      '{"url":"x","url":"y","assertion":"a.b.c"}',
      JSON.stringify({ url: origin + '/mobile-pilot/v1/business-roots', assertion: 'a.b.c', principal: 'admin' }),
      JSON.stringify({ url: origin + '/mobile-pilot/v1/business-roots', assertion: 'a.b.c', method: 'POST' }),
      JSON.stringify({ url: 'https://wrong.example/mobile-pilot/v1/business-roots', assertion: 'a.b.c' }),
      input('/mobile-pilot/v1/operations'), input('/mobile-pilot/v1/session'),
      input('/mobile-pilot/v1/business-roots?cursor=a&cursor=b'), input('/mobile-pilot/v1/business-roots?source=other'),
      input('/mobile-pilot/v1/business-roots/organization/%FF/projects'),
    ];
    for (const value of bad) expect((await result(value)).status).not.toBe(200);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('verifies the fixed pilot audience and uses the verified staff for the exact staging root', async () => {
    const response = await result(input('/mobile-pilot/v1/business-roots/organization/root-1/projects?cursor=abc'));
    expect(response.status).toBe(200);
    expect(f.verify).toHaveBeenCalledWith(expect.any(Request), { teamDomain: 'https://ledgetoptechnologies.cloudflareaccess.com',
      pilotAudience: 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d',
      operationsAudience: '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b' });
    expect(f.projects).toHaveBeenCalledWith(env, { principal: { id: 'staff' } },
      { sourceId: 'project-alpha:staging', kind: 'organization', clientHubRootId: 'root-1' }, 'abc');
  });

  it('fails closed and never reflects errors or secrets', async () => {
    f.verify.mockRejectedValueOnce(new HTTPException(401, { message: 'private-assertion' }));
    const denied = await readPilotBusinessAuthority(input(), env);
    expect(JSON.parse(denied).status).toBe(401);
    expect(denied).not.toContain('private-assertion');
    expect(f.roots).not.toHaveBeenCalled();
    f.roots.mockRejectedValueOnce(new Error('private-internal'));
    const failed = await readPilotBusinessAuthority(input(), env);
    expect(JSON.parse(failed).status).toBe(503);
    expect(failed).not.toContain('private-internal');
  });

  it('independently rejects extra fields, a foreign source, and malformed pagination', async () => {
    const root = { sourceId: 'project-alpha:staging', rootNamespace: 'business', kind: 'organization', clientHubRootId: 'one', name: 'Example' };
    for (const body of [
      { schemaVersion: 1, roots: [{ ...root, email: 'private' }], nextCursor: null },
      { schemaVersion: 1, roots: [{ ...root, sourceId: 'project-alpha:primary' }], nextCursor: null },
      { schemaVersion: 1, roots: [root], nextCursor: 'bad cursor' },
    ]) {
      f.roots.mockResolvedValueOnce(body);
      const response = await readPilotBusinessAuthority(input(), env);
      expect(JSON.parse(response).status).toBe(503);
      expect(response).not.toContain('private');
    }
  });
});
