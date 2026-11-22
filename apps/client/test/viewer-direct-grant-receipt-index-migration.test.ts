import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import grants from "../migrations/0237_viewer_direct_client_grants.sql?raw";
import immutability from "../migrations/0240_viewer_direct_grant_receipt_immutability.sql?raw";
import index from "../migrations/0246_viewer_direct_grant_receipt_lookup_index.sql?raw";

// Synthetic data only. The create-receipt lookup by grant must use the (grant_id, action) index, not a
// scan of the receipt ledger, both for the authority-pin read and as a correlated subquery per grant.
const PIN_READ = `SELECT response_json FROM viewer_direct_client_grant_mutation_receipts
  WHERE grant_id=? AND action='grant.create' ORDER BY created_at LIMIT 2`;
const CORRELATED = `SELECT count(*) n FROM viewer_direct_client_grants g WHERE g.source_id=? AND g.workspace_id=? AND g.status='active'
  AND (SELECT count(*) FROM viewer_direct_client_grant_mutation_receipts receipt WHERE receipt.grant_id=g.id AND receipt.action='grant.create')=1`;

function ledger(withIndex: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT,legacy_account_id TEXT);
    INSERT INTO portal_v2_workspaces VALUES('ws-one','project-alpha:primary','active',NULL),('ws-two','project-alpha:primary','active',NULL);`);
  db.exec(grants);db.exec(immutability);if(withIndex)db.exec(index);
  const now = "2026-11-22T00:00:00.000Z";
  const grant = db.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,
    include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
    VALUES(?,'project-alpha:primary',?,?,NULL,'project',1,1,0,0,NULL,1,'active','staff-one',?,?)`);
  const receipt = db.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts
    (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json,created_at) VALUES('staff-one',?,?,'fingerprint',?,'{}',?)`);
  db.exec("BEGIN");
  for (let n = 0; n < 2_000; n++) {
    const id = `grant-${n}`;grant.run(id, n % 2 ? "ws-one" : "ws-two", `project-${n}`, now, now);
    receipt.run(`create-${n}`, "grant.create", id, now);if (n % 3 === 0) receipt.run(`revoke-${n}`, "grant.revoke", id, now);
  }
  db.exec("COMMIT");
  return db;
}
const plan = (db: DatabaseSync, sql: string, ...values: string[]) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String((row as {detail: string}).detail)).join("\n");

it("adds only the receipt lookup index, leaving the ledger intact and immutable", () => {
  const db = ledger(true);
  try {
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check: "ok"});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA index_info(viewer_direct_client_grant_receipts_grant_action)").all().map(row => (row as {name: string}).name))
      .toEqual(["grant_id", "action"]);
    expect(db.prepare("SELECT count(*) n FROM viewer_direct_client_grant_mutation_receipts").get()).toEqual({n: 2_667});
    expect(() => db.prepare("DELETE FROM viewer_direct_client_grant_mutation_receipts WHERE grant_id='grant-1'").run()).toThrow(/immutable/);
  } finally { db.close(); }
});

it("locks the receipt lookups to the index instead of a ledger scan", () => {
  const before = ledger(false), after = ledger(true);
  try {
    expect(plan(before, PIN_READ, "grant-1")).toMatch(/SCAN receipt|SCAN viewer_direct_client_grant_mutation_receipts/);
    expect(plan(after, PIN_READ, "grant-1")).toMatch(/SEARCH viewer_direct_client_grant_mutation_receipts USING INDEX viewer_direct_client_grant_receipts_grant_action \(grant_id=\? AND action=\?\)/);
    expect(plan(before, CORRELATED, "project-alpha:primary", "ws-one")).toMatch(/SCAN receipt/);
    const correlated = plan(after, CORRELATED, "project-alpha:primary", "ws-one");
    expect(correlated).toMatch(/SEARCH receipt USING COVERING INDEX viewer_direct_client_grant_receipts_grant_action \(grant_id=\? AND action=\?\)/);
    expect(correlated).not.toMatch(/SCAN receipt/);
    expect(after.prepare(CORRELATED).get("project-alpha:primary", "ws-one")).toEqual(before.prepare(CORRELATED).get("project-alpha:primary", "ws-one"));
  } finally { before.close(); after.close(); }
});
