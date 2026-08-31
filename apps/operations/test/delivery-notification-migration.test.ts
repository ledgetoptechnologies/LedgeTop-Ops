import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const directory = new URL("../../client/migrations/", import.meta.url);
const expand = "0177_domain_neutral_delivery_notifications.sql";
const contract = "0178_domain_neutral_delivery_notification_contract.sql";
const names = readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name)).sort();

function apply(db: DatabaseSync, name: string): void {
  db.exec("BEGIN");
  try { db.exec(readFileSync(new URL(name, directory), "utf8")); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

describe("domain-neutral delivery notification expand/contract migrations", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const name of names) { if (name === expand) break; apply(db, name); }
    db.exec(`INSERT INTO projects(id,client_name,project_name,r2_prefix)
      VALUES('project','Client','Project','jobs/client/project/');
      INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id,public_id,r2_prefix)
      VALUES('share','project','token-hash','staff','staff','public-identity','jobs/client/project/');`);
  });
  afterEach(() => { expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]); db.close(); });

  function legacy(id: string, payload: string, status = "queued"): void {
    db.prepare(`INSERT INTO delivery_notifications
      (id,dedupe_key,share_id,kind,recipient_email,payload_json,status)
      VALUES(?,?, 'share','share_created','client@example.test',?,?)`).run(id, `dedupe-${id}`, payload, status);
  }

  it("keeps old writers compatible during expand and aborts contract without a recoverable secret", () => {
    const url = "https://old.example/s/public-identity#abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    legacy("legacy-url", JSON.stringify({ projectName: "Project", shareUrl: url }));
    apply(db, expand);
    const expanded = JSON.parse(String(db.prepare("SELECT payload_json FROM delivery_notifications").get()?.payload_json));
    expect(expanded).toEqual({ projectName: "Project", shareUrl: url, publicId: "public-identity" });
    expect(() => legacy("old-writer", JSON.stringify({ shareUrl: url }))).not.toThrow();
    expect(() => apply(db, contract)).toThrow();
    expect(JSON.parse(String(db.prepare("SELECT payload_json FROM delivery_notifications WHERE id='legacy-url'").get()?.payload_json)).shareUrl).toBe(url);
    expect(() => legacy("still-compatible", JSON.stringify({ shareUrl: url }))).not.toThrow();
  });

  it("contracts safely after active legacy rows are recoverable and cleans all stored fragments", () => {
    const url = "https://old.example/s/public-identity#abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
    legacy("legacy-url", JSON.stringify({ projectName: "Project", shareUrl: url }));
    legacy("sent-history", "not-json", "sent");
    apply(db, expand);
    db.prepare("UPDATE shares SET secret_ciphertext='ciphertext',secret_iv='iv' WHERE id='share'").run();
    apply(db, contract);
    const payloads = db.prepare("SELECT payload_json FROM delivery_notifications ORDER BY id").all()
      .map(row => JSON.parse(String(row.payload_json)));
    expect(payloads).toEqual([
      { projectName: "Project", publicId: "public-identity" },
      { publicId: "public-identity" },
    ]);
    expect(JSON.stringify(payloads)).not.toContain("shareUrl");
    expect(JSON.stringify(payloads)).not.toContain("#");
  });

  it("rejects legacy writers and invalid payload shapes after contract", () => {
    apply(db, expand);
    apply(db, contract);
    expect(() => legacy("url", JSON.stringify({ publicId: "public-identity", shareUrl: "https://old.example/s/id#bearer" })))
      .toThrow(/materialized at send time/);
    expect(() => legacy("invalid", "not-json")).toThrow(/must be a JSON object/);
    expect(() => legacy("array", "[]")).toThrow(/must be a JSON object/);
    legacy("safe", JSON.stringify({ publicId: "public-identity", projectName: "Project" }));
    expect(db.prepare("SELECT COUNT(*) count FROM delivery_notifications").get()?.count).toBe(1);
  });
});
