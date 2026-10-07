import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlScope } from "../src/worker/acl";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const fullScope: SqlScope = { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };
const acl = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true),
  sqlScope: vi.fn(async (): Promise<SqlScope> => ({ global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false })),
  isAdministrator: vi.fn(async () => true), hasLocalGlobalAllow: vi.fn(async () => false) }));
vi.mock("../src/worker/acl", () => acl);
import { readClientHubBusinessProjectDetail } from "../src/worker/client-hub-business-project-detail";
import { listClientHubBusinessProjects } from "../src/worker/client-hub-business-projects";
import { recheckCanonicalClientHubProjects } from "../src/worker/client-hub-canonical-projects";
import { readClientHubBusinessProjectPolicy } from "../src/worker/client-hub-project-policy";

const active: Miniflare[] = [];
const staff = { id: "staff-a", projectAlphaUserId: "user-a" } as StaffPrincipal;
function context(kind: "organization" | "standalone_client" = "organization", id = "org-a"): ClientHubCollectionContext {
  return { root: { source_id: "project-alpha:primary", root_namespace: "business", kind, public_id: id, pa_internal_id: id,
    pa_public_id: null, mapping_status: "missing", display_name: "Client root", sort_name: "client root", status: "active",
    portal_status: "not_provisioned", workspace_id: null, legacy_account_id: null, account_count: 0, project_count: 0,
    request_count: 0, contact_count: 0, meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 0 },
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind, publicId: id },
  access: { directory: true, requests: true, delivery: true, viewer: true }, contextVersion: "a".repeat(43) };
}
const sql = (db: D1Database, value: string) => db.exec(value.replace(/\s*\n\s*/g, " "));
function table(migration: string, name: string): string {
  const source = readFileSync(new URL("../migrations/" + migration, import.meta.url), "utf8");
  const start = source.indexOf("CREATE TABLE " + name + " (");
  if (start < 0) throw new Error("Missing production table " + name);
  return source.slice(start, source.indexOf("\n);", start) + 3);
}
async function fixture() {
  const mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){return new Response('ok')} }",
    d1Databases: { OPS_DB: `business-project-detail-${randomUUID()}` }, d1Persist: "./.tmp-checks/portal-d1" });
  active.push(mf);
  const db = await mf.getD1Database("OPS_DB") as unknown as D1Database;
  await applyConnectorSchema(db);
  for (const name of ["pa_organizations", "pa_clients", "pa_projects", "pa_users", "pa_project_assignments"])
    await sql(db, table("0001_operations.sql", name));
  for (const name of ["pa_operations", "pa_operation_assignments", "pa_tasks"])
    await sql(db, table("0004_project_alpha_authority.sql", name));
  await sql(db, table("0008_project_units_task_assignments.sql", "pa_task_assignments"));
  await sql(db, "ALTER TABLE pa_projects ADD COLUMN manager_user_id TEXT;");
  for (const name of ["pa_organizations", "pa_clients", "pa_projects", "pa_users", "pa_project_assignments",
    "pa_operations", "pa_operation_assignments", "pa_tasks", "pa_task_assignments"])
    await sql(db, `ALTER TABLE ${name} ADD COLUMN projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary';`);
  await sql(db, `INSERT INTO pa_organizations(id,name,payload_json,last_sync_id) VALUES('org-a','Org A','{}','sync'),('org-b','Org B','{}','sync');
    INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id) VALUES
      ('client-a','Contact A','org-a','{"email":" a@example.test ","phone":"+1 (555) 123-4567","billing":"never-return"}','sync'),
      ('client-b','Other Contact','org-b','{"email":"private-other@example.test"}','sync'),
      ('standalone','Standalone',NULL,'{}','sync');
    INSERT INTO pa_users(id,display_name,payload_json,last_sync_id) VALUES('user-a','Manager A','{"private":"never-return"}','sync');
    INSERT INTO pa_projects(id,name,status,start_date,end_date,client_id,payload_json,last_sync_id,manager_user_id)
      VALUES('project-a','Project A','completed','2026-01-01','2026-02-01','client-a',
        '{"description":"Documented project description","created_at":"2026-01-01T08:00:00+05:00","billing_status":"private","contract":"never-return","notes":"secret memory"}','sync','user-a');`);
  return { db, env: { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://alpha.example.test/", apiKey: "test-key",
      sourceInstanceId: "00000000-0000-4000-8000-000000000001", applicationId: "00000000-0000-4000-8000-000000000002",
      historyEpoch: "00000000-0000-4000-8000-000000000003" },
  } }) } as Env };
}
afterEach(async () => {
  vi.resetAllMocks();
  acl.hasPermission.mockResolvedValue(true); acl.sqlScope.mockResolvedValue(fullScope);
  acl.isAdministrator.mockResolvedValue(true); acl.hasLocalGlobalAllow.mockResolvedValue(false);
  await Promise.all(active.splice(0).map(mf => mf.dispose()));
});

describe("read-only source-qualified business project detail", () => {
  it("lists and opens an activated canonical project by its Ops ID when every PA identity differs", async () => {
    const { db, env } = await fixture();
    const opsRoot = "ops-org-9", paInternalRoot = "org-a", paPublicRoot = "1".repeat(32);
    const opsClient = "ops-client-9", paPublicClient = "6".repeat(32);
    const opsProject = "ops-project-77", paPublicProject = "2".repeat(32), revision = "7", projection = "a".repeat(64);
    await sql(db, `CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT);
      CREATE TABLE active_mapping_rows(source_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,
        source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT);
      CREATE VIEW project_alpha_active_directory_mappings AS SELECT * FROM active_mapping_rows;
      CREATE TABLE project_alpha_project_mappings(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,
        application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT);
      CREATE TABLE project_alpha_project_v2_canonical_activation_receipts(external_project_id TEXT,resulting_local_version INTEGER,
        organization_record_id TEXT,client_record_id TEXT);
      CREATE TABLE operations_shared_projects(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,
        history_epoch_id TEXT,project_alpha_public_id TEXT,pa_revision TEXT,current_version INTEGER,name TEXT,lifecycle TEXT,
        planned_start TEXT,planned_end TEXT,organization_record_id TEXT,client_record_id TEXT,scopes_json TEXT,description TEXT,
        completed_at TEXT,archived INTEGER,archived_at TEXT,canonical_projection_sha256 TEXT,overdue_warning INTEGER,created_at TEXT);
      CREATE TABLE operations_shared_project_revisions(external_project_id TEXT,version INTEGER,pa_revision TEXT,read_json TEXT,
        refresh_command_id TEXT,v2_settlement_id TEXT,inbound_resolution_id TEXT);
      CREATE TABLE project_alpha_project_inbound_resolution_receipts(resolution_id TEXT,decision TEXT,
        prior_local_version INTEGER,resulting_local_version INTEGER);
      CREATE TABLE project_alpha_api_v2_inventory_conflicts(source_id TEXT,source_instance_id TEXT,application_id TEXT,
        history_epoch_id TEXT,inventory_kind TEXT,project_alpha_public_id TEXT,external_id TEXT);
      CREATE TABLE project_alpha_api_v2_project_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,
        history_epoch_id TEXT,project_alpha_public_id TEXT,external_project_id TEXT,resource_revision TEXT,
        projection_sha256 TEXT,lifecycle_status TEXT,archived INTEGER,has_conflict INTEGER);
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT);`);
    const identity = { source_id: "project-alpha:primary", source_instance_id: "00000000-0000-4000-8000-000000000001",
      application_id: "00000000-0000-4000-8000-000000000002", history_epoch_id: "00000000-0000-4000-8000-000000000003" };
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?, 'organization')").bind(opsRoot),
      db.prepare("INSERT INTO operations_directory_records VALUES(?, 'client')").bind(opsClient),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(opsClient, opsRoot),
      db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id=?").bind(JSON.stringify({ public_id: paPublicRoot }), paInternalRoot),
      db.prepare("UPDATE pa_clients SET payload_json=? WHERE id='client-a'").bind(JSON.stringify({ public_id: paPublicClient })),
      db.prepare(`INSERT INTO active_mapping_rows VALUES(?,?,?,?,?,?,?,?)`).bind(identity.source_id, "organization",
        opsRoot, paInternalRoot, paPublicRoot, identity.source_instance_id, identity.application_id, identity.history_epoch_id),
      db.prepare(`INSERT INTO active_mapping_rows VALUES(?,?,?,?,?,?,?,?)`).bind(identity.source_id, "client",
        opsClient, "client-a", paPublicClient, identity.source_instance_id, identity.application_id, identity.history_epoch_id),
      db.prepare(`INSERT INTO project_alpha_project_mappings VALUES(?,?,?,?,?,?)`).bind(opsProject, ...Object.values(identity), paPublicProject),
      db.prepare(`INSERT INTO project_alpha_project_v2_canonical_activation_receipts VALUES(?,?,?,?)`)
        .bind(opsProject, 1, opsRoot, opsClient),
      db.prepare(`INSERT INTO operations_shared_projects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        opsProject, ...Object.values(identity), paPublicProject, revision, 1, "Shared project", "active", "2026-04-01", null,
        opsRoot, opsClient, "[]", "Canonical description", null, 0, null, projection, 0, "2026-04-01T00:00:00.000Z"),
      db.prepare(`INSERT INTO operations_shared_project_revisions VALUES(?,?,NULL,?,NULL,?,NULL)`).bind(opsProject, 1,
        JSON.stringify({ apiVersion: "2", sourceInstanceId: identity.source_instance_id, applicationId: identity.application_id,
          historyEpoch: identity.history_epoch_id, resource: { type: "project", id: paPublicProject, revision,
            projectionSha256: projection }, data: { name: "Shared project", description: "Canonical description", status: "active",
            archived: false, overdueWarning: false, estimatedStart: "2026-04-01", estimatedEnd: null, clientPublicId: paPublicClient,
            organizationPublicId: paPublicRoot } }), "settlement-a"),
    ]);
    const mapped = context("organization", opsRoot);
    mapped.root.pa_internal_id = paInternalRoot; mapped.root.pa_public_id = paPublicRoot;
    mapped.root.mapping_status = "mapped";

    // PA TEXT identifiers are unrestricted. This ID must remain a PA ID even
    // though it resembles the former inline canonical-route marker.
    const collidingPaId = `shared:${opsProject}`;
    await db.prepare(`INSERT INTO pa_projects(id,name,status,organization_id,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?, 'active',?,1,?,'sync','project-alpha:primary')`)
      .bind(collidingPaId, "PA collision project", paInternalRoot,
        JSON.stringify({ public_id: "3".repeat(32), description: "PA collision description" })).run();
    const list = await listClientHubBusinessProjects(env, staff, mapped);
    expect(list.items).toContainEqual(expect.objectContaining({ id: opsProject, origin: "canonical", name: "Shared project", status: "active" }));
    expect(list.items).toContainEqual(expect.objectContaining({ id: collidingPaId, origin: "pa", name: "PA collision project" }));
    const detail = await readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" });
    expect(detail.project).toMatchObject({ id: opsProject, origin: "canonical", name: "Shared project", description: "Canonical description",
      start_date: "2026-04-01", created_at: null, manager: null, overdue_warning: false });
    expect((await readClientHubBusinessProjectDetail(env, staff, mapped, collidingPaId, { origin: "pa" })).project)
      .toMatchObject({ id: collidingPaId, origin: "pa", name: "PA collision project", description: "PA collision description" });
    expect(detail.operationalWorkspaceAvailable).toBe(false);
    expect(detail.projectInternalNotesAvailable).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("read_json");
    expect(JSON.stringify(detail)).not.toContain(paPublicProject);

    // A project-sync grant is not a read grant. Without the usual PA manager or
    // assignment relationship, an ordinary staff account must not see it.
    await sql(db, `INSERT INTO pa_projects(id,name,status,client_id,organization_id,active,payload_json,last_sync_id)
      VALUES('pa-mirror','Shared project','active','client-a','org-a',1,'{"public_id":"${paPublicProject}"}','sync');`);
    const mirroredList = await listClientHubBusinessProjects(env, staff, mapped);
    expect(mirroredList.items.filter(item => item.id === opsProject && item.origin === "canonical")).toHaveLength(1);
    expect(mirroredList.items.some(item => item.id === "pa-mirror")).toBe(false);
    expect(JSON.stringify(mirroredList)).not.toContain(paPublicProject);

    // More leading PA mirrors than a whole page must not hide a later real PA
    // project or terminate pagination. Their canonical counterpart sorts later.
    await db.prepare("UPDATE pa_projects SET payload_json=? WHERE id='pa-mirror'")
      .bind(JSON.stringify({ public_id: paPublicProject, created_at: "2026-05-05T00:00:00.000Z" })).run();
    for (let day = 1; day <= 4; day++) {
      await db.prepare(`INSERT INTO pa_projects(id,name,status,organization_id,active,payload_json,last_sync_id)
        VALUES(?, 'Leading mirror', 'active', 'org-a', 1, ?, 'sync')`)
        .bind(`leading-mirror-${day}`, JSON.stringify({ public_id: paPublicProject,
          created_at: `2026-05-0${day}T00:00:00.000Z` })).run();
    }
    await db.prepare(`INSERT INTO pa_projects(id,name,status,organization_id,active,payload_json,last_sync_id)
      VALUES('pa-after-mirrors','Later project','active','org-a',1,?,'sync')`)
      .bind(JSON.stringify({ public_id: "4".repeat(32), created_at: "2026-03-01T00:00:00.000Z" })).run();
    const firstPage = await listClientHubBusinessProjects(env, staff, mapped, { limit: 1 });
    expect(firstPage.items.map(item => item.id)).toEqual([opsProject]);
    expect(firstPage.page.hasMore).toBe(true);
    const secondPage = await listClientHubBusinessProjects(env, staff, mapped, { limit: 1, cursor: firstPage.page.nextCursor! });
    expect(secondPage.items.map(item => item.id)).toEqual(["pa-after-mirrors"]);
    expect(secondPage.page.hasMore).toBe(true); // The unrelated collision ID still follows.
    const thirdPage = await listClientHubBusinessProjects(env, staff, mapped, { limit: 1, cursor: secondPage.page.nextCursor! });
    expect(thirdPage.items.map(item => item.id)).toEqual(["project-a"]);
    expect(thirdPage.page.hasMore).toBe(true);
    const lastPage = await listClientHubBusinessProjects(env, staff, mapped, { limit: 1, cursor: thirdPage.page.nextCursor! });
    expect(lastPage.items.map(item => item.id)).toEqual([collidingPaId]);
    expect(lastPage.page.hasMore).toBe(false);
    const currentPolicy = await readClientHubBusinessProjectPolicy(env, staff);
    expect(await recheckCanonicalClientHubProjects(env, mapped, currentPolicy, [opsProject], "current")).toBe(true);
    expect(await recheckCanonicalClientHubProjects(env, mapped, currentPolicy, [opsProject], "completed")).toBe(false);
    expect(await recheckCanonicalClientHubProjects(env, mapped, currentPolicy, [opsProject], "cancelled")).toBe(false);

    // Rebinding the same Ops owner record to another PA public ID must not
    // move the old accepted project into the newly mapped organization root.
    const reboundOrgPublic = "7".repeat(32), reboundClientPublic = "8".repeat(32);
    await db.batch([
      db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id=?").bind(JSON.stringify({ public_id: reboundOrgPublic }), paInternalRoot),
      db.prepare(`UPDATE active_mapping_rows SET project_alpha_public_id=? WHERE resource_type='organization' AND record_id=?`)
        .bind(reboundOrgPublic, opsRoot),
    ]);
    const reboundOrganization = context("organization", opsRoot);
    reboundOrganization.root.pa_internal_id = paInternalRoot;
    reboundOrganization.root.pa_public_id = reboundOrgPublic;
    reboundOrganization.root.mapping_status = "mapped";
    expect((await listClientHubBusinessProjects(env, staff, reboundOrganization)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    expect(await recheckCanonicalClientHubProjects(env, reboundOrganization, currentPolicy, [opsProject], "all")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, reboundOrganization, opsProject, { origin: "canonical" }))
      .rejects.toMatchObject({ status: 404 });
    await db.batch([
      db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id=?").bind(JSON.stringify({ public_id: paPublicRoot }), paInternalRoot),
      db.prepare(`UPDATE active_mapping_rows SET project_alpha_public_id=? WHERE resource_type='organization' AND record_id=?`)
        .bind(paPublicRoot, opsRoot),
      db.prepare("UPDATE pa_clients SET payload_json=? WHERE id='client-a'").bind(JSON.stringify({ public_id: reboundClientPublic })),
      db.prepare(`UPDATE active_mapping_rows SET project_alpha_public_id=? WHERE resource_type='client' AND record_id=?`)
        .bind(reboundClientPublic, opsClient),
    ]);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    expect(await recheckCanonicalClientHubProjects(env, mapped, currentPolicy, [opsProject], "all")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" }))
      .rejects.toMatchObject({ status: 404 });
    await db.batch([
      db.prepare("UPDATE pa_clients SET payload_json=? WHERE id='client-a'").bind(JSON.stringify({ public_id: paPublicClient })),
      db.prepare(`UPDATE active_mapping_rows SET project_alpha_public_id=? WHERE resource_type='client' AND record_id=?`)
        .bind(paPublicClient, opsClient),
    ]);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);

    // A self-consistent canonical head from a retired producer identity must
    // not be released through a root whose active mapping belongs to the
    // currently configured producer identity.
    const retired = { source_instance_id: "10000000-0000-4000-8000-000000000001",
      application_id: "10000000-0000-4000-8000-000000000002", history_epoch_id: "10000000-0000-4000-8000-000000000003" };
    await db.batch([
      db.prepare(`UPDATE operations_shared_projects SET source_instance_id=?,application_id=?,history_epoch_id=?
        WHERE external_project_id=?`).bind(...Object.values(retired), opsProject),
      db.prepare(`UPDATE project_alpha_project_mappings SET source_instance_id=?,application_id=?,history_epoch_id=?
        WHERE external_project_id=?`).bind(...Object.values(retired), opsProject),
      db.prepare(`UPDATE operations_shared_project_revisions SET read_json=? WHERE external_project_id=?`).bind(
        JSON.stringify({ apiVersion: "2", sourceInstanceId: retired.source_instance_id, applicationId: retired.application_id,
          historyEpoch: retired.history_epoch_id, resource: { type: "project", id: paPublicProject, revision,
            projectionSha256: projection }, data: { name: "Shared project", description: "Canonical description", status: "active",
            archived: false, overdueWarning: false, estimatedStart: "2026-04-01", estimatedEnd: null, clientPublicId: paPublicClient,
            organizationPublicId: paPublicRoot } }), opsProject),
    ]);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });
    await db.batch([
      db.prepare(`UPDATE operations_shared_projects SET source_instance_id=?,application_id=?,history_epoch_id=?
        WHERE external_project_id=?`).bind(identity.source_instance_id, identity.application_id, identity.history_epoch_id, opsProject),
      db.prepare(`UPDATE project_alpha_project_mappings SET source_instance_id=?,application_id=?,history_epoch_id=?
        WHERE external_project_id=?`).bind(identity.source_instance_id, identity.application_id, identity.history_epoch_id, opsProject),
      db.prepare(`UPDATE operations_shared_project_revisions SET read_json=? WHERE external_project_id=?`).bind(
        JSON.stringify({ apiVersion: "2", sourceInstanceId: identity.source_instance_id, applicationId: identity.application_id,
          historyEpoch: identity.history_epoch_id, resource: { type: "project", id: paPublicProject, revision,
            projectionSha256: projection }, data: { name: "Shared project", description: "Canonical description", status: "active",
            archived: false, overdueWarning: false, estimatedStart: "2026-04-01", estimatedEnd: null, clientPublicId: paPublicClient,
            organizationPublicId: paPublicRoot } }), opsProject),
    ]);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);

    const enabledConnections = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
    env.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify({ version: 1, instances: {
      "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: false, baseUrl: "https://alpha.example.test/",
        apiKey: "test-key", sourceInstanceId: identity.source_instance_id, applicationId: identity.application_id,
        historyEpoch: identity.history_epoch_id },
    } });
    await expect(listClientHubBusinessProjects(env, staff, mapped)).rejects.toMatchObject({ status: 404 });
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });
    env.PROJECT_ALPHA_API_V2_CONNECTIONS = enabledConnections;
    expect((await readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).project.id).toBe(opsProject);

    // An accepted inbound PA edit may carry forward an earlier activation
    // when the ownership identity is unchanged.
    const retainedOwnerResolution = "inbound-resolution-same-owner";
    await db.batch([
      db.prepare("UPDATE operations_shared_projects SET current_version=2 WHERE external_project_id=?").bind(opsProject),
      db.prepare(`INSERT INTO operations_shared_project_revisions VALUES(?,2,NULL,?,NULL,NULL,?)`)
        .bind(opsProject, JSON.stringify({ apiVersion: "2", sourceInstanceId: identity.source_instance_id, applicationId: identity.application_id,
          historyEpoch: identity.history_epoch_id, resource: { type: "project", id: paPublicProject, revision,
            projectionSha256: projection }, data: { name: "Shared project", description: "Canonical description", status: "active",
            archived: false, overdueWarning: false, estimatedStart: "2026-04-01", estimatedEnd: null, clientPublicId: paPublicClient,
            organizationPublicId: paPublicRoot } }), retainedOwnerResolution),
      db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_receipts VALUES(?,'accept_project_alpha',1,2)`)
        .bind(retainedOwnerResolution),
    ]);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);
    await db.batch([
      db.prepare("DELETE FROM project_alpha_project_inbound_resolution_receipts WHERE resolution_id=?").bind(retainedOwnerResolution),
      db.prepare("DELETE FROM operations_shared_project_revisions WHERE external_project_id=? AND version=2").bind(opsProject),
      db.prepare("UPDATE operations_shared_projects SET current_version=1 WHERE external_project_id=?").bind(opsProject),
    ]);

    // A changed owner needs a new exact activation before Client Hub can
    // release the project under that root.
    const opsRootB = "ops-org-10", paPublicRootB = "5".repeat(32), inboundResolution = "inbound-resolution-changed-owner";
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?, 'organization')").bind(opsRootB),
      db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id='org-b'").bind(JSON.stringify({ public_id: paPublicRootB })),
      db.prepare(`INSERT INTO active_mapping_rows VALUES(?,?,?,?,?,?,?,?)`).bind(identity.source_id, "organization",
        opsRootB, "org-b", paPublicRootB, identity.source_instance_id, identity.application_id, identity.history_epoch_id),
      db.prepare("UPDATE pa_projects SET organization_id='org-b',client_id=NULL WHERE id='pa-mirror'"),
      db.prepare(`UPDATE operations_shared_projects SET current_version=2,organization_record_id=?,client_record_id=NULL
        WHERE external_project_id=?`).bind(opsRootB, opsProject),
      db.prepare(`INSERT INTO operations_shared_project_revisions VALUES(?,2,NULL,?,NULL,NULL,?)`)
        .bind(opsProject, JSON.stringify({ apiVersion: "2", sourceInstanceId: identity.source_instance_id, applicationId: identity.application_id,
          historyEpoch: identity.history_epoch_id, resource: { type: "project", id: paPublicProject, revision,
            projectionSha256: projection }, data: { name: "Shared project", description: "Canonical description", status: "active",
            archived: false, overdueWarning: false, estimatedStart: "2026-04-01", estimatedEnd: null, clientPublicId: null,
            organizationPublicId: paPublicRootB } }), inboundResolution),
      db.prepare(`INSERT INTO project_alpha_project_inbound_resolution_receipts VALUES(?,'accept_project_alpha',1,2)`)
        .bind(inboundResolution),
    ]);
    const mappedB = context("organization", opsRootB);
    mappedB.root.pa_internal_id = "org-b"; mappedB.root.pa_public_id = paPublicRootB; mappedB.root.mapping_status = "mapped";
    expect((await listClientHubBusinessProjects(env, staff, mappedB)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await db.prepare(`INSERT INTO project_alpha_project_v2_canonical_activation_receipts VALUES(?,?,?,NULL)`)
      .bind(opsProject, 2, opsRootB).run();
    expect((await listClientHubBusinessProjects(env, staff, mappedB)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);
    await db.batch([
      db.prepare("DELETE FROM project_alpha_project_v2_canonical_activation_receipts WHERE resulting_local_version=2"),
      db.prepare("DELETE FROM project_alpha_project_inbound_resolution_receipts WHERE resolution_id=?").bind(inboundResolution),
      db.prepare("DELETE FROM operations_shared_project_revisions WHERE external_project_id=? AND version=2").bind(opsProject),
      db.prepare(`UPDATE operations_shared_projects SET current_version=1,organization_record_id=?,client_record_id=?
        WHERE external_project_id=?`).bind(opsRoot, opsClient, opsProject),
      db.prepare("UPDATE pa_projects SET organization_id=NULL,client_id='client-a' WHERE id='pa-mirror'"),
    ]);

    await db.prepare("DELETE FROM pa_projects WHERE id IN ('leading-mirror-1','leading-mirror-2','leading-mirror-3','leading-mirror-4','pa-after-mirrors')").run();
    acl.isAdministrator.mockResolvedValue(false);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });
    await sql(db, `INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id)
      VALUES('pa-mirror-assignment','pa-mirror','user-a','{}','sync');`);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === "pa-mirror")).toBe(false);

    // A stale canonical head must not suppress its still-valid PA mirror. The
    // mirror is suppressed only when the exact same canonical proof used for
    // display accepts the shared row.
    await db.prepare("UPDATE operations_shared_projects SET description='stale description' WHERE external_project_id=?").bind(opsProject).run();
    const staleCanonical = await listClientHubBusinessProjects(env, staff, mapped);
    expect(staleCanonical.items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    expect(staleCanonical.items.some(item => item.id === "pa-mirror")).toBe(true);
    await db.prepare("UPDATE operations_shared_projects SET description='Canonical description' WHERE external_project_id=?").bind(opsProject).run();

    // Conflicting inventory evidence suppresses the canonical row even for an
    // otherwise authorized manager; review must resolve it before display.
    await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts VALUES(?,?,?,?,?,?,?)`)
      .bind(identity.source_id, identity.source_instance_id, identity.application_id, identity.history_epoch_id,
        "project", paPublicProject, opsProject).run();
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items.some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });

    // A release must not make projects disappear while 0178 is pending on
    // staging: treat the inbound receipt table/column as a paired capability.
    await db.prepare("DELETE FROM project_alpha_api_v2_inventory_conflicts").run();
    await db.prepare("DROP TABLE project_alpha_project_inbound_resolution_receipts").run();
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });
    await db.prepare(`CREATE TABLE project_alpha_project_inbound_resolution_receipts(
      resolution_id TEXT, decision TEXT, prior_local_version INTEGER, resulting_local_version INTEGER)`).run();
    await db.prepare("ALTER TABLE operations_shared_project_revisions DROP COLUMN inbound_resolution_id").run();
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).rejects.toMatchObject({ status: 404 });
    await db.prepare("DROP TABLE project_alpha_project_inbound_resolution_receipts").run();
    expect((await listClientHubBusinessProjects(env, staff, mapped)).items
      .some(item => item.id === opsProject && item.origin === "canonical")).toBe(true);
    expect((await readClientHubBusinessProjectDetail(env, staff, mapped, opsProject, { origin: "canonical" })).project.id).toBe(opsProject);
  // This joined D1 scenario checks pagination, identity retirement, disabled
  // sources and authorization using many round trips; keep a bounded allowance.
  }, 60_000);

  it("reads only the selected producer's project and contacts even when relationships are malformed", async () => {
    const { db, env } = await fixture();
    await registerVisibleTestSource(db,"project-alpha:secondary");
    await sql(db, `INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id)
      VALUES('secondary-org','Secondary','{}','sync','project-alpha:secondary');
      INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id,projection_source_id)
      VALUES('secondary-client','Secondary contact','secondary-org','{}','sync','project-alpha:secondary');
      INSERT INTO pa_projects(id,name,status,organization_id,client_id,payload_json,last_sync_id,projection_source_id)
      VALUES('secondary-project','Secondary project','active','secondary-org','secondary-client','{}','sync','project-alpha:secondary');`);
    const secondary = context("organization", "secondary-org");
    secondary.root.source_id = "project-alpha:secondary";
    secondary.canonicalRoot.sourceId = "project-alpha:secondary";
    expect((await readClientHubBusinessProjectDetail(env, staff, secondary, "secondary-project")).linkedContact?.id).toBe("secondary-client");
    await expect(readClientHubBusinessProjectDetail(env, staff, secondary, "project-a")).rejects.toMatchObject({ status: 404 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context("organization", "secondary-org"), "secondary-project")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_projects SET client_id='client-a' WHERE id='secondary-project'").run();
    expect((await readClientHubBusinessProjectDetail(env, staff, secondary, "secondary-project")).linkedContact).toBeNull();
  });
  it("returns only documented business fields and a factual linked contact, never grants or billing payload", async () => {
    const { db, env } = await fixture();
    // Session bookkeeping can increment SQLite total_changes independently of
    // application rows. Guard actual domain tables against any write instead.
    for (const name of ["pa_projects", "pa_clients", "pa_organizations", "pa_users", "pa_project_assignments",
      "pa_operations", "pa_operation_assignments", "pa_tasks", "pa_task_assignments"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        await db.prepare(`CREATE TRIGGER readonly_${name}_${action} BEFORE ${action} ON ${name}
          BEGIN SELECT RAISE(ABORT,'read-only project endpoint wrote domain data'); END`).run();
    }
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result).toMatchObject({
      canonicalRoot: context().canonicalRoot, contextVersion: context().contextVersion,
      client: { detail_path: "/clients/sources/project-alpha%3Aprimary/business/organizations/org-a" },
      project: { id: "project-a", name: "Project A", status: "completed", description: "Documented project description",
        start_date: "2026-01-01", end_date: "2026-02-01", created_at: "2026-01-01T03:00:00.000Z",
        manager: { id: "user-a", display_name: "Manager A" } },
      linkedContact: { id: "client-a", display_name: "Contact A", email: "a@example.test", phone: "+1 (555) 123-4567",
        sourceField: "project.client_id" },
      availability: { linkedContact: "available", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" },
      operationalWorkspaceAvailable: true, businessActivityAvailable: true, auditTimelineAvailable: true, feedbackHistoryAvailable: true,
    });
    expect(result.linkedContact).not.toHaveProperty("role");
    expect(JSON.stringify(result)).not.toMatch(/payload_json|billing_status|never-return|secret memory|has_workspace_access|entitlements/);
  });

  it("uses explicit organization precedence and does not disclose an out-of-root linked contact", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET organization_id='org-a',client_id='client-b'").run();
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result.linkedContact).toBeNull(); expect(result.availability.linkedContact).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private-other@example.test");
    await expect(readClientHubBusinessProjectDetail(env, staff, context("organization", "org-b"), "project-a"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_projects SET client_id=NULL").run();
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).availability.linkedContact).toBe("not_projected");
  });

  it("treats zone-less source timestamps as UTC and omits inactive projected managers", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET payload_json=?").bind(JSON.stringify({ created_at: "2026-01-01 09:00:00" })).run();
    await db.prepare("UPDATE pa_users SET active=0 WHERE id='user-a'").run();
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result.project.created_at).toBe("2026-01-01T09:00:00.000Z");
    expect(result.project.manager).toBeNull();
  });

  it("does not revive inactive or reparented projects, clients or roots", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET active=0").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_projects SET active=1").run();
    await db.prepare("UPDATE pa_clients SET active=0 WHERE id='client-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET active=1,organization_id='org-b' WHERE id='client-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='client-a'").run();
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='org-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("allows a current standalone project only under its exact source-qualified standalone root", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET client_id='standalone'").run();
    const root = context("standalone_client", "standalone");
    expect((await readClientHubBusinessProjectDetail(env, staff, root, "project-a")).linkedContact?.id).toBe("standalone");
    for (const namespace of ["account", "portal"] as const) {
      const wrong = context("standalone_client", "standalone");
      wrong.root.root_namespace = namespace;
      await expect(readClientHubBusinessProjectDetail(env, staff, wrong, "project-a")).rejects.toMatchObject({ status: 404 });
    }
    await expect(readClientHubBusinessProjectDetail(env, staff, { ...root, root: { ...root.root, source_id: "delivery:local" } }, "project-a"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='standalone'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, root, "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("requires directory and project-view permission without adding new write authority", async () => {
    const { env } = await fixture();
    acl.hasPermission.mockResolvedValue(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 403 });
    acl.hasPermission.mockResolvedValue(true);
    acl.sqlScope.mockResolvedValue({ ...fullScope, deniedGlobal: true });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 403 });
    acl.sqlScope.mockResolvedValue(fullScope);
    const root = context(); root.access.directory = false;
    await expect(readClientHubBusinessProjectDetail(env, staff, root, "project-a")).rejects.toMatchObject({ status: 403 });
  });

  it("uses the same manager and direct/operation/task assignment scope as business history", async () => {
    const { db, env } = await fixture();
    acl.isAdministrator.mockResolvedValue(false);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_projects SET manager_user_id=NULL").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await sql(db, `INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id) VALUES('assignment','project-a','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_project_assignments SET active=0").run();
    await sql(db, `INSERT INTO pa_operations(id,project_id,title,status,payload_json,last_sync_id) VALUES('op','project-a','Operation','scheduled','{}','sync');
      INSERT INTO pa_operation_assignments(operation_id,user_id,payload_json,last_sync_id) VALUES('op','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_operation_assignments SET active=0").run();
    await sql(db, `INSERT INTO pa_tasks(id,project_id,title,status,payload_json,last_sync_id) VALUES('task','project-a','Task','todo','{}','sync');
      INSERT INTO pa_task_assignments(task_id,user_id,payload_json,last_sync_id) VALUES('task','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_task_assignments SET active=0").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects stale optional contexts and malformed identifiers before selecting detail", async () => {
    const { env } = await fixture();
    for (const id of ["", "a".repeat(513), "bad\u0000id"])
      await expect(readClientHubBusinessProjectDetail(env, staff, context(), id)).rejects.toMatchObject({ status: 400 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: "bad" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: "b".repeat(43) }))
      .rejects.toMatchObject({ status: 409 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: context().contextVersion }))
      .resolves.toMatchObject({ project: { id: "project-a" } });
  });

  it.each(["project", "contact", "assignment", "permission", "source"] as const)("rechecks %s changes after hydration", async change => {
    const { db, env } = await fixture();
    const admin = change !== "assignment";
    if (!admin) {
      await db.prepare("UPDATE pa_projects SET manager_user_id=NULL").run();
      await sql(db, `INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id) VALUES('assignment','project-a','user-a','{}','sync');`);
    }
    acl.isAdministrator.mockImplementationOnce(async () => admin).mockImplementationOnce(async () => {
      const updates = {
        project: "UPDATE pa_projects SET organization_id='org-b'",
        contact: "UPDATE pa_clients SET organization_id='org-b' WHERE id='client-a'",
        assignment: "UPDATE pa_project_assignments SET active=0",
        permission: "SELECT 1",
        source: `UPDATE pa_organizations SET payload_json='{"public_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' WHERE id='org-a'`,
      };
      await sql(db, updates[change]);
      return change === "permission" ? !admin : admin;
    });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 409 });
  });

  it("returns unknown for malformed, non-scalar, oversized and control-bearing source fields", async () => {
    const { db, env } = await fixture();
    for (const payload of ["not-json", "[]", '{"description":{"private":"secret"},"created_at":12}',
      JSON.stringify({ description: "a".repeat(8001), created_at: "now" }),
      JSON.stringify({ description: "bad\u0000text", created_at: "2026-02-30T00:00:00Z" })]) {
      await db.prepare("UPDATE pa_projects SET payload_json=?,start_date='not-a-date'").bind(payload).run();
      const detail = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
      expect(detail.project).toMatchObject({ description: null, created_at: null, start_date: null });
    }
    await db.prepare("UPDATE pa_clients SET payload_json=? WHERE id='client-a'")
      .bind(JSON.stringify({ email: { secret: "private" }, phone: "bad\u0000phone" })).run();
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).linkedContact)
      .toMatchObject({ email: null, phone: null });
  });
});
