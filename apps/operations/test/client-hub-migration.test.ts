import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourcePublicIdExpression, validatedUniquePublicIdExpression } from "../src/worker/client-hub-source";

describe("Client Hub populated migration upgrade", () => {
  it("preserves legacy source data, indexes guarded mappings, and keeps directory state rebuildable", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const directory = new URL("../migrations/", import.meta.url);
      const target = "0032_client_hub_directory.sql";
      for (const migration of readdirSync(fileURLToPath(directory)).filter(name => /^\d+_.+\.sql$/.test(name) && name < target).sort())
        database.exec(readFileSync(new URL(migration, directory), "utf8"));

      const publicId = "0123456789abcdef0123456789abcdef";
      const payloads = [JSON.stringify({ public_id: publicId }), "{}", "null", '"legacy text"', "broken-json",
        '{"public_id":null}', '{"public_id":42}', '{"public_id":"not-a-public-id"}', JSON.stringify({ public_id: publicId })];
      for (const table of ["pa_organizations", "pa_clients"] as const) {
        const insert = database.prepare(`INSERT INTO ${table}(id,name,payload_json,last_sync_id,active) VALUES(?,?,?,'before-upgrade',?)`);
        payloads.forEach((payload, index) => insert.run(String(index), `Legacy ${index}`, payload, index === 8 ? 0 : 1));
      }
      database.prepare("UPDATE pa_clients SET organization_id='0' WHERE id IN ('0','1','8')").run();
      const before = ["pa_organizations", "pa_clients"].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

      database.exec(readFileSync(new URL(target, directory), "utf8"));
      expect(["pa_organizations", "pa_clients"].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
      expect(database.prepare("SELECT ready,revision,generation,backfill_phase FROM client_hub_directory_state").get())
        .toEqual({ ready: 0, revision: 0, generation: 1, backfill_phase: null });
      for (const table of ["pa_organizations", "pa_clients"] as const) {
        const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} source WHERE ${sourcePublicIdExpression("source") }=?`).all(publicId);
        expect(plan.some(row => String(row.detail).includes(`idx_${table}_client_hub_public_id`))).toBe(true);
        // Inactive duplicate IDs must not accidentally become a unique mapping.
        expect(database.prepare(`SELECT ${validatedUniquePublicIdExpression(table, "source")} public_id FROM ${table} source WHERE id='0'`).get())
          .toEqual({ public_id: null });
        expect(database.prepare(`SELECT ${sourcePublicIdExpression("source")} public_id FROM ${table} source WHERE id='4'`).get())
          .toEqual({ public_id: null });
      }
      const countPlan = database.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM pa_clients WHERE organization_id=? AND active=1").all("0");
      expect(countPlan.some(row => String(row.detail).includes("idx_pa_clients_client_hub_organization"))).toBe(true);
      expect(database.prepare("SELECT count(*) count FROM pa_clients WHERE organization_id='0' AND active=1").get()).toEqual({ count: 2 });

      database.exec(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
        VALUES('project-alpha:primary','business','organization','0','Legacy 0','legacy 0','active');
        INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','business','organization','0','pa_client','0','contact','legacy 0');`);
      expect(database.prepare("SELECT revision FROM client_hub_directory_state").get()).toEqual({ revision: 2 });
      database.exec("UPDATE client_hub_roots SET scan_generation=2,indexed_at='2026-08-25' WHERE public_id='0'");
      expect(database.prepare("SELECT revision FROM client_hub_directory_state").get()).toEqual({ revision: 2 });
      database.exec("DELETE FROM client_hub_roots WHERE public_id='0'");
      expect(database.prepare("SELECT count(*) count FROM client_hub_search_values").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT revision FROM client_hub_directory_state").get()).toEqual({ revision: 4 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      database.close();
    }
  });
});
