// Offline generator and verifier for the Ops 0227..0244 wire-statement fixture.
// It splits each migration with the installed Wrangler splitter, exactly as the
// 0226 precedent fixture was produced, and compiles the full Ops migration chain
// in a local in-memory SQLite to derive each file's exact added schema objects.
// It never contacts Cloudflare. `--write` rewrites the fixture; the default only
// compares the committed fixture with a fresh derivation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPS_0227_0244_FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'production-ops-0227-0244-wrangler-wire-statements.json');
export const OPS_0227_0244_ORDERED_NAMES = Object.freeze([
  '0227_owner_intel_reads.sql',
  '0228_competitor_intel_ingest.sql',
  '0229_owner_intel_source_feed.sql',
  '0230_app_release_pilot.sql',
  '0231_owner_google_ads_summary.sql',
  '0240_flight_logs_permissions.sql',
  '0241_staff_usernames.sql',
  '0242_native_staff_onboarding_approval_actor_authority.sql',
  '0243_staff_logs_device_eligibility.sql',
  '0244_staff_operations_access_writer.sql',
]);
const PRIOR_LAST = '0226_staff_login_bindings.sql';
const PRIOR_COUNT = 226;
const SETUP = /^PRAGMA\s+foreign_keys\s*=\s*ON$/iu;
// Mirrors the table Wrangler creates for its migration ledger.
export const D1_MIGRATIONS_DDL = 'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
export const LEDGER_INSERT_SQL = 'INSERT INTO d1_migrations(name) VALUES (?)';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const schemaRowsSha256 = rows => hash(JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql])));
export const ledgerNamesSha256 = names => hash(names.join('\n'));

function wrangler(root) {
  const require = createRequire(path.join(root, 'apps', 'operations', 'package.json'));
  const { unstable_splitSqlQuery } = require('wrangler');
  const cliPath = path.join(path.dirname(require.resolve('wrangler/package.json')), 'wrangler-dist', 'cli.js');
  const version = JSON.parse(fs.readFileSync(require.resolve('wrangler/package.json'), 'utf8')).version;
  return { split: unstable_splitSqlQuery, cliSha256: hash(fs.readFileSync(cliPath)), version };
}

export function splitWireStatements(sql, split) {
  const output = split(sql);
  const setupStatements = output.filter(statement => SETUP.test(statement.trim()));
  const statements = output.filter(statement => !SETUP.test(statement.trim()));
  if (statements.some(statement => typeof statement !== 'string' || statement.trim().length === 0)) throw new Error('empty_statement');
  return { splitterOutputStatementCount: output.length, setupStatements, statements };
}

export function migrationNames(root = ROOT) {
  return fs.readdirSync(path.join(root, 'apps', 'operations', 'migrations')).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
}

export const SCHEMA_SQL = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name";

/** Applies source migrations [0, count) into a fresh local SQLite database. */
export function buildOpsChainDatabase({ root = ROOT, count = PRIOR_COUNT, filename = ':memory:' } = {}) {
  const { split } = wrangler(root);
  const names = migrationNames(root).slice(0, count);
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(D1_MIGRATIONS_DDL);
  const insert = db.prepare(LEDGER_INSERT_SQL);
  for (const name of names) {
    const { statements } = splitWireStatements(fs.readFileSync(path.join(root, 'apps', 'operations', 'migrations', name), 'utf8'), split);
    db.exec('BEGIN');
    try { for (const statement of statements) db.exec(statement); insert.run(name); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw new Error(`chain_migration_failed:${name}:${error.message}`); }
  }
  return db;
}

const plainRows = rows => rows.map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));

export function buildOps0227To0244WireFixture({ root = ROOT } = {}) {
  const tool = wrangler(root);
  const names = migrationNames(root);
  if (names.length !== PRIOR_COUNT + OPS_0227_0244_ORDERED_NAMES.length || names[PRIOR_COUNT - 1] !== PRIOR_LAST
    || names.slice(PRIOR_COUNT).join('\n') !== OPS_0227_0244_ORDERED_NAMES.join('\n')) throw new Error('source_inventory_unexpected');
  const db = buildOpsChainDatabase({ root, count: PRIOR_COUNT });
  try {
    const prior = db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all();
    if (prior.length !== PRIOR_COUNT || prior.some((row, index) => row.id !== index + 1 || row.name !== names[index])) throw new Error('prior_chain_unexpected');
    const files = OPS_0227_0244_ORDERED_NAMES.map((name, index) => {
      const bytes = fs.readFileSync(path.join(root, 'apps', 'operations', 'migrations', name));
      const wire = splitWireStatements(bytes.toString('utf8'), tool.split);
      const before = plainRows(db.prepare(SCHEMA_SQL).all());
      const beforeKeys = new Set(before.map(row => `${row.type}\0${row.name}`));
      db.exec('BEGIN');
      try { for (const statement of wire.statements) db.exec(statement); db.prepare(LEDGER_INSERT_SQL).run(name); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw new Error(`fixture_compile_failed:${name}:${error.message}`); }
      const after = plainRows(db.prepare(SCHEMA_SQL).all());
      const added = after.filter(row => !beforeKeys.has(`${row.type}\0${row.name}`));
      const newTableRows = Object.fromEntries(added.filter(row => row.type === 'table').map(row => row.name).sort()
        .map(table => [table, Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n)]));
      return {
        order: index + 1, name, ledgerId: PRIOR_COUNT + index + 1, sourceSha256: hash(bytes),
        splitterOutputStatementCount: wire.splitterOutputStatementCount, setupStatements: wire.setupStatements,
        statementCount: wire.statements.length, statementsSha256: hash(JSON.stringify(wire.statements)),
        expectedAddedObjects: added.map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name })),
        expectedAddedObjectCount: added.length, expectedAddedSchemaSha256: schemaRowsSha256(added),
        expectedNewTableRows: newTableRows, statements: wire.statements,
      };
    });
    return {
      schemaVersion: 1, contract: 'production-ops-0227-0244-wrangler-wire-v1',
      wranglerVersion: tool.version, wranglerCliSha256: tool.cliSha256,
      priorLedger: { count: PRIOR_COUNT, lastMigration: PRIOR_LAST, namesSha256: ledgerNamesSha256(names.slice(0, PRIOR_COUNT)) },
      finalLedger: { count: names.length, lastMigration: names.at(-1), namesSha256: ledgerNamesSha256(names) },
      files,
    };
  } finally { db.close(); }
}

export const serializeFixture = fixture => `${JSON.stringify(fixture, null, 2)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = serializeFixture(buildOps0227To0244WireFixture());
  if (process.argv.includes('--write')) fs.writeFileSync(OPS_0227_0244_FIXTURE_PATH, text);
  const current = fs.existsSync(OPS_0227_0244_FIXTURE_PATH) ? fs.readFileSync(OPS_0227_0244_FIXTURE_PATH, 'utf8') : '';
  process.stdout.write(`${JSON.stringify({ fixtureSha256: hash(Buffer.from(text)), matchesCommitted: current === text })}\n`);
  if (current !== text) process.exitCode = 1;
}
