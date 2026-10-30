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

export default {
  fetch(request: Request, env: ManagedPilotEnvironment): Promise<Response> {
    if (env.ENVIRONMENT !== 'staging' || env.IOS_MANAGED_PILOT_ENABLED !== 'true'
      || !env.IOS_MANAGED_PILOT_ORIGIN || !env.IOS_MANAGED_PILOT_AUDIENCE) {
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
