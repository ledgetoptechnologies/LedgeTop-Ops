import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { ClientPortalSession } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

// Receipts are intentionally immutable. Give these tests their own database,
// not the catalog suite's DELETE-based per-test cleanup.
describe("primary current draft receipt read model", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let historicalDb: D1Database;
  let env: Env;
  let historicalEnv: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: {
        DELIVERY_DB: "receipt-reader", HISTORICAL_DB: "receipt-reader-pre0160",
      } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    historicalDb = await runtime.getD1Database("HISTORICAL_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
    for (const name of names) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
      if (name < "0160_" && statements.length)
        await historicalDb.batch(statements.map(sql => historicalDb.prepare(sql)));
    }
    env = { DELIVERY_DB: db } as Env;
    historicalEnv = { DELIVERY_DB: historicalDb } as Env;
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  async function request(account: string, identity: string, source = "project-alpha:primary") {
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id)
        VALUES(?,?,?,'service','Draft receipt test','Read-model fixture','submitted',?,?,?)`)
        .bind(id, account, identity, `request-${id}`, "a".repeat(43), source),
      db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES(?,?,1,'client',?,'submitted','{}')`).bind(`revision-${id}`, id, identity),
    ]);
    return id;
  }
  async function receipt(id: string, source = "project-alpha:primary", stale = false) {
    await db.batch([
      db.prepare(`INSERT INTO request_pa_draft_quote_commands
        (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
        VALUES(?,?,1,0,?,'https://alpha.example/api/drafts','operations','https://alpha.example',?,?,?,'{}','staff')`)
        .bind(`command-${id}`, id, source, "b".repeat(64), `command-key-${id}`, "c".repeat(64)),
      db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,scope_stale_at,created_by,source_id,command_id)
        VALUES(?,?,1,0,?,?,'receipt','draft','draft',1,'/drafts/draft',?,'staff',?,?)`)
        .bind(`receipt-${id}`, id, `command-key-${id}`, "c".repeat(64), stale ? "2026-09-01T00:00:00.000Z" : null, source, `command-${id}`),
    ]);
  }
  it.each(["current", "missing", "stale", "revision", "area", "other source", "revoked"] as const)("reads %s receipts without widening access", async scenario => {
    const suffix = crypto.randomUUID(), account = `account-${suffix}`, identity = `identity-${suffix}`;
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id) VALUES(?,'Fixture','active','project-alpha:primary')").bind(account),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,'https://issuer.test',?,'client@example.test')").bind(identity, account, suffix),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(account, identity),
    ]);
    const session: ClientPortalSession = { accountId: account, identityId: identity, displayName: "Fixture", role: "manager", canViewBilling: false };
    const id = await request(account, identity);
    if (scenario === "other source") {
      const foreign = await request(account, identity, "project-alpha:other");
      await receipt(foreign, "project-alpha:other");
      expect(await d1ClientPortalRepository.getServiceRequest(env, session, foreign)).toBeNull();
    } else if (scenario !== "missing") await receipt(id, "project-alpha:primary", scenario === "stale");
    if (scenario === "revision") await db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      VALUES(?,?,2,'staff','staff','staff_proposal','{}')`).bind(`revised-${id}`, id).run();
    if (scenario === "area") await db.prepare(`INSERT INTO client_service_request_area_revisions
      (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint)
      VALUES(?,?,1,'2026-08-01T00:00:00.000Z',NULL,'[]','Reviewed boundary','Changed area','staff',?,?)`)
      .bind(`area-${id}`, id, `area-key-${id}`, "d".repeat(64)).run();
    if (scenario === "revoked") await db.prepare("UPDATE client_account_members SET revoked_at=datetime('now') WHERE account_id=? AND identity_id=?").bind(account, identity).run();
    const result = await d1ClientPortalRepository.getServiceRequest(env, session, id);
    if (scenario === "revoked") expect(result).toBeNull();
    else {
      expect(result).not.toBeNull();
      expect(result?.projectAlphaDraftCreated).toBe(scenario === "current" ? true : undefined);
    }
  });

  it("keeps current work-area and stale-quote filtering on the real pre-0160 receipt schema", async () => {
    const account = "historical-account", identity = "historical-identity", requestId = "historical-request";
    await historicalDb.batch([
      historicalDb.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id) VALUES(?,'Historical fixture','active','project-alpha:primary')").bind(account),
      historicalDb.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES(?,?,'https://issuer.test','historical-subject','historical@example.test')`).bind(identity, account),
      historicalDb.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(account, identity),
      historicalDb.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id)
        VALUES(?,?,?,'service','Historical request','Pre-0160 receipt fixture','under_review','historical-request-key',?,'project-alpha:primary')`)
        .bind(requestId, account, identity, "h".repeat(43)),
      historicalDb.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES('historical-revision',?,1,'client',?,'submitted','{}')`).bind(requestId, identity),
      historicalDb.prepare(`INSERT INTO client_service_request_area_revisions
        (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint)
        VALUES('historical-area',?,1,'2026-08-01T00:00:00.000Z','{"type":"Polygon","coordinates":[]}','[]',
          'Reviewed boundary','Current reviewed area','staff','historical-area-key',?)`).bind(requestId, "a".repeat(64)),
      historicalDb.prepare(`INSERT INTO request_pa_artifacts
        (id,request_id,artifact_type,project_alpha_artifact_id,document_number,artifact_status,total_minor,currency,
          verification_fingerprint,verified_at,verified_by,scope_stale_at)
        VALUES('historical-stale-quote',?,'quote','pa-quote','QUOTE-OLD','accepted',987654,'USD',
          'historical-verification','2026-08-01T00:00:00.000Z','staff','2026-08-02T00:00:00.000Z')`).bind(requestId),
      historicalDb.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,
          project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,created_by)
        VALUES('historical-draft-receipt',?,1,1,'historical-draft-key',?,'pa-receipt','pa-draft','draft',1,'/drafts/pa-draft','staff')`)
        .bind(requestId, "d".repeat(64)),
    ]);
    const receiptColumns = (await historicalDb.prepare("PRAGMA table_info('request_pa_draft_quote_receipts')")
      .all<{ name: string }>()).results.map(column => column.name);
    expect(receiptColumns).not.toContain("source_id");

    const session: ClientPortalSession = { accountId: account, identityId: identity,
      displayName: "Historical fixture", role: "manager", canViewBilling: true };
    const result = await d1ClientPortalRepository.getServiceRequest(historicalEnv, session, requestId);
    expect(result).toMatchObject({ id: requestId, areaGeoJson: { type: "Polygon", coordinates: [] },
      workAreaRevision: { revisionNumber: 1, changeSummary: "Current reviewed area" }, acceptedQuote: null });
    expect(result).not.toHaveProperty("projectAlphaDraftCreated");
  });
});
