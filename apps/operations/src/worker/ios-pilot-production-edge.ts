import { handlePilotEdgeForEnvironment, type AccessContext } from './ios-pilot-edge-bridge';
import { productionPilotConfigured, PRODUCTION_PILOT_ORIGIN,
  type ProductionPilotEnvironment } from './ios-pilot-production-policy';

/** Dedicated production ingress only: no business/database/credential bindings.
 * No synthetic diagnostic is exposed, even if probe flags are accidentally set. */
export default {
  fetch(request: Request, env: ProductionPilotEnvironment, ctx?: { access?: AccessContext }): Promise<Response> {
    if (!productionPilotConfigured(env)) return Promise.resolve(Response.json({ error: 'Not found', code: 'not_found' }, {
      status: 404, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' },
    }));
    return handlePilotEdgeForEnvironment(request, env, [PRODUCTION_PILOT_ORIGIN], 'production', ctx?.access, false);
  },
};
