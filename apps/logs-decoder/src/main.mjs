#!/usr/bin/env node
// Entry point for the local DJI log decoder container. Configuration comes from the environment and secret files;
// see README.md. Exits non-zero on bad configuration instead of guessing.
import fs from 'node:fs';
import os from 'node:os';
import { createClient } from './client.mjs';
import { run, runParser } from './runner.mjs';

const ENVIRONMENTS = { staging: 'staging', production: 'production' };

function fail(message) { console.error(`config: ${message}`); process.exit(2); }
function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (!file) fail(`${name}_FILE is not set`);
  let value;
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch { fail(`${name}_FILE can't be read`); }
  if (!value) fail(`${name}_FILE is empty`);
  return value;
}

export function loadConfig(env = process.env) {
  const environment = ENVIRONMENTS[env.LOGS_ENVIRONMENT];
  if (!environment) fail('LOGS_ENVIRONMENT must be "staging" or "production"');
  let base;
  try { base = new URL(env.LOGS_URL ?? ''); } catch { fail('LOGS_URL is not a URL'); }
  const local = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(local && env.ALLOW_HTTP_LOCAL === 'true')) fail('LOGS_URL must be https');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) fail('LOGS_URL must be a bare origin');
  // Each environment has its own DJI key file; there is no fallback to the other environment's key.
  if (env.DJI_API_KEY_FILE && !new RegExp(`${environment}`, 'i').test(env.DJI_API_KEY_FILE)) fail(`DJI_API_KEY_FILE must be the ${environment} key file`);
  return {
    environment, baseUrl: base.origin,
    token: secret('DECODER_TOKEN'), apiKey: secret('DJI_API_KEY'),
    parserBinary: env.DJI_LOG_BIN || '/usr/local/bin/dji-log',
    workRoot: env.WORK_DIR || os.tmpdir(),
    timeoutMs: Number(env.DECODE_TIMEOUT_MS) || 240_000,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.mjs')) {
  const config = loadConfig();
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log('stopping after the current log'); controller.abort(); });
  const client = createClient({ baseUrl: config.baseUrl, token: config.token });
  const parser = ({ inputFile, workDir }) => runParser({ binary: config.parserBinary, inputFile, workDir, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  console.log(`decoder started (${config.environment}, ${config.baseUrl})`);
  run({ client, parser, workRoot: config.workRoot, signal: controller.signal, log: line => console.log(line) })
    .then(() => { console.log('decoder stopped'); process.exit(0); })
    .catch(error => { console.error(`decoder crashed: ${error?.name ?? 'Error'}`); process.exit(1); });
}
