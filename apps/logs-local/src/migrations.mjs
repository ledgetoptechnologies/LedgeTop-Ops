// Applies the Logs D1 migrations (apps/logs/migrations) to the local SQLite database, in order, once each.
// Each file runs in its own transaction. A changed file that was already applied stops startup:
// local and D1 schemas must never drift apart silently.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const LEDGER = `CREATE TABLE IF NOT EXISTS logs_local_migrations (
  name TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export class MigrationError extends Error {
  constructor(code, message) { super(message); this.name = 'MigrationError'; this.code = code; }
}

export function listMigrations(dir) {
  const names = fs.readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const bad = names.find(name => !NAME.test(name));
  if (bad) throw new MigrationError('migration_name', `Unexpected migration file name: ${bad}`);
  return names.map(name => {
    // Line endings differ between Windows and Linux checkouts; the checksum must not.
    const sql = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * @param {import('./sqlite-d1.mjs').SqliteD1} db
 * @returns {{ applied: string[], current: string[] }}
 */
export function migrate(db, dir, { now = () => new Date() } = {}) {
  const files = listMigrations(dir);
  db.transaction(raw => raw.exec(LEDGER));
  const done = new Map(db.transaction(raw => raw.prepare('SELECT name, sha256 FROM logs_local_migrations').all())
    .map(row => [row.name, row.sha256]));
  for (const name of done.keys())
    if (!files.some(file => file.name === name)) throw new MigrationError('migration_missing', `Applied migration is missing on disk: ${name}`);
  const applied = [];
  for (const file of files) {
    const known = done.get(file.name);
    if (known) {
      if (known !== file.sha256) throw new MigrationError('migration_changed', `Applied migration was edited: ${file.name}`);
      continue;
    }
    db.transaction(raw => {
      raw.exec(file.sql);
      raw.prepare('INSERT INTO logs_local_migrations (name, sha256, applied_at) VALUES (?, ?, ?)')
        .run(file.name, file.sha256, now().toISOString());
    });
    applied.push(file.name);
  }
  return { applied, current: files.map(file => file.name) };
}
