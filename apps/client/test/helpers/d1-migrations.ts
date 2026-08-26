import { unstable_splitSqlQuery } from "wrangler";

/** Use the installed, lockfile-pinned D1 SQL parser, including trigger bodies. */
export function splitD1MigrationStatements(sql: string): string[] {
  return unstable_splitSqlQuery(sql.replace(/\r\n/g, "\n"))
    .map(statement => statement.trim())
    // D1 already enforces foreign keys. Preserve defer_foreign_keys and every
    // other pragma: dropping them changes the migration's transaction contract.
    .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(statement));
}
