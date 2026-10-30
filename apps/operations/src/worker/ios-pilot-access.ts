import { jwtVerify } from 'jose';
import { HTTPException } from 'hono/http-exception';
import { accessJwksResolver } from './access-jwks';
import type { VerifiedStaffLoginClaims } from './staff-login-bindings';

/** A route-less building block: verifying an Access assertion does not grant
 * staff or operation access. Callers must additionally check current staff
 * binding, admission and record permissions. No existing web auth uses this. */
export async function verifyPilotAccessAssertion(request: Request, config: {
  teamDomain: string; pilotAudience: string; operationsAudience: string;
}): Promise<VerifiedStaffLoginClaims> {
  const { teamDomain, pilotAudience, operationsAudience } = config;
  if (!teamDomain || !pilotAudience || !operationsAudience || pilotAudience !== pilotAudience.trim()
    || operationsAudience !== operationsAudience.trim() || pilotAudience.startsWith('REPLACE_')
    || operationsAudience.startsWith('REPLACE_') || pilotAudience === operationsAudience) {
    throw new HTTPException(503, { message: 'Pilot Access is not configured' });
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new HTTPException(401, { message: 'Cloudflare Access authentication required' });
  const issuer = teamDomain.replace(/\/$/, '');
  try {
    const { payload } = await jwtVerify(assertion, accessJwksResolver(issuer), {
      issuer, audience: pilotAudience, algorithms: ['RS256'],
    });
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
    const now = Math.floor(Date.now() / 1000);
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub || payload.sub !== payload.sub.trim()
      || typeof payload.email !== 'string' || !payload.email.trim() || payload.common_name !== undefined
      || payload.service_token_status === true || payload.service_token_id !== undefined
      || payload.iss !== issuer || !Array.isArray(audiences) || audiences.length !== 1 || audiences[0] !== pilotAudience
      || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) || payload.iat < 0 || payload.iat > now
      || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now
      || payload.exp > 253_402_300_799 || payload.iat >= payload.exp) throw new Error('invalid_claims');
    return { issuer, email: payload.email.trim().toLowerCase(), subject: payload.sub, issuedAt: payload.iat, expiresAt: payload.exp };
  } catch {
    throw new HTTPException(401, { message: 'A current human pilot Access sign-in is required' });
  }
}
