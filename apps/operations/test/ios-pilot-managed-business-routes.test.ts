import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ roots: vi.fn(), projects: vi.fn(), session: vi.fn() }));
vi.mock('../src/worker/ios-pilot-access', () => ({ verifyPilotAccessAssertion: vi.fn(async () => ({})) }));
vi.mock('../src/worker/ios-pilot-session', () => ({ IOS_PILOT_BASE: '/mobile-pilot/v1', pilotSessionFromAccessClaims: f.session }));
vi.mock('../src/worker/ios-pilot-business-reads', () => ({ readPilotBusinessRoots: f.roots, readPilotBusinessProjects: f.projects }));
vi.mock('../src/worker/ios-pilot-reads', () => ({ readPilotOperations: vi.fn() }));
vi.mock('../src/worker/ios-pilot-staff-snapshot', () => ({ readPilotSessionView: vi.fn() }));
import { handleManagedIosPilot } from '../src/worker/ios-pilot-managed-routes';

const origin = 'https://pilot-staging.example.test';
const config = { enabled: 'true', origin, audience: 'pilot' };
const env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  TEAM_DOMAIN: 'https://access.example.test', OPERATIONS_AUD: 'ops' } as Env;
const request = (path: string, init?: RequestInit) => new Request(origin + path, init);

describe('managed staging business routes', () => {
  it('remains closed when either the managed or business gate is disabled', async () => {
    const path = '/mobile-pilot/v1/business-roots';
    expect((await handleManagedIosPilot(request(path), env, config)).status).toBe(404);
    expect((await handleManagedIosPilot(request(path), { ...env, IOS_PILOT_BUSINESS_ENABLED: 'true' } as Env,
      { ...config, enabled: 'false' })).status).toBe(404);
    expect(f.roots).not.toHaveBeenCalled();
  });

  it('only allows GET and a single cursor before dispatching the verified session', async () => {
    const enabled = { ...env, IOS_PILOT_BUSINESS_ENABLED: 'true' } as Env;
    const path = '/mobile-pilot/v1/business-roots';
    expect((await handleManagedIosPilot(request(path, { method: 'POST' }), enabled, config)).status).toBe(405);
    expect((await handleManagedIosPilot(request(path + '?cursor=a&cursor=b'), enabled, config)).status).toBe(400);
    f.session.mockResolvedValue({ principal: { id: 'staff' } });
    f.roots.mockResolvedValue({ schemaVersion: 1, roots: [], nextCursor: null });
    expect((await handleManagedIosPilot(request(path + '?cursor=abc'), enabled, config)).status).toBe(200);
    expect(f.roots).toHaveBeenCalledWith(enabled, { principal: { id: 'staff' } }, 'abc');
  });

  it('dispatches only an exact staging root and rejects invalid escaped ids', async () => {
    const enabled = { ...env, IOS_PILOT_BUSINESS_ENABLED: 'true' } as Env;
    const path = '/mobile-pilot/v1/business-roots/organization/root-1/projects';
    f.session.mockResolvedValue({ principal: { id: 'staff' } });
    f.projects.mockResolvedValue({ schemaVersion: 1, projects: [], nextCursor: null });
    expect((await handleManagedIosPilot(request(path), enabled, config)).status).toBe(200);
    expect(f.projects).toHaveBeenCalledWith(enabled, { principal: { id: 'staff' } },
      { sourceId: 'project-alpha:staging', kind: 'organization', clientHubRootId: 'root-1' }, undefined);
    expect((await handleManagedIosPilot(request('/mobile-pilot/v1/business-roots/organization/%FF/projects'), enabled, config)).status).toBe(400);
  });
});
