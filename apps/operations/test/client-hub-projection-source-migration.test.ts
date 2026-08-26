import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("Client Hub source projection upgrade", () => {
  it("preserves populated primary keys/search/evidence and restricts secondary roots to business-only", () => {
    const db = new DatabaseSync(":memory:"), directory = new URL("../migrations/", import.meta.url);
    try {
      for (const name of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0034_").sort())
        db.exec("BEGIN;\n" + readFileSync(new URL(name, directory), "utf8") + "\nCOMMIT;");
      db.exec(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status,workspace_id)
        VALUES('project-alpha:primary','business','organization','42','Old primary','old primary','active','workspace');
        INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','business','organization','42','pa_client','7','contact','old contact');`);
      const roots = db.prepare("SELECT * FROM client_hub_roots").all(), search = db.prepare("SELECT * FROM client_hub_search_values").all();
      const revision = Number(db.prepare("SELECT revision FROM client_hub_directory_state").get()!.revision);
      db.exec("BEGIN;\n" + readFileSync(new URL("0034_client_hub_projection_sources.sql", directory), "utf8") + "\nCOMMIT;");
      expect(db.prepare("SELECT * FROM client_hub_roots").all()).toEqual(roots);
      expect(db.prepare("SELECT * FROM client_hub_search_values").all()).toEqual(search);
      expect(Number(db.prepare("SELECT revision FROM client_hub_directory_state").get()!.revision)).toBeGreaterThan(revision);
      const insert = db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status,workspace_id)
        VALUES(?,?,'organization','secondary-42','Secondary','secondary','active',?)`);
      expect(() => insert.run("project-alpha:secondary", "portal", null)).toThrow();
      expect(() => insert.run("project-alpha:secondary", "business", "workspace")).toThrow();
      insert.run("project-alpha:secondary", "business", null);
      expect(() => db.prepare("UPDATE client_hub_roots SET account_count=1 WHERE source_id='project-alpha:secondary'").run()).toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      db.exec("DELETE FROM client_hub_roots WHERE source_id='project-alpha:primary'");
      expect(db.prepare("SELECT count(*) n FROM client_hub_search_values").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
