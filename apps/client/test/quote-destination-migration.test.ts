import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary";
const secondary = "project-alpha:secondary";
const at = "2026-08-26T12:34:56.789Z";
const payloadHash = "f".repeat(64);
const destinationHash = "d".repeat(64);
const endpoint = "https://alpha.example/api/v2/integrations/ltds/draft-quotes";
const payload = '{ "note": "Élevation  \\u00e9", "version": 1.0 }';
const tables = ["client_accounts", "client_identity_links", "client_account_members", "client_service_requests",
  "request_revisions", "client_service_request_area_revisions", "client_service_request_services",
  "client_portal_notification_outbox", "request_admin_audit", "audit_log", "request_pa_draft_quote_receipts"] as const;
type Row = Record<string, unknown>;
type Snapshot = Record<typeof tables[number], Row[]>;
interface CommandOptions {
  requestId?: string;
  revision?: number;
  areaRevision?: number;
  source?: string;
  endpoint?: string;
  applicationKey?: string;
  origin?: string;
  destinationHash?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  payload?: string;
}

describe("source-bound quote destination populated migration", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let before: Snapshot;
  let after: Snapshot;
  let oldTriggers: Row[];
  let retainedTriggers: Row[];
  let oldReceiptFks: Row[];

  async function snapshot(): Promise<Snapshot> {
    const result = {} as Snapshot;
    for (const table of tables) {
      result[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Row>()).results
        .map(row => Object.fromEntries(Object.entries(row).filter(([column]) => !(table === "request_pa_draft_quote_receipts"
          && (column === "source_id" || column === "command_id"))).sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return result;
  }
  function command(id: string, options: CommandOptions = {}) {
    return db.prepare(`INSERT INTO request_pa_draft_quote_commands
      (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,
        destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, options.requestId ?? "new-request", options.revision ?? 1,
      options.areaRevision ?? 0, options.source ?? primary, options.endpoint ?? endpoint, options.applicationKey ?? "ltds",
      options.origin ?? "https://alpha.example", options.destinationHash ?? destinationHash,
      options.idempotencyKey ?? `quote-command-key-${id}`, options.payloadHash ?? payloadHash, options.payload ?? payload, "staff-original", at);
  }
  function receipt(id: string, commandId: string) {
    return db.prepare(`INSERT INTO request_pa_draft_quote_receipts
      (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
        project_alpha_artifact_public_id,document_number,artifact_status,artifact_version,editor_path,created_by,created_at,source_id,command_id)
      SELECT ?,request_id,request_revision,area_revision,idempotency_key,payload_hash,'remote-receipt','remote-quote',
        'DRAFT-001','draft',1,'/quotes/remote-quote/edit','staff-original',?,source_id,id
      FROM request_pa_draft_quote_commands WHERE id=?`).bind(id, at, commandId);
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('quote-destination-migration')}}",
      d1Databases: { DELIVERY_DB: "quote-destination-migration" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url))
      .filter(name => name.endsWith(".sql") && name < "0160_").sort();
    for (const name of names) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES('account','Original client','active')"),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('identity','account','https://issuer.test','subject','person@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account','identity','manager')"),
      ...(["historical-request", "new-request", "secondary-request"] as const).map(id => db.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status,catalog_source_id,created_at,updated_at)
        VALUES(?,'account','identity','service','Original title','Original request details',?,?,'under_review',?,?,?)`)
        .bind(id, `request-key-${id}`, "r".repeat(43), id === "secondary-request" ? secondary : primary, at, at)),
      ...([1, 2] as const).map(revision => db.prepare(`INSERT INTO request_revisions
        (id,request_id,revision_number,author_type,author_id,action,snapshot_json,created_at)
        VALUES(?,'historical-request',?,'client','identity','submitted',?,?)`).bind(`revision-${revision}`, revision, payload, at)),
      db.prepare(`INSERT INTO client_service_request_area_revisions
        (id,request_id,revision_number,base_request_updated_at,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint,created_at)
        VALUES('area-revision','historical-request',1,?,'[]','Original area review','Keep original area','staff-original','original-area-mutation',?,?)`)
        .bind(at, payloadHash, at),
      db.prepare(`INSERT INTO client_service_request_services
        (request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
        VALUES('historical-request',0,'service-a','v1',?,?,?)`).bind(payload, payload, primary),
      ...([1, 2] as const).map(revision => db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
          project_alpha_artifact_public_id,document_number,artifact_status,artifact_version,editor_path,scope_stale_at,created_by,created_at)
        VALUES(?,'historical-request',?,?,?, ?,?,?,?,'draft',1,?,?,?,?)`)
        .bind(`historical-receipt-${revision}`, revision, revision - 1, `historical-quote-key-${revision}`, payloadHash,
          `historical-pa-receipt-${revision}`, `historical-pa-quote-${revision}`, `DRAFT-${revision}`,
          `/quotes/historical-pa-quote-${revision}/edit`, revision === 2 ? at : null, "staff-original", at)),
      db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        VALUES('old-notice','historical-request','request_submitted','submitted','staff_triage','old-notice-key',?)`).bind(payload),
      db.prepare(`INSERT INTO request_admin_audit(request_id,actor_id,action,details_json,created_at)
        VALUES('historical-request','staff-original','pa_draft_quote_created',?,?)`).bind(payload, at),
      db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
        VALUES('staff','staff-original','client.service_request.pa_draft_quote_created','client_service_request','historical-request',?,?)`).bind(payload, at),
    ]);
    before = await snapshot();
    oldTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results;
    oldReceiptFks = (await db.prepare("PRAGMA foreign_key_list('request_pa_draft_quote_receipts')").all<Row>()).results;
    const sql = readFileSync(new URL("../migrations/0160_project_alpha_quote_destinations.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    after = await snapshot();
    const oldNames = new Set(oldTriggers.map(row => row.name));
    retainedTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results
      .filter(row => oldNames.has(row.name));
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("preserves populated receipt IDs, result fields, stale status, snapshots, audit and delivery history byte-for-byte", async () => {
    expect(after).toEqual(before);
    expect(retainedTriggers).toEqual(oldTriggers);
    expect(after.request_pa_draft_quote_receipts).toHaveLength(2);
    expect(after.request_pa_draft_quote_receipts.find(row => row.id === "historical-receipt-2")?.scope_stale_at).toBe(at);
    expect(after.request_revisions[0]?.snapshot_json).toBe(payload);
    expect(after.client_service_request_services[0]?.answers_json).toBe(payload);
    const retainedFks = (await db.prepare("PRAGMA foreign_key_list('request_pa_draft_quote_receipts')").all<Row>()).results
      .filter(row => row.table === "client_service_requests").map(({ id: _id, ...row }) => row);
    expect(retainedFks).toEqual(oldReceiptFks.map(({ id: _id, ...row }) => row));
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const checks = await db.batch<{ quick_check: string }>(tables.map(table => db.prepare(`PRAGMA quick_check('${table}')`)));
    expect(checks.map(result => result.results.map(row => row.quick_check))).toEqual(tables.map(() => ["ok"]));
  });

  it("leaves all historical destinations unknown instead of adopting today's origin or manufacturing commands", async () => {
    expect((await db.prepare("SELECT DISTINCT source_id,command_id FROM request_pa_draft_quote_receipts").all()).results)
      .toEqual([{ source_id: primary, command_id: null }]);
    expect(await db.prepare("SELECT COUNT(*) count FROM request_pa_draft_quote_commands").first("count")).toBe(0);
    const receiptDestination = await db.prepare(`SELECT receipt.id,command.editor_origin
      FROM request_pa_draft_quote_receipts receipt LEFT JOIN request_pa_draft_quote_commands command ON command.id=receipt.command_id
      WHERE receipt.id='historical-receipt-1'`).first();
    expect(receiptDestination).toEqual({ id: "historical-receipt-1", editor_origin: null });
  });

  it("reserves a source-bound command and joins its exact immutable destination to the completed receipt", async () => {
    await db.batch([command("completed"), receipt("completed-receipt", "completed")]);
    expect(await db.prepare(`SELECT receipt.source_id,command.command_endpoint,command.application_key,command.editor_origin,
      command.payload_json FROM request_pa_draft_quote_receipts receipt
      JOIN request_pa_draft_quote_commands command ON command.id=receipt.command_id WHERE receipt.id='completed-receipt'`).first())
      .toEqual({ source_id: primary, command_endpoint: endpoint, application_key: "ltds", editor_origin: "https://alpha.example", payload_json: payload });
  });

  it("allows independent source-owned requests but rejects cross-source and missing request parents", async () => {
    await db.batch([command("secondary", { requestId: "secondary-request", source: secondary,
      endpoint: "https://second.example/api/v2/integrations/ltds/draft-quotes", origin: "https://second.example" }),
    receipt("secondary-receipt", "secondary")]);
    // Remote artifact IDs can coincide in separate producers; local receipt IDs do not.
    expect(await db.prepare("SELECT COUNT(*) count FROM request_pa_draft_quote_receipts WHERE project_alpha_artifact_public_id='remote-quote'").first("count")).toBe(2);
    await expect(command("wrong-source", { source: secondary, revision: 2 }).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(command("orphan", { requestId: "missing-request" }).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("cannot change a journal's source, target, application, payload or owner by UPDATE, DELETE or REPLACE", async () => {
    const columns = ["id", "request_id", "request_revision", "area_revision", "source_id", "command_endpoint", "application_key",
      "editor_origin", "destination_fingerprint", "idempotency_key", "payload_hash", "payload_json", "created_by", "created_at"] as const;
    const changes = [
      ["source_id", secondary], ["command_endpoint", "https://changed.example/api/v2/integrations/ltds/draft-quotes"],
      ["application_key", "other_app"], ["editor_origin", "https://changed.example"], ["destination_fingerprint", "a".repeat(64)],
      ["payload_hash", "b".repeat(64)], ["payload_json", '{"changed":true}'], ["created_by", "other-staff"],
    ] as const;
    for (const [column, value] of changes) {
      await expect(db.prepare(`UPDATE request_pa_draft_quote_commands SET ${column}=? WHERE id='completed'`).bind(value).run()).rejects.toThrow(/immutable/);
      await expect(db.prepare(`INSERT OR REPLACE INTO request_pa_draft_quote_commands
        SELECT ${columns.map(name => name === column ? "?" : name).join(",")} FROM request_pa_draft_quote_commands WHERE id='completed'`)
        .bind(value).run()).rejects.toThrow(/identity conflicts/);
    }
    await expect(db.prepare("DELETE FROM request_pa_draft_quote_commands WHERE id='completed'").run()).rejects.toThrow();
    expect(await db.prepare("SELECT command_endpoint FROM request_pa_draft_quote_commands WHERE id='completed'").first("command_endpoint")).toBe(endpoint);
  });

  it("prevents another global handle from stealing either the revision identity or idempotency key", async () => {
    await expect(command("duplicate-revision").run()).rejects.toThrow(/identity conflicts/);
    await expect(command("duplicate-key", { revision: 8, idempotencyKey: "quote-command-key-completed" }).run()).rejects.toThrow(/identity conflicts/);
    await expect(db.prepare(`INSERT OR REPLACE INTO request_pa_draft_quote_commands
      SELECT 'thief',request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,
        destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by,created_at
      FROM request_pa_draft_quote_commands WHERE id='completed'`).run()).rejects.toThrow(/identity conflicts/);
    expect(await db.prepare("SELECT id FROM request_pa_draft_quote_commands WHERE request_id='new-request' AND request_revision=1 AND area_revision=0").first("id")).toBe("completed");
  });

  it("retains a pre-fetch reservation without a receipt and permits later exact recovery", async () => {
    await command("uncertain", { revision: 3 }).run();
    expect(await db.prepare("SELECT id FROM request_pa_draft_quote_receipts WHERE command_id='uncertain'").first()).toBeNull();
    const original = await db.prepare("SELECT * FROM request_pa_draft_quote_commands WHERE id='uncertain'").first();
    await db.prepare(`INSERT INTO request_pa_draft_quote_commands
      SELECT * FROM request_pa_draft_quote_commands WHERE id='uncertain' ON CONFLICT(id) DO NOTHING`).run();
    expect(await db.prepare("SELECT * FROM request_pa_draft_quote_commands WHERE id='uncertain'").first()).toEqual(original);
    await receipt("recovered-receipt", "uncertain").run();
    expect(await db.prepare("SELECT command_id FROM request_pa_draft_quote_receipts WHERE id='recovered-receipt'").first("command_id")).toBe("uncertain");
  });

  it("requires every new receipt to match a pre-existing command rather than only a coincident source or revision", async () => {
    await expect(db.prepare(`INSERT INTO request_pa_draft_quote_receipts
      (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
        project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,created_by)
      VALUES('unbound','new-request',4,0,'unbound-receipt-key',?,'remote','quote','draft',1,'/quotes/quote/edit','staff')`)
      .bind(payloadHash).run()).rejects.toThrow(/exact command/);
    await command("matching", { revision: 4 }).run();
    const columns = ["source_id", "request_id", "request_revision", "area_revision", "idempotency_key", "payload_hash", "command_id"] as const;
    for (const [index, column] of columns.entries()) {
      const values: Record<typeof columns[number], string | number> = { source_id: secondary, request_id: "secondary-request",
        request_revision: 100, area_revision: 100, idempotency_key: "changed-idempotency-key", payload_hash: "a".repeat(64), command_id: "missing-command" };
      await expect(db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
          project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,created_by,source_id,command_id)
        SELECT ?,${["request_id", "request_revision", "area_revision", "idempotency_key", "payload_hash"].map(name => name === column ? "?" : name).join(",")},
          'remote','quote','draft',1,'/quotes/quote/edit','staff',${column === "source_id" ? "?" : "source_id"},${column === "command_id" ? "?" : "id"}
        FROM request_pa_draft_quote_commands WHERE id='matching'`).bind(`mismatch-${index}`, values[column]).run()).rejects.toThrow(/exact command/);
    }
  });

  it("does not bind historical receipts to a new journal through UPDATE or same-ID REPLACE", async () => {
    await command("legacy-candidate", { requestId: "historical-request", revision: 1, idempotencyKey: "historical-quote-key-1" }).run();
    await expect(db.prepare("UPDATE request_pa_draft_quote_receipts SET command_id='legacy-candidate' WHERE id='historical-receipt-1'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare(`INSERT OR REPLACE INTO request_pa_draft_quote_receipts
      SELECT id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
        project_alpha_artifact_public_id,document_number,artifact_status,artifact_version,editor_path,scope_stale_at,
        created_by,created_at,source_id,'legacy-candidate' FROM request_pa_draft_quote_receipts WHERE id='historical-receipt-1'`).run()).rejects.toThrow(/identity conflicts/);
    expect(await db.prepare("SELECT command_id FROM request_pa_draft_quote_receipts WHERE id='historical-receipt-1'").first("command_id")).toBeNull();
  });

  it("does not allow completed result or stale-state rewrites and unique receipt-owner replacement", async () => {
    const columns = ["id", "request_id", "request_revision", "area_revision", "idempotency_key", "payload_hash",
      "project_alpha_receipt_id", "project_alpha_artifact_public_id", "document_number", "artifact_status", "artifact_version",
      "editor_path", "scope_stale_at", "created_by", "created_at", "source_id", "command_id"] as const;
    for (const [column, value] of [["id", "receipt-thief"], ["project_alpha_receipt_id", "other-receipt"],
      ["project_alpha_artifact_public_id", "other-quote"], ["editor_path", "/quotes/other-quote/edit"],
      ["scope_stale_at", at], ["artifact_version", 2]] as const) {
      await expect(db.prepare(`INSERT OR REPLACE INTO request_pa_draft_quote_receipts
        SELECT ${columns.map(name => name === column ? "?" : name).join(",")} FROM request_pa_draft_quote_receipts WHERE id='completed-receipt'`)
        .bind(value).run()).rejects.toThrow(/identity conflicts/);
    }
    expect(await db.prepare("SELECT project_alpha_artifact_public_id FROM request_pa_draft_quote_receipts WHERE id='completed-receipt'").first("project_alpha_artifact_public_id")).toBe("remote-quote");
  });

  it("rolls back the reservation and preceding request write if receipt proof fails", async () => {
    await expect(db.batch([db.prepare("UPDATE client_service_requests SET title='Must roll back' WHERE id='new-request'"),
      command("rollback", { revision: 9 }),
      db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
          project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,created_by,source_id,command_id)
        VALUES('rollback-receipt','new-request',9,0,'quote-command-key-rollback',?,'remote','quote','draft',1,'/quotes/quote/edit','staff',?,'rollback')`)
        .bind("a".repeat(64), primary),
    ])).rejects.toThrow(/exact command/);
    expect(await db.prepare("SELECT title FROM client_service_requests WHERE id='new-request'").first("title")).toBe("Original title");
    expect(await db.prepare("SELECT id FROM request_pa_draft_quote_commands WHERE id='rollback'").first()).toBeNull();
  });

  it("validates canonical sources, hex proofs and the UTF-8 body bound without storing credentials", async () => {
    for (const [index, source] of ["primary", "project-alpha:Upper", "project-alpha:x\n", "project-alpha:x\0hidden", `project-alpha:${"a".repeat(65)}`].entries())
      await expect(command(`bad-source-${index}`, { revision: 20 + index, source }).run()).rejects.toThrow();
    await expect(command("bad-hash", { revision: 30, payloadHash: "G".repeat(64) }).run()).rejects.toThrow();
    await expect(command("bad-destination", { revision: 30, destinationHash: "g".repeat(64) }).run()).rejects.toThrow();
    await expect(command("bad-json", { revision: 30, payload: "not-json" }).run()).rejects.toThrow();
    const exactBody = JSON.stringify({ x: "é".repeat((98304 - 8) / 2) });
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(98304);
    await command("bounded-body", { revision: 31, payload: exactBody }).run();
    await expect(command("oversized-body", { revision: 32, payload: JSON.stringify({ x: "é".repeat((98304 - 8) / 2 + 1) }) }).run()).rejects.toThrow();
    const columns = (await db.prepare("PRAGMA table_info('request_pa_draft_quote_commands')").all<{ name: string }>()).results.map(row => row.name);
    expect(columns).toEqual(["id", "request_id", "request_revision", "area_revision", "source_id", "command_endpoint", "application_key",
      "editor_origin", "destination_fingerprint", "idempotency_key", "payload_hash", "payload_json", "created_by", "created_at"]);
  });

  it("uses exact revision/key and receipt-command indexes and keeps foreign keys valid", async () => {
    const revisionPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM request_pa_draft_quote_commands
      WHERE request_id=? AND request_revision=? AND area_revision=?`).bind("new-request", 1, 0).all<{ detail: string }>();
    expect(revisionPlan.results.some(row => /SEARCH .*request_id=\? AND request_revision=\? AND area_revision=\?/.test(row.detail))).toBe(true);
    const keyPlan = await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM request_pa_draft_quote_commands WHERE idempotency_key=?")
      .bind("quote-command-key-completed").all<{ detail: string }>();
    expect(keyPlan.results.some(row => /SEARCH .*idempotency_key=\?/.test(row.detail))).toBe(true);
    const receiptPlan = await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM request_pa_draft_quote_receipts WHERE command_id=?")
      .bind("completed").all<{ detail: string }>();
    expect(receiptPlan.results.some(row => row.detail.includes("idx_request_pa_draft_quote_receipt_command"))).toBe(true);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db.prepare("PRAGMA quick_check('request_pa_draft_quote_commands')").all()).results).toEqual([{ quick_check: "ok" }]);
  });
});
