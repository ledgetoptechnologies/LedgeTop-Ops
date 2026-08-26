import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provePrimaryBusinessReferences } from "../src/worker/project-alpha-primary-references";
import { sourcePublicIdExpression } from "../src/worker/client-hub-source";
import type { Env } from "../src/worker/types";

const secondary = "project-alpha:secondary";
const primarySources = { accountSourceId: "project-alpha:primary", projectSourceId: "project-alpha:primary" };
const clientPublic = "a".repeat(32), orgPublic = "b".repeat(32), projectPublic = "c".repeat(32);
const migrations = (directory: URL) => readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name)).sort()
  .map(name => readFileSync(new URL(name, directory), "utf8"));
const opsMigrations = migrations(new URL("../migrations/", import.meta.url));
const deliveryMigrations = migrations(new URL("../../client/migrations/", import.meta.url));

// Execute production SQL against SQLite; no storage mocks choose query results.
function d1(db: DatabaseSync): D1Database {
  const adapter = {
    withSession: () => adapter,
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...input: SQLInputValue[]) { values = input; return statement; },
        async all() { return { results: db.prepare(sql).all(...values) }; },
      };
      return statement;
    },
  };
  return adapter as unknown as D1Database;
}

describe("primary outbound business provenance", () => {
  let ops: DatabaseSync, delivery: DatabaseSync, env: Pick<Env, "OPS_DB" | "DELIVERY_DB">;
  beforeEach(() => {
    ops = new DatabaseSync(":memory:"); delivery = new DatabaseSync(":memory:");
    for (const [db, chain] of [[ops, opsMigrations], [delivery, deliveryMigrations]] as const)
      for (const source of chain) { db.exec("BEGIN"); db.exec(source); db.exec("COMMIT"); }
    env = { OPS_DB: d1(ops), DELIVERY_DB: d1(delivery) };
  });
  afterEach(() => { ops?.close(); delivery?.close(); });

  function business() {
    ops.prepare("INSERT INTO pa_organizations(id,name,payload_json,last_sync_id) VALUES('2','Organization',?,'test')")
      .run(JSON.stringify({ public_id: orgPublic }));
    ops.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id) VALUES('1','Client','2',?,'test')")
      .run(JSON.stringify({ public_id: clientPublic }));
    ops.prepare("INSERT INTO pa_projects(id,name,client_id,organization_id,payload_json,last_sync_id) VALUES('3','Project','1','2',?,'test')")
      .run(JSON.stringify({ public_id: projectPublic }));
  }
  function portal() {
    delivery.prepare("INSERT INTO client_accounts(project_alpha_source_id,id,display_name,status,project_alpha_client_id,project_alpha_organization_id) VALUES ('project-alpha:primary','account','Account','active',?,?)")
      .run(clientPublic, orgPublic);
    delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,legacy_account_id,display_name) VALUES('workspace','organization',?,'account','Workspace')").run(orgPublic);
    delivery.exec("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES('generation','workspace','source-generation',1,'active',1)");
    const insert = delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES('workspace','generation',?,?,?,'Source entity','source-v1')`);
    insert.run("organization", orgPublic, null); insert.run("client", clientPublic, orgPublic); insert.run("project", projectPublic, orgPublic);
    delivery.exec("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES('workspace','generation',1)");
    return { ...primarySources, clientId: clientPublic, organizationId: orgPublic, projectId: projectPublic, accountId: "account" };
  }

  it("preserves primary local identifiers and recognizes exact immutable primary public IDs", async () => {
    business();
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, clientId: "1", organizationId: "2", projectId: "3" })).toEqual({ available: true });
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, clientId: clientPublic, organizationId: orgPublic, projectId: projectPublic })).toEqual({ available: true });
    for (const table of ["pa_clients", "pa_organizations", "pa_projects"]) {
      const plan = ops.prepare(`EXPLAIN QUERY PLAN SELECT source.id,source.projection_source_id,source.active
        FROM ${table} source WHERE source.id=? OR
        (source.projection_source_id=? AND ?=1 AND ${sourcePublicIdExpression("source")}=?) LIMIT 2`)
        .all("unknown-local", "project-alpha:primary", 1, clientPublic);
      expect(plan.some(row => String(row.detail).includes(`idx_${table}_source_public_id`))).toBe(true);
      expect(plan.some(row => String(row.detail).startsWith("SCAN source"))).toBe(false);
    }
  });

  it("rejects an opaque secondary local identifier even with colliding public IDs and a working primary portal", async () => {
    business(); const refs = portal();
    ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'client','1','secondary-client')").run(secondary);
    ops.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id,projection_source_id) VALUES('secondary-client','Other',?,'test',?)")
      .run(JSON.stringify({ public_id: clientPublic }), secondary);
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, ...refs, clientId: "secondary-client" }))
      .toEqual({ available: false, reason: "unsupported_source" });
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, clientId: clientPublic })).toEqual({ available: true });
  });

  it("does not accept an unknown scalar or a same-name contact as primary provenance", async () => {
    business();
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, clientId: "Client" })).toEqual({ available: false, reason: "mapping_unavailable" });
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, clientId: "missing" })).toEqual({ available: false, reason: "mapping_unavailable" });
  });

  it.each(["account", "project"])("rejects a secondary %s source even when every raw ID matches the primary producer", async kind => {
    business();
    const refs = { ...primarySources, clientId: "1", organizationId: "2", projectId: "3",
      ...(kind === "account" ? { accountSourceId: secondary } : { projectSourceId: secondary }) };
    expect(await provePrimaryBusinessReferences(env, refs)).toEqual({ available: false, reason: "unsupported_source" });
  });

  it("does not interpret an unlinked or missing account source as primary quote authority", async () => {
    business();
    expect(await provePrimaryBusinessReferences(env, { accountSourceId: null, clientId: "1" }))
      .toEqual({ available: false, reason: "unsupported_source" });
  });

  it("supports an established verified primary portal without requiring unpublished v1 public-ID exports", async () => {
    const refs = portal();
    expect(await provePrimaryBusinessReferences(env, refs)).toEqual({ available: true });
    expect(await provePrimaryBusinessReferences(env, { ...primarySources, ...refs, accountId: "another-account" }))
      .toEqual({ available: false, reason: "mapping_unavailable" });
  });

  it.each(["inactive", "ambiguous"])("does not let native portal evidence revive %s business mapping", async kind => {
    business(); const refs = portal();
    if (kind === "inactive") ops.exec("UPDATE pa_clients SET active=0 WHERE id='1'");
    else ops.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id) VALUES('another','Duplicate',?,'test')").run(JSON.stringify({ public_id: clientPublic }));
    expect(await provePrimaryBusinessReferences(env, refs)).toEqual({ available: false, reason: "mapping_unavailable" });
  });

  it.each(["account", "workspace", "project", "root", "generation", "legacy"])("rejects missing current %s portal evidence", async kind => {
    const refs = portal();
    if (kind === "account") delivery.exec("UPDATE client_accounts SET status='suspended' WHERE id='account'");
    if (kind === "workspace") delivery.exec("UPDATE portal_v2_workspaces SET status='suspended' WHERE id='workspace'");
    if (kind === "project") delivery.exec("DELETE FROM portal_v2_directory_entities WHERE entity_type='project'");
    if (kind === "root") delivery.exec("UPDATE portal_v2_directory_entities SET active=0 WHERE entity_type='organization'");
    if (kind === "generation") delivery.exec("DELETE FROM portal_v2_directory_checkpoints");
    if (kind === "legacy") delivery.exec("UPDATE portal_v2_directory_entities SET source_version='legacy-backfill' WHERE entity_type='client'");
    expect(await provePrimaryBusinessReferences(env, refs)).toEqual({ available: false, reason: "mapping_unavailable" });
  });
});
