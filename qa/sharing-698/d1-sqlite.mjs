// QA fixture only (not for merge). A minimal Cloudflare D1 binding over an
// in-memory node:sqlite database, so the fixture can be validated without a
// Worker runtime. It covers the D1 calls the #698 sharing paths make:
// prepare/bind/first/all/run/raw, batch (one transaction), exec and withSession.
import { DatabaseSync } from "node:sqlite";

function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function isRead(sql) {
  return /^\s*(?:WITH\b[\s\S]*?\bSELECT\b|SELECT\b|PRAGMA\b)/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values.map(bindable)); }
  #prepared() { return this.db.sqlite.prepare(this.sql); }
  async first(column) {
    const row = this.#prepared().get(...this.values);
    if (!row) return null;
    return column === undefined ? { ...row } : (row[column] ?? null);
  }
  async all() {
    const results = this.#prepared().all(...this.values).map(row => ({ ...row }));
    return { success: true, results, meta: { changes: 0, rows_read: results.length } };
  }
  async raw() { return this.#prepared().all(...this.values).map(row => Object.values(row)); }
  async run() {
    if (isRead(this.sql)) {
      const results = this.#prepared().all(...this.values).map(row => ({ ...row }));
      return { success: true, results, meta: { changes: 0, rows_read: results.length } };
    }
    const info = this.#prepared().run(...this.values);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  execute() { return isRead(this.sql) ? this.all() : this.run(); }
}

export class SqliteD1 {
  constructor(sqlite = new DatabaseSync(":memory:")) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this, sql); }
  async exec(sql) { this.sqlite.exec(sql); return { count: 1, duration: 0 }; }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  withSession() { return this; }
  getBookmark() { return null; }
}
