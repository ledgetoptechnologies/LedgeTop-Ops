#!/usr/bin/env node
// Container entry point (runs as UID 568, never root). First start on the NAS:
//   1. create /data/flight-logs and its db/, objects/, config/ folders (0700), and nothing else. The container sees
//      the whole parent mount, but Logs only ever creates or opens this one folder. If the parent is not writable by
//      this user, stop with a clear message: never chmod/chown anything, never touch siblings, no ZFS commands;
//   2. if config/logs.env does not exist, write a blank template ONCE (0600, never overwritten) and stop as
//      not-ready, so the machine credentials can be filled in;
//   3. if the machine credentials are missing or invalid, stop as not-ready (exit 78). Authentication is never
//      switched off. A blank DJI key is NOT a reason to stop: Logs runs and the decoder waits for the key;
//   4. otherwise start the Logs server.
// Messages carry codes and paths only, never config values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadConfig } from './config.mjs';

export const NOT_READY_EXIT = 78;

export const TEMPLATE = `# Ledge Top flight logs: app configuration (read by the Logs app itself, not by Docker Compose).
# Keep this file private (0600, owned by the app user). Values are never logged.
# After editing: restart the container. A new DJI key alone can also be applied with: docker kill -s HUP <container>

# The private Tunnel hostname this backend serves (other Host headers get 404).
LOGS_INGRESS_HOST=

# Cloudflare Access app protecting this backend, and the two service tokens allowed to call it.
ACCESS_ISSUER=https://ledgetoptechnologies.cloudflareaccess.com
ACCESS_AUDIENCE=
ACCESS_STAFF_PROXY_CLIENT_ID=
ACCESS_DEVICE_PROXY_CLIENT_ID=

# Ops directory (pilot and staff lookups), with this host's own Access service token for it.
OPS_DIRECTORY_BASE_URL=
OPS_DIRECTORY_CLIENT_ID=
OPS_DIRECTORY_CLIENT_SECRET=

# DJI Open API key. May stay blank: uploads and history work, and decoding waits until a key is entered.
DJI_API_KEY=

# Optional: key for sealing imported DJI keychains (base64, 32 bytes). Blank disables keychain import.
KEYCHAIN_ENCRYPTION_KEY=
`;

const SUBDIRS = ['db', 'objects', 'config'];

/**
 * @returns {{ ready: boolean, code: string, message: string }}
 */
export function bootstrap({ dataDir = DATA_DIR, configFile = path.join(dataDir, 'config', 'logs.env'), checkOptions } = {}) {
  for (const dir of [dataDir, ...SUBDIRS.map(name => path.join(dataDir, name))]) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST' && fs.statSync(dir).isDirectory()) continue;
      return { ready: false, code: 'data_dir_not_writable',
        message: `Cannot create ${dir} (${error.code}). Give the app user (UID 568) write access to the parent folder; Logs never changes permissions itself.` };
    }
  }
  if (!fs.existsSync(configFile)) {
    try { fs.writeFileSync(configFile, TEMPLATE, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') return { ready: false, code: 'config_not_writable', message: `Cannot write ${configFile} (${error.code}).` };
    }
    return { ready: false, code: 'config_created', message: `Created ${configFile}. Fill in the machine credentials, then restart.` };
  }
  try { loadConfig(configFile, checkOptions); }
  catch (error) {
    return { ready: false, code: error?.code ?? 'config_invalid', message: `${configFile} is not ready: ${error?.message ?? 'invalid'}` };
  }
  return { ready: true, code: 'ready', message: 'Configuration is complete.' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = bootstrap({ configFile: process.env.LOGS_CONFIG_FILE || undefined });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'bootstrap', code: result.code, message: result.message }));
  if (!result.ready) process.exit(NOT_READY_EXIT);
  const { start } = await import('./main.mjs');
  start({ configFile: process.env.LOGS_CONFIG_FILE || undefined }).then(({ stop, reloadKey }) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal).then(() => process.exit(0), () => process.exit(1)));
    process.on('SIGHUP', () => { reloadKey(); });
  }, error => {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'startup_failed', code: error?.code ?? 'error', message: error?.message }));
    process.exit(1);
  });
}
