import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import projectionMigration from "../migrations/0125_project_alpha_portal_projection.sql?raw";
import relationMigration from "../migrations/0129_portal_hierarchy_relations.sql?raw";
import eligibilityMigration from "../migrations/0145_portal_identity_eligibility.sql?raw";
import bridgeMigration from "../migrations/0132_portal_v2_legacy_member_bridges.sql?raw";
import sourceMigration from "../migrations/0158_portal_source_ownership.sql?raw";
import contactAssignmentMigration from "../migrations/0190_portal_contact_assignments_v4.sql?raw";
import wireContractClaimMigration from "../migrations/0191_portal_projection_wire_contract_claim.sql?raw";
import billingIndependenceMigration from "../migrations/0192_contact_assignment_billing_independence.sql?raw";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { authorizePortalWorkspaceCapability } from "../src/worker/client-portal/workspace-v2";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import { applyPortalProjectionDelivery, handleProjectAlphaPortalProjectionRequest, parsePortalProjectionDelivery } from "../src/worker/project-alpha-portal";
import { createCatalogSourceContext } from "@ltds/shared";
import type { Env } from "../src/worker/types";
import relationFixture from "../../../packages/shared/fixtures/project-alpha-portal-relations-v3.json";
import portalV2Fixture from "../../../packages/shared/fixtures/project-alpha-portal-v2.json";

const applicationKey = "field_operations_portal";
const secret = "relations-test-secret-at-least-thirty-two-bytes";
const keyId = "relations-test-v1";
const snapshotHash = "d".repeat(64);
const principal: VerifiedClientPrincipal = { issuer: "https://access.example.test", subject: "manager-subject", email: "manager@example.test" };
const workspace = { publicId: "pa-workspace-relations", rootType: "organization", rootPublicId: "pa-org-relations", displayName: "Relations Inc", sourceVersion: "workspace-v1", active: true } as const;

const entities = [
  { type: "organization", publicId: "pa-org-relations", parentPublicId: null, displayName: "Relations Inc", sourceVersion: "org-v1", active: true, primaryContact: false },
  { type: "department", publicId: "pa-dept-field", parentPublicId: "pa-org-relations", displayName: "Field", sourceVersion: "dept-v1", active: true, primaryContact: false },
  { type: "client", publicId: "pa-client-owner", parentPublicId: "pa-org-relations", displayName: "Owner", sourceVersion: "client-v1", active: true, primaryContact: false },
  { type: "project", publicId: "pa-project-north", parentPublicId: "pa-dept-field", displayName: "North", sourceVersion: "project-v1", active: true, primaryContact: false },
  { type: "contact", publicId: "pa-contact-manager", parentPublicId: "pa-dept-field", displayName: "Manager", sourceVersion: "contact-v1", active: true, primaryContact: true },
] as const;
const relations = [
  { publicId: "relation-org-dept", relationType: "contains", from: { type: "organization", publicId: "pa-org-relations" }, to: { type: "department", publicId: "pa-dept-field" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-org-client", relationType: "contains", from: { type: "organization", publicId: "pa-org-relations" }, to: { type: "client", publicId: "pa-client-owner" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-dept-project", relationType: "contains", from: { type: "department", publicId: "pa-dept-field" }, to: { type: "project", publicId: "pa-project-north" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-client-project", relationType: "contains", from: { type: "client", publicId: "pa-client-owner" }, to: { type: "project", publicId: "pa-project-north" }, sourceVersion: "r-v1", active: true },
  { publicId: "relation-dept-contact", relationType: "contact_assignment", from: { type: "department", publicId: "pa-dept-field" }, to: { type: "contact", publicId: "pa-contact-manager" }, sourceVersion: "r-v1", active: true },
] as const;
const projectedPrincipal = { publicId: "pa-principal-manager", emailHint: principal.email, displayName: "Manager", sourceVersion: "principal-v1", active: true } as const;
const entitlements = [
  { publicId: "entitlement-workspace", principalPublicId: projectedPrincipal.publicId, capability: "workspace.view", effect: "allow", scopeType: "workspace", scopePublicId: workspace.publicId, sourceVersion: "grant-v1", active: true, validFrom: "2026-08-01T00:00:00.000Z", expiresAt: null },
  { publicId: "entitlement-department", principalPublicId: projectedPrincipal.publicId, capability: "directory.read", effect: "allow", scopeType: "department", scopePublicId: "pa-dept-field", sourceVersion: "grant-v1", active: true, validFrom: "2026-08-01T00:00:00.000Z", expiresAt: null },
] as const;

function envelope(kind: string, id: string, sequence: number, extra: Record<string, unknown>) {
  return { schemaVersion: 3, applicationKey, deliveryId: id, occurredAt: "2026-08-13T18:00:00.000Z", sourceGeneration: "relations-generation", sourceSequence: sequence, workspaceId: workspace.publicId, kind, ...extra };
}

async function migrate(db: D1Database, sql: string): Promise<void> {
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function signature(body: string, timestamp: string, deliveryId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\nPOST\n/api/internal/project-alpha/portal-v2\n${keyId}\n${deliveryId}\n${body}`));
  return `sha256=${[...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function bodyHash(body:string):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));return[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}

function failActiveContractReadOnce(database: D1Database): D1Database {
  let failed = false;
  let proxy: D1Database;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (property === "first" && sql.includes("portal_v2_directory_generation_contracts contract")) return async () => {
        if (!failed) { failed = true; throw new Error("injected-contract-read-failure"); }
        return target.first();
      };
      const value = target[property as keyof D1PreparedStatement];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as D1PreparedStatement;
  proxy = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "withSession") return () => proxy;
      const value = target[property as keyof D1Database];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as D1Database;
  return proxy;
}

describe("Project Alpha relation/lifecycle projection receiver", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "pa-relations-projection" } });
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
    await migrate(db, hierarchyMigration); await migrate(db, projectionMigration); await migrate(db, relationMigration); await migrate(db, eligibilityMigration);
    await db.exec("ALTER TABLE client_account_members ADD COLUMN can_view_billing INTEGER DEFAULT 0; ALTER TABLE client_member_project_grants ADD COLUMN granted_by_identity_id TEXT;");
    await migrate(db, bridgeMigration); await migrate(db, sourceMigration);
    await migrate(db, contactAssignmentMigration); await migrate(db, wireContractClaimMigration);
    await migrate(db, billingIndependenceMigration);
    env = { DELIVERY_DB: db, PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey, PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId, PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret, PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://access.example.test", PROJECT_ALPHA_PORTAL_ACCESS_AUD: "portal-aud", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" } as Env;
  }, 30_000);
  afterAll(async () => mf.dispose());

  async function deliver(payload: Record<string, unknown>, environment: Env = env) {
    const body = JSON.stringify(payload); const timestamp = new Date().toISOString();
    return handleProjectAlphaPortalProjectionRequest(new Request("https://client.test/api/internal/project-alpha/portal-v2", { method: "POST", headers: { "Content-Type": "application/json","X-Portal-Integration-Application-Key":applicationKey,"X-Portal-Integration-Timestamp":timestamp,"X-Portal-Integration-Body-SHA256":await bodyHash(body),"X-Portal-Integration-Key-Id":keyId,"X-Portal-Integration-Delivery-Id":String(payload.deliveryId),"X-Portal-Integration-Signature":await signature(body,timestamp,String(payload.deliveryId)) }, body }), environment, async () => undefined);
  }

  it("keeps schema v3 fail-closed behind the independent relation flag", async () => {
    const page = relationFixture.valid.snapshotPage as Record<string, unknown>;
    expect(() => parsePortalProjectionDelivery(page, applicationKey)).toThrow("portal-envelope-invalid");
    expect(parsePortalProjectionDelivery(page, applicationKey, true).schemaVersion).toBe(3);
    for (const specimen of relationFixture.invalid) {
      expect(() => parsePortalProjectionDelivery(specimen.delivery, applicationKey, true), specimen.name).toThrow(specimen.expectedError);
    }
    expect((await deliver(page, { ...env, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false" })).status).toBe(422);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_generations").first("count")).toBe(0);
  });

  it("stages and atomically activates complete edges and lifecycle without implicit contact grants", async () => {
    const page = relationFixture.valid.snapshotPage as Record<string, unknown>;
    expect((await deliver(page)).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_relations").first("count")).toBe(0);
    expect((await deliver(relationFixture.valid.snapshotActivate as Record<string, unknown>)).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_relations WHERE workspace_id=?").bind(workspace.publicId).first("count")).toBe(5);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_project_lifecycle WHERE lifecycle_status='active'").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
  });

  it("applies ordered lifecycle reopen and relation tombstone events with replay safety", async () => {
    await db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES ('manager',?,?,?,'active')").bind(principal.issuer, principal.subject, principal.email).run();
    await db.prepare("UPDATE pa_portal_principals SET identity_id='manager' WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, projectedPrincipal.publicId).run();
    const completed = relationFixture.valid.lifecycleEvent as Record<string, unknown>;
    expect((await deliver(completed)).status).toBe(200);
    expect((await (await deliver(completed)).json() as { status: string }).status).toBe("duplicate");
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "directory.read", { scopeType: "project", publicId: "pa-project-north" })).toBe(false);
    const reopened = envelope("event", "relations-reopened", 12, { event: { resource: "project_lifecycle", action: "upsert", projectLifecycle: { projectPublicId: "pa-project-north", status: "active", completedAt: null, sourceVersion: "project-v3" } } });
    expect((await deliver(reopened)).status).toBe(200);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "directory.read", { scopeType: "project", publicId: "pa-project-north" })).toBe(true);
    expect(await authorizePortalWorkspaceCapability({ ...env, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false" }, principal, workspace.publicId, "workspace.view", { scopeType: "workspace", publicId: workspace.publicId })).toBe(false);
    const tombstone = relationFixture.valid.relationTombstoneEvent as Record<string, unknown>;
    expect((await deliver(tombstone)).status).toBe(200);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "directory.read", { scopeType: "project", publicId: "pa-project-north" })).toBe(false);
    expect((await deliver(envelope("event", "relations-gap", 15, { event: { resource: "relation", action: "tombstone", publicId: "relation-client-project", sourceVersion: "r-v2" } }))).status).toBe(409);
  }, 20_000);

  it("rejects incomplete lifecycle and malformed relation state before checkpoint cutover", async () => {
    const currentSequence = await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence");
    const incompleteEntities = [entities[0], { ...entities[3], parentPublicId: workspace.rootPublicId }];
    const incompleteRelation = [{ ...relations[2], publicId: "relation-root-project", from: { type: "organization", publicId: workspace.rootPublicId } }];
    const incompletePage = envelope("snapshot.page", "missing-lifecycle-page", 14, { sourceGeneration: "missing-lifecycle-generation", snapshotHash: "e".repeat(64), pageNumber: 1, pageCount: 1, recordCount: 3, workspace, entities: incompleteEntities, principals: [], entitlements: [], relations: incompleteRelation, projectLifecycles: [] });
    expect((await deliver(incompletePage)).status).toBe(200);
    expect((await deliver(envelope("snapshot.activate", "missing-lifecycle-activate", 14, { sourceGeneration: "missing-lifecycle-generation", snapshotHash: "e".repeat(64), pageCount: 1, recordCount: 3 }))).status).toBe(422);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence")).toBe(currentSequence);
    expect(() => parsePortalProjectionDelivery(envelope("event", "bad-lifecycle", 14, { event: { resource: "project_lifecycle", action: "upsert", projectLifecycle: { projectPublicId: "pa-project-north", status: "active", completedAt: "2026-08-13T18:00:00.000Z", sourceVersion: "bad" } } }), applicationKey, true)).toThrow("portal-project-lifecycle-invalid");
    const invalidRelation = envelope("event", "bad-relation", 14, { event: { resource: "relation", action: "upsert", relation: { publicId: "relation-self", relationType: "contains", from: { type: "project", publicId: "pa-project-north" }, to: { type: "project", publicId: "pa-project-north" }, sourceVersion: "bad", active: true } } });
    expect((await deliver(invalidRelation)).status).toBe(422);
    const reversedRelation = envelope("event", "reversed-relation", 14, { event: { resource: "relation", action: "upsert", relation: { publicId: "relation-reversed", relationType: "contains", from: { type: "project", publicId: "pa-project-north" }, to: { type: "department", publicId: "pa-dept-field" }, sourceVersion: "bad", active: true } } });
    expect((await deliver(reversedRelation)).status).toBe(422);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence")).toBe(currentSequence);
    const activeGeneration = await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first<string>("active_generation_id");
    await expect(db.prepare(`INSERT INTO portal_v2_directory_relations
      (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES (?,?,?,'contains','project',?,'department',?,'bad')`)
      .bind(workspace.publicId, activeGeneration, "relation-db-reversed", "pa-project-north", "pa-dept-field").run()).rejects.toThrow();
  });

  it("enforces identical endpoint, direction, and public-id guards for active and staged relation writes", async () => {
    const activeGeneration = await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first<string>("active_generation_id");
    const stagedGeneration = await db.prepare("SELECT snapshot_generation_id FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first<string>("snapshot_generation_id");
    expect(activeGeneration).toBeTruthy();
    expect(stagedGeneration).toBeTruthy();

    await expect(db.prepare(`UPDATE portal_v2_directory_relations
      SET from_type='project',from_public_id='pa-project-north',to_type='department',to_public_id='pa-dept-field'
      WHERE workspace_id=? AND generation_id=? AND public_id='relation-org-dept'`)
      .bind(workspace.publicId, activeGeneration).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE portal_v2_directory_relations SET to_public_id='pa-project-missing'
      WHERE workspace_id=? AND generation_id=? AND public_id='relation-dept-project'`)
      .bind(workspace.publicId, activeGeneration).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_v2_directory_relations
      (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES (?,?,?,'contains','department','pa-dept-field','project','pa-project-missing','bad')`)
      .bind(workspace.publicId, activeGeneration, "relation-active-missing-endpoint").run()).rejects.toThrow();

    await expect(db.prepare(`UPDATE pa_portal_projection_relations
      SET from_type='project',from_public_id='pa-project-north',to_type='department',to_public_id='pa-dept-field'
      WHERE generation_id=? AND public_id='relation-org-dept'`)
      .bind(stagedGeneration).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE pa_portal_projection_relations SET to_public_id='pa-project-missing'
      WHERE generation_id=? AND public_id='relation-dept-project'`)
      .bind(stagedGeneration).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO pa_portal_projection_relations
      (generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
      VALUES (?,?,'contains','department','pa-dept-field','project','pa-project-missing','bad',1)`)
      .bind(stagedGeneration, "relation-staged-missing-endpoint").run()).rejects.toThrow();

    await db.batch([
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES (?,?,'project','pa-dept-field','pa-dept-field','Duplicate ID fixture','test',0)`).bind(workspace.publicId, activeGeneration),
      db.prepare(`INSERT INTO pa_portal_projection_entities
        (generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact)
        VALUES (?,'project','pa-dept-field','pa-dept-field','Duplicate ID fixture','test',0,0)`).bind(stagedGeneration),
    ]);
    try {
      await expect(db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES (?,?,?,'contains','department','pa-dept-field','project','pa-dept-field','bad')`)
        .bind(workspace.publicId, activeGeneration, "relation-active-same-id").run()).rejects.toThrow();
      await expect(db.prepare(`INSERT INTO pa_portal_projection_relations
        (generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,?,'contains','department','pa-dept-field','project','pa-dept-field','bad',1)`)
        .bind(stagedGeneration, "relation-staged-same-id").run()).rejects.toThrow();
    } finally {
      await db.batch([
        db.prepare("DELETE FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND entity_type='project' AND public_id='pa-dept-field'").bind(workspace.publicId, activeGeneration),
        db.prepare("DELETE FROM pa_portal_projection_entities WHERE generation_id=? AND entity_type='project' AND public_id='pa-dept-field'").bind(stagedGeneration),
      ]);
    }
  });

  it("backfills live schema-v2 generations and preserves the next ordered v2 event", async () => {
    const upgradeMf = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "pa-relations-v2-upgrade" } });
    try {
      const upgradeDb = await upgradeMf.getD1Database("DELIVERY_DB") as unknown as D1Database;
      await upgradeDb.exec(`
        CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),last_seen_at TEXT,UNIQUE(issuer,subject),UNIQUE(id,account_id));
        CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(account_id,identity_id));
        CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER DEFAULT 1);
        CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER DEFAULT 0,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
        CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
        CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
      `.replace(/\s*\n\s*/g, " "));
      await migrate(upgradeDb, hierarchyMigration);
      await migrate(upgradeDb, projectionMigration);
      await migrate(upgradeDb, eligibilityMigration);
      await upgradeDb.exec("ALTER TABLE client_account_members ADD COLUMN can_view_billing INTEGER DEFAULT 0; ALTER TABLE client_member_project_grants ADD COLUMN granted_by_identity_id TEXT;");
      await migrate(upgradeDb, bridgeMigration); await migrate(upgradeDb, sourceMigration);
      const upgradeEnv = { ...env, DELIVERY_DB: upgradeDb, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false" } as Env;
      const activePage = structuredClone(portalV2Fixture.valid.snapshotPage) as Record<string, unknown>;
      const activeActivate = structuredClone(portalV2Fixture.valid.snapshotActivate) as Record<string, unknown>;
      expect((await deliver(activePage, upgradeEnv)).status).toBe(200);
      expect((await deliver(activeActivate, upgradeEnv)).status).toBe(200);

      await migrate(upgradeDb, relationMigration);
      await migrate(upgradeDb, relationMigration);

      const stagingPage = structuredClone(portalV2Fixture.valid.snapshotPage) as Record<string, unknown>;
      Object.assign(stagingPage, {
        deliveryId: "portal-v2-staging-page",
        sourceGeneration: "portal-v2-staging-generation",
        sourceSequence: 12,
        snapshotHash: "c".repeat(64),
      });
      expect((await deliver(stagingPage, upgradeEnv)).status).toBe(200);
      const stagingGeneration = await upgradeDb.prepare(`SELECT id FROM pa_portal_projection_generations
        WHERE workspace_id=? AND source_generation=?`).bind(String(stagingPage.workspaceId), String(stagingPage.sourceGeneration)).first<string>("id");
      expect(stagingGeneration).toBeTruthy();
      expect(await upgradeDb.prepare("SELECT COUNT(*) count FROM pa_portal_projection_generation_contracts WHERE generation_id=?")
        .bind(stagingGeneration).first("count")).toBe(0);

      await migrate(upgradeDb, contactAssignmentMigration);
      await migrate(upgradeDb, wireContractClaimMigration);
      await migrate(upgradeDb, billingIndependenceMigration);
      expect(await upgradeDb.prepare(`SELECT COUNT(*) count FROM portal_v2_directory_generations generation
        JOIN portal_v2_directory_generation_contracts contract ON contract.generation_id=generation.id AND contract.workspace_id=generation.workspace_id
        WHERE contract.schema_version=2`).first("count")).toBe(1);
      expect(await upgradeDb.prepare(`SELECT COUNT(*) count FROM pa_portal_projection_generations generation
        JOIN pa_portal_projection_generation_contracts contract ON contract.generation_id=generation.id
        WHERE contract.schema_version=2`).first("count")).toBe(2);
      expect(await upgradeDb.prepare("SELECT wire_schema_version FROM pa_portal_projection_generations WHERE id=?")
        .bind(stagingGeneration).first("wire_schema_version")).toBe(2);

      const mixedSchemaPage = { ...stagingPage, schemaVersion: 3, deliveryId: "portal-v3-mixed-staging", relations: [], projectLifecycles: [] };
      expect((await deliver(mixedSchemaPage, { ...upgradeEnv, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" })).status).toBe(409);

      const nextEvent = structuredClone(portalV2Fixture.valid.event) as Record<string, unknown>;
      expect((await deliver(nextEvent, upgradeEnv)).status).toBe(200);
      expect(await upgradeDb.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(String(activePage.workspaceId)).first("source_sequence")).toBe(11);
      expect(await upgradeDb.prepare(`SELECT contract.schema_version FROM portal_v2_directory_checkpoints checkpoint
        JOIN portal_v2_directory_generation_contracts contract ON contract.generation_id=checkpoint.active_generation_id AND contract.workspace_id=checkpoint.workspace_id
        WHERE checkpoint.workspace_id=?`).bind(String(activePage.workspaceId)).first("schema_version")).toBe(2);
    } finally {
      await upgradeMf.dispose();
    }
  }, 30_000);

  it("keeps same-ID relation graphs and project lifecycle events isolated by mapped producer workspace", async () => {
    const sourceA = createCatalogSourceContext("project-alpha:relations-a");
    const sourceB = createCatalogSourceContext("project-alpha:relations-b");
    const page = relationFixture.valid.snapshotPage;
    const activate = relationFixture.valid.snapshotActivate;
    const apply = async (source: typeof sourceA, payload: unknown) => applyPortalProjectionDelivery(env, parsePortalProjectionDelivery(payload, applicationKey, true), await bodyHash(JSON.stringify(payload)), source);
    for (const source of [sourceA, sourceB]) { await apply(source, page); await apply(source, activate); }
    const localA = await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?").bind(sourceA.sourceId, page.workspaceId).first<string>("workspace_id");
    const localB = await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?").bind(sourceB.sourceId, page.workspaceId).first<string>("workspace_id");
    expect(localA).toBeTruthy(); expect(localB).toBeTruthy(); expect(localA).not.toBe(localB);
    const lifecycle = page.projectLifecycles[0]!;
    const event = { schemaVersion: 3, applicationKey, workspaceId: page.workspaceId, sourceGeneration: page.sourceGeneration, sourceSequence: page.sourceSequence + 1, deliveryId: "same-lifecycle-event", occurredAt: "2026-08-13T18:00:00.000Z", kind: "event", event: { resource: "project_lifecycle", action: "upsert", projectLifecycle: { ...lifecycle, status: "completed", completedAt: "2026-08-13T17:00:00.000Z", sourceVersion: "completed-a" } } };
    await apply(sourceA, event);
    const currentStatus = (localId: string | null) => db.prepare("SELECT lifecycle.lifecycle_status FROM portal_v2_project_lifecycle lifecycle JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=lifecycle.workspace_id AND checkpoint.active_generation_id=lifecycle.generation_id WHERE lifecycle.workspace_id=? AND lifecycle.project_public_id=?")
      .bind(localId, lifecycle.projectPublicId).first("lifecycle_status");
    expect(await currentStatus(localA)).toBe("completed"); expect(await currentStatus(localB)).toBe("active");
    await apply(sourceB, { ...event, event: { ...event.event, projectLifecycle: { ...lifecycle, sourceVersion: "active-b" } } });
    expect(await currentStatus(localA)).toBe("completed"); expect(await currentStatus(localB)).toBe("active");
    const graph = await db.prepare("SELECT relation.public_id,relation.from_public_id,relation.to_public_id FROM portal_v2_directory_relations relation JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=relation.workspace_id AND checkpoint.active_generation_id=relation.generation_id WHERE relation.workspace_id=? ORDER BY relation.public_id").bind(localB).all();
    expect(graph.results).toHaveLength(page.relations.length);
    expect(graph.results.map(row => row.public_id).sort()).toEqual(page.relations.map(row => row.publicId).sort());
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE delivery_id='same-lifecycle-event'").first("count")).toBe(2);
  }, 20_000);

  it("fails closed when the active generation contract cannot be read", async () => {
    const checkpoint = await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence");
    const failed = await deliver(envelope("event", "contract-read-failure", 14, { event: { resource: "project_lifecycle", action: "upsert", projectLifecycle: { projectPublicId: "pa-project-north", status: "active", completedAt: null, sourceVersion: "project-v4" } } }), { ...env, DELIVERY_DB: failActiveContractReadOnce(db) });
    expect(failed.status).toBe(500);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("source_sequence")).toBe(checkpoint);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE delivery_id='contract-read-failure'").first("count")).toBe(0);
  });

  it("atomically closes project and nonempty workspace tombstones", async () => {
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_entitlement_intents
        (workspace_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from)
        VALUES (?,?,?,?,?,'project',?,'grant-v2','active',?)`).bind(workspace.publicId, "entitlement-project", projectedPrincipal.publicId, "directory.read", "allow", "pa-project-north", "2026-08-01T00:00:00.000Z"),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status,valid_from)
        VALUES (?,?,?,?,?,'project',?,'project_alpha','grant-v2','active',?)`).bind("pa-entitlement:project", workspace.publicId, "manager", "directory.read", "allow", "pa-project-north", "2026-08-01T00:00:00.000Z"),
    ]);
    expect((await deliver(relationFixture.valid.projectTombstoneEvent as Record<string, unknown>)).status).toBe(200);
    expect(await db.prepare("SELECT active FROM portal_v2_directory_entities WHERE workspace_id=? AND entity_type='project' AND public_id='pa-project-north' ORDER BY rowid DESC LIMIT 1").bind(workspace.publicId).first("active")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_project_lifecycle WHERE workspace_id=? AND project_public_id='pa-project-north' AND generation_id=(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?)").bind(workspace.publicId, workspace.publicId).first("count")).toBe(0);
    expect(await db.prepare("SELECT status FROM pa_portal_entitlement_intents WHERE workspace_id=? AND public_id='entitlement-project'").bind(workspace.publicId).first("status")).toBe("suspended");
    expect(await db.prepare("SELECT status FROM portal_v2_entitlements WHERE workspace_id=? AND id='pa-entitlement:project'").bind(workspace.publicId).first("status")).toBe("revoked");

    expect((await deliver(relationFixture.valid.workspaceTombstoneEvent as Record<string, unknown>)).status).toBe(200);
    expect(await db.prepare("SELECT status FROM portal_v2_workspaces WHERE id=?").bind(workspace.publicId).first("status")).toBe("suspended");
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?) AND active=1").bind(workspace.publicId, workspace.publicId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_directory_relations WHERE workspace_id=? AND generation_id=(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?) AND active=1").bind(workspace.publicId, workspace.publicId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_project_lifecycle WHERE workspace_id=? AND generation_id=(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?)").bind(workspace.publicId, workspace.publicId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspace_memberships WHERE workspace_id=? AND status='active'").bind(workspace.publicId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements WHERE workspace_id=? AND status='active'").bind(workspace.publicId).first("count")).toBe(0);
  }, 20_000);
});
