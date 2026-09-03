import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { listClientHubRoots, normalizeClientHubText } from "../src/worker/client-hub-directory";
import { mutateBusinessParty, previewBusinessParty, readBusinessParty, type BusinessPartyOperation } from "../src/worker/business-parties";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyBusinessPartySchema } from "./helpers/business-parties";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
const staff: StaffPrincipal = { id: "staff-j1", email: "admin@example.test", displayName: "Admin", accessSubject: "j1", projectAlphaUserId: null };
let runtime: Miniflare, ops: D1Database, delivery: D1Database, env: Env;
const compact = (value: string) => value.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");

async function authorityRows() {
  const result: Record<string, unknown> = {};
  for (const table of ["portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships", "portal_v2_entitlements"])
    result[table] = (await delivery.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return result;
}

async function mutation(operation: BusinessPartyOperation) {
  const preview = await previewBusinessParty(env, staff, operation);
  return mutateBusinessParty(env, staff, { operation, previewContextVersion: preview.contextVersion, idempotencyKey: crypto.randomUUID() });
}

beforeAll(async () => {
  runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('j1')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
  ops = await runtime.getD1Database("OPS_DB") as D1Database;
  delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  env = { OPS_DB: ops, DELIVERY_DB: delivery } as Env;
  await ops.exec(compact(`
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    INSERT INTO staff_users VALUES('staff-j1','active');
    INSERT INTO role_permissions VALUES('role-admin','team.view'),('role-admin','team.manage');
    INSERT INTO staff_role_assignments VALUES('staff-j1','role-admin','global',NULL);
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,business_unit_id TEXT,active INTEGER,manager_user_id TEXT,client_id TEXT,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
  `));
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8")).map(sql => ops.prepare(sql)));
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0034_client_hub_projection_sources.sql", import.meta.url), "utf8")).map(sql => ops.prepare(sql)));
  await applyConnectorSchema(ops);
  await applyBusinessPartySchema(ops);
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0037_client_business_activity.sql", import.meta.url), "utf8")).map(sql => ops.prepare(sql)));
  await registerVisibleTestSource(ops, secondary, "Independent Alpha B");
  await ops.prepare("UPDATE client_hub_directory_state SET ready=1 WHERE id='directory'").run();

  await delivery.exec("CREATE TABLE client_accounts(id TEXT PRIMARY KEY)");
  const hierarchy = splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0121_client_workspace_hierarchy_v2.sql", import.meta.url), "utf8"));
  // This joined fixture needs the canonical v2 authority schema, not 0121's
  // one-time legacy backfill (whose source tables intentionally are absent).
  await delivery.batch(hierarchy.filter(sql => !sql.includes("client_identity_links") && !sql.includes("client_account_memberships")
    && !sql.includes("client_project_grants") && !sql.includes("client_delivery_grants")).map(sql => delivery.prepare(sql)));
});
afterAll(async () => runtime.dispose());

describe("J1 joined reviewed-link isolation", () => {
  it("keeps colliding Alpha roots and portal authority independent across presentation lifecycle", async () => {
    const sameEmail = "shared-contact@example.test";
    await ops.batch([
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES('external-a','Same Customer',1,?,?)").bind(JSON.stringify({ email: sameEmail }), primary),
      ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES('org-b','Same Customer',1,?,?)").bind(JSON.stringify({ email: sameEmail }), secondary),
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization','external-a','external-a')").bind(primary),
      ops.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization','external-b','org-b')").bind(secondary),
      ...[[primary, "external-a", "contact-a"], [secondary, "org-b", "contact-b"]].flatMap(([source, id, contact]) => [
        ops.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
          VALUES(?,'business','organization',?,'Same Customer',?,'active')`).bind(source, id, normalizeClientHubText("Same Customer")),
        ops.prepare(`INSERT INTO pa_clients(id,name,active,organization_id,payload_json,projection_source_id)
          VALUES(?,'Shared Contact',1,?,?,?)`).bind(contact, id, JSON.stringify({ email: sameEmail }), source),
        ops.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
          VALUES(?,'business','organization',?,'pa_client',?,'email',?)`).bind(source, id, contact, normalizeClientHubText(sameEmail)),
      ]),
    ]);
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES('identity-a','issuer','subject-a',?),('identity-b','issuer','subject-b',?)").bind(sameEmail, sameEmail),
      delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name) VALUES('workspace-a','organization','external-a','Same Customer A'),('workspace-b','organization','external-b','Same Customer B')"),
      delivery.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES('membership-a','workspace-a','identity-a','project_alpha'),('membership-b','workspace-b','identity-b','project_alpha')"),
      delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
        VALUES('grant-a','workspace-a','identity-a','workspace.view','workspace','workspace-a','project_alpha'),
              ('grant-b','workspace-b','identity-b','workspace.view','workspace','workspace-b','project_alpha')`),
    ]);
    const authorityBefore = await authorityRows();

    expect((await listClientHubRoots(env, staff, { grouping: "records", q: sameEmail })).clients).toHaveLength(2);
    const first = await listClientHubRoots(env, staff, { grouping: "records", limit: 1 });
    const second = await listClientHubRoots(env, staff, { grouping: "records", limit: 1, cursor: first.nextCursor! });
    expect([first.clients[0], second.clients[0]].map(row => [row.source_id, row.public_id])).toEqual([[primary, "external-a"], [secondary, "org-b"]]);
    await expect(listClientHubRoots(env, staff, { grouping: "customers", limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 400 });

    const create: BusinessPartyOperation = { action: "create", displayName: "Reviewed Same Customer", roots: [
      { sourceId: primary, kind: "organization", recordId: "external-a" }, { sourceId: secondary, kind: "organization", recordId: "org-b" },
    ] };
    const created = await mutation(create);
    await expect(listClientHubRoots(env, staff, { grouping: "records", limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 409 });
    const grouped = await listClientHubRoots(env, staff, { grouping: "customers", sort: "name" });
    expect(grouped.clients).toHaveLength(1);
    expect(grouped.clients[0]).toMatchObject({ business_party_id: created.partyId, business_party_name: "Reviewed Same Customer", business_party_member_count: 2 });
    expect(await authorityRows()).toEqual(authorityBefore);

    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id='org-b' AND projection_source_id=?").bind(secondary).run();
    expect(await readBusinessParty(env, staff, created.partyId)).toMatchObject({ status: "active", needsReview: true });
    expect((await listClientHubRoots(env, staff, { grouping: "records" })).clients.map(row => row.source_id)).toEqual([primary]);
    await ops.prepare("UPDATE pa_organizations SET active=0 WHERE id='external-a' AND projection_source_id=?").bind(primary).run();
    expect(await readBusinessParty(env, staff, created.partyId)).toMatchObject({ status: "archived", archiveCause: "source_unavailable" });
    expect((await listClientHubRoots(env, staff, { grouping: "customers" })).clients).toEqual([]);
    await ops.prepare("UPDATE pa_organizations SET active=1 WHERE id='external-a' AND projection_source_id=?").bind(primary).run();
    expect(await readBusinessParty(env, staff, created.partyId)).toMatchObject({ status: "active", archiveCause: null });

    let party = await readBusinessParty(env, staff, created.partyId);
    const unavailableLink = party.members.find(member => member.root.sourceId === secondary)!;
    await mutation({ action: "unlink", partyId: party.id, expectedVersion: party.version, linkId: unavailableLink.linkId! });
    party = await readBusinessParty(env, staff, created.partyId);
    const liveLink = party.members.find(member => member.root.sourceId === primary)!;
    await mutation({ action: "unlink", partyId: party.id, expectedVersion: party.version, linkId: liveLink.linkId! });
    expect(await readBusinessParty(env, staff, created.partyId)).toMatchObject({ status: "archived", archiveCause: "operator_closed" });
    await ops.prepare("UPDATE pa_organizations SET active=1 WHERE id='org-b' AND projection_source_id=?").bind(secondary).run();
    const archived = await readBusinessParty(env, staff, created.partyId);
    await mutation({ action: "add", partyId: archived.id, expectedVersion: archived.version, root: { sourceId: secondary, kind: "organization", recordId: "org-b" } });
    expect(await readBusinessParty(env, staff, created.partyId)).toMatchObject({ status: "active", archiveCause: null });
    expect(await authorityRows()).toEqual(authorityBefore);
    expect((await ops.prepare("SELECT projection_source_id,external_id,local_id FROM pa_projection_record_ids ORDER BY projection_source_id").all()).results)
      .toEqual([{ projection_source_id: primary, external_id: "external-a", local_id: "external-a" }, { projection_source_id: secondary, external_id: "external-b", local_id: "org-b" }]);
  }, 30_000);
});
