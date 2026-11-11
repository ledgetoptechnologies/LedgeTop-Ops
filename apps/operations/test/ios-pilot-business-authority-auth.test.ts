import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ publicKey: undefined as unknown, session: vi.fn(), roots: vi.fn() }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => f.publicKey }));
vi.mock('../src/worker/ios-pilot-session', () => ({ pilotSessionFromAccessClaims: f.session }));
vi.mock('../src/worker/ios-pilot-business-reads', () => ({ readPilotBusinessRoots: f.roots, readPilotBusinessProjects: vi.fn() }));
import { readPilotBusinessAuthority } from '../src/worker/ios-pilot-business-authority';

const team = 'https://ledgetoptechnologies.cloudflareaccess.com';
const pilotAud = 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d';
const opsAud = '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b';
const origin = 'https://ios-pilot-staging.ledgetop.app';
const env = { ENVIRONMENT: 'staging', IOS_PILOT_BUSINESS_AUTHORITY_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://ops-staging.ledgetopdroneservices.com', TEAM_DOMAIN: team, OPERATIONS_AUD: opsAud } as unknown as Env;
let privateKey: CryptoKey, foreignKey: CryptoKey;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256'), other = await generateKeyPair('RS256');
  privateKey = keys.privateKey; foreignKey = other.privateKey; f.publicKey = keys.publicKey;
  f.session.mockResolvedValue({ principal: { id: 'staff' } });
  f.roots.mockResolvedValue({ schemaVersion: 1, roots: [], nextCursor: null });
});
async function assertion(overrides: Record<string, unknown> = {}, signingKey = privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', email: 'staff@example.test', ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer((overrides.iss as string) ?? team)
    .setAudience((overrides.aud as string) ?? pilotAud).setSubject('access|staff')
    .setIssuedAt(now - 1).setExpirationTime((overrides.exp as number) ?? now + 300).sign(signingKey);
}
async function call(token: string): Promise<{ status: number }> {
  return JSON.parse(await readPilotBusinessAuthority(JSON.stringify({ url: origin + '/mobile-pilot/v1/business-roots', assertion: token }), env));
}

describe('business authority signed assertions', () => {
  it('accepts only a signed current human assertion for the staging pilot audience', async () => {
    expect((await call(await assertion())).status).toBe(200);
    for (const token of [await assertion({ aud: opsAud }), await assertion({ iss: 'https://other.example' }),
      await assertion({ exp: 1 }), await assertion({ service_token_id: 'machine' }), await assertion({}, foreignKey)]) {
      expect((await call(token)).status).toBe(401);
    }
    expect(f.roots).toHaveBeenCalledTimes(1);
  });
});
