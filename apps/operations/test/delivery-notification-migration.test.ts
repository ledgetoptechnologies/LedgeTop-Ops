import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const directory = new URL("../../client/migrations/", import.meta.url);
const targetName = "0177_domain_neutral_delivery_notifications.sql";
const names = readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name)).sort();

function apply(db: DatabaseSync, name: string): void {
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("domain-neutral delivery notification migration", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const name of names) {
      if (name === targetName) break;
      apply(db, name);
    }
    db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix)
      VALUES('project','Client','Project','jobs/client/project/')`).run();
    db.prepare(`INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id,public_id,r2_prefix)
      VALUES('share','project','token-hash','staff','staff','public-identity','jobs/client/project/')`).run();
  });

  afterEach(() => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  function legacy(id: string, payload: string): void {
    db.prepare(`INSERT INTO delivery_notifications
      (id,dedupe_key,share_id,kind,recipient_email,payload_json)
      VALUES(?,?, 'share','share_created','client@example.test',?)`).run(id, `dedupe-${id}`, payload);
  }

  it("rewrites legacy URLs and malformed shapes to source identity only", () => {
    legacy("legacy-url", JSON.stringify({ projectName: "Project", shareUrl: "https://old.example/s/public-identity#bearer" }));
    legacy("existing-identity", JSON.stringify({ publicId: "saved-identity", projectName: "Project" }));
    legacy("invalid-json", "not-json");
    legacy("array-json", "[]");

    apply(db, targetName);

    const rows = db.prepare("SELECT id,payload_json FROM delivery_notifications ORDER BY id").all() as
      { id: string; payload_json: string }[];
    const payloads = Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.payload_json)]));
    expect(payloads["legacy-url"]).toEqual({ projectName: "Project", publicId: "public-identity" });
    expect(payloads["existing-identity"]).toEqual({ publicId: "saved-identity", projectName: "Project" });
    expect(payloads["invalid-json"]).toEqual({ publicId: "public-identity" });
    expect(payloads["array-json"]).toEqual({ publicId: "public-identity" });
    expect(JSON.stringify(payloads)).not.toContain("#bearer");
    expect(JSON.stringify(payloads)).not.toContain("shareUrl");
  });

  it("rejects fragment-bearing URL fields and non-object payloads after migration", () => {
    apply(db, targetName);
    expect(() => legacy("url", JSON.stringify({ publicId: "public-identity", shareUrl: "https://old.example/s/id#bearer" })))
      .toThrow(/materialized at send time/);
    expect(() => legacy("invalid", "not-json")).toThrow(/must be a JSON object/);
    expect(() => legacy("array", "[]")).toThrow(/must be a JSON object/);
    legacy("safe", JSON.stringify({ publicId: "public-identity", projectName: "Project" }));
    expect(db.prepare("SELECT COUNT(*) count FROM delivery_notifications").get()?.count).toBe(1);
  });
});
