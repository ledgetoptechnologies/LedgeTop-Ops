// Token-level canonical form of stored sqlite_schema text.
//
// D1 stores a CREATE statement as it was submitted. Wrangler's local splitter
// removes comments first; an unsplit migration keeps them. Both describe the
// same schema, so a readiness pin must compare SQL tokens, not bytes.
//
// Only two things are dropped: whitespace and comments BETWEEN tokens. String
// and blob literals, quoted identifiers, numbers, operators and unquoted words
// stay exactly as stored, including their case. A double-quoted word can mean a
// string in SQLite, so quoting is never normalized in expressions. The single
// exception is the object's own declared name directly after CREATE <kind>,
// where the grammar only accepts a name and it must equal the row's name.
//
// Anything this tokenizer does not recognize is refused, never skipped.
// This is a runtime readiness check. It is separate from, and must not be
// shared with, the release schema comparators under scripts/.
export const SQLITE_SCHEMA_CANONICAL_VERSION = "sqlite-schema-tokens-v1";

export type SqliteSchemaTuple = readonly [type: string, name: string, table: string, sql: unknown];

const refuse = (): never => { throw Error("sqlite_schema_text_unrecognized"); };
const SPACE = /[ \t\n\f\r]+/y;
const WORD = /[A-Za-z_\u0080-﻾＀-￿][A-Za-z0-9_$\u0080-￿]*/y;
const BLOB = /[xX]'(?:[0-9a-fA-F]{2})*'/y;
const NUMBER = /0[xX][0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const OPERATOR = /->>|->|\|\||<<|>>|<=|<>|>=|==|!=|[-()+*/%=<>&~|;,.]/y;
const WORD_CHARACTER = /[A-Za-z0-9_$\u0080-￿]/;

function match(pattern: RegExp, sql: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(sql)?.[0] ?? null;
}

/** The exact SQLite tokens of one stored statement, in order. */
export function sqliteSchemaTokens(sql: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < sql.length) {
    const space = match(SPACE, sql, at);
    if (space) { at += space.length; continue; }
    const pair = sql.slice(at, at + 2);
    if (pair === "--") {
      // SQLite ends this comment at LF only; a lone CR does not end it.
      const end = sql.indexOf("\n", at);
      at = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (pair === "/*") {
      const end = sql.indexOf("*/", at + 2);
      if (end < 0) refuse();
      at = end + 2;
      continue;
    }
    const first = sql[at]!;
    let token: string | null;
    if (first === "'" || first === '"' || first === "`" || first === "[") {
      const close = first === "[" ? "]" : first;
      let end = sql.indexOf(close, at + 1);
      while (first !== "[" && end >= 0 && sql[end + 1] === close) end = sql.indexOf(close, end + 2);
      token = end < 0 ? refuse() : sql.slice(at, end + 1);
    } else if ((first === "x" || first === "X") && sql[at + 1] === "'") {
      token = match(BLOB, sql, at) ?? refuse();
    } else {
      token = match(NUMBER, sql, at);
      if (token && WORD_CHARACTER.test(sql[at + token.length] ?? "")) refuse();
      token ??= match(WORD, sql, at) ?? match(OPERATOR, sql, at) ?? refuse();
    }
    // SQLite text ends at NUL, so a NUL inside a literal is not readable text.
    if (token.includes("\u0000")) refuse();
    tokens.push(token);
    at += token.length;
  }
  return tokens;
}

function declaredName(token: string | null | undefined): string | null | undefined {
  if (token?.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
  if (token?.startsWith("`")) return token.slice(1, -1).replaceAll("``", "`");
  return token?.startsWith("[") ? token.slice(1, -1) : token;
}

/** One inventory row. The declared name becomes null: the row's own name is
 * already in the tuple and the two must match exactly. */
export function canonicalSqliteSchemaTuple(tuple: SqliteSchemaTuple): unknown[] {
  if (!Array.isArray(tuple) || tuple.length !== 4) refuse();
  const [type, name, table, sql] = tuple;
  if (![type, name, table].every(value => typeof value === "string")) refuse();
  if (type === "column") {
    // pragma_table_info projection: [declared type, not null, default, primary key].
    const column: unknown = typeof sql === "string" ? JSON.parse(sql) : sql;
    if (!Array.isArray(column) || column.length !== 4) refuse();
    return [type, name, table, column];
  }
  // Only SQLite's automatic UNIQUE/PRIMARY KEY indexes have no text.
  if (sql === null && type === "index" && name.startsWith("sqlite_autoindex_")) return [type, name, table, null];
  if (typeof sql !== "string") return refuse();
  const tokens: (string | null)[] = sqliteSchemaTokens(sql);
  const header = type === "table" ? ["CREATE", "TABLE"] : type === "view" ? ["CREATE", "VIEW"]
    : type === "trigger" ? ["CREATE", "TRIGGER"]
      : type === "index" ? (tokens[1] === "UNIQUE" ? ["CREATE", "UNIQUE", "INDEX"] : ["CREATE", "INDEX"]) : refuse();
  if (header.some((word, index) => tokens[index] !== word) || declaredName(tokens[header.length]) !== name) refuse();
  tokens[header.length] = null;
  return [type, name, table, tokens];
}

/** Versioned canonical text of a whole ordered inventory. */
export function canonicalSqliteSchemaInventory(inventory: unknown): string {
  if (!Array.isArray(inventory)) return refuse();
  return JSON.stringify([SQLITE_SCHEMA_CANONICAL_VERSION,
    (inventory as SqliteSchemaTuple[]).map(canonicalSqliteSchemaTuple)]);
}
