import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const AGENT_READ_PREFIX = '/api/agent/v1';
export const AGENT_STAGING_HOST = 'ops-staging.ledgetopdroneservices.com';
export type AgentServiceConfiguration = Readonly<{
  environment?: string; enabled?: string; issuer?: string; audience?: string;
}>;
export type VerifiedAgentService = Readonly<{ accessClientId: string; expiresAt: number }>;

/** Separate signed service identity: never interpreted as a staff user or email. */
export async function verifyAgentService(request: Request, configuration: AgentServiceConfiguration,
  keyResolver?: JWTVerifyGetKey): Promise<VerifiedAgentService> {
  const url = new URL(request.url), c = configuration;
  if (c.environment !== 'staging' || c.enabled !== 'true' || url.protocol !== 'https:'
    || url.host !== AGENT_STAGING_HOST || !c.audience || !/^[A-Za-z0-9_-]{16,128}$/.test(c.audience)) throw Error('agent_access_denied');
  let issuer: URL;
  try { issuer = new URL(c.issuer ?? ''); } catch { throw Error('agent_access_denied'); }
  if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com')
    || issuer.hostname === '.cloudflareaccess.com' || issuer.origin !== c.issuer || issuer.username || issuer.password
    || issuer.port || issuer.pathname !== '/' || issuer.search || issuer.hash) throw Error('agent_access_denied');
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384 || /\s/.test(assertion)) throw Error('agent_access_denied');
  try {
    const { payload } = await jwtVerify(assertion, keyResolver ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)),
      { issuer: issuer.origin, audience: c.audience, algorithms: ['RS256'] });
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
    const now = Math.floor(Date.now() / 1000);
    if (!Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== c.audience
      || payload.type !== 'app' || payload.sub !== '' || Object.hasOwn(payload, 'email')
      || typeof payload.common_name !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(payload.common_name)
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.iat! < 0 || payload.iat! > now || payload.exp! <= now || payload.exp! > 253402300799
      || payload.iat! >= payload.exp!) throw Error();
    return Object.freeze({ accessClientId: payload.common_name, expiresAt: payload.exp! });
  } catch { throw Error('agent_access_denied'); }
}
