import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { boundedGuardInsert, splitGuardConjunction } from "./staging-bounded-guards.mjs";

const table = "staging_native_authority_guard_0123456789abcdef0123";
test("retains nested conditions and escaped literals verbatim", () => {
  const source = "EXISTS(SELECT 1 WHERE 1=1 AND (2=2 OR 3=4)) AND 'x AND y'' OR z'= 'x AND y'' OR z' AND 1=1";
  assert.deepEqual(splitGuardConjunction(source), [
    "EXISTS(SELECT 1 WHERE 1=1 AND (2=2 OR 3=4))", "'x AND y'' OR z'= 'x AND y'' OR z'", "1=1",
  ]);
});
test("rejects unsupported top-level logic and malformed input", () => {
  for (const expression of ["", "1 OR 0", "1 BETWEEN 0 AND 2", "CASE WHEN 1 THEN 1 END", "1 AND", "AND 1", "(1", "1)", "'x", "1;SELECT 1", "1 --x", "1 /*x*/", "[x]=1"])
    assert.throws(() => splitGuardConjunction(expression));
  assert.throws(() => boundedGuardInsert("arbitrary_table", "1"));
});
test("every predicate and NULL fail closed and roll back earlier batch writes", () => {
  for (const predicate of ["0", "NULL", "1"]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE changes(value INTEGER); CREATE TABLE ${table}(ok INTEGER NOT NULL CHECK(ok=1));`);
      db.exec("BEGIN");
      let failed = false;
      try {
        db.exec(`INSERT INTO changes VALUES(1); ${boundedGuardInsert(table, `1 AND ${predicate} AND 1`)} COMMIT;`);
      } catch { failed = true; db.exec("ROLLBACK"); }
      assert.equal(failed, predicate !== "1");
      assert.equal(db.prepare("SELECT count(*) count FROM changes").get().count, failed ? 0 : 1);
      assert.equal(db.prepare(`SELECT count(*) count FROM ${table}`).get().count, failed ? 0 : 3);
    } finally { db.close(); }
  }
});
