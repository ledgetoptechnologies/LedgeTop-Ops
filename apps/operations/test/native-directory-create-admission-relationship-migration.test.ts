import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare, db: D1Database;

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const migration of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0134").sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));
}, 240_000);

afterAll(async () => runtime.dispose());

describe("native Directory client-create relationship admission migration", () => {
  it("installs a durable immutable relationship assertion after the relationship outbox", async () => {
    const objects = (await db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name LIKE 'native_directory_create_admission_relationships%' ORDER BY type,name`).all<{
        type: string; name: string; sql: string;
      }>()).results;
    expect(objects.map(value => [value.type, value.name])).toEqual([
      ["table", "native_directory_create_admission_relationships"],
      ["trigger", "native_directory_create_admission_relationships_immutable"],
      ["trigger", "native_directory_create_admission_relationships_insert_guard"],
      ["trigger", "native_directory_create_admission_relationships_no_delete"],
    ]);
    expect(objects[0]!.sql).toContain("organization_record_version");
    expect(objects[1]!.sql).toContain("immutable");
    expect(objects[3]!.sql).toContain("durable");
    await expect(db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id) VALUES('missing','acquired:client:one')`).run()).rejects.toThrow();
  });
});
