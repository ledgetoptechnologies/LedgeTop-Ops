import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL } from "../src/worker/client-portal/windows-portal-successor-candidate";
import { id, principal } from "./helpers/windows-portal-successor-fixture";

describe("successor candidate query against real Client schema", () => {
  it("stays within D1 expression depth and cannot infer authority from an empty schema", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DB: crypto.randomUUID() } });
    try {
      const db = await runtime.getD1Database("DB") as unknown as D1Database;
      for (const file of ["0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql",
        "0227_operations_portal_native_delivery_authority.sql"]) {
        const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
        await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
      }
      const query = db.prepare(WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL).bind(id(2), principal.issuer, principal.subject);
      expect(await query.first()).toBeNull();
      const plan = await db.prepare("EXPLAIN QUERY PLAN " + WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL)
        .bind(id(2), principal.issuer, principal.subject).all();
      expect(plan.success).toBe(true);
      expect(plan.results.length).toBeGreaterThan(0);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await runtime.dispose(); }
  });
});
