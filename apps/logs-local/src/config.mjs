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
//   - ONE Access service token is enough: OPS_DIRECTORY_CLIENT_ID / _SECRET is the token this host uses to call the
//     Ops directory, and when both proxy ids are blank the same client id is the one accepted from Ops on the staff
//     and device routes. If only one proxy id is set, it is accepted for both route families. Two ids still work;
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
export const REQUIRED_KEYS = Object.freeze(['LOGS_INGRESS_HOST', 'ACCESS_AUDIENCE', 'OPS_DIRECTORY_CLIENT_ID', 'OPS_DIRECTORY_CLIENT_SECRET']);

const SPEC = Object.freeze({
  LOGS_DATA_DIR: { default: DATA_DIR },
  LOGS_PORT: { default: '8080' },
  LOGS_HEALTH_PORT: { default: '8081' },
  LOGS_INGRESS_HOST: { required: true },
  ACCESS_ISSUER: { default: DEFAULT_ACCESS_ISSUER },
  ACCESS_AUDIENCE: { required: true },
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
  constructor(code, message, missing) { super(message); this.name = 'ConfigError'; this.code = code; if (missing) this.missing = missing; }
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
  // One token for everything: blank proxy ids fall back to the other proxy id, then to the directory token's id.
  // Two distinct proxy ids keep working as before.
  config.ACCESS_STAFF_PROXY_CLIENT_ID ||= config.ACCESS_DEVICE_PROXY_CLIENT_ID || config.OPS_DIRECTORY_CLIENT_ID;
  config.ACCESS_DEVICE_PROXY_CLIENT_ID ||= config.ACCESS_STAFF_PROXY_CLIENT_ID;
  // Key names only, never values.
  if (missing.length) throw new ConfigError('config_missing', `Required settings still blank: ${missing.join(', ')}.`, missing);
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

/** Safe to log: which optional capabilities are configured. Never a value. */
export function describe(config) {
  return { djiKey: Boolean(config.DJI_API_KEY), keychainKey: Boolean(config.KEYCHAIN_ENCRYPTION_KEY), uploadConcurrency: config.UPLOAD_CONCURRENCY };
}
