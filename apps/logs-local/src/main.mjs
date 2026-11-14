// Entry point for the local Logs host (container command: node apps/logs-local/src/main.mjs).
//
// Layout under LOGS_DATA_DIR (the isolated flight-logs directory; the store never creates the directory itself):
//   db/logs.sqlite       the Logs database (WAL, synchronous FULL)
//   objects/             originals and tracks (FsR2)
//   config/logs.env      this app's config (0600), read here at start, never via Compose
//
// Startup refuses to run with incomplete machine credentials. A blank DJI key is allowed: uploads and history
// work and decoding waits for the key (the decoder arrives in a later change). Logs never print config values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describe } from './config.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';
import { migrate, LEDGERS } from './migrations.mjs';
import { FsR2 } from './fs-r2.mjs';
import { createMachineAuth } from './machine-auth.mjs';
import { createOpsDirectory } from './directory-client.mjs';
import { createIdempotency } from './idempotency.mjs';
import { createLogsServer, createHealthServer } from './server.mjs';

const log = (event, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

export async function start({ configFile } = {}) {
  const config = loadConfig(configFile);
  const dataDir = config.LOGS_DATA_DIR;
  if (!fs.statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('LOGS_DATA_DIR does not exist');
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true, mode: 0o700 });
  const db = new SqliteD1(path.join(dataDir, 'db', 'logs.sqlite'));
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  const bucket = new FsR2(path.join(dataDir, 'objects'), { durableBase: dataDir });
  const directory = createOpsDirectory({ baseUrl: config.OPS_DIRECTORY_BASE_URL, clientId: config.OPS_DIRECTORY_CLIENT_ID, clientSecret: config.OPS_DIRECTORY_CLIENT_SECRET });
  const authorize = createMachineAuth({ issuer: config.ACCESS_ISSUER, audience: config.ACCESS_AUDIENCE,
    identities: { [config.ACCESS_STAFF_PROXY_CLIENT_ID]: 'staff-proxy', [config.ACCESS_DEVICE_PROXY_CLIENT_ID]: 'device-proxy' } });
  const env = { LOGS_DB: db, LOGS_BUCKET: bucket, OPS_DIRECTORY: directory, KEYCHAIN_ENCRYPTION_KEY: config.KEYCHAIN_ENCRYPTION_KEY || undefined };
  const logs = createLogsServer({ env, authorize, directory, ingressHost: config.LOGS_INGRESS_HOST, idempotency: createIdempotency(db), uploadConcurrency: config.UPLOAD_CONCURRENCY,
    log: (area, code) => log('error', { area, code }) });
  const health = createHealthServer(() => ({ decoder: config.DJI_API_KEY ? 'not_started' : 'waiting_for_key', uploadsInFlight: logs.uploadsInFlight }));
  await new Promise(resolve => logs.server.listen(config.LOGS_PORT, '0.0.0.0', resolve));
  await new Promise(resolve => health.listen(config.LOGS_HEALTH_PORT, '127.0.0.1', resolve));
  log('started', { port: config.LOGS_PORT, ...describe(config), sqlite: db.sqliteVersion, durability: bucket.durability });

  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    log('stopping', { signal });
    health.close();
    await logs.close();
    bucket.close();
    db.close();
    log('stopped');
  };
  return { stop, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().then(({ stop }) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal).then(() => process.exit(0), () => process.exit(1)));
  }, error => {
    // Only the error code or message, never config values.
    log('startup_failed', { code: error?.code ?? 'error', message: error?.message });
    process.exit(1);
  });
}
