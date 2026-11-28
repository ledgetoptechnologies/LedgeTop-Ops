import { readFileSync } from "node:fs";
import { unstable_splitSqlQuery } from "wrangler";

/** Use the installed, lockfile-pinned D1 SQL parser, including trigger bodies. */
export function splitD1MigrationStatements(sql: string): string[] {
  return unstable_splitSqlQuery(sql.replace(/\r\n/g, "\n"))
    .map(statement => statement.trim())
    // D1 already enforces foreign keys. Preserve defer_foreign_keys and every
    // other pragma: dropping them changes the migration's transaction contract.
    .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(statement));
}

/** Hub 2496ea83 step A: the file-scope column, its closing triggers and the folder-only grants view,
 * for fixtures whose schema is pinned before migration 0244. */
export async function applyFileGrantScope(db: D1Database): Promise<void> {
  const present = await db.prepare("SELECT 1 FROM pragma_table_info('portal_v2_authenticated_delivery_grants') WHERE name='object_path'").first();
  if (present) return;
  const sql = readFileSync(new URL("../../migrations/0244_file_grant_scope.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
