import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
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
import { ingestOpsSyncPortalProjection } from "../src/worker/ops-sync-portal-entrypoint";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import type { Env } from "../src/worker/types";
import portalFixture from "../../../packages/shared/fixtures/project-alpha-portal-v2.json";

const applicationKey = "field_operations_portal";
const secret = "portal-test-secret-at-least-thirty-two-bytes";
const keyId = "portal-test-v1";
const access = async () => undefined;
const principal: VerifiedClientPrincipal = { issuer: "https://team.cloudflareaccess.com", subject: "verified-subject", email: "manager@example.test" };

async function signature(body: string, timestamp: string, deliveryId: string, signingKeyId = keyId, signingSecret = secret): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\nPOST\n/api/internal/project-alpha/portal-v2\n${signingKeyId}\n${deliveryId}\n${body}`));
  return `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function bodyHash(body:string):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));return[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}

const workspace = {
  publicId: "pa-workspace-acme", rootType: "organization", rootPublicId: "pa-org-acme",
  displayName: "Acme Construction", sourceVersion: "org-v1", active: true,
} as const;
const contact = { type: "contact", publicId: "pa-contact-primary", parentPublicId: "pa-dept-field", displayName: "Primary Contact", sourceVersion: "contact-v1", active: true, primaryContact: true } as const;
const project = { type: "project", publicId: "pa-project-north", parentPublicId: "pa-dept-field", displayName: "North Site", sourceVersion: "project-v1", active: true, primaryContact: false } as const;
const projectedPrincipal = { publicId: "pa-principal-manager", emailHint: "manager@example.test", displayName: "Portal Manager", sourceVersion: "principal-v1", active: true } as const;

function envelope(kind: string, deliveryId: string, sourceSequence: number, extra: Record<string, unknown>) {
  return {
    schemaVersion: 2, applicationKey, deliveryId, occurredAt: "2026-08-13T18:00:00.000Z",
    sourceGeneration: "portal-2026-08-13", sourceSequence, workspaceId: workspace.publicId, kind, ...extra,
  };
}

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

function beforeFirstBatch(database: D1Database, before: () => Promise<void>): D1Database {
  let called = false;
  let proxy: D1Database;
  proxy = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!called) { called = true; await before(); }
      return target.batch(statements);
    };
    const value = target[property as keyof D1Database];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

describe("Project Alpha portal hierarchy projection", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-16", modules: true, script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DELIVERY_DB: "portal-projection-test" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,project_alpha_source_id TEXT DEFAULT 'project-alpha:primary',project_alpha_client_id TEXT,project_alpha_organization_id TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),last_seen_at TEXT,UNIQUE(issuer,subject),UNIQUE(id,account_id));
      CREATE TABLE client_account_members(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,role TEXT NOT NULL,revoked_at TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(account_id,identity_id));
      CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE client_project_grants(account_id TEXT NOT NULL,project_id TEXT NOT NULL,can_request_service INTEGER DEFAULT 0,revoked_at TEXT,PRIMARY KEY(account_id,project_id));
      CREATE TABLE client_member_project_grants(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,project_id TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,identity_id,project_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,account_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),revoked_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await applyMigration(db, hierarchyMigration);
    await applyMigration(db, projectionMigration);
    await applyMigration(db, relationMigration);
    await applyMigration(db, eligibilityMigration);
    await db.exec("ALTER TABLE client_account_members ADD COLUMN can_view_billing INTEGER DEFAULT 0; ALTER TABLE client_member_project_grants ADD COLUMN granted_by_identity_id TEXT;");
    await applyMigration(db, bridgeMigration);
    await applyMigration(db, sourceMigration);
    await applyMigration(db, contactAssignmentMigration);
    await applyMigration(db, wireContractClaimMigration);
    await applyMigration(db, billingIndependenceMigration);
    await db.prepare("PRAGMA foreign_keys=ON").run();
    env = {
      DELIVERY_DB: db,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "portal-sync-audience",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    } as Env;
  }, 30_000);

  afterAll(async () => miniflare.dispose());

  async function deliver(payload: Record<string, unknown>, options: { timestamp?: string; signature?: string; keyId?: string; secret?: string; accessVerifier?: typeof access } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? new Date().toISOString();
    const signingKeyId = options.keyId ?? keyId;
    return handleProjectAlphaPortalProjectionRequest(new Request("https://client.test/api/internal/project-alpha/portal-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Portal-Integration-Application-Key":applicationKey,"X-Portal-Integration-Timestamp": timestamp,"X-Portal-Integration-Body-SHA256":await bodyHash(body),"X-Portal-Integration-Key-Id":signingKeyId, "X-Portal-Integration-Delivery-Id": String(payload.deliveryId), "X-Portal-Integration-Signature": options.signature ?? await signature(body, timestamp,String(payload.deliveryId), signingKeyId, options.secret ?? secret) },
      body,
    }), env, options.accessVerifier ?? access);
  }

  it("accepts and rejects the shared schema-v2 producer corpus exactly", () => {
    expect(portalFixture.contract).toBe("ltds-project-alpha-portal-v2");
    expect(portalFixture.endpoint).toBe("/api/internal/project-alpha/portal-v2");
    for (const delivery of Object.values(portalFixture.valid))
      expect(parsePortalProjectionDelivery(delivery, portalFixture.applicationKey)).toBeTruthy();
    for (const specimen of portalFixture.invalid)
      expect(() => parsePortalProjectionDelivery(specimen.delivery, portalFixture.applicationKey))
        .toThrow(specimen.expectedError);
    expect(portalFixture.relationProjectionStatus).toMatchObject({
      acceptedWhenRelationsFlagEnabled: true,
      runtimeFeatureFlagDefault: false,
    });
  });

  it("accepts the primary projection through the private Ops Sync boundary without copied PA credentials",async()=>{
    const payload=portalFixture.valid.snapshotPage as Record<string,unknown>;
    const result=await ingestOpsSyncPortalProjection({...env,PROJECT_ALPHA_PORTAL_HMAC_SECRET:undefined,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:undefined},{protocolVersion:1,sourceId:PRIMARY_ALPHA_SOURCE_ID,
      applicationKey,deliveryId:String(payload.deliveryId),projectionKind:"portal",body:JSON.stringify(payload)});
    expect(result).toEqual({ok:true,protocolVersion:1,status:"completed"});
  });

  it("stages a complete bounded generation and atomically activates hierarchy and unbound authorization intent", async () => {
    const page = portalFixture.valid.snapshotPage as Record<string, unknown>;
    expect((await deliver(page)).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces").first("count")).toBe(0);
    expect((await deliver(portalFixture.valid.snapshotActivate as Record<string, unknown>)).status).toBe(200);
    expect(await db.prepare("SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?").bind(workspace.publicId).first("active_generation_id")).toBeTruthy();
    expect(await db.prepare("SELECT primary_contact FROM portal_v2_directory_entities WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, contact.publicId).first("primary_contact")).toBe(1);
    expect(await db.prepare("SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, projectedPrincipal.publicId).first("identity_id")).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='project_alpha'").bind(workspace.publicId).first("count")).toBe(0);
  });

  it("does not treat email hints or primary contacts as identity proof, then projects grants only after an explicit verified binding", async () => {
    await db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES ('verified-identity',?,?,?,'active')").bind(principal.issuer, principal.subject, principal.email).run();
    await db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES ('eligible-identity','https://eligible.example','eligible-subject',?,'active')").bind(principal.email).run();
    await db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings
      (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
      VALUES('eligible-identity',?,?,?,?)`).bind(workspace.publicId, projectedPrincipal.publicId, projectedPrincipal.sourceVersion, principal.email).run();
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(false);
    await db.prepare("UPDATE pa_portal_principals SET identity_id='verified-identity' WHERE workspace_id=? AND public_id=?").bind(workspace.publicId, projectedPrincipal.publicId).run();
    const refresh = envelope("event", "portal-event-11", 11, { event: { resource: "principal", action: "upsert", principal: { ...projectedPrincipal, sourceVersion: "principal-v2" } } });
    expect((await deliver(refresh)).status).toBe(200);
    expect(await db.prepare(`SELECT principal_source_version FROM portal_v2_identity_eligibility_bindings
      WHERE identity_id='eligible-identity'`).first("principal_source_version")).toBe("principal-v2");
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(true);
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "member.manage", { scopeType: "workspace", publicId: workspace.publicId })).toBe(false);
  });

  it("accepts exact replay, rejects delivery-id reuse and sequence gaps, and immediately removes a tombstoned principal", async () => {
    const replay = envelope("event", "portal-event-11", 11, { event: { resource: "principal", action: "upsert", principal: { ...projectedPrincipal, sourceVersion: "principal-v2" } } });
    expect((await (await deliver(replay)).json() as { status: string }).status).toBe("duplicate");
    expect((await deliver({ ...replay, occurredAt: "2026-08-13T18:01:00.000Z" })).status).toBe(409);
    expect((await deliver(envelope("event", "portal-event-13", 13, { event: { resource: "principal", action: "tombstone", publicId: projectedPrincipal.publicId, sourceVersion: "principal-v3" } }))).status).toBe(409);
    expect((await deliver(envelope("event", "portal-event-12", 12, { event: { resource: "principal", action: "tombstone", publicId: projectedPrincipal.publicId, sourceVersion: "principal-v3" } }))).status).toBe(200);
    expect(await db.prepare(`SELECT principal_source_version FROM portal_v2_identity_eligibility_bindings
      WHERE identity_id='eligible-identity'`).first("principal_source_version")).toBe("principal-v2");
    expect(await authorizePortalWorkspaceCapability(env, principal, workspace.publicId, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(false);
  });

  it("hard-404s while disabled and clearly rejects an enabled but malformed receiver before Access, body reads, or D1", async () => {
    let accessCalls = 0;
    const request = () => new Request("https://client.test/api/internal/project-alpha/portal-v2", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const disabled = await handleProjectAlphaPortalProjectionRequest(request(), { PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "false" } as Env, async () => { accessCalls += 1; });
    expect(disabled.status).toBe(404);
    expect(accessCalls).toBe(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const incomplete = await handleProjectAlphaPortalProjectionRequest(request(), { PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true" } as Env, async () => { accessCalls += 1; });
      expect(incomplete.status).toBe(503);
      expect(await incomplete.json()).toEqual({ error: "portal-receiver-misconfigured", reason: "application_key_invalid" });
      for (const malformed of ["too-short", ` ${"s".repeat(32)}`, `${"s".repeat(31)}\n`]) {
        const response = await handleProjectAlphaPortalProjectionRequest(request(), {
          ...env, PROJECT_ALPHA_PORTAL_HMAC_SECRET: malformed,
        }, async () => { accessCalls += 1; });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "portal-receiver-misconfigured", reason: "current_secret_invalid" });
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"project_alpha_portal_receiver_misconfigured"'));
      expect(accessCalls).toBe(0);
      expect(env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED).toBe("true");
    } finally { error.mockRestore(); }
  });

  it("requires Access, fresh exact-body HMAC and opaque public ids", async () => {
    const payload = envelope("event", "portal-auth-13", 13, { event: { resource: "workspace", action: "tombstone", publicId: workspace.publicId, sourceVersion: "org-v2" } });
    expect((await deliver(payload, { accessVerifier: async () => { throw new Error("portal-access-invalid"); } })).status).toBe(401);
    expect((await deliver(payload, { timestamp: "2020-01-01T00:00:00.000Z" })).status).toBe(401);
    expect((await deliver(payload, { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect(() => parsePortalProjectionDelivery({ ...payload, apiKey: "forbidden" }, applicationKey)).toThrow();
    expect(() => parsePortalProjectionDelivery({ ...payload, workspaceId: 42 }, applicationKey)).toThrow();
    expect(() => parsePortalProjectionDelivery({ ...payload, workspaceId: "42" }, applicationKey)).toThrow();
  });

  it("accepts only the configured current or previous rotation key", async () => {
    const previousKeyId = "portal-test-v0";
    const previousSecret = "portal-previous-secret-at-least-thirty-two-bytes";
    env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID = previousKeyId;
    const payload = envelope("event", "portal-rotation-13", 13, { event: { resource: "workspace", action: "tombstone", publicId: workspace.publicId, sourceVersion: "org-v2" } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await deliver(payload, { keyId: previousKeyId, secret: previousSecret })).status).toBe(503);
    error.mockRestore();
    env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET = previousSecret;
    expect((await deliver(payload, { keyId: previousKeyId, secret: previousSecret })).status).toBe(200);
    expect((await deliver({ ...payload, deliveryId: "portal-rotation-unknown" }, { keyId: "portal-test-unknown" })).status).toBe(401);
    delete env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID;
    delete env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET;
  });

  it("rejects an oversized streamed body without relying on Content-Length", async () => {
    const response = await handleProjectAlphaPortalProjectionRequest(new Request(
      "https://client.test/api/internal/project-alpha/portal-v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(256 * 1024 + 1),
      },
    ), env, access);
    expect(response.status).toBe(413);
  });

  async function applyFrom(sourceId: string, payload: Record<string, unknown>, environment = env) {
    return applyPortalProjectionDelivery(environment, parsePortalProjectionDelivery(payload, applicationKey), await bodyHash(JSON.stringify(payload)), createCatalogSourceContext(sourceId));
  }

  function sourceSnapshot(sequence: number, sourceGeneration: string) {
    const common = { sourceSequence: sequence, sourceGeneration, deliveryId: `source-page-${sequence}`, snapshotHash: String(sequence % 10).repeat(64) };
    return {
      page: { ...structuredClone(portalFixture.valid.snapshotPage), ...common } as Record<string, unknown>,
      activate: { ...structuredClone(portalFixture.valid.snapshotActivate), ...common, deliveryId: `source-activate-${sequence}` } as Record<string, unknown>,
    };
  }

  async function baseline(sourceId: string) {
    const snapshot = sourceSnapshot(10, "source-generation-ten");
    await applyFrom(sourceId, snapshot.page); await applyFrom(sourceId, snapshot.activate);
    return await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?")
      .bind(sourceId, workspace.publicId).first<string>("workspace_id") as string;
  }

  it("claims schema v2 with relations disabled and rejects a v3 page after the flag is enabled", async () => {
    const source = "project-alpha:v2-flag-transition";
    const firstPage = {
      ...structuredClone(portalFixture.valid.snapshotPage),
      deliveryId: "v2-flag-transition-page-1",
      sourceGeneration: "v2-flag-transition-generation",
      sourceSequence: 20,
      snapshotHash: "9".repeat(64),
      pageNumber: 1,
      pageCount: 2,
    } as Record<string, unknown>;
    const relationsOff = { ...env, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "false" } as Env;
    expect(await applyFrom(source, firstPage, relationsOff)).toBe("completed");

    const generation = await db.prepare(`SELECT generation.id,generation.wire_schema_version
      FROM pa_portal_projection_generations generation
      JOIN pa_portal_workspace_sources source ON source.workspace_id=generation.workspace_id
      WHERE source.projection_source_id=? AND generation.source_generation=?`)
      .bind(source, firstPage.sourceGeneration).first<{ id: string; wire_schema_version: number }>();
    expect(generation?.wire_schema_version).toBe(2);
    expect(await db.prepare("SELECT schema_version FROM pa_portal_projection_generation_contracts WHERE generation_id=?")
      .bind(generation!.id).first("schema_version")).toBe(2);

    const secondPage = {
      ...firstPage,
      schemaVersion: 3,
      deliveryId: "v2-flag-transition-page-2",
      pageNumber: 2,
      entities: [],
      principals: [],
      entitlements: [],
      relations: [],
      projectLifecycles: [],
    };
    const relationsOn = { ...env, CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true" } as Env;
    const parsedSecondPage = parsePortalProjectionDelivery(secondPage, applicationKey, true);
    await expect(applyPortalProjectionDelivery(relationsOn, parsedSecondPage,
      await bodyHash(JSON.stringify(secondPage)), createCatalogSourceContext(source)))
      .rejects.toThrow("portal-generation-contract-conflict");
    expect(await db.prepare("SELECT count(*) count FROM pa_portal_projection_pages WHERE generation_id=?")
      .bind(generation!.id).first("count")).toBe(1);
  });

  it("isolates equal workspace, root, principal, entitlement and delivery IDs by producer while retaining primary URLs and raw hashes", async () => {
    const primaryState = () => db.prepare(`SELECT workspace.status,checkpoint.source_generation,checkpoint.source_sequence,
      checkpoint.snapshot_generation_id,directory.active_generation_id,principal.status principal_status,
      principal.source_version principal_source_version,principal.identity_id
      FROM portal_v2_workspaces workspace
      JOIN pa_portal_projection_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_checkpoints directory ON directory.workspace_id=workspace.id
      JOIN pa_portal_principals principal ON principal.workspace_id=workspace.id AND principal.public_id=?
      WHERE workspace.id=?`).bind(projectedPrincipal.publicId, workspace.publicId).first();
    const primaryBefore = await primaryState();
    expect(primaryBefore).not.toBeNull();
    const sourceB = "project-alpha:source-b";
    const page = portalFixture.valid.snapshotPage as Record<string, unknown>;
    const activate = portalFixture.valid.snapshotActivate as Record<string, unknown>;
    expect(await applyFrom(PRIMARY_ALPHA_SOURCE_ID, page)).toBe("duplicate");
    expect(await applyFrom(sourceB, page)).toBe("completed");
    expect(await applyFrom(sourceB, activate)).toBe("completed");
    const maps = (await db.prepare("SELECT workspace_id,projection_source_id FROM pa_portal_workspace_sources WHERE source_workspace_id=? AND projection_source_id IN (?,?) ORDER BY projection_source_id")
      .bind(workspace.publicId, PRIMARY_ALPHA_SOURCE_ID, sourceB).all<{ workspace_id: string; projection_source_id: string }>()).results;
    expect(maps).toHaveLength(2);
    expect(maps.find(row => row.projection_source_id === PRIMARY_ALPHA_SOURCE_ID)?.workspace_id).toBe(workspace.publicId);
    const localB = maps.find(row => row.projection_source_id === sourceB)!.workspace_id;
    expect(localB).not.toBe(workspace.publicId);
    expect(await db.prepare("SELECT pa_organization_public_id FROM portal_v2_workspaces WHERE id=?").bind(localB).first("pa_organization_public_id")).toBe(workspace.rootPublicId);
    const receipts = (await db.prepare("SELECT payload_hash FROM pa_portal_projection_receipts WHERE delivery_id=?").bind(String(page.deliveryId)).all<{ payload_hash: string }>()).results;
    expect(receipts).toHaveLength(2);
    expect(receipts.every(row => row.payload_hash === receipts[0]!.payload_hash)).toBe(true);
    expect(await db.prepare("SELECT scope_public_id FROM pa_portal_entitlement_intents WHERE workspace_id=? AND scope_type='workspace' LIMIT 1").bind(localB).first("scope_public_id")).toBe(localB);
    expect(await applyFrom(sourceB, page)).toBe("duplicate");
    await expect(applyFrom(sourceB, { ...page, occurredAt: "2026-08-13T18:01:00.000Z" })).rejects.toThrow("portal-delivery-id-conflict");
    await db.prepare("UPDATE pa_portal_principals SET identity_id='verified-identity' WHERE workspace_id=? AND public_id=?").bind(localB, projectedPrincipal.publicId).run();
    const refresh = envelope("event", "source-b-refresh", 11, { event: { resource: "principal", action: "upsert", principal: { ...projectedPrincipal, sourceVersion: "source-b-principal-v2" } } });
    await applyFrom(sourceB, refresh);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_identities WHERE issuer=? AND subject=?").bind(principal.issuer, principal.subject).first("count")).toBe(1);
    expect(await authorizePortalWorkspaceCapability(env, principal, localB, "delivery.view", { scopeType: "project", publicId: project.publicId })).toBe(false);
    expect(await primaryState()).toEqual(primaryBefore);
    await applyFrom(sourceB, envelope("event", "source-b-close", 12, { event: { resource: "workspace", action: "tombstone", publicId: workspace.publicId, sourceVersion: "source-b-closed" } }));
    expect(await db.prepare("SELECT status FROM portal_v2_workspaces WHERE id=?").bind(localB).first("status")).toBe("suspended");
    expect(await primaryState()).toEqual(primaryBefore);
  }, 20_000);

  it("rejects an event raced by a newer snapshot before any authority or receipt mutation", async () => {
    const source = "project-alpha:event-race";
    const localId = await baseline(source);
    const newer = sourceSnapshot(12, "source-generation-twelve");
    const event = envelope("event", "raced-event-eleven", 11, { sourceGeneration: "source-generation-ten", event: { resource: "principal", action: "tombstone", publicId: projectedPrincipal.publicId, sourceVersion: "stale-principal" } });
    const racedEnv = { ...env, DELIVERY_DB: beforeFirstBatch(db, async () => { await applyFrom(source, newer.page); await applyFrom(source, newer.activate); }) };
    await expect(applyFrom(source, event, racedEnv)).rejects.toThrow("portal-write-conflict");
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(localId).first("source_sequence")).toBe(12);
    expect(await db.prepare("SELECT status FROM portal_v2_directory_generations WHERE id=(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?)").bind(localId).first("status")).toBe("active");
    expect(await db.prepare("SELECT status FROM pa_portal_principals WHERE workspace_id=? AND public_id=?").bind(localId, projectedPrincipal.publicId).first("status")).toBe("active");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE projection_source_id=? AND delivery_id=?").bind(source, event.deliveryId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_audit WHERE workspace_id=? AND delivery_id=?").bind(localId, event.deliveryId).first("count")).toBe(0);
  }, 20_000);

  it("rejects a stale snapshot activation read after another snapshot commits", async () => {
    const source = "project-alpha:activation-race";
    const localId = await baseline(source);
    const older = sourceSnapshot(12, "source-generation-twelve");
    const newer = sourceSnapshot(14, "source-generation-fourteen");
    await applyFrom(source, older.page); await applyFrom(source, newer.page);
    const racedEnv = { ...env, DELIVERY_DB: beforeFirstBatch(db, async () => { await applyFrom(source, newer.activate); }) };
    await expect(applyFrom(source, older.activate, racedEnv)).rejects.toThrow("portal-write-conflict");
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(localId).first("source_sequence")).toBe(14);
    expect(await db.prepare("SELECT status FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation='source-generation-twelve'").bind(localId).first("status")).toBe("staging");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE projection_source_id=? AND delivery_id=?").bind(source, older.activate.deliveryId).first("count")).toBe(0);
  }, 20_000);

  it("does not append a page after its initial checkpoint read has become stale", async () => {
    const source = "project-alpha:page-race";
    const localId = await baseline(source);
    const older = sourceSnapshot(12, "source-generation-twelve");
    const newer = sourceSnapshot(14, "source-generation-fourteen");
    const racedEnv = { ...env, DELIVERY_DB: beforeFirstBatch(db, async () => { await applyFrom(source, newer.page); await applyFrom(source, newer.activate); }) };
    await expect(applyFrom(source, older.page, racedEnv)).rejects.toThrow("portal-write-conflict");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_pages WHERE generation_id=(SELECT id FROM pa_portal_projection_generations WHERE workspace_id=? AND source_generation='source-generation-twelve')").bind(localId).first("count")).toBe(0);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(localId).first("source_sequence")).toBe(14);
  }, 20_000);

  it("rejects producer-supplied local workspace coordinates before translating them", async () => {
    const source = "project-alpha:coordinate-check";
    const localId = await baseline(source);
    const common = { sourceGeneration: "source-generation-ten" };
    await expect(applyFrom(source, envelope("event", "bad-local-workspace-upsert", 11, { ...common, event: { resource: "workspace", action: "upsert", workspace: { ...workspace, publicId: localId } } }))).rejects.toThrow("portal-workspace-id-invalid");
    await expect(applyFrom(source, envelope("event", "bad-local-workspace-tombstone", 11, { ...common, event: { resource: "workspace", action: "tombstone", publicId: localId, sourceVersion: "bad" } }))).rejects.toThrow("portal-workspace-id-invalid");
    const grant = portalFixture.valid.snapshotPage.entitlements.find(row => row.scopeType === "workspace")!;
    await expect(applyFrom(source, envelope("event", "bad-local-workspace-entitlement", 11, { ...common, event: { resource: "entitlement", action: "upsert", entitlement: { ...grant, scopePublicId: localId } } }))).rejects.toThrow("portal-entitlement-scope-invalid");
    const snapshot = parsePortalProjectionDelivery(sourceSnapshot(12, "bad-coordinate-generation").page, applicationKey);
    if (snapshot.kind !== "snapshot.page") throw new Error("fixture-shape");
    await expect(applyPortalProjectionDelivery(env, { ...snapshot, workspace: { ...snapshot.workspace, publicId: localId } }, "f".repeat(64), createCatalogSourceContext("project-alpha:unreserved-bad"))).rejects.toThrow("portal-workspace-id-invalid");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_workspace_sources WHERE projection_source_id='project-alpha:unreserved-bad'").first("count")).toBe(0);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(localId).first("source_sequence")).toBe(10);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_receipts WHERE projection_source_id=? AND delivery_id LIKE 'bad-local-%'").bind(source).first("count")).toBe(0);
  }, 20_000);

  it("reuses the winning staging generation when concurrent first pages reserve different local IDs", async () => {
    const source = "project-alpha:staging-race";
    const snapshot = sourceSnapshot(10, "shared-staging-generation");
    const parsed = parsePortalProjectionDelivery(snapshot.page, applicationKey);
    if (parsed.kind !== "snapshot.page") throw new Error("fixture-shape");
    const pageOne = { ...snapshot.page, pageCount: 2, pageNumber: 1, principals: [], entitlements: [] };
    const pageTwo = { ...snapshot.page, deliveryId: "second-concurrent-page", pageCount: 2, pageNumber: 2, entities: [] };
    let injected = false;
    let winningGenerationId: string | null = null;
    let proxy: D1Database;
    const statementSql = new WeakMap<D1PreparedStatement, string>();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = target[property as keyof D1PreparedStatement];
        return typeof value === "function" ? value.bind(target) : value;
      } });
      statementSql.set(wrapped, sql);
      return wrapped;
    };
    proxy = new Proxy(db, { get(target, property) {
      if (property === "withSession") return () => proxy;
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!injected && statements.some(statement => statementSql.get(statement)?.includes("INSERT OR IGNORE INTO pa_portal_projection_generations"))) {
          injected = true;
          await applyFrom(source, pageTwo);
          winningGenerationId = await db.prepare("SELECT id FROM pa_portal_projection_generations WHERE projection_source_id=? AND source_generation=?")
            .bind(source, snapshot.page.sourceGeneration).first<string>("id");
        }
        return target.batch(statements);
      };
      const value = target[property as keyof D1Database];
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await applyFrom(source, pageOne, { ...env, DELIVERY_DB: proxy })).toBe("completed");
    expect(injected).toBe(true);
    expect(winningGenerationId).toBeTruthy();
    expect(await applyFrom(source, { ...snapshot.activate, pageCount: 2 })).toBe("completed");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_generations WHERE projection_source_id=?").bind(source).first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_portal_projection_pages page JOIN pa_portal_projection_generations generation ON generation.id=page.generation_id WHERE generation.projection_source_id=?").bind(source).first("count")).toBe(2);
    expect((await db.prepare("SELECT page.page_number,page.generation_id FROM pa_portal_projection_pages page JOIN pa_portal_projection_generations generation ON generation.id=page.generation_id WHERE generation.projection_source_id=? ORDER BY page.page_number")
      .bind(source).all()).results).toEqual([{page_number:1,generation_id:winningGenerationId},{page_number:2,generation_id:winningGenerationId}]);
  }, 20_000);

  it("is migration-idempotent and keeps referential integrity", async () => {
    await applyMigration(db, projectionMigration);
    const activeGenerationId = await db.prepare(
      "SELECT snapshot_generation_id FROM pa_portal_projection_checkpoints WHERE workspace_id=?",
    ).bind(workspace.publicId).first<string>("snapshot_generation_id");
    expect(activeGenerationId).toBeTruthy();
    await expect(db.prepare(`INSERT INTO pa_portal_projection_checkpoints
      (workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES ('pa-workspace-cross','generation-one',10,?)`).bind(activeGenerationId).run()).rejects.toThrow();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
