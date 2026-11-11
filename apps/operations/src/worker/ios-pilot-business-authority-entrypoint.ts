import { WorkerEntrypoint } from 'cloudflare:workers';
import { readPilotBusinessAuthority } from './ios-pilot-business-authority';
import type { Env } from './types';

/** Named, read-only service binding. It has no fetch or generic dispatch. */
export class IosPilotBusinessAuthority extends WorkerEntrypoint<Env & { IOS_PILOT_BUSINESS_AUTHORITY_ENABLED?: string }> {
  async read(input: string): Promise<string> {
    return readPilotBusinessAuthority(input, this.env);
  }
}
