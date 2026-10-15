import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function captureImportQueries(database: D1Database) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const wrap = (target: object): D1Database => new Proxy(target, {
    get(current, key) {
      if (key === "withSession") return (...args: unknown[]) => wrap((current as D1Database).withSession(...args as Parameters<D1Database["withSession"]>));
      if (key === "prepare") return (sql: string) => {
        const statement = (current as D1Database).prepare(sql);
        if (!sql.includes("?")) queries.push({ sql, values: [] });
        return new Proxy(statement, { get(value, property) {
          if (property === "bind") return (...values: unknown[]) => {
            queries.push({ sql, values }); return value.bind(...values);
          };
          const member = Reflect.get(value, property);
          return typeof member === "function" ? member.bind(value) : member;
        } });
      };
      const member = Reflect.get(current, key);
      return typeof member === "function" ? member.bind(current) : member;
    },
  }) as D1Database;
  return { database: wrap(database), queries };
}

/** Compile the actual application's generated statements, not SQL approximations. */
export function checkImportQueryDepth(queries: { sql: string; values: unknown[] }[]) {
  const code = String.raw`
import json,pathlib,sqlite3,sys
db=sqlite3.connect(':memory:')
for path in sorted(pathlib.Path(sys.argv[1]).glob('[0-9][0-9][0-9][0-9]_*.sql')):
 db.executescript(path.read_text(encoding='utf-8-sig'))
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
failures=[]
queries=json.load(sys.stdin)
for index,query in enumerate(queries):
 try:db.execute('EXPLAIN '+query['sql'],query['values']).fetchall()
 except sqlite3.Error as error:failures.append({'index':index,'sql':query['sql'],'error':str(error)})
print(json.dumps({'count':len(queries),'failures':failures}))
sys.exit(1 if failures else 0)
`;
  const result = spawnSync(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    ["-c", code, fileURLToPath(new URL("../../migrations/", import.meta.url))],
    { input: JSON.stringify(queries), encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return JSON.parse(result.stdout) as { count: number; failures: unknown[] };
}
