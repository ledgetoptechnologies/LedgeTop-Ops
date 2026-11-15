import { describe, expect, it } from "vitest";
import { createPilotReadBarrier } from "../src/worker/ios-pilot-read-barrier";

type FakeRead = (sql: string, bindings: readonly unknown[]) => Record<string, unknown>[];

function result<T>(rows: T[]): D1Result<T> {
  return { success: true, meta: { duration: 0, size_after: 0, rows_read: rows.length, rows_written: 0,
    last_row_id: 0, changed_db: false, changes: 0 }, results: rows };
}

class FakePrepared {
  constructor(readonly database: FakeDatabase, readonly sql: string, readonly bindings: readonly unknown[] = []) {}
  bind(...values: unknown[]): FakePrepared { return new FakePrepared(this.database, this.sql, values); }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database.read(this.sql, this.bindings);
    return result(rows as T[]);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.read(this.sql, this.bindings)[0];
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.database.read(this.sql, this.bindings);
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const values = rows.map(row => Object.values(row));
    return (options?.columnNames ? [keys, ...values] : values) as T[];
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return result([]); }
}

class FakeSession {
  constructor(readonly database: FakeDatabase) {}
  prepare(sql: string): FakePrepared { return this.database.prepare(sql); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.sessionBatches.push(statements.map(statement => ({
      sql: statement instanceof FakePrepared ? statement.sql : "unrecognized",
      bindings: statement instanceof FakePrepared ? statement.bindings : [],
    })));
    const results: D1Result<T>[] = [];
    for (const statement of statements) results.push(await statement.all<T>());
    return results;
  }
  getBookmark(): string | null { return "fake-bookmark"; }
}

class FakeDatabase {
  readonly sessionBatches: Array<Array<{ sql: string; bindings: readonly unknown[] }>> = [];
  read: FakeRead = () => [{ id: "one", name: "One" }];
  prepare(sql: string): FakePrepared { return new FakePrepared(this, sql); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) results.push(await statement.all<T>());
    return results;
  }
  exec(_sql: string): Promise<D1ExecResult> { return Promise.resolve({ count: 0, duration: 0 }); }
  dump(): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(0)); }
  withSession(_constraint?: string): FakeSession { return new FakeSession(this); }
}

describe("iOS pilot read barrier", () => {
  it("revalidates exact read-only table shape metadata and rejects other PRAGMA forms", async () => {
    const original = new FakeDatabase();
    const barrier = createPilotReadBarrier(original);
    await barrier.database.prepare("PRAGMA table_info('clients')").all();
    await barrier.database.prepare("PRAGMA table_info(operations_shared_project_revisions)").all();
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(original.sessionBatches[0]?.[0]?.sql).toBe("PRAGMA table_info('clients')");
    expect(original.sessionBatches[0]?.[1]?.sql).toBe("PRAGMA table_info(operations_shared_project_revisions)");
    for (const sql of ["PRAGMA foreign_keys=OFF", "PRAGMA writable_schema=ON", "PRAGMA journal_mode(WAL)",
      "PRAGMA table_info('clients'); DELETE FROM clients", "PRAGMA table_info('clients' || 'x')", "PRAGMA main.table_info('clients')"])
      expect(() => createPilotReadBarrier(original).database.prepare(sql)).toThrow("unsupported-sql");
  });
  it("captures all, first, and database batch reads and replays them in one session batch", async () => {
    const original = new FakeDatabase();
    const barrier = createPilotReadBarrier(original);
    const database = barrier.database;
    await database.withSession("first-primary").prepare("SELECT id,name FROM clients WHERE id=?").bind("c1").all();
    expect(await database.prepare("SELECT id FROM clients WHERE id=?").bind("c1").first("id")).toBe("one");
    await database.batch([database.prepare("WITH chosen AS (SELECT id FROM clients) SELECT id FROM chosen")]);

    const session = original.withSession("first-primary");
    const prefix = original.prepare("SELECT staff_id FROM current_staff").bind("staff");
    await barrier.verify({ session, prefixStatements: [prefix], checkPrefix: rows => rows.length === 1 && rows[0]?.success === true });

    expect(barrier.networkCalls).toBe(4); // all + first + one data batch + one final batch
    expect(original.sessionBatches).toHaveLength(1);
    expect(original.sessionBatches[0]?.map(query => query.sql)).toEqual([
      "SELECT staff_id FROM current_staff",
      "SELECT id,name FROM clients WHERE id=?",
      "SELECT id FROM clients WHERE id=?",
      "WITH chosen AS (SELECT id FROM clients) SELECT id FROM chosen",
    ]);
    expect(original.sessionBatches[0]?.[2]?.bindings).toEqual(["c1"]);
    expect(() => database.prepare("SELECT id FROM clients")).toThrow("read-after-verification");
  });

  it("compares row values while ignoring object key order", async () => {
    const original = new FakeDatabase();
    let reads = 0;
    original.read = () => ++reads === 1 ? [{ id: "one", name: "One" }] : [{ name: "One", id: "one" }];
    const barrier = createPilotReadBarrier(original);
    await barrier.database.prepare("SELECT id,name FROM clients").all();
    await barrier.verify({ session: original.withSession("first-primary") });
  });

  it("accepts verb-like values in SQL literals but rejects mutating CTEs and comments", async () => {
    const original = new FakeDatabase();
    const barrier = createPilotReadBarrier(original);
    await barrier.database.prepare("SELECT 'UPDATE', 'trigger', '-- ;' AS label").all();
    await barrier.verify({ session: original.withSession("first-primary") });

    const mutation = createPilotReadBarrier(original);
    expect(() => mutation.database.prepare("WITH changed AS (DELETE FROM clients) SELECT 1")).toThrow("unsupported-sql");
    const comment = createPilotReadBarrier(original);
    expect(() => comment.database.prepare("SELECT id FROM clients -- comment")).toThrow("unsupported-sql");
  });

  it("rejects changed rows during final replay", async () => {
    const original = new FakeDatabase();
    let name = "Before";
    original.read = () => [{ id: "one", name }];
    const barrier = createPilotReadBarrier(original);
    await barrier.database.prepare("SELECT id,name FROM clients").all();
    name = "After";
    await expect(barrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("read-changed");
  });

  it("fails closed for mutation SQL and write-capable APIs", async () => {
    const original = new FakeDatabase();
    const sqlBarrier = createPilotReadBarrier(original);
    expect(() => sqlBarrier.database.prepare("DELETE FROM clients")).toThrow("unsupported-sql");
    await expect(sqlBarrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("unsupported-sql");
    expect(() => createPilotReadBarrier(original).database.exec("DELETE FROM clients")).toThrow("write-api-denied");
    expect(() => createPilotReadBarrier(original).database.dump()).toThrow("write-api-denied");
    const runBarrier = createPilotReadBarrier(original);
    expect(() => runBarrier.database.prepare("SELECT id FROM clients").run()).toThrow("write-api-denied");
    const rawBarrier = createPilotReadBarrier(original);
    expect(() => rawBarrier.database.prepare("SELECT id FROM clients").raw()).toThrow("unsupported-raw");
  });

  it("rejects an initial read failure and latches it even if the caller catches it", async () => {
    const original = new FakeDatabase();
    original.read = () => { throw new Error("database failure"); };
    const barrier = createPilotReadBarrier(original);
    await expect(barrier.database.prepare("SELECT id FROM clients").all()).rejects.toThrow("database failure");
    await expect(barrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("read-failed");
  });

  it("bounds read count before issuing the excess query", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = () => { executions++; return []; };
    const barrier = createPilotReadBarrier(original);
    for (let index = 0; index < 256; index++) await barrier.database.prepare("SELECT id FROM clients").all();
    await expect(barrier.database.prepare("SELECT id FROM clients").all()).rejects.toThrow("read-limit");
    expect(executions).toBe(256);
    await expect(barrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("read-limit");
  });

  it("allows an unused read lane to verify vacuously without issuing a fake batch", async () => {
    const original = new FakeDatabase();
    const barrier = createPilotReadBarrier(original);
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(original.sessionBatches).toHaveLength(0);
    expect(barrier.networkCalls).toBe(0);
  });
});
