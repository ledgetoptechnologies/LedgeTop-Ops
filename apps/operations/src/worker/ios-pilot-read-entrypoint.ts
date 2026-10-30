import { WorkerEntrypoint } from 'cloudflare:workers';
import { readPilotRpc } from './ios-pilot-read-rpc';
import type { Env } from './types';

// This source-controlled list is intentionally empty. Adding an exact staging
// origin requires separate review, and this class is not exported or deployed.
const REVIEWED_RPC_ORIGINS: readonly string[] = [];

/** Private service-binding RPC; it is not an HTTP route. */
export class IosPilotReadService extends WorkerEntrypoint<Env> {
  read(input: string): Promise<string> {
    return readPilotRpc(input, this.env, REVIEWED_RPC_ORIGINS);
  }
}
