// Offline validation of the machine configuration, with the same rules the server applies at start (no network).
// Bootstrap uses it so a malformed credential is "not ready" BEFORE anything is opened, never a failure afterwards.
// Errors carry codes only, never the configured values.
import { createMachineAuth } from './machine-auth.mjs';
import { createOpsDirectory } from './directory-client.mjs';

export class MachineConfigError extends Error {
  constructor(code) { super(code); this.name = 'MachineConfigError'; this.code = code; }
}

/** Client id -> role(s). One id set for both proxies is accepted for both route families. */
export function machineIdentities(config) {
  const staff = config.ACCESS_STAFF_PROXY_CLIENT_ID, device = config.ACCESS_DEVICE_PROXY_CLIENT_ID;
  return staff === device ? { [staff]: ['staff-proxy', 'device-proxy'] } : { [staff]: 'staff-proxy', [device]: 'device-proxy' };
}

/** Throws MachineConfigError with a code when the machine configuration would not start the server. */
export function validateMachineConfig(config) {
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(String(config.LOGS_INGRESS_HOST ?? '').toLowerCase())) throw new MachineConfigError('ingress_host_invalid');
  // The directory token may be the same Access service token Ops uses to call this host (one token for everything).
  try {
    // Constructing these checks every format rule; neither makes a request (no keys are fetched).
    createMachineAuth({ issuer: config.ACCESS_ISSUER, audience: config.ACCESS_AUDIENCE,
      identities: machineIdentities(config) },
    { getKey: async () => { throw new Error('offline'); } });
    createOpsDirectory({ baseUrl: config.OPS_DIRECTORY_BASE_URL, clientId: config.OPS_DIRECTORY_CLIENT_ID, clientSecret: config.OPS_DIRECTORY_CLIENT_SECRET },
      { fetch: async () => { throw new Error('offline'); } });
  } catch (error) {
    // The constructors throw plain codes (e.g. machine_audience_invalid, directory_client_secret_missing).
    throw new MachineConfigError(/^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'machine_config_invalid');
  }
}
