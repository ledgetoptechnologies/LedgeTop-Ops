import { Hono } from 'hono';
import { authenticateNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from './native-staff-auth';
import { readBoundedJson } from './bounded-json';
import { EmployeeProvisioningError, provisionEmployeeRead } from './employee-read-provisioning';

export type EmployeeReadAdminConfiguration = Readonly<{
  enabled: boolean; opsOrigin: string; access: NativeStaffAccessConfiguration; gatewayIds: readonly string[];
}>;

/** Deliberately not mounted by the production entrypoint. UI and deployment are separate gates. */
export function createEmployeeReadAdminRouter(configuration: EmployeeReadAdminConfiguration,
  dependencies: Readonly<{ database: D1Database; authenticate?: typeof authenticateNativeStaffWithAdmissionVersion }>) {
  const router = new Hono();
  const enabled = configuration?.enabled === true;
  let captured: Readonly<{ opsOrigin: string; access: NativeStaffAccessConfiguration; gatewayIds: readonly string[];
    database: D1Database; authenticate: typeof authenticateNativeStaffWithAdmissionVersion }> | null = null;
  try {
    const opsOrigin = configuration.opsOrigin, origin = new URL(opsOrigin);
    const access = Object.freeze({ enabled: configuration.access.enabled, issuer: configuration.access.issuer, staffAudience: configuration.access.staffAudience });
    const issuer = new URL(access.issuer), gatewayIds = Object.freeze([...configuration.gatewayIds]);
    const database = dependencies.database, authenticate = dependencies.authenticate ?? authenticateNativeStaffWithAdmissionVersion;
    if (origin.protocol !== 'https:' || origin.origin !== opsOrigin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || !access.enabled || issuer.protocol !== 'https:' || issuer.origin !== access.issuer || issuer.port || issuer.username || issuer.password
      || issuer.pathname !== '/' || issuer.search || issuer.hash || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.hostname === '.cloudflareaccess.com'
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(access.staffAudience) || !gatewayIds.length || gatewayIds.length > 100
      || !gatewayIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))
      || !database || typeof database.withSession !== 'function' || typeof authenticate !== 'function') throw Error();
    captured = Object.freeze({ opsOrigin, access, gatewayIds, database, authenticate });
  } catch { /* enabled invalid configuration remains unavailable, never falls back */ }
  router.post('/api/admin/employee-files/commands', async c => {
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    try {
      if (!enabled) return reply(404, { error: 'not-found' });
      if (!captured) return reply(503, { error: 'unavailable' });
      const fixed = captured, url = new URL(c.req.url);
      if (url.origin !== fixed.opsOrigin || url.search || c.req.header('Origin') !== fixed.opsOrigin
        || (c.req.header('Sec-Fetch-Site') !== undefined && c.req.header('Sec-Fetch-Site') !== 'same-origin')) return reply(403, { error: 'denied' });
      let actor;
      try { actor = await fixed.authenticate(c.req.raw, fixed.database, fixed.access); }
      catch { return reply(401, { error: 'login-required' }); }
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
