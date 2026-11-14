#!/usr/bin/env node
// Snapshot import command (run inside the Logs container, as the app user):
//   node apps/logs-local/src/snapshot-cli.mjs pack   --snapshot DIR --label LABEL
//   node apps/logs-local/src/snapshot-cli.mjs plan   --snapshot DIR --staging-dir DIR --device-tokens preserve|revoke [--accept-missing-objects]
//   node apps/logs-local/src/snapshot-cli.mjs import --snapshot DIR --staging-dir DIR --device-tokens preserve|revoke [--accept-missing-objects]
// --staging-dir is required: an existing private folder with room for the table files (verified private copies are
// made there and removed afterwards). Never the container's small /tmp, never a shared location.
// plan is read-only: it opens the database and object index read-only, creates no folder, runs no migration and
// refuses a host that is not set up yet. import is the explicit path that prepares the host (migrations) and adds
// only, stopping at the first conflict. Output is one JSON line of aggregate counts; it never contains row contents
// or config values. Exit codes: 0 done, 2 usage, 3 conflicts/refused, 1 other error.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';
import { migrate, LEDGERS } from './migrations.mjs';
import { FsR2 } from './fs-r2.mjs';
import { readSnapshot, planSnapshot, importSnapshot, packSnapshot, openReadOnlyHost, SnapshotError } from './snapshot.mjs';

/**
 * @param {string[]} argv
 * @param {{ configFile?: string, dataDir?: string, print?: (value: object) => void }} [options] dataDir overrides the
 *   config (tests)
 */
export async function run(argv, { configFile = process.env.LOGS_CONFIG_FILE || undefined, dataDir: givenDataDir, print = v => console.log(JSON.stringify(v)) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      snapshot: { type: 'string' }, label: { type: 'string' }, 'device-tokens': { type: 'string' }, 'accept-missing-objects': { type: 'boolean', default: false },
      'staging-dir': { type: 'string' } } });
  } catch (error) { print({ ok: false, code: 'usage', message: error.message }); return 2; }
  const [command] = parsed.positionals;
  const { snapshot: dir, label } = parsed.values;
  if (!['pack', 'plan', 'import'].includes(command) || !dir) { print({ ok: false, code: 'usage', message: 'pack|plan|import --snapshot DIR' }); return 2; }
  let snapshot;
  try {
    if (command === 'pack') { print({ ok: true, ...(await packSnapshot(dir, { label })) }); return 0; }
    const options = { deviceTokens: parsed.values['device-tokens'], acceptMissingObjects: parsed.values['accept-missing-objects'] };
    const dataDir = givenDataDir ?? loadConfig(configFile).LOGS_DATA_DIR;
    if (!parsed.values['staging-dir']) { print({ ok: false, code: 'usage', message: '--staging-dir DIR is required (a private folder with room for the table files).' }); return 2; }
    snapshot = await readSnapshot(dir, { stagingDir: parsed.values['staging-dir'] });
    if (command === 'plan') {
      const host = openReadOnlyHost(dataDir);
      try { const plan = await planSnapshot(host.db, host.store, snapshot, options); print(plan); return plan.ok ? 0 : 3; }
      finally { host.close(); }
    }
    const db = new SqliteD1(path.join(dataDir, 'db', 'logs.sqlite'));
    const store = new FsR2(path.join(dataDir, 'objects'), { durableBase: dataDir });
    try {
      migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
      migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
      print({ ok: true, ...(await importSnapshot(db, store, snapshot, options)) });
      return 0;
    } finally { store.close(); db.close(); }
  } catch (error) {
    if (error instanceof SnapshotError) { print({ ok: false, code: error.code, message: error.message, ...(error.plan ? { plan: error.plan } : {}) }); return 3; }
    print({ ok: false, code: typeof error?.code === 'string' ? error.code : 'error', message: 'The snapshot command failed.' });
    return 1;
  } finally { snapshot?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
