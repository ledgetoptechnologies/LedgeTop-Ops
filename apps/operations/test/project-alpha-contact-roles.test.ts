import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import { exactBusinessProjectPublicId, listProjectAlphaContactRoles, projectAlphaContactRolesEnabled } from "../src/worker/project-alpha-contact-roles";
import type { Env } from "../src/worker/types";

const active: Miniflare[] = [];
const orgPublicId = "a".repeat(32), projectPublicId = "b".repeat(32);
function context(overrides: Partial<ClientHubCollectionContext["root"]> = {}): ClientHubCollectionContext {
  return { root: { source_id: "project-alpha:primary", root_namespace: "business", kind: "organization", public_id: "org-internal",
    pa_public_id: orgPublicId, mapping_status: "mapped", display_name: "Acme", sort_name: "acme", status: "active",
    portal_status: "active", workspace_id: "workspace-one", legacy_account_id: null, account_count: 0, project_count: 1,
    request_count: 0, contact_count: 2, meaningful_activity_at: null, source_version: "root-v1", indexed_at: "", scan_generation: 1,
    ...overrides }, access: { directory: true, requests: false, delivery: false, viewer: false },
  canonicalRoot: { sourceId: overrides.source_id ?? "project-alpha:primary", rootNamespace: overrides.root_namespace ?? "business",
    kind: overrides.kind ?? "organization", publicId: overrides.public_id ?? "org-internal" }, contextVersion: "c".repeat(43) };
}
const exec = (db: D1Database, sql: string) => db.exec(sql.replace(/\s*\n\s*/g, " "));
async function fixture(withContract = true) {
  const mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DELIVERY_DB: "roles-client", OPS_DB: "roles-ops" } });
  active.push(mf);
  const delivery = await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const ops = await mf.getD1Database("OPS_DB") as unknown as D1Database;
  await exec(delivery, `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
    pa_client_public_id TEXT,project_alpha_source_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,source_generation TEXT,
      source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,
      parent_public_id TEXT,display_name TEXT,source_version TEXT,active INTEGER,primary_contact INTEGER DEFAULT 0,
      PRIMARY KEY(workspace_id,generation_id,entity_type,public_id));
    CREATE TABLE portal_v2_contact_assignment_contracts(workspace_id TEXT,generation_id TEXT,schema_version INTEGER,
      PRIMARY KEY(workspace_id,generation_id));
    CREATE TABLE portal_v2_contact_assignments(workspace_id TEXT,generation_id TEXT,public_id TEXT,contact_public_id TEXT,
      client_public_id TEXT,scope_type TEXT,scope_public_id TEXT,role TEXT,primary_contact INTEGER,primary_billing INTEGER,
      send_project_invoices INTEGER,can_view_invoice_links INTEGER,source_version TEXT,active INTEGER,
      PRIMARY KEY(workspace_id,generation_id,public_id));
    INSERT INTO portal_v2_workspaces VALUES('workspace-one','organization','${orgPublicId}',NULL,'project-alpha:primary');
    INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','source-one',10,'active',1);
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',10);
    INSERT INTO portal_v2_directory_entities VALUES
      ('workspace-one','generation-one','organization','${orgPublicId}',NULL,'Acme','org-v1',1,0),
      ('workspace-one','generation-one','department','dept-one','${orgPublicId}','Athletics','dept-v1',1,0),
      ('workspace-one','generation-one','client','client-one','${orgPublicId}','Craig Client','client-v1',1,0),
      ('workspace-one','generation-one','client','client-two','${orgPublicId}','Steve Client','client-v1',1,0),
      ('workspace-one','generation-one','contact','contact-one','client-one','Craig Contact','contact-v1',1,1),
      ('workspace-one','generation-one','contact','contact-two','client-two','Steve Contact','contact-v1',1,0),
      ('workspace-one','generation-one','project','${projectPublicId}','client-one','Roof Project','project-v1',1,0);
    INSERT INTO portal_v2_contact_assignments VALUES
      ('workspace-one','generation-one','assignment-one','contact-one','client-one','department','dept-one','athletic_director',1,0,0,0,'assignment-v1',1),
      ('workspace-one','generation-one','assignment-two','contact-two','client-two','client','client-two','head_coach',0,0,0,0,'assignment-v2',1),
      ('workspace-one','generation-one','assignment-project','contact-one','client-one','project','${projectPublicId}','billing_contact',1,1,1,1,'assignment-v3',1);`);
  if (withContract) await delivery.prepare("INSERT INTO portal_v2_contact_assignment_contracts VALUES('workspace-one','generation-one',4)").run();
  await exec(ops, `CREATE TABLE pa_clients(id TEXT,organization_id TEXT,projection_source_id TEXT,active INTEGER,payload_json TEXT);
    CREATE TABLE pa_projects(id TEXT,client_id TEXT,organization_id TEXT,projection_source_id TEXT,active INTEGER,payload_json TEXT);
    INSERT INTO pa_clients VALUES('client-internal','org-internal','project-alpha:primary',1,'{"public_id":"${"d".repeat(32)}"}');
    INSERT INTO pa_projects VALUES('project-internal','client-internal',NULL,'project-alpha:primary',1,'{"public_id":"${projectPublicId}"}');`);
  return { delivery, ops, env: { DELIVERY_DB: delivery, OPS_DB: ops } as Env };
}
afterEach(async () => Promise.all(active.splice(0).map(item => item.dispose())));

describe("default-off Project Alpha contact-role adapter", () => {
  it("is disabled unless the exact feature value is true and distinguishes unpublished, unavailable and verified-empty", async () => {
    expect(projectAlphaContactRolesEnabled({})).toBe(false);
    expect(projectAlphaContactRolesEnabled({ CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED: "TRUE" })).toBe(false);
    expect(projectAlphaContactRolesEnabled({ CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED: "true" })).toBe(true);
    const unpublished = await fixture(false);
    expect(await listProjectAlphaContactRoles(unpublished.env, context())).toMatchObject({ state: "not_published",
      reason: "schema_v4_not_published", items: [] });
    expect(await listProjectAlphaContactRoles(unpublished.env, context({ workspace_id: null }))).toMatchObject({ state: "unavailable",
      reason: "workspace_unavailable", items: [] });
    await unpublished.delivery.prepare("INSERT INTO portal_v2_contact_assignment_contracts VALUES('workspace-one','generation-one',4)").run();
    await unpublished.delivery.prepare("UPDATE portal_v2_contact_assignments SET active=0").run();
    expect(await listProjectAlphaContactRoles(unpublished.env, context())).toMatchObject({ state: "verified_empty", reason: null, items: [] });
    await unpublished.delivery.prepare("DROP TABLE portal_v2_contact_assignments").run();
    expect(await listProjectAlphaContactRoles(unpublished.env, context())).toMatchObject({ state: "unavailable",
      reason: "workspace_unavailable", items: [] });
  });

  it("returns only display role metadata and boolean flags without authority side effects", async () => {
    const { delivery, env } = await fixture();
    for (const table of ["portal_v2_workspaces", "portal_v2_directory_generations", "portal_v2_directory_checkpoints",
      "portal_v2_directory_entities", "portal_v2_contact_assignment_contracts", "portal_v2_contact_assignments"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        await delivery.prepare(`CREATE TRIGGER readonly_${table}_${action} BEFORE ${action} ON ${table}
          BEGIN SELECT RAISE(ABORT,'contact-role read wrote data'); END`).run();
    }
    const result = await listProjectAlphaContactRoles(env, context(), { limit: 10 });
    expect(result).toMatchObject({ state: "populated", returned: 2, hasMore: false, items: [
      { contactDisplayName: "Steve Contact", clientDisplayName: "Steve Client", scopeType: "client", scopeDisplayName: "Steve Client",
        role: "head_coach", primary: false, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false, sourceVersion: "assignment-v2" },
      { contactDisplayName: "Craig Contact", clientDisplayName: "Craig Client", scopeType: "department", scopeDisplayName: "Athletics",
        role: "athletic_director", primary: true, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false, sourceVersion: "assignment-v1" },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/email|phone|identity|membership|entitlement|invitation|notification|public_id|contact-one|assignment-one/i);
  });

  it("isolates selected source/workspace/generation, filters tombstones, and binds bounded pages to context and scope", async () => {
    const { delivery, env } = await fixture();
    const first = await listProjectAlphaContactRoles(env, context(), { limit: 1 });
    expect(first).toMatchObject({ state: "populated", returned: 1, hasMore: true });
    expect(first.items[0]!.contactDisplayName).toBe("Steve Contact");
    const second = await listProjectAlphaContactRoles(env, context(), { limit: 1, cursor: first.nextCursor! });
    expect(second).toMatchObject({ state: "populated", returned: 1, hasMore: false });
    expect(second.items[0]!.contactDisplayName).toBe("Craig Contact");
    await delivery.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE entity_type='contact' AND public_id='contact-two'").run();
    const filtered = await listProjectAlphaContactRoles(env, context(), { limit: 10 });
    expect(filtered.items.map(item => item.contactDisplayName)).toEqual(["Craig Contact"]);
    await expect(listProjectAlphaContactRoles(env, { ...context(), contextVersion: "z".repeat(43) },
      { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    await expect(listProjectAlphaContactRoles(env, context(),
      { limit: 1, cursor: first.nextCursor!, project: true, projectPublicId })).rejects.toMatchObject({ status: 409 });
    const otherSource = context({ source_id: "project-alpha:secondary" });
    expect(await listProjectAlphaContactRoles(env, otherSource)).toMatchObject({ state: "unavailable", items: [] });
    await expect(listProjectAlphaContactRoles(env, context(), { limit: 101 })).rejects.toMatchObject({ status: 400 });
  });

  it("reads exact project roles only after an exact source/root project mapping is available", async () => {
    const { env, ops } = await fixture();
    expect(await exactBusinessProjectPublicId(env, context(), "project-internal")).toBe(projectPublicId);
    expect(await exactBusinessProjectPublicId(env, context({ public_id: "another-org" }), "project-internal")).toBeNull();
    const result = await listProjectAlphaContactRoles(env, context(), { project: true, projectPublicId, limit: 10 });
    expect(result).toMatchObject({ state: "populated", returned: 1, items: [{ scopeType: "project", role: "billing_contact",
      primary: true, primaryBilling: true, sendProjectInvoices: true, canViewInvoiceLinks: true }] });
    expect((await listProjectAlphaContactRoles(env, context(), { project: true, projectPublicId: null })).state).toBe("unavailable");
    await ops.prepare("UPDATE pa_projects SET projection_source_id='project-alpha:secondary'").run();
    expect(await exactBusinessProjectPublicId(env, context(), "project-internal")).toBeNull();
  });
});
