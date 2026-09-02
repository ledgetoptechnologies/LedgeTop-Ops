/**
 * Checks additive D1 capabilities against the primary without relying on the
 * migration ledger. This supports both fresh installs and legacy databases
 * whose migration history was bootstrapped separately.
 */
export async function d1TablesPresent(
  database: D1Database,
  tableNames: readonly string[],
): Promise<boolean> {
  if (!tableNames.length) return true;
  const placeholders = tableNames.map(() => "?").join(",");
  const row = await database.withSession("first-primary").prepare(
    `SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
  ).bind(...tableNames).first<{ count: number }>();
  return Number(row?.count || 0) === tableNames.length;
}

/**
 * Checks an additive column without assuming that every focused test fixture
 * or interrupted legacy install has reached the migration that introduced it.
 */
export async function d1ColumnPresent(
  database: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const row = await database.withSession("first-primary").prepare(
    "SELECT 1 present FROM pragma_table_info(?) WHERE name=? LIMIT 1",
  ).bind(tableName, columnName).first("present");
  return row !== null;
}
