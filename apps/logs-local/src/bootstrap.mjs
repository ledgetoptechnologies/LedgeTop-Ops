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
import { validateMachineConfig } from './machine-config.mjs';

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
export function bootstrap(options = {}) {
  // Error boundary: any unexpected filesystem failure (a file where a parent folder should be, a permission error,
  // a vanished path) stops as not-ready with its error code only. Never a crash, never a fallback.
  try { return bootstrapSteps(options); }
  catch (error) {
    return { ready: false, code: 'data_dir_unavailable',
      message: `Cannot check the Logs data folder (${safeCode(error)}). Logs only writes inside its own folder and changes no permissions.` };
  }
}

const safeCode = error => (typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'error');

/** lstat without following links; a missing path is undefined, any other failure is reported, not thrown. */
function lstatOrError(target) {
  try { return { stat: fs.lstatSync(target, { throwIfNoEntry: false }) }; }
  catch (error) { return { error }; }
}

function bootstrapSteps({ dataDir = DATA_DIR, configFile = path.join(dataDir, 'config', 'logs.env'), checkOptions } = {}) {
  const unavailable = (target, error) => ({ ready: false, code: 'data_dir_unavailable',
    message: `Cannot check ${target} (${safeCode(error)}). Give the app user (UID 568) access to the parent folder; Logs never changes permissions itself.` });
  const unsafe = what => ({ ready: false, code: 'data_dir_unsafe',
    message: `${what} must be a real folder (not a link). Logs only writes inside its own folder and will not follow links.` });
  for (const dir of [dataDir, ...SUBDIRS.map(name => path.join(dataDir, name))]) {
    // lstat, never stat: a link (to a sibling folder or anywhere else) is refused, never followed.
    const { stat: existing, error } = lstatOrError(dir);
    if (error) return unavailable(dir, error);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) return unsafe(dir);
      continue;
    }
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (error) {
      return { ready: false, code: 'data_dir_not_writable',
        message: `Cannot create ${dir} (${safeCode(error)}). Give the app user (UID 568) write access to the parent folder; Logs never changes permissions itself.` };
    }
  }
  // The folder must really be the child of its parent (no link anywhere below the mount point).
  try {
    if (fs.realpathSync(dataDir) !== path.join(fs.realpathSync(path.dirname(dataDir)), path.basename(dataDir))) return unsafe(dataDir);
  } catch { return unsafe(dataDir); }
  const { stat: configStat, error: configError } = lstatOrError(configFile);
  if (configError) return { ready: false, code: 'config_unavailable', message: `Cannot check ${configFile} (${safeCode(configError)}).` };
  if (configStat && (configStat.isSymbolicLink() || !configStat.isFile()))
    return { ready: false, code: 'config_unsafe', message: `${configFile} must be a regular file (not a link).` };
  if (!configStat) {
    try { fs.writeFileSync(configFile, TEMPLATE, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') return { ready: false, code: 'config_not_writable', message: `Cannot write ${configFile} (${safeCode(error)}).` };
    }
    return { ready: false, code: 'config_created', message: `Created ${configFile}. Fill in the machine credentials, then restart.` };
  }
  try { validateMachineConfig(loadConfig(configFile, checkOptions)); }
  catch (error) {
    // Codes and key names only: config messages never contain values.
    return { ready: false, code: error?.code ?? 'config_invalid', message: `${configFile} is not ready (${error?.code ?? 'config_invalid'}): ${error?.message ?? 'invalid'}` };
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
    process.on('SIGHUP', () => { reloadKey().catch(() => {}); });
  }, error => {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'startup_failed', code: error?.code ?? 'error', message: error?.message }));
    process.exit(1);
  });
}
