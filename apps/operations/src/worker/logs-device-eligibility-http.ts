import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readBoundedJson } from './bounded-json';
import { authenticateNativeStaffWithAdmissionVersion } from './native-staff-auth';
import { admittedOperationsRequestOrigin } from './host-admission';
import { auditStatement, csrfToken, requireMutationSecurity } from './request-security';
import { LogsDeviceEligibilityError, readLogsDeviceEligibility, setLogsDeviceEligibility, type LogsDeviceEligibilityCommand } from './logs-device-eligibility';
import type { Env, StaffPrincipal } from './types';

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
const ROUTE = '/api/staff-device-eligibility/:staffId';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
function commandSnapshot(value: unknown): LogsDeviceEligibilityCommand {
  const keys = ['commandId', 'expectedRevision', 'effect', 'reason'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
    throw new LogsDeviceEligibilityError('logs_device_eligibility_invalid', 400);
  const input = value as Record<string, unknown>;
  if (typeof input.commandId !== 'string' || typeof input.expectedRevision !== 'number'
    || input.effect !== 'allow' && input.effect !== 'deny' || typeof input.reason !== 'string')
    throw new LogsDeviceEligibilityError('logs_device_eligibility_invalid', 400);
  return Object.freeze({ commandId: input.commandId, expectedRevision: input.expectedRevision, effect: input.effect, reason: input.reason });
}

/** Exact native-only management routes terminate before the generic staff
 * wrapper. They independently verify JWT/native identity and global authority;
 * they never trust an administrator boolean or browser-supplied actor fields. */
export function registerLogsDeviceEligibilityRoutes(app: Hono<Bindings>): void {
  for (const method of ['get', 'post'] as const) app[method](ROUTE, async c => {
    try {
      const request = c.req.raw;
      if (request.method !== method.toUpperCase()) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (new URL(request.url).search) return json({ error: 'logs_device_eligibility_invalid' }, 400);
      const origin = admittedOperationsRequestOrigin(request.url, { ENVIRONMENT: c.env.ENVIRONMENT,
        EXPECTED_HOST: c.env.EXPECTED_HOST, OPERATIONS_ORIGINS: c.env.OPERATIONS_ORIGINS }, c.env.PUBLIC_BASE_URL);
      if (origin === null) return json({ error: 'logs_device_eligibility_denied' }, 403);
      const actor = await authenticateNativeStaffWithAdmissionVersion(request, c.env.OPS_DB, {
        enabled: true, issuer: c.env.TEAM_DOMAIN, staffAudience: c.env.OPERATIONS_AUD,
      });
      const principal: StaffPrincipal = { id: actor.identity.staffId, email: actor.identity.email,
        displayName: actor.identity.displayName, accessSubject: actor.identity.verifiedAccessSubject,
        projectAlphaUserId: null, accessExpiresAt: Math.floor(Date.parse(actor.verifiedUntil) / 1000),
        ...(actor.verifiedLogin ? { verifiedLogin: actor.verifiedLogin } : {}) };
      const staffId = c.req.param('staffId');
      if (method === 'get') {
        const token = await csrfToken(c.env, principal);
        // Keep the permission/identity/data snapshot as the final I/O before
        // returning private state, rather than awaiting crypto after admission.
        const state = await readLogsDeviceEligibility(c.env.OPS_DB, actor, staffId);
        if (Date.now() >= Date.parse(actor.verifiedUntil)) return json({ error: 'logs_device_eligibility_denied' }, 403);
        return json({ ...state, csrfToken: token, verifiedUntil: actor.verifiedUntil });
      }
      await requireMutationSecurity(request, c.env, principal);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? ''))
        return json({ error: 'logs_device_eligibility_invalid' }, 400);
      const command = commandSnapshot(await readBoundedJson(request, 4096, 'Logs device eligibility'));
      const audit = await auditStatement(c.env, request, principal, 'staff.logs_device_eligibility.changed', 'staff', staffId,
        null, { commandId: command.commandId, effect: command.effect, expectedRevision: command.expectedRevision, reason: command.reason });
      return json({ receipt: await setLogsDeviceEligibility(c.env.OPS_DB, actor, staffId, command, audit) });
    } catch (error) {
      if (error instanceof LogsDeviceEligibilityError) return json({ error: error.code }, error.status);
      if (error instanceof Error && error.message === 'native_staff_access_denied') return json({ error: 'logs_device_eligibility_denied' }, 403);
      if (error instanceof HTTPException && [400, 403, 413].includes(error.status))
        return json({ error: error.status === 403 ? 'logs_device_eligibility_denied' : 'logs_device_eligibility_invalid' }, error.status);
      return json({ error: 'logs_device_eligibility_unavailable' }, 503);
    }
  });
}
