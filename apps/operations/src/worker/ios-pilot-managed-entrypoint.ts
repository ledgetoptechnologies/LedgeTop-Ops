import { handleManagedIosPilot } from './ios-pilot-managed-routes';
import type { Env } from './types';

/** Standalone, staging-only entrypoint. No Worker is configured or deployed
 * for this module. It intentionally has no web app, assets, queue or cron
 * dispatch; every HTTP request goes through the pilot facade. */
type ManagedPilotEnvironment = Env & {
  IOS_MANAGED_PILOT_ENABLED?: string;
  IOS_MANAGED_PILOT_ORIGIN?: string;
  IOS_MANAGED_PILOT_AUDIENCE?: string;
};

// Intentionally empty until an exact staging-only origin has been reviewed,
// its DNS and Worker routes checked, and the release owner approves its use.
// Environment variables alone must not turn an arbitrary origin into a pilot.
const REVIEWED_STAGING_PILOT_ORIGINS: readonly string[] = [];
const RESERVED_OPERATIONS_ORIGINS = new Set([
  'https://ops.ledgetop.app',
  'https://ops.ledgetopdroneservices.com',
  'https://ops.ledgetoptechnologies.com',
  'https://ops-staging.ledgetopdroneservices.com',
]);

/** Pure predicate; the actual Worker always supplies the source-reviewed list. */
export function isReviewedPilotOrigin(origin: string, webOrigin: string, reviewed: readonly string[]): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.origin === origin && parsed.pathname === '/'
      && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
      && !RESERVED_OPERATIONS_ORIGINS.has(origin) && origin !== webOrigin
      && reviewed.includes(origin);
  } catch { return false; }
}

export default {
  fetch(request: Request, env: ManagedPilotEnvironment): Promise<Response> {
    if (env.ENVIRONMENT !== 'staging' || env.IOS_MANAGED_PILOT_ENABLED !== 'true'
      || !env.IOS_MANAGED_PILOT_ORIGIN || !env.IOS_MANAGED_PILOT_AUDIENCE
      || !isReviewedPilotOrigin(env.IOS_MANAGED_PILOT_ORIGIN, env.PUBLIC_BASE_URL, REVIEWED_STAGING_PILOT_ORIGINS)) {
      return Promise.resolve(Response.json({ error: 'Not found', code: 'not_found' }, {
        status: 404, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' },
      }));
    }
    return handleManagedIosPilot(request, env, {
      enabled: env.IOS_MANAGED_PILOT_ENABLED,
      origin: env.IOS_MANAGED_PILOT_ORIGIN ?? '',
      audience: env.IOS_MANAGED_PILOT_AUDIENCE ?? '',
    });
  },
};
