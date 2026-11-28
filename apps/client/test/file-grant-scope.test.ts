import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

// Hub 2496ea83, step A: single-file grants get a column, but nothing may create one yet,
// and every client-facing reader sees folder grants only.
describe("file grant scope column, closed until creation ships", { timeout: 60_000 }, () => {
  let runtime: Miniflare, db: D1Database;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: { DELIVERY_DB: "file-grant-scope" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    for (const name of readdirSync(fileURLToPath(new URL("../migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      if (statements.length) await db.batch(statements.map(s => db.prepare(s)));
    }
  });
  afterAll(async () => { await runtime?.dispose(); });

  it("adds a nullable object_path and a folder-only view", async () => {
    const columns = (await db.prepare("SELECT name FROM pragma_table_info('portal_v2_authenticated_delivery_grants')").all<{ name: string }>()).results.map(r => r.name);
    expect(columns).toContain("object_path");
    const view = await db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='portal_v2_folder_delivery_grants'").first<{ sql: string }>();
    expect(view?.sql.replace(/\s+/g, " ")).toMatch(/FROM portal_v2_authenticated_delivery_grants WHERE object_path IS NULL/i);
  });
  it("refuses to store a file grant, or to change a grant's scope, until creation ships", async () => {
    const triggers = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='portal_v2_authenticated_delivery_grants'").all<{ name: string; sql: string }>()).results;
    const closed = triggers.find(t => /BEFORE INSERT/i.test(t.sql) && /NEW\.object_path IS NOT NULL/i.test(t.sql));
    expect(closed?.sql).toMatch(/RAISE\(ABORT,\s*'file grants are not enabled'\)/);
    const immutable = triggers.find(t => /BEFORE UPDATE OF object_path/i.test(t.sql));
    expect(immutable?.sql).toMatch(/RAISE\(ABORT,\s*'object_path is immutable'\)/);
    // The column itself refuses absolute paths and folder-looking paths.
    const check = (await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='portal_v2_authenticated_delivery_grants'").first<{ sql: string }>())!.sql;
    expect(check).toMatch(/object_path TEXT CHECK/i);
  });
});

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
// Every reader that decides what a client can see, or tells a client about content, reads the folder-only view.
const CLIENT_FACING = [
  "apps/client/src/worker/client-portal/app-release-routes.ts",
  "apps/client/src/worker/client-portal/authenticated-content-audit.ts",
  "apps/client/src/worker/client-portal/authenticated-delivery-grants.ts",
  "apps/client/src/worker/client-portal/feedback-target.ts",
  "apps/client/src/worker/client-portal/native-feedback-target.ts",
  "apps/client/src/worker/client-portal/project-access-authority-history.ts",
  "apps/client/src/worker/verified-recipient-delivery-authority.ts",
  "packages/shared/src/authenticated-delivery-authority.ts",
];
// The Ops Worker's client notifications (change and expiry notices) move to exact-file matching in step B,
// in the same Ops deploy that first lets staff create a file grant.
describe("client-facing readers never see a file grant before it is enforced", () => {
  it.each(CLIENT_FACING)("%s reads grants only through the folder-only view", path => {
    const source = read(path);
    expect(source).toContain("portal_v2_folder_delivery_grants");
    // The base table may appear only as a schema-readiness name, never in a FROM/JOIN or as the table a query reads.
    expect(source).not.toMatch(/(FROM|JOIN)\s+portal_v2_authenticated_delivery_grants\b/);
    expect(source).not.toMatch(/["'`]portal_v2_authenticated_delivery_grants["'`]\s*:/);
    expect(source).not.toMatch(/\?\s*["'`]portal_v2_authenticated_delivery_grants["'`]/);
  });
});
