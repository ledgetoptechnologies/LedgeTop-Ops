import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import type { ClientViewerSessionRequestV1 } from "@ltds/shared";
import { authorizeClientViewerAssociation } from "../src/worker/viewer-session-issuer";
import { persistViewerAssociation } from "../src/worker/viewer-integration";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const request: ClientViewerSessionRequestV1 = {
  protocolVersion: 1,
  workspaceId: "workspace-one",
  identityId: "identity-one",
  legacyAccountId: "account-one",
  legacyIdentityId: "legacy-identity-one",
  principalIssuer: "https://clients.example.test",
  principalSubject: "subject-one",
  projectId: "project-one",
  associationId: "association-one",
  idempotencyKey: "viewer-session-key-0001",
  displayUnits: "imperial",
};

async function applySql(database: D1Database, sql: string): Promise<void> {
  await database.exec(sql.replace(/\s*\n\s*/g, " "));
}

async function fixture(): Promise<{ database: D1Database; env: Env }> {
  const miniflare = new Miniflare({
    compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DELIVERY_DB: "viewer-session-authorization" },
  });
  active.push(miniflare);
  const database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applySql(database, `
    CREATE TABLE viewer_model_associations(
      id TEXT PRIMARY KEY,project_id TEXT,project_alpha_project_id TEXT,project_source_version TEXT,
      viewer_model_id TEXT,viewer_model_version_id TEXT,viewer_resource_version TEXT,model_title TEXT,
      model_provider TEXT,model_status TEXT,state TEXT,association_version INTEGER,created_by_staff_id TEXT,
      created_at TEXT,updated_at TEXT,revoked_at TEXT,revoked_by_staff_id TEXT,revoke_reason TEXT,
      UNIQUE(project_id,viewer_model_id));
    CREATE TABLE viewer_association_mutation_receipts(
      actor_staff_id TEXT,idempotency_key TEXT,action TEXT,request_fingerprint TEXT,association_id TEXT,
      PRIMARY KEY(actor_staff_id,idempotency_key));
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,source_updated_at TEXT,active INTEGER);
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE client_project_grants(project_id TEXT,account_id TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,status TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,status TEXT,legacy_account_id TEXT);
    CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT,revoked_at TEXT);
    CREATE TABLE client_account_members(account_id TEXT,identity_id TEXT,role TEXT,revoked_at TEXT);
    CREATE TABLE client_member_project_grants(account_id TEXT,identity_id TEXT,project_id TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,
      public_id TEXT,parent_public_id TEXT,active INTEGER);
    CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,capability TEXT,effect TEXT,
      status TEXT,revoked_at TEXT,valid_from TEXT,expires_at TEXT,scope_type TEXT,scope_public_id TEXT);
    CREATE TABLE portal_v2_identity_denials(identity_id TEXT,status TEXT,revoked_at TEXT,valid_from TEXT,
      expires_at TEXT,scope_type TEXT,workspace_id TEXT,scope_public_id TEXT);
    INSERT INTO projects VALUES ('project-one','pa-project-one','source-v1',1);
    INSERT INTO viewer_model_associations VALUES (
      'association-one','project-one','pa-project-one','source-v1','viewer-model-one','viewer-version-one',
      'diagnostic-resource-version','Point cloud','webodm','ready','active',1,'staff-one',
      datetime('now'),datetime('now'),NULL,NULL,NULL);
    INSERT INTO client_accounts VALUES ('account-one','active');
    INSERT INTO client_project_grants VALUES ('project-one','account-one',NULL);
    INSERT INTO portal_v2_identities VALUES (
      'identity-one','https://clients.example.test','subject-one','active',NULL);
    INSERT INTO portal_v2_workspace_memberships VALUES (
      'workspace-one','identity-one','active',NULL,datetime('now','+20 minutes'));
    INSERT INTO portal_v2_workspaces VALUES (
      'workspace-one','organization','pa-org-one',NULL,'active','account-one');
    INSERT INTO client_identity_links VALUES ('legacy-identity-one','account-one',NULL);
    INSERT INTO client_account_members VALUES ('account-one','legacy-identity-one','manager',NULL);
    INSERT INTO portal_v2_directory_generations VALUES ('generation-one','workspace-one','active',1);
    INSERT INTO portal_v2_directory_checkpoints VALUES ('workspace-one','generation-one');
    INSERT INTO portal_v2_directory_entities VALUES (
      'workspace-one','generation-one','project','pa-project-one','pa-org-one',1);
    INSERT INTO portal_v2_directory_entities VALUES (
      'workspace-one','generation-one','organization','pa-org-one',NULL,1);
    INSERT INTO portal_v2_entitlements VALUES (
      'workspace-one','identity-one','delivery.view','allow','active',NULL,
      datetime('now','-1 minute'),NULL,'workspace','workspace-one');
  `);
  return { database, env: {
    DELIVERY_DB: database,
    CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "true",
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
  } as Env };
}

afterEach(async () => Promise.all(active.splice(0).map(instance => instance.dispose())));

describe("client Viewer authorization", () => {
  it("returns only an exact live project/model association with delivery.view", async () => {
    const { env } = await fixture();
    const association = await authorizeClientViewerAssociation(env, request);
    expect(association).toMatchObject({
      id: "association-one",
      viewer_model_id: "viewer-model-one",
      viewer_model_version_id: "viewer-version-one",
    });
    expect(Date.parse(association!.authorization_expires_at!)).toBeGreaterThan(Date.now());
  });

  it("does not bump association_version on a same-key retry", async () => {
    const { database, env } = await fixture();
    const principal: StaffPrincipal = {
      id: "staff-one", email: "staff@example.test", displayName: "Staff",
      accessSubject: "staff-subject", projectAlphaUserId: null,
    };
    const input = {
      env,
      principal,
      project: {
        id: "project-one", project_alpha_project_id: "pa-project-one",
        project_name: "Project", client_name: "Client", source_updated_at: "source-v1",
      },
      model: {
        id: "viewer-model-one", title: "Point cloud", provider: "webodm", status: "ready",
        available: true, updatedAt: "diagnostic-resource-version",
        activeVersion: {
          id: "viewer-version-one", providerVersionId: "provider-version-one",
          createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z",
        },
      },
      idempotencyKey: "association-retry-key-0001",
      fingerprint: "same-request-fingerprint",
    };
    expect((await persistViewerAssociation(input)).replayed).toBe(false);
    expect((await persistViewerAssociation(input)).replayed).toBe(true);
    expect(await database.prepare("SELECT association_version FROM viewer_model_associations WHERE id='association-one'")
      .first("association_version")).toBe(2);
  });

  it("fails closed for an explicit entitlement denial", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_entitlements VALUES (
      'workspace-one','identity-one','delivery.view','deny','active',NULL,
      datetime('now','-1 minute'),NULL,'project','pa-project-one')`).run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("fails closed for a live identity denial", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_identity_denials VALUES (
      'identity-one','active',NULL,datetime('now','-1 minute'),NULL,'global',NULL,NULL)`).run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("stays unavailable until both rollout gates are enabled", async () => {
    const { env } = await fixture();
    expect(await authorizeClientViewerAssociation({ ...env, CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "false" }, request))
      .toBeNull();
    expect(await authorizeClientViewerAssociation({ ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" }, request))
      .toBeNull();
  });
});
