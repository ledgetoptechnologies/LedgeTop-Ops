// A D1-shaped database over node:sqlite, so the Logs worker code runs unchanged on a local host.
// It covers the D1 surface the Logs code uses: prepare/bind/first/all/run/raw, batch (atomic) and exec.
// D1 limits are kept on purpose so code that passes here also passes on D1.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Write receipts. While an operation runs inside writeReceipts.run(context, fn), the FIRST write it makes on
 * context.db (a batch, or a run() of an INSERT/UPDATE/DELETE/REPLACE) also executes context.statement() in the
 * same transaction, and that statement must change exactly one row (an attempt-fenced receipt), or the whole
 * write rolls back. So "no receipt" proves "no write committed", and "receipt" proves the first write committed.
 */
export const writeReceipts = new AsyncLocalStorage();
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)[^A-Za-z_]/i;

export class ReceiptFenceError extends Error {
  constructor() { super('receipt_fence_lost'); this.name = 'ReceiptFenceError'; this.code = 'receipt_fence_lost'; }
}

export const D1_MAX_PARAMS = 100;

/**
 * SQLite builds with the WAL-reset fix (https://www.sqlite.org/wal.html): 3.51.3 and later, or the
 * 3.50.7+ / 3.44.6+ backports. A WAL database on an older embedded SQLite is refused at open.
 */
export function walSafeSqlite(version) {
  const [major, minor, patch] = String(version).split('.').map(Number);
  if (![major, minor, patch].every(Number.isInteger) || major !== 3) return false;
  if (minor > 51 || (minor === 51 && patch >= 3)) return true;
  return (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6);
}

export class D1Error extends Error {
  constructor(message, cause) { super(`D1_ERROR: ${message}`, cause ? { cause } : undefined); this.name = 'D1Error'; }
}

function normalise(value) {
  if (value === undefined) throw new D1Error('Type \'undefined\' not supported for value \'undefined\'');
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new D1Error(`Type '${typeof value}' not supported`);
}

/** D1 rows are plain objects, and blob columns come back as number arrays. */
function shapeRow(row) {
  const plain = { ...row };
  for (const key of Object.keys(plain)) if (plain[key] instanceof Uint8Array) plain[key] = Array.from(plain[key]);
  return plain;
}

class Statement {
  #db; #sql; #params;
  constructor(db, sql, params = []) { this.#db = db; this.#sql = sql; this.#params = params; }

  bind(...values) {
    if (values.length > D1_MAX_PARAMS) throw new D1Error(`too many SQL variables (max ${D1_MAX_PARAMS})`);
    return new Statement(this.#db, this.#sql, values.map(normalise));
  }

  /** Runs the statement synchronously; returns rows plus D1-style meta. */
  execute() { return this.#db.execute(this.#sql, this.#params); }

  /** True when this statement was prepared on that database (batch() refuses foreign statements). */
  belongsTo(db) { return this.#db === db; }

  async first(column) {
    const { results } = this.execute();
    const row = results[0] ?? null;
    if (column === undefined) return row;
    if (!row) return null;
    if (!(column in row)) throw new D1Error(`Column not found: ${column}`);
    return row[column];
  }
  async all() { return this.execute(); }
  async run() {
    const context = writeReceipts.getStore();
    if (context && !context.used && context.db === this.#db && WRITE.test(this.#sql)) return (await this.#db.batch([this]))[0];
    return this.execute();
  }
  /** The SQL text (used to recognise writes). */
  get sql() { return this.#sql; }
  async raw({ columnNames = false } = {}) {
    const { results, columns } = this.#db.execute(this.#sql, this.#params, { raw: true });
    return columnNames ? [columns, ...results] : results;
  }
}

export class SqliteD1 {
  #db; #closed = false;

  /** @param {string} path a file path, or ':memory:' for tests. */
  constructor(path, { busyTimeoutMs = 5000, wal = path !== ':memory:' } = {}) {
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.sqliteVersion = this.#db.prepare('SELECT sqlite_version() AS v').get().v;
    this.#db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    if (wal) {
      if (!walSafeSqlite(this.sqliteVersion)) {
        this.close();
        throw new D1Error(`SQLite ${this.sqliteVersion} lacks the WAL-reset fix; use a Node build with SQLite 3.51.3+ (or 3.50.7+ / 3.44.6+)`);
      }
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = FULL');
    }
  }

  prepare(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new D1Error('Empty SQL');
    return new Statement(this, sql);
  }

  /** All statements commit together or not at all, like D1 batch(). */
  async batch(statements) {
    if (!Array.isArray(statements) || !statements.every(s => s instanceof Statement)) throw new D1Error('batch() takes prepared statements');
    // A statement from another database would run outside this transaction and survive its rollback.
    if (!statements.every(s => s.belongsTo(this))) throw new D1Error('batch() statements must come from this database');
    if (!statements.length) return [];
    this.#open();
    const context = writeReceipts.getStore();
    const receipt = context && !context.used && context.db === this ? context.statement(this) : null;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(s => s.execute());
      if (receipt) {
        if (receipt.execute().meta.changes !== 1) throw new ReceiptFenceError();
        context.used = true;
      }
      this.#db.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Line-separated statements, like D1 exec(). Used for migrations and setup only. */
  async exec(sql) {
    this.#open();
    const started = performance.now();
    const lines = sql.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      try { this.#db.exec(line); } catch (error) { throw new D1Error(error.message, error); }
    }
    return { count: lines.length, duration: performance.now() - started };
  }

  /** Runs one transaction body synchronously. For local-only callers such as the migration runner. */
  transaction(fn) {
    this.#open();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn(this.#db);
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  execute(sql, params, { raw = false } = {}) {
    this.#open();
    const started = performance.now();
    let statement;
    try {
      statement = this.#db.prepare(sql);
    } catch (error) { throw new D1Error(error.message, error); }
    const before = this.#totalChanges();
    let rows;
    try {
      if (raw) statement.setReturnArrays(true);
      rows = statement.all(...params);
    } catch (error) { throw new D1Error(error.message, error); }
    // Like D1 (sqlite3_changes): rows this statement wrote directly, not foreign-key cascades. changes() keeps
    // the previous write's count after a read, so it is only consulted when this statement wrote something.
    const wrote = this.#totalChanges() !== before;
    const direct = wrote ? this.#db.prepare('SELECT changes() AS n, last_insert_rowid() AS id').get() : null;
    const changes = direct ? Number(direct.n) : 0;
    const lastRowId = direct ? Number(direct.id) : 0;
    const results = raw ? rows.map(r => r.map(v => (v instanceof Uint8Array ? Array.from(v) : v))) : rows.map(shapeRow);
    const result = {
      success: true,
      results,
      meta: { changes, last_row_id: lastRowId, changed_db: changes > 0, duration: performance.now() - started,
        rows_read: rows.length, rows_written: changes },
    };
    if (raw) result.columns = statement.columns().map(c => c.name);
    return result;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  get isOpen() { return !this.#closed; }

  #totalChanges() { return Number(this.#db.prepare('SELECT total_changes() AS n').get().n); }
  #open() { if (this.#closed) throw new D1Error('Database is closed'); }
}
