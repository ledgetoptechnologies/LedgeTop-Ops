import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** SQLite-backed D1 test adapter. Every real migration/trigger is retained.
 * Only SQLite's clock is synchronized with the test's application clock. */
export function clockedNativeImportSqlite() {
  const sqlite = new DatabaseSync(":memory:"), builtin = new DatabaseSync(":memory:");
  for (const name of ["strftime", "datetime", "date", "time", "julianday", "unixepoch"]) {
    sqlite.function(name, { varargs: true }, (...args) => {
      const values = args.map(value => value === "now" ? new Date().toISOString() : value);
      return Object.values(builtin.prepare(`SELECT ${name}(${values.map(() => "?").join(",")}) value`).get(...values) ?? {})[0] ?? null;
    });
  }
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  sqlite.exec(`INSERT INTO native_business_areas(id,name,active) VALUES('business-area-ltds','Ledge Top Drone Services',1),('business-area-ltt','Ledge Top Technologies',1)`);
  const prepared = (sql: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const all = () => {
      const results = sqlite.prepare(sql).all(...values);
      const changes = Number(sqlite.prepare("SELECT changes() value").get()!.value);
      return { success: true, results, meta: { changes, duration: 0 } };
    };
    return {
      bind: (...args: unknown[]) => prepared(sql, args as SQLInputValue[]),
      first: async (column?: string) => { const row = all().results[0]; return row ? column ? row[column] ?? null : row : null; },
      all: async () => all(), run: async () => all(),
      raw: async () => all().results.map(row => Object.values(row)),
    } as unknown as D1PreparedStatement;
  };
  const database = {
    prepare: prepared,
    withSession: () => database,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { database, dispose: () => { sqlite.close(); builtin.close(); } };
}
