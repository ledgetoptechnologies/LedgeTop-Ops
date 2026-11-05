import type { EdgeEnvironment } from './ios-pilot-edge-bridge';

// Candidate source pin only. DNS, Access application and production data
// binding require separate release review; this source does not provision them.
export const PRODUCTION_PILOT_ORIGIN = 'https://ios-pilot.ledgetop.app';
const STAGING_PILOT_AUDIENCE = 'e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d';
export type ProductionPilotEnvironment = EdgeEnvironment & {
  IOS_PRODUCTION_READ_PILOT_ENABLED?: string;
};

/** A staging flag or audience can never activate the production entrypoints. */
export function productionPilotConfigured(env: ProductionPilotEnvironment): boolean {
  return env.ENVIRONMENT === 'production'
    && env.IOS_PRODUCTION_READ_PILOT_ENABLED === 'true'
    && env.IOS_MANAGED_PILOT_ENABLED === 'true'
    && env.IOS_MANAGED_PILOT_ORIGIN === PRODUCTION_PILOT_ORIGIN
    && typeof env.IOS_MANAGED_PILOT_AUDIENCE === 'string'
    && env.IOS_MANAGED_PILOT_AUDIENCE.length > 0
    && env.IOS_MANAGED_PILOT_AUDIENCE !== STAGING_PILOT_AUDIENCE
    && env.IOS_MANAGED_PILOT_AUDIENCE !== env.OPERATIONS_AUD;
}
