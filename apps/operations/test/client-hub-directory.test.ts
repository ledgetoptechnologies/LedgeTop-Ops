import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientHubDetailPath, findClientHubRoot, listClientHubRoots, normalizeClientHubText,
  type ClientHubKind, type ClientHubRoot, type ClientHubSource } from "../src/worker/client-hub-directory";
import { createClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { applyBusinessPartySchema } from "./helpers/business-parties";

const staff: StaffPrincipal = { id: "staff-a", email: "a@example.test", displayName: "A", accessSubject: "subject-a", projectAlphaUserId: "pa-user-a" };
const migration = readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8");
const sql = (value: string) => value.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");

describe("source-qualified Client Hub directory", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let deliveryDb: D1Database;
  let env: Env;
  let populated0166Upgrade: { root: unknown; search: unknown; foreignKeys: unknown[] };
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }",
      d1Databases: { OPS_DB: "hub-directory", DELIVERY_DB: "hub-directory-delivery" } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    deliveryDb = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    env = { OPS_DB: db, DELIVERY_DB: deliveryDb, CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      ENVIRONMENT: "staging", PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true" } as Env;
    await deliveryDb.batch(splitD1MigrationStatements(readFileSync(
      new URL("../../client/migrations/0197_portal_root_access_policy.sql", import.meta.url), "utf8",
    )).map(statement => deliveryDb.prepare(statement)));
    await db.exec(sql(`
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
      CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER);
      CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
      CREATE TABLE native_directory_resource_scopes(record_id TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
      CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,
        business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER);
      INSERT INTO role_permissions VALUES('directory','team.view'),('projects','projects.view');
      CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,active INTEGER,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT '',last_sync_id TEXT,business_unit_id TEXT,active INTEGER,manager_user_id TEXT,client_id TEXT,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    `));
    await db.exec(sql(migration));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0034_client_hub_projection_sources.sql", import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0042_client_hub_secondary_portal_visibility.sql", import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    await db.exec(sql(`
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
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT,relationship_version INTEGER);
      CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,resource_type TEXT,external_id TEXT,
        project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
        provenance_id TEXT,mapping_kind TEXT,created_at TEXT);
      CREATE TABLE project_alpha_api_v2_directory_observations_current(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,
        project_alpha_public_id TEXT,present INTEGER,last_action TEXT,has_conflict INTEGER,resource_revision TEXT,
        binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT,request_id TEXT);
      CREATE TABLE project_alpha_api_v2_inventory_receipts(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,
        request_id TEXT,authorization_generation TEXT,page_sha256 TEXT);
      CREATE TABLE project_alpha_api_v2_inventory_conflicts(
        source_id TEXT,inventory_kind TEXT,resource_type TEXT,project_alpha_public_id TEXT,external_id TEXT);
      CREATE TABLE project_alpha_directory_mappings(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
      CREATE TABLE project_alpha_acquired_canonical_mappings(
        source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);
    `));
    await db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status,
      portal_status,account_count,project_count,request_count,contact_count)
      VALUES('delivery:local','account','standalone_client','upgrade-client','Preserved upgrade client','preserved upgrade client',
        'active','not_provisioned',0,0,0,0)`).run();
    await db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('delivery:local','account','standalone_client','upgrade-client','account','upgrade-client','name','preserved upgrade client')`).run();
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0166_project_alpha_reviewed_standalone_display.sql", import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    populated0166Upgrade = {
      root: await db.prepare(`SELECT source_id,root_namespace,kind,public_id,display_name FROM client_hub_roots WHERE public_id='upgrade-client'`).first(),
      search: await db.prepare(`SELECT record_type,record_id,field,normalized_value FROM client_hub_search_values WHERE root_public_id='upgrade-client'`).first(),
      foreignKeys: (await db.prepare("PRAGMA foreign_key_check").all()).results,
    };
    await applyConnectorSchema(db);
    await applyBusinessPartySchema(db);
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0037_client_business_activity.sql", import.meta.url), "utf8")).map(statement => db.prepare(statement)));
  });
  beforeEach(async () => {
    env.ENVIRONMENT = "staging";
    env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "true";
    await deliveryDb.prepare("UPDATE portal_v2_root_access_policies SET state='active'").run();
    await db.batch([
      db.prepare("DELETE FROM client_hub_search_values"), db.prepare("DELETE FROM client_hub_roots"),
      db.prepare("DELETE FROM staff_role_assignments"), db.prepare("DELETE FROM staff_permission_overrides"),
      db.prepare("DELETE FROM native_directory_grants"),
      db.prepare("DELETE FROM pa_projects"), db.prepare("DELETE FROM pa_project_assignments"),
      db.prepare("DELETE FROM pa_clients"), db.prepare("DELETE FROM pa_organizations"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','directory','global',NULL)"),
      db.prepare("UPDATE client_hub_directory_state SET ready=1,last_success_at=NULL WHERE id='directory'"),
      db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id<>'project-alpha:primary'"),
    ]);
  });

  it("preserves populated Client Hub roots, search rows, and foreign keys across migration 0166", () => {
    expect(populated0166Upgrade.root).toEqual({ source_id: "delivery:local", root_namespace: "account",
      kind: "standalone_client", public_id: "upgrade-client", display_name: "Preserved upgrade client" });
    expect(populated0166Upgrade.search).toEqual({ record_type: "account", record_id: "upgrade-client",
      field: "name", normalized_value: "preserved upgrade client" });
    expect(populated0166Upgrade.foreignKeys).toEqual([]);
  });

  it("authorizes canonical Directory contact name and email search through current ownership", async () => {
    await registerVisibleTestSource(db, "project-alpha:primary", "Project Alpha");
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id='project-alpha:primary'").run();
    const organizationId = "6".repeat(32), clientId = "7".repeat(32);
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES('search-org','organization',1)"),
      db.prepare("INSERT INTO operations_directory_records VALUES('search-client','client',1)"),
      db.prepare("INSERT INTO operations_directory_revisions VALUES('search-org',1,?)")
        .bind(JSON.stringify({ name: "Search Organization" })),
      db.prepare("INSERT INTO operations_directory_revisions VALUES('search-client',1,?)")
        .bind(JSON.stringify({ name: "Astral 😀 Contact", email: "canonical-search@example.test" })),
      db.prepare(`INSERT INTO project_alpha_active_directory_mappings
        VALUES('project-alpha:primary','organization','search-org',?,'search-instance','search-app','search-history','org-proof','acquired','2026-01-01')`)
        .bind(organizationId),
      db.prepare(`INSERT INTO project_alpha_active_directory_mappings
        VALUES('project-alpha:primary','client','search-client',?,'search-instance','search-app','search-history','client-proof','acquired','2026-01-01')`)
        .bind(clientId),
      db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations_current VALUES
        ('project-alpha:primary','search-instance','search-app','search-history','organization',?,1,'upsert',0,'org-rev','search-org','active','org-rev','org-request')`)
        .bind(organizationId),
      db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations_current VALUES
        ('project-alpha:primary','search-instance','search-app','search-history','client',?,1,'upsert',0,'client-rev','search-client','active','client-rev','client-request')`)
        .bind(clientId),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES('search-client','search-org',1)"),
      db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,
        display_name,sort_name,status,portal_status,account_count,project_count,request_count,contact_count)
        VALUES('project-alpha:primary','business','organization','search-org',?,'mapped','Search Organization','search organization',
          'active','not_provisioned',0,0,0,1)`).bind(organizationId),
      db.prepare(`INSERT INTO client_hub_search_values
        (source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','business','organization','search-org','ops_directory_client','search-client','contact','astral 😀 contact')`),
      db.prepare(`INSERT INTO client_hub_search_values
        (source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','business','organization','search-org','ops_directory_client','search-client','email','canonical-search@example.test')`),
    ]);
    // The same Operations external ID in another source is not authorized by
    // the primary source's exact canonical tuple.
    await registerVisibleTestSource(db, "project-alpha:secondary", "Secondary Project Alpha");
    await roots([{ id: "secondary-search-org", kind: "organization", source: "project-alpha:secondary" }]);
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('project-alpha:secondary','business','organization','secondary-search-org',
        'ops_directory_client','search-client','email','canonical-search@example.test')`).run();
    expect((await listClientHubRoots(env, staff, { q: "astral 😀" })).clients.map(row => row.public_id)).toEqual(["search-org"]);
    expect((await listClientHubRoots(env, staff, { q: "canonical-search@example" })).clients.map(row => row.public_id)).toEqual(["search-org"]);

    // An active mapping with the same local/PA identity but a different
    // authority tuple is ambiguous even if only the original tuple has a
    // current observation. Search must fail closed instead of accepting the
    // first tuple that happens to join.
    await db.prepare(`INSERT INTO project_alpha_active_directory_mappings
      VALUES('project-alpha:primary','client','search-client',?,'other-instance','other-app','other-history',
        'other-proof','acquired','2026-01-02')`).bind(clientId).run();
    expect((await listClientHubRoots(env, staff, { q: "canonical-search@example" })).clients).toEqual([]);
  });

  it("hydrates a revoked root independently of workspace projection readiness", async () => {
    const publicId = "a".repeat(32);
    await registerVisibleTestSource(db, "project-alpha:secondary", "Secondary Project Alpha");
    await roots([{ id: "revoked-org", kind: "organization", name: "Revoked organization",
      source: "project-alpha:secondary" }]);
    await db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id=? AND projection_source_id=?")
      .bind(JSON.stringify({ public_id: publicId }), "revoked-org", "project-alpha:secondary").run();
    await deliveryDb.prepare(`INSERT INTO portal_v2_root_access_policies
      (projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
      VALUES ('project-alpha:secondary','organization',?,'revoked','security_concern','staff-a','staff-a')`)
      .bind(publicId).run();
    const client = (await listClientHubRoots(env, staff)).clients[0];
    expect(client).toMatchObject({ public_id: "revoked-org", pa_public_id: publicId,
      portal_access_state: "revoked" });
  });

  it("hides reviewed PII rows absent current native authority and honors record-scoped profile-view grants and denies", async () => {
    const projectionId="70000000-0000-4000-8000-000000000007";
    const recordId="review-record-7";
    await db.batch([
      db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,
        display_name,sort_name,status,portal_status,workspace_id,legacy_account_id,account_count,project_count,request_count,contact_count)
        VALUES('project-alpha:primary','review','standalone_client',?,?,'not_applicable','Reviewed Client','reviewed client',
          'reviewed_display_only','review_only',NULL,NULL,0,0,0,1)`).bind(projectionId,"a".repeat(32)),
      db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','review','standalone_client',?,'api_v2_reviewed_client',?,'contact','reviewed client')`)
        .bind(projectionId,projectionId),
      db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','review','standalone_client',?,'api_v2_reviewed_client',?,'email','reviewed@example.test')`)
        .bind(projectionId,projectionId),
      db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES('project-alpha:primary','review','standalone_client',?,'api_v2_reviewed_client',?,'phone','9205550100')`)
        .bind(projectionId,projectionId),
      db.prepare(`INSERT INTO project_alpha_directory_read_adoption_reviews
        (review_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id,external_id,
          project_alpha_public_id,project_alpha_revision,authorization_generation,inventory_request_id,inventory_page_sha256,
          profile_request_id,binding_request_id,binding_evidence_sha256)
        VALUES('review-7','project-alpha:primary','source-instance','application','history-epoch','client',?,'external-7',
          ?,'revision-7','generation-7','inventory-request','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '70000000-0000-4000-8000-000000000008','70000000-0000-4000-8000-000000000009',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`).bind(recordId,"a".repeat(32)),
      db.prepare("INSERT INTO project_alpha_directory_read_adoption_claims(claim_id,state) VALUES('claim-7','inactive')"),
      db.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_review_receipts
        (receipt_id,review_id,claim_id,resource_type,record_id,local_record_version,project_alpha_profile_sha256)
        VALUES('receipt-7','review-7','claim-7','client',?,1,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')`).bind(recordId),
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(recordId),
      db.prepare(`INSERT INTO project_alpha_reviewed_standalone_client_displays
        (projection_id,receipt_id,review_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,
          record_id,external_id,project_alpha_public_id,project_alpha_revision,authorization_generation,inventory_request_id,
          inventory_page_sha256,profile_request_id,profile_sha256,binding_request_id,binding_sha256,display_name,email,phone,state)
        VALUES(?,'receipt-7','review-7','project-alpha:primary','source-instance','application','history-epoch','client',
          ?,'external-7',?,'revision-7','generation-7','inventory-request',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','70000000-0000-4000-8000-000000000008',
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          '70000000-0000-4000-8000-000000000009','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'Reviewed Client',NULL,NULL,'display_only')`).bind(projectionId,recordId,"a".repeat(32)),
    ]);
    expect((await listClientHubRoots(env,staff,{q:"reviewed",sort:"name"})).clients).toHaveLength(0);
    await expect(findClientHubRoot(env,"standalone_client",projectionId,"project-alpha:primary","review"))
      .rejects.toMatchObject({status:404});

    await db.batch([
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,version) VALUES(?, ?,1,1)`)
        .bind(staff.id,staff.accessSubject),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,version) VALUES(?,?,1)`).bind(staff.id,staff.email),
      db.prepare(`INSERT INTO native_directory_grant_generations(staff_id,generation) VALUES(?,1)`).bind(staff.id),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active)
        VALUES('review-allow',?,'directory.profile.view','allow','resource',?,1)`).bind(staff.id,recordId),
    ]);
    const authority = {staffId:staff.id,accessSubject:staff.accessSubject,admissionVersion:1,profileVersion:1,
      grantGeneration:1,verifiedUntil:new Date(Date.now()+60_000).toISOString()};
    const listed=await listClientHubRoots(env,staff,{q:"reviewed",sort:"name",reviewAuthority:authority});
    expect(listed.clients).toHaveLength(1);
    expect(listed.clients[0]).toMatchObject({root_namespace:"review",public_id:projectionId,
      status:"reviewed_display_only",portal_status:"review_only",workspace_id:null,account_count:0,project_count:0,request_count:0});
    expect(listed.clients[0]).not.toHaveProperty("portal_access_state");
    env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED="false";
    expect((await listClientHubRoots(env,staff,{q:"reviewed",sort:"name",reviewAuthority:authority})).clients).toHaveLength(0);
    expect((await db.prepare("SELECT status FROM client_hub_roots WHERE public_id=?").bind(projectionId)
      .first<string>("status"))).toBe("reviewed_display_only");
    env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED="true";
    const unrelated=await listClientHubRoots(env,staff,{q:"unrelated",sort:"name",reviewAuthority:authority});
    expect(unrelated.clients.map(row=>row.public_id)).not.toContain(projectionId);
    expect((await listClientHubRoots(env,staff,{q:"reviewed@example.test",sort:"name",reviewAuthority:authority})).clients
      .map(row=>row.public_id)).toContain(projectionId);
    expect((await listClientHubRoots(env,staff,{q:"(920) 555-0100",sort:"name",reviewAuthority:authority})).clients
      .map(row=>row.public_id)).toContain(projectionId);
    await expect(createClientHubCollectionContext(env,staff,listed.clients[0]! as ClientHubRoot,{directory:true,requests:true,delivery:true,viewer:true}))
      .rejects.toMatchObject({status:404});
    await roots([{id:"ordinary-local",name:"Ordinary local record",source:"delivery:local"}]);
    const first=await listClientHubRoots(env,staff,{limit:1,sort:"name",reviewAuthority:authority});
    expect(first.clients[0]?.public_id).toBe("ordinary-local");
    expect(first.nextCursor).toBeTruthy();
    await db.prepare("UPDATE native_directory_grant_generations SET generation=2 WHERE staff_id=?").bind(staff.id).run();
    await expect(listClientHubRoots(env,staff,{limit:1,sort:"name",cursor:first.nextCursor!,
      reviewAuthority:{...authority,grantGeneration:2}})).rejects.toMatchObject({status:400});

    await db.batch([
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active)
        VALUES('review-deny',?,'directory.profile.view','deny','resource',?,1)`).bind(staff.id,recordId),
      db.prepare("UPDATE native_directory_grant_generations SET generation=3 WHERE staff_id=?").bind(staff.id),
    ]);
    expect((await listClientHubRoots(env,staff,{q:"reviewed",sort:"name",
      reviewAuthority:{...authority,grantGeneration:3}})).clients).toHaveLength(0);
    await db.batch([
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id=?").bind(staff.id),
      db.prepare(`INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,division_id,active)
        VALUES(?,'business_area','area-a',NULL,1)`).bind(recordId),
      db.prepare(`INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,division_id,active)
        VALUES(?,'division','area-a','division-a',1)`).bind(recordId),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active)
        VALUES('review-area-allow',?,'directory.profile.view','allow','business_area','area-a',1)`).bind(staff.id),
      db.prepare("UPDATE native_directory_grant_generations SET generation=4 WHERE staff_id=?").bind(staff.id),
    ]);
    expect((await listClientHubRoots(env,staff,{q:"reviewed",sort:"name",
      reviewAuthority:{...authority,grantGeneration:4}})).clients).toHaveLength(1);
    await db.batch([
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,active)
        VALUES('review-division-deny',?,'directory.profile.view','deny','division','division-a',1)`).bind(staff.id),
      db.prepare("UPDATE native_directory_grant_generations SET generation=5 WHERE staff_id=?").bind(staff.id),
    ]);
    expect((await listClientHubRoots(env,staff,{q:"reviewed",sort:"name",
      reviewAuthority:{...authority,grantGeneration:5}})).clients).toHaveLength(0);
    expect((await listClientHubRoots(env,staff,{reviewAuthority:{...authority,grantGeneration:5,
      accessSubject:"forged-subject"}})).clients.map(row=>row.public_id)).toContain("ordinary-local");
    expect((await listClientHubRoots(env,staff,{reviewAuthority:{...authority,grantGeneration:5,
      profileVersion:2}})).clients.map(row=>row.public_id)).toContain("ordinary-local");
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id=?").bind(staff.id).run();
    expect((await listClientHubRoots(env,staff,{reviewAuthority:{...authority,admissionVersion:2,
      grantGeneration:5}})).clients.map(row=>row.public_id)).toContain("ordinary-local");
  });
  afterAll(async () => runtime.dispose());

  async function roots(rows: Array<{ id: string; name?: string; kind?: ClientHubKind; source?: ClientHubSource; status?: string }>) {
    const statements = rows.flatMap(row => [db.prepare(`INSERT INTO client_hub_roots
      (source_id,root_namespace,kind,public_id,display_name,sort_name,status) VALUES(?,?,?,?,?,?,?)`)
      .bind(row.source ?? "project-alpha:primary", row.source === "delivery:local" ? "account" : "business", row.kind ?? "standalone_client", row.id,
        row.name ?? row.id, normalizeClientHubText(row.name ?? row.id), row.status ?? "active"),
      ...(row.source === "delivery:local" ? [] : [db.prepare(row.kind === "organization"
        ? "INSERT OR IGNORE INTO pa_organizations(id,active,projection_source_id) VALUES(?,1,?)"
        : "INSERT OR IGNORE INTO pa_clients(id,active,organization_id,projection_source_id) VALUES(?,1,NULL,?)").bind(row.id, row.source ?? "project-alpha:primary")]),
    ]);
    for (let start = 0; start < statements.length; start += 50) await db.batch(statements.slice(start, start + 50));
  }

  async function linkedParty(id: string, name: string, memberIds: [string, string]) {
    await registerVisibleTestSource(db, "project-alpha:secondary", "Second company");
    await roots([{ id: memberIds[0], kind: "organization", name: "A Trading" },
      { id: memberIds[1], kind: "organization", name: "B Trading", source: "project-alpha:secondary" }]);
    await db.batch([
      db.prepare(`INSERT INTO business_parties(id,kind,display_name,sort_name,created_by,updated_by)
        VALUES(?,'organization',?,?,'staff-a','staff-a')`).bind(id, name, normalizeClientHubText(name)),
      ...memberIds.flatMap((recordId, index) => {
        const source = index ? "project-alpha:secondary" : "project-alpha:primary";
        return [db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
          VALUES(?,'organization',?,?)`).bind(source, recordId, recordId),
        db.prepare(`INSERT INTO business_party_links(id,party_id,source_id,record_kind,record_id,linked_by)
          VALUES(?,?,?,'organization',?,'staff-a')`).bind(`${id}-${index}`, id, source, recordId)];
      }),
    ]);
  }

  async function activity(rootId: string, at: string, options: { kind?: ClientHubKind; source?: ClientHubSource; projectId?: string } = {}) {
    const source = options.source ?? "project-alpha:primary", rootKind = options.kind ?? "standalone_client";
    const rootRecordKind = rootKind === "organization" ? "organization" : "client";
    const recordKind = options.projectId ? "project" : rootRecordKind, recordId = options.projectId ?? rootId;
    for (const [kind, id] of [[rootRecordKind, rootId], [recordKind, recordId]]) {
      await db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM pa_projection_record_ids WHERE projection_source_id=? AND record_kind=? AND local_id=?)`)
        .bind(source, kind, id, id, source, kind, id).run();
    }
    await db.prepare(`INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,
      root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at) VALUES(?,?,'projection_event',?,?,?,?,?,'upsert',?,?)`)
      .bind(source, `event-${crypto.randomUUID()}`, recordKind, recordId, rootKind, rootId, rootRecordKind, at, at).run();
  }

  it("defaults to meaningful recent updates with stable names for ties and unknown dates last", async () => {
    await roots([{ id: "recent-z", name: "Z Recent" }, { id: "recent-a", name: "A Older" },
      { id: "recent-b", name: "B Recent" }, { id: "recent-none", name: "A Unknown" }]);
    await activity("recent-z", "2026-08-20T12:00:00.000Z");
    await activity("recent-b", "2026-08-20T12:00:00.000Z");
    await activity("recent-a", "2026-08-19T12:00:00.000Z");
    let cursor: string | undefined; const names: string[] = [];
    do {
      const page = await listClientHubRoots(env, staff, { limit: 1, cursor });
      names.push(...page.clients.map(row => row.display_name));
      expect(page).toMatchObject({ sort: "recent", activityCoverage: "project_alpha_business_records" });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(names).toEqual(["B Recent", "Z Recent", "A Older", "A Unknown"]);
    const alphabetical = await listClientHubRoots(env, staff, { sort: "name" });
    expect(alphabetical.clients.map(row => row.display_name)).toEqual(["A Older", "A Unknown", "B Recent", "Z Recent"]);
    expect(alphabetical.clients.find(row => row.public_id === "recent-none")?.meaningful_activity_at).toBeNull();
  });

  it("ignores cached/global activity, future events, synchronization, and page visits", async () => {
    await roots([{ id: "honest-a" }, { id: "honest-z" }]);
    await db.prepare("UPDATE client_hub_roots SET meaningful_activity_at='2099-01-01T00:00:00.000Z'").run();
    await activity("honest-z", "2099-01-01T00:00:00.000Z");
    const before = await db.prepare("SELECT revision FROM client_business_activity_state").first("revision");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    await db.prepare("UPDATE pa_clients SET last_sync_id='new-snapshot'").run();
    const second = await listClientHubRoots(env, staff, { cursor: first.nextCursor!, limit: 1 });
    expect([...first.clients, ...second.clients].map(row => row.meaningful_activity_at)).toEqual([null, null]);
    expect(await db.prepare("SELECT revision FROM client_business_activity_state").first("revision")).toBe(before);
  });

  it("filters project authority before deriving activity or ordering", async () => {
    await roots([{ id: "scope-a" }, { id: "scope-z" }]);
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,manager_user_id,client_id) VALUES('scope-hidden',1,'other','scope-a'),('scope-visible',1,'pa-user-a','scope-z')"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
    await activity("scope-a", "2026-08-25T00:00:00.000Z", { projectId: "scope-hidden" });
    await activity("scope-z", "2026-08-20T00:00:00.000Z", { projectId: "scope-visible" });
    const visible = await listClientHubRoots(env, staff);
    expect(visible.clients.map(row => [row.public_id, row.meaningful_activity_at])).toEqual([
      ["scope-z", "2026-08-20T00:00:00.000Z"], ["scope-a", null],
    ]);
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','projects.view','deny','global',NULL)").run();
    expect((await listClientHubRoots(env, staff)).clients.every(row => row.meaningful_activity_at === null)).toBe(true);
  });

  it("invalidates activity cursors when live assignments change without another event", async () => {
    await roots([{ id: "assign-a" }, { id: "assign-z" }]);
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,client_id) VALUES('assign-project',1,'assign-z')"),
      db.prepare("INSERT INTO pa_project_assignments(project_id,user_id,active) VALUES('assign-project','pa-user-a',1)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
    await activity("assign-z", "2026-08-20T00:00:00.000Z", { projectId: "assign-project" });
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    expect(first.clients[0]?.public_id).toBe("assign-z");
    await db.prepare("UPDATE pa_project_assignments SET active=0 WHERE project_id='assign-project'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    expect((await listClientHubRoots(env, staff)).clients.map(row => row.public_id)).toEqual(["assign-a", "assign-z"]);
  });

  it("does not transfer historical project activity to a new owner or retain it for the former owner", async () => {
    await roots([{ id: "move-a" }, { id: "move-b" }]);
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,manager_user_id,client_id) VALUES('move-project',1,'pa-user-a','move-a')"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
    await activity("move-a", "2026-08-20T00:00:00.000Z", { projectId: "move-project" });
    await db.prepare("UPDATE pa_projects SET client_id='move-b' WHERE id='move-project'").run();
    expect((await listClientHubRoots(env, staff)).clients.every(row => row.meaningful_activity_at === null)).toBe(true);
  });

  it("rolls linked customer activity across all visible records before grouping, search and pagination", async () => {
    await linkedParty("party-activity", "Z Unified Recent", ["activity-party-a", "activity-party-b"]);
    await roots([{ id: "activity-unlinked", name: "A Older Customer" }]);
    await activity("activity-party-b", "2026-08-22T00:00:00.000Z", { kind: "organization", source: "project-alpha:secondary" });
    await activity("activity-unlinked", "2026-08-20T00:00:00.000Z");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    expect(first.clients[0]).toMatchObject({ business_party_id: "party-activity", meaningful_activity_at: "2026-08-22T00:00:00.000Z" });
    expect((await listClientHubRoots(env, staff, { cursor: first.nextCursor!, limit: 1 })).clients[0]?.public_id).toBe("activity-unlinked");
    for (const selection of [{ q: "A Trading" }, { source: "project-alpha:primary" }]) {
      expect((await listClientHubRoots(env, staff, selection)).clients.find(row => row.business_party_id === "party-activity")?.meaningful_activity_at)
        .toBe("2026-08-22T00:00:00.000Z");
    }
    expect((await listClientHubRoots(env, staff, { grouping: "records", source: "project-alpha:primary", q: "A Trading" })).clients[0]?.meaningful_activity_at).toBeNull();
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:secondary'").run();
    const hidden = await listClientHubRoots(env, staff);
    expect(hidden.clients.every(row => !("business_party_id" in row))).toBe(true);
    expect(hidden.clients.find(row => row.public_id === "activity-party-a")?.meaningful_activity_at).toBeNull();
  }, 15_000);

  it("binds sort and activity revision to pagination and rejects invalid sort and forged future cutoffs", async () => {
    await roots([{ id: "cursor-activity-a" }, { id: "cursor-activity-b" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor!, sort: "name" })).rejects.toMatchObject({ status: 400 });
    await expect(listClientHubRoots(env, staff, { sort: "newest-updated-or-other-sql" })).rejects.toMatchObject({ status: 400 });
    const forged = JSON.parse(atob(first.nextCursor!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
    forged.asOf = "2099-01-01T00:00:00.000Z";
    const cursor = btoa(JSON.stringify(forged)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    await expect(listClientHubRoots(env, staff, { cursor })).rejects.toMatchObject({ status: 400 });
    await activity("cursor-activity-b", "2026-08-20T00:00:00.000Z");
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });

  it.each(["directory", "assignment", "source"] as const)("discards a hydrated page after a concurrent %s authority change", async change => {
    const id = `race-activity-${change}`;
    const source = change === "source" ? "project-alpha:secondary" : "project-alpha:primary";
    if (change === "source") await registerVisibleTestSource(db, source);
    await roots([{ id, source }]);
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,manager_user_id,client_id,projection_source_id) VALUES(?,1,'pa-user-a',?,?)").bind(`${id}-project`, id, source),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
    await activity(id, "2026-08-20T00:00:00.000Z", { projectId: `${id}-project`, source });
    let fired = false;
    let hydrationSession: unknown, authorityRecheckSession: unknown;
    const racing = new Proxy(db, { get(target, key) {
      if (key === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
        const session = target.withSession(...args);
        return new Proxy(session, { get(current, property) {
          if (property === "prepare") return (sql: string) => {
            if (sql.includes("SELECT revision,") && !sql.includes("last_success_at")) authorityRecheckSession = current;
            return current.prepare(sql);
          };
          if (property === "batch") return async <T>(statements: D1PreparedStatement[]) => {
            hydrationSession = current;
            const result = await current.batch<T>(statements);
            if (!fired) {
              fired = true;
              if (change === "directory") await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','team.view','deny','global',NULL)").run();
              if (change === "assignment") await db.prepare("UPDATE pa_projects SET manager_user_id='someone-else' WHERE id=?").bind(`${id}-project`).run();
              if (change === "source") await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?").bind(source).run();
            }
            return result;
          };
          const value = Reflect.get(current, property, current);
          return typeof value === "function" ? value.bind(current) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(listClientHubRoots({ ...env, OPS_DB: racing }, staff)).rejects.toMatchObject({ status: change === "directory" ? 403 : 409 });
    expect(fired).toBe(true);
    expect(authorityRecheckSession).toBeDefined();
    expect(authorityRecheckSession).not.toBe(hydrationSession);
  });

  it("collapses linked records before pagination and sorts by the displayed customer name", async () => {
    await linkedParty("party-page", "Z Unified Customer", ["group-page-a", "group-page-b"]);
    await roots([{ id: "middle", name: "M Independent" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    expect(first.clients.map(row => row.public_id)).toEqual(["middle"]);
    const second = await listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! });
    expect(second.clients).toHaveLength(1);
    expect(second.clients[0]).toMatchObject({ business_party_id: "party-page",
      business_party_name: "Z Unified Customer", business_party_member_count: 2, detail_path: "/clients/parties/party-page" });
    expect(second.nextCursor).toBeNull();
    expect(second.clients[0]).not.toHaveProperty("party_rank");
    expect(await findClientHubRoot(env, "organization", "group-page-b", "project-alpha:secondary", "business"))
      .toMatchObject({ public_id: "group-page-b", source_id: "project-alpha:secondary" });
  });

  it("finds a linked customer by its reviewed name or any matching visible source record", async () => {
    await linkedParty("party-search", "Acme Combined", ["group-search-a", "group-search-b"]);
    for (const q of ["Acme Combined", "B Trading"]) {
      const page = await listClientHubRoots(env, staff, { q, limit: 1 });
      expect(page.clients).toHaveLength(1);
      expect(page.clients[0]).toMatchObject({ business_party_id: "party-search", business_party_member_count: 2 });
      expect(page.nextCursor).toBeNull();
    }
    const filtered = await listClientHubRoots(env, staff, { source: "project-alpha:secondary" });
    expect(filtered.clients[0]).toMatchObject({ public_id: "group-search-b", business_party_id: "party-search" });
  });

  it("keeps source records separate for the explicit linking picker and binds that mode to its cursor", async () => {
    await linkedParty("party-picker", "Picker customer", ["group-picker-a", "group-picker-b"]);
    const first = await listClientHubRoots(env, staff, { grouping: "records", limit: 1 });
    expect(first.clients[0]).toMatchObject({ business_party_id: "party-picker",
      detail_path: "/clients/sources/project-alpha%3Aprimary/business/organizations/group-picker-a" });
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    const second = await listClientHubRoots(env, staff, { grouping: "records", cursor: first.nextCursor!, limit: 1 });
    expect(second.clients[0]?.public_id).toBe("group-picker-b");
    expect(second.nextCursor).toBeNull();
    await expect(listClientHubRoots(env, staff, { grouping: "untrusted" })).rejects.toMatchObject({ status: 400 });
  });

  it("normalizes non-ASCII reviewed names for search without wildcard interpretation", async () => {
    await linkedParty("party-unicode", "ÉLAN %_ Client", ["group-unicode-a", "group-unicode-b"]);
    expect((await listClientHubRoots(env, staff, { q: "e\u0301lan %_" })).clients[0])
      .toMatchObject({ business_party_id: "party-unicode" });
    expect((await listClientHubRoots(env, staff, { q: "ÉLAN not" })).clients).toEqual([]);
  });

  it("suppresses party names and counts when any member becomes hidden or inactive", async () => {
    await linkedParty("party-private", "Private aggregate label", ["group-private-a", "group-private-b"]);
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:secondary'").run();
    const hidden = await listClientHubRoots(env, staff);
    expect(hidden.clients).toHaveLength(1);
    expect(hidden.clients[0]).not.toHaveProperty("business_party_id");
    expect(JSON.stringify(hidden)).not.toContain("Private aggregate label");
    expect((await listClientHubRoots(env, staff, { q: "Private aggregate" })).clients).toEqual([]);
    await registerVisibleTestSource(db, "project-alpha:secondary", "Second company");
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='group-private-b'").run();
    const inactive = await listClientHubRoots(env, staff);
    expect(inactive.clients).toHaveLength(1);
    expect(inactive.clients[0]).not.toHaveProperty("business_party_id");
  });

  it("invalidates pagination after audited links change and restores the unlinked source row", async () => {
    await linkedParty("party-unlink", "A Unified", ["group-unlink-a", "group-unlink-b"]);
    await roots([{ id: "z-after-party", name: "Z Other" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    await db.prepare("UPDATE business_party_links SET unlinked_by='staff-a',unlinked_at=datetime('now') WHERE id='party-unlink-1'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    const refreshed = await listClientHubRoots(env, staff);
    expect(refreshed.clients).toHaveLength(3);
    expect(refreshed.clients.find(row => row.public_id === "group-unlink-b")).not.toHaveProperty("business_party_id");
    expect(refreshed.clients.find(row => row.business_party_id === "party-unlink")?.business_party_member_count).toBe(1);
  });

  it("invalidates grouped pages immediately when a live member deactivates before index reconciliation", async () => {
    await linkedParty("party-lifecycle", "A Unified", ["group-life-a", "group-life-b"]);
    await roots([{ id: "z-after-life", name: "Z Other" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='group-life-b'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    const refreshed = await listClientHubRoots(env, staff);
    expect(refreshed.clients).toHaveLength(2);
    expect(refreshed.clients.every(row => !("business_party_id" in row))).toBe(true);
  });

  it("labels secondary business roots and keeps exact source ownership during search and lookup", async () => {
    await registerVisibleTestSource(db, "project-alpha:secondary", "Second company");
    await roots([{ id: "primary-org", kind: "organization", name: "Same name" },
      { id: "secondary-org", kind: "organization", name: "Same name", source: "project-alpha:secondary" }]);
    const publicId = "b".repeat(32);
    await db.prepare("UPDATE pa_organizations SET payload_json=?").bind(JSON.stringify({ public_id: publicId })).run();
    const page = await listClientHubRoots(env, staff, { q: "Same name" });
    expect(page.clients).toHaveLength(2);
    expect(page.clients.find(row => row.source_id === "project-alpha:secondary")).toMatchObject({
      public_id: "secondary-org", pa_public_id: publicId, source_name: "Second company",
      workspace_id: null, account_count: 0,
      detail_path: "/clients/sources/project-alpha%3Asecondary/business/organizations/secondary-org",
    });
    await expect(findClientHubRoot(env, "organization", "secondary-org", "project-alpha:primary", "business"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("INSERT INTO pa_clients(id,active,organization_id,projection_source_id) VALUES('secondary-contact',1,'secondary-org','project-alpha:secondary')").run();
    for (const [source, root] of [["project-alpha:primary", "primary-org"], ["project-alpha:secondary", "secondary-org"]]) {
      await db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES(?,'business','organization',?,'pa_client','secondary-contact','contact','secondary-only@example.test')`).bind(source, root).run();
    }
    expect((await listClientHubRoots(env, staff, { q: "secondary-only@example.test" })).clients.map(row => row.source_id))
      .toEqual(["project-alpha:secondary"]);
  });
  it("hides unregistered and hidden sources before limits, search, and exact lookup", async () => {
    await roots([{ id: "hidden", name: "A hidden", source: "project-alpha:unregistered" }, { id: "primary", name: "Z primary" }]);
    expect((await listClientHubRoots(env, staff, { limit: 1 })).clients.map(row => row.public_id)).toEqual(["primary"]);
    expect((await listClientHubRoots(env, staff, { q: "hidden" })).clients).toEqual([]);
    await expect(findClientHubRoot(env, "standalone_client", "hidden", "project-alpha:unregistered", "business")).rejects.toMatchObject({ status: 404 });
    await expect(listClientHubRoots(env, staff, { source: "project-alpha:unregistered" })).rejects.toMatchObject({ status: 404 });
    await registerVisibleTestSource(db, "project-alpha:unregistered", "Business B");
    const visible = await listClientHubRoots(env, staff, { source: "project-alpha:unregistered", limit: 1 });
    expect(visible.clients.map(row => row.public_id)).toEqual(["hidden"]);
    expect(visible.sources).toContainEqual({ source_id: "project-alpha:unregistered", display_name: "Business B" });
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:unregistered'").run();
    expect((await listClientHubRoots(env, staff)).sources.some(row => row.source_id === "project-alpha:unregistered")).toBe(false);
    await expect(findClientHubRoot(env, "standalone_client", "hidden", "project-alpha:unregistered", "business")).rejects.toMatchObject({ status: 404 });
  });

  it("binds cursors to source selection and registry revision while suspension retains visible projected data", async () => {
    await registerVisibleTestSource(db, "project-alpha:secondary", "Business B");
    await roots([{ id: "a", source: "project-alpha:secondary" }, { id: "b", source: "project-alpha:secondary" }, { id: "primary" }]);
    const selection = { source: "project-alpha:secondary", limit: 1 };
    const first = await listClientHubRoots(env, staff, selection);
    await expect(listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    expect((await listClientHubRoots(env, staff, { ...selection, cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    const stale = await listClientHubRoots(env, staff, { ...selection, cursor: first.nextCursor! }).catch(error => error);
    expect(stale.status).toBe(409);
    expect(await stale.getResponse().json()).toMatchObject({ code: "source_visibility_changed" });
    const refreshed = await listClientHubRoots(env, staff, selection);
    expect(refreshed.clients[0]?.public_id).toBe("a");
    await db.prepare("UPDATE pa_connectors SET display_name='Renamed business',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    await expect(listClientHubRoots(env, staff, { ...selection, cursor: refreshed.nextCursor! })).rejects.toMatchObject({ status: 409 });
    expect((await listClientHubRoots(env, staff, selection)).clients[0]?.source_name).toBe("Renamed business");
  });
  async function field(root: string, type: string, value: string, projectId: string | null = null) {
    await db.prepare("INSERT OR IGNORE INTO pa_clients(id,active,organization_id) VALUES(?,1,NULL)").bind(root).run();
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value,project_id)
      VALUES('project-alpha:primary','standalone_client',?,?,?,?,?,?)`)
      .bind(root, projectId === null ? "pa_client" : "pa_project", projectId ?? root,
        type, normalizeClientHubText(value), projectId).run();
  }

  it("progressively reads more than 500 roots and resolves an unloaded exact root without DELIVERY_DB", async () => {
    await db.exec(sql(`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<536)
      INSERT INTO client_hub_roots(source_id,kind,public_id,display_name,sort_name,status)
      SELECT 'project-alpha:primary','standalone_client',printf('%04d',n),printf('Client %04d',n),printf('client %04d',n),'active' FROM ids;`));
    await db.prepare("INSERT INTO pa_clients(id,active,organization_id) SELECT public_id,1,NULL FROM client_hub_roots").run();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listClientHubRoots(env, staff, { limit: 100, cursor });
      seen.push(...page.clients.map(client => client.public_id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(537);
    expect(new Set(seen).size).toBe(537);
    expect(await findClientHubRoot(env, "standalone_client", "0536", "project-alpha:primary"))
      .toMatchObject({ public_id: "0536" });
    expect((await listClientHubRoots(env, staff, { q: "0536", limit: 24 })).clients.map(client => client.public_id)).toEqual(["0536"]);
  }, 30_000);

  it("searches all stored contact/email/phone values, not only loaded summaries", async () => {
    await roots([{ id: "a" }, { id: "z" }]);
    await field("z", "contact", "Jane O'Neil");
    await field("z", "email", "Jane@EXAMPLE.test");
    await field("z", "phone", "19205551234");
    expect((await listClientHubRoots(env, staff, { limit: 1 })).clients.map(client => client.public_id)).toEqual(["a"]);
    for (const q of ["o'NEIL", "jane@example", "(920) 555-1234"])
      expect((await listClientHubRoots(env, staff, { q })).clients.map(client => client.public_id), q).toEqual(["z"]);
  });

  it("matches case-insensitively with literal percent/underscore/escape and normalized Unicode", async () => {
    await roots([{ id: "exact", name: "CAFÉ 100%_Done\\Files" }, { id: "neighbor", name: "Cafe 100ABDone Files" }]);
    for (const q of ["cafe\u0301", "100%_done", "\\files"])
      expect((await listClientHubRoots(env, staff, { q })).clients.map(client => client.public_id)).toEqual(["exact"]);
  });

  it("supports long literal Unicode search beyond D1's 50-byte LIKE limit", async () => {
    const name = `${"界".repeat(80)}%_tail`;
    const contact = `${"É".repeat(90)}%_contact`;
    await roots([{ id: "a", name }, { id: "z", name: "Unloaded contact" }]);
    await field("z", "contact", contact);
    expect(new TextEncoder().encode(name).length).toBeGreaterThan(200);
    expect((await listClientHubRoots(env, staff, { q: name })).clients.map(client => client.public_id)).toEqual(["a"]);
    expect((await listClientHubRoots(env, staff, { q: contact.toLowerCase() })).clients.map(client => client.public_id)).toEqual(["z"]);
    expect((await listClientHubRoots(env, staff, { q: "%_" })).clients.map(client => client.public_id).sort()).toEqual(["a", "z"]);
  });

  it("does not use a stale moved/deactivated business contact as a search match", async () => {
    await roots([{ id: "old-org", kind: "organization" }, { id: "new-org", kind: "organization" }]);
    await db.exec("INSERT INTO pa_clients(id,active,organization_id) VALUES('contact-a',1,'old-org');");
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('project-alpha:primary','organization','old-org','pa_client','contact-a','email','private@example.test')`).run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients.map(client => client.public_id)).toEqual(["old-org"]);
    await db.prepare("UPDATE pa_clients SET organization_id='new-org' WHERE id='contact-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id='old-org',active=0 WHERE id='contact-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET active=1 WHERE id='contact-a'").run();
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='old-org'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
  });

  it("does not expose a stale standalone root after client reassignment or deactivation", async () => {
    await roots([{ id: "old-client", name: "Sensitive name" }]);
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toHaveLength(1);
    await db.prepare("UPDATE pa_clients SET organization_id='new-org'").run();
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id=NULL,active=0").run();
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toEqual([]);
  });

  it("does not guess a portal principal's business-root mapping to produce a search match", async () => {
    await roots([{ id: "business-id", name: "Business root" }]);
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('project-alpha:primary','standalone_client','business-id','portal_principal','public-principal-id','email','unproven@example.test')`).run();
    expect((await listClientHubRoots(env, staff, { q: "unproven@example" })).clients).toEqual([]);
  });

  it("applies organization/individual filters before keyset limits and hides closed/inactive roots", async () => {
    await roots([{ id: "a", kind: "organization" }, { id: "b" }, { id: "c", kind: "organization" }, { id: "d", status: "closed" }, { id: "e", status: "inactive" }]);
    const first = await listClientHubRoots(env, staff, { kind: "organization", limit: 1 });
    expect(first.clients.map(client => client.public_id)).toEqual(["a"]);
    expect((await listClientHubRoots(env, staff, { kind: "organization", limit: 1, cursor: first.nextCursor! })).clients.map(client => client.public_id)).toEqual(["c"]);
    expect((await listClientHubRoots(env, staff, { kind: "standalone_client" })).clients.map(client => client.public_id)).toEqual(["b"]);
  });

  it("never infers a source from a colliding raw ID; old URLs fail ambiguous and exact-source routes stay separate", async () => {
    await roots([{ id: "42", name: "Alpha" }, { id: "42", name: "Local", source: "delivery:local" }]);
    await expect(findClientHubRoot(env, "standalone_client", "42")).rejects.toMatchObject({ status: 409 });
    const local = await findClientHubRoot(env, "standalone_client", "42", "delivery:local");
    expect(local.display_name).toBe("Local");
    expect(clientHubDetailPath(local)).toBe("/clients/sources/delivery%3Alocal/account/standalone/42");
    expect((await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary")).display_name).toBe("Alpha");
    await expect(findClientHubRoot(env, "standalone_client", "42", "project-alpha:second")).rejects.toMatchObject({ status: 404 });
    await expect(db.prepare("UPDATE client_hub_roots SET source_id='project-alpha:second' WHERE source_id='delivery:local'").run()).rejects.toThrow();
  });

  it("separates same-source business and portal keys in lookup and keyset pagination", async () => {
    await roots([{ id: "42", name: "Same name" }]);
    await db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
      VALUES('project-alpha:primary','portal','standalone_client','42','Same name','same name','active')`).run();
    await expect(findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary")).rejects.toMatchObject({ status: 409 });
    expect(await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary", "business"))
      .toMatchObject({ root_namespace: "business" });
    const portal = await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary", "portal");
    expect(clientHubDetailPath(portal)).toBe("/clients/sources/project-alpha%3Aprimary/portal/standalone/42");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    const second = await listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! });
    expect([...first.clients, ...second.clients].map(client => client.root_namespace)).toEqual(["business", "portal"]);
  });

  it("rejects stale or mismatched cursors, but scan-only/no-op reconciliation does not break pagination", async () => {
    await roots([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    const revision = await db.prepare("SELECT revision FROM client_hub_directory_state").first("revision");
    await db.prepare("UPDATE client_hub_roots SET scan_generation=9,indexed_at=datetime('now'),source_version='new-version',display_name=display_name").run();
    expect(await db.prepare("SELECT revision FROM client_hub_directory_state").first("revision")).toBe(revision);
    expect((await listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await expect(listClientHubRoots(env, staff, { q: "a", cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await db.prepare("UPDATE client_hub_roots SET sort_name='renamed' WHERE public_id='b'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });

  it("invalidates cursors on effective search changes, not identical search or scan marks", async () => {
    await roots([{ id: "a" }, { id: "b" }]);
    await field("b", "email", "first@example.test");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    await db.prepare("UPDATE client_hub_search_values SET normalized_value=normalized_value,scan_generation=2").run();
    expect((await listClientHubRoots(env, staff, { cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await db.prepare("UPDATE client_hub_search_values SET normalized_value='second@example.test'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });

  it("checks project permission and live assignments before a project field can match a client", async () => {
    await roots([{ id: "a" }, { id: "b" }]);
    await field("a", "project", "Hidden renovation", "hidden");
    await field("b", "project", "Visible renovation", "visible");
    await db.exec("INSERT INTO pa_projects(id,active,manager_user_id,client_id,organization_id) VALUES('hidden',1,NULL,'a',NULL),('visible',1,'pa-user-a','b',NULL);");
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients).toEqual([]);
    await db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients.map(client => client.public_id)).toEqual(["b"]);
    await db.prepare("INSERT INTO pa_project_assignments(project_id,user_id,active) VALUES('hidden','pa-user-a',1)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients.map(client => client.public_id)).toEqual(["a", "b"]);
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','projects.view','deny','global',NULL)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients).toEqual([]);
  });

  it("matches canonical project search through the exact PA public owner identity", async () => {
    await registerVisibleTestSource(db, "project-alpha:primary", "Project Alpha");
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id='project-alpha:primary'").run();
    const organizationPublicId = "3".repeat(32);
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES('ops-project-org','organization',1)"),
      db.prepare("INSERT INTO operations_directory_revisions VALUES('ops-project-org',1,?)")
        .bind(JSON.stringify({ name: "Canonical Project Organization" })),
      db.prepare(`INSERT INTO project_alpha_active_directory_mappings
        VALUES('project-alpha:primary','organization','ops-project-org',?,'project-instance','project-app',
          'project-history','project-proof','acquired','2026-01-01')`).bind(organizationPublicId),
      db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations_current VALUES
        ('project-alpha:primary','project-instance','project-app','project-history','organization',?,1,'upsert',0,
          'project-root-revision','ops-project-org','active','project-root-revision','project-root-request')`)
        .bind(organizationPublicId),
      db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('legacy-project-org','Legacy Project Organization',1,?)")
        .bind(JSON.stringify({ public_id: organizationPublicId })),
      db.prepare("INSERT INTO pa_clients(id,name,active,organization_id,payload_json) VALUES('legacy-project-client','Project Contact',1,'legacy-project-org',?)")
        .bind(JSON.stringify({ public_id: "4".repeat(32) })),
      db.prepare(`INSERT INTO pa_projects(id,name,active,manager_user_id,client_id,organization_id,payload_json)
        VALUES('canonical-search-project','Canonical Search Project',1,'pa-user-a','legacy-project-client','legacy-project-org','{}')`),
      db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,
        display_name,sort_name,status,portal_status,account_count,project_count,request_count,contact_count)
        VALUES('project-alpha:primary','business','organization','ops-project-org',?,'mapped',
          'Canonical Project Organization','canonical project organization','active','not_provisioned',0,1,0,1)`)
        .bind(organizationPublicId),
      db.prepare(`INSERT INTO client_hub_search_values
        (source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value,project_id)
        VALUES('project-alpha:primary','business','organization','ops-project-org','pa_project',
          'canonical-search-project','project','canonical search project','canonical-search-project')`),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
    expect((await listClientHubRoots(env, staff, { q: "Canonical Search" })).clients.map(root => root.public_id))
      .toEqual(["ops-project-org"]);

    // A second same-source legacy owner exporting the same PA identity makes
    // project ownership ambiguous even though the canonical mapping is unique.
    await db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('ambiguous-project-org','Ambiguous',1,?)")
      .bind(JSON.stringify({ public_id: organizationPublicId })).run();
    expect((await listClientHubRoots(env, staff, { q: "Canonical Search" })).clients).toEqual([]);
  });

  async function scopedProject() {
    await roots([{ id: "client-a" }, { id: "client-b" }, { id: "org-a", kind: "organization" }]);
    await field("client-a", "project", "Scoped renovation", "project-a");
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,manager_user_id,client_id,organization_id) VALUES('project-a',1,'pa-user-a','client-a',NULL)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
  }

  it("requires the current active project owner before stale cached project text can match", async () => {
    await scopedProject();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["client-a"]);
    await db.prepare("UPDATE pa_projects SET client_id='client-b'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_projects SET client_id='client-a',active=0").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
  });

  it("prioritizes an explicit project organization over a stale standalone search root", async () => {
    await scopedProject();
    await db.prepare("UPDATE pa_projects SET organization_id='org-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare(`UPDATE client_hub_search_values SET kind='organization',root_public_id='org-a' WHERE record_id='project-a'`).run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["org-a"]);
  });

  it("rechecks inherited organization ownership and active client state for project matches", async () => {
    await scopedProject();
    await db.batch([
      db.prepare(`UPDATE client_hub_search_values SET kind='organization',root_public_id='org-a' WHERE record_id='project-a'`),
      db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='client-a'"),
    ]);
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["org-a"]);
    await db.prepare("UPDATE pa_clients SET organization_id='other-org' WHERE id='client-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id='org-a',active=0 WHERE id='client-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
  });

  it("returns explicit source labels and real directory reconciliation freshness", async () => {
    await roots([{ id: "a" }, { id: "b", source: "delivery:local" }]);
    const completed = "2026-08-25T13:40:00.000Z";
    await db.prepare("UPDATE client_hub_directory_state SET last_success_at=?").bind(completed).run();
    const result = await listClientHubRoots(env, staff);
    expect(result.indexUpdatedAt).toBe(completed);
    expect(result.searchCapabilities).toEqual({ businessContacts: true, portalContacts: false });
    expect(result.clients.map(client => client.source_name)).toEqual(["Project Alpha", "Local delivery"]);
    expect(result.clients.every(client => client.meaningful_activity_at === null)).toBe(true);
  });

  it("requires global directory permission and never treats business indexing as a grant", async () => {
    await roots([{ id: "a" }]);
    await db.prepare("UPDATE staff_role_assignments SET scope='division',division_id='division-a'").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 403 });
    await db.prepare("UPDATE staff_role_assignments SET scope='global'").run();
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','team.view','deny','global',NULL)").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 403 });
    expect(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'portal_v2_%'").first("n")).toBe(0);
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { kind: "all" }, { source: "bad-source" }, { source: "" }, { q: "x".repeat(201) }, { q: "bad\0query" }, { cursor: "" }, { cursor: "not-a-cursor" }])
    ("rejects invalid search input %j", async options => {
      await expect(listClientHubRoots(env, staff, options)).rejects.toMatchObject({ status: 400 });
    });

  it("distinguishes unfinished backfill from empty ready results and unknown clients", async () => {
    await db.prepare("UPDATE client_hub_directory_state SET ready=0").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 503 });
    await expect(findClientHubRoot(env, "organization", "missing")).rejects.toMatchObject({ status: 503 });
    await db.prepare("UPDATE client_hub_directory_state SET ready=1").run();
    expect(await listClientHubRoots(env, staff)).toMatchObject({ clients: [], nextCursor: null });
    await expect(findClientHubRoot(env, "organization", "missing")).rejects.toMatchObject({ status: 404 });
  });
});
