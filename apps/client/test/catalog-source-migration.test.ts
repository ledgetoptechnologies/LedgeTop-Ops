import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary";
const secondary = "project-alpha:secondary";
const timestamp = "2026-08-25T12:34:56.789Z";
// Deliberately retain whitespace, Unicode, escaped text, and numeric spellings.
// Parsing/re-serializing these payloads would invalidate old operation receipts.
const questions = '[ { "id": "note", "label": "Élevation \\u2014 notes", "type": "text", "required": false } ]';
const snapshot = '{ "publicId": "svc-existing", "sourceVersion": "v1", "name": "Élevation", "questions": [] }';
const answers = '{ "note": "Keep  two spaces / \\u00e9", "number": 1.0 }';
const draftJson = '{ "title": "Retained request", "services": [ { "publicId": "svc-existing", "sourceVersion": "v1" } ] }';
const receiptJson = '{ "version": 2, "draft": ' + draftJson + ' }';

const tables = [
  ["pa_service_catalog_items", "source_id"],
  ["pa_service_catalog_generations", "source_id"],
  ["pa_service_catalog_generation_pages", "source_id"],
  ["pa_service_catalog_generation_items", "source_id"],
  ["pa_service_catalog_checkpoint", "source_id"],
  ["pa_service_catalog_entity_state", "source_id"],
  ["pa_service_catalog_projection_receipts", "source_id"],
  ["pa_service_catalog_projection_audit", "source_id"],
  ["client_service_request_drafts", "catalog_source_id"],
  ["client_service_requests", "catalog_source_id"],
  ["client_service_request_draft_services", "service_source_id"],
  ["client_service_request_services", "service_source_id"],
  ["client_service_request_draft_mutations", null],
  ["client_accounts", null], ["client_identity_links", null], ["client_account_members", null],
  ["client_project_grants", null], ["client_portal_notification_outbox", null], ["audit_log", null],
] as const;
type Row = Record<string, unknown>;

describe("populated catalog source migration on the full D1 schema", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let before: Record<string, Row[]>;
  let after: Record<string, Row[]>;
  let sourceValues: Record<string, unknown[]>;
  let migrationStatementCount = 0;
  let existingTriggers: Row[];
  let preservedTriggers: Row[];

  function readMigration(name: string) {
    return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
  }
  async function migrateEarlier(name: string) {
    const sql = readMigration(name);
    const queries = splitD1MigrationStatements(sql);
    if (queries.length) await db.batch(queries.map(query => db.prepare(query)));
  }
  async function snapshotTables() {
    const result: Record<string, Row[]> = {};
    for (const [table, addedColumn] of tables) {
      const rows = (await db.prepare(`SELECT * FROM ${table}`).all<Row>()).results;
      result[table] = rows.map(row => Object.fromEntries(Object.entries(row)
        .filter(([column]) => column !== addedColumn && !(table === "pa_service_catalog_checkpoint" && column === "singleton"))
        .sort(([left], [right]) => left.localeCompare(right))))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return result;
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('migration-test'); } };",
      d1Databases: { DELIVERY_DB: "populated-catalog-source-migration" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort();
    const migrationName = names.find(name => name.startsWith("0156_"));
    if (!migrationName) throw new Error("Missing catalog source migration 0156");
    for (const name of names.filter(name => name < "0156_")) await migrateEarlier(name);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES('source-account','Retained client','active')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('source-identity','source-account','https://issuer.test','source-subject','source@example.test')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('source-account','source-identity','manager')"),
      db.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('source-project','Retained client','Retained project','Clients/Source/Project/')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('source-account','source-project',1)"),
      db.prepare(`INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status,created_at,updated_at)
        VALUES('source-request','source-account','source-project','source-identity','service','Retained request','Do not rewrite this request','source-request-key-0001',?,'submitted',?,?)`).bind("r".repeat(43), timestamp, timestamp),
      db.prepare(`INSERT INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        VALUES('source-notice','source-request','request_submitted','submitted','staff_triage','source-notice-dedupe',?)`).bind(receiptJson),
      ...["draft", "submitted"].map(state => db.prepare(`INSERT INTO client_service_request_drafts
        (id,account_id,project_id,created_by_identity_id,state,version,draft_json,create_idempotency_key,create_fingerprint,submitted_request_id,submit_idempotency_key,submit_fingerprint,last_mutation_key,created_at,updated_at,submitted_at)
        VALUES(?,'source-account','source-project','source-identity',?,2,?,?,?,?,?,?,?,?,?,?)`)
        .bind(`source-${state}`, state, draftJson, `source-create-key-${state}`, "c".repeat(43), state === "submitted" ? "source-request" : null,
          state === "submitted" ? "source-submit-key-0001" : null, state === "submitted" ? "s".repeat(43) : null,
          `source-mutation-key-${state}`, timestamp, timestamp, state === "submitted" ? timestamp : null)),
      ...["draft", "submitted"].map(state => db.prepare(`INSERT INTO client_service_request_draft_services
        (draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json) VALUES(?,0,'svc-existing','v1',?,?)`)
        .bind(`source-${state}`, snapshot, answers)),
      ...["draft", "submitted"].map(state => db.prepare(`INSERT INTO client_service_request_draft_mutations
        (draft_id,mutation_key,mutation_fingerprint,resulting_version,result_snapshot_json,created_at) VALUES(?,?,?,2,?,?)`)
        .bind(`source-${state}`, `source-mutation-key-${state}`, "m".repeat(43), receiptJson, timestamp)),
      db.prepare(`INSERT INTO client_service_request_services(request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json)
        VALUES('source-request',0,'svc-existing','v1',?,?)`).bind(snapshot, answers),
      ...["active", "staging"].map((status, index) => db.prepare(`INSERT INTO pa_service_catalog_generations
        (id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete,created_at,activated_at) VALUES(?,?,?, ?,1,1,?,?,?,?)`)
        .bind(`generation-${status}`, `generation-name-${status}`, index + 7, String(index + 1).repeat(64), status, status === "active" ? 1 : 0, timestamp, status === "active" ? timestamp : null)),
      ...["active", "staging"].map(status => db.prepare(`INSERT INTO pa_service_catalog_generation_pages
        (generation_id,page_number,item_count,payload_hash,received_at) VALUES(?,1,1,?,?)`)
        .bind(`generation-${status}`, "p".repeat(64), timestamp)),
      ...["active", "staging"].map(status => db.prepare(`INSERT INTO pa_service_catalog_generation_items
        (generation_id,page_number,public_id,source_version,name,summary,question_schema_json,category,display_order,geometry_requirement)
        VALUES(?,1,'svc-existing','v1','Élevation','Preserved summary',?,'Mapping',3,'optional')`).bind(`generation-${status}`, questions)),
      ...[0, 1].map(active => db.prepare(`INSERT INTO pa_service_catalog_items
        (public_id,source_version,name,summary,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence,category,display_order,geometry_requirement)
        VALUES('svc-existing',?,'Élevation','Preserved summary',?,?,?,?,'generation-name-active',7,'Mapping',3,'optional')`)
        .bind(active ? "v1" : "v0", questions, active, timestamp, timestamp)),
      db.prepare("UPDATE pa_service_catalog_checkpoint SET active_generation_id='generation-active',source_generation='generation-name-active',source_sequence=7,updated_at=? WHERE singleton=1").bind(timestamp),
      db.prepare("INSERT INTO pa_service_catalog_entity_state(public_id,source_version,source_sequence,active,updated_at) VALUES('svc-existing','v1',7,1,?)").bind(timestamp),
      db.prepare(`INSERT INTO pa_service_catalog_projection_receipts(delivery_id,delivery_kind,payload_hash,source_sequence,status,received_at,processed_at)
        VALUES('delivery-existing','snapshot_activate',?,7,'completed',?,?)`).bind("d".repeat(64), timestamp, timestamp),
      db.prepare(`INSERT INTO pa_service_catalog_projection_audit(id,action,delivery_id,source_generation,source_sequence,details_json,created_at)
        VALUES('audit-existing','snapshot_activated','delivery-existing','generation-name-active',7,?,?)`).bind(receiptJson, timestamp),
    ]);
    before = await snapshotTables();
    existingTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results;
    const sql = readMigration(migrationName);
    const queries = splitD1MigrationStatements(sql);
    migrationStatementCount = queries.length;
    // One real D1 transaction preserves deferred FK behavior during rebuilds.
    await db.batch(queries.map(query => db.prepare(query)));
    after = await snapshotTables();
    const namesBefore = new Set(existingTriggers.map(row => row.name));
    preservedTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results.filter(row => namesBefore.has(row.name));
    sourceValues = {};
    for (const [table, column] of tables) if (column) {
      sourceValues[table] = (await db.prepare(`SELECT DISTINCT ${column} source FROM ${table}`).all<{source: string}>()).results.map(row => row.source);
    }
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("retains every existing ID, timestamp, JSON byte string, receipt and authority row while assigning explicit primary source", async () => {
    expect(migrationStatementCount).toBeGreaterThan(10);
    expect(after).toEqual(before);
    expect(preservedTriggers).toEqual(existingTriggers);
    for (const [table, column] of tables) if (column) expect(sourceValues[table], table).toEqual([primary]);
    expect(after.pa_service_catalog_generations).toHaveLength(2);
    expect(after.client_service_request_drafts).toHaveLength(2);
    expect(after.client_service_request_draft_services?.[0]?.service_snapshot_json).toBe(snapshot);
    expect(after.client_service_request_services?.[0]?.answers_json).toBe(answers);
    expect(after.client_service_request_draft_mutations?.[0]?.result_snapshot_json).toBe(receiptJson);
    expect((await db.prepare("PRAGMA table_info(pa_service_catalog_checkpoint)").all<{name: string}>()).results.map(row => row.name)).not.toContain("singleton");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("allows colliding public versions, source generations, sequences and delivery receipts only across independent sources", async () => {
    await db.batch([
      db.prepare(`INSERT INTO pa_service_catalog_items(source_id,public_id,source_version,name,active,source_updated_at)
        VALUES(?,'svc-existing','v1','Secondary service',1,?)`).bind(secondary, timestamp),
      db.prepare(`INSERT INTO pa_service_catalog_generations(id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete)
        VALUES('generation-secondary',?,'generation-name-active',7,?,1,1,'active',1)`).bind(secondary, "z".repeat(64)),
      db.prepare("INSERT INTO pa_service_catalog_checkpoint(source_id,active_generation_id,source_generation,source_sequence) VALUES(?,'generation-secondary','generation-name-active',7)").bind(secondary),
      db.prepare("INSERT INTO pa_service_catalog_entity_state(source_id,public_id,source_version,source_sequence,active) VALUES(?,'svc-existing','v1',7,1)").bind(secondary),
      db.prepare(`INSERT INTO pa_service_catalog_projection_receipts(source_id,delivery_id,delivery_kind,payload_hash,source_sequence,status)
        VALUES(?,'delivery-existing','snapshot_activate',?,7,'completed')`).bind(secondary, "z".repeat(64)),
      db.prepare("UPDATE pa_service_catalog_items SET name='Secondary changed' WHERE source_id=? AND public_id='svc-existing'").bind(secondary),
      db.prepare("UPDATE pa_service_catalog_checkpoint SET source_sequence=9 WHERE source_id=?").bind(secondary),
    ]);
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-existing' AND active=1").bind(primary).first("name")).toBe("Élevation");
    expect(await db.prepare("SELECT source_sequence FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(primary).first("source_sequence")).toBe(7);
    expect(await db.prepare("SELECT payload_hash FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='delivery-existing'").bind(primary).first("payload_hash")).toBe("d".repeat(64));
    await expect(db.prepare("INSERT INTO pa_service_catalog_items(source_id,public_id,source_version,name,active,source_updated_at) VALUES(?,'svc-existing','v2','Duplicate active',1,?)").bind(primary, timestamp).run()).rejects.toThrow(/UNIQUE/i);
    await expect(db.prepare("INSERT INTO pa_service_catalog_projection_receipts(source_id,delivery_id,delivery_kind,payload_hash,source_sequence,status) VALUES(?,'delivery-existing','event',?,8,'ignored')").bind(primary, "e".repeat(64)).run()).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects cross-source generation children and checkpoints even when all raw identifiers exist", async () => {
    await expect(db.prepare("INSERT INTO pa_service_catalog_generation_pages(source_id,generation_id,page_number,item_count,payload_hash) VALUES(?,'generation-active',2,0,?)").bind(secondary, "a".repeat(64)).run()).rejects.toThrow(/FOREIGN KEY/i);
    await expect(db.prepare(`INSERT INTO pa_service_catalog_generation_items(source_id,generation_id,page_number,public_id,source_version,name)
      VALUES(?,'generation-active',1,'cross-source','v1','Wrong source')`).bind(secondary).run()).rejects.toThrow(/FOREIGN KEY/i);
    await expect(db.prepare("INSERT INTO pa_service_catalog_checkpoint(source_id,active_generation_id,source_generation,source_sequence) VALUES('project-alpha:third','generation-active','generation-name-active',7)").run()).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects draft and submitted service rows that disagree with their parent's catalog source and rolls back the entire batch", async () => {
    await expect(db.batch([
      db.prepare("UPDATE pa_service_catalog_items SET name='Must roll back' WHERE source_id=? AND public_id='svc-existing' AND active=1").bind(primary),
      db.prepare(`INSERT INTO client_service_request_draft_services(draft_id,ordinal,service_source_id,service_public_id,service_source_version,service_snapshot_json,answers_json)
        VALUES('source-draft',1,?,'another-service','v1',?,?)`).bind(secondary, snapshot, answers),
    ])).rejects.toThrow(/FOREIGN KEY/i);
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-existing' AND active=1").bind(primary).first("name")).toBe("Élevation");
    await expect(db.prepare(`INSERT INTO client_service_request_services(request_id,ordinal,service_source_id,service_public_id,service_source_version,service_snapshot_json,answers_json)
      VALUES('source-request',1,?,'another-service','v1',?,?)`).bind(secondary, snapshot, answers).run()).rejects.toThrow(/FOREIGN KEY/i);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("does not allow an empty draft or historical request to be relabelled to a different catalog source", async () => {
    await db.prepare(`INSERT INTO client_service_request_drafts
      (id,account_id,project_id,created_by_identity_id,draft_json,create_idempotency_key,create_fingerprint,last_mutation_key)
      VALUES('empty-draft','source-account','source-project','source-identity','{}','empty-draft-key-0001',?,'empty-mutation-key-0001')`).bind("a".repeat(43)).run();
    await db.prepare(`INSERT INTO client_service_requests
      (id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status)
      VALUES('empty-request','source-account','source-project','source-identity','service','Empty historical selection','Keep source provenance','empty-request-key-0001',?,'submitted')`).bind("e".repeat(43)).run();
    await expect(db.prepare("UPDATE client_service_request_drafts SET catalog_source_id=? WHERE id='empty-draft'").bind(secondary).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE client_service_requests SET catalog_source_id=? WHERE id='empty-request'").bind(secondary).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE client_service_requests SET catalog_source_id=? WHERE id='source-request'").bind(secondary).run()).rejects.toThrow();
    expect(await db.prepare("SELECT catalog_source_id FROM client_service_request_drafts WHERE id='empty-draft'").first("catalog_source_id")).toBe(primary);
    expect(await db.prepare("SELECT catalog_source_id FROM client_service_requests WHERE id='empty-request'").first("catalog_source_id")).toBe(primary);
  });

  it("uses source-leading indexes for ordered catalog browsing and exact checkpoint, receipt and child reads", async () => {
    const queries = [
      "SELECT public_id,source_version FROM pa_service_catalog_items WHERE source_id=? AND active=1 ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id LIMIT 100",
      "SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?",
      "SELECT * FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='delivery-existing'",
      "SELECT * FROM pa_service_catalog_entity_state WHERE source_id=? AND public_id='svc-existing'",
      "SELECT * FROM pa_service_catalog_generation_items WHERE source_id=? AND generation_id='generation-active' AND page_number=1 ORDER BY public_id",
    ];
    for (const query of queries) {
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(primary).all<{detail: string}>()).results.map(row => row.detail).join("\n");
      expect(plan, query).toMatch(/SEARCH .*USING (?:COVERING )?INDEX/i);
      expect(plan, query).toMatch(/source_id=\?/i);
      expect(plan, query).not.toMatch(/SCAN |USE TEMP B-TREE/i);
    }
  });
});
