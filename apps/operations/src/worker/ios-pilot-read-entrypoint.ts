import { WorkerEntrypoint } from 'cloudflare:workers';
import { readPilotRpc } from './ios-pilot-read-rpc';
import type { Env } from './types';
import { IOS_PILOT_REVIEWED_ORIGINS } from './ios-pilot-reviewed-origins';

// The service binding is limited to the exact reviewed staging host. This class
// is exported by the legacy wrapper and the dedicated private-reader candidate.

/** Private service-binding RPC; it is not an HTTP route. */
export class IosPilotReadService extends WorkerEntrypoint<Env> {
  read(input: string): Promise<string> {
    return readPilotRpc(input, this.env, IOS_PILOT_REVIEWED_ORIGINS);
  }
}
