import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileClientHubIndex } from "../src/worker/client-hub-index";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const runtimes: Miniflare[] = [];
async function fixture() {
  const runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }",
    d1Databases: { OPS_DB: "index-ops", DELIVERY_DB: "index-delivery" } });
  runtimes.push(runtime);
  const ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  const delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const execute = (db: D1Database, sql: string) => db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  await execute(ops, `
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,client_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
  `);
  await execute(ops, readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8"));
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0034_client_hub_projection_sources.sql", import.meta.url), "utf8")).map(statement => ops.prepare(statement)));
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0042_client_hub_secondary_portal_visibility.sql", import.meta.url), "utf8")).map(statement => ops.prepare(statement)));
  await execute(delivery, `
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,project_alpha_client_id TEXT,project_alpha_organization_id TEXT,project_alpha_source_id TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,display_name TEXT,status TEXT,legacy_account_id TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,display_name TEXT,email_hint TEXT,status TEXT,PRIMARY KEY(workspace_id,public_id));
    CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT);
    CREATE TABLE client_service_requests(id TEXT PRIMARY KEY,account_id TEXT);
    CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,parent_public_id TEXT,active INTEGER,source_version TEXT);
    CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT);
    CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER);
    CREATE TABLE pa_portal_source_authority_revisions(source_id TEXT,revision INTEGER);
    INSERT INTO portal_v2_workspace_memberships VALUES('membership','workspace','identity');
  `);
  return { ops, delivery, env: { OPS_DB: ops, DELIVERY_DB: delivery } };
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });

async function finish(env: { OPS_DB: D1Database; DELIVERY_DB: D1Database }) {
  for (let count = 0; count < 30; count++) {
    // Every prepared statement here is executed, including all batch entries.
    // The wrapper observes both direct queries and session-bound source reads.
    let queries = 0;
    const counted = <T extends D1Database | D1DatabaseSession>(db: T): T => new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
        if (key === "withSession" && "withSession" in target)
          return (constraint?: D1SessionBookmark | D1SessionConstraint) => counted(target.withSession(constraint));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await reconcileClientHubIndex({ OPS_DB: counted(env.OPS_DB), DELIVERY_DB: counted(env.DELIVERY_DB) }, 40);
    expect(queries).toBeLessThanOrEqual(800);
    if (result.status === "complete") return;
    expect(result.status).toBe("progress");
  }
  throw new Error("Index did not finish within test bound");
}
async function nextCycle(ops: D1Database) {
  await ops.prepare("UPDATE client_hub_directory_state SET next_run_at=NULL").run();
}
async function projectWorkspace(delivery: D1Database, workspace: string, kind: string, root: string, legacy = false) {
  const generation = `generation-${workspace}`, sequence = legacy ? 0 : 1;
  await delivery.batch([
    delivery.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,?,?, 'active',1)")
      .bind(generation, workspace, legacy ? "legacy-backfill" : "native-1", sequence),
    delivery.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,?)").bind(workspace, generation, sequence),
    delivery.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,?,NULL,1,?)")
      .bind(workspace, generation, kind, root, legacy ? "legacy-backfill" : "native-version"),
  ]);
}

describe("resumable Client Hub index", { timeout: 60_000 }, () => {
  it("indexes an exactly authorized secondary portal without borrowing primary account associations", async () => {
    const { ops, delivery, env } = await fixture(), publicId = "a".repeat(32);
    await ops.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id)
      VALUES('primary-org','Primary',1,?,'project-alpha:primary'),('secondary-org','Secondary',1,?,'project-alpha:secondary')`)
      .bind(JSON.stringify({ public_id: publicId }), JSON.stringify({ public_id: publicId })).run();
    await ops.prepare(`INSERT INTO pa_clients(id,name,organization_id,active,payload_json,projection_source_id)
      VALUES('secondary-contact','Secondary contact','secondary-org',1,'{"email":"secondary@example.test"}','project-alpha:secondary')`).run();
    await delivery.prepare("INSERT INTO client_accounts VALUES('account','Primary account','active',NULL,'primary-org','project-alpha:primary')").run();
    await delivery.prepare("INSERT INTO client_accounts VALUES('secondary-account','Same raw ID','active',NULL,'primary-org','project-alpha:secondary')").run();
    await delivery.prepare("INSERT INTO client_project_grants VALUES('secondary-account','secondary-share',NULL)").run();
    await delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('workspace','organization',?,NULL,'Primary portal','active','account')").bind(publicId).run();
    await projectWorkspace(delivery, "workspace", "organization", publicId);
    await delivery.prepare("INSERT INTO pa_portal_principals VALUES('workspace','person','Primary person','primary@example.test','active')").run();
    await delivery.prepare(`INSERT INTO portal_v2_workspaces
      (id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
      VALUES('secondary-workspace','organization',?,'Secondary portal','active','project-alpha:secondary')`).bind(publicId).run();
    await projectWorkspace(delivery, "secondary-workspace", "organization", publicId);
    await delivery.prepare("INSERT INTO pa_portal_principals VALUES('secondary-workspace','person','Other source person','other-source@example.test','active')").run();
    await delivery.batch([
      delivery.prepare("INSERT INTO pa_portal_workspace_sources VALUES('secondary-workspace','project-alpha:secondary','source-secondary-workspace')"),
      delivery.prepare("INSERT INTO pa_portal_source_authorities VALUES('project-alpha:secondary','active',1)"),
      delivery.prepare("INSERT INTO pa_portal_source_authority_revisions VALUES('project-alpha:secondary',1)"),
    ]);
    await finish(env);
    expect(await ops.prepare("SELECT source_id,pa_public_id,mapping_status,workspace_id,account_count,contact_count,portal_status FROM client_hub_roots WHERE public_id='secondary-org'").first())
      .toEqual({ source_id: "project-alpha:secondary", pa_public_id: publicId, mapping_status: "mapped", workspace_id: "secondary-workspace", account_count: 0, contact_count: 2, portal_status: "active" });
    expect(await ops.prepare("SELECT source_id,root_public_id FROM client_hub_search_values WHERE normalized_value='secondary@example.test'").first())
      .toEqual({ source_id: "project-alpha:secondary", root_public_id: "secondary-org" });
    expect(await ops.prepare("SELECT workspace_id,account_count,project_count FROM client_hub_roots WHERE public_id='primary-org'").first()).toEqual({ workspace_id: "workspace", account_count: 1, project_count: 0 });
    expect(await ops.prepare("SELECT count(*) count FROM client_hub_roots WHERE root_namespace='portal' AND public_id='secondary-workspace'").first("count")).toBe(0);
    expect(await ops.prepare("SELECT source_id,root_public_id FROM client_hub_search_values WHERE normalized_value='other-source@example.test'").first())
      .toEqual({ source_id: "project-alpha:secondary", root_public_id: "secondary-org" });
  });
  it("backfills more than 500 roots with bounded pages and resumes from its persisted checkpoint", async () => {
    const { ops, env } = await fixture();
    await ops.prepare(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n<619)
      INSERT INTO pa_organizations(id,name,active,payload_json) SELECT printf('%04d',n),'Organization '||printf('%04d',n),1,'{}' FROM sequence`).run();
    expect(await reconcileClientHubIndex(env, 1)).toEqual({ status: "progress", pages: 1 });
    expect(await ops.prepare("SELECT count(*) count FROM client_hub_roots").first("count")).toBe(20);
    expect(await ops.prepare("SELECT ready FROM client_hub_directory_state").first("ready")).toBe(0);
    expect(await ops.prepare("SELECT backfill_cursor FROM client_hub_directory_state").first("backfill_cursor")).toBe("0019");
    await finish(env);
    expect(await ops.prepare("SELECT count(*) count FROM client_hub_roots WHERE status='active'").first("count")).toBe(620);
    expect(await ops.prepare("SELECT ready FROM client_hub_directory_state").first("ready")).toBe(1);
    expect(await ops.prepare("SELECT lease_token FROM client_hub_directory_state").first("lease_token")).toBeNull();
  }, 120_000);

  it("keeps colliding source records and principal identities separate; only contact scalars are indexed", async () => {
    const { ops, delivery, env } = await fixture();
    await ops.batch([
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('org','Business',1,'{}')"),
      ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('same','Source customer',NULL,1,?)")
        .bind(JSON.stringify({ email: "source@example.test", phone: "+1 (920) 555-1234", price: 98765, notes: "secret business notes" })),
      ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('contact','Business contact','org',1,'{}')"),
      ops.prepare("INSERT INTO pa_projects(id,name,organization_id,client_id,active) VALUES('project','Roof survey','org','contact',1)"),
    ]);
    await delivery.batch([
      delivery.prepare("INSERT INTO client_accounts VALUES('same','Local customer','active',NULL,NULL,NULL)"),
      delivery.prepare("INSERT INTO client_accounts VALUES('linked','Business account','active','contact','org','project-alpha:primary')"),
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('workspace','organization','org',NULL,'Business portal','active','linked')"),
      delivery.prepare("INSERT INTO pa_portal_principals VALUES('workspace','contact','Different portal person','portal@example.test','active')"),
      delivery.prepare("INSERT INTO client_project_grants VALUES('linked','shared-project',NULL)"),
      delivery.prepare("INSERT INTO client_service_requests VALUES('request','linked')"),
    ]);
    await projectWorkspace(delivery, "workspace", "organization", "org", true);
    await finish(env);
    const collision = await ops.prepare("SELECT source_id,display_name FROM client_hub_roots WHERE public_id='same' ORDER BY source_id").all();
    expect(collision.results).toEqual([
      { source_id: "delivery:local", display_name: "Local customer" },
      { source_id: "project-alpha:primary", display_name: "Source customer" },
    ]);
    const business = await ops.prepare("SELECT account_count,project_count,request_count,contact_count FROM client_hub_roots WHERE public_id='org'").first();
    expect(business).toEqual({ account_count: 1, project_count: 1, request_count: 1, contact_count: 2 });
    const search = await ops.prepare("SELECT record_type,field,normalized_value,project_id FROM client_hub_search_values ORDER BY record_type,field").all();
    expect(search.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_type: "pa_client", field: "contact", normalized_value: "business contact" }),
      expect.objectContaining({ record_type: "portal_principal", field: "contact", normalized_value: "different portal person" }),
      expect.objectContaining({ field: "phone", normalized_value: "19205551234" }),
      expect.objectContaining({ field: "project", normalized_value: "roof survey project", project_id: "project" }),
    ]));
    expect(JSON.stringify(search.results)).not.toMatch(/secret business notes|98765/);
    expect(await delivery.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(1);
  });

  it("unchanged reconciliation preserves revision; changed ownership and removals clear stale fields", async () => {
    const { ops, env } = await fixture();
    await ops.batch([
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('a','A',1,'{}')"),
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('b','B',1,'{}')"),
      ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('contact','Contact','a',1,?)").bind('{"email":"old@example.test"}'),
    ]);
    await finish(env);
    const revision = await ops.prepare("SELECT revision FROM client_hub_directory_state").first("revision");
    await nextCycle(ops); await finish(env);
    expect(await ops.prepare("SELECT revision FROM client_hub_directory_state").first("revision")).toBe(revision);
    await ops.prepare("UPDATE pa_clients SET organization_id='b',payload_json='{}' WHERE id='contact'").run();
    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id='a'").run();
    await nextCycle(ops); await finish(env);
    expect(await ops.prepare("SELECT status FROM client_hub_roots WHERE public_id='a'").first("status")).toBe("inactive");
    expect((await ops.prepare("SELECT root_public_id,field FROM client_hub_search_values").all()).results).toEqual([{ root_public_id: "b", field: "contact" }]);
    await ops.prepare("UPDATE pa_organizations SET active=1 WHERE id='a'").run();
    await nextCycle(ops); await finish(env);
    expect(await ops.prepare("SELECT status FROM client_hub_roots WHERE public_id='a'").first("status")).toBe("active");
  });

  it("does not infer a business identity from an equal raw portal ID, including inactive sources", async () => {
    const { ops, delivery, env } = await fixture();
    await ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('inactive','Inactive source',0,'{}')").run();
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('old','organization','inactive',NULL,'Old portal','active',NULL)"),
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('only','organization','portal-only',NULL,'Portal only','active',NULL)"),
    ]);
    await finish(env);
    expect((await ops.prepare("SELECT root_namespace,public_id,workspace_id,portal_status FROM client_hub_roots ORDER BY public_id").all()).results).toEqual([
      { root_namespace: "portal", public_id: "old", workspace_id: null, portal_status: "projection_pending" },
      { root_namespace: "portal", public_id: "only", workspace_id: null, portal_status: "projection_pending" },
    ]);
  });

  it("does not count a reassigned legacy account under its old workspace root", async () => {
    const { ops, delivery, env } = await fixture();
    await ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('old','Old owner',1,'{}'),('new','New owner',1,'{}')").run();
    await delivery.batch([
      delivery.prepare("INSERT INTO client_accounts VALUES('account','Reassigned account','active',NULL,'new','project-alpha:primary')"),
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('workspace','organization','old',NULL,'Old portal','active','account')"),
      delivery.prepare("INSERT INTO client_project_grants VALUES('account','project',NULL)"),
      delivery.prepare("INSERT INTO client_service_requests VALUES('request','account')"),
    ]);
    await finish(env);
    const counts = await ops.prepare("SELECT public_id,account_count,project_count,request_count FROM client_hub_roots ORDER BY public_id").all();
    expect(counts.results).toEqual([
      { public_id: "new", account_count: 1, project_count: 1, request_count: 1 },
      { public_id: "old", account_count: 0, project_count: 0, request_count: 0 },
      { public_id: "workspace", account_count: 0, project_count: 0, request_count: 0 },
    ]);
  });

  it("folds a portal-only row only after explicit native public-ID proof; preserves colliding business IDs", async () => {
    const { ops, delivery, env } = await fixture();
    const publicId = "00000000000000000000000000000042";
    await ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('42','Actual business',1,'{}'),('workspace','Unrelated business',1,'{}')").run();
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,pa_client_public_id,display_name,status,legacy_account_id) VALUES('workspace','organization',?,NULL,'Portal only','active',NULL)").bind(publicId),
      delivery.prepare("INSERT INTO pa_portal_principals VALUES('workspace','42','Portal contact','contact@example.test','active')"),
    ]);
    await projectWorkspace(delivery, "workspace", "organization", publicId);
    await finish(env);
    expect((await ops.prepare("SELECT root_namespace,public_id FROM client_hub_roots WHERE status='active' ORDER BY root_namespace,public_id").all()).results).toEqual([
      { root_namespace: "business", public_id: "42" }, { root_namespace: "business", public_id: "workspace" },
      { root_namespace: "portal", public_id: "workspace" },
    ]);
    expect(await ops.prepare("SELECT root_namespace FROM client_hub_search_values WHERE record_type='portal_principal' LIMIT 1").first("root_namespace")).toBe("portal");
    await ops.prepare("UPDATE pa_organizations SET payload_json=? WHERE id='42'").bind(JSON.stringify({ id: 42, public_id: publicId })).run();
    await nextCycle(ops); await finish(env);
    expect(await ops.prepare("SELECT workspace_id FROM client_hub_roots WHERE root_namespace='business' AND public_id='42'").first("workspace_id")).toBe("workspace");
    expect(await ops.prepare("SELECT status FROM client_hub_roots WHERE root_namespace='portal' AND public_id='workspace'").first("status")).toBe("inactive");
    expect((await ops.prepare("SELECT DISTINCT root_namespace,root_public_id FROM client_hub_search_values WHERE record_type='portal_principal'").all()).results)
      .toEqual([{ root_namespace: "business", root_public_id: "42" }]);
    expect(await ops.prepare("SELECT workspace_id FROM client_hub_roots WHERE root_namespace='business' AND public_id='workspace'").first("workspace_id")).toBeNull();
    expect(await delivery.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(1);
  });

  it("honors the lease and refresh interval, and releases the lease after a failed page", async () => {
    const { ops, env } = await fixture();
    await ops.prepare("UPDATE client_hub_directory_state SET lease_token='another-worker',lease_until=datetime('now','+2 minutes')").run();
    expect(await reconcileClientHubIndex(env)).toEqual({ status: "busy", pages: 0 });
    expect(await ops.prepare("SELECT lease_token FROM client_hub_directory_state").first("lease_token")).toBe("another-worker");
    await ops.prepare("UPDATE client_hub_directory_state SET lease_until=datetime('now','-1 minute')").run();
    await finish(env);
    expect(await reconcileClientHubIndex(env)).toEqual({ status: "busy", pages: 0 });
    await nextCycle(ops);
    await ops.prepare("UPDATE client_hub_directory_state SET backfill_phase='invalid'").run();
    await expect(reconcileClientHubIndex(env)).rejects.toThrow("invalid-phase");
    expect(await ops.prepare("SELECT lease_token FROM client_hub_directory_state").first("lease_token")).toBeNull();
    await expect(reconcileClientHubIndex(env, 41)).rejects.toThrow("page-budget");
  });
});
