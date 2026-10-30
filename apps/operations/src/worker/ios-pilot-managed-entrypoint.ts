import type { Env } from './types';

/** Retired direct HTTP entrypoint. Business reads must pass through the
 * Access-context-checking edge and private service binding instead. */
type ManagedPilotEnvironment = Env & {
  IOS_MANAGED_PILOT_ENABLED?: string;
  IOS_MANAGED_PILOT_ORIGIN?: string;
  IOS_MANAGED_PILOT_AUDIENCE?: string;
};

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
  fetch(_request: Request, _env: ManagedPilotEnvironment): Promise<Response> {
    return Promise.resolve(Response.json({ error: 'Not found', code: 'not_found' }, {
      status: 404, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' },
    }));
  },
};
