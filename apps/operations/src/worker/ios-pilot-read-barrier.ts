/**
 * Records read-only D1 observations made through the supplied proxy and checks
 * them again in one caller-owned D1 session batch. This provides a bounded
 * optimistic read proof for one database. OPS_DB and DELIVERY_DB still cannot
 * be made atomic with each other; callers must verify each database separately.
 */

const MAX_READS = 256;
const MAX_CAPTURED_BYTES = 2 * 1024 * 1024;
const MAX_SQL_BYTES = 64 * 1024;

type ReadRecord = {
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly expectedRows: string;
  readonly first: boolean;
  readonly selectedColumn?: string;
};

type StatementInfo = {
  readonly statement: D1PreparedStatement;
  readonly sql: string;
  readonly bindings: readonly unknown[];
};

export type PilotReadBarrierVerification = {
  /** The original database session that will execute the final combined batch. */
  session: D1DatabaseSession;
  /** Trusted caller-owned statements, such as the final staff snapshot reads. */
  prefixStatements?: D1PreparedStatement[];
  /** Validates only prefix results; this callback must be synchronous. */
  checkPrefix?: (results: D1Result[]) => boolean;
};

export type PilotReadBarrier = {
  /** Actual D1 API calls, including the final batch; not statement count. */
  readonly networkCalls: number;
  /** Proxy to pass to the read helpers. All queries through it are recorded. */
  database: D1Database;
  /** Seal and revalidate all observations in the supplied original session. */
  verify(options: PilotReadBarrierVerification): Promise<void>;
};

type State = {
  failed: string | null;
  sealed: boolean;
  verified: boolean;
  pending: number;
  readCount: number;
  capturedBytes: number;
  networkCalls: number;
  readonly reads: ReadRecord[];
  readonly statements: WeakMap<object, StatementInfo>;
};

function fail(state: State, reason: string): never {
  state.failed ??= reason;
  throw new Error(`pilot-read-barrier:${reason}`);
}

function ensureActive(state: State): void {
  if (state.failed) throw new Error(`pilot-read-barrier:${state.failed}`);
  if (state.sealed || state.verified) fail(state, "read-after-verification");
}

function validateReadSql(sql: string): number {
  if (typeof sql !== "string") throw new Error("pilot-read-barrier:unsupported-sql");
  const bytes = new TextEncoder().encode(sql).byteLength;
  // Client Hub validates relation shape before it trusts current mapping rows.
  // Admit only this exact read-only metadata grammar, never general PRAGMA
  // statements, assignments, schema-qualified names or SQL supplied by RPC.
  if (bytes <= MAX_SQL_BYTES && /^\s*PRAGMA\s+table_info\(\s*(?:'[a-z_][a-z0-9_]{0,127}'|[a-z_][a-z0-9_]{0,127})\s*\)\s*$/i.test(sql)) return bytes;
  const tokens = maskSqlStrings(sql);
  const trimmed = tokens.trim();
  if (bytes === 0 || bytes > MAX_SQL_BYTES || /[;]|--|\/\*/.test(tokens)
    || !/^(?:SELECT|WITH)\b/i.test(trimmed)
    || /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRIGGER|INTO|LOAD_EXTENSION|WRITEFILE|READFILE)\b/i.test(tokens)
    || /\b(?:writefile|readfile|load_extension|pragma_[a-z0-9_]+)\s*\(/i.test(tokens)) {
    throw new Error("pilot-read-barrier:unsupported-sql");
  }
  return bytes;
}

/** Mask SQL string literals before keyword checks so values like 'UPDATE' do not
 * look like SQL verbs. Unterminated literals fail closed. Comments and
 * semicolons remain visible to the subsequent checks. */
function maskSqlStrings(sql: string): string {
  const chars = sql.split("");
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] !== "'") continue;
    chars[index] = " ";
    let closed = false;
    for (index++; index < chars.length; index++) {
      if (chars[index] === "'") {
        if (chars[index + 1] === "'") {
          chars[index] = " ";
          chars[index + 1] = " ";
          index++;
          continue;
        }
        chars[index] = " ";
        closed = true;
        break;
      }
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
    if (!closed) throw new Error("pilot-read-barrier:unsupported-sql");
  }
  return chars.join("");
}

function validateReadSqlForState(state: State, sql: string): number {
  try { return validateReadSql(sql); }
  catch { return fail(state, "unsupported-sql"); }
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("pilot-read-barrier:unsupported-result");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("pilot-read-barrier:unsupported-result");
    seen.add(value);
    const serialized = `[${value.map(item => canonical(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null || seen.has(object))
      throw new Error("pilot-read-barrier:unsupported-result");
    seen.add(object);
    const parts: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("pilot-read-barrier:unsupported-result");
      parts.push(`${JSON.stringify(key)}:${canonical(descriptor.value, seen)}`);
    }
    seen.delete(object);
    return `{${parts.join(",")}}`;
  }
  throw new Error("pilot-read-barrier:unsupported-result");
}

function copyBinding(value: unknown): { value: unknown; bytes: number } {
  if (value === null) return { value: null, bytes: 4 };
  if (typeof value === "string") return { value, bytes: new TextEncoder().encode(value).byteLength };
  if (typeof value === "number" && Number.isFinite(value)) return { value, bytes: 8 };
  if (typeof value === "boolean") return { value, bytes: 1 };
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    return { value: copy, bytes: copy.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = view.slice();
    return { value: copy, bytes: copy.byteLength };
  }
  throw new Error("pilot-read-barrier:unsupported-binding");
}

function copyBindingForState(state: State, value: unknown): { value: unknown; bytes: number } {
  try { return copyBinding(value); }
  catch { return fail(state, "unsupported-binding"); }
}

function reserveRead(state: State, info: StatementInfo): void {
  ensureActive(state);
  if (++state.readCount > MAX_READS) fail(state, "read-limit");
  const sqlBytes = validateReadSqlForState(state, info.sql);
  let bindingBytes = 0;
  for (const value of info.bindings) bindingBytes += copyBindingForState(state, value).bytes;
  if (state.capturedBytes + sqlBytes + bindingBytes > MAX_CAPTURED_BYTES) fail(state, "capture-limit");
  state.capturedBytes += sqlBytes + bindingBytes;
  state.pending++;
}

function recordRows(state: State, info: StatementInfo, rows: unknown[], selectedColumn?: string, first = false): void {
  const expectedRows = canonical(rows);
  const bytes = new TextEncoder().encode(expectedRows).byteLength;
  if (state.capturedBytes + bytes > MAX_CAPTURED_BYTES) fail(state, "capture-limit");
  state.capturedBytes += bytes;
  state.reads.push({ sql: info.sql, bindings: info.bindings, expectedRows, first,
    ...(selectedColumn === undefined ? {} : { selectedColumn }) });
}

function assertD1Rows(result: unknown): asserts result is D1Result {
  if (!result || typeof result !== "object") throw new Error("pilot-read-barrier:failed-read");
  const value = result as { success?: unknown; results?: unknown };
  if (value.success !== true || !Array.isArray(value.results)) throw new Error("pilot-read-barrier:failed-read");
}

function wrapStatement(state: State, statement: D1PreparedStatement, info: StatementInfo): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => {
        ensureActive(state);
        const copied = values.map(value => copyBindingForState(state, value));
        const bindings = copied.map(item => item.value);
        const bound = target.bind(...bindings);
        return wrapStatement(state, bound, { statement: bound, sql: info.sql, bindings });
      };
      if (property === "all") return async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        reserveRead(state, info);
        try {
          state.networkCalls++;
          const result = await target.all<T>();
          assertD1Rows(result);
          recordRows(state, info, result.results);
          state.pending--;
          return result;
        } catch (error) {
          state.failed ??= "read-failed";
          throw error;
        }
      };
      if (property === "first") return async <T = Record<string, unknown>>(column?: string): Promise<T | null> => {
        reserveRead(state, info);
        try {
          state.networkCalls++;
          const value = column === undefined ? await target.first<T>() : await target.first<T>(column);
          recordRows(state, info, [value], column, true);
          state.pending--;
          return value;
        } catch (error) {
          state.failed ??= "read-failed";
          throw error;
        }
      };
      if (property === "raw") return () => fail(state, "unsupported-raw");
      if (property === "run") return () => fail(state, "write-api-denied");
      if (property === "then") return undefined;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value === "function") return (..._args: unknown[]) => fail(state, "unsupported-statement-api");
      return value;
    },
  });
  state.statements.set(proxy, info);
  return proxy;
}

function wrapSession(state: State, session: D1DatabaseSession): D1DatabaseSession {
  return new Proxy(session, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        ensureActive(state);
        validateReadSqlForState(state, sql);
        const statement = target.prepare(sql);
        return wrapStatement(state, statement, { statement, sql, bindings: [] });
      };
      if (property === "batch") return <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
        executeBatch(state, target, statements);
      if (property === "getBookmark") return () => target.getBookmark();
      if (property === "then") return undefined;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value === "function") return (..._args: unknown[]) => fail(state, "unsupported-session-api");
      return value;
    },
  });
}

async function executeBatch<T>(state: State, target: D1Database | D1DatabaseSession,
  statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  ensureActive(state);
  if (!Array.isArray(statements) || statements.length === 0) fail(state, "unsupported-batch");
  const infos = statements.map(statement => state.statements.get(statement));
  if (infos.some(info => !info)) fail(state, "untracked-statement");
  for (const info of infos) reserveRead(state, info!);
  try {
    const raw = infos.map(info => info!.statement);
    state.networkCalls++;
    const results = await target.batch<T>(raw);
    if (!Array.isArray(results) || results.length !== statements.length) throw new Error("pilot-read-barrier:failed-batch");
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      assertD1Rows(result);
      recordRows(state, infos[index]!, result.results);
      state.pending--;
    }
    return results;
  } catch (error) {
    state.failed ??= "read-failed";
    throw error;
  }
}

export function createPilotReadBarrier(database: D1Database): PilotReadBarrier {
  const state: State = { failed: null, sealed: false, verified: false, pending: 0, readCount: 0, capturedBytes: 0, networkCalls: 0,
    reads: [], statements: new WeakMap<object, StatementInfo>() };

  const wrappedDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        ensureActive(state);
        validateReadSqlForState(state, sql);
        const statement = target.prepare(sql);
        return wrapStatement(state, statement, { statement, sql, bindings: [] });
      };
      if (property === "batch") return <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
        executeBatch(state, target, statements);
      if (property === "withSession") return (constraintOrBookmark?: string) => wrapSession(state, target.withSession(constraintOrBookmark));
      if (property === "exec" || property === "dump") return () => fail(state, "write-api-denied");
      if (property === "then") return undefined;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value === "function") return (..._args: unknown[]) => fail(state, "unsupported-database-api");
      return value;
    },
  });

  return {
    get networkCalls() { return state.networkCalls; },
    database: wrappedDatabase,
    async verify(options: PilotReadBarrierVerification): Promise<void> {
      ensureActive(state);
      state.sealed = true;
      if (state.pending !== 0) fail(state, "pending-read");
      if (state.reads.length !== state.readCount) fail(state, "incomplete-read-record");
      const prefix = options.prefixStatements ?? [];
      if (prefix.length > 0 && !options.checkPrefix) fail(state, "missing-prefix-check");
      if (state.reads.length === 0 && prefix.length === 0) {
        state.verified = true;
        return;
      }
      if (prefix.length + state.reads.length > MAX_READS) fail(state, "batch-limit");
      const replay = state.reads.map(read => {
        const statement = options.session.prepare(read.sql).bind(...read.bindings.map(value => copyBindingForState(state, value).value));
        return statement;
      });
      let results: D1Result[];
      try {
        state.networkCalls++;
        results = await options.session.batch([...prefix, ...replay]);
      } catch {
        fail(state, "verification-failed");
      }
      if (results.length !== prefix.length + state.reads.length) fail(state, "verification-result-count");
      for (let index = 0; index < results.length; index++) assertD1Rows(results[index]);
      if (options.checkPrefix) {
        let prefixValid = false;
        try { prefixValid = options.checkPrefix(results.slice(0, prefix.length)); }
        catch { fail(state, "prefix-check-failed"); }
        if (prefixValid !== true) fail(state, "prefix-check-failed");
      }
      for (let index = 0; index < state.reads.length; index++) {
        const read = state.reads[index]!;
        const result = results[prefix.length + index]!;
        let rows: unknown[] = result.results;
        if (read.first) {
          const first = result.results[0];
          const value = first === undefined ? null : read.selectedColumn !== undefined && first && typeof first === "object"
            ? (first as Record<string, unknown>)[read.selectedColumn] : first;
          rows = [value];
        }
        if (canonical(rows) !== read.expectedRows) fail(state, "read-changed");
      }
      state.verified = true;
    },
  };
}
