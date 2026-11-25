import { WorkerEntrypoint } from 'cloudflare:workers';
import { readPilotBusinessRpc } from './ios-pilot-business-rpc';
import type { PilotBusinessEnvironment } from './ios-pilot-business-routes';

// Intentionally unprovisioned. Merger must independently review the current
// staging account/resources/source/admission before proposing a source pin and
// binding rollout. Environment values cannot populate this allowlist.
const REVIEWED_BUSINESS_RPC_ORIGINS: readonly string[] = [];

export class IosPilotBusinessReadService extends WorkerEntrypoint<PilotBusinessEnvironment> {
  read(input: string): Promise<string> {
    return readPilotBusinessRpc(input, this.env, REVIEWED_BUSINESS_RPC_ORIGINS);
  }
}
