import { WorkerEntrypoint } from 'cloudflare:workers';
import { readPilotRpc } from './ios-pilot-read-rpc';
import type { Env } from './types';

// The service binding is limited to the exact staging host. This class is
// exported only by the staging pilot wrapper and has no public HTTP route.
const REVIEWED_RPC_ORIGINS: readonly string[] = ['https://ios-pilot-staging.ledgetop.app'];

/** Private service-binding RPC; it is not an HTTP route. */
export class IosPilotReadService extends WorkerEntrypoint<Env> {
  read(input: string): Promise<string> {
    return readPilotRpc(input, this.env, REVIEWED_RPC_ORIGINS);
  }
}
