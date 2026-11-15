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
  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = this.database.read(this.sql, this.bindings);
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const values = rows.map(row => Object.values(row));
    if (options?.columnNames === true) return [keys, ...values] as [string[], ...T[]];
    return values as T[];
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
    for (let index = 0; index < 256; index++)
      await barrier.database.prepare("SELECT id FROM clients WHERE id=?").bind(String(index)).all();
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

  it("coalesces concurrent identical reads and returns independent result copies", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = () => { executions++; return [{ id: "one", nested: { label: "initial" } }]; };
    const barrier = createPilotReadBarrier(original);
    const statement = barrier.database.withSession("first-primary").prepare("SELECT id,nested FROM clients WHERE id=?").bind("one");
    const first = statement.all();
    const second = barrier.database.withSession("first-primary").prepare("SELECT id,nested FROM clients WHERE id=?").bind("one").all();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(executions).toBe(1);
    expect(barrier.networkCalls).toBe(1);
    (firstResult.results[0] as { nested: { label: string } }).nested.label = "mutated";
    expect((secondResult.results[0] as { nested: { label: string } }).nested.label).toBe("initial");
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(barrier.networkCalls).toBe(2);
  });

  it("does not alias different SQL, bindings, first projections, or batch mode", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = (sql, bindings) => { executions++; return [{ id: `${sql}|${String(bindings[0] ?? "")}`, name: "same" }]; };
    const barrier = createPilotReadBarrier(original);
    const database = barrier.database;
    await database.withSession("first-primary").prepare("SELECT id,name FROM clients WHERE id=?").bind("a").all();
    await database.withSession("first-primary").prepare("SELECT id,name FROM clients WHERE id=?").bind("b").all();
    await database.withSession("first-primary").prepare("SELECT name FROM clients WHERE id=?").bind("a").all();
    await database.withSession("first-primary").prepare("SELECT id,name FROM clients WHERE id=?").bind("a").first();
    await database.batch([database.prepare("SELECT id,name FROM clients WHERE id=?").bind("a")]);
    expect(executions).toBe(5);
    expect(barrier.networkCalls).toBe(5);
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(barrier.networkCalls).toBe(6);
  });

  it("coalesces repeated direct-primary prepares but keeps them distinct from session reads", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = () => { executions++; return [{ id: "same" }]; };
    const barrier = createPilotReadBarrier(original);
    const sql = "SELECT id FROM client_hub_directory_state WHERE id=?";
    await barrier.database.prepare(sql).bind("directory").all();
    await barrier.database.prepare(sql).bind("directory").all();
    expect(executions).toBe(1);
    await barrier.database.withSession("first-primary").prepare(sql).bind("directory").all();
    expect(executions).toBe(2);
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(barrier.networkCalls).toBe(3); // direct miss + session miss + final replay batch
  });

  it("reuses exact direct-primary schema discovery reads", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = () => { executions++; return [{ name: "id", type: "TEXT" }]; };
    const barrier = createPilotReadBarrier(original);
    await barrier.database.prepare("PRAGMA table_info('clients')").all();
    await barrier.database.prepare("PRAGMA table_info('clients')").all();
    expect(executions).toBe(1);
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(barrier.networkCalls).toBe(2);
    expect(original.sessionBatches[0]?.map(query => query.sql)).toEqual(["PRAGMA table_info('clients')"]);
  });

  it("copies binary bindings before helper mutation and keeps replay bound to the original bytes", async () => {
    const original = new FakeDatabase();
    original.read = (_sql, bindings) => [{ bytes: Array.from(new Uint8Array(bindings[0] as Uint8Array)) }];
    const barrier = createPilotReadBarrier(original);
    const input = new Uint8Array([10, 20]);
    const pending = barrier.database.withSession("first-primary").prepare("SELECT bytes FROM clients WHERE key=?").bind(input).all();
    input[0] = 99;
    const initial = await pending;
    expect(initial.results[0]?.bytes).toEqual([10, 20]);
    initial.results[0]!.bytes = [77];
    await barrier.verify({ session: original.withSession("first-primary") });
    expect(original.sessionBatches[0]?.[0]?.bindings[0]).toEqual(new Uint8Array([10, 20]));
  });

  it("rechecks cached observations and current prefix authority before release", async () => {
    const original = new FakeDatabase();
    let current = "active";
    original.read = () => [{ status: current }];
    const barrier = createPilotReadBarrier(original);
    const database = barrier.database;
    await database.withSession("first-primary").prepare("SELECT status FROM clients WHERE id=?").bind("c1").all();
    await database.withSession("first-primary").prepare("SELECT status FROM clients WHERE id=?").bind("c1").all();
    current = "revoked";
    await expect(barrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("read-changed");
    expect(barrier.networkCalls).toBe(2); // one source read and final replay

    const prefixBarrier = createPilotReadBarrier(original);
    await prefixBarrier.database.withSession("first-primary").prepare("SELECT status FROM clients WHERE id=?").bind("c1").all();
    const prefix = original.prepare("SELECT staff_id FROM active_staff");
    await expect(prefixBarrier.verify({ session: original.withSession("first-primary"), prefixStatements: [prefix],
      checkPrefix: () => false })).rejects.toThrow("prefix-check-failed");
  });

  it("memoizes rejected in-flight reads without retrying and latches failure", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = () => { executions++; throw new Error("read failed"); };
    const barrier = createPilotReadBarrier(original);
    const makeRead = () => barrier.database.withSession("first-primary")
      .prepare("SELECT id FROM clients WHERE id=?").bind("c1").all();
    const first = makeRead();
    const second = makeRead();
    await expect(Promise.all([first, second])).rejects.toThrow("read failed");
    expect(executions).toBe(1);
    expect(barrier.networkCalls).toBe(1);
    await expect(makeRead()).rejects.toThrow("read-failed");
    expect(executions).toBe(1);
  });

  it("rejects a warm cache hit after a different query latches failure", async () => {
    const original = new FakeDatabase();
    let executions = 0;
    original.read = sql => {
      executions++;
      if (sql.includes("failure_query")) throw new Error("failure query");
      return [{ id: "cached" }];
    };
    const barrier = createPilotReadBarrier(original);
    const readCached = () => barrier.database.withSession("first-primary")
      .prepare("SELECT id FROM clients WHERE id=?").bind("c1").all();
    await readCached();
    await expect(barrier.database.withSession("first-primary").prepare("SELECT id FROM failure_query").all())
      .rejects.toThrow("failure query");
    expect(executions).toBe(2);
    await expect(readCached()).rejects.toThrow("read-failed");
    expect(executions).toBe(2);
    expect(barrier.networkCalls).toBe(2);
  });

  it("keeps zero and multirow first() results exact across replay", async () => {
    for (const rows of [[], [{ id: "one" }, { id: "two" }]]) {
      const original = new FakeDatabase();
      original.read = () => rows;
      const barrier = createPilotReadBarrier(original);
      const row = await barrier.database.withSession("first-primary").prepare("SELECT id FROM clients ORDER BY id").first();
      expect(row).toEqual(rows[0] ?? null);
      await barrier.verify({ session: original.withSession("first-primary") });
    }
  });

  it("seals with pending unique reads and rejects unsupported session consistency modes", async () => {
    const original = new FakeDatabase();
    const barrier = createPilotReadBarrier(original);
    const pending = barrier.database.withSession("first-primary").prepare("SELECT id FROM clients").all();
    await expect(barrier.verify({ session: original.withSession("first-primary") })).rejects.toThrow("pending-read");
    await expect(pending).rejects.toThrow("pending-read");
    expect(barrier.networkCalls).toBe(0);
    const other = createPilotReadBarrier(original);
    expect(() => other.database.withSession("first-unconstrained")).toThrow("unsupported-session-constraint");
  });
});
