import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

const key = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => key.publicKey }));
import { verifyPilotAccessAssertion } from '../src/worker/ios-pilot-access';

const issuer = 'https://pilot-test.cloudflareaccess.com';
const config = { teamDomain: issuer, pilotAudience: 'pilot-audience', operationsAudience: 'web-audience' };
let privateKey: CryptoKey;
let otherKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey; key.publicKey = pair.publicKey; otherKey = other.privateKey;
});
async function request(claims: Record<string, unknown> = {}, signingKey = privateKey, algorithm = 'RS256') {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ type: 'app', email: 'Staff@Example.test', ...claims })
    .setProtectedHeader({ alg: algorithm }).setIssuer((claims.iss as string) ?? issuer)
    .setAudience((claims.aud as string | string[]) ?? config.pilotAudience)
    .setSubject((claims.sub as string) ?? 'provider|staff').setIssuedAt((claims.iat as number) ?? now - 1)
    .setExpirationTime((claims.exp as number) ?? now + 300).sign(signingKey);
  return new Request('https://pilot.example.test/mobile-pilot/v1/session', { headers: { 'Cf-Access-Jwt-Assertion': token } });
}

describe('dedicated pilot Access assertion', () => {
  it('accepts a signed, current human assertion for only the pilot audience', async () => {
    await expect(verifyPilotAccessAssertion(await request(), config)).resolves.toMatchObject({
      issuer, subject: 'provider|staff', email: 'staff@example.test',
    });
  });
  it.each([
    ['web audience', { aud: 'web-audience' }], ['multiple audiences', { aud: ['pilot-audience', 'web-audience'] }],
    ['other issuer', { iss: 'https://other.cloudflareaccess.com' }], ['machine identity', { service_token_id: 'machine' }],
    ['certificate identity', { common_name: 'machine' }], ['non-app token', { type: 'service' }],
    ['whitespace subject', { sub: ' provider|staff' }], ['missing human email', { email: '' }],
    ['future issue time', { iat: Math.floor(Date.now() / 1000) + 600 }], ['expired token', { exp: 1 }],
  ])('rejects %s', async (_label, claims) => {
    await expect(verifyPilotAccessAssertion(await request(claims), config)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a token signed by another key', async () => {
    await expect(verifyPilotAccessAssertion(await request({}, otherKey), config)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an unsupported signature algorithm', async () => {
    const pair = await generateKeyPair('RS384');
    await expect(verifyPilotAccessAssertion(await request({}, pair.privateKey, 'RS384'), config)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a missing assertion and a shared or unconfigured audience', async () => {
    await expect(verifyPilotAccessAssertion(new Request('https://pilot.example.test'), config)).rejects.toMatchObject({ status: 401 });
    const signed = await request();
    for (const pilotAudience of ['', 'REPLACE_PILOT', config.operationsAudience]) {
      await expect(verifyPilotAccessAssertion(signed, { ...config, pilotAudience })).rejects.toMatchObject({ status: 503 });
    }
  });
});
