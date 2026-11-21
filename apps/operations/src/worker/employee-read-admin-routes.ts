import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from './native-staff-auth';
import { readBoundedJson } from './bounded-json';
import { EmployeeProvisioningError, listEmployeeFilesAccess, provisionEmployeeRead } from './employee-read-provisioning';

export type EmployeeReadAdminConfiguration = Readonly<{
  enabled: boolean; opsOrigin: string; access: NativeStaffAccessConfiguration; gatewayIds: readonly string[]; csrfSecret: string;
}>;

const encoder = new TextEncoder();
/** A CSRF token carries its own expiry and is valid for at most 15 minutes from issue. */
export const CSRF_LIFETIME_SECONDS = 900;
const TOKEN = /^([1-9][0-9]{0,15})\.([0-9a-f]{64})$/u;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(message))).toString('hex');
}
/** HMAC over the same identity fields as the existing Ops staff CSRF (client-onboarding-staff-http.ts), with its own
 * domain string and an explicit expiry: "<expiresAt>.<hex>". */
function csrfMac(secret: string, origin: string, access: NativeStaffAccessConfiguration, auth: AuthenticatedNativeStaffWithAdmissionVersion, expiresAt: number) {
  return hmac(secret, JSON.stringify(['employee-files-admin-csrf-v2', access.issuer, access.staffAudience, origin,
    auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.identity.email, auth.admissionVersion, expiresAt]));
}
export async function issueEmployeeFilesCsrf(secret: string, origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const expiresAt = nowSeconds + CSRF_LIFETIME_SECONDS;
  return `${expiresAt}.${await csrfMac(secret, origin, access, auth, expiresAt)}`;
}
export async function employeeFilesCsrfValid(candidate: string, secret: string, origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const match = TOKEN.exec(candidate);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  // Valid strictly before its expiry, and never for more than the lifetime (a forged far-future expiry fails the MAC anyway).
  if (!Number.isSafeInteger(expiresAt) || nowSeconds >= expiresAt || expiresAt > nowSeconds + CSRF_LIFETIME_SECONDS) return false;
  const expected = await csrfMac(secret, origin, access, auth, expiresAt);
  return timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(expected, 'hex'));
}

/** Deliberately not mounted by the production entrypoint. The Ops Team screen calls these; it is built separately. */
export function createEmployeeReadAdminRouter(configuration: EmployeeReadAdminConfiguration,
  dependencies: Readonly<{ database: D1Database; authenticate?: typeof authenticateNativeStaffWithAdmissionVersion }>) {
  const router = new Hono();
  const enabled = configuration?.enabled === true;
  let captured: Readonly<{ opsOrigin: string; access: NativeStaffAccessConfiguration; gatewayIds: readonly string[]; csrfSecret: string;
    database: D1Database; authenticate: typeof authenticateNativeStaffWithAdmissionVersion }> | null = null;
  try {
    const opsOrigin = configuration.opsOrigin, origin = new URL(opsOrigin);
    const access = Object.freeze({ enabled: configuration.access.enabled, issuer: configuration.access.issuer, staffAudience: configuration.access.staffAudience });
    const issuer = new URL(access.issuer), gatewayIds = Object.freeze([...configuration.gatewayIds]), csrfSecret = configuration.csrfSecret;
    const database = dependencies.database, authenticate = dependencies.authenticate ?? authenticateNativeStaffWithAdmissionVersion;
    if (origin.protocol !== 'https:' || origin.origin !== opsOrigin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || !access.enabled || issuer.protocol !== 'https:' || issuer.origin !== access.issuer || issuer.port || issuer.username || issuer.password
      || issuer.pathname !== '/' || issuer.search || issuer.hash || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.hostname === '.cloudflareaccess.com'
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(access.staffAudience) || !gatewayIds.length || gatewayIds.length > 100
      || !gatewayIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))
      || typeof csrfSecret !== 'string' || encoder.encode(csrfSecret).byteLength < 32 || encoder.encode(csrfSecret).byteLength > 512
      || !database || typeof database.withSession !== 'function' || typeof authenticate !== 'function') throw Error();
    captured = Object.freeze({ opsOrigin, access, gatewayIds, csrfSecret, database, authenticate });
  } catch { /* enabled invalid configuration remains unavailable, never falls back */ }
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  /** Shared gates: enabled, configured, exact origin, same-origin browser fetch, then human authentication. */
  async function admit(request: Request, requireOriginHeader: boolean) {
    if (!enabled) return { error: reply(404, { error: 'not-found' }) } as const;
    if (!captured) return { error: reply(503, { error: 'unavailable' }) } as const;
    const fixed = captured, url = new URL(request.url), originHeader = request.headers.get('Origin');
    if (url.origin !== fixed.opsOrigin || url.search || (requireOriginHeader ? originHeader !== fixed.opsOrigin : originHeader !== null && originHeader !== fixed.opsOrigin)
      || (request.headers.get('Sec-Fetch-Site') !== null && request.headers.get('Sec-Fetch-Site') !== 'same-origin')) return { error: reply(403, { error: 'denied' }) } as const;
    try { return { fixed, actor: await fixed.authenticate(request, fixed.database, fixed.access) } as const; }
    catch { return { error: reply(401, { error: 'login-required' }) } as const; }
  }
  router.get('/api/admin/employee-files/staff/:staffId/grants', async c => {
    try {
      const admitted = await admit(c.req.raw, false);
      if ('error' in admitted) return admitted.error;
      const { fixed, actor } = admitted;
      const listing = await listEmployeeFilesAccess(fixed.database, actor, c.req.param('staffId'), { gatewayIds: fixed.gatewayIds });
      return reply(200, listing.canManage ? { ...listing, csrfToken: await issueEmployeeFilesCsrf(fixed.csrfSecret, fixed.opsOrigin, fixed.access, actor) } : listing);
    } catch (error) {
      return error instanceof EmployeeProvisioningError ? reply(error.status, { error: error.code }) : reply(503, { error: 'unavailable' });
    }
  });
  router.post('/api/admin/employee-files/commands', async c => {
    try {
      const admitted = await admit(c.req.raw, true);
      if ('error' in admitted) return admitted.error;
      const { fixed, actor } = admitted;
      if (!await employeeFilesCsrfValid(c.req.header('X-CSRF-Token') ?? '', fixed.csrfSecret, fixed.opsOrigin, fixed.access, actor)) return reply(403, { error: 'invalid-csrf' });
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(c.req.header('Content-Type') ?? '')) return reply(400, { error: 'invalid-command' });
      let body: unknown;
      try { body = await readBoundedJson(c.req.raw, 8192, 'employee file administration'); }
      catch { return reply(400, { error: 'invalid-command' }); }
      const receipt = await provisionEmployeeRead(fixed.database, actor, body, { gatewayIds: fixed.gatewayIds });
      return reply(200, receipt);
    } catch (error) {
      return error instanceof EmployeeProvisioningError ? reply(error.status, { error: error.code }) : reply(503, { error: 'unavailable' });
    }
  });
  return router;
}
