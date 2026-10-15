import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { clientHubClassicReadIdentities, clientHubClassicReadEligibleSql } from "../src/worker/client-hub-classic-read";
import { reconcileClientHubIndex } from "../src/worker/client-hub-index";
import { listClientHubRoots, findClientHubRoot } from "../src/worker/client-hub-directory";
import { resolveClientHubSourceRoot, resolveClientHubSourceRootByAlphaIdentity, resolveClientHubSourceRootByAlphaPublicId } from "../src/worker/client-hub-source";
import { createClientHubCollectionContext, listClientHubCollection } from "../src/worker/client-hub-collections";
import { listClientHubBusinessProjects } from "../src/worker/client-hub-business-projects";
import { requireProjectAlphaReadOrNativeMappingVisibility } from "../src/worker/project-alpha-read-visibility";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { applyBusinessPartySchema } from "./helpers/business-parties";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { Env, StaffPrincipal } from "../src/worker/types";
const runtimes: Miniflare[] = [];
const staff: StaffPrincipal = { id: "staff-compat", email: "staff@example.test", displayName: "Staff", accessSubject: "access-compat", projectAlphaUserId: "pa-staff" };
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
const identity = { sourceInstanceId: "11111111-1111-4111-8111-111111111111", applicationId: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333" };
const sourceIdentity = (source: string) => source === primary ? identity : { sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", historyEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const sql = (value: string) => value.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");
const publicId = (n: number) => n.toString(16).padStart(32, "0");
async function fixture() {
  const runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }",
    d1Databases: { OPS_DB: "index-ops", DELIVERY_DB: "index-delivery" } });
  runtimes.push(runtime);
  const ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  const delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const execute = (db: D1Database, sql: string) => db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  await execute(ops, `
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,last_sync_id TEXT,name TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,last_sync_id TEXT,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_projects(id TEXT PRIMARY KEY,last_sync_id TEXT,business_unit_id TEXT,manager_user_id TEXT,status TEXT,start_date TEXT,end_date TEXT,updated_at TEXT,name TEXT,organization_id TEXT,client_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
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
  return { ops, delivery };
}

afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });
async function compatibilityFixture() {
  const { ops, delivery } = await fixture();
  await ops.exec(sql(`
      CREATE TABLE project_alpha_directory_read_adoption_reviews(
        review_id TEXT PRIMARY KEY,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
        resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT,
        authorization_generation TEXT,inventory_request_id TEXT,inventory_page_sha256 TEXT,profile_request_id TEXT,
        binding_request_id TEXT,binding_evidence_sha256 TEXT);
      CREATE TABLE project_alpha_directory_read_adoption_claims(claim_id TEXT PRIMARY KEY,state TEXT);
      CREATE TABLE project_alpha_directory_read_adoption_field_review_receipts(
        receipt_id TEXT PRIMARY KEY,review_id TEXT UNIQUE,claim_id TEXT,resource_type TEXT,record_id TEXT,
        local_record_version INTEGER,project_alpha_profile_sha256 TEXT);
      CREATE TABLE project_alpha_directory_read_adoption_field_decisions(
        receipt_id TEXT,field_name TEXT,decision TEXT,PRIMARY KEY(receipt_id,field_name));
      CREATE TABLE project_alpha_directory_read_adoption_field_review_audit(receipt_id TEXT);
      CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
      CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT,PRIMARY KEY(record_id,version));
      CREATE TABLE project_alpha_api_v2_directory_observations_current(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,
        project_alpha_public_id TEXT,present INTEGER,last_action TEXT,has_conflict INTEGER,resource_revision TEXT,
        binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT,request_id TEXT);
      CREATE TABLE project_alpha_api_v2_inventory_receipts(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,
        request_id TEXT,authorization_generation TEXT,page_sha256 TEXT);
      CREATE TABLE project_alpha_api_v2_inventory_conflicts(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
        inventory_kind TEXT,resource_type TEXT,project_alpha_public_id TEXT,external_id TEXT);
      CREATE TABLE project_alpha_directory_mappings(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
      CREATE TABLE project_alpha_acquired_canonical_mappings(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);

  `));
  for (const name of ["0166_project_alpha_reviewed_standalone_display.sql"])
    await ops.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).map(statement => ops.prepare(statement)));
  await applyConnectorSchema(ops);
  await applyBusinessPartySchema(ops);
  await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0197_portal_root_access_policy.sql", import.meta.url), "utf8")).map(statement => delivery.prepare(statement)));
  await ops.exec(sql(`
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    INSERT INTO role_permissions VALUES('directory','team.view');
    INSERT INTO staff_role_assignments VALUES('staff-compat','directory','global',NULL);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
    CREATE TABLE active_mapping_rows(source_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,active INTEGER,mapping_kind TEXT,provenance_id TEXT);
    CREATE VIEW project_alpha_active_directory_mappings AS SELECT source_id,resource_type,record_id,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,mapping_kind,provenance_id FROM active_mapping_rows WHERE active=1;
    CREATE TABLE project_alpha_existing_directory_binding_acquired_mapping_receipts(source_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE pa_users(id TEXT PRIMARY KEY,display_name TEXT,projection_source_id TEXT);
    CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT);
    CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT);
    CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT);
    CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT);
    CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT);
  `));
  await ops.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0037_client_business_activity.sql", import.meta.url), "utf8")).map(statement => ops.prepare(statement)));
  const instances: Record<string, unknown> = {};
  for (const sourceId of [primary, secondary]) {
    await registerVisibleTestSource(ops, sourceId);
    await ops.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(sourceId).run();
    const origin = await ops.prepare("SELECT snapshot_origin FROM pa_connectors WHERE source_id=?").bind(sourceId).first<string>("snapshot_origin");
    instances[sourceId] = { sourceId, enabled: true, baseUrl: origin, apiKey: "test-secret-never-return", ...sourceIdentity(sourceId) };
  }
  const env = { OPS_DB: ops, DELIVERY_DB: delivery, ENVIRONMENT: "production", CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true", PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances }) } as unknown as Env;
  return { ops, delivery, env, instances };
}
function countedDatabase(database: D1Database, onQuery: () => void): D1Database {
  const wrap = <T extends D1Database | D1DatabaseSession>(db: T): T => new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => { onQuery(); return target.prepare(sql); };
      if (key === "withSession" && "withSession" in target) return (constraint?: D1SessionBookmark | D1SessionConstraint) => wrap(target.withSession(constraint));
      const value = Reflect.get(target,key);return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrap(database);
}
async function finishIndex(env: Env) {
  for (let n = 0; n < 50; n++) {
    const result = await reconcileClientHubIndex(env, 40);
    if (result.status === "complete") return;
    expect(result.status).toBe("progress");
  }
  throw new Error("Index failed to complete within bounded pages");
}
async function classic(ops: D1Database, source: string, n: number, kind: "organization" | "client" = "client", parent: string | null = null) {
  const id = `${source}:${kind}:${n}`, payload = JSON.stringify({ id: n, public_id: publicId(n), name: `Compatibility ${n}`, email: `record${n}@example.test` });
  const statement = kind === "organization"
    ? ops.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES(?,?,1,?,?)").bind(id, `Compatibility ${n}`, payload, source)
    : ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,projection_source_id) VALUES(?,?,?,1,?,?)").bind(id, `Compatibility ${n}`, parent, payload, source);
  await statement.run();
  const observedIdentity = sourceIdentity(source);
  await ops.prepare(`INSERT INTO project_alpha_api_v2_directory_observations_current(source_id,source_instance_id,application_id,history_epoch_id,resource_type,project_alpha_public_id,present,last_action,has_conflict,resource_revision,binding_external_id,binding_status,binding_resource_revision,request_id)
    VALUES(?,?,?,?,?,?,1,'upsert',0,'1',NULL,NULL,NULL,'observed-current')`).bind(source,observedIdentity.sourceInstanceId,observedIdentity.applicationId,observedIdentity.historyEpoch,kind,publicId(n)).run();
  return id;
}

describe("migrated Client Hub classic business read compatibility", { timeout: 60_000 }, () => {
  it("indexes and resolves all60 existing source-bound records with an empty native view, without native ownership", async () => {
    const { ops, delivery, env } = await compatibilityFixture();
    const ids: Array<{ source: string; id: string; n: number; kind: "organization" | "standalone_client"; parent: string | null }> = [];
    for (let n = 1; n <= 60; n++) {
      const source = n <= 51 ? primary : secondary, kind = n <= 21 || n >= 52 && n <= 55 ? "organization" : "client";
      const parent = n >= 29 && n <= 51 ? `${primary}:organization:${1+(n-29)%21}`
        : n >= 56 ? `${secondary}:organization:${52+(n-56)%4}` : null;
      ids.push({ source, id: await classic(ops, source, n, kind, parent), n, kind: kind === "client" ? "standalone_client" : "organization", parent });
    }
    const identities = await clientHubClassicReadIdentities(env);
    expect(identities).toHaveLength(2);
    expect(await ops.prepare(`SELECT count(*) n FROM pa_clients source WHERE ${clientHubClassicReadEligibleSql("pa_clients", "source", identities)}`).first("n")).toBe(35);
    expect(await ops.prepare(`SELECT count(*) n FROM pa_organizations source WHERE ${clientHubClassicReadEligibleSql("pa_organizations", "source", identities)}`).first("n")).toBe(25);
    await finishIndex(env);
    let listQueries = 0;
    const listed = await listClientHubRoots({ ...env, OPS_DB: countedDatabase(ops,()=>{listQueries++;}) }, staff, { limit: 100, grouping: "records", sort: "name" });
    expect(listQueries).toBeLessThan(100); // A full-size page must stay safely below Workers' database subrequest budget.
    expect(listed.clients).toHaveLength(32); //25organizations +7standaloneclients;28otherclients are nested contacts
    expect(new Set(listed.clients.map(row => `${row.source_id}/${row.public_id}`)).size).toBe(32);
    expect(await ops.prepare("SELECT count(DISTINCT record_id) n FROM client_hub_search_values WHERE record_type='pa_client'").first("n")).toBe(35);
    expect(listed.clients.filter(row=>row.kind==="organization")).toHaveLength(25);
    for (const selected of ids.filter(row => [1,21,22,28,52,55].includes(row.n))) {
      const root = await findClientHubRoot(env, selected.kind, selected.id, selected.source, "business");
      expect(root.pa_public_id).toBe(publicId(selected.n));
      expect(root.workspace_id).toBeNull();
      expect(await resolveClientHubSourceRoot(env, selected.kind, selected.id, selected.source)).toMatchObject({ id: selected.id, pa_public_id: publicId(selected.n) });
    }
    expect((await listClientHubRoots(env, staff, { q: "Compatibility 60", limit: 100 })).clients.map(row => row.public_id)).toEqual([ids[59]!.parent]);
    expect(await ops.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(0);
    expect(await ops.prepare("SELECT count(*) n FROM project_alpha_active_directory_mappings").first("n")).toBe(0);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_workspaces").first("n")).toBe(0);
  });
  it("requires exact current source/epoch evidence and hides foreign bindings, conflicts, deletions and invalid origins", async () => {
    const { ops, env, instances } = await compatibilityFixture();
    const id = await classic(ops, secondary, 90);
    const visible = async () => resolveClientHubSourceRoot(env, "standalone_client", id, secondary);
    expect(await visible()).not.toBeNull();
    const otherSourceRecord = await classic(ops,primary,90); //same public ID and email across independent producers
    expect(otherSourceRecord).not.toBe(id);
    expect(await resolveClientHubSourceRootByAlphaPublicId(env,"standalone_client",primary,publicId(90))).toMatchObject({id:otherSourceRecord});
    expect(await resolveClientHubSourceRootByAlphaPublicId(env,"standalone_client",secondary,publicId(90))).toMatchObject({id});
    for (const [column, value] of [["history_epoch_id", "44444444-4444-4444-8444-444444444444"], ["source_instance_id", "44444444-4444-4444-8444-444444444444"], ["application_id", "44444444-4444-4444-8444-444444444444"], ["binding_external_id", "foreign-owner"], ["binding_status", "active"], ["has_conflict", 1], ["present", 0], ["last_action", "delete"]] as const) {
      const original = await ops.prepare(`SELECT ${column} v FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?`).bind(secondary).first("v");
      await ops.prepare(`UPDATE project_alpha_api_v2_directory_observations_current SET ${column}=? WHERE source_id=?`).bind(value,secondary).run();
      expect(await visible(), column).toBeNull();
      await ops.prepare(`UPDATE project_alpha_api_v2_directory_observations_current SET ${column}=? WHERE source_id=?`).bind(original,secondary).run();
    }
    const configured = instances[secondary] as Record<string, unknown>;
    for (const delta of [{ enabled: false }, { baseUrl: "https://wrong-instance.example.test" }, { historyEpoch: "44444444-4444-4444-8444-444444444444" }]) {
      env.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify({ version: 1, instances: { ...instances, [secondary]: { ...configured, ...delta } } });
      expect(await visible()).toBeNull();
    }
    env.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify({ version: 1, instances });
    expect(await visible()).not.toBeNull();
    expect(await resolveClientHubSourceRoot(env, "standalone_client", id, primary)).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaIdentity(env, "standalone_client", id, secondary, publicId(91))).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(env, "standalone_client", primary, publicId(90))).toMatchObject({id:otherSourceRecord});
  });

  it("vetoes source-wide directory conflicts independently of resource conflict flags and isolates other sources", async () => {
    const { ops, env } = await compatibilityFixture();
    const primaryId = await classic(ops, primary, 97);
    const secondaryId = await classic(ops, secondary, 98);
    expect(await reconcileClientHubIndex(env, 40)).toMatchObject({ status: "complete" });
    expect((await listClientHubRoots(env, staff, { limit: 100 })).clients).toHaveLength(2);
    const conflict = (surface: string) => ops.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts
      (source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,project_alpha_public_id,external_id)
      VALUES(?,?,?,?,?,'source',NULL,NULL)`).bind(primary, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch, surface).run();
    await conflict("project");
    expect(await resolveClientHubSourceRoot(env, "standalone_client", primaryId, primary)).not.toBeNull();
    await conflict("directory");
    // The current observation itself remains present, unbound and conflict-free.
    // Only the independently recorded source-wide conflict vetoes its display.
    expect(await ops.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
      WHERE source_id=?`).bind(primary).first("has_conflict")).toBe(0);
    expect(await resolveClientHubSourceRoot(env, "standalone_client", primaryId, primary)).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(env, "standalone_client", primary, publicId(97))).toBeNull();
    await expect(findClientHubRoot(env, "standalone_client", primaryId, primary, "business"))
      .rejects.toMatchObject({ status: 404 });
    expect((await listClientHubRoots(env, staff, { q: "Compatibility", limit: 100 })).clients.map(row => row.public_id))
      .toEqual([secondaryId]);
    expect(await resolveClientHubSourceRoot(env, "standalone_client", secondaryId, secondary)).not.toBeNull();
    expect(await ops.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(0);
    expect(await ops.prepare("SELECT count(*) n FROM project_alpha_active_directory_mappings").first("n")).toBe(0);
  });

  it.each(["pa_clients", "pa_organizations"])("fails closed without %s storage while preserving valid native mappings", async table => {
    const { ops, env } = await compatibilityFixture();
    const id = await classic(ops, primary, 99);
    await ops.prepare("INSERT INTO operations_directory_records VALUES('native-only','organization',1)").run();
    await ops.prepare("INSERT INTO operations_directory_revisions VALUES('native-only',1,?)")
      .bind(JSON.stringify({ name: "Native remains available" })).run();
    await ops.prepare("INSERT INTO active_mapping_rows VALUES(?,?,?,?,?,?,?,?,1,'acquired','native-only-proof')")
      .bind(primary, "organization", "native-only", "remote-org", publicId(100), identity.sourceInstanceId,
        identity.applicationId, identity.historyEpoch).run();
    await ops.prepare(`DROP TABLE ${table}`).run();
    expect(await clientHubClassicReadIdentities(env)).toEqual([]);
    expect(await resolveClientHubSourceRoot(env, "standalone_client", id, primary)).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(env, "standalone_client", primary, publicId(99))).toBeNull();
    expect(await resolveClientHubSourceRoot(env, "organization", "native-only", primary))
      .toMatchObject({ id: "native-only", display_name: "Native remains available" });
  });

  it("blocks malformed and inactive duplicate public IDs rather than guessing a classic identity", async () => {
    const { ops, env } = await compatibilityFixture();
    const id = await classic(ops, primary, 91);
    for (const invalid of ["A".repeat(32), ` ${publicId(91)}`, "91", null]) {
      await ops.prepare("UPDATE pa_clients SET payload_json=? WHERE id=?").bind(JSON.stringify({ public_id: invalid }), id).run();
      expect(await resolveClientHubSourceRoot(env, "standalone_client", id, primary)).toBeNull();
    }
    await ops.prepare("UPDATE pa_clients SET payload_json=? WHERE id=?").bind(JSON.stringify({ public_id: publicId(91) }), id).run();
    await ops.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,projection_source_id) VALUES('inactive-collision','Collision',NULL,0,?,?)").bind(JSON.stringify({ public_id: publicId(91) }), primary).run();
    expect(await resolveClientHubSourceRoot(env, "standalone_client", id, primary)).toBeNull();
  });

  it("lets a current native mapping win and prevents historical claims from resurrecting classic rows", async () => {
    const { ops, env } = await compatibilityFixture();
    const id = await classic(ops, primary, 92, "organization");
    await ops.prepare("INSERT INTO operations_directory_records VALUES('native-92','organization',1)").run();
    await ops.prepare("INSERT INTO operations_directory_revisions VALUES('native-92',1,?)").bind(JSON.stringify({ name: "Native wins" })).run();
    await ops.prepare("INSERT INTO active_mapping_rows VALUES(?,?,?,?,?,?,?,?,1,'acquired','provenance92')").bind(primary,"organization","native-92",id,publicId(92),identity.sourceInstanceId,identity.applicationId,identity.historyEpoch).run();
    expect(await resolveClientHubSourceRoot(env,"organization",id,primary)).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(env,"organization",primary,publicId(92))).toMatchObject({ id: "native-92", display_name: "Native wins" });
    await ops.prepare("UPDATE active_mapping_rows SET active=0").run();
    await ops.prepare("INSERT INTO project_alpha_acquired_canonical_mappings VALUES(?,?,?,?,?,?,?)").bind(primary,identity.sourceInstanceId,identity.applicationId,"organization","native-92",id,publicId(92)).run();
    expect(await resolveClientHubSourceRoot(env,"organization",id,primary)).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(env,"organization",primary,publicId(92))).toBeNull();
    const legacy = await classic(ops,primary,98,"organization");
    expect(await resolveClientHubSourceRoot(env,"organization",legacy,primary)).not.toBeNull();
    await ops.prepare("INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)").bind(primary,identity.sourceInstanceId,identity.applicationId,"organization",legacy,publicId(98)).run();
    expect(await resolveClientHubSourceRoot(env,"organization",legacy,primary)).toBeNull();

  });

  it("keeps index, search and detail live-revoked when a visible source is hidden or retired", async () => {
    const { ops, env } = await compatibilityFixture();
    const id = await classic(ops, secondary, 93);
    await finishIndex(env);
    expect((await listClientHubRoots(env,staff,{q:"Compatibility 93"})).clients).toHaveLength(1);
    for (const change of ["read_visible=0", "state='retired'"]) {
      await ops.prepare(`UPDATE pa_connectors SET ${change},version=version+1 WHERE source_id=?`).bind(secondary).run();
      expect((await listClientHubRoots(env,staff,{q:"Compatibility 93"})).clients).toHaveLength(0);
      await expect(findClientHubRoot(env,"standalone_client",id,secondary,"business")).rejects.toMatchObject({status:404});
      expect(await resolveClientHubSourceRoot(env,"standalone_client",id,secondary)).toBeNull();
      if (change === "read_visible=0") await ops.prepare("UPDATE pa_connectors SET read_visible=1,version=version+1 WHERE source_id=?").bind(secondary).run();
    }
  });

  it("preserves portal-root revocation and global directory denies without creating any portal authority", async () => {
    const { ops, delivery, env } = await compatibilityFixture();
    const id = await classic(ops, primary, 94);
    await delivery.prepare(`INSERT INTO portal_v2_root_access_policies(projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
      VALUES(?,'standalone_client',?,'revoked','review',?,?)`).bind(primary,publicId(94),staff.id,staff.id).run();
    await finishIndex(env);
    expect((await listClientHubRoots(env,staff,{})).clients).toEqual([expect.objectContaining({ public_id:id,portal_access_state:"revoked",workspace_id:null })]);
    await ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'team.view','deny','global',NULL)").bind(staff.id).run();
    await expect(listClientHubRoots(env,staff,{})).rejects.toMatchObject({status:403});
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_workspaces").first("n")).toBe(0);
    expect(await delivery.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(1); // only the fixture's pre-existing unrelated row
  });

  it("nests source-qualified contacts and preserves legacy project permissions without granting native authority", async () => {
    const { ops, env } = await compatibilityFixture();
    const org = await classic(ops,primary,95,"organization");
    const child = await classic(ops,primary,96,"client",org);
    const foreign = await classic(ops,secondary,97,"client",org);
    await ops.prepare("INSERT INTO role_permissions VALUES('project-reader','projects.view')").run();
    await ops.prepare("INSERT INTO staff_role_assignments VALUES(?,'project-reader','global',NULL)").bind(staff.id).run();
    await ops.prepare(`INSERT INTO pa_projects(id,name,organization_id,client_id,manager_user_id,status,active,payload_json,projection_source_id)
      VALUES('primary-project','Scoped primary project',?,NULL,?,'active',1,'{}',?),('foreign-project','Scoped foreign project',?,NULL,?,'active',1,'{}',?)`)
      .bind(org,staff.projectAlphaUserId,primary,org,staff.projectAlphaUserId,secondary).run();
    await finishIndex(env);
    const root = await findClientHubRoot(env,"organization",org,primary,"business");
    const visible = await requireProjectAlphaReadOrNativeMappingVisibility(env,primary,org,"organization");
    expect(visible).not.toHaveProperty("nativeProof");
    const context = await createClientHubCollectionContext(env,staff,root,{directory:true,requests:false,delivery:false,viewer:false});
    const contacts = await listClientHubCollection(env,context,"businessContacts");
    expect(contacts.items.map(row=>row.public_id)).toEqual([child]);
    expect(contacts.items.map(row=>row.public_id)).not.toContain(foreign);
    const projects = await listClientHubBusinessProjects(env,staff,context);
    expect(projects.items.map(row=>row.id)).toEqual(["primary-project"]);
    await ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'projects.view','deny','global',NULL)").bind(staff.id).run();
    await expect(listClientHubBusinessProjects(env,staff,context)).rejects.toMatchObject({status:403});
    expect(await ops.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(0);
  });

});
