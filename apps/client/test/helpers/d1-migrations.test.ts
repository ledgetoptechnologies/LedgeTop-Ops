import { describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./d1-migrations";

describe("D1 migration statement boundaries", () => {
  it("preserves a trigger's inner statements, nested CASE and quoted semicolons as one batch statement", () => {
    const statements = splitD1MigrationStatements(`
      PRAGMA foreign_keys = ON;
      PRAGMA defer_foreign_keys = ON;
      -- A migration comment with a misleading END; separator.
      CREATE TRIGGER immutable_source BEFORE UPDATE ON example
      BEGIN
        SELECT CASE WHEN NEW.source_id IS NOT OLD.source_id
          THEN RAISE(ABORT, 'source; cannot change') END;
        INSERT INTO audit_log(message) VALUES('still inside; trigger');
      END;
      INSERT INTO example(source_id) VALUES('project-alpha:primary');
    `);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("PRAGMA defer_foreign_keys = ON");
    expect(statements[1]).toContain("CREATE TRIGGER immutable_source");
    expect(statements[1]).toContain("INSERT INTO audit_log(message) VALUES('still inside; trigger');");
    expect(statements[1]?.trimEnd()).toMatch(/END$/);
    expect(statements[2]).toBe("INSERT INTO example(source_id) VALUES('project-alpha:primary')");
  });

  it("does not strip comment-shaped text or terminators from stored SQL string literals", () => {
    const statements = splitD1MigrationStatements(`
      /* schema comment; */
      INSERT INTO snapshots(payload) VALUES('{"text":"-- keep; /* literal */"}');
      INSERT INTO snapshots(payload) VALUES('quote '' ; retained');
    `);
    expect(statements).toEqual([
      `INSERT INTO snapshots(payload) VALUES('{"text":"-- keep; /* literal */"}')`,
      "INSERT INTO snapshots(payload) VALUES('quote '' ; retained')",
    ]);
  });
});
