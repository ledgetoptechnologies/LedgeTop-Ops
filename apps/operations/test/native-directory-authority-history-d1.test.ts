import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;

async function migrate() {
  const sql = readFileSync(new URL("../migrations/0123_native_directory_authority_history.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.exec(`
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,admitted_by TEXT,created_at TEXT,updated_at TEXT,version INTEGER);
    CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER,granted_by TEXT,created_at TEXT);
    CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions BEGIN SELECT 1; END;
    INSERT INTO native_staff_admissions VALUES('staff','access|staff',1,'owner','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1);
    INSERT INTO native_directory_grants VALUES('grant','staff','directory.profile.view','allow','global',NULL,NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z');
  `);
  await db.prepare(`CREATE TRIGGER native_directory_grants_identity BEFORE UPDATE ON native_directory_grants
    WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.permission IS NOT OLD.permission
    BEGIN SELECT RAISE(ABORT,'native grant identity is immutable'); END`).run();
  await migrate();
});
afterEach(async () => runtime.dispose());

describe("0123 native directory authority history", () => {
  it("backfills existing grants losslessly and appends a generation-fenced history on change", async () => {
    expect(await db.prepare("SELECT staff_id,generation FROM native_directory_grant_generations").first()).toEqual({ staff_id: "staff", generation: 1 });
    expect(await db.prepare("SELECT grant_id,grant_version,active,grant_generation FROM native_directory_grant_history").first())
      .toEqual({ grant_id: "grant", grant_version: 1, active: 1, grant_generation: 1 });
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='grant'").run();
    expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id='staff'").first("generation")).toBe(2);
    expect(await db.prepare("SELECT grant_version,active,grant_generation FROM native_directory_grant_history WHERE grant_id='grant' ORDER BY grant_version DESC LIMIT 1").first())
      .toEqual({ grant_version: 2, active: 0, grant_generation: 2 });
    await expect(db.prepare("UPDATE native_directory_grant_history SET active=1").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM native_directory_grants WHERE id='grant'").run()).rejects.toThrow(/durable/);
    await expect(db.prepare("DELETE FROM native_directory_grant_generations WHERE staff_id='staff'").run()).rejects.toThrow(/durable/);
  });

  it("keeps ordinary admission state transitions but rejects identity replacement", async () => {
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='staff'").run();
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id='staff'").first()).toEqual({ active: 0, version: 2 });
    await expect(db.prepare("UPDATE native_staff_admissions SET bound_access_subject='access|other',version=3 WHERE staff_id='staff'").run()).rejects.toThrow(/invalid/);
    await expect(db.prepare("UPDATE native_staff_admissions SET admitted_by='other',version=3 WHERE staff_id='staff'").run()).rejects.toThrow(/invalid/);
    await expect(db.prepare("DELETE FROM native_staff_admissions WHERE staff_id='staff'").run()).rejects.toThrow(/durable/);
  });

  it("starts a new staff grant history at generation one and retains existing grant identity guards", async () => {
    await db.prepare("INSERT INTO native_staff_admissions VALUES('new-staff','access|new-staff',1,'owner','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',1)").run();
    await db.prepare("INSERT INTO native_directory_grants VALUES('new-grant','new-staff','directory.profile.view','allow','global',NULL,NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z')").run();
    expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id='new-staff'").first("generation")).toBe(1);
    expect(await db.prepare("SELECT grant_version,grant_generation FROM native_directory_grant_history WHERE grant_id='new-grant'").first())
      .toEqual({ grant_version: 1, grant_generation: 1 });
    await expect(db.prepare("UPDATE native_directory_grants SET permission='directory.profile.edit' WHERE id='grant'").run()).rejects.toThrow(/identity/);
  });
});
