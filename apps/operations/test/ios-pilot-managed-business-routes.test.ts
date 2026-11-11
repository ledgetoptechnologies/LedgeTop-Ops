import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ session: vi.fn(), operations: vi.fn() }));
vi.mock('../src/worker/ios-pilot-access', () => ({ verifyPilotAccessAssertion: vi.fn(async () => ({})) }));
vi.mock('../src/worker/ios-pilot-session', () => ({ IOS_PILOT_BASE: '/mobile-pilot/v1', pilotSessionFromAccessClaims: f.session }));
vi.mock('../src/worker/ios-pilot-reads', () => ({ readPilotOperations: f.operations }));
vi.mock('../src/worker/ios-pilot-staff-snapshot', () => ({ readPilotSessionView: vi.fn() }));
import { handleManagedIosPilot } from '../src/worker/ios-pilot-managed-routes';

const origin = 'https://pilot-staging.example.test';
const config = { enabled: 'true', origin, audience: 'pilot' };
const env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  TEAM_DOMAIN: 'https://access.example.test', OPERATIONS_AUD: 'ops' } as Env;
const request = (path: string, init?: RequestInit) => new Request(origin + path, init);

describe('isolated managed pilot handler', () => {
  it('never dispatches business routes, even if the old business gate is set', async () => {
    for (const path of ['/mobile-pilot/v1/business-roots',
      '/mobile-pilot/v1/business-roots/organization/root-1/projects']) {
      expect((await handleManagedIosPilot(request(path), env, config)).status).toBe(404);
      expect((await handleManagedIosPilot(request(path), { ...env, IOS_PILOT_BUSINESS_ENABLED: 'true' } as Env, config)).status).toBe(404);
    }
    expect(f.session).not.toHaveBeenCalled();
    expect(f.operations).not.toHaveBeenCalled();
  });

  it('continues serving the existing operations route through the managed handler', async () => {
    f.session.mockResolvedValue({ principal: { id: 'staff' } });
    f.operations.mockResolvedValue({ schemaVersion: 1, operations: [], nextCursor: null });
    const response = await handleManagedIosPilot(request('/mobile-pilot/v1/operations'), env, config);
    expect(response.status).toBe(200);
    expect(f.operations).toHaveBeenCalledOnce();
  });
});
