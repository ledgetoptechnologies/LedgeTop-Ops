import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { listClientHubRoots, normalizeClientHubText, PORTAL_CONTACT_MINIMUM_QUERY_LENGTH } from "../src/worker/client-hub-directory";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyBusinessPartySchema } from "./helpers/business-parties";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const principal: StaffPrincipal = { id: "staff-search", email: "staff@example.test", displayName: "Staff",
  accessSubject: "staff-search", projectAlphaUserId: null };
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
const publicA = "a".repeat(32), publicB = "b".repeat(32);
const compact = (value: string) => value.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");

describe("live portal-contact Client Hub search", () => {
  let runtime: Miniflare, ops: D1Database, delivery: D1Database, env: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
    ops = await runtime.getD1Database("OPS_DB") as D1Database;
    delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    env = { OPS_DB: ops, DELIVERY_DB: delivery } as Env;
    await ops.exec(compact(`
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      INSERT INTO role_permissions VALUES('directory','team.view');
      INSERT INTO staff_role_assignments VALUES('staff-search','directory','global',NULL);
      CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,business_unit_id TEXT,active INTEGER,manager_user_id TEXT,client_id TEXT,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    `));
    for (const name of ["0032_client_hub_directory.sql", "0034_client_hub_projection_sources.sql", "0042_client_hub_secondary_portal_visibility.sql"])
      await ops.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).map(sql => ops.prepare(sql)));
    await applyConnectorSchema(ops); await applyBusinessPartySchema(ops);
    await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0037_client_business_activity.sql", import.meta.url), "utf8")).map(sql => ops.prepare(sql)));
    await registerVisibleTestSource(ops, secondary, "Secondary Alpha");
    await delivery.exec(compact(`
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT);
      CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT);
      CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
      CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,status TEXT,complete INTEGER);
      CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,parent_public_id TEXT,active INTEGER,public_id TEXT);
      CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,email_hint TEXT,display_name TEXT,source_version TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,verified_email TEXT,status TEXT,revoked_at TEXT,updated_at TEXT);
      CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT,updated_at TEXT);
      CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,version INTEGER);
    `));
  });
  beforeEach(async () => {
    await ops.batch([ops.prepare("DELETE FROM client_hub_search_values"), ops.prepare("DELETE FROM client_hub_roots"),
      ops.prepare("DELETE FROM pa_organizations"), ops.prepare("UPDATE client_hub_directory_state SET ready=1 WHERE id='directory'")]);
    await registerVisibleTestSource(ops, secondary, "Secondary Alpha");
    for (const table of ["portal_v2_workspace_memberships", "portal_v2_identities", "pa_portal_principals", "portal_v2_directory_entities",
      "portal_v2_directory_checkpoints", "portal_v2_directory_generations", "pa_portal_workspace_sources", "portal_v2_workspaces", "pa_portal_source_authorities"])
      await delivery.prepare(`DELETE FROM ${table}`).run();
  });
  afterAll(async () => runtime.dispose());

  async function root(source: string, workspace: string, internalId: string, publicId: string, name: string) {
    await ops.batch([
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES(?,?,1,?,?)")
        .bind(internalId, name, JSON.stringify({ public_id: publicId }), source),
      ops.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,display_name,sort_name,status,workspace_id)
        VALUES(?,'business','organization',?,?,'mapped',?,?,'active',?)`).bind(source, internalId, publicId, name, normalizeClientHubText(name), workspace),
    ]);
  }
  async function portal(source: string, workspace: string, publicId: string, people: Array<{ id: string; email: string; name?: string }>) {
    const generation = `generation-${workspace}`;
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES(?,'organization',?,NULL,?,'active')").bind(workspace, publicId, source),
      delivery.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(workspace, source, workspace),
      delivery.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,?,1,'active',1)").bind(generation, workspace, `source-${workspace}`),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?,1)").bind(workspace, generation),
      delivery.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,'organization',NULL,1,?)").bind(workspace, generation, publicId),
      ...(source === secondary ? [delivery.prepare("INSERT OR IGNORE INTO pa_portal_source_authorities VALUES(?,'active',1)").bind(source)] : []),
      ...people.flatMap(person => [
        delivery.prepare("INSERT INTO portal_v2_identities VALUES(?,?,'active',NULL,'2026-09-01 00:00:00')").bind(`identity-${person.id}`, person.email),
        delivery.prepare("INSERT INTO pa_portal_principals VALUES(?,?,?,?,?,'v1','active','2026-09-01 00:00:00')")
          .bind(workspace, person.id, `identity-${person.id}`, person.email, person.name ?? person.id),
        delivery.prepare("INSERT INTO portal_v2_workspace_memberships VALUES(?,?,'active',NULL,NULL,'2026-09-01 00:00:00')").bind(workspace, `identity-${person.id}`),
      ]),
    ]);
    await ops.batch(people.map(person => ops.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES(?,'business','organization',?,'portal_principal',?,'email',?)`).bind(source, source === primary ? "internal-a" : "internal-b",
      JSON.stringify([workspace, person.id]), normalizeClientHubText(person.email))));
  }

  it("deduplicates matching principals to exact roots and paginates same-email roots independently", async () => {
    await root(primary, "workspace-a", "internal-a", publicA, "Primary customer");
    await root(secondary, "workspace-b", "internal-b", publicB, "Secondary customer");
    await portal(primary, "workspace-a", publicA, [{ id: "a1", email: "shared@example.test" }, { id: "a2", email: "shared@example.test" }]);
    await portal(secondary, "workspace-b", publicB, [{ id: "b1", email: "shared@example.test" }]);
    const short = await listClientHubRoots(env, principal, { q: "sh", grouping: "records" });
    expect(short.clients).toEqual([]);
    expect(short.searchCapabilities).toEqual({ businessContacts: true, portalContacts: true,
      portalContactMinimumQueryLength: PORTAL_CONTACT_MINIMUM_QUERY_LENGTH });
    const first = await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records", sort: "name", limit: 1 });
    const second = await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records", sort: "name", limit: 1, cursor: first.nextCursor! });
    expect([...first.clients, ...second.clients].map(row => row.source_id)).toEqual([primary, secondary]);
    expect(first.searchCapabilities).toEqual({ businessContacts: true, portalContacts: true,
      portalContactMinimumQueryLength: PORTAL_CONTACT_MINIMUM_QUERY_LENGTH });
  });

  it("disables only portal-contact search for an incomplete schema and propagates ordinary D1 failures", async () => {
    await root(primary, "workspace-a", "internal-a", publicA, "Primary customer");
    const schema = {
      portal_v2_workspaces: ["id", "root_type", "pa_organization_public_id", "pa_client_public_id", "status"],
      pa_portal_workspace_sources: ["workspace_id", "projection_source_id"],
      portal_v2_directory_checkpoints: ["workspace_id", "active_generation_id", "source_sequence"],
      portal_v2_directory_generations: ["id", "workspace_id", "source_generation", "source_sequence", "status", "complete"],
      portal_v2_directory_entities: ["workspace_id", "generation_id", "entity_type", "parent_public_id", "active", "public_id"],
      pa_portal_principals: ["workspace_id", "public_id", "identity_id", "email_hint", "display_name", "source_version", "status", "updated_at"],
      portal_v2_identities: ["id", "verified_email", "status", "revoked_at", "updated_at"],
      portal_v2_workspace_memberships: ["workspace_id", "identity_id", "status", "revoked_at", "expires_at", "updated_at"],
      pa_portal_source_authorities: ["source_id", "state", "version"],
    };
    const incomplete = { withSession: () => ({ prepare: (sql: string) => ({ sql }),
      batch: async () => Object.values(schema).map(columns => ({ results: columns.map(name => ({ name })) })) }) } as any;
    const reduced = await listClientHubRoots({ ...env, DELIVERY_DB: incomplete }, principal, { q: "Primary", grouping: "records" });
    expect(reduced.clients.map(row => row.display_name)).toEqual(["Primary customer"]);
    expect(reduced.searchCapabilities).toEqual({ businessContacts: true, portalContacts: false });

    const failure = new Error("ordinary D1 failure");
    const failing = { withSession: () => ({ prepare: (sql: string) => ({ sql }), batch: async () => { throw failure; } }) } as any;
    await expect(listClientHubRoots({ ...env, DELIVERY_DB: failing }, principal, { q: "Primary" })).rejects.toBe(failure);
  });

  it("fails closed for revocation, changed generation, hidden sources, stale cursors and malformed proof facts", async () => {
    await root(primary, "workspace-a", "internal-a", publicA, "Primary customer");
    await root(secondary, "workspace-b", "internal-b", publicB, "Secondary customer");
    await portal(primary, "workspace-a", publicA, [{ id: "a1", email: "shared@example.test" }]);
    await portal(secondary, "workspace-b", publicB, [{ id: "b1", email: "shared@example.test" }]);
    const page = await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records", sort: "name", limit: 1 });
    await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now'),updated_at=datetime('now') WHERE workspace_id='workspace-b'").run();
    await expect(listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records", sort: "name", limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ status: 400 });
    expect((await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records", sort: "name" })).clients.map(row => row.source_id)).toEqual([primary]);
    await delivery.prepare("UPDATE portal_v2_directory_entities SET public_id=? WHERE workspace_id='workspace-a'").bind("c".repeat(32)).run();
    expect((await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records" })).clients).toEqual([]);
    await ops.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?").bind(secondary).run();
    expect((await listClientHubRoots(env, principal, { q: "shared@example.test", grouping: "records" })).clients).toEqual([]);
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('bad-workspace','organization',?,NULL,'malformed','active')").bind("d".repeat(32)),
      delivery.prepare("INSERT INTO pa_portal_workspace_sources VALUES('bad-workspace','malformed','bad-workspace')"),
      delivery.prepare("INSERT INTO portal_v2_directory_generations VALUES('bad-generation','bad-workspace','bad',1,'active',1)"),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES('bad-workspace','bad-generation',1)"),
      delivery.prepare("INSERT INTO portal_v2_directory_entities VALUES('bad-workspace','bad-generation','organization',NULL,1,?)").bind("d".repeat(32)),
      delivery.prepare("INSERT INTO portal_v2_identities VALUES('bad-identity','bad@example.test','active',NULL,'2026-09-01 00:00:00')"),
      delivery.prepare("INSERT INTO pa_portal_principals VALUES('bad-workspace','bad-person','bad-identity','bad@example.test','Bad','v1','active','2026-09-01 00:00:00')"),
      delivery.prepare("INSERT INTO portal_v2_workspace_memberships VALUES('bad-workspace','bad-identity','active',NULL,NULL,'2026-09-01 00:00:00')"),
      delivery.prepare("INSERT INTO pa_portal_source_authorities VALUES('malformed','active',1)"),
    ]);
    await expect(listClientHubRoots(env, principal, { q: "bad@example.test" })).rejects.toMatchObject({ status: 503 });
  });
});
