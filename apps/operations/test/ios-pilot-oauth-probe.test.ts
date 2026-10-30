import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

const key = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => key.publicKey }));
import probe, { handleOAuthProbe } from '../src/worker/ios-pilot-oauth-probe';

const origin = 'https://synthetic-pilot.example.test';
const issuer = 'https://synthetic-team.cloudflareaccess.com';
const env = { ENVIRONMENT: 'staging', IOS_OAUTH_PROBE_ENABLED: 'true', IOS_OAUTH_PROBE_ORIGIN: origin,
  IOS_OAUTH_PROBE_AUDIENCE: 'pilot-audience', TEAM_DOMAIN: issuer, OPERATIONS_AUD: 'web-audience' };
let privateKey: CryptoKey;
beforeAll(async () => { const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey; key.publicKey = pair.publicKey; });
async function signed(audience = env.IOS_OAUTH_PROBE_AUDIENCE) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: 'synthetic@example.test' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer).setAudience(audience).setSubject('synthetic-subject').setIssuedAt(now - 1).setExpirationTime(now + 300).sign(privateKey);
}
const req = (path: string, headers: HeadersInit = {}, method = 'GET', host = origin) =>
  new Request(host + path, { method, headers });

describe('synthetic OAuth probe', () => {
  it('keeps the deployable entrypoint closed even with enabled environment variables', async () => {
    const response = await probe.fetch(req('/oauth-probe/v1'), env);
    expect(response.status).toBe(404);
    expect(Object.keys(probe)).toEqual(['fetch']);
  });
  it('keeps the reviewed staging origin disabled until explicitly enabled', async () => {
    const stagingOrigin = 'https://ios-pilot-staging.ledgetop.app';
    const stagingEnv = { ...env, IOS_OAUTH_PROBE_ORIGIN: stagingOrigin, IOS_OAUTH_PROBE_ENABLED: 'false' };
    const headers = { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': await signed() };
    expect((await probe.fetch(req('/oauth-probe/v1', headers, 'GET', stagingOrigin), stagingEnv)).status).toBe(404);
    expect((await probe.fetch(req('/oauth-probe/v1', headers, 'GET', stagingOrigin), { ...stagingEnv, IOS_OAUTH_PROBE_ENABLED: 'true' })).status).toBe(200);
    expect((await probe.fetch(req('/oauth-probe/v1', headers, 'GET', origin), { ...env, IOS_OAUTH_PROBE_ENABLED: 'true' })).status).toBe(404);
  });
  it('returns only a static marker after a verified dedicated human assertion', async () => {
    const token = 'oauth:synthetic-token', assertion = await signed();
    const response = await handleOAuthProbe(req('/oauth-probe/v1', {
      Authorization: `Bearer ${token}`, 'Cf-Access-Jwt-Assertion': assertion,
    }), env, [origin]);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-LT-Ops-Probe-Stage')).toBe('ok');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, kind: 'synthetic-oauth-probe' });
    for (const value of [token, assertion, 'synthetic-subject', 'synthetic@example.test']) expect(text).not.toContain(value);
  });
  it('denies unsupported paths, methods, queries, foreign host, and disabled configuration', async () => {
    const headers = { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': await signed() };
    for (const value of [req('/api/operations', headers), req('/oauth-probe/v1?x=1', headers),
      req('/oauth-probe/v1', headers, 'POST'), req('/oauth-probe/v1', headers, 'GET', 'https://other.example.test')]) {
      expect((await handleOAuthProbe(value, env, [origin])).status).toBe(404);
    }
    expect((await handleOAuthProbe(req('/oauth-probe/v1', headers), { ...env, ENVIRONMENT: 'production' }, [origin])).status).toBe(404);
    expect((await handleOAuthProbe(req('/oauth-probe/v1', headers), env, [])).status).toBe(404);
  });
  it('rejects missing, foreign-audience, ambient-cookie and unsigned credentials', async () => {
    const requests = [req('/oauth-probe/v1'), req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic' }),
      req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': await signed('web-audience') }),
      req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': await signed(), Cookie: 'CF_Authorization=bad' }),
      req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': 'forged' })];
    for (const value of requests) expect((await handleOAuthProbe(value, env, [origin])).status).toBe(401);
  });
  it('returns only fixed diagnostic stages for failed synthetic requests', async () => {
    const cases: Array<[Request, string]> = [
      [req('/oauth-probe/v1'), 'bearer-rejected'],
      [req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic' }), 'assertion-missing'],
      [req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': 'forged' }), 'assertion-invalid'],
      [req('/oauth-probe/v1', { Authorization: 'Bearer oauth:synthetic', Cookie: 'secret-test' }), 'request-rejected'],
    ];
    for (const [request, expected] of cases) {
      const response = await handleOAuthProbe(request, env, [origin]);
      expect(response.status).toBe(401);
      expect(response.headers.get('X-LT-Ops-Probe-Stage')).toBe(expected);
      expect(JSON.stringify([...response.headers])).not.toContain('secret-test');
    }
  });
});
