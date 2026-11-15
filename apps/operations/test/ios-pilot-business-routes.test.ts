import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../src/worker/types';
const key = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => key.publicKey }));
import { handleManagedIosPilotBusiness } from '../src/worker/ios-pilot-business-routes';
import { readPilotBusinessRpc } from '../src/worker/ios-pilot-business-rpc';

const origin = 'https://pilot-staging.example.test', issuer = 'https://synthetic.cloudflareaccess.com';
const env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_PILOT_BUSINESS_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
  IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience', TEAM_DOMAIN: issuer, OPERATIONS_AUD: 'web-audience' } as Env & { IOS_PILOT_BUSINESS_ENABLED: string };
const config = { enabled: 'true', origin, audience: 'pilot-audience' };
let privateKey: CryptoKey;
beforeAll(async () => { const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey; key.publicKey = pair.publicKey; });
async function assertion(overrides: Record<string, unknown> = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: 'staff@example.test', ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(String(overrides.iss ?? issuer))
    .setAudience((overrides.aud as string) ?? 'pilot-audience').setSubject('access|staff')
    .setIssuedAt(now - 1).setExpirationTime(Number(overrides.exp ?? now + 300)).sign(signingKey);
}
const input = (url = origin + '/mobile-pilot/v1/business-roots', jwt = 'a.b.c') => JSON.stringify({ url, assertion: jwt });
const rpc = async (value: unknown, candidate = env, reviewed: readonly string[] = [origin]) =>
  JSON.parse(await readPilotBusinessRpc(value, candidate, reviewed)) as { version: number; status: number; body: Record<string, unknown> };

describe('private business facade and bounded RPC admission', () => {
  it('defaults closed without staging flags and a reviewed origin even for structurally valid RPC', async () => {
    expect((await rpc(input(), env, [])).status).toBe(404);
    for (const changed of [{ ENVIRONMENT: 'production' }, { IOS_PILOT_BUSINESS_ENABLED: 'false' },
      { IOS_MANAGED_PILOT_ENABLED: 'false' }, { IOS_MANAGED_PILOT_ORIGIN: 'https://ops.ledgetop.app' }])
      expect((await rpc(input(), { ...env, ...changed })).status).toBe(404);
  });
  it('rejects injected principals, foreign URL, malformed assertion and oversized envelope', async () => {
    for (const value of [{ url: origin + '/mobile-pilot/v1/business-roots', assertion: 'a.b.c', principal: 'owner' },
      { url: 'https://foreign.example.test/mobile-pilot/v1/business-roots', assertion: 'a.b.c' },
      { url: origin + '/mobile-pilot/v1/business-roots', assertion: 'not-a-jwt' }])
      expect((await rpc(JSON.stringify(value))).status).toBe(404);
    expect((await rpc('x'.repeat(24_577))).status).toBe(404);
  });
  it('exposes only exact business GET routes and rejects query or encoded-control ambiguity', async () => {
    for (const path of ['/api/clients', '/mobile-pilot/v1/operations', '/mobile-pilot/v1/business-roots/',
      '/mobile-pilot/v1/business-roots/portal/id/projects'])
      expect((await handleManagedIosPilotBusiness(new Request(origin + path), env, config)).status).toBe(404);
    expect((await handleManagedIosPilotBusiness(new Request(origin + '/mobile-pilot/v1/business-roots', { method: 'POST' }), env, config)).status).toBe(405);
    for (const path of ['/mobile-pilot/v1/business-roots?source=project-alpha:other',
      '/mobile-pilot/v1/business-roots?cursor=a&cursor=b', '/mobile-pilot/v1/business-roots/organization/a%00b/projects'])
      expect((await handleManagedIosPilotBusiness(new Request(origin + path), env, config)).status).toBe(400);
  });
  it('does not accept ordinary browser/session headers at the private handler', async () => {
    for (const header of ['Cookie', 'Origin', 'Authorization']) {
      const result = await handleManagedIosPilotBusiness(new Request(origin + '/mobile-pilot/v1/business-roots',
        { headers: { [header]: 'untrusted' } }), env, config);
      expect(result.status).toBe(403);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('independently verifies signed pilot audience, issuer, human identity and expiration before DB access', async () => {
    const other = await generateKeyPair('RS256');
    const tokens = [await assertion({ aud: 'web-audience' }), await assertion({ iss: 'https://other.cloudflareaccess.com' }),
      await assertion({ service_token_id: 'machine' }), await assertion({ exp: 1 }), await assertion({}, other.privateKey)];
    for (const token of tokens) {
      const result = await rpc(input(undefined, token));
      expect(result.status).toBe(401);
      expect(JSON.stringify(result)).not.toMatch(/stack|sqlite|assertion|staff@example/);
    }
  });
});
