#!/usr/bin/env node
// Entry point for the local DJI log decoder container. Configuration comes from the environment and secret files;
// see README.md. Exits non-zero on bad configuration instead of guessing.
import fs from 'node:fs';
import { createClient } from './client.mjs';
import { run } from './runner.mjs';
import { runParser } from './parser.mjs';

const ENVIRONMENTS = new Set(['staging', 'production']);

function fail(message) { console.error(`config: ${message}`); process.exit(2); }
function readSecret(file, name) {
  if (!file) fail(`${name} is not set`);
  let value;
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch { fail(`${name} can't be read`); }
  if (!value) fail(`${name} is empty`);
  return value;
}

export function loadConfig(env = process.env) {
  const environment = env.LOGS_ENVIRONMENT;
  if (!ENVIRONMENTS.has(environment)) fail('LOGS_ENVIRONMENT must be "staging" or "production"');
  let base;
  try { base = new URL(env.DECODER_BRIDGE_URL ?? ''); } catch { fail('DECODER_BRIDGE_URL is not a URL'); }
  if (base.protocol !== 'https:') fail('DECODER_BRIDGE_URL must be https');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) fail('DECODER_BRIDGE_URL must be a bare origin');
  const audience = `ledgetop-logs-decoder-${environment}`;
  if (env.DECODER_AUDIENCE && env.DECODER_AUDIENCE !== audience) fail(`DECODER_AUDIENCE must be ${audience}`);
  // Each environment has its own DJI key file; there is no fallback to the other environment's key. The key itself
  // is read only by the parser wrapper, from this file.
  const keyFile = env.DJI_API_KEY_FILE;
  if (!keyFile || !new RegExp(`(^|[^a-z])${environment}([^a-z]|$)`, 'i').test(keyFile)) fail(`DJI_API_KEY_FILE must name the ${environment} key file`);
  readSecret(keyFile, 'DJI_API_KEY_FILE');
  const workRoot = env.WORK_DIR || '/work';
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  return {
    environment, audience, baseUrl: base.origin, keyFile, workRoot,
    token: readSecret(env.DECODER_TOKEN_FILE, 'DECODER_TOKEN_FILE'),
    parserBinary: env.DJI_DECODE_BIN || '/usr/local/bin/ltds-dji-decode',
    timeoutMs: Math.min(600_000, Number(env.DECODE_TIMEOUT_MS) || 240_000),
  };
}

if (process.argv[1]?.endsWith('main.mjs')) {
  const config = loadConfig();
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log('stopping after the current log'); controller.abort(); });
  const client = createClient({ baseUrl: config.baseUrl, token: config.token, audience: config.audience });
  const parser = ({ inputFile, workDir }) => runParser({ binary: config.parserBinary, inputFile, workDir, keyFile: config.keyFile, timeoutMs: config.timeoutMs });
  console.log(`decoder started (${config.environment})`);
  run({ client, parser, workRoot: config.workRoot, signal: controller.signal, log: line => console.log(line) })
    .then(() => { console.log('decoder stopped'); process.exit(0); })
    .catch(error => { console.error(`decoder crashed: ${error?.name ?? 'Error'}`); process.exit(1); });
}
