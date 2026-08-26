import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary";
const secondary = "project-alpha:secondary";
const at = "2026-08-26T12:34:56.789Z";
const root = "a".repeat(32);
const historicalJson = '{ "note": "Élevation  \\u00e9", "version": 1.0 }';
const tables = ["client_accounts", "client_identity_links", "client_account_members",
  "portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships",
  "portal_v2_directory_generations", "portal_v2_directory_entities", "portal_v2_directory_checkpoints",
  "portal_v2_directory_generation_contracts", "portal_v2_entitlements", "portal_v2_invitations",
  "portal_v2_invitation_entitlements", "portal_v2_identity_denials", "portal_v2_folder_bindings",
  "portal_v2_identity_eligibility_legacy_bridges", "pa_portal_principals", "pa_portal_entitlement_intents",
  "pa_portal_projection_generations", "pa_portal_projection_pages", "pa_portal_projection_entities",
  "pa_portal_projection_principals", "pa_portal_projection_entitlements", "pa_portal_projection_receipts",
  "pa_portal_projection_checkpoints", "pa_portal_projection_audit", "project_alpha_delivery_intent_receipts",
  "project_alpha_delivery_portal_grants", "project_alpha_delivery_portal_notification_outbox"] as const;
type Row = Record<string, unknown>;
type Snapshot = Record<typeof tables[number], Row[]>;

describe("native portal source ownership populated migration", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let before: Snapshot;
  let after: Snapshot;
  let beforeTriggers: Row[];
  let retainedTriggers: Row[];

  async function snapshot(): Promise<Snapshot> {
    const rows = {} as Snapshot;
    for (const table of tables) {
      rows[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Row>()).results
        .map(row => Object.fromEntries(Object.entries(row)
          .filter(([key]) => !(
            (table === "portal_v2_workspaces" && key === "project_alpha_source_id")
            || (table === "pa_portal_projection_generations" && key === "projection_source_id")
            || (table === "pa_portal_projection_receipts" && (key === "projection_source_id" || key === "write_guard"))
          ))
          .sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return rows;
  }
  function reserve(local: string, source = primary, external = local) {
    return db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
      VALUES(?,?,?)`).bind(local, source, external);
  }
  function workspace(id: string, source = primary, rootId = id) {
    return db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
      VALUES(?,'organization',?,?,?)`).bind(id, rootId, id, source);
  }
  function generation(id: string, workspaceId: string, source = primary, sourceGeneration = "same-generation", sequence = 1) {
    return db.prepare(`INSERT INTO pa_portal_projection_generations
      (id,workspace_id,projection_source_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,
        workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status)
      VALUES(?,?,?,?,?,?,1,1,'organization',?,'Fixture','v1',1,'staging')`)
      .bind(id, workspaceId, source, sourceGeneration, sequence, "f".repeat(64), root);
  }
  function receipt(source: string, workspaceId: string, delivery = "same-delivery", hash = "h".repeat(64), guard = 1) {
    return db.prepare(`INSERT INTO pa_portal_projection_receipts
      (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,received_at,write_guard)
      VALUES(?,?,?,'snapshot_page',?,1,'completed',?,?)`).bind(source, delivery, workspaceId, hash, at, guard);
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('portal-source-migration')}}",
      d1Databases: { DELIVERY_DB: "portal-source-migration" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql") && name < "0158_").sort();
    for (const name of names) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status) VALUES('legacy-account','Local legacy wrapper','active')`),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('legacy-identity','legacy-account','https://issuer.test','subject','person@example.test')`),
      db.prepare(`INSERT INTO client_account_members(account_id,identity_id,role) VALUES('legacy-account','legacy-identity','manager')`),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,created_at,updated_at)
        VALUES('global-person','https://issuer.test','subject','person@example.test',?,?)`).bind(at, at),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,created_at,updated_at)
        VALUES('native-workspace','organization',?,'Native workspace',?,?)`).bind(root, at, at),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,legacy_account_id,display_name,status)
        VALUES('legacy-workspace','standalone_client','17','legacy-account','Legacy wrapper','suspended')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
        VALUES('membership-native','native-workspace','global-person','project_alpha'),
          ('membership-legacy','legacy-workspace','global-person','legacy')`),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges
        (workspace_id,identity_id,legacy_account_id,legacy_identity_id)
        VALUES('legacy-workspace','global-person','legacy-account','legacy-identity')`),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,created_at)
        VALUES('directory-native','native-workspace','native-generation',10,'active',1,?),
          ('directory-legacy','legacy-workspace','legacy-backfill',0,'active',1,?)`).bind(at, at),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES('directory-native','native-workspace',2),('directory-legacy','legacy-workspace',2)`),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,safe_metadata_json)
        VALUES('native-workspace','directory-native','organization',?,'Native workspace','v1',?),
          ('legacy-workspace','directory-legacy','standalone_client','17','Legacy wrapper','legacy-backfill',?)`)
        .bind(root, historicalJson, historicalJson),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES('native-workspace','directory-native',10),('legacy-workspace','directory-legacy',0)`),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES('native-workspace','principal','global-person','person@example.test','Person','v1','active')`),
      db.prepare(`INSERT INTO pa_portal_entitlement_intents
        (workspace_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from)
        VALUES('native-workspace','intent','principal','workspace.view','allow','workspace','native-workspace','v1','active',?)`).bind(at),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
        VALUES('grant-native','native-workspace','global-person','workspace.view','workspace','native-workspace','project_alpha')`),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at)
        VALUES('invitation','native-workspace',?,'invite@example.test','global-person','2099-01-01')`).bind("i".repeat(43)),
      db.prepare(`INSERT INTO portal_v2_invitation_entitlements(invitation_id,capability,scope_type,scope_public_id)
        VALUES('invitation','workspace.view','workspace','native-workspace')`),
      db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,scope_type,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES('global-denial','global-person','global','fixture','staff','staff')`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES('binding','native-workspace','organization',?,'Clients/Native/','project_alpha','v1')`).bind(root),
      ...([["projection-native", "native-workspace", "native-generation", 10, "active", 1],
        ["projection-pending", "staged-only-workspace", "pending-generation", 11, "staging", 0]] as const)
        .map(([id, workspaceId, sourceGeneration, sequence, status, complete]) => db.prepare(`INSERT INTO pa_portal_projection_generations
          (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
            workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,created_at)
          VALUES(?,?,?,?,?,1,3,'organization',?,'Native workspace','v1',1,?,?,?)`)
          .bind(id, workspaceId, sourceGeneration, sequence, "f".repeat(64), root, status, complete, at)),
      db.prepare(`INSERT INTO pa_portal_projection_pages(generation_id,page_number,record_count,payload_hash)
        VALUES('projection-pending',1,3,?)`).bind("p".repeat(64)),
      db.prepare(`INSERT INTO pa_portal_projection_entities(generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES('projection-pending','organization',?,'Native workspace','v1',1)`).bind(root),
      db.prepare(`INSERT INTO pa_portal_projection_principals(generation_id,public_id,email_hint,display_name,source_version,active)
        VALUES('projection-pending','principal','person@example.test','Person','v1',1)`),
      db.prepare(`INSERT INTO pa_portal_projection_entitlements
        (generation_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,active,valid_from)
        VALUES('projection-pending','intent','principal','workspace.view','allow','workspace','staged-only-workspace','v1',1,?)`).bind(at),
      db.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
        VALUES('native-workspace','native-generation',10,'projection-native')`),
      db.prepare(`INSERT INTO pa_portal_projection_receipts
        (delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,received_at)
        VALUES('old-delivery','native-workspace','snapshot_activate',?,10,'completed',?),
          ('orphan-delivery','receipt-only-workspace','event',?,3,'ignored',?)`)
        .bind("h".repeat(64), at, "r".repeat(64), at),
      db.prepare(`INSERT INTO pa_portal_projection_audit
        (id,workspace_id,action,delivery_id,source_generation,source_sequence,details_json,created_at)
        VALUES('audit-only','audit-only-workspace','delivery_replayed','historical-delivery','old-generation',2,?,?)`)
        .bind(historicalJson, at),
      db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
        (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,created_at)
        VALUES('delivery-receipt','delivery-intent',?,'portal','delivery-grant',?)`).bind("d".repeat(64), at),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
        (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,actor_id)
        VALUES('delivery-grant','delivery-receipt','native-workspace','binding','v1','principal','principal','v1','producer')`),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox
        (id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type)
        VALUES('delivery-notice','delivery-receipt','delivery-grant','principal','v1','granted')`),
    ]);
    before = await snapshot();
    beforeTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results;
    const sql = readFileSync(new URL("../migrations/0158_portal_source_ownership.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    after = await snapshot();
    const oldNames = new Set(beforeTriggers.map(row => row.name));
    retainedTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results.filter(row => oldNames.has(row.name));
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("preserves populated URLs, global identities, access, staged data, audit JSON and delivery-intent history", async () => {
    expect(after).toEqual(before);
    expect(retainedTriggers).toEqual(beforeTriggers);
    expect(after.pa_portal_projection_audit[0]?.details_json).toBe(historicalJson);
    expect(after.portal_v2_identity_eligibility_legacy_bridges).toHaveLength(1);
    expect(after.portal_v2_workspace_memberships).toHaveLength(2);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const checks = await db.batch<{ quick_check: string }>(tables.map(table => db.prepare(`PRAGMA quick_check('${table}')`)));
    expect(checks.map(result => result.results.map(row => row.quick_check))).toEqual(tables.map(() => ["ok"]));
  });

  it("adopts native, legacy, pending, receipt-only and audit-only workspace handles exactly", async () => {
    const mappings = (await db.prepare("SELECT * FROM pa_portal_workspace_sources ORDER BY workspace_id").all()).results;
    expect(mappings).toEqual(["audit-only-workspace", "legacy-workspace", "native-workspace", "receipt-only-workspace", "staged-only-workspace"]
      .map(workspaceId => ({ workspace_id: workspaceId, projection_source_id: primary, source_workspace_id: workspaceId })));
    expect(await db.prepare("SELECT pa_client_public_id FROM portal_v2_workspaces WHERE id='legacy-workspace'").first("pa_client_public_id")).toBe("17");
    expect((await db.prepare("SELECT DISTINCT project_alpha_source_id FROM portal_v2_workspaces").all()).results).toEqual([{ project_alpha_source_id: primary }]);
    expect((await db.prepare("SELECT DISTINCT projection_source_id FROM pa_portal_projection_generations").all()).results).toEqual([{ projection_source_id: primary }]);
  });

  it("allows colliding external workspace/root/generation/delivery IDs only under independent local source ownership", async () => {
    await db.batch([reserve("secondary-workspace", secondary, "native-workspace"), workspace("secondary-workspace", secondary, root),
      generation("secondary-generation", "secondary-workspace", secondary, "native-generation", 10),
      receipt(secondary, "secondary-workspace", "old-delivery")]);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE delivery_id='old-delivery'").first("count")).toBe(2);
    await expect(db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject) VALUES('duplicate-person','https://issuer.test','subject')`).run()).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities WHERE issuer='https://issuer.test' AND subject='subject'").first("count")).toBe(1);
  });

  it("does not activate an unreserved secondary workspace, but retains primary writer compatibility", async () => {
    await expect(workspace("unreserved-secondary", secondary).run()).rejects.toThrow(/reservation|ownership/);
    await workspace("new-primary").run();
    expect(await db.prepare("SELECT projection_source_id FROM pa_portal_workspace_sources WHERE workspace_id='new-primary'").first("projection_source_id")).toBe(primary);
    await expect(workspace("new-primary").run()).rejects.toThrow();
    await db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name)
      VALUES('new-primary','organization','new-primary','Updated primary')
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name`).run();
    expect(await db.prepare("SELECT display_name FROM portal_v2_workspaces WHERE id='new-primary'").first("display_name")).toBe("Updated primary");
  });

  it("reserves before native activation and rejects missing or foreign generation ownership", async () => {
    await db.batch([reserve("future-native"), generation("future-generation", "future-native")]);
    expect(await db.prepare("SELECT id FROM portal_v2_workspaces WHERE id='future-native'").first()).toBeNull();
    await workspace("future-native").run();
    await expect(generation("orphan-generation", "unreserved").run()).rejects.toThrow(/ownership/);
    await expect(generation("foreign-generation", "native-workspace", secondary).run()).rejects.toThrow(/ownership/);
  });

  it("prevents source/local-handle reassignment and reservation stealing with UPDATE or REPLACE", async () => {
    for (const sql of [
      "UPDATE pa_portal_workspace_sources SET projection_source_id='project-alpha:other' WHERE workspace_id='native-workspace'",
      "UPDATE pa_portal_workspace_sources SET workspace_id='stolen-handle' WHERE workspace_id='native-workspace'",
      "UPDATE pa_portal_workspace_sources SET source_workspace_id='different-external' WHERE workspace_id='native-workspace'",
      "DELETE FROM pa_portal_workspace_sources WHERE workspace_id='native-workspace'",
      "INSERT OR REPLACE INTO pa_portal_workspace_sources VALUES('native-workspace','project-alpha:other','native-workspace')",
      "INSERT OR REPLACE INTO pa_portal_workspace_sources VALUES('stolen-handle','project-alpha:primary','native-workspace')",
    ]) await expect(db.prepare(sql).run()).rejects.toThrow();
    expect(await db.prepare("SELECT projection_source_id FROM pa_portal_workspace_sources WHERE workspace_id='native-workspace'").first("projection_source_id")).toBe(primary);
  });

  it("prevents native source/root/local-handle reparenting and unique-owner REPLACE stealing", async () => {
    for (const sql of [
      "UPDATE portal_v2_workspaces SET id='new-id' WHERE id='native-workspace'",
      "UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:other' WHERE id='native-workspace'",
      "UPDATE portal_v2_workspaces SET pa_organization_public_id='changed' WHERE id='native-workspace'",
      "UPDATE portal_v2_workspaces SET root_type='standalone_client',pa_organization_public_id=NULL,pa_client_public_id='changed' WHERE id='native-workspace'",
      "DELETE FROM portal_v2_workspaces WHERE id='native-workspace'",
      `INSERT OR REPLACE INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name) VALUES('root-thief','organization','${root}','Thief')`,
      "INSERT OR REPLACE INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name) VALUES('native-workspace','organization','different-root','Thief')",
      "INSERT OR REPLACE INTO portal_v2_workspaces(id,root_type,pa_client_public_id,legacy_account_id,display_name) VALUES('account-thief','standalone_client','different-root','legacy-account','Thief')",
      "UPDATE OR REPLACE portal_v2_workspaces SET legacy_account_id='legacy-account' WHERE id='native-workspace'",
    ]) await expect(db.prepare(sql).run()).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships WHERE workspace_id='native-workspace'").first("count")).toBe(1);
    expect(await db.prepare("SELECT pa_organization_public_id FROM portal_v2_workspaces WHERE id='native-workspace'").first("pa_organization_public_id")).toBe(root);
  });

  it("keeps snapshot and directory generation identities immutable without blocking lifecycle updates", async () => {
    await db.prepare("UPDATE pa_portal_projection_generations SET status='rejected' WHERE id='projection-pending'").run();
    await expect(db.prepare("UPDATE pa_portal_projection_generations SET workspace_id='native-workspace' WHERE id='projection-pending'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("UPDATE pa_portal_projection_generations SET projection_source_id='project-alpha:secondary' WHERE id='projection-pending'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("UPDATE pa_portal_projection_generations SET workspace_root_public_id='other' WHERE id='projection-pending'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("UPDATE portal_v2_directory_generations SET workspace_id='legacy-workspace' WHERE id='directory-native'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare(`INSERT OR REPLACE INTO portal_v2_directory_generations
      (id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES('directory-thief','native-workspace','native-generation',10,'active',1)`).run()).rejects.toThrow(/ownership/);
    await expect(generation("generation-thief", "native-workspace", primary, "native-generation", 10).run()).rejects.toThrow(/ownership/);
  });

  it("rejects foreign/orphan receipts and immutable receipt rewrites, preserving exact replay provenance", async () => {
    await expect(receipt(secondary, "native-workspace", "foreign-delivery").run()).rejects.toThrow();
    await expect(receipt(primary, "missing-workspace", "orphan-new").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE pa_portal_projection_receipts SET workspace_id='legacy-workspace' WHERE delivery_id='old-delivery'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare(`INSERT OR REPLACE INTO pa_portal_projection_receipts
      (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,received_at)
      VALUES(?,'old-delivery','legacy-workspace','snapshot_activate',?,10,'completed',?)`).bind(primary, "h".repeat(64), at).run()).rejects.toThrow(/conflicts/);
  });

  it("rolls back the entire authority batch when the named receipt write guard fails", async () => {
    await expect(db.batch([
      db.prepare("UPDATE portal_v2_workspaces SET display_name='Must rollback' WHERE id='native-workspace'"),
      receipt(primary, "native-workspace", "failed-proof", "h".repeat(64), 0),
    ])).rejects.toThrow(/pa_portal_projection_write_guard/);
    expect(await db.prepare("SELECT display_name FROM portal_v2_workspaces WHERE id='native-workspace'").first("display_name")).toBe("Native workspace");
    expect(await db.prepare("SELECT delivery_id FROM pa_portal_projection_receipts WHERE delivery_id='failed-proof'").first()).toBeNull();
  });

  it("keeps audit/checkpoint ownership pinned while accepting mapped audit-only history", async () => {
    await expect(db.prepare("UPDATE pa_portal_projection_audit SET workspace_id='native-workspace' WHERE id='audit-only'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare(`INSERT INTO pa_portal_projection_audit(id,workspace_id,action,delivery_id,source_generation,source_sequence)
      VALUES('audit-orphan','unreserved','event_upserted','event','generation',1)`).run()).rejects.toThrow(/ownership/);
    await expect(db.prepare(`UPDATE pa_portal_projection_checkpoints SET snapshot_generation_id='secondary-generation'
      WHERE workspace_id='native-workspace'`).run()).rejects.toThrow(/ownership/);
    await expect(db.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES('receipt-only-workspace','native-generation',10,'projection-native')`).run()).rejects.toThrow(/ownership/);
  });

  it("rejects malformed producer sources including NUL and newline", async () => {
    for (const source of ["", "primary", "project-alpha:Upper", "project-alpha:bad/name", "project-alpha:x\n", "project-alpha:x\0hidden", `project-alpha:${"a".repeat(65)}`]) {
      await expect(reserve(`invalid-${source.length}`, source).run()).rejects.toThrow();
      await expect(workspace(`invalid-native-${source.length}`, source).run()).rejects.toThrow();
    }
  });

  it("keeps secondary native storage from attaching a primary legacy account or compatibility bridge", async () => {
    await expect(db.prepare("UPDATE portal_v2_workspaces SET legacy_account_id='legacy-account' WHERE id='secondary-workspace'").run()).rejects.toThrow();
    await db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
      VALUES('secondary-member','secondary-workspace','global-person','client_invitation')`).run();
    await expect(db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges
      (workspace_id,identity_id,legacy_account_id,legacy_identity_id)
      VALUES('secondary-workspace','global-person','legacy-account','legacy-identity')`).run()).rejects.toThrow(/primary portal source/);
    await db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,status,expires_at,accepted_by_identity_id)
      VALUES('secondary-invitation','secondary-workspace',?,'person@example.test','global-person','accepted','2099-01-01','global-person')`).bind("s".repeat(43)).run();
    await expect(db.prepare(`INSERT INTO portal_v2_legacy_member_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
      VALUES('secondary-workspace','global-person','legacy-account','legacy-identity','secondary-invitation')`).run()).rejects.toThrow(/primary portal source/);
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_identity_eligibility_legacy_bridges WHERE workspace_id='legacy-workspace'").first("legacy_account_id")).toBe("legacy-account");
  });

  it("uses source-leading exact lookup indexes and leaves all foreign keys valid", async () => {
    const rootPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM portal_v2_workspaces
      WHERE project_alpha_source_id=? AND pa_organization_public_id=?`).bind(primary, root).all<{ detail: string }>();
    expect(rootPlan.results.some(row => row.detail.includes("idx_portal_v2_workspace_org_root"))).toBe(true);
    const receiptPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT payload_hash FROM pa_portal_projection_receipts
      WHERE projection_source_id=? AND delivery_id=?`).bind(primary, "old-delivery").all<{ detail: string }>();
    expect(receiptPlan.results.some(row => /SEARCH .*projection_source_id=\? AND delivery_id=\?/.test(row.detail))).toBe(true);
    // Exact native rootPage SELECT from Operations' Client Hub indexer: source
    // filtering and the cursor range must reach the index before LIMIT.
    const cursorPlan = await db.prepare(`EXPLAIN QUERY PLAN
      SELECT 'project-alpha:primary' source_id,'portal' root_namespace,root_type kind,
        id public_id,NULL pa_public_id,'not_applicable' mapping_status,
        display_name,status,0 contact_count,id cursor FROM portal_v2_workspaces
      WHERE project_alpha_source_id='project-alpha:primary' AND status<>'closed'
        AND id>? ORDER BY id COLLATE BINARY LIMIT ?`).bind("native-workspace", 25).all<{ detail: string }>();
    expect(cursorPlan.results.some(row => row.detail.includes("idx_portal_v2_workspace_source_cursor")
      && /project_alpha_source_id=\? AND id>\?/.test(row.detail))).toBe(true);
    expect(cursorPlan.results.some(row => /SCAN |TEMP B-TREE/i.test(row.detail))).toBe(false);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
