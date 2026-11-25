import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/worker/ios-pilot-access', () => ({ verifyPilotAccessAssertion: vi.fn(async () => ({ subject: 'subject', email: 'staff@example.test' })) }));
import { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

const origin = 'https://pilot-staging.example.test';
const access = { aud: 'pilot', getIdentity: async () => ({ user_uuid: 'subject', email: 'staff@example.test' }) };
const base = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin, IOS_MANAGED_PILOT_AUDIENCE: 'pilot',
  TEAM_DOMAIN: 'https://access.example.test', OPERATIONS_AUD: 'ops' };
const path = '/mobile-pilot/v1/business-roots';
const req = (method = 'GET') => new Request(origin + path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } });

describe('business reader boundary', () => {
  it('requires both independent business switches and returns only the reviewed response', async () => {
    const binding = { read: vi.fn(async () => JSON.stringify({ version: 1, status: 200, body: {
      schemaVersion: 1, roots: [{ sourceId: 'project-alpha:staging', rootNamespace: 'business',
        kind: 'organization', clientHubRootId: 'one', name: 'Example' }], nextCursor: null,
    } })) };
    const edge = { ...base, IOS_PILOT_BUSINESS_READ: binding };
    expect((await handlePilotEdge(req(), edge, [origin], access)).status).toBe(404);
    expect(binding.read).not.toHaveBeenCalled();
    const enabled = { ...edge, IOS_PILOT_BUSINESS_ENABLED: 'true' };
    expect((await handlePilotEdge(req(), { ...enabled, IOS_MANAGED_PILOT_ENABLED: 'false' }, [origin], access)).status).toBe(404);
    expect((await handlePilotEdge(req(), { ...enabled, IOS_PILOT_BUSINESS_ENABLED: 'false' }, [origin], access)).status).toBe(404);
    expect(binding.read).not.toHaveBeenCalled();
    expect((await handlePilotEdge(req('POST'), enabled, [origin], access)).status).toBe(405);
    const response = await handlePilotEdge(req(), enabled, [origin], access);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, roots: [{ sourceId: 'project-alpha:staging',
      rootNamespace: 'business', kind: 'organization', clientHubRootId: 'one', name: 'Example' }], nextCursor: null });
    expect(binding.read).toHaveBeenCalledOnce();
  });
});
