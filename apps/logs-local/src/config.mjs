// App-owned configuration for the local Logs host. It is a KEY=VALUE file that THIS process reads at start
// (default /data/flight-logs/config/logs.env). It is deliberately not a Compose .env file: Compose would
// interpolate it into the container environment before start, where `docker inspect` shows every value.
//
// Rules:
//   - only known keys; an unknown key is a startup error (catches typos in secret names);
//   - no interpolation, no command substitution, no multi-line values; optional surrounding "..." or '...';
//   - on Linux the file must be owned by this process's user and not readable by group or others (0600);
//   - machine credentials are required: a blank or missing one stops startup, it never disables auth;
//   - DJI_API_KEY may be blank (keyless first boot: uploads and history work, decoding waits for the key);
//   - values are never logged; describe() reports which optional values are present, nothing more.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = '/data/flight-logs/config/logs.env';
/** The only data directory Logs ever uses. The container may see a wider parent mount; Logs never leaves this. */
export const DATA_DIR = '/data/flight-logs';

const SPEC = Object.freeze({
  LOGS_DATA_DIR: { default: DATA_DIR },
  LOGS_PORT: { default: '8080' },
  LOGS_HEALTH_PORT: { default: '8081' },
  LOGS_INGRESS_HOST: { required: true },
  ACCESS_ISSUER: { required: true },
  ACCESS_AUDIENCE: { required: true },
  ACCESS_STAFF_PROXY_CLIENT_ID: { required: true },
  ACCESS_DEVICE_PROXY_CLIENT_ID: { required: true },
  OPS_DIRECTORY_BASE_URL: { required: true },
  OPS_DIRECTORY_CLIENT_ID: { required: true },
  OPS_DIRECTORY_CLIENT_SECRET: { required: true, secret: true },
  DJI_API_KEY: { blankAllowed: true, secret: true },
  KEYCHAIN_ENCRYPTION_KEY: { blankAllowed: true, secret: true },
  UPLOAD_CONCURRENCY: { default: '4' },
});

export class ConfigError extends Error {
  constructor(code, message) { super(message); this.name = 'ConfigError'; this.code = code; }
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
  for (const [key, spec] of Object.entries(SPEC)) {
    const value = values.get(key) ?? spec.default ?? '';
    if (spec.required && !value) throw new ConfigError('config_missing', `Config key ${key} is required.`);
    config[key] = value;
  }
  if (config.LOGS_DATA_DIR !== DATA_DIR && !allowDataDir) throw new ConfigError('config_value', `LOGS_DATA_DIR must be ${DATA_DIR}.`);
  if (!path.isAbsolute(config.LOGS_DATA_DIR)) throw new ConfigError('config_value', 'LOGS_DATA_DIR must be an absolute path.');
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
