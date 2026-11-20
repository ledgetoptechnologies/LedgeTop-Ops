// App-owned configuration for the local Logs host. It is a KEY=VALUE file that THIS process reads at start
// (default /app-data/flight-logs/config/logs.env). It is deliberately not a Compose .env file: Compose would
// interpolate it into the container environment before start, where `docker inspect` shows every value.
//
// Rules:
//   - only known keys; an unknown key is a startup error (catches typos in secret names);
//   - no interpolation, no command substitution, no multi-line values; optional surrounding "..." or '...';
//   - on Linux the file must be owned by this process's user and not readable by group or others (0600);
//   - machine credentials are required: a blank or missing one stops startup, it never disables auth. A blank line
//     with a built-in default (ACCESS_ISSUER, OPS_DIRECTORY_BASE_URL, ports...) uses the default;
//   - token profile, chosen explicitly by the operator (ACCESS_TOKEN_PROFILE):
//       separate (the default, also when the line is blank or absent): ACCESS_STAFF_PROXY_CLIENT_ID and
//         ACCESS_DEVICE_PROXY_CLIENT_ID are both required, distinct, and different from the directory token. This is
//         exactly the scope earlier versions enforced, so an upgraded file keeps its effective scope;
//       single: ONE Access service token for everything. OPS_DIRECTORY_CLIENT_ID is also the id accepted from Ops on
//         the staff and device routes; the proxy id lines must then be blank or equal to it.
//     Blank lines never widen scope on their own;
//   - DJI_API_KEY may be blank (keyless first boot: uploads and history work, decoding waits for the key);
//   - values are never logged; describe() reports which optional values are present, nothing more.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = '/app-data/flight-logs/config/logs.env';
/** The only data directory Logs ever uses. The container may see a wider parent mount; Logs never leaves this. */
export const DATA_DIR = '/app-data/flight-logs';
/** The pilot profile mounted the same host folder at /data; a pilot config naming it is read as the new path. */
export const LEGACY_DATA_DIR = '/data/flight-logs';
/** Built-in defaults for lines that may stay blank (public values; overridable in the file). */
export const DEFAULT_ACCESS_ISSUER = 'https://ledgetoptechnologies.cloudflareaccess.com';
export const DEFAULT_OPS_DIRECTORY_BASE_URL = 'https://ops.ledgetop.app/';
/** The settings that must be filled before Logs serves anything (one proxy client id counts for both). */
export const TOKEN_PROFILES = Object.freeze(['separate', 'single']);
/** Required in every profile. The separate profile (the default) also requires both proxy ids. */
export const REQUIRED_KEYS = Object.freeze(['LOGS_INGRESS_HOST', 'ACCESS_AUDIENCE', 'OPS_DIRECTORY_CLIENT_ID', 'OPS_DIRECTORY_CLIENT_SECRET']);
export const SEPARATE_PROFILE_KEYS = Object.freeze(['ACCESS_STAFF_PROXY_CLIENT_ID', 'ACCESS_DEVICE_PROXY_CLIENT_ID']);

const SPEC = Object.freeze({
  LOGS_DATA_DIR: { default: DATA_DIR },
  LOGS_PORT: { default: '8080' },
  LOGS_HEALTH_PORT: { default: '8081' },
  LOGS_INGRESS_HOST: { required: true },
  ACCESS_ISSUER: { default: DEFAULT_ACCESS_ISSUER },
  ACCESS_AUDIENCE: { required: true },
  ACCESS_TOKEN_PROFILE: { default: 'separate' },
  ACCESS_STAFF_PROXY_CLIENT_ID: { proxyId: true },
  ACCESS_DEVICE_PROXY_CLIENT_ID: { proxyId: true },
  OPS_DIRECTORY_BASE_URL: { default: DEFAULT_OPS_DIRECTORY_BASE_URL },
  OPS_DIRECTORY_CLIENT_ID: { required: true },
  OPS_DIRECTORY_CLIENT_SECRET: { required: true, secret: true },
  DJI_API_KEY: { blankAllowed: true, secret: true },
  KEYCHAIN_ENCRYPTION_KEY: { blankAllowed: true, secret: true },
  UPLOAD_CONCURRENCY: { default: '4' },
  DECODER_WORK_DIR: { default: '/work' },
  DJI_DECODE_BIN: { default: '/usr/local/bin/ltds-dji-decode' },
});

export class ConfigError extends Error {
  constructor(code, message, missing, effective) {
    super(message); this.name = 'ConfigError'; this.code = code;
    if (missing) this.missing = missing;
    if (effective) this.effective = effective;
  }
}

/** Parses KEY=VALUE text. Throws on anything it does not understand; never echoes a value in an error. */
export function parseConfig(text, { allowDataDir = false } = {}) {
  const values = new Map();
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new ConfigError('config_syntax', `Config line ${index + 1} is not KEY=VALUE.`);
    const [, key, rawValue] = match;
    if (!Object.hasOwn(SPEC, key)) throw new ConfigError('config_unknown_key', `Unknown config key ${key} (line ${index + 1}).`);
    if (values.has(key)) throw new ConfigError('config_duplicate_key', `Config key ${key} is set twice.`);
    let value = rawValue.trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1];
    if (/[\0\r\n]/.test(value) || /\$\(|`/.test(value)) throw new ConfigError('config_value', `Config key ${key} has an unsupported value.`);
    values.set(key, value);
  });
  const config = {};
  const missing = [];
  for (const [key, spec] of Object.entries(SPEC)) {
    // A blank line means "not set": the built-in default applies where there is one.
    const value = values.get(key) || spec.default || '';
    if (spec.required && !value) missing.push(key);
    config[key] = value;
  }
  // Non-secret facts an operator must be able to check before anything starts (shown in the closed/ready reports).
  const effective = effectiveSummary(config);
  if (!TOKEN_PROFILES.includes(config.ACCESS_TOKEN_PROFILE))
    throw new ConfigError('config_value', `ACCESS_TOKEN_PROFILE must be one of: ${TOKEN_PROFILES.join(', ')}.`, undefined, effective);
  if (config.ACCESS_TOKEN_PROFILE === 'separate') {
    for (const key of SEPARATE_PROFILE_KEYS) if (!config[key]) missing.push(key);
  } else {
    // single: the operator chose one token for everything; any proxy line that is set must name that same token.
    for (const key of SEPARATE_PROFILE_KEYS)
      if (config[key] && config.OPS_DIRECTORY_CLIENT_ID && config[key] !== config.OPS_DIRECTORY_CLIENT_ID)
        throw new ConfigError('config_value', `With ACCESS_TOKEN_PROFILE=single, ${key} must be blank or equal OPS_DIRECTORY_CLIENT_ID.`, undefined, effective);
    config.ACCESS_STAFF_PROXY_CLIENT_ID = config.OPS_DIRECTORY_CLIENT_ID;
    config.ACCESS_DEVICE_PROXY_CLIENT_ID = config.OPS_DIRECTORY_CLIENT_ID;
  }
  const order = [...REQUIRED_KEYS, ...SEPARATE_PROFILE_KEYS];
  missing.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  // Key names only, never values.
  if (missing.length) throw new ConfigError('config_missing', `Required settings still blank: ${missing.join(', ')}.`, missing, effective);
  if (config.LOGS_DATA_DIR === LEGACY_DATA_DIR && !allowDataDir) config.LOGS_DATA_DIR = DATA_DIR;
  if (config.LOGS_DATA_DIR !== DATA_DIR && !allowDataDir) throw new ConfigError('config_value', `LOGS_DATA_DIR must be ${DATA_DIR}.`);
  // Decoder scratch must be the RAM tmpfs mounted at /work (raw logs and the key copy never go to disk).
  if (config.DECODER_WORK_DIR !== '/work') throw new ConfigError('config_value', 'DECODER_WORK_DIR must be /work (the RAM tmpfs).');
  for (const key of ['LOGS_DATA_DIR', 'DECODER_WORK_DIR', 'DJI_DECODE_BIN'])
    if (!path.isAbsolute(config[key])) throw new ConfigError('config_value', `${key} must be an absolute path.`);
  for (const key of ['LOGS_PORT', 'LOGS_HEALTH_PORT', 'UPLOAD_CONCURRENCY']) {
    const number = Number(config[key]);
    if (!Number.isSafeInteger(number) || number < (key === 'UPLOAD_CONCURRENCY' ? 1 : 1) || number > 65535)
      throw new ConfigError('config_value', `Config key ${key} must be a positive integer.`);
    config[key] = number;
  }
  if (config.UPLOAD_CONCURRENCY > 16) throw new ConfigError('config_value', 'UPLOAD_CONCURRENCY must be 16 or less.');
  if (config.LOGS_PORT === config.LOGS_HEALTH_PORT) throw new ConfigError('config_value', 'LOGS_PORT and LOGS_HEALTH_PORT must differ.');
  return Object.freeze(config);
}

/** Refuses a config file another user could read or replace (Linux; Windows has no POSIX modes). */
export function checkConfigFile(file, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new ConfigError('config_file', 'The config path is not a regular file.');
  if (platform === 'win32') return;
  if (stat.uid !== uid) throw new ConfigError('config_permissions', 'The config file must be owned by the user running Logs.');
  if (stat.mode & 0o077) throw new ConfigError('config_permissions', 'The config file must not be readable by group or others (chmod 600).');
}

export function loadConfig(file = process.env.LOGS_CONFIG_FILE || DEFAULT_CONFIG_FILE, options) {
  checkConfigFile(file, options);
  return parseConfig(fs.readFileSync(file, 'utf8'));
}

/** Non-secret effective settings: the directory ORIGIN only (no path, credentials or query) and the token profile. */
export function effectiveSummary(config) {
  let directoryOrigin = 'invalid';
  try { directoryOrigin = new URL(config.OPS_DIRECTORY_BASE_URL).origin; } catch { /* reported as invalid */ }
  return { directoryOrigin, tokenProfile: config.ACCESS_TOKEN_PROFILE || 'separate' };
}

/** Safe to log: which optional capabilities are configured, the directory origin and the token profile. Never a secret. */
export function describe(config) {
  return { djiKey: Boolean(config.DJI_API_KEY), keychainKey: Boolean(config.KEYCHAIN_ENCRYPTION_KEY), uploadConcurrency: config.UPLOAD_CONCURRENCY,
    ...effectiveSummary(config) };
}
