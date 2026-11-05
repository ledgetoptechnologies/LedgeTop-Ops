import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleProductionPilotRead } from './ios-pilot-production-read';
import type { Env } from './types';

/** This class is separate from the staging service and never exports the
 * general Operations handler, workflows, or a public business HTTP route. */
export class IosPilotProductionReadService extends WorkerEntrypoint<Env & {
  IOS_PRODUCTION_READ_PILOT_ENABLED?: string;
}> {
  read(input: string): Promise<string> {
    return handleProductionPilotRead(input, this.env);
  }
}

export default {
  fetch(): Promise<Response> {
    return Promise.resolve(Response.json({ error: 'Not found', code: 'not_found' }, {
      status: 404, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' },
    }));
  },
};
