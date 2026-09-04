import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import projectionMigration from "../migrations/0125_project_alpha_portal_projection.sql?raw";
import relationMigration from "../migrations/0129_portal_hierarchy_relations.sql?raw";
import bridgeMigration from "../migrations/0132_portal_v2_legacy_member_bridges.sql?raw";
import eligibilityMigration from "../migrations/0145_portal_identity_eligibility.sql?raw";
import sourceMigration from "../migrations/0158_portal_source_ownership.sql?raw";
import contactAssignmentMigration from "../migrations/0190_portal_contact_assignments_v4.sql?raw";
import wireContractClaimMigration from "../migrations/0191_portal_projection_wire_contract_claim.sql?raw";
import billingIndependenceMigration from "../migrations/0192_contact_assignment_billing_independence.sql?raw";
import relationFixture from "../../../packages/shared/fixtures/project-alpha-portal-relations-v3.json";
import contactAssignmentFixture from "../../../packages/shared/fixtures/project-alpha-portal-contact-assignments-v4.json";
import { handleProjectAlphaPortalProjectionRequest, parsePortalProjectionDelivery } from "../src/worker/project-alpha-portal";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const applicationKey = "field_operations_portal";
const secret = "contact-assignment-test-secret-at-least-thirty-two-bytes";
const keyId = "contact-assignment-v4-test";
const workspace = { publicId: "pa-workspace-contacts-local", rootType: "organization", rootPublicId: "pa-org-contacts-local", displayName: "Contact Roles Inc", sourceVersion: "workspace-v1", active: true } as const;
const entities = [
  { type: "organization", publicId: "pa-org-contacts-local", parentPublicId: null, displayName: "Contact Roles Inc", sourceVersion: "org-v1", active: true, primaryContact: false },
  { type: "department", publicId: "pa-dept-field", parentPublicId: "pa-org-contacts-local", displayName: "Field", sourceVersion: "dept-v1", active: true, primaryContact: false },
  { type: "client", publicId: "pa-client-alex", parentPublicId: "pa-org-contacts-local", displayName: "Alex", sourceVersion: "client-v1", active: true, primaryContact: false },
  { type: "project", publicId: "pa-project-north", parentPublicId: "pa-dept-field", displayName: "North", sourceVersion: "project-v1", active: true, primaryContact: false },
  { type: "contact", publicId: "pa-contact-alex", parentPublicId: "pa-dept-field", displayName: "Alex", sourceVersion: "contact-v1", active: true, primaryContact: true },
] as const;
const relations = [
  { publicId: "relation-org-dept", relationType: "contains", from: { type: "organization", publicId: "pa-org-contacts-local" }, to: { type: "department", publicId: "pa-dept-field" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-org-client", relationType: "contains", from: { type: "organization", publicId: "pa-org-contacts-local" }, to: { type: "client", publicId: "pa-client-alex" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-dept-project", relationType: "contains", from: { type: "department", publicId: "pa-dept-field" }, to: { type: "project", publicId: "pa-project-north" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-client-project", relationType: "contains", from: { type: "client", publicId: "pa-client-alex" }, to: { type: "project", publicId: "pa-project-north" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-dept-contact", relationType: "contact_assignment", from: { type: "department", publicId: "pa-dept-field" }, to: { type: "contact", publicId: "pa-contact-alex" }, sourceVersion: "r-v1", active: true },
] as const;
const assignments = [
  { publicId: "assignment-department-alex", contactPublicId: "pa-contact-alex", clientPublicId: "pa-client-alex", scopeType: "department", scopePublicId: "pa-dept-field", role: "athletic_director", primary: true, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false, sourceVersion: "assignment-v1", active: true },
  { publicId: "assignment-project-alex", contactPublicId: "pa-contact-alex", clientPublicId: "pa-client-alex", scopeType: "project", scopePublicId: "pa-project-north", role: "billing_contact", primary: false, primaryBilling: true, sendProjectInvoices: false, canViewInvoiceLinks: true, sourceVersion: "assignment-v1", active: true },
] as const;

function envelope(kind: string, deliveryId: string, sourceSequence: number, extra: Record<string, unknown>) {
  return { schemaVersion: 4, applicationKey, deliveryId, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration: "contact-generation", sourceSequence, workspaceId: workspace.publicId, kind, ...extra };
}

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function bodyHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(body: string, timestamp: string, deliveryId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\nPOST\n/api/internal/project-alpha/portal-v2\n${keyId}\n${deliveryId}\n${body}`));
  return `sha256=${[...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Project Alpha schema v4 informational contact assignments", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "pa-contact-assignments-v4" } });
    db = await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),last_seen_at TEXT,UNIQUE(issuer,subject),UNIQUE(id,account_id));
      CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER DEFAULT 0,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await migrate(db, hierarchyMigration);
    await migrate(db, projectionMigration);
    await migrate(db, relationMigration);
    await migrate(db, eligibilityMigration);
    await db.exec("ALTER TABLE client_account_members ADD COLUMN can_view_billing INTEGER DEFAULT 0; ALTER TABLE client_member_project_grants ADD COLUMN granted_by_identity_id TEXT;");
    await migrate(db, bridgeMigration);
    await migrate(db, sourceMigration);
    await migrate(db, contactAssignmentMigration);
    await db.batch([
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES ('wire-backfill-v3','project-alpha:primary','wire-backfill-v3')"),
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES ('wire-backfill-v4','project-alpha:primary','wire-backfill-v4')"),
    ]);
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
         workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,projection_source_id)
        VALUES ('wire-backfill-generation-v3','wire-backfill-v3','wire-backfill-source-v3',1,?,1,1,'standalone_client',
          'wire-backfill-client-v3','Backfill v3','v1',1,'staging','project-alpha:primary')`).bind("1".repeat(64)),
      db.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
         workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,projection_source_id)
        VALUES ('wire-backfill-generation-v4','wire-backfill-v4','wire-backfill-source-v4',1,?,1,1,'standalone_client',
          'wire-backfill-client-v4','Backfill v4','v1',1,'staging','project-alpha:primary')`).bind("2".repeat(64)),
    ]);
    await db.batch([
      db.prepare("INSERT INTO pa_portal_projection_generation_contracts(generation_id,schema_version) VALUES ('wire-backfill-generation-v3',3)"),
      db.prepare("INSERT INTO pa_portal_projection_generation_contracts(generation_id,schema_version) VALUES ('wire-backfill-generation-v4',3)"),
      db.prepare("INSERT INTO pa_portal_projection_contact_assignment_contracts(generation_id,schema_version) VALUES ('wire-backfill-generation-v4',4)"),
    ]);
    await migrate(db, wireContractClaimMigration);
    await db.prepare(`INSERT INTO pa_portal_projection_contact_assignments
      (generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
       primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES('wire-backfill-generation-v4','wire-legacy-assignment','wire-contact','wire-client','project','wire-project',
        'billing_contact',0,1,1,1,'legacy-v1',1)`).run();
    await migrate(db, billingIndependenceMigration);
    env = { DELIVERY_DB: db, PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey, PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId, PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret, PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://access.example.test", PROJECT_ALPHA_PORTAL_ACCESS_AUD: "portal-aud", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" } as Env;
  }, 30_000);

  afterAll(async () => mf.dispose());

  async function deliver(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    return handleProjectAlphaPortalProjectionRequest(new Request("https://client.test/api/internal/project-alpha/portal-v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Portal-Integration-Application-Key": applicationKey,
        "X-Portal-Integration-Timestamp": timestamp, "X-Portal-Integration-Body-SHA256": await bodyHash(body),
        "X-Portal-Integration-Key-Id": keyId, "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
        "X-Portal-Integration-Signature": await signature(body, timestamp, String(payload.deliveryId)),
      },
      body,
    }), env, async () => undefined);
  }

  it("backfills one authoritative wire contract from the compatibility markers", async () => {
    const rows = await db.prepare(`SELECT id,wire_schema_version FROM pa_portal_projection_generations
      WHERE id IN ('wire-backfill-generation-v3','wire-backfill-generation-v4') ORDER BY id`).all();
    expect(rows.results).toEqual([
      { id: "wire-backfill-generation-v3", wire_schema_version: 3 },
      { id: "wire-backfill-generation-v4", wire_schema_version: 4 },
    ]);
    expect(await db.prepare(`SELECT primary_billing,send_project_invoices FROM pa_portal_projection_contact_assignments
      WHERE generation_id='wire-backfill-generation-v4' AND public_id='wire-legacy-assignment'`).first()).toEqual({
        primary_billing: 1,
        send_project_invoices: 1,
      });
    await db.prepare(`UPDATE pa_portal_projection_contact_assignments SET send_project_invoices=0
      WHERE generation_id='wire-backfill-generation-v4' AND public_id='wire-legacy-assignment'`).run();
    expect(await db.prepare(`SELECT primary_billing,send_project_invoices FROM pa_portal_projection_contact_assignments
      WHERE generation_id='wire-backfill-generation-v4' AND public_id='wire-legacy-assignment'`).first()).toEqual({
        primary_billing: 1,
        send_project_invoices: 0,
      });
    await expect(db.prepare(`UPDATE pa_portal_projection_contact_assignments SET primary_contact=1
      WHERE generation_id='wire-backfill-generation-v4' AND public_id='wire-legacy-assignment'`).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE pa_portal_projection_generations SET wire_schema_version=3
      WHERE id='wire-backfill-generation-v4'`).run()).rejects.toThrow("portal projection wire contract is immutable");
    await expect(db.prepare(`UPDATE pa_portal_projection_generation_contracts SET schema_version=2
      WHERE generation_id='wire-backfill-generation-v4'`).run()).rejects.toThrow("portal projection base contract is immutable");
    await expect(db.prepare(`DELETE FROM pa_portal_projection_generation_contracts
      WHERE generation_id='wire-backfill-generation-v4'`).run()).rejects.toThrow("portal projection base contract is immutable");
    await expect(db.prepare(`UPDATE pa_portal_projection_contact_assignment_contracts SET schema_version=3
      WHERE generation_id='wire-backfill-generation-v4'`).run()).rejects.toThrow("portal projection contact contract is immutable");
    await expect(db.prepare(`DELETE FROM pa_portal_projection_contact_assignment_contracts
      WHERE generation_id='wire-backfill-generation-v4'`).run()).rejects.toThrow("portal projection contact contract is immutable");

    await db.prepare("DELETE FROM pa_portal_projection_generations WHERE id='wire-backfill-generation-v4'").run();
    expect(await db.prepare("SELECT count(*) count FROM pa_portal_projection_generation_contracts WHERE generation_id='wire-backfill-generation-v4'").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM pa_portal_projection_contact_assignment_contracts WHERE generation_id='wire-backfill-generation-v4'").first("count")).toBe(0);
  });

  it("preserves v2/v3 and strictly validates v4 without accepting recipient email data", () => {
    expect(parsePortalProjectionDelivery(relationFixture.valid.snapshotPage, applicationKey, true).schemaVersion).toBe(3);
    const page = envelope("snapshot.page", "contact-page-parser", 1, { snapshotHash: "a".repeat(64), pageNumber: 1, pageCount: 1, recordCount: 13, workspace, entities, principals: [], entitlements: [], relations, projectLifecycles: [{ projectPublicId: "pa-project-north", status: "active", completedAt: null, sourceVersion: "project-v1" }], contactAssignments: assignments });
    expect(() => parsePortalProjectionDelivery(page, applicationKey)).toThrow("portal-envelope-invalid");
    const parsedPage = parsePortalProjectionDelivery(page, applicationKey, true);
    expect(parsedPage.schemaVersion).toBe(4);
    if (parsedPage.kind !== "snapshot.page") throw new Error("fixture-shape");
    expect(parsedPage.contactAssignments[1]).toMatchObject({ primaryBilling: true, sendProjectInvoices: false });
    const withEmail = { ...page, contactAssignments: [{ ...assignments[0], email: "private@example.test" }, assignments[1]] };
    expect(() => parsePortalProjectionDelivery(withEmail, applicationKey, true)).toThrow("portal-contact-assignment-fields-invalid");
    const wrongBillingScope = { ...page, contactAssignments: [{ ...assignments[0], sendProjectInvoices: true }, assignments[1]] };
    expect(() => parsePortalProjectionDelivery(wrongBillingScope, applicationKey, true)).toThrow("portal-contact-assignment-billing-scope-invalid");
  });

  it("pins and activates the complete shared v4 contract without treating primary billing as invoice delivery", async () => {
    expect(contactAssignmentFixture).toMatchObject({
      contract: "ltds-project-alpha-portal-contact-assignments-v4",
      schemaVersion: 4,
      endpoint: "/api/internal/project-alpha/portal-v2",
      expectedSnapshotHash: "fa787865c479b1cbdfaba7361d9dd15e8fa9f7d9ffcdad25fa232e1004f71cfa",
    });
    expect(contactAssignmentFixture.valid.snapshotPage.applicationKey).toBe(applicationKey);
    for (const delivery of Object.values(contactAssignmentFixture.valid))
      expect(parsePortalProjectionDelivery(delivery, applicationKey, true)).toBeTruthy();
    const v4Disabled = contactAssignmentFixture.invalid.find(specimen => specimen.name === "v4-disabled")!;
    const projectPrimaryInvalid = contactAssignmentFixture.invalid.find(specimen => specimen.name === "project-primary-invalid")!;
    const departmentBillingInvalid = contactAssignmentFixture.invalid.find(specimen => specimen.name === "billing-flags-on-department")!;
    const missingContactEndpoint = contactAssignmentFixture.invalid.find(specimen => specimen.name === "missing-contact-endpoint")!;
    expect(() => parsePortalProjectionDelivery(v4Disabled.delivery, applicationKey, false)).toThrow("portal-envelope-invalid");
    expect(() => parsePortalProjectionDelivery(projectPrimaryInvalid.delivery, applicationKey, true)).toThrow("portal-contact-assignment-primary-scope-invalid");
    expect(() => parsePortalProjectionDelivery(departmentBillingInvalid.delivery, applicationKey, true)).toThrow("portal-contact-assignment-billing-scope-invalid");
    expect(parsePortalProjectionDelivery(missingContactEndpoint.delivery, applicationKey, true)).toBeTruthy();
    const tableDefinitions = await db.prepare(`SELECT name,sql FROM sqlite_master
      WHERE type='table' AND name IN ('pa_portal_projection_contact_assignments','portal_v2_contact_assignments')
      ORDER BY name`).all<{ name: string; sql: string }>();
    expect(tableDefinitions.results).toHaveLength(2);
    for (const table of tableDefinitions.results) {
      expect(table.sql).toContain("scope_type<>'project' OR primary_contact=0");
      expect(table.sql).toContain("scope_type='project' OR (primary_billing=0 AND send_project_invoices=0 AND can_view_invoice_links=0)");
      expect(table.sql).not.toContain("primary_billing=0 OR send_project_invoices=1");
    }

    const page = contactAssignmentFixture.valid.snapshotPage;
    const projectAssignment = page.contactAssignments[0]!;
    expect((await deliver(page)).status).toBe(200);
    expect((await deliver(contactAssignmentFixture.valid.snapshotActivate)).status).toBe(200);
    const selectedGeneration = await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?")
      .bind(page.workspaceId).first<string>("active_generation_id");
    const stagedGeneration = await db.prepare("SELECT id FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation=?")
      .bind(page.workspaceId, page.sourceGeneration).first<string>("id");
    expect(await db.prepare(`SELECT primary_billing,send_project_invoices,can_view_invoice_links
      FROM portal_v2_contact_assignments WHERE workspace_id=? AND generation_id=? AND public_id=?`)
      .bind(page.workspaceId, selectedGeneration, projectAssignment.publicId).first()).toEqual({
        primary_billing: 1,
        send_project_invoices: 0,
        can_view_invoice_links: 1,
      });

    await expect(db.prepare(`INSERT INTO pa_portal_projection_contact_assignments
      (generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
       primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES(?,? ,?,?,'organization',?,'billing_contact',0,1,0,0,'invalid',1)`)
      .bind(stagedGeneration, "pa-invalid-staged-non-project-billing", "pa-contact-manager", "pa-client-manager", "pa-org-contacts").run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO pa_portal_projection_contact_assignments
      (generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
       primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES(?,?,?,?,'project',?,'project_contact',1,0,0,0,'invalid',1)`)
      .bind(stagedGeneration, "pa-invalid-staged-project-primary", "pa-contact-manager", "pa-client-manager", "pa-project-north").run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE pa_portal_projection_contact_assignments SET primary_contact=1
      WHERE generation_id=? AND public_id=?`).bind(stagedGeneration, projectAssignment.publicId).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_v2_contact_assignments
      (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
       primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES(?,?,?, ?,?,'client',?,'billing_contact',0,0,1,0,'invalid',1)`)
      .bind(page.workspaceId, selectedGeneration, "pa-invalid-selected-non-project-invoices", "pa-contact-manager", "pa-client-manager", "pa-client-manager").run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_v2_contact_assignments
      (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,
       primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES(?,?,?,?,?,'project',?,'project_contact',1,0,0,0,'invalid',1)`)
      .bind(page.workspaceId, selectedGeneration, "pa-invalid-selected-project-primary", "pa-contact-manager", "pa-client-manager", "pa-project-north").run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE portal_v2_contact_assignments SET primary_contact=1
      WHERE workspace_id=? AND generation_id=? AND public_id=?`)
      .bind(page.workspaceId, selectedGeneration, projectAssignment.publicId).run()).rejects.toThrow();

    expect((await deliver(contactAssignmentFixture.valid.roleUpdateEvent)).status).toBe(200);
    expect(await db.prepare(`SELECT role,primary_billing,send_project_invoices FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id
        AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.workspace_id=? AND assignment.public_id=?`)
      .bind(page.workspaceId, projectAssignment.publicId).first()).toEqual({
        role: "project_liaison",
        primary_billing: 1,
        send_project_invoices: 0,
      });
    expect((await deliver(contactAssignmentFixture.valid.assignmentTombstone)).status).toBe(200);
    expect(await db.prepare(`SELECT assignment.active FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id
        AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.workspace_id=? AND assignment.public_id=?`)
      .bind(page.workspaceId, projectAssignment.publicId).first("active")).toBe(0);
    const relationTombstoneResponse = await deliver(contactAssignmentFixture.valid.relationTombstone);
    expect(relationTombstoneResponse.status, await relationTombstoneResponse.clone().text()).toBe(200);
    expect((await deliver(contactAssignmentFixture.valid.contactTombstone)).status).toBe(200);
    expect(await db.prepare(`SELECT entity.active FROM portal_v2_directory_entities entity
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=entity.workspace_id
        AND checkpoint.active_generation_id=entity.generation_id
      WHERE entity.workspace_id=? AND entity.public_id='pa-contact-manager'`)
      .bind(page.workspaceId).first("active")).toBe(0);

    const missingEndpoint = {
      ...missingContactEndpoint.delivery,
      deliveryId: "contact-assignment-missing-endpoint-page-receiver",
      sourceGeneration: "contact-assignment-missing-endpoint-generation",
    };
    expect((await deliver(missingEndpoint)).status).toBe(200);
    const invalidActivation = {
      schemaVersion: 4, applicationKey, deliveryId: "contact-assignment-missing-endpoint-activate",
      occurredAt: missingEndpoint.occurredAt, sourceGeneration: missingEndpoint.sourceGeneration,
      sourceSequence: missingEndpoint.sourceSequence, workspaceId: missingEndpoint.workspaceId,
      kind: "snapshot.activate", snapshotHash: missingEndpoint.snapshotHash,
      pageCount: missingEndpoint.pageCount, recordCount: missingEndpoint.recordCount,
    };
    const invalidActivationResponse = await deliver(invalidActivation);
    expect(invalidActivationResponse.status, await invalidActivationResponse.clone().text()).toBe(422);
    expect(await invalidActivationResponse.json()).toMatchObject({ error: "portal-root-invalid" });
  });

  it("rejects v3/v4 contract mixing in either direction within a multipage generation", async () => {
    const multipage = (schemaVersion: 3 | 4, sourceGeneration: string, deliveryId: string, pageNumber: number, sourceSequence: number) => ({
      schemaVersion, applicationKey, deliveryId, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration, sourceSequence,
      workspaceId: workspace.publicId, kind: "snapshot.page", snapshotHash: sourceGeneration === "mixed-v3-v4" ? "c".repeat(64) : "d".repeat(64),
      pageNumber, pageCount: 2, recordCount: 1, workspace, entities: [], principals: [], entitlements: [], relations: [], projectLifecycles: [],
      ...(schemaVersion === 4 ? { contactAssignments: [] } : {}),
    });

    expect((await deliver(multipage(3, "mixed-v3-v4", "mixed-v3-first", 1, 10))).status).toBe(200);
    const v4AfterV3 = await deliver(multipage(4, "mixed-v3-v4", "mixed-v4-second", 2, 10));
    expect(v4AfterV3.status).toBe(409);
    expect(await v4AfterV3.json()).toMatchObject({ error: "portal-generation-contract-conflict" });

    expect((await deliver(multipage(4, "mixed-v4-v3", "mixed-v4-first", 1, 11))).status).toBe(200);
    const v3AfterV4 = await deliver(multipage(3, "mixed-v4-v3", "mixed-v3-second", 2, 11));
    expect(v3AfterV4.status).toBe(409);
    expect(await v3AfterV4.json()).toMatchObject({ error: "portal-generation-contract-conflict" });
  });

  it("atomically claims concurrent first-page contracts and keeps same-schema retries safe", async () => {
    const firstPage = (schemaVersion: 3 | 4, sourceGeneration: string, deliveryId: string, sourceSequence: number) => ({
      schemaVersion, applicationKey, deliveryId, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration, sourceSequence,
      workspaceId: workspace.publicId, kind: "snapshot.page", snapshotHash: sourceGeneration === "concurrent-mixed" ? "e".repeat(64) : "f".repeat(64),
      pageNumber: 1, pageCount: 2, recordCount: 1, workspace, entities: [], principals: [], entitlements: [], relations: [], projectLifecycles: [],
      ...(schemaVersion === 4 ? { contactAssignments: [] } : {}),
    });

    const mixed = await Promise.all([
      deliver(firstPage(3, "concurrent-mixed", "concurrent-v3", 12)),
      deliver(firstPage(4, "concurrent-mixed", "concurrent-v4", 12)),
    ]);
    expect(mixed.map(response => response.status).sort()).toEqual([200, 409]);
    const mixedGeneration = await db.prepare("SELECT id FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation='concurrent-mixed'").bind(workspace.publicId).first<string>("id");
    expect(await db.prepare("SELECT count(*) count FROM pa_portal_projection_pages WHERE generation_id=?").bind(mixedGeneration).first("count")).toBe(1);
    const markerCount = await db.prepare("SELECT count(*) count FROM pa_portal_projection_contact_assignment_contracts WHERE generation_id=?").bind(mixedGeneration).first<number>("count");
    const winningWireSchema = mixed[1]!.status === 200 ? 4 : 3;
    expect(await db.prepare("SELECT wire_schema_version FROM pa_portal_projection_generations WHERE id=?").bind(mixedGeneration).first("wire_schema_version")).toBe(winningWireSchema);
    expect(markerCount).toBe(winningWireSchema === 4 ? 1 : 0);

    const retry = firstPage(4, "concurrent-same-v4", "concurrent-v4-retry", 13);
    const sameSchema = await Promise.all([deliver(retry), deliver(retry)]);
    const sameSchemaResults = await Promise.all(sameSchema.map(async response => ({ status: response.status, body: await response.clone().json() })));
    expect(sameSchemaResults.map(result => result.status), JSON.stringify(sameSchemaResults)).toEqual([200, 200]);
    const retryGeneration = await db.prepare("SELECT id FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation='concurrent-same-v4'").bind(workspace.publicId).first<string>("id");
    expect(await db.prepare("SELECT count(*) count FROM pa_portal_projection_pages WHERE generation_id=?").bind(retryGeneration).first("count")).toBe(1);
    expect(await db.prepare("SELECT wire_schema_version FROM pa_portal_projection_generations WHERE id=?").bind(retryGeneration).first("wire_schema_version")).toBe(4);
  });

  it("rejects activation envelopes that do not exactly match the staged extension contract", async () => {
    const completePage = (schemaVersion: 3 | 4, sourceGeneration: string, deliveryId: string, sourceSequence: number) => ({
      schemaVersion, applicationKey, deliveryId, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration, sourceSequence,
      workspaceId: workspace.publicId, kind: "snapshot.page", snapshotHash: sourceGeneration === "activate-v4-as-v3" ? "7".repeat(64) : "8".repeat(64),
      pageNumber: 1, pageCount: 1, recordCount: 11, workspace, entities, principals: [], entitlements: [], relations,
      projectLifecycles: [{ projectPublicId: "pa-project-north", status: "active", completedAt: null, sourceVersion: "project-v1" }],
      ...(schemaVersion === 4 ? { contactAssignments: [] } : {}),
    });
    const activate = (schemaVersion: 3 | 4, sourceGeneration: string, deliveryId: string, sourceSequence: number) => ({
      schemaVersion, applicationKey, deliveryId, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration, sourceSequence,
      workspaceId: workspace.publicId, kind: "snapshot.activate", snapshotHash: sourceGeneration === "activate-v4-as-v3" ? "7".repeat(64) : "8".repeat(64),
      pageCount: 1, recordCount: 11,
    });

    expect((await deliver(completePage(4, "activate-v4-as-v3", "activate-v4-page", 14))).status).toBe(200);
    const v4AsV3 = await deliver(activate(3, "activate-v4-as-v3", "activate-v4-with-v3-envelope", 14));
    expect(v4AsV3.status).toBe(409);
    expect(await v4AsV3.json()).toMatchObject({ error: "portal-generation-contract-conflict" });

    expect((await deliver(completePage(3, "activate-v3-as-v4", "activate-v3-page", 15))).status).toBe(200);
    const v3AsV4 = await deliver(activate(4, "activate-v3-as-v4", "activate-v3-with-v4-envelope", 15));
    expect(v3AsV4.status).toBe(409);
    expect(await v3AsV4.json()).toMatchObject({ error: "portal-generation-contract-conflict" });
  });

  it("stages then atomically selects distinct per-scope roles without creating authority", async () => {
    const page = envelope("snapshot.page", "contact-page", 1, { snapshotHash: "a".repeat(64), pageNumber: 1, pageCount: 1, recordCount: 13, workspace, entities, principals: [], entitlements: [], relations, projectLifecycles: [{ projectPublicId: "pa-project-north", status: "active", completedAt: null, sourceVersion: "project-v1" }], contactAssignments: assignments });
    expect((await deliver(page)).status).toBe(200);
    expect(await db.prepare(`SELECT count(*) count FROM pa_portal_projection_contact_assignments assignment
      JOIN pa_portal_projection_generations generation ON generation.id=assignment.generation_id
      WHERE generation.workspace_id=? AND generation.source_generation=?`)
      .bind(workspace.publicId, page.sourceGeneration).first("count")).toBe(2);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_contact_assignments WHERE workspace_id=?")
      .bind(workspace.publicId).first("count")).toBe(0);
    const activate = envelope("snapshot.activate", "contact-activate", 1, { snapshotHash: "a".repeat(64), pageCount: 1, recordCount: 13 });
    const activationResponse = await deliver(activate);
    expect(activationResponse.status, await activationResponse.text()).toBe(200);
    const rows = await db.prepare(`SELECT scope_type,role,primary_contact,primary_billing,send_project_invoices,can_view_invoice_links
      FROM portal_v2_contact_assignments WHERE workspace_id=? ORDER BY scope_type`).bind(workspace.publicId).all();
    expect(rows.results).toEqual([
      { scope_type: "department", role: "athletic_director", primary_contact: 1, primary_billing: 0, send_project_invoices: 0, can_view_invoice_links: 0 },
      { scope_type: "project", role: "billing_contact", primary_contact: 0, primary_billing: 1, send_project_invoices: 0, can_view_invoice_links: 1 },
    ]);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
    expect(await db.prepare(`SELECT base.schema_version FROM portal_v2_directory_generation_contracts base
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.active_generation_id=base.generation_id AND checkpoint.workspace_id=base.workspace_id
      WHERE checkpoint.workspace_id=?`).bind(workspace.publicId).first("schema_version")).toBe(3);
    expect(await db.prepare(`SELECT extension.schema_version FROM portal_v2_contact_assignment_contracts extension
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.active_generation_id=extension.generation_id AND checkpoint.workspace_id=extension.workspace_id
      WHERE checkpoint.workspace_id=?`).bind(workspace.publicId).first("schema_version")).toBe(4);
    const columns = await db.prepare("PRAGMA table_info(portal_v2_contact_assignments)").all<{ name: string }>();
    expect(columns.results.map(column => column.name)).not.toContain("email");
  });

  it("keeps a standalone-client assignment active when an unrelated contact is tombstoned", async () => {
    const standaloneWorkspace = { publicId: "pa-workspace-standalone", rootType: "standalone_client", rootPublicId: "pa-client-standalone", displayName: "Standalone Client", sourceVersion: "workspace-v1", active: true } as const;
    const standaloneEntities = [
      { type: "standalone_client", publicId: "pa-client-standalone", parentPublicId: null, displayName: "Standalone Client", sourceVersion: "client-v1", active: true, primaryContact: false },
      { type: "contact", publicId: "pa-contact-standalone", parentPublicId: "pa-client-standalone", displayName: "Owner", sourceVersion: "contact-v1", active: true, primaryContact: true },
      { type: "contact", publicId: "pa-contact-unrelated", parentPublicId: "pa-client-standalone", displayName: "Estimator", sourceVersion: "contact-v1", active: true, primaryContact: false },
    ];
    const common = { schemaVersion: 4, applicationKey, occurredAt: "2026-09-02T18:00:00.000Z", sourceGeneration: "standalone-generation", sourceSequence: 1, workspaceId: standaloneWorkspace.publicId };
    const standaloneAssignments = [
      { publicId: "assignment-standalone", contactPublicId: "pa-contact-standalone", clientPublicId: "pa-client-standalone", scopeType: "standalone_client", scopePublicId: "pa-client-standalone", role: "owner", primary: true, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false, sourceVersion: "assignment-v1", active: true },
      { publicId: "assignment-unrelated", contactPublicId: "pa-contact-unrelated", clientPublicId: "pa-client-standalone", scopeType: "standalone_client", scopePublicId: "pa-client-standalone", role: "estimator", primary: false, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false, sourceVersion: "assignment-v1", active: true },
    ];
    const page = { ...common, deliveryId: "standalone-page", kind: "snapshot.page", snapshotHash: "b".repeat(64), pageNumber: 1, pageCount: 1, recordCount: 7, workspace: standaloneWorkspace, entities: standaloneEntities, principals: [], entitlements: [], relations: [
      { publicId: "relation-standalone-contact", relationType: "contact_assignment", from: { type: "standalone_client", publicId: "pa-client-standalone" }, to: { type: "contact", publicId: "pa-contact-standalone" }, sourceVersion: "r-v1", active: true },
      { publicId: "relation-standalone-unrelated", relationType: "contact_assignment", from: { type: "standalone_client", publicId: "pa-client-standalone" }, to: { type: "contact", publicId: "pa-contact-unrelated" }, sourceVersion: "r-v1", active: true },
    ], projectLifecycles: [], contactAssignments: standaloneAssignments };
    expect((await deliver(page)).status).toBe(200);
    const activate = { ...common, deliveryId: "standalone-activate", kind: "snapshot.activate", snapshotHash: "b".repeat(64), pageCount: 1, recordCount: 7 };
    expect((await deliver(activate)).status).toBe(200);
    const tombstone = { ...common, deliveryId: "standalone-unrelated-tombstone", sourceSequence: 2, kind: "event", event: { resource: "entity", action: "tombstone", publicId: "pa-contact-unrelated", sourceVersion: "contact-v2" } };
    const tombstoneResponse = await deliver(tombstone);
    expect(tombstoneResponse.status, await tombstoneResponse.text()).toBe(200);
    const selected = await db.prepare(`SELECT assignment.public_id,assignment.active FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.workspace_id=? ORDER BY assignment.public_id`).bind(standaloneWorkspace.publicId).all();
    expect(selected.results).toEqual([
      { public_id: "assignment-standalone", active: 1 },
      { public_id: "assignment-unrelated", active: 0 },
    ]);
  });

  it("applies ordered assignment updates and tombstones in the selected generation only", async () => {
    const update = envelope("event", "contact-update", 2, { event: { resource: "contact_assignment", action: "upsert", contactAssignment: { ...assignments[1], role: "project_contact", primary: false, primaryBilling: false, sourceVersion: "assignment-v2" } } });
    const updateResponse = await deliver(update);
    expect(updateResponse.status, await updateResponse.text()).toBe(200);
    expect(await db.prepare(`SELECT role FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.public_id='assignment-project-alex'`).first("role")).toBe("project_contact");
    const tombstone = envelope("event", "contact-tombstone", 3, { event: { resource: "contact_assignment", action: "tombstone", publicId: "assignment-department-alex", sourceVersion: "assignment-v3" } });
    expect((await deliver(tombstone)).status).toBe(200);
    const selected = await db.prepare(`SELECT public_id,active FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.workspace_id=? ORDER BY public_id`).bind(workspace.publicId).all();
    expect(selected.results).toEqual([{ public_id: "assignment-department-alex", active: 0 }, { public_id: "assignment-project-alex", active: 1 }]);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
  });

  it("fences selected assignments to their workspace, generation, schema, and entity endpoints", async () => {
    const generation = await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first<string>("active_generation_id");
    await expect(db.prepare(`INSERT INTO portal_v2_contact_assignments
      (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version)
      VALUES('other-workspace',?,'assignment-cross-workspace','pa-contact-alex','pa-client-alex','department','pa-dept-field','contact',0,0,0,0,'bad')`).bind(generation).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_v2_contact_assignments
      (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version)
      VALUES(?,?,'assignment-missing-contact','missing-contact','pa-client-alex','department','pa-dept-field','contact',0,0,0,0,'bad')`).bind(workspace.publicId, generation).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_v2_contact_assignments
      (workspace_id,generation_id,public_id,contact_public_id,client_public_id,scope_type,scope_public_id,role,primary_contact,primary_billing,send_project_invoices,can_view_invoice_links,source_version,active)
      VALUES(?,?,'assignment-inactive-missing','missing-contact','pa-client-alex','department','pa-dept-field','contact',0,0,0,0,'bad',0)`).bind(workspace.publicId, generation).run()).rejects.toThrow();
  });
});
