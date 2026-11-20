#!/usr/bin/env node
// Container entry point (runs as UID 568, never root). First start on the NAS:
//   1. create /app-data/flight-logs and its db/, objects/, config/ folders (0700), and nothing else. The container sees
//      the whole parent mount, but Logs only ever creates or opens this one folder. If the parent is not writable by
//      this user, stop with a clear message: never chmod/chown anything, never touch siblings, no ZFS commands;
//   2. if config/logs.env does not exist, write a blank template ONCE (0600, never overwritten);
//   3. while the settings are missing or invalid, STAY UP CLOSED: every request gets 404 (as an unauthorised one
//      would), the in-container health check answers "unconfigured", and one log line says the settings are
//      incomplete. Nothing is served and authentication is never switched off. A restart, or SIGHUP, rechecks the
//      file. A blank DJI key is NOT incomplete: Logs runs and the decoder waits for the key;
//   4. once the settings are complete, start the Logs server.
// Messages carry codes and paths only, never config values.
import fs from 'node:fs';
import http from 'node:http';
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

# DJI Open API key: paste it here, then restart (or docker kill -s HUP <container>). Blank: decoding waits.
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
    return { ready: false, code: 'config_created', message: `Created ${configFile}. Fill in the settings, then restart the container.` };
  }
  try { validateMachineConfig(loadConfig(configFile, checkOptions)); }
  catch (error) {
    // Codes and key names only: config messages never contain values.
    return { ready: false, code: error?.code ?? 'config_invalid', message: `${configFile} is not ready (${error?.code ?? 'config_invalid'}): ${error?.message ?? 'invalid'}` };
  }
  return { ready: true, code: 'ready', message: 'Configuration is complete.' };
}

/** Filesystem problems: the closed host stays up but reports unhealthy, because only the operator can fix them. */
export const FILESYSTEM_CODES = new Set(['data_dir_unavailable', 'data_dir_unsafe', 'data_dir_not_writable',
  'config_unavailable', 'config_unsafe', 'config_not_writable']);

/**
 * The closed (unconfigured) host: every request on the service port is the same 404 an unauthorised request gets,
 * and the loopback health route says "unconfigured" (200 when only settings are missing, 503 for a filesystem problem).
 */
export async function startClosed(result, { port = 8080, healthPort = 8081, host = '0.0.0.0' } = {}) {
  const healthy = !FILESYSTEM_CODES.has(result.code);
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const closed = http.createServer((req, res) => { req.resume(); reply(res, 404, { error: 'Not found' }); });
  const health = http.createServer((req, res) => {
    req.resume();
    if (req.method !== 'GET' || req.url !== '/healthz') return reply(res, 404, { error: 'Not found' });
    return reply(res, healthy ? 200 : 503, { ok: healthy, state: 'unconfigured', code: result.code });
  });
  await new Promise((resolve, reject) => { closed.once('error', reject); closed.listen(port, host, resolve); });
  await new Promise((resolve, reject) => { health.once('error', reject); health.listen(healthPort, '127.0.0.1', resolve); });
  const close = () => Promise.all([closed, health].map(server => new Promise(resolve => {
    server.close(() => resolve()); server.closeAllConnections?.();
  })));
  return { closed, health, close };
}

const logLine = (event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/** Waits closed until a recheck (SIGHUP) finds complete settings; a stop signal ends the process. */
async function waitUntilConfigured(first, configFile) {
  let result = first;
  let host = await startClosed(result);
  logLine('settings_incomplete', { code: result.code, message: `${result.message} Serving nothing until the settings are complete.` });
  await new Promise(resolve => {
    const stop = () => { host.close().then(() => process.exit(0), () => process.exit(1)); };
    const recheck = async () => {
      const next = bootstrap({ configFile });
      logLine('bootstrap', { code: next.code, message: next.message });
      if (next.ready) {
        for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, stop);
        process.removeListener('SIGHUP', recheck);
        await host.close();
        return resolve();
      }
      if (next.code !== result.code) { await host.close(); result = next; host = await startClosed(result); }
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
    process.on('SIGHUP', recheck);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const configFile = process.env.LOGS_CONFIG_FILE || undefined;
  const result = bootstrap({ configFile });
  logLine('bootstrap', { code: result.code, message: result.message });
  if (!result.ready) await waitUntilConfigured(result, configFile);
  const { start } = await import('./main.mjs');
  start({ configFile }).then(({ stop, reloadKey }) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal).then(() => process.exit(0), () => process.exit(1)));
    process.on('SIGHUP', () => { reloadKey().catch(() => {}); });
  }, error => {
    logLine('startup_failed', { code: error?.code ?? 'error', message: error?.message });
    process.exit(1);
  });
}
