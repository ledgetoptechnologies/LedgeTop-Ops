import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const sourceId = "project-alpha:surface-generation";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpochId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function insertReceipt(db: D1Database, inventoryKind: "directory" | "project", requestId: string,
  generation: string, digest: string): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,
    request_id,authorization_generation,page_sha256,item_count
  ) VALUES(?,?,?,?,?,?,?,?,0)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId,
    inventoryKind, requestId, generation, digest).run();
}

async function runMigration(db: D1Database, name: string): Promise<void> {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

describe("Project Alpha API-v2 inventory authorization generations", () => {
  it("scopes regression checks per surface without rewriting immutable historical conflict evidence", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('local-test')}}", d1Databases: ["OPS_DB"] });
    try {
      const db = await runtime.getD1Database("OPS_DB") as D1Database;
      const prerequisites = `
        CREATE TABLE pa_clients(id TEXT PRIMARY KEY);
        CREATE TABLE pa_projects(id TEXT PRIMARY KEY);
        CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY);
        CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY);
        CREATE TABLE project_alpha_directory_mappings(
          source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
          resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
        CREATE TABLE project_alpha_project_mappings(
          source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
          external_project_id TEXT,project_alpha_public_id TEXT);`;
      await db.batch(splitD1MigrationStatements(prerequisites).map(statement => db.prepare(statement)));
      await runMigration(db, "0161_project_alpha_api_v2_inventory_observations.sql");

      await insertReceipt(db, "directory", "11111111-1111-4111-8111-111111111111", "48", "a".repeat(64));
      await insertReceipt(db, "project", "22222222-2222-4222-8222-222222222222", "7", "b".repeat(64));
      const historical = await db.prepare(`SELECT conflict_kind,details_json
        FROM project_alpha_api_v2_inventory_conflicts`).first();
      expect(historical).toEqual({ conflict_kind: "authorization_generation_regressed",
        details_json: JSON.stringify({ observedAuthorizationGeneration: "7", priorAuthorizationGeneration: "48" }) });

      await runMigration(db, "0165_project_alpha_inventory_generation_surface_scope.sql");
      await insertReceipt(db, "project", "33333333-3333-4333-8333-333333333333", "8", "c".repeat(64));
      expect(await db.prepare(`SELECT count(*) AS n FROM project_alpha_api_v2_inventory_conflicts`)
        .first<number>("n")).toBe(1);
      expect(await db.prepare(`SELECT conflict_kind,details_json FROM project_alpha_api_v2_inventory_conflicts`)
        .first()).toEqual(historical);

      await insertReceipt(db, "project", "44444444-4444-4444-8444-444444444444", "6", "d".repeat(64));
      const conflicts = await db.prepare(`SELECT conflict_kind,details_json
        FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id`).all();
      expect(conflicts.results).toEqual([
        historical,
        { conflict_kind: "authorization_generation_regressed",
          details_json: JSON.stringify({ observedAuthorizationGeneration: "6", priorAuthorizationGeneration: "8" }) },
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
