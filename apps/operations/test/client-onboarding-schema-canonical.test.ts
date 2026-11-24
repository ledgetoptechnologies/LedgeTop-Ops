import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { canonicalSqliteSchemaInventory, canonicalSqliteSchemaTuple, sqliteSchemaTokens, SQLITE_SCHEMA_CANONICAL_VERSION,
  type SqliteSchemaTuple } from "../src/worker/sqlite-schema-canonical";
import { CLIENT_ONBOARDING_SCHEMA_PINS, destinationIssuanceSchemaFence, mailIssuanceSchemaFence, targetIssuanceSchemaFence }
  from "../src/worker/client-onboarding-target-schema";

// SHA-256 over the reviewed comment-stripped stored text.
const STRIPPED_TEXT_PINS = {
  target: "0ccdcb9baabb0a5f5c4a480304255862563034ad5472cc9c4507094fd9a3d749",
  destination: "3847a78394a2a4e8a5dc4556a8a7187fa8589ad58330bc29e8d417e39798e41e",
  mail: "bfef35e15eee0702db7e1e679ec30636967e013509ec8ffd3e18a81c583f6228",
} as const;
type InventoryName = keyof typeof STRIPPED_TEXT_PINS;
const NAMES = Object.keys(STRIPPED_TEXT_PINS) as InventoryName[];
const fences = { target: targetIssuanceSchemaFence, destination: destinationIssuanceSchemaFence, mail: mailIssuanceSchemaFence };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const directory = new URL("../migrations/", import.meta.url);
// Every migration, so a later one that changes a pinned object fails here first.
const migrationNames = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();

/** "stripped": statements as Wrangler splits them. "source": each file unsplit,
 * so stored text keeps its interior comments. */
function migrated(form: "stripped" | "source"): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const name of migrationNames) {
    const text = readFileSync(new URL(name, directory), "utf8").replaceAll("\r\n", "\n");
    database.exec("BEGIN");
    for (const statement of form === "source" ? [text] : splitD1MigrationStatements(text)) database.exec(statement);
    database.exec("COMMIT");
  }
  return database;
}
function d1(database: DatabaseSync, onRead?: (query: string) => void): Pick<D1Database, "prepare"> {
  const statement = (query: string, values: string[] = []): unknown => ({
    bind: (...next: string[]) => statement(query, next),
    first: async (column?: string) => {
      onRead?.(query);
      const row = database.prepare(query).get(...values) as Record<string, unknown> | undefined;
      return column ? row?.[column] ?? null : row ?? null;
    },
  });
  return { prepare: statement } as unknown as Pick<D1Database, "prepare">;
}
/** The rows the shipped fence query itself reads. */
async function inventory(database: DatabaseSync, name: InventoryName): Promise<SqliteSchemaTuple[]> {
  let query = "";
  await fences[name](d1(database, text => { query = text; })).catch(() => undefined);
  return JSON.parse(String((database.prepare(query).get() as { inventory: string }).inventory)) as SqliteSchemaTuple[];
}
const canonicalDigest = (rows: readonly SqliteSchemaTuple[]) => sha256(canonicalSqliteSchemaInventory(rows));
const object = (type: string, name: string, sql: string, table = name): SqliteSchemaTuple => [type, name, table, sql];
const same = (type: string, name: string, left: string, right: string, table = name) =>
  JSON.stringify(canonicalSqliteSchemaTuple(object(type, name, left, table)))
    === JSON.stringify(canonicalSqliteSchemaTuple(object(type, name, right, table)));

describe("client onboarding schema readiness canonicalization", () => {
  let stripped: DatabaseSync, source: DatabaseSync;
  beforeAll(() => { stripped = migrated("stripped"); source = migrated("source"); }, 120_000);
  afterAll(() => { stripped?.close(); source?.close(); });

  it.each(NAMES)("%s readiness accepts the reviewed schema with and without stored comments", async name => {
    for (const database of [stripped, source]) {
      const fence = await fences[name](d1(database));
      await expect(fence.first("schema_fence")).resolves.toBe("true");
    }
  });

  it("stored text differs only in the two objects whose migrations carry interior comments", async () => {
    const [left, right] = [await inventory(stripped, "mail"), await inventory(source, "mail")];
    expect(left.filter((row, index) => row[3] !== right[index]![3]).map(row => `${row[0]}:${row[1]}`))
      .toEqual(["table:client_onboarding_issuance_commands", "view:client_onboarding_live_issuances"]);
    expect(await inventory(stripped, "destination")).toEqual(await inventory(source, "destination"));
  });

  it.each(NAMES)("%s matches the stored and canonical digests tuple by tuple", async name => {
    const recorded = JSON.parse(readFileSync(new URL("./fixtures/client-onboarding-schema-readiness-v1.json", import.meta.url), "utf8"));
    const [left, right] = [await inventory(stripped, name), await inventory(source, name)];
    // The stripped form must also match its reviewed stored-text pin.
    expect(sha256(JSON.stringify(left))).toBe(STRIPPED_TEXT_PINS[name]);
    const text = (row: SqliteSchemaTuple) => row[3] === null ? null : typeof row[3] === "string" ? row[3] : JSON.stringify(row[3]);
    const tuples = left.map((row, index) => {
      const canonical = JSON.stringify([SQLITE_SCHEMA_CANONICAL_VERSION, canonicalSqliteSchemaTuple(row)]);
      expect(JSON.stringify([SQLITE_SCHEMA_CANONICAL_VERSION, canonicalSqliteSchemaTuple(right[index]!)])).toBe(canonical);
      const [plain, commented] = [text(row), text(right[index]!)];
      return { type: row[0], name: row[1], table: row[2],
        strippedSqlSha256: plain === null ? null : sha256(plain), sourceSqlSha256: commented === null ? null : sha256(commented),
        strippedTupleSha256: sha256(JSON.stringify(row)), canonicalTupleSha256: sha256(canonical) };
    });
    expect({ strippedTextPin: STRIPPED_TEXT_PINS[name], sourceTextSha256: sha256(JSON.stringify(right)),
      canonicalPin: CLIENT_ONBOARDING_SCHEMA_PINS[name], tuples }).toEqual(recorded.inventories[name]);
    expect(recorded.canonicalVersion).toBe(SQLITE_SCHEMA_CANONICAL_VERSION);
    expect([canonicalDigest(left), canonicalDigest(right)]).toEqual([CLIENT_ONBOARDING_SCHEMA_PINS[name], CLIENT_ONBOARDING_SCHEMA_PINS[name]]);
  });

  it("still refuses a schema that changes after the readiness read", async () => {
    source.exec("SAVEPOINT race");
    try {
      const fence = await targetIssuanceSchemaFence(d1(source));
      source.exec("CREATE INDEX unreviewed_race ON client_onboarding_invitations(state)");
      await expect(fence.first("schema_fence")).rejects.toThrow();
    } finally { source.exec("ROLLBACK TO race; RELEASE race"); }
  });

  // Real DDL against each stored form; every case must refuse.
  const redefine = (name: string, from: string | RegExp, to: string) => (database: DatabaseSync) => {
    const row = database.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name) as { type: string; sql: string };
    const next = row.sql.replace(from, to);
    expect(next).not.toBe(row.sql);
    database.exec(`DROP ${row.type.toUpperCase()} ${name}`);
    database.exec(next);
  };
  const drift: [string, InventoryName[], (database: DatabaseSync) => void][] = [
    ["changed trigger literal", ["destination"], redefine("client_onboarding_destination_intent_exact", "project-alpha:secondary", "project-alpha:tertiary")],
    ["changed literal case", ["destination"], redefine("client_onboarding_destination_intent_exact", "'array'", "'Array'")],
    ["comment marker added inside a literal", ["destination"], redefine("client_onboarding_destination_intent_exact",
      "'invalid onboarding destination intent'", "'invalid onboarding destination intent -- reviewed'")],
    ["changed trigger number", ["destination"], redefine("client_onboarding_destination_intent_exact", "BETWEEN 1 AND 2", "BETWEEN 1 AND 3")],
    ["trigger body commented out", ["target", "mail"], redefine("client_onboarding_target_approval_held", /BEGIN[\s\S]*END$/,
      "BEGIN SELECT 1; /* original body */ END")],
    ["changed trigger timing", ["target", "mail"], redefine("client_onboarding_target_approval_held", "BEFORE INSERT", "AFTER INSERT")],
    ["weakened view predicate", ["target", "mail"], redefine("client_onboarding_live_issuances", "admission.active=1", "admission.active=0")],
    ["view predicate hidden in a comment", ["target", "mail"], redefine("client_onboarding_live_issuances",
      "AND admission.bound_access_subject=invitation.bound_access_subject", "/* AND admission.bound_access_subject=invitation.bound_access_subject */")],
    ["added column", ["target", "mail"], database => database.exec("ALTER TABLE client_onboarding_target_proofs ADD COLUMN unreviewed TEXT")],
    ["renamed column", ["target", "mail"], database => database.exec(
      "ALTER TABLE client_onboarding_issuance_commands RENAME COLUMN target_intent_json TO renamed_target_intent_json")],
    ["missing trigger", ["target", "mail"], database => database.exec("DROP TRIGGER client_onboarding_handoffs_no_delete")],
    ["missing destination trigger", ["target", "destination", "mail"], database => database.exec("DROP TRIGGER client_onboarding_destination_approval_exact")],
    ["missing index", ["target", "mail"], database => database.exec("DROP INDEX client_onboarding_invitations_issuer")],
    ["extra index", ["target", "mail"], database => database.exec("CREATE INDEX unreviewed ON client_onboarding_handoffs(expires_at)")],
    ["index made unique", ["target", "mail"], redefine("client_onboarding_invitations_issuer", "CREATE INDEX", "CREATE UNIQUE INDEX")],
    ["extra trigger", ["target", "mail"], database => database.exec(
      "CREATE TRIGGER unreviewed AFTER INSERT ON client_onboarding_invitations BEGIN SELECT 1; END")],
    ["missing outbox trigger", ["mail"], database => database.exec("DROP TRIGGER client_onboarding_invite_mail_transition")],
    ["trigger body kept only as a comment", ["mail"], redefine("client_onboarding_invite_mail_no_delete",
      /BEGIN[\s\S]*END$/, "BEGIN SELECT 'kept'; -- RAISE(ABORT,'immutable')\nEND")],
  ];
  it.each(drift)("refuses real drift: %s", async (_label, names, change) => {
    for (const database of [stripped, source]) {
      database.exec("SAVEPOINT drift");
      try {
        change(database);
        for (const name of names)
          await expect(fences[name](d1(database))).rejects.toThrow("client_onboarding_target_schema_unavailable");
      } finally { database.exec("ROLLBACK TO drift; RELEASE drift"); }
    }
  });

  it.each([
    ["CHECK constraint", "client_onboarding_invite_mail_outbox", /CHECK ?\(/, "CHECK(1 OR "],
    ["NOT NULL", "client_onboarding_issuance_commands", " NOT NULL", ""],
    ["column type", "client_onboarding_target_proofs", " TEXT", " BLOB"],
    ["table option", "client_onboarding_target_proofs", /$/, " STRICT"],
  ] as const)("a changed table %s gives a different digest", async (_label, name, from, to) => {
    for (const database of [stripped, source]) {
      const rows = await inventory(database, "mail");
      const changed = rows.map(row => row[1] === name && row[0] === "table"
        ? [row[0], row[1], row[2], String(row[3]).replace(from, to)] as const : row);
      expect(changed).not.toEqual(rows);
      expect(canonicalDigest(changed)).not.toBe(CLIENT_ONBOARDING_SCHEMA_PINS.mail);
    }
  });

  it("treats comments and formatting between tokens as nothing, wherever they appear", async () => {
    for (const name of NAMES) {
      const rows = (await inventory(stripped, name)).map(row => {
        if (row[0] === "column" || typeof row[3] !== "string") return row;
        // Every gap: line comment, block comment, CRLF, tab.
        return [row[0], row[1], row[2], sqliteSchemaTokens(row[3]).map((token, index) =>
          token + [" -- note 'x' \"y\" /* z\n", "/* note -- 'x' */", "\r\n", "\t\f "][index % 4]).join("")] as const;
      });
      expect(canonicalDigest(rows)).toBe(CLIENT_ONBOARDING_SCHEMA_PINS[name]);
    }
  });

  it("splits tokens as SQLite does: a one-space rejoin of every object still compiles to the same inventory", async () => {
    for (const row of await inventory(source, "mail")) {
      if (typeof row[3] !== "string" || row[0] === "table") continue;
      const rejoined = sqliteSchemaTokens(row[3]).join(" ");
      source.exec("SAVEPOINT rejoin");
      try {
        source.exec(`DROP ${row[0].toUpperCase()} "${row[1]}"`);
        source.exec(rejoined);
        await expect(mailIssuanceSchemaFence(d1(source)), row[1]).resolves.toBeDefined();
      } finally { source.exec("ROLLBACK TO rejoin; RELEASE rejoin"); }
    }
  });

  it("never alters string literals or quoted identifiers", () => {
    const table = (value: string) => `CREATE TABLE t(a TEXT DEFAULT ${value})`;
    for (const [left, right] of [["'a--b'", "'a'"], ["'a/*b*/c'", "'ac'"], ["'a  b'", "'a b'"], ["'a\r\nb'", "'a\nb'"],
      ["'A'", "'a'"], ["'it''s'", "'it' 's'"], ["'x'", '"x"'], ["x'ab'", "X'AB'"], ["'1'", "1"], ["1", "1.0"]] as const)
      expect(same("table", "t", table(left), table(right)), `${left} vs ${right}`).toBe(false);
    expect(sqliteSchemaTokens("'a -- b' \"c /* d */\" [e -- f] `g``h`")).toEqual(["'a -- b'", '"c /* d */"', "[e -- f]", "`g``h`"]);
  });

  it("normalizes quoting only for the declared object name", () => {
    for (const quoted of ['"t"', "[t]", "`t`"]) expect(same("table", "t", `CREATE TABLE ${quoted}(a)`, "CREATE TABLE t(a)")).toBe(true);
    // Elsewhere a quoted word may be a string, a keyword or a differently resolved name.
    expect(same("table", "t", 'CREATE TABLE t("a")', "CREATE TABLE t(a)")).toBe(false);
    expect(same("table", "t", "CREATE TABLE t(a, CHECK(a='b'))", 'CREATE TABLE t(a, CHECK(a="b"))')).toBe(false);
    expect(same("trigger", "r", "CREATE TRIGGER r INSERT ON t BEGIN SELECT 1; END", 'CREATE TRIGGER r INSERT ON "t" BEGIN SELECT 1; END', "t")).toBe(false);
    for (const sql of ["CREATE TABLE T(a)", 'CREATE TABLE "other"(a)', "CREATE TABLE 't'(a)", "CREATE VIEW t AS SELECT 1", "CREATE TEMP TABLE t(a)"])
      expect(() => canonicalSqliteSchemaTuple(object("table", "t", sql)), sql).toThrow("sqlite_schema_text_unrecognized");
  });

  it.each([
    ["different word", "table", "t", "CREATE TABLE u(a)"],
    ["different case", "table", "t", 'CREATE TABLE "T"(a)'],
    ["extra space inside the quotes", "table", "t", 'CREATE TABLE "t "(a)'],
    ["prefix only", "table", "t", "CREATE TABLE [t_old](a)"],
    ["escaped quote left escaped", "table", 'a""b', 'CREATE TABLE "a""b"(x)'],
    ["bracket text is not unescaped", "table", "a]b", "CREATE TABLE [a]]b](x)"],
    ["empty quoted name", "table", "t", 'CREATE TABLE ""(a)'],
    ["quotes kept in the row name", "table", '"t"', 'CREATE TABLE "t"(a)'],
    ["schema qualifier", "table", "t", "CREATE TABLE main.t(a)"],
    ["trigger named like another trigger", "trigger", "r", 'CREATE TRIGGER "s" INSERT ON t BEGIN SELECT 1; END'],
    ["trigger named like its table", "trigger", "r", "CREATE TRIGGER t INSERT ON t BEGIN SELECT 1; END"],
    ["view", "view", "v", "CREATE VIEW `w` AS SELECT 1 AS a"],
    ["index", "index", "i", 'CREATE INDEX "j" ON t(a)'],
    ["unique index", "index", "i", "CREATE UNIQUE INDEX [j] ON t(a)"],
  ])("refuses a declared name that is not exactly the row name: %s", (_label, type, name, sql) => {
    expect(() => canonicalSqliteSchemaTuple(object(type, name, sql, "t"))).toThrow("sqlite_schema_text_unrecognized");
  });

  it("decodes a declared name exactly once", () => {
    for (const sql of ['CREATE TABLE "a""b"(x)', 'CREATE TABLE [a"b](x)', 'CREATE TABLE `a"b`(x)'])
      expect(canonicalSqliteSchemaTuple(object("table", 'a"b', sql))[3]).toEqual(["CREATE", "TABLE", null, "(", "x", ")"]);
  });

  it("never applies the declared-name exception to a later use of the same quoted text", () => {
    const pairs: [string, string, string, string][] = [
      ["table", "t", "CREATE TABLE t(a, CHECK(a<>'t'))", 'CREATE TABLE t(a, CHECK(a<>"t"))'],
      ["table", "t", "CREATE TABLE t(a, CHECK(t.a>0))", 'CREATE TABLE t(a, CHECK("t".a>0))'],
      ["table", "t", "CREATE TABLE t(a DEFAULT t)", 'CREATE TABLE t(a DEFAULT "t")'],
      ["table", "t", "CREATE TABLE t(a DEFAULT 't')", 'CREATE TABLE t(a DEFAULT "t")'],
      ["table", "t", "CREATE TABLE t(a REFERENCES t(a))", "CREATE TABLE t(a REFERENCES [t](a))"],
      ["table", "t", "CREATE TABLE t(t)", "CREATE TABLE t(`t`)"],
      ["trigger", "r", "CREATE TRIGGER r INSERT ON t BEGIN SELECT RAISE(ABORT,'r'); END", 'CREATE TRIGGER r INSERT ON t BEGIN SELECT RAISE(ABORT,"r"); END'],
      ["trigger", "r", "CREATE TRIGGER r INSERT ON t WHEN NEW.a='r' BEGIN SELECT 1; END", 'CREATE TRIGGER r INSERT ON t WHEN NEW.a="r" BEGIN SELECT 1; END'],
      ["trigger", "r", "CREATE TRIGGER r INSERT ON t WHEN NEW.a BEGIN SELECT 1; END", 'CREATE TRIGGER r INSERT ON t WHEN NEW."a" BEGIN SELECT 1; END'],
      ["view", "v", "CREATE VIEW v AS SELECT a AS v FROM t WHERE a=v", 'CREATE VIEW v AS SELECT a AS v FROM t WHERE a="v"'],
      ["view", "v", "CREATE VIEW v AS SELECT true AS a", "CREATE VIEW v AS SELECT [true] AS a"],
      ["view", "v", "CREATE VIEW v AS SELECT current_timestamp AS a", 'CREATE VIEW v AS SELECT "current_timestamp" AS a'],
      ["index", "i", "CREATE INDEX i ON t(i)", 'CREATE INDEX i ON t("i")'],
      ["index", "i", "CREATE INDEX i ON t(a) WHERE a='i'", 'CREATE INDEX i ON t(a) WHERE a="i"'],
    ];
    for (const [type, name, left, right] of pairs) {
      expect(same(type, name, left, right, "t"), right).toBe(false);
      // Quoting the declared name as well must not hide the difference.
      expect(same(type, name, left.replace(/^(CREATE \w+) (\w+)/, '$1 "$2"'), right, "t"), right).toBe(false);
    }
  });

  it.each([
    ["virtual table", "table", "t", "CREATE VIRTUAL TABLE t USING fts5(a)"],
    ["temporary table", "table", "t", "CREATE TEMPORARY TABLE t(a)"],
    ["temporary trigger", "trigger", "t", "CREATE TEMP TRIGGER t INSERT ON u BEGIN SELECT 1; END"],
    ["IF NOT EXISTS", "table", "t", "CREATE TABLE IF NOT EXISTS t(a)"],
    ["lower-case header", "table", "t", "create table t(a)"],
    ["row type and statement kind differ", "trigger", "t", "CREATE VIEW t AS SELECT 1 AS a"],
    ["leading statement", "table", "t", "SELECT 1; CREATE TABLE t(a)"],
    ["no name", "table", "t", "CREATE TABLE"],
    ["empty text", "table", "t", ""],
    ["comment only", "table", "t", "-- CREATE TABLE t(a)"],
    ["unique table", "table", "t", "CREATE UNIQUE TABLE t(a)"],
    ["named variable", "view", "t", "CREATE VIEW t AS SELECT :a AS a"],
    ["at variable", "view", "t", "CREATE VIEW t AS SELECT @a AS a"],
    ["dollar variable", "view", "t", "CREATE VIEW t AS SELECT $a AS a"],
    ["backslash", "view", "t", "CREATE VIEW t AS SELECT \\ AS a"],
    ["lone exclamation mark", "view", "t", "CREATE VIEW t AS SELECT ! 1 AS a"],
    ["digit separator", "view", "t", "CREATE VIEW t AS SELECT 1_000 AS a"],
    ["incomplete exponent", "view", "t", "CREATE VIEW t AS SELECT 1e AS a"],
    ["unterminated bracket", "table", "t", "CREATE TABLE t([a)"],
    ["unterminated backtick", "table", "t", "CREATE TABLE t(`a)"],
    ["opening comment only", "table", "t", "CREATE TABLE t(a)/*/"],
  ])("fails closed on an unsupported form: %s", (_label, type, name, sql) => {
    expect(() => canonicalSqliteSchemaTuple(object(type, name, sql, "t"))).toThrow("sqlite_schema_text_unrecognized");
  });

  it("the shipped fences fail closed, with their one error, when any pinned row is unsupported or misnamed", async () => {
    const changes: ((row: SqliteSchemaTuple) => unknown)[] = [
      row => [row[0], `${row[1]}_other`, row[2], row[3]],
      row => [row[0], row[1], `${row[2]}_other`, row[3]],
      row => [row[0], row[1], row[2], String(row[3]).replace(row[1], `"${row[1]}_other"`)],
      row => [row[0], row[1], row[2], `${String(row[3])} \\`],
      row => [row[0], row[1], row[2], `${String(row[3])}; SELECT 1`],
      row => [row[0], row[1], row[2], null],
      row => [row[0], row[1], row[2]],
      () => null,
    ];
    for (const name of NAMES) {
      const rows = await inventory(source, name);
      const reply = (text: string) => ({ prepare: () => ({ first: async () => text, bind: () => ({}) }) }) as unknown as Pick<D1Database, "prepare">;
      // Control: the same shim with the unmodified rows is accepted.
      await expect(fences[name](reply(JSON.stringify(rows)))).resolves.toBeDefined();
      const at = rows.findIndex(row => row[0] === "trigger");
      for (const change of changes)
        await expect(fences[name](reply(JSON.stringify(rows.map((row, index) => index === at ? change(row) : row)))))
          .rejects.toThrow("client_onboarding_target_schema_unavailable");
      for (const text of ["", "{}", "null", "[]", "not json", JSON.stringify([...rows, rows[at]]), JSON.stringify([...rows].reverse())])
        await expect(fences[name](reply(text)), text.slice(0, 20)).rejects.toThrow("client_onboarding_target_schema_unavailable");
    }
  });
  it("follows SQLite comment boundaries", () => {
    // A lone CR does not end a line comment, so the constraint is really gone.
    expect(same("table", "t", "CREATE TABLE t(a --x\rCHECK(a)\n)", "CREATE TABLE t(a)")).toBe(true);
    expect(same("table", "t", "CREATE TABLE t(a --x\nCHECK(a)\n)", "CREATE TABLE t(a)")).toBe(false);
    expect(same("table", "t", "CREATE TABLE t(a /*/ CHECK(a) */)", "CREATE TABLE t(a)")).toBe(true);
    expect(same("table", "t", "CREATE TABLE t(a /* /* */ CHECK(a))", "CREATE TABLE t(a CHECK(a))")).toBe(true);
    // SQLite itself agrees about which of these still has the constraint.
    for (const [sql, constrained] of [["CREATE TABLE t(a --x\rCHECK(a)\n)", false], ["CREATE TABLE t(a --x\nCHECK(a)\n)", true],
      ["CREATE TABLE t(a /*/ CHECK(a) */)", false], ["CREATE TABLE t(a /* /* */ CHECK(a))", true]] as const) {
      const database = new DatabaseSync(":memory:");
      database.exec(sql);
      if (constrained) expect(() => database.exec("INSERT INTO t VALUES(0)"), sql).toThrow("CHECK constraint failed");
      else database.exec("INSERT INTO t VALUES(0)");
      database.close();
    }
    expect(same("table", "t", "CREATE TABLE t(a DEFAULT(1- -1))", "CREATE TABLE t(a DEFAULT(1 + 1))")).toBe(false);
    expect(sqliteSchemaTokens("a->>'$.b'||c<>1.5e3")).toEqual(["a", "->>", "'$.b'", "||", "c", "<>", "1.5e3"]);
    expect(sqliteSchemaTokens("ab a/**/b")).toEqual(["ab", "a", "b"]);
  });

  it.each([["unterminated block comment", "CREATE TABLE t(a) /* x"], ["unterminated string", "CREATE TABLE t(a DEFAULT 'x)"],
    ["unterminated identifier", 'CREATE TABLE t("a)'], ["NUL", "CREATE TABLE t(a\u0000)"], ["NUL in a literal", "CREATE TABLE t(a DEFAULT '\u0000')"],
    ["BOM", "CREATE TABLE t(\ufeffa)"], ["vertical tab", "CREATE TABLE t(a\v)"], ["bound variable", "CREATE TABLE t(a DEFAULT ?1)"],
    ["malformed number", "CREATE TABLE t(a DEFAULT 1abc)"], ["malformed blob", "CREATE TABLE t(a DEFAULT x'abc')"],
  ])("refuses unrecognized text: %s", (_label, sql) => {
    expect(() => canonicalSqliteSchemaTuple(object("table", "t", sql))).toThrow("sqlite_schema_text_unrecognized");
  });

  it("refuses rows that are not schema tuples", () => {
    for (const row of [["table", "t", "t"], ["table", "t", "t", null], ["index", "t_a", "t", null], ["other", "t", "t", "CREATE TABLE t(a)"],
      ["column", "a", "t", "[1]"], ["table", 1, "t", "CREATE TABLE t(a)"]])
      expect(() => canonicalSqliteSchemaTuple(row as unknown as SqliteSchemaTuple)).toThrow("sqlite_schema_text_unrecognized");
    expect(() => canonicalSqliteSchemaInventory({})).toThrow("sqlite_schema_text_unrecognized");
  });

  it("keeps the canonical encoding unambiguous", () => {
    expect(canonicalDigest([object("table", "t", "CREATE TABLE t(a,b)")])).not.toBe(canonicalDigest([object("table", "t", "CREATE TABLE t(ab)")]));
    const [left, right] = [object("table", "t", "CREATE TABLE t(a)"), object("table", "u", "CREATE TABLE u(a)")];
    expect(new Set([[left, right], [right, left], [left], [left, left]].map(canonicalDigest)).size).toBe(4);
    expect(canonicalSqliteSchemaInventory([])).toBe(`["${SQLITE_SCHEMA_CANONICAL_VERSION}",[]]`);
  });
});
