import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare;
let db: D1Database;

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    compatibilityDate: "2026-08-06",
    script: "export default { fetch() { return new Response('local test'); } }",
    d1Databases: ["OPS_DB"],
  });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files.at(-1)).toBe("0183_project_alpha_binding_standalone_relationship_rows.sql");
  for (const file of files) {
    const sql = readFileSync(new URL(file, directory), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
  }
}, 120_000);

afterAll(async () => { await runtime?.dispose(); });

it("preserves the 0171 outgoing-settlement guard predicate in migration 0173", () => {
  const read = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const extractOutgoingBranch = (sql: string, hasInboundBranch: boolean) => {
    const trigger = sql.indexOf("CREATE TRIGGER operations_shared_projects_no_update");
    const start = sql.indexOf("WHEN NOT EXISTS (", trigger);
    const end = hasInboundBranch ? sql.indexOf(") AND NOT EXISTS (", start) : sql.indexOf("\nBEGIN", start);
    expect(trigger).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return sql.slice(start, end).replace(/\s+/g, "");
  };
  const previous = extractOutgoingBranch(read("0171_project_alpha_active_directory_update_guard.sql"), false);
  const current = `${extractOutgoingBranch(read("0178_project_alpha_project_inbound_reconciliation.sql"), true)})`;
  expect(current).toBe(previous);
});

it("applies migration 0178 in D1 and executes the full update guard without expression-depth failure", async () => {
  const authorizationTriggers = await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
    AND substr(name,1,length('project_alpha_project_inbound_resolution_authorizations_'))
      ='project_alpha_project_inbound_resolution_authorizations_'
    AND substr(name,-6)='_exact'
    ORDER BY name`).all<{ name: string }>();
  expect(authorizationTriggers.results.map(row => row.name)).toEqual([
    "project_alpha_project_inbound_resolution_authorizations_allow_exact",
    "project_alpha_project_inbound_resolution_authorizations_authority_exact",
    "project_alpha_project_inbound_resolution_authorizations_deny_exact",
    "project_alpha_project_inbound_resolution_authorizations_directory_exact",
    "project_alpha_project_inbound_resolution_authorizations_project_mapping_exact",
    "project_alpha_project_inbound_resolution_authorizations_proposal_exact",
    "project_alpha_project_inbound_resolution_authorizations_remote_exact",
  ]);
  const trigger = await db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
    AND name='operations_shared_projects_no_update'`).first<{ sql: string }>();
  expect(trigger?.sql).toContain("project_alpha_project_inbound_resolution_authorizations");
  await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,
    canonical_projection_sha256) VALUES('d1-unbound-project','Unbound','not_started','[]',?)`)
    .bind("a".repeat(64)).run();
  await expect(db.prepare(`UPDATE operations_shared_projects SET name='unauthorized update'
    WHERE external_project_id='d1-unbound-project'`).run()).rejects.toThrow(/versioned writer/);
  expect(await db.prepare(`SELECT name FROM operations_shared_projects
    WHERE external_project_id='d1-unbound-project'`).first<{ name: string }>()).toEqual({ name: "Unbound" });
});
