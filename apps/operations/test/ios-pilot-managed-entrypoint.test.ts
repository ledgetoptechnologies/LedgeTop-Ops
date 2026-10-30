import { describe, expect, it } from 'vitest';
import pilot, { isReviewedPilotOrigin } from '../src/worker/ios-pilot-managed-entrypoint';

const origin = 'https://pilot-staging.example.test';
const web = 'https://ops-staging.example.test';
const configured = {
  ENVIRONMENT: 'staging', PUBLIC_BASE_URL: web,
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
  IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience', OPERATIONS_AUD: 'web-audience',
  TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
};
type Environment = Parameters<typeof pilot.fetch>[1];
const env = configured as Environment;
const request = (path: string, init?: RequestInit, base = origin) => new Request(base + path, init);

describe('separate staging pilot Worker entrypoint', () => {
  it('exports only fetch and defaults closed outside explicit staging activation', async () => {
    expect(Object.keys(pilot)).toEqual(['fetch']);
    for (const variant of [
      { ...configured, ENVIRONMENT: 'production' },
      { ...configured, ENVIRONMENT: 'development' },
      { ...configured, IOS_MANAGED_PILOT_ENABLED: undefined },
      { ...configured, IOS_MANAGED_PILOT_ORIGIN: undefined },
    ]) {
      const response = await pilot.fetch(request('/mobile-pilot/v1/session'), variant as Environment);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('keeps every path closed when no staging hostname has been reviewed', async () => {
    for (const path of ['/api/operations', '/api/team', '/dashboard', '/assets/index.js', '/', '/mobile-pilot/v1'])
      expect((await pilot.fetch(request(path, { headers: { Authorization: 'Bearer oauth:synthetic' } }), env)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
      expect((await pilot.fetch(request('/mobile-pilot/v1/operations', { method, headers: { Authorization: 'Bearer oauth:synthetic' } }), env)).status).toBe(404);
    expect((await pilot.fetch(request('/mobile-pilot/v1/session', undefined, web), env)).status).toBe(404);
    expect((await pilot.fetch(request('/mobile-pilot/v1/session', { headers: { Host: new URL(web).host } }), env)).status).toBe(404);
  });

  it('requires a canonical exact reviewed origin and rejects existing Operations aliases', () => {
    expect(isReviewedPilotOrigin(origin, web, [])).toBe(false);
    expect(isReviewedPilotOrigin(origin, web, [origin])).toBe(true);
    for (const value of [web, 'https://ops.ledgetop.app', 'https://ops.ledgetopdroneservices.com',
      'https://ops.ledgetoptechnologies.com', 'https://ops-staging.ledgetopdroneservices.com',
      origin + '/', origin + ':443', origin + '/path', 'http://pilot-staging.example.test',
      'https://user@pilot-staging.example.test', 'https://pilot-staging.example.test?x=1']) {
      expect(isReviewedPilotOrigin(value, web, [value])).toBe(false);
    }
    expect(isReviewedPilotOrigin('https://other.example.test', web, [origin])).toBe(false);
  });
});
