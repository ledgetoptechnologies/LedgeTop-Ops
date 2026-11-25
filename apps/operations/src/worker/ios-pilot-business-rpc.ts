import { readPilotRpc } from './ios-pilot-read-rpc';
import { handleManagedIosPilotBusiness, type PilotBusinessEnvironment } from './ios-pilot-business-routes';

/** Reuse the bounded exact {url,assertion} envelope and response reader. The
 * separate handler independently validates the pilot assertion and current
 * staff/source/root permissions. A normal staff cookie is never accepted. */
export async function readPilotBusinessRpc(input: unknown, env: PilotBusinessEnvironment,
  reviewedOrigins: readonly string[]): Promise<string> {
  if (env.IOS_PILOT_BUSINESS_ENABLED !== 'true')
    return JSON.stringify({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  return readPilotRpc(input, env, reviewedOrigins, handleManagedIosPilotBusiness);
}
