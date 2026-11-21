import { fileURLToPath } from 'node:url';
import { LEDGERS, listMigrations } from '../../logs-local/src/migrations.mjs';

const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
const ledger = LEDGERS.logs;
const baselineName = '0001_flight_logs.sql';

function normalizeSchema(sql) {
  return sql.replace(/--.*$/gm, '').trim().replace(/;$/, '').replace(/\s+/g, ' ');
}

function matchesLegacySchema(schema, statements) {
  const expected = new Map(statements.map(sql => {
    const definition = normalizeSchema(sql);
    const object = /^CREATE (TABLE|INDEX) (\w+)\b/i.exec(definition);
    if (!object) throw new Error('Unexpected SQL in the legacy preview migration');
    return [object[2], definition];
  }));
  return schema.length === expected.size && schema.every(
    row => expected.get(row.name) === normalizeSchema(row.sql),
  );
}

/** Use the same file checksums as Logs startup, with D1 batches for atomic DDL and ledger updates. */
export async function migratePreviewDatabase(db, splitSqlQuery) {
  const files = listMigrations(directory);
  const statements = file => splitSqlQuery(file.sql).map(sql => sql.trim())
    .filter(sql => sql && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(sql));
  const baseline = files[0];
  if (baseline?.name !== baselineName) throw new Error('Unexpected first Logs preview migration');

  // Workerd persists local D1 bookmarks in this exact vendor table.
  const { results: schema } = await db.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
      AND NOT (type = 'table' AND name = '_cf_METADATA')`).all();
  const hasLedger = schema.some(row => row.name === ledger);
  const applied = hasLedger
    ? (await db.prepare(`SELECT name, sha256 FROM ${ledger} ORDER BY name`).all()).results
    : [];
  if (applied.some((entry, i) => entry.name !== files[i]?.name || entry.sha256 !== files[i]?.sha256)) {
    throw new Error('Logs preview migration ledger differs from the local migration files');
  }

  const existing = schema.filter(row => row.name !== ledger);
  const adoptBaseline = applied.length === 0 && existing.length > 0;
  if (adoptBaseline && !matchesLegacySchema(existing, statements(baseline))) {
    throw new Error('Existing Logs preview schema does not match the complete 0001 migration');
  }

  await db.prepare(`CREATE TABLE IF NOT EXISTS ${ledger} (
    name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
  )`).run();
  const record = file => db.prepare(
    `INSERT INTO ${ledger}(name, sha256, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
  ).bind(file.name, file.sha256);

  // The earlier preview applied 0001 without a ledger. Adopt it only after comparing its definitions.
  if (adoptBaseline) await record(baseline).run();
  for (const file of files.slice(adoptBaseline ? 1 : applied.length)) {
    await db.batch([...statements(file).map(sql => db.prepare(sql)), record(file)]);
  }
}
