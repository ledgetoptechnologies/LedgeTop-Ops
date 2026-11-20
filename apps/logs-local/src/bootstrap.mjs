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
import { DATA_DIR, DEFAULT_ACCESS_ISSUER, DEFAULT_OPS_DIRECTORY_BASE_URL, REQUIRED_KEYS, SEPARATE_PROFILE_KEYS, effectiveSummary, loadConfig } from './config.mjs';
import { validateMachineConfig } from './machine-config.mjs';

export const NOT_READY_EXIT = 78;

const HEADER = `# Ledge Top flight logs: settings (read by the Logs app itself, not by Docker Compose).
# Keep this file private (0600, owned by the app user). Values are never logged.
# Lines marked REQUIRED must be filled before Logs serves anything. Lines marked "default" may stay blank.
# After editing: restart the container (or: docker kill -s HUP <container>).
`;

/** The settings a fresh install writes, in order, each with its comment. An upgrade only appends missing ones. */
export const TEMPLATE_ENTRIES = Object.freeze([
  ['LOGS_INGRESS_HOST', '# REQUIRED. The private Tunnel hostname this backend serves (other Host headers get 404).'],
  ['ACCESS_AUDIENCE', '# REQUIRED. The AUD tag of the Cloudflare Access application protecting this backend.'],
  ['ACCESS_TOKEN_PROFILE', '# REQUIRED CHOICE. "single" = ONE Access service token for everything (the two lines below are also the\n# token Ops and the device proxy use to call this host). Blank or "separate" = separate tokens: then both\n# ACCESS_*_PROXY_CLIENT_ID lines further down are REQUIRED and must differ from the directory token.'],
  ['OPS_DIRECTORY_CLIENT_ID', '# REQUIRED. The Cloudflare Access service token this host uses to call the Ops directory: client id.'],
  ['OPS_DIRECTORY_CLIENT_SECRET', '# REQUIRED. That token\'s client secret.'],
  ['ACCESS_STAFF_PROXY_CLIENT_ID', '# REQUIRED only when ACCESS_TOKEN_PROFILE is separate: client id of the token Ops uses to call this host.'],
  ['ACCESS_DEVICE_PROXY_CLIENT_ID', '# REQUIRED only when ACCESS_TOKEN_PROFILE is separate: client id of the device-proxy token.'],
  ['ACCESS_ISSUER', `# Default when blank: ${DEFAULT_ACCESS_ISSUER}`],
  ['OPS_DIRECTORY_BASE_URL', `# Default when blank: ${DEFAULT_OPS_DIRECTORY_BASE_URL} (production). Staging MUST set its own Ops origin here.`],
  ['DJI_API_KEY', '# DJI Open API key: paste it here, then restart (or docker kill -s HUP <container>). Blank: decoding waits.'],
].map(([key, comment]) => Object.freeze({ key, comment })));

export const TEMPLATE = HEADER + TEMPLATE_ENTRIES.map(({ key, comment }) => `\n${comment}\n${key}=\n`).join('');

/** Keys set (blank or not) on uncommented lines. Values are not read. */
function presentKeys(text) {
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(raw);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * Upgrade of an existing settings file: ONLY appends the template keys it lacks (blank, with their comments). Every
 * existing byte stays exactly as it was and in place (values, order, comments, line endings). The new file is written
 * beside it with the same mode, flushed, then renamed over it, so a failure at any point leaves the original intact.
 * It never runs for a file owned by another user. Returns { code, added } with key names only, never values.
 */
export function upgradeConfigFile(configFile, { uid = process.getuid?.(), fsImpl = fs } = {}) {
  const stat = fsImpl.lstatSync(configFile);
  if (!stat.isFile()) return { code: 'config_upgrade_skipped', added: [] };
  if (uid !== undefined && stat.uid !== uid) return { code: 'config_upgrade_skipped', added: [] };
  const original = fsImpl.readFileSync(configFile);
  const text = original.toString('utf8');
  const present = presentKeys(text);
  const missing = TEMPLATE_ENTRIES.filter(({ key }) => !present.has(key));
  if (!missing.length) return { code: 'config_current', added: [] };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = [text.length && !text.endsWith('\n') ? eol : '', eol,
    `# Added by a Logs upgrade: settings this version knows about. Existing lines above are unchanged.${eol}`,
    ...missing.map(({ key, comment }) => `${comment.replace(/\n/g, eol)}${eol}${key}=${eol}`)].join('');
  const temp = path.join(path.dirname(configFile), `.${path.basename(configFile)}.upgrade-${process.pid}`);
  let fd;
  try {
    fd = fsImpl.openSync(temp, 'wx', stat.mode & 0o777);
    fsImpl.writeSync(fd, original);
    fsImpl.writeSync(fd, Buffer.from(block, 'utf8'));
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = undefined;
    fsImpl.chmodSync(temp, stat.mode & 0o777);
    fsImpl.renameSync(temp, configFile);
    try { const dir = fsImpl.openSync(path.dirname(configFile), 'r'); try { fsImpl.fsyncSync(dir); } finally { fsImpl.closeSync(dir); } } catch { /* best effort */ }
    return { code: 'config_upgraded', added: missing.map(({ key }) => key) };
  } catch (error) {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    try { fsImpl.unlinkSync(temp); } catch { /* ignore */ }
    return { code: 'config_upgrade_failed', added: [], error: safeCode(error) };
  }
}

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
    return { ready: false, code: 'config_created', message: `Created ${configFile}. Fill in the REQUIRED settings, then restart the container.`,
      missing: [...REQUIRED_KEYS, ...SEPARATE_PROFILE_KEYS],
      effective: { directoryOrigin: new URL(DEFAULT_OPS_DIRECTORY_BASE_URL).origin, tokenProfile: 'separate' } };
  }
  // Existing file: only ever append keys it lacks (never touch a value). A failed upgrade leaves it as it was.
  const upgrade = upgradeConfigFile(configFile);
  if (upgrade.code === 'config_upgraded' || upgrade.code === 'config_upgrade_failed')
    console.log(JSON.stringify({ at: new Date().toISOString(), event: upgrade.code, added: upgrade.added, ...(upgrade.error ? { error: upgrade.error } : {}) }));
  let loaded;
  try { loaded = loadConfig(configFile, checkOptions); validateMachineConfig(loaded); }
  catch (error) {
    const effective = error?.effective ?? (loaded ? effectiveSummary(loaded) : null);
    // Codes and key names only: config messages never contain values.
    return { ready: false, code: error?.code ?? 'config_invalid', message: `${configFile} is not ready (${error?.code ?? 'config_invalid'}): ${error?.message ?? 'invalid'}`,
      ...(Array.isArray(error?.missing) ? { missing: [...error.missing] } : {}), ...(effective ? { effective: { ...effective } } : {}) };
  }
  return { ready: true, code: 'ready', message: 'Configuration is complete.', effective: effectiveSummary(loaded) };
}

/** Filesystem problems: the closed host stays up but reports unhealthy, because only the operator can fix them. */
export const FILESYSTEM_CODES = new Set(['data_dir_unavailable', 'data_dir_unsafe', 'data_dir_not_writable',
  'config_unavailable', 'config_unsafe', 'config_not_writable']);

/**
 * The closed (unconfigured) host: every request on the service port is the same 404 an unauthorised request gets.
 * Loopback health: /healthz says the process is up but unconfigured (200 when only settings are missing, 503 for a
 * filesystem problem); /readyz is always 503 here, so "closed" is never mistaken for "configured and serving".
 * The listeners stay bound for the whole closed period; a recheck only updates the reported result (setResult).
 */
export async function startClosed(first, { port = 8080, healthPort = 8081, host = '0.0.0.0' } = {}) {
  let result = first;
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const closed = http.createServer((req, res) => { req.resume(); reply(res, 404, { error: 'Not found' }); });
  const health = http.createServer((req, res) => {
    req.resume();
    const healthy = !FILESYSTEM_CODES.has(result.code);
    const body = { ok: healthy, configured: false, state: 'unconfigured', code: result.code, ...(result.missing ? { missing: result.missing } : {}), ...(result.effective ? { effective: result.effective } : {}) };
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, healthy ? 200 : 503, body);
    if (req.method === 'GET' && req.url === '/readyz') return reply(res, 503, { ...body, ok: false });
    return reply(res, 404, { error: 'Not found' });
  });
  await new Promise((resolve, reject) => { closed.once('error', reject); closed.listen(port, host, resolve); });
  await new Promise((resolve, reject) => { health.once('error', reject); health.listen(healthPort, '127.0.0.1', resolve); });
  let closing = null;
  const close = () => closing ??= Promise.all([closed, health].map(server => new Promise(resolve => {
    server.close(() => resolve()); server.closeAllConnections?.();
  })));
  return { closed, health, close, setResult: next => { result = next; }, get result() { return result; } };
}

const logLine = (event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/**
 * Stays closed until a recheck finds complete settings, then closes the closed listeners (once) and resolves, so the
 * real server can bind the same ports. Rechecks (SIGHUP) are serialised and coalesced: any number of signals run at
 * most one check at a time, never rebind a listener, and resolve exactly once. A stop signal exits.
 */
export async function waitUntilConfigured(first, { recheck, signals = process, exit = code => process.exit(code), log = logLine, ...listen }) {
  const closedHost = await startClosed(first, listen);
  log('settings_incomplete', { code: first.code, ...(first.missing ? { missing: first.missing } : {}), ...(first.effective ? { effective: first.effective } : {}), message: `${first.message} Serving nothing until the settings are complete.` });
  await new Promise(resolve => {
    let running = false, again = false, done = false;
    const stop = () => { closedHost.close().then(() => exit(0), () => exit(1)); };
    const onHup = () => {
      if (done) return;
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const next = recheck();
          log('bootstrap', { code: next.code, message: next.message });
          if (next.ready) {
            done = true;
            for (const signal of ['SIGTERM', 'SIGINT']) signals.removeListener(signal, stop);
            signals.removeListener('SIGHUP', onHup);
            closedHost.close().then(resolve);
            return;
          }
          closedHost.setResult(next);
        } while (again);
      } finally { running = false; }
    };
    for (const signal of ['SIGTERM', 'SIGINT']) signals.on(signal, stop);
    signals.on('SIGHUP', onHup);
  });
  return closedHost;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const configFile = process.env.LOGS_CONFIG_FILE || undefined;
  const result = bootstrap({ configFile });
  logLine('bootstrap', { code: result.code, message: result.message, ...(result.effective ? { effective: result.effective } : {}) });
  // Hold SIGHUP (whose default action would end the process) until the started host installs its own handler.
  const holdHup = () => {};
  process.on('SIGHUP', holdHup);
  if (!result.ready) await waitUntilConfigured(result, { recheck: () => bootstrap({ configFile }) });
  const { start } = await import('./main.mjs');
  start({ configFile }).then(({ stop, reloadKey }) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal).then(() => process.exit(0), () => process.exit(1)));
    process.on('SIGHUP', () => { reloadKey().catch(() => {}); });
    process.removeListener('SIGHUP', holdHup);
  }, error => {
    logLine('startup_failed', { code: error?.code ?? 'error', message: error?.message });
    process.exit(1);
  });
}
