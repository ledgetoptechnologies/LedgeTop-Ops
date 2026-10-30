import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

const keys = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => keys.publicKey }));
import { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

const origin = 'https://pilot-staging.example.test', issuer = 'https://synthetic.cloudflareaccess.com';
const service = { read: vi.fn(async () => JSON.stringify({ version: 1, status: 200,
  body: { schemaVersion: 1, readOnly: true, user: { id: 'staff', displayName: 'Staff', email: 'staff@example.test' }, expiresAt: 9999999999 } })) };
const env = { ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
  IOS_MANAGED_PILOT_AUDIENCE: 'pilot-aud', TEAM_DOMAIN: issuer, OPERATIONS_AUD: 'web-aud', IOS_PILOT_READ: service };
const context = { aud: 'pilot-aud', getIdentity: async () => ({ user_uuid: 'subject', email: 'staff@example.test' }) };
let privateKey: CryptoKey, otherKey: CryptoKey;
beforeAll(async () => { const pair = await generateKeyPair('RS256'); keys.publicKey = pair.publicKey; privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey; });
async function token(options: { aud?: string; iss?: string; sub?: string; expires?: number; key?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: 'staff@example.test' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(options.iss ?? issuer).setAudience(options.aud ?? 'pilot-aud').setSubject(options.sub ?? 'subject')
    .setIssuedAt(now - 10).setExpirationTime(now + (options.expires ?? 300)).sign(options.key ?? privateKey);
}
const request = (assertion: string) => new Request(origin + '/mobile-pilot/v1/session', { headers: { 'Cf-Access-Jwt-Assertion': assertion } });

describe('edge runtime identity and signed assertion binding', () => {
  it('accepts a matching verified identity without the original Authorization header', async () => {
    service.read.mockClear();
    expect((await handlePilotEdge(request(await token()), env, [origin], context)).status).toBe(200);
    expect(service.read).toHaveBeenCalledOnce();
  });
  it('does not reach the service for forged, expired, wrong issuer/audience, or another user', async () => {
    service.read.mockClear();
    for (const jwt of [await token({ key: otherKey }), await token({ expires: -60 }),
      await token({ iss: 'https://foreign.cloudflareaccess.com' }), await token({ aud: 'web-aud' }), await token({ sub: 'other-user' })]) {
      expect((await handlePilotEdge(request(jwt), env, [origin], context)).status).toBe(401);
    }
    expect(service.read).not.toHaveBeenCalled();
  });
});
