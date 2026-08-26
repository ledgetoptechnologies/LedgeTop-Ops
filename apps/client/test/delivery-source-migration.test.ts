import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary";
const secondary = "project-alpha:secondary";
const at = "2026-08-25T12:34:56.789Z";
const historicalJson = '{ "sourceOwner": { "account": { "projectAlphaClientId": "17" } }, "note": "Élevation  \\u00e9", "version": 1.0 }';
const tables = ["client_accounts", "projects", "client_identity_links", "client_account_members",
  "client_project_grants", "client_member_project_grants", "shares", "client_delivery_grants",
  "client_folder_associations", "client_folder_grant_mutations", "client_folder_notification_preferences",
  "client_portal_notifications", "client_service_requests", "client_service_request_drafts",
  "client_service_request_draft_mutations", "client_portal_notification_outbox", "client_feedback",
  "client_feedback_events", "portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships",
  "portal_v2_invitations", "portal_v2_legacy_member_bridges", "portal_v2_identity_eligibility_legacy_bridges", "audit_log"] as const;
type Row = Record<string, unknown>;
type Snapshot = Record<typeof tables[number], Row[]>;
type GlobalQuickCheck = { rows: string[] } | { runtimeError: "SQLITE_NOMEM" };

describe("Delivery source provenance populated migration", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let before: Snapshot;
  let after: Snapshot;
  let oldTriggers: Row[];
  let retainedTriggers: Row[];
  let backfillAccounts: Row[];
  let backfillProjects: Row[];
  let beforeGlobalCheck: GlobalQuickCheck;
  let afterGlobalCheck: GlobalQuickCheck;
  let beforeTableChecks: string[][];
  let afterTableChecks: string[][];

  async function globalQuickCheck(): Promise<GlobalQuickCheck> {
    try {
      return { rows: (await db.prepare("PRAGMA quick_check").all<{ quick_check: string }>()).results.map(row => row.quick_check) };
    } catch (error) {
      // Preserve an explicit before/after diagnostic for the local D1 engine.
      // Any new post-upgrade failure or error other than this exact runtime
      // limitation still fails. Per-table checks below must always succeed.
      if (error instanceof Error && /SQLITE_NOMEM/.test(error.message)) return { runtimeError: "SQLITE_NOMEM" };
      throw error;
    }
  }
  async function tableQuickChecks() {
    // SQLite documents quick_check(TABLENAME); unlike a whole-file check,
    // this cannot detect cross-table page reuse or freelist corruption.
    // https://www.sqlite.org/pragma.html#pragma_quick_check
    return (await db.batch<{ quick_check: string }>(tables.map(table => db.prepare(`PRAGMA quick_check('${table}')`))))
      .map(result => result.results.map(row => row.quick_check));
  }

  async function snapshot() {
    const result = {} as Snapshot;
    for (const table of tables) {
      result[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Row>()).results
        .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "project_alpha_source_id")
          .sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return result;
  }
  function account(id: string, source: string | null, clientId: string | null = null, organizationId: string | null = null) {
    return db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id,project_alpha_client_id,project_alpha_organization_id)
      VALUES(?,?,'active',?,?,?)`).bind(id, id, source, clientId, organizationId);
  }
  function project(id: string, source: string | null, externalId: string | null = null) {
    return db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES(?,'Client',?,'Clients/Fixture/',?,?)`).bind(id, id, source, externalId);
  }
  function folder(id: string, accountId: string, projectId: string, revokedAt: string | null = null) {
    return db.prepare(`INSERT INTO client_folder_associations(id,scope_type,account_id,project_id,r2_prefix,created_by,revoked_at)
      VALUES(?,'project',?,?,?,'staff',?)`).bind(id, accountId, projectId, `Clients/Fixture/${id}/`, revokedAt);
  }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('delivery-source-migration'); } };",
      d1Databases: { DELIVERY_DB: "delivery-source-provenance" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort();
    for (const name of names.filter(name => name < "0157_")) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    // Seed the actual pre-upgrade schema, including numeric and public-shaped
    // references. Their namespace is deliberately NOT inferred by this upgrade.
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id,created_at,updated_at)
        VALUES('a-primary','Historical client','active','17','org-old',?,?),
        ('a-public','Public-shaped client','active',?,NULL,?,?),('a-local','Local client','active',NULL,NULL,?,?),
        ('a-bridge','Local bridge','active',NULL,NULL,?,?),('a-empty-ref','Empty historical scalar','disabled','',NULL,?,?)`)
        .bind(at, at, "b".repeat(32), at, at, at, at, at, at, at, at),
      db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_project_id,created_at,updated_at)
        VALUES('p-primary','Historical client','Historical project','Clients/Primary/','41',?,?),
        ('p-public','Public-shaped client','Public project','Clients/Public/',?,?,?),
        ('p-local','Local client','Local project','Clients/Local/',NULL,?,?)`).bind(at, at, "c".repeat(32), at, at, at, at),
      ...["primary", "local", "bridge"].map(name => db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email,created_at)
        VALUES(?,?,'https://issuer.test',?,?,?)`).bind(`i-${name}`, `a-${name}`, name, `${name}@example.test`, at)),
      ...["primary", "local", "bridge"].map(name => db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(`a-${name}`, `i-${name}`)),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service,granted_at) VALUES('a-primary','p-primary',1,?),('a-local','p-local',1,?)").bind(at, at),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,revoked_at) VALUES('a-primary','p-local',?)").bind(at),
      db.prepare("INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id) VALUES('a-primary','i-primary','p-primary','i-primary')"),
      db.prepare(`INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id,created_at)
        VALUES('share-history','p-primary','not-a-real-token','staff','staff-fixture',?)`).bind(at),
      db.prepare("INSERT INTO client_delivery_grants(account_id,project_id,share_id,share_version,granted_at) VALUES('a-primary','p-primary','share-history',1,?)").bind(at),
      db.prepare(`INSERT INTO client_folder_associations(id,scope_type,project_id,account_id,r2_prefix,created_by,logical_grant_id,created_at)
        VALUES('folder-history','project','p-primary','a-primary','Clients/Primary/','staff','logical-history',?)`).bind(at),
      db.prepare(`INSERT INTO client_folder_grant_mutations(account_id,mutation_key,mutation_fingerprint,logical_grant_id,grant_version,association_id)
        VALUES('a-primary','folder-history-key-0001',?,'logical-history',1,'folder-history')`).bind("f".repeat(64)),
      db.prepare(`INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by)
        VALUES('logical-history','a-primary','i-primary','both','staff')`),
      db.prepare(`INSERT INTO client_portal_notifications(id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES('notice-history','a-primary','i-primary','files_added','folder_grant','logical-history','notice-history-key','Files added','Preserve notice','/files')`),
      ...["primary", "local"].map(name => db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status,created_at,updated_at)
        VALUES(?,?,?,?,'service','Historical request','Preserve exact request',?,?,'submitted',?,?)`)
        .bind(`request-${name}`, `a-${name}`, `p-${name}`, `i-${name}`, `request-${name}-key-0001`, "r".repeat(43), at, at)),
      db.prepare(`INSERT INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        VALUES('outbox-history','request-primary','request_submitted','submitted','staff_triage','outbox-history-key',?)`).bind(historicalJson),
      db.prepare(`INSERT INTO client_service_request_drafts(id,account_id,project_id,created_by_identity_id,draft_json,create_idempotency_key,create_fingerprint,last_mutation_key)
        VALUES('draft-history','a-primary','p-primary','i-primary',?,'draft-history-key-0001',?,'draft-mutation-key-0001')`).bind(historicalJson, "d".repeat(43)),
      db.prepare(`INSERT INTO client_service_request_draft_mutations(draft_id,mutation_key,mutation_fingerprint,resulting_version,result_snapshot_json)
        VALUES('draft-history','draft-mutation-key-0001',?,1,?)`).bind("m".repeat(43), historicalJson),
      db.prepare(`INSERT INTO client_feedback(id,account_id,scope_key,creator_identity_id,principal_issuer,principal_subject,target_kind,project_id,target_json,target_fingerprint,message,mutation_key,request_fingerprint,created_at,updated_at)
        VALUES('feedback-history','a-primary','account:a-primary','i-primary','https://issuer.test','primary','project','p-primary',?,?,'Keep this feedback','feedback-key-0001',?,?,?)`)
        .bind(historicalJson, "t".repeat(64), "r".repeat(64), at, at),
      db.prepare("INSERT INTO client_feedback_events(id,feedback_id,revision,actor_type,actor_id,status) VALUES('feedback-event','feedback-history',1,'client','i-primary','new')"),
      db.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff','staff','fixture.created','project','p-primary',?)").bind(historicalJson),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES
        ('native-invite','https://issuer.test','native-invite','invite@example.test'),('native-shell','https://issuer.test','native-shell','shell@example.test')`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,legacy_account_id,display_name)
        VALUES('w-primary','standalone_client','17','a-primary','Primary native'),('w-shell','standalone_client','shell-public-id',NULL,'Shell native')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
        VALUES('membership-invite','w-primary','native-invite','client_invitation'),('membership-shell','w-shell','native-shell','project_alpha')`),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,status,expires_at,accepted_by_identity_id)
        VALUES('invite-history','w-primary',?,'invite@example.test','native-invite','accepted','2099-01-01','native-invite')`).bind("i".repeat(43)),
      db.prepare(`INSERT INTO portal_v2_legacy_member_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
        VALUES('w-primary','native-invite','a-primary','i-primary','invite-history')`),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id)
        VALUES('w-shell','native-shell','a-bridge','i-bridge')`),
    ]);
    before = await snapshot();
    beforeGlobalCheck = await globalQuickCheck();
    beforeTableChecks = await tableQuickChecks();
    oldTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results;
    const migration = readFileSync(new URL("../migrations/0157_delivery_source_provenance.sql", import.meta.url), "utf8");
    // D1 applies the whole upgrade atomically; no dropping FK enforcement and
    // no semicolon splitter that would silently break trigger bodies.
    await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
    after = await snapshot();
    afterGlobalCheck = await globalQuickCheck();
    afterTableChecks = await tableQuickChecks();
    console.info("Delivery migration integrity diagnostic", { before0157: beforeGlobalCheck, after0157: afterGlobalCheck });
    const namesBefore = new Set(oldTriggers.map(row => row.name));
    retainedTriggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all<Row>()).results.filter(row => namesBefore.has(row.name));
    backfillAccounts = (await db.prepare("SELECT id,project_alpha_source_id FROM client_accounts ORDER BY id").all<Row>()).results;
    backfillProjects = (await db.prepare("SELECT id,project_alpha_source_id FROM projects ORDER BY id").all<Row>()).results;
  }, 60_000);
  afterAll(async () => runtime?.dispose());

  it("preserves every populated ID, grant, history, JSON byte string and existing trigger", async () => {
    expect(after).toEqual(before);
    expect(retainedTriggers).toEqual(oldTriggers);
    expect(after.client_feedback[0]?.target_json).toBe(historicalJson);
    expect(after.client_service_request_draft_mutations[0]?.result_snapshot_json).toBe(historicalJson);
    expect(after.client_delivery_grants).toHaveLength(1);
    expect(after.client_project_grants).toHaveLength(3);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(afterGlobalCheck).toEqual(beforeGlobalCheck);
    if ("rows" in beforeGlobalCheck) expect(beforeGlobalCheck.rows).toEqual(["ok"]);
    expect(beforeTableChecks).toEqual(tables.map(() => ["ok"]));
    expect(afterTableChecks).toEqual(tables.map(() => ["ok"]));
  });

  it("backfills only already linked records without interpreting the raw reference namespace", () => {
    expect(backfillAccounts).toEqual([
      { id: "a-bridge", project_alpha_source_id: null }, { id: "a-empty-ref", project_alpha_source_id: primary },
      { id: "a-local", project_alpha_source_id: null }, { id: "a-primary", project_alpha_source_id: primary },
      { id: "a-public", project_alpha_source_id: primary },
    ]);
    expect(backfillProjects).toEqual([{ id: "p-local", project_alpha_source_id: null },
      { id: "p-primary", project_alpha_source_id: primary }, { id: "p-public", project_alpha_source_id: primary }]);
    expect(after.client_accounts.find(row => row.id === "a-primary")?.project_alpha_client_id).toBe("17");
    expect(after.client_accounts.find(row => row.id === "a-public")?.project_alpha_client_id).toBe("b".repeat(32));
  });

  it("allows identical Alpha client, organization and project references in different sources only", async () => {
    await db.batch([account("b-collision", secondary, "17", "org-old"), project("b-project", secondary, "41")]);
    expect(await db.prepare("SELECT id FROM client_accounts WHERE project_alpha_source_id=? AND project_alpha_client_id='17'").bind(primary).first("id")).toBe("a-primary");
    expect(await db.prepare("SELECT id FROM client_accounts WHERE project_alpha_source_id=? AND project_alpha_client_id='17'").bind(secondary).first("id")).toBe("b-collision");
    await expect(account("a-duplicate", primary, "17").run()).rejects.toThrow(/source identity|UNIQUE/i);
    await expect(account("b-duplicate-org", secondary, null, "org-old").run()).rejects.toThrow(/source identity|UNIQUE/i);
    await expect(project("b-duplicate-project", secondary, "41").run()).rejects.toThrow(/source identity|UNIQUE/i);
  });

  it("requires explicit valid source for newly written references but leaves genuinely local records null", async () => {
    await db.batch([account("new-local", null), project("new-local-project", null)]);
    await expect(account("missing-source", null, "new-ref").run()).rejects.toThrow(/explicit source/i);
    await expect(account("missing-org-source", null, null, "new-org").run()).rejects.toThrow(/explicit source/i);
    await expect(project("missing-project-source", null, "new-ref").run()).rejects.toThrow(/explicit source/i);
    await expect(db.prepare("UPDATE client_accounts SET project_alpha_client_id='new-ref' WHERE id='new-local'").run()).rejects.toThrow(/explicit source/i);
    await expect(db.prepare("UPDATE projects SET project_alpha_project_id='new-ref' WHERE id='new-local-project'").run()).rejects.toThrow(/explicit source/i);
    for (const [index, source] of ["", "primary", "project-alpha:", "project-alpha:UPPER", "project-alpha:a/b", "project-alpha:a\u0000b", "project-alpha:a\n", `project-alpha:${"a".repeat(65)}`].entries()) {
      await expect(account(`invalid-source-${index}`, source).run()).rejects.toThrow(/CHECK/i);
      await expect(project(`invalid-project-source-${index}`, source).run()).rejects.toThrow(/CHECK/i);
    }
    expect(await db.prepare("SELECT project_alpha_source_id FROM client_accounts WHERE id='new-local'").first("project_alpha_source_id")).toBeNull();
  });

  it("does not relabel established source or local identity through UPDATE or REPLACE", async () => {
    for (const source of [secondary, null]) {
      await expect(db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='a-primary'").bind(source).run()).rejects.toThrow(/immutable|explicit source/i);
      await expect(db.prepare("UPDATE projects SET project_alpha_source_id=? WHERE id='p-primary'").bind(source).run()).rejects.toThrow(/immutable|explicit source/i);
    }
    await expect(db.prepare("UPDATE client_accounts SET id='stolen-local-id' WHERE id='a-primary'").run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare("UPDATE projects SET id='stolen-project-id' WHERE id='p-primary'").run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO client_accounts(id,display_name,project_alpha_source_id,project_alpha_client_id)
      VALUES('a-primary','Replaced',?,'17')`).bind(secondary).run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES('p-primary','Replaced','Replaced','Wrong/',?,'41')`).bind(secondary).run()).rejects.toThrow(/immutable/i);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_feedback WHERE id='feedback-history'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_delivery_grants WHERE share_id='share-history'").first("count")).toBe(1);
  });

  it("does not steal a source-qualified external reference into a different local ID via REPLACE", async () => {
    await expect(db.prepare(`INSERT OR REPLACE INTO client_accounts(id,display_name,project_alpha_source_id,project_alpha_client_id)
      VALUES('replacement-owner','Replaced',?,'17')`).bind(primary).run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES('replacement-project','Replaced','Replaced','Wrong/',?,'41')`).bind(primary).run()).rejects.toThrow(/immutable/i);
    await db.prepare(`INSERT INTO projects(id,external_ref,client_name,project_name,r2_prefix,project_alpha_source_id)
      VALUES('global-reference-owner','original-global-key','Original','Original','Original/',?)`).bind(primary).run();
    await expect(db.prepare(`INSERT OR REPLACE INTO projects(id,external_ref,client_name,project_name,r2_prefix,project_alpha_source_id)
      VALUES('global-reference-thief','original-global-key','Replaced','Replaced','Wrong/',?)`).bind(secondary).run()).rejects.toThrow(/immutable/i);
    await db.batch([account('update-reference-thief',primary),project('update-project-thief',secondary)]);
    await expect(db.prepare("UPDATE OR REPLACE client_accounts SET project_alpha_client_id='17' WHERE id='update-reference-thief'").run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare("UPDATE OR REPLACE projects SET external_ref='original-global-key' WHERE id='update-project-thief'").run()).rejects.toThrow(/immutable/i);
    expect(await db.prepare("SELECT id FROM projects WHERE external_ref='original-global-key'").first("id")).toBe("global-reference-owner");
    expect(await db.prepare("SELECT account_id FROM client_identity_links WHERE id='i-primary'").first("account_id")).toBe("a-primary");
  });

  it("preserves valid same-ID/source UPSERT and same-source organization reconciliation", async () => {
    await db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES('p-primary','Historical client','Updated project','Clients/Primary/',?,'41')
      ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name WHERE projects.project_alpha_source_id=excluded.project_alpha_source_id`).bind(primary).run();
    await db.prepare(`INSERT INTO client_accounts(id,display_name,project_alpha_source_id,project_alpha_client_id,project_alpha_organization_id)
      VALUES('a-primary','Updated client',?,'17','org-next') ON CONFLICT(id) DO UPDATE
      SET display_name=excluded.display_name,project_alpha_organization_id=excluded.project_alpha_organization_id
      WHERE client_accounts.project_alpha_source_id=excluded.project_alpha_source_id`).bind(primary).run();
    expect(await db.prepare("SELECT project_alpha_organization_id FROM client_accounts WHERE id='a-primary'").first("project_alpha_organization_id")).toBe("org-next");
    expect(await db.prepare("SELECT project_alpha_source_id FROM client_accounts WHERE id='a-primary'").first("project_alpha_source_id")).toBe(primary);
    expect(await db.prepare("SELECT target_json FROM client_feedback WHERE id='feedback-history'").first("target_json")).toBe(historicalJson);
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_workspaces WHERE id='w-primary'").first("legacy_account_id")).toBe("a-primary");
  });

  it("allows explicit local-to-primary adoption without changing history or unrevoked native bridge identity", async () => {
    await expect(db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='a-local'").bind(secondary).run()).rejects.toThrow(/immutable|different source/i);
    await expect(db.prepare("UPDATE projects SET project_alpha_source_id=? WHERE id='p-local'").bind(secondary).run()).rejects.toThrow(/immutable|different source/i);
    await expect(db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='a-bridge'").bind(secondary).run()).rejects.toThrow(/immutable|different source/i);
    await db.batch([
      db.prepare("UPDATE client_accounts SET project_alpha_source_id=?,project_alpha_client_id='local-adopted' WHERE id='a-local'").bind(primary),
      db.prepare("UPDATE projects SET project_alpha_source_id=?,project_alpha_project_id='local-project-adopted' WHERE id='p-local'").bind(primary),
      db.prepare("UPDATE client_accounts SET project_alpha_source_id=?,project_alpha_client_id='bridge-adopted' WHERE id='a-bridge'").bind(primary),
    ]);
    expect(await db.prepare("SELECT account_id FROM client_service_requests WHERE id='request-local'").first("account_id")).toBe("a-local");
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_identity_eligibility_legacy_bridges WHERE workspace_id='w-shell'").first("legacy_account_id")).toBe("a-bridge");
    expect(await db.prepare("SELECT revoked_at FROM client_project_grants WHERE account_id='a-primary' AND project_id='p-local'").first("revoked_at")).toBe(at);
  });

  it("never reinterprets a local parent as secondary, including empty and historical parents", async () => {
    await db.batch([account("unbound-account", null), project("unbound-project", null),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,revoked_at) VALUES('unbound-account','unbound-project',?)").bind(at)]);
    await expect(db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='unbound-account'").bind(secondary).run()).rejects.toThrow(/immutable|different source/i);
    await expect(db.prepare("UPDATE projects SET project_alpha_source_id=? WHERE id='unbound-project'").bind(secondary).run()).rejects.toThrow(/immutable|different source/i);
    await expect(db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='new-local'").bind(secondary).run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare("UPDATE projects SET project_alpha_source_id=? WHERE id='new-local-project'").bind(secondary).run()).rejects.toThrow(/immutable/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO client_accounts(id,display_name,project_alpha_source_id)
      VALUES('unbound-account','Replacement',?)`).bind(secondary).run()).rejects.toThrow(/immutable/i);
    expect(await db.prepare("SELECT project_alpha_source_id FROM client_accounts WHERE id='unbound-account'").first("project_alpha_source_id")).toBeNull();
  });

  it("accepts same-source and legacy local/primary edges but rejects cross-source project and folder inserts", async () => {
    await db.batch([account("relation-a", primary), account("relation-b", secondary), account("relation-local", null),
      project("relation-pa", primary), project("relation-pb", secondary), project("relation-pl", null)]);
    for (const [accountId, projectId] of [["relation-a", "relation-pa"], ["relation-a", "relation-pl"],
      ["relation-local", "relation-pa"], ["relation-local", "relation-pl"], ["relation-b", "relation-pb"]] as const) {
      await db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES(?,?)").bind(accountId, projectId).run();
      await folder(`valid-${accountId}-${projectId}`, accountId, projectId).run();
    }
    for (const [accountId, projectId] of [["relation-a", "relation-pb"], ["relation-local", "relation-pb"],
      ["relation-b", "relation-pa"], ["relation-b", "relation-pl"]] as const) {
      await expect(db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES(?,?)").bind(accountId, projectId).run()).rejects.toThrow(/sources must agree/i);
      await expect(folder(`invalid-${accountId}-${projectId}`, accountId, projectId).run()).rejects.toThrow(/sources must agree/i);
      await expect(folder(`invalid-revoked-${accountId}-${projectId}`, accountId, projectId, at).run()).rejects.toThrow(/sources must agree/i);
    }
  });

  it("checks relation rebinding and reactivation before the legacy bridge auto-grant trigger", async () => {
    await db.batch([project("autogrant-primary", primary), project("autogrant-secondary", secondary),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,revoked_at) VALUES('a-primary','autogrant-primary',?)").bind(at),
      folder("reactivation-folder", "a-primary", "autogrant-primary", at)]);
    await expect(db.prepare("UPDATE client_project_grants SET project_id='autogrant-secondary',revoked_at=NULL WHERE account_id='a-primary' AND project_id='autogrant-primary'").run()).rejects.toThrow(/sources must agree/i);
    await expect(db.prepare("UPDATE client_folder_associations SET project_id='autogrant-secondary',revoked_at=NULL WHERE id='reactivation-folder'").run()).rejects.toThrow(/sources must agree/i);
    await expect(db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES('a-primary','autogrant-secondary')").run()).rejects.toThrow(/sources must agree/i);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_member_project_grants WHERE project_id='autogrant-secondary'").first("count")).toBe(0);
    await db.prepare("UPDATE client_project_grants SET revoked_at=NULL WHERE account_id='a-primary' AND project_id='autogrant-primary'").run();
    await db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES('a-primary','p-public')").run();
    expect(await db.prepare("SELECT COUNT(*) count FROM client_member_project_grants WHERE account_id='a-primary' AND project_id='p-public' AND revoked_at IS NULL").first("count")).toBe(1);
  });

  it("does not enable secondary native workspaces or either legacy bridge path", async () => {
    await db.batch([account("native-secondary", secondary),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject) VALUES('native-secondary-legacy','native-secondary','https://issuer.test','secondary-legacy')")]);
    await expect(db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,legacy_account_id,display_name)
      VALUES('native-secondary-workspace','standalone_client','secondary-root','native-secondary','No secondary native portal')`).run()).rejects.toThrow(/primary delivery source/i);
    await expect(db.prepare("UPDATE portal_v2_workspaces SET legacy_account_id='native-secondary' WHERE id='w-shell'").run()).rejects.toThrow(/primary delivery source/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO portal_v2_legacy_member_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
      VALUES('w-primary','native-invite','native-secondary','native-secondary-legacy','invite-history')`).run()).rejects.toThrow(/primary delivery source/i);
    await expect(db.prepare(`INSERT OR REPLACE INTO portal_v2_identity_eligibility_legacy_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id)
      VALUES('w-shell','native-shell','native-secondary','native-secondary-legacy')`).run()).rejects.toThrow(/primary delivery source/i);
    for (const table of ["portal_v2_legacy_member_bridges", "portal_v2_identity_eligibility_legacy_bridges"]) {
      await expect(db.prepare(`UPDATE ${table} SET legacy_account_id='native-secondary',legacy_identity_id='native-secondary-legacy'`).run()).rejects.toThrow(/primary delivery source/i);
    }
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_legacy_member_bridges WHERE workspace_id='w-primary'").first("legacy_account_id")).toBe("a-primary");
  });

  it("rolls back all writes when a source-binding/grant race crosses ownership", async () => {
    await db.batch([account("race-account", null), project("race-project", secondary)]);
    await expect(db.batch([
      db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='race-account'").bind(primary),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES('race-account','race-project')"),
    ])).rejects.toThrow(/sources must agree/i);
    expect(await db.prepare("SELECT project_alpha_source_id FROM client_accounts WHERE id='race-account'").first("project_alpha_source_id")).toBeNull();
    await db.prepare("UPDATE client_accounts SET project_alpha_source_id=? WHERE id='race-account'").bind(primary).run();
    await expect(db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES('race-account','race-project')").run()).rejects.toThrow(/sources must agree/i);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_project_grants WHERE account_id='race-account'").first("count")).toBe(0);
  });

  it("uses source-qualified indexes for exact references and keeps foreign-key integrity", async () => {
    for (const [sql, index] of [
      ["SELECT id FROM client_accounts WHERE project_alpha_source_id=? AND project_alpha_client_id='17'", "idx_client_accounts_pa_client"],
      ["SELECT id FROM client_accounts WHERE project_alpha_source_id=? AND project_alpha_organization_id='org-next'", "idx_client_accounts_pa_organization"],
      ["SELECT id FROM projects WHERE project_alpha_source_id=? AND project_alpha_project_id='41'", "idx_projects_pa_project"],
    ] as const) {
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(primary).all<{ detail: string }>()).results.map(row => row.detail).join("\n");
      expect(plan).toContain(index);
      expect(plan).toContain("project_alpha_source_id=?");
    }
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await tableQuickChecks()).toEqual(tables.map(() => ["ok"]));
  });
});
