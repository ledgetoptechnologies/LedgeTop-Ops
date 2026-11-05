import { readPilotRpcForEnvironment } from './ios-pilot-read-rpc';
import { productionPilotConfigured, PRODUCTION_PILOT_ORIGIN,
  type ProductionPilotEnvironment } from './ios-pilot-production-policy';
import type { Env } from './types';

type ProductionReadEnvironment = Env & ProductionPilotEnvironment;
type ReadHandler = Parameters<typeof readPilotRpcForEnvironment>[4];

/** Private only: the unchanged authoritative handler checks current staff,
 * source and record scope. Source metadata is required; no secrets are loaded. */
export async function handleProductionPilotRead(input: unknown, env: ProductionReadEnvironment,
  handler?: ReadHandler): Promise<string> {
  if (!productionPilotConfigured(env) || env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED !== 'true'
    || !env.PROJECT_ALPHA_CONNECTOR_SOURCES?.trim())
    return JSON.stringify({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  return readPilotRpcForEnvironment(input, env, [PRODUCTION_PILOT_ORIGIN], 'production', handler);
}
