import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary";
const secondary = "project-alpha:secondary";
const at = "2026-08-26T12:34:56.789Z";
const fingerprint = "f".repeat(64);
const historicalJson = '{ "label": "Élevation  \\u00e9", "version": 1.0 }';
const tables = ["portal_v2_identities", "portal_v2_workspaces", "pa_portal_workspace_sources",
  "portal_v2_directory_generations", "portal_v2_directory_entities", "portal_v2_directory_checkpoints",
  "portal_v2_folder_bindings", "pa_portal_principals", "projects", "shares", "share_events",
  "delivery_share_audience_snapshots", "delivery_share_recipient_members",
  "project_alpha_delivery_intent_receipts", "project_alpha_delivery_intent_revocation_receipts",
  "project_alpha_delivery_portal_grants", "project_alpha_delivery_guest_authority",
  "project_alpha_delivery_intent_audit", "project_alpha_delivery_portal_notification_outbox"] as const;
const childTables = ["project_alpha_delivery_portal_grants", "project_alpha_delivery_guest_authority",
  "project_alpha_delivery_intent_audit", "project_alpha_delivery_portal_notification_outbox",
  "delivery_share_audience_snapshots", "delivery_share_recipient_members"] as const;
type Row = Record<string, unknown>;
type Snapshot = Record<typeof tables[number], Row[]>;

describe("delivery intent source provenance populated migration", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let before: Snapshot;
  let after: Snapshot;
  let previousTriggers: Row[];
  let retainedTriggers: Row[];
  let previousChildSchemas: Row[];
  let retainedChildSchemas: Row[];
  let previousChildFks: Row[][];
  let retainedChildFks: Row[][];

  async function snapshot(): Promise<Snapshot> {
    const value = {} as Snapshot;
    for (const table of tables) {
      value[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Row>()).results
        .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !(
          (table === "project_alpha_delivery_intent_receipts" || table === "project_alpha_delivery_intent_revocation_receipts")
          && (key === "project_alpha_source_id" || key === "write_guard")
        )).sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return value;
  }
  async function childSchemas() {
    return (await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE tbl_name IN (${childTables.map(() => "?").join(",")}) AND type<>'trigger' ORDER BY type,name`)
      .bind(...childTables).all<Row>()).results;
  }
  async function childFks() {
    const results = await db.batch<Row>(childTables.map(table => db.prepare(`PRAGMA foreign_key_list('${table}')`)));
    return results.map(result => result.results);
  }
  function receipt(id: string, source = primary, deliveryId = id, resourceId = `grant-${id}`,
    mode: "portal" | "guest" = "portal", guard = 1) {
    return db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,created_at,project_alpha_source_id,write_guard)
      VALUES(?,?,?,?,?,?,?,?)`).bind(id, deliveryId, fingerprint, mode, resourceId, at, source, guard);
  }
  function revocation(id: string, originalId: string, source = primary, deliveryId = id, guard = 1) {
    return db.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts
      (receipt_id,delivery_id,original_receipt_id,request_fingerprint,created_at,project_alpha_source_id,write_guard)
      VALUES(?,?,?,?,?,?,?)`).bind(id, deliveryId, originalId, fingerprint, at, source, guard);
  }
  function grant(id: string, receiptId: string, workspaceId = "workspace-a", bindingId = "binding-a", audience = id) {
    return db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
      (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,
        audience_source_version,actor_id,created_at)
      VALUES(?,?,?,?,'v1','principal',?,'v1','producer',?)`).bind(id, receiptId, workspaceId, bindingId, audience, at);
  }
  function share(id: string) {
    return db.prepare(`INSERT INTO shares(id,project_id,token_hash,label,created_by_type,created_by_id,created_at)
      VALUES(?,'local-project',?,'Guest file','integration','producer',?)`).bind(id, `token-${id}`, at);
  }
  function guest(id: string, workspaceId = "workspace-a", bindingId = "binding-a") {
    return db.prepare(`INSERT INTO project_alpha_delivery_guest_authority
      (share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,
        principal_public_id,principal_source_version,label,created_at)
      VALUES(?,?,?,'v1',?,'principal','v1','Guest file',?)`).bind(id, workspaceId, bindingId, `directory-${workspaceId}`, at);
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('delivery-intent-source-migration')}}",
      d1Databases: { DELIVERY_DB: "delivery-intent-source-migration" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url))
      .filter(name => name.endsWith(".sql") && name < "0159_").sort();
    for (const name of names) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,created_at,updated_at)
        VALUES('person','https://issuer.test','subject','person@example.test',?,?)`).bind(at, at),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
        VALUES('workspace-a','organization','same-root','Original workspace',?)`).bind(primary),
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES('workspace-b',?,'workspace-a')`).bind(secondary),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
        VALUES('workspace-b','organization','same-root','Second workspace',?)`).bind(secondary),
      ...(["a", "b"] as const).flatMap(suffix => [
        db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
          VALUES(?,?,'source-generation',1,'active',1)`).bind(`directory-workspace-${suffix}`, `workspace-${suffix}`),
        db.prepare(`INSERT INTO portal_v2_directory_entities
          (workspace_id,generation_id,entity_type,public_id,display_name,source_version,safe_metadata_json)
          VALUES(?,?,'organization','same-root','Fixture','v1',?)`)
          .bind(`workspace-${suffix}`, `directory-workspace-${suffix}`, historicalJson),
        db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
          VALUES(?,?,1)`).bind(`workspace-${suffix}`, `directory-workspace-${suffix}`),
        db.prepare(`INSERT INTO portal_v2_folder_bindings
          (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
          VALUES(?,?,'organization','same-root',?,'project_alpha','v1')`)
          .bind(`binding-${suffix}`, `workspace-${suffix}`, `Clients/${suffix}/`),
        db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
          VALUES(?,'principal','person@example.test','Person','v1','active')`).bind(`workspace-${suffix}`),
      ]),
      db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,created_at,updated_at)
        VALUES('local-project','Local client','Unchanged project','Clients/a/',?,?)`).bind(at, at),
      ...(["active", "revoked", "expired"] as const).flatMap(status => [
        db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
          (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,created_at)
          VALUES(?,?,?,'portal',?,?)`).bind(`old-${status}`, `delivery-${status}`, fingerprint, `old-grant-${status}`, at),
        db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
          (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,
            audience_source_version,actor_id,grant_version,status,expires_at,revoked_at,revoke_reason_code,label,created_at)
          VALUES(?,?,'workspace-a','binding-a','v1','principal',?,'v1','original-producer',?,?,?,?,?,'Original label',?)`)
          .bind(`old-grant-${status}`, `old-${status}`, `principal-${status}`, status === "active" ? 1 : 2, status,
            status === "expired" ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
            status === "revoked" ? at : null, status === "revoked" ? "project_alpha_delivery_revoked" : null, at),
        db.prepare(`INSERT INTO project_alpha_delivery_intent_audit
          (id,receipt_id,action,actor_id,details_json,created_at) VALUES(?,?,'portal.accepted','original-producer',?,?)`)
          .bind(`audit-${status}`, `old-${status}`, historicalJson, at),
        db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox
          (id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type,status,attempt_count,
            next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at)
          VALUES(?,?,?,?,'v1','granted',?,3,?,?,?, ?,?,?)`)
          .bind(`notice-${status}`, `old-${status}`, `old-grant-${status}`, `principal-${status}`,
            status === "active" ? "processing" : status === "revoked" ? "sent" : "suppressed",
            at, status === "active" ? "2099-01-01" : null, status === "expired" ? "expired" : null,
            status === "revoked" ? at : null, at, at),
      ]),
      db.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts
        (receipt_id,delivery_id,original_receipt_id,request_fingerprint,created_at)
        VALUES('old-revoke','delivery-revoke','old-revoked',?,?)`).bind(fingerprint, at),
      ...(["active", "revoked"] as const).flatMap(status => [
        db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
          (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,created_at)
          VALUES(?,?,?,'guest',?,?)`).bind(`old-guest-${status}`, `guest-delivery-${status}`, fingerprint, `old-share-${status}`, at),
        db.prepare(`INSERT INTO shares(id,project_id,token_hash,public_id,idempotency_key,label,created_by_type,
          created_by_id,created_at,revoked_at,expires_at,access_count)
          VALUES(?,'local-project',?,?,?,'Guest file','integration','original-producer',?,?,?,7)`)
          .bind(`old-share-${status}`, `old-token-${status}`, `public-${status}`, `guest-delivery-${status}`,
            at, status === "revoked" ? at : null, "2099-01-01"),
        db.prepare(`INSERT INTO project_alpha_delivery_guest_authority
          (share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,
            principal_public_id,principal_source_version,label,status,revoked_at,created_at)
          VALUES(?,'workspace-a','binding-a','v1','directory-workspace-a','principal','v1','Guest file',?,?,?)`)
          .bind(`old-share-${status}`, status, status === "revoked" ? at : null, at),
        db.prepare(`INSERT INTO delivery_share_audience_snapshots
          (share_id,share_version,workspace_id,folder_binding_id,owner_scope_type,owner_public_id,directory_generation_id,
            audience_type,audience_public_id,audience_display_name,selected_by_staff_id,created_at)
          VALUES(?,1,'workspace-a','binding-a','organization','same-root','directory-workspace-a','principal','principal','Person','original-producer',?)`)
          .bind(`old-share-${status}`, at),
        db.prepare(`INSERT INTO delivery_share_recipient_members
          (share_id,share_version,recipient_principal_public_id,recipient_display_name,recipient_normalized_email)
          VALUES(?,1,'principal','Person','person@example.test')`).bind(`old-share-${status}`),
        db.prepare(`INSERT INTO share_events(share_id,event_type,item_ref,client_address_hash,user_agent,created_at)
          VALUES(?,'preview.viewed','exact/file.jpg','hash','historical-agent',?)`).bind(`old-share-${status}`, at),
        db.prepare(`INSERT INTO project_alpha_delivery_intent_audit
          (id,receipt_id,action,actor_id,details_json,created_at) VALUES(?,?,'guest.accepted','original-producer',?,?)`)
          .bind(`audit-guest-${status}`, `old-guest-${status}`, historicalJson, at),
      ]),
    ]);
    before = await snapshot();
    previousTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results;
    previousChildSchemas = await childSchemas();
    previousChildFks = await childFks();
    const sql = readFileSync(new URL("../migrations/0159_delivery_intent_source_provenance.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    after = await snapshot();
    const namesBefore = new Set(previousTriggers.map(row => row.name));
    retainedTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results
      .filter(row => namesBefore.has(row.name));
    retainedChildSchemas = await childSchemas();
    retainedChildFks = await childFks();
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("preserves every existing receipt, grant, guest share, recipient snapshot, audit and outbox byte-for-byte", async () => {
    expect(after).toEqual(before);
    expect(retainedTriggers).toEqual(previousTriggers);
    expect(retainedChildSchemas).toEqual(previousChildSchemas);
    expect(retainedChildFks).toEqual(previousChildFks);
    expect(after.project_alpha_delivery_intent_audit[0]?.details_json).toBe(historicalJson);
    expect(after.project_alpha_delivery_portal_grants.map(row => row.status).sort()).toEqual(["active", "expired", "revoked"]);
    expect(after.shares).toHaveLength(2);
    expect(after.delivery_share_recipient_members).toHaveLength(2);
    expect((await db.prepare("SELECT DISTINCT project_alpha_source_id,write_guard FROM project_alpha_delivery_intent_receipts").all()).results)
      .toEqual([{ project_alpha_source_id: primary, write_guard: 1 }]);
    expect((await db.prepare("SELECT project_alpha_source_id,write_guard FROM project_alpha_delivery_intent_revocation_receipts").all()).results)
      .toEqual([{ project_alpha_source_id: primary, write_guard: 1 }]);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    // Whole-file quick_check exceeds D1's limits on the pre-existing full schema;
    // retain bounded integrity checks for every populated table instead.
    const checks = await db.batch<{ quick_check: string }>(tables.map(table => db.prepare(`PRAGMA quick_check('${table}')`)));
    expect(checks.map(result => result.results.map(row => row.quick_check))).toEqual(tables.map(() => ["ok"]));
  });

  it("permits equal producer delivery IDs across sources with distinct global receipts and resources", async () => {
    await db.batch([receipt("collision-a", primary, "same-delivery"), grant("grant-collision-a", "collision-a"),
      receipt("collision-b", secondary, "same-delivery"), grant("grant-collision-b", "collision-b", "workspace-b", "binding-b")]);
    expect((await db.prepare(`SELECT receipt_id,project_alpha_source_id FROM project_alpha_delivery_intent_receipts
      WHERE delivery_id='same-delivery' ORDER BY receipt_id`).all()).results).toEqual([
      { receipt_id: "collision-a", project_alpha_source_id: primary },
      { receipt_id: "collision-b", project_alpha_source_id: secondary },
    ]);
    await expect(receipt("collision-duplicate", primary, "same-delivery").run()).rejects.toThrow();
  });

  it("keeps revocation delivery keys source-local and foreign keys tied to the original source", async () => {
    await db.batch([receipt("revoke-original-a"), receipt("revoke-original-b", secondary),
      revocation("revoke-a", "revoke-original-a", primary, "same-revocation"),
      revocation("revoke-b", "revoke-original-b", secondary, "same-revocation")]);
    expect(await db.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_revocation_receipts WHERE delivery_id='same-revocation'").first("count")).toBe(2);
    await expect(revocation("foreign-revoke", "revoke-original-a", secondary).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(revocation("orphan-revoke", "missing-original").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(revocation("duplicate-revoke", "revoke-original-a", primary, "same-revocation").run()).rejects.toThrow();
  });

  it("rejects global receipt identity changes and source-key stealing by UPDATE, DELETE or REPLACE", async () => {
    for (const sql of [
      "UPDATE project_alpha_delivery_intent_receipts SET project_alpha_source_id='project-alpha:secondary' WHERE receipt_id='old-active'",
      "UPDATE project_alpha_delivery_intent_receipts SET receipt_id='stolen' WHERE receipt_id='old-active'",
      "UPDATE project_alpha_delivery_intent_receipts SET resource_id='different' WHERE receipt_id='old-active'",
      "DELETE FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'",
      `INSERT OR REPLACE INTO project_alpha_delivery_intent_receipts
        SELECT receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,status,created_at,'project-alpha:secondary',write_guard
        FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'`,
      `INSERT OR REPLACE INTO project_alpha_delivery_intent_receipts
        SELECT 'thief',delivery_id,request_fingerprint,access_mode,resource_id,status,created_at,project_alpha_source_id,write_guard
        FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'`,
      "UPDATE project_alpha_delivery_intent_revocation_receipts SET original_receipt_id='old-active' WHERE receipt_id='old-revoke'",
      "DELETE FROM project_alpha_delivery_intent_revocation_receipts WHERE receipt_id='old-revoke'",
      `INSERT OR REPLACE INTO project_alpha_delivery_intent_revocation_receipts
        SELECT receipt_id,delivery_id,original_receipt_id,request_fingerprint,created_at,'project-alpha:secondary',write_guard
        FROM project_alpha_delivery_intent_revocation_receipts WHERE receipt_id='old-revoke'`,
      `INSERT OR REPLACE INTO project_alpha_delivery_intent_revocation_receipts
        SELECT 'revoke-thief',delivery_id,original_receipt_id,request_fingerprint,created_at,project_alpha_source_id,write_guard
        FROM project_alpha_delivery_intent_revocation_receipts WHERE receipt_id='old-revoke'`,
    ]) await expect(db.prepare(sql).run()).rejects.toThrow();
    expect(await db.prepare("SELECT project_alpha_source_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'").first("project_alpha_source_id")).toBe(primary);
    expect(await db.prepare("SELECT grant_version FROM project_alpha_delivery_portal_grants WHERE id='old-grant-active'").first("grant_version")).toBe(1);
  });

  it("allows an exact no-write replay without deleting any dependent history", async () => {
    const original = await db.prepare("SELECT * FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'").first<Row>();
    await db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      SELECT * FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'
      ON CONFLICT(project_alpha_source_id,delivery_id) DO NOTHING`).run();
    expect(await db.prepare("SELECT * FROM project_alpha_delivery_intent_receipts WHERE receipt_id='old-active'").first()).toEqual(original);
    expect(await db.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_audit WHERE receipt_id='old-active'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_notification_outbox WHERE receipt_id='old-active'").first("count")).toBe(1);
  });

  it("supports receipt-first portal and guest resource creation in the same transaction", async () => {
    await db.batch([receipt("ordered-portal"), grant("grant-ordered-portal", "ordered-portal"),
      receipt("ordered-guest", primary, "ordered-guest", "ordered-share", "guest"), share("ordered-share"), guest("ordered-share")]);
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_portal_grants WHERE id='grant-ordered-portal'").first("receipt_id")).toBe("ordered-portal");
    expect(await db.prepare("SELECT workspace_id FROM project_alpha_delivery_guest_authority WHERE share_id='ordered-share'").first("workspace_id")).toBe("workspace-a");
  });

  it("rejects wrong-source receipt-first resources and rolls back the entire batch", async () => {
    await expect(db.batch([receipt("bad-portal", primary), grant("grant-bad-portal", "bad-portal", "workspace-b", "binding-b")])).rejects.toThrow(/source conflicts/);
    await expect(db.batch([receipt("bad-guest", primary, "bad-guest", "bad-share", "guest"),
      share("bad-share"), guest("bad-share", "workspace-b", "binding-b")])).rejects.toThrow(/source conflicts/);
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id IN ('bad-portal','bad-guest')").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM shares WHERE id='bad-share'").first()).toBeNull();
  });

  it("does not reuse existing or reserved resources under another producer", async () => {
    await expect(receipt("reuse-portal", secondary, "reuse-portal", "old-grant-active").run()).rejects.toThrow(/source conflicts/);
    await expect(receipt("reuse-guest", secondary, "reuse-guest", "old-share-active", "guest").run()).rejects.toThrow(/source conflicts/);
    await receipt("reservation-a", primary, "reservation-a", "future-grant").run();
    await expect(receipt("reservation-b", secondary, "reservation-b", "future-grant").run()).rejects.toThrow(/source conflicts/);
  });

  it("preserves compatible same-source receipt reuse of existing portal and guest resources", async () => {
    await db.batch([receipt("same-source-portal", primary, "same-source-portal", "old-grant-active"),
      receipt("same-source-guest", primary, "same-source-guest", "old-share-active", "guest"),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox
        (id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type)
        VALUES('same-source-notice','same-source-portal','old-grant-active','principal-active','v1','granted')`)]);
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_portal_grants WHERE id='old-grant-active'").first("receipt_id")).toBe("old-active");
    expect(await db.prepare("SELECT workspace_id FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-active'").first("workspace_id")).toBe("workspace-a");
    expect(await db.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_receipts WHERE resource_id='old-grant-active'").first("count")).toBe(2);
  });

  it("requires the exact portal receipt, mode, resource and native folder ownership", async () => {
    await expect(grant("orphan-grant", "missing-receipt").run()).rejects.toThrow();
    await receipt("wrong-resource", primary, "wrong-resource", "expected-grant").run();
    await expect(grant("unexpected-grant", "wrong-resource").run()).rejects.toThrow(/source conflicts/);
    await receipt("wrong-mode", primary, "wrong-mode", "wrong-mode-grant", "guest").run();
    await expect(grant("wrong-mode-grant", "wrong-mode").run()).rejects.toThrow(/source conflicts/);
    await receipt("wrong-binding").run();
    await expect(grant("grant-wrong-binding", "wrong-binding", "workspace-a", "binding-b").run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("keeps native guest ownership immutable without blocking the existing revoke transition", async () => {
    for (const sql of [
      "UPDATE project_alpha_delivery_guest_authority SET workspace_id='workspace-b',folder_binding_id='binding-b' WHERE share_id='old-share-active'",
      "UPDATE project_alpha_delivery_guest_authority SET share_id='different-share' WHERE share_id='old-share-active'",
      "DELETE FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-active'",
      `INSERT OR REPLACE INTO project_alpha_delivery_guest_authority
        SELECT share_id,'workspace-b','binding-b',binding_source_version,directory_generation_id,principal_public_id,
          principal_source_version,label,status,revoked_at,created_at FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-active'`,
      `INSERT OR REPLACE INTO project_alpha_delivery_portal_grants
        SELECT id,receipt_id,'workspace-b','binding-b',binding_source_version,audience_type,audience_public_id,audience_source_version,
          grant_version,status,expires_at,label,actor_kind,actor_id,revoked_at,revoke_reason_code,created_at
        FROM project_alpha_delivery_portal_grants WHERE id='old-grant-active'`,
    ]) await expect(db.prepare(sql).run()).rejects.toThrow();
    await db.prepare(`UPDATE project_alpha_delivery_guest_authority SET status='revoked',revoked_at=? WHERE share_id='old-share-active'`).bind(at).run();
    expect(await db.prepare("SELECT status FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-active'").first("status")).toBe("revoked");
    expect(await db.prepare("SELECT workspace_id FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-active'").first("workspace_id")).toBe("workspace-a");
  });

  it("does not let same-owner REPLACE revive terminal resources or bypass immutable grant fields", async () => {
    for (const status of ["revoked", "expired"]) {
      await expect(db.prepare(`INSERT OR REPLACE INTO project_alpha_delivery_portal_grants
        SELECT id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,
          audience_source_version,1,'active',expires_at,label,actor_kind,actor_id,NULL,NULL,created_at
        FROM project_alpha_delivery_portal_grants WHERE id=?`).bind(`old-grant-${status}`).run()).rejects.toThrow(/source conflicts/);
      expect(await db.prepare("SELECT status FROM project_alpha_delivery_portal_grants WHERE id=?")
        .bind(`old-grant-${status}`).first("status")).toBe(status);
    }
    for (const changed of ["audience_public_id", "binding_source_version", "expires_at", "actor_id"] as const) {
      const columns = ["id", "receipt_id", "workspace_id", "folder_binding_id", "binding_source_version", "audience_type",
        "audience_public_id", "audience_source_version", "grant_version", "status", "expires_at", "label", "actor_kind",
        "actor_id", "revoked_at", "revoke_reason_code", "created_at"] as const;
      const values = columns.map(column => column === changed ? "?" : column).join(",");
      await expect(db.prepare(`INSERT OR REPLACE INTO project_alpha_delivery_portal_grants
        SELECT ${values} FROM project_alpha_delivery_portal_grants WHERE id='old-grant-active'`)
        .bind(changed === "expires_at" ? "2099-12-31T00:00:00Z" : "changed").run()).rejects.toThrow(/source conflicts/);
    }
    await expect(db.prepare(`INSERT OR REPLACE INTO project_alpha_delivery_guest_authority
      SELECT share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,principal_public_id,
        principal_source_version,label,'active',NULL,created_at
      FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-revoked'`).run()).rejects.toThrow(/source conflicts/);
    expect(await db.prepare("SELECT status FROM project_alpha_delivery_guest_authority WHERE share_id='old-share-revoked'").first("status")).toBe("revoked");
  });

  it("preserves the existing normal portal grant UPDATE lifecycle", async () => {
    await db.batch([receipt("lifecycle"), grant("grant-lifecycle", "lifecycle"),
      db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='expired',grant_version=grant_version+1
        WHERE id='grant-lifecycle'`)]);
    expect(await db.prepare("SELECT status,grant_version FROM project_alpha_delivery_portal_grants WHERE id='grant-lifecycle'").first())
      .toEqual({ status: "expired", grant_version: 2 });
    await expect(db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='active',grant_version=grant_version+1
      WHERE id='grant-lifecycle'`).run()).rejects.toThrow(/immutable/);
  });

  it("does not let REPLACE steal the unique active audience from another grant handle", async () => {
    await db.batch([receipt("unique-owner"), grant("grant-unique-owner", "unique-owner", "workspace-a", "binding-a", "unique-audience")]);
    await expect(db.batch([receipt("unique-thief"),
      db.prepare(`INSERT OR REPLACE INTO project_alpha_delivery_portal_grants
        (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,
          audience_source_version,actor_id,created_at)
        VALUES('grant-unique-thief','unique-thief','workspace-a','binding-a','v1','principal','unique-audience','v1','producer',?)`).bind(at),
    ])).rejects.toThrow(/source conflicts/);
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_portal_grants WHERE id='grant-unique-owner'").first("receipt_id")).toBe("unique-owner");
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id='unique-thief'").first()).toBeNull();
  });

  it("rolls back prior mutations when either named transaction-time guard fails", async () => {
    await expect(db.batch([db.prepare("UPDATE projects SET project_name='Must rollback' WHERE id='local-project'"),
      receipt("failed-intent", primary, "failed-intent", "failed-share", "guest", 0), share("failed-share")]))
      .rejects.toThrow(/project_alpha_delivery_intent_write_guard/);
    await expect(db.batch([
      db.prepare(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,
        revoked_at=?,revoke_reason_code='project_alpha_delivery_revoked' WHERE id='old-grant-active'`).bind(at),
      revocation("failed-revoke", "old-active", primary, "failed-revoke", 0),
      db.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id)
        VALUES('failed-audit','old-active','portal.revoked','producer')`),
    ])).rejects.toThrow(/project_alpha_delivery_revocation_write_guard/);
    expect(await db.prepare("SELECT project_name FROM projects WHERE id='local-project'").first("project_name")).toBe("Unchanged project");
    expect(await db.prepare("SELECT status FROM project_alpha_delivery_portal_grants WHERE id='old-grant-active'").first("status")).toBe("active");
    expect(await db.prepare("SELECT id FROM shares WHERE id='failed-share'").first()).toBeNull();
    expect(await db.prepare("SELECT id FROM project_alpha_delivery_intent_audit WHERE id='failed-audit'").first()).toBeNull();
    expect(await db.prepare("SELECT receipt_id FROM project_alpha_delivery_intent_revocation_receipts WHERE receipt_id='failed-revoke'").first()).toBeNull();
  });

  it("requires explicit canonical producer IDs on new receipts, including rejecting NUL and newline", async () => {
    await expect(db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES('no-source','no-source',?,'portal','no-source')`)
      .bind(fingerprint).run()).rejects.toThrow(/NOT NULL/);
    await expect(db.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts
      (receipt_id,delivery_id,original_receipt_id,request_fingerprint) VALUES('no-source-revoke','no-source-revoke','old-active',?)`)
      .bind(fingerprint).run()).rejects.toThrow(/NOT NULL/);
    for (const [index, source] of ["", "primary", "project-alpha:Upper", "project-alpha:bad/name",
      "project-alpha:x\n", "project-alpha:x\0hidden", `project-alpha:${"a".repeat(65)}`].entries()) {
      await expect(receipt(`invalid-source-${index}`, source).run()).rejects.toThrow();
      await expect(revocation(`invalid-revoke-${index}`, "old-active", source).run()).rejects.toThrow();
    }
  });

  it("uses source-qualified replay and resource indexes and leaves all foreign keys valid", async () => {
    const intentPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT receipt_id,request_fingerprint
      FROM project_alpha_delivery_intent_receipts WHERE project_alpha_source_id=? AND delivery_id=?`)
      .bind(primary, "delivery-active").all<{ detail: string }>();
    const revokePlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT receipt_id,request_fingerprint
      FROM project_alpha_delivery_intent_revocation_receipts WHERE project_alpha_source_id=? AND delivery_id=?`)
      .bind(primary, "delivery-revoke").all<{ detail: string }>();
    for (const plan of [intentPlan, revokePlan]) {
      expect(plan.results.some(row => /SEARCH .*project_alpha_source_id=\? AND delivery_id=\?/.test(row.detail))).toBe(true);
      expect(plan.results.some(row => /SCAN |TEMP B-TREE/i.test(row.detail))).toBe(false);
    }
    const resourcePlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT receipt_id FROM project_alpha_delivery_intent_receipts
      WHERE access_mode='guest' AND resource_id=? AND project_alpha_source_id=?`).bind("old-share-active", primary).all<{ detail: string }>();
    expect(resourcePlan.results.some(row => row.detail.includes("idx_project_alpha_delivery_intent_resource_source"))).toBe(true);
    const originalPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT receipt_id FROM project_alpha_delivery_intent_revocation_receipts
      WHERE original_receipt_id=? AND project_alpha_source_id=?`).bind("old-revoked", primary).all<{ detail: string }>();
    expect(originalPlan.results.some(row => row.detail.includes("idx_project_alpha_delivery_revocation_original_source"))).toBe(true);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
