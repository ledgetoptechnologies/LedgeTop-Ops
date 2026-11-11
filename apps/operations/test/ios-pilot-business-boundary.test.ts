import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ roots: vi.fn(), projects: vi.fn(), session: vi.fn() }));
vi.mock('../src/worker/ios-pilot-access', () => ({ verifyPilotAccessAssertion: vi.fn(async () => ({ subject: 'subject', email: 'staff@example.test' })) }));
vi.mock('../src/worker/ios-pilot-session', () => ({ IOS_PILOT_BASE: '/mobile-pilot/v1', pilotSessionFromAccessClaims: f.session }));
vi.mock('../src/worker/ios-pilot-business-reads', () => ({ readPilotBusinessRoots: f.roots, readPilotBusinessProjects: f.projects }));
vi.mock('../src/worker/ios-pilot-reads', () => ({ readPilotOperations: vi.fn() }));
vi.mock('../src/worker/ios-pilot-staff-snapshot', () => ({ readPilotSessionView: vi.fn() }));
import { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';

const origin = 'https://pilot-staging.example.test';
const access = { aud: 'pilot', getIdentity: async () => ({ user_uuid: 'subject', email: 'staff@example.test' }) };
const base = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin, IOS_MANAGED_PILOT_AUDIENCE: 'pilot',
  TEAM_DOMAIN: 'https://access.example.test', OPERATIONS_AUD: 'ops' };
const path = '/mobile-pilot/v1/business-roots';
const req = (method = 'GET') => new Request(origin + path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } });

describe('business reader boundary', () => {
  it('requires both independent business switches and returns only the reviewed response', async () => {
    f.session.mockResolvedValue({ principal: { id: 'staff' } });
    f.roots.mockResolvedValue({ schemaVersion: 1, roots: [{ sourceId: 'project-alpha:staging', rootNamespace: 'business',
      kind: 'organization', clientHubRootId: 'one', name: 'Example' }], nextCursor: null });
    let reader = { ...base, IOS_PILOT_BUSINESS_ENABLED: 'false' } as unknown as Env;
    const binding = { read: vi.fn(async (input: string) => readPilotRpc(input, reader, [origin])) };
    const edge = { ...base, IOS_PILOT_BUSINESS_ENABLED: 'true', IOS_PILOT_READ: binding };
    expect((await handlePilotEdge(req(), edge, [origin], access)).status).toBe(404);
    expect(f.roots).not.toHaveBeenCalled();
    reader = { ...base, IOS_PILOT_BUSINESS_ENABLED: 'true' } as unknown as Env;
    expect((await handlePilotEdge(req(), { ...edge, IOS_PILOT_BUSINESS_ENABLED: 'false' }, [origin], access)).status).toBe(404);
    expect(f.roots).not.toHaveBeenCalled();
    expect((await handlePilotEdge(req('POST'), edge, [origin], access)).status).toBe(405);
    const response = await handlePilotEdge(req(), edge, [origin], access);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, roots: [{ sourceId: 'project-alpha:staging',
      rootNamespace: 'business', kind: 'organization', clientHubRootId: 'one', name: 'Example' }], nextCursor: null });
  });
});
