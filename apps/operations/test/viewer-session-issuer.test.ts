import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import type { ClientViewerSessionRequestV1 } from "@ltds/shared";
import {
  authorizeClientViewerAssociation,
  createClientViewerShare,
  issueClientViewerSession,
  introspectClientViewerSourceAuthorization,
  listClientViewerShares,
  pruneClientViewerShareReceipts,
  revokeClientViewerShare,
} from "../src/worker/viewer-session-issuer";
import {
  drainViewerSessionRevocations,
  issueViewerSession,
  persistViewerAssociation,
} from "../src/worker/viewer-integration";
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
    CREATE TABLE viewer_session_revocation_outbox(
      id TEXT PRIMARY KEY,association_id TEXT,association_version INTEGER,idempotency_key TEXT UNIQUE,
      state TEXT DEFAULT 'pending',attempt_count INTEGER DEFAULT 0,next_attempt_at TEXT DEFAULT (datetime('now')),
      last_error_code TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),
      delivered_at TEXT,UNIQUE(association_id,association_version));
    CREATE TABLE viewer_session_issuance_receipts(
      actor_id TEXT,audience TEXT,idempotency_key TEXT,request_fingerprint TEXT,response_json TEXT,
      expires_at TEXT,PRIMARY KEY(actor_id,audience,idempotency_key));
    CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,source_updated_at TEXT,active INTEGER);
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE client_project_grants(project_id TEXT,account_id TEXT,revoked_at TEXT);
    CREATE TABLE viewer_client_grants(id TEXT PRIMARY KEY,account_id TEXT,project_id TEXT,scope_type TEXT,
      association_id TEXT,include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,
      can_download INTEGER,authorization_expires_at TEXT,grant_version INTEGER,status TEXT,
      created_by_staff_id TEXT,created_at TEXT,updated_at TEXT,revoked_at TEXT,revoked_by_staff_id TEXT,revoke_reason TEXT);
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,verified_email TEXT,status TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,status TEXT,legacy_account_id TEXT,
      project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE portal_v2_root_access_policies(
      projection_source_id TEXT,root_type TEXT,root_public_id TEXT,state TEXT,
      PRIMARY KEY(projection_source_id,root_type,root_public_id));
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
    CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT PRIMARY KEY,match_type TEXT,issuer TEXT,subject TEXT,
      normalized_email TEXT,status TEXT,valid_from TEXT,expires_at TEXT);
    CREATE TABLE client_viewer_source_authorizations(
      id TEXT PRIMARY KEY,authorization_version INTEGER NOT NULL DEFAULT 1,workspace_id TEXT,identity_id TEXT,legacy_account_id TEXT,
      legacy_identity_id TEXT,principal_issuer TEXT,principal_subject TEXT,project_id TEXT,association_id TEXT,
      association_version INTEGER,viewer_model_id TEXT,viewer_model_version_id TEXT,authorization_expires_at TEXT,
      idempotency_key TEXT,request_fingerprint TEXT,status TEXT NOT NULL DEFAULT 'pending',share_id TEXT,created_at TEXT,updated_at TEXT,
      revoked_at TEXT,last_denial_reason TEXT,last_denial_at TEXT,UNIQUE(identity_id,idempotency_key),UNIQUE(share_id));
    CREATE TABLE client_viewer_share_revocation_receipts(identity_id TEXT,idempotency_key TEXT,share_id TEXT,
      response_json TEXT,created_at TEXT,PRIMARY KEY(identity_id,idempotency_key));
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,action TEXT,
      entity_type TEXT,entity_id TEXT,details_json TEXT);
    INSERT INTO projects VALUES ('project-one','pa-project-one','source-v1',1);
    INSERT INTO viewer_model_associations VALUES (
      'association-one','project-one','pa-project-one','source-v1','viewer-model-one','viewer-version-one',
      'diagnostic-resource-version','Point cloud','webodm','ready','active',1,'staff-one',
      datetime('now'),datetime('now'),NULL,NULL,NULL);
    INSERT INTO client_accounts VALUES ('account-one','active');
    INSERT INTO client_project_grants VALUES ('project-one','account-one',NULL);
    INSERT INTO viewer_client_grants VALUES ('viewer-grant-one','account-one','project-one','project',NULL,1,1,1,0,
      NULL,1,'active','staff-one',datetime('now'),datetime('now'),NULL,NULL,NULL);
    INSERT INTO portal_v2_identities VALUES (
      'identity-one','https://clients.example.test','subject-one','client@example.test','active',NULL);
    INSERT INTO portal_v2_workspace_memberships VALUES (
      'workspace-one','identity-one','active',NULL,datetime('now','+20 minutes'));
    INSERT INTO portal_v2_workspaces
      (id,root_type,pa_organization_public_id,pa_client_public_id,status,legacy_account_id) VALUES (
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
    CLIENT_VIEWER_SHARES_ENABLED: "true",
    VIEWER_INTEGRATION_ENABLED: "true",
    VIEWER_PUBLIC_SHARES_ENABLED: "true",
    VIEWER_BASE_URL: "https://viewer.example.test",
    VIEWER_SERVICE_KEY_ID: "ops-v1",
    VIEWER_SERVICE_HMAC_SECRET: "viewer-service-secret-32-characters-minimum",
    OPS_DB: database,
  } as Env };
}

async function grantViewerSharing(database: D1Database, identityId = "identity-one"): Promise<void> {
  await database.prepare(`INSERT INTO portal_v2_entitlements VALUES (
    'workspace-one',?,'viewer.share.create','allow','active',NULL,
    datetime('now','-1 minute'),NULL,'workspace','workspace-one')`).bind(identityId).run();
}

async function addSourceAuthorization(database: D1Database): Promise<void> {
  await database.prepare(`INSERT INTO client_viewer_source_authorizations(
    id,authorization_version,workspace_id,identity_id,legacy_account_id,legacy_identity_id,principal_issuer,
    principal_subject,project_id,association_id,association_version,viewer_model_id,viewer_model_version_id,
    authorization_expires_at,idempotency_key,request_fingerprint,status,share_id,created_at,updated_at)
    VALUES('source-auth-one',1,'workspace-one','identity-one','account-one','legacy-identity-one',
      'https://clients.example.test','subject-one','project-one','association-one',1,'viewer-model-one',
      'viewer-version-one',datetime('now','+15 minutes'),'share-create-key-0001','fingerprint','active',
      'share-one',datetime('now'),datetime('now'))`).run();
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(active.splice(0).map(instance => instance.dispose()));
});

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

  it("denies Viewer session authorization while the client root is revoked", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_root_access_policies
      VALUES('project-alpha:primary','organization','pa-org-one','revoked')`).run();
    expect(await authorizeClientViewerAssociation({ ...env,
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true" }, request)).toBeNull();
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
    expect(await database.prepare(`SELECT association_version FROM viewer_session_revocation_outbox
      WHERE association_id='association-one'`).first("association_version")).toBe(1);
    const next = { ...input, idempotencyKey: "association-retry-key-0002", fingerprint: "next-request-fingerprint" };
    expect((await persistViewerAssociation(next)).replayed).toBe(false);
    expect(await database.prepare("SELECT association_version FROM viewer_model_associations WHERE id='association-one'")
      .first("association_version")).toBe(3);
    expect((await database.prepare(`SELECT association_version FROM viewer_session_revocation_outbox
      WHERE association_id='association-one' ORDER BY association_version`).all()).results)
      .toEqual([{ association_version: 1 }, { association_version: 2 }]);
  });

  it("delivers exact version-bound session revocation and retains bounded retry state", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO viewer_session_revocation_outbox
      (id,association_id,association_version,idempotency_key)
      VALUES('outbox-one','association-one',1,'viewer-session-revoke:outbox-one')`).run();
    const seen: Array<{ method: string; body: unknown; key: string }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        method: init?.method || "", body: JSON.parse(String(init?.body)),
        key: (init?.headers as Record<string, string>)["Idempotency-Key"] || "",
      });
      return Response.json({
        sourceAuthorization: { type: "model_association", id: "association-one", version: 1 },
        revokedGrants: 2, revokedSessions: 3,
      });
    });
    expect(await drainViewerSessionRevocations(env, { fetcher: fetcher as typeof fetch }))
      .toEqual({ delivered: 1, pending: 0 });
    expect(seen).toEqual([{
      method: "DELETE",
      body: { sourceAuthorization: { type: "model_association", id: "association-one", version: 1 } },
      key: "viewer-session-revoke:outbox-one",
    }]);
    expect(await database.prepare("SELECT state,attempt_count,last_error_code FROM viewer_session_revocation_outbox")
      .first()).toMatchObject({ state: "delivered", attempt_count: 1, last_error_code: null });

    await database.prepare(`INSERT INTO viewer_session_revocation_outbox
      (id,association_id,association_version,idempotency_key)
      VALUES('outbox-two','association-one',2,'viewer-session-revoke:outbox-two')`).run();
    const unavailable = vi.fn(async () => new Response("unavailable", { status: 503 }));
    expect(await drainViewerSessionRevocations(env, { fetcher: unavailable as typeof fetch }))
      .toEqual({ delivered: 0, pending: 1 });
    const retry = await database.prepare(`SELECT state,attempt_count,last_error_code,
      datetime(next_attempt_at)>datetime('now') delayed FROM viewer_session_revocation_outbox WHERE id='outbox-two'`).first();
    expect(retry).toMatchObject({ state: "pending", attempt_count: 1, last_error_code: "unavailable", delayed: 1 });
  });

  it("binds every issued Viewer session to the exact association version", async () => {
    const { env } = await fixture();
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/models") return Response.json({ models: [{
        id: "viewer-model-one", title: "Point cloud", provider: "webodm", status: "ready", available: true,
        activeVersion: { id: "viewer-version-one", providerVersionId: "provider-version-one",
          createdAt: expires, updatedAt: expires }, updatedAt: expires,
      }] });
      expect(path).toBe("/api/v1/models/viewer-model-one/sessions");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        sourceAuthorization: { type: "model_association", id: "association-one", version: 1 },
      });
      expect(JSON.parse(String(init?.body)).permissions).not.toHaveProperty("personalMeasurements");
      return Response.json({
        grant: "00000000-0000-4000-8000-000000000001", grantExpiresAt: expires, sessionTtlSeconds: 900,
        modelVersionId: "viewer-version-one", redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
        embedUrl: "https://viewer.example.test/session/00000000-0000-4000-8000-000000000001",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const association = await env.DELIVERY_DB.prepare("SELECT * FROM viewer_model_associations WHERE id='association-one'")
      .first<import("../src/worker/viewer-integration").AssociationRow>();
    await expect(issueViewerSession({
      env, actorId: "staff-one", audience: "ops", association: association!,
      idempotencyKey: "viewer-session-key-source-0001", displayUnits: "imperial",
    })).resolves.toMatchObject({ grant: "00000000-0000-4000-8000-000000000001" });
  });

  it("attests only the exact authorized individual client subject", async () => {
    const { env } = await fixture();
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const sessionBodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/models") return Response.json({ models: [{
        id: "viewer-model-one", title: "Point cloud", provider: "webodm", status: "ready", available: true,
        activeVersion: { id: "viewer-version-one", providerVersionId: "provider-version-one",
          createdAt: expires, updatedAt: expires }, updatedAt: expires,
      }] });
      sessionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        grant: "00000000-0000-4000-8000-000000000001", grantExpiresAt: expires, sessionTtlSeconds: 900,
        modelVersionId: "viewer-version-one", redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
        embedUrl: "https://viewer.example.test/session/00000000-0000-4000-8000-000000000001",
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(issueClientViewerSession(env, request)).resolves.toMatchObject({ ok: true, modelId: "viewer-model-one" });
    expect(sessionBodies).toHaveLength(1);
    expect(sessionBodies[0]).toMatchObject({
      subject: "client:identity-one",
      audience: "client",
      modelVersionId: "viewer-version-one",
      permissions: { view: true, measure: true, cameras: true, download: false, personalMeasurements: true },
      sourceAuthorization: { type: "model_association", id: "association-one", version: 1 },
    });
    expect(Date.parse(String(sessionBodies[0]?.authorizationExpiresAt))).toBeLessThanOrEqual(Date.now() + 20 * 60_000);

    const callsBeforeDenial = fetcher.mock.calls.length;
    await expect(issueClientViewerSession(env, {
      ...request,
      principalSubject: "different-person",
      idempotencyKey: "viewer-session-key-denied-0001",
    })).resolves.toEqual({ ok: false, protocolVersion: 1, code: "denied" });
    expect(fetcher).toHaveBeenCalledTimes(callsBeforeDenial);
  });

  it("fails closed for an explicit entitlement denial", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_entitlements VALUES (
      'workspace-one','identity-one','delivery.view','deny','active',NULL,
      datetime('now','-1 minute'),NULL,'project','pa-project-one')`).run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("requires a live authenticated-client project or task grant", async () => {
    const { database, env } = await fixture();
    await database.prepare("UPDATE viewer_client_grants SET status='revoked',revoked_at=datetime('now')").run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
    await database.prepare(`INSERT INTO viewer_client_grants VALUES (
      'viewer-task-grant','account-one','project-one','task','association-one',0,1,1,0,
      datetime('now','+10 minutes'),1,'active','staff-one',datetime('now'),datetime('now'),NULL,NULL,NULL)`).run();
    const task = await authorizeClientViewerAssociation(env, request);
    expect(task).toMatchObject({ id: "association-one" });
    expect(Date.parse(task!.authorization_expires_at!)).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    await database.prepare("UPDATE viewer_client_grants SET authorization_expires_at=datetime('now','-1 minute') WHERE id='viewer-task-grant'").run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("fails closed for a live identity denial", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_identity_denials VALUES (
      'identity-one','active',NULL,datetime('now','-1 minute'),NULL,'global',NULL,NULL)`).run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("fails closed for an active eligibility blacklist entry on every Viewer authorization", async () => {
    const { database, env } = await fixture();
    await database.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks VALUES (
      'block-one','email',NULL,NULL,'client@example.test','active',datetime('now','-1 minute'),NULL)`).run();
    expect(await authorizeClientViewerAssociation(env, request)).toBeNull();
  });

  it("requires the distinct viewer.share.create opt-in with deny precedence", async () => {
    const { database, env } = await fixture();
    expect(await authorizeClientViewerAssociation(env, request, "viewer.share.create")).toBeNull();
    await grantViewerSharing(database);
    expect(await authorizeClientViewerAssociation(env, request, "viewer.share.create")).toMatchObject({ id: "association-one" });
    await database.prepare(`INSERT INTO portal_v2_entitlements VALUES (
      'workspace-one','identity-one','viewer.share.create','deny','active',NULL,
      datetime('now','-1 minute'),NULL,'project','pa-project-one')`).run();
    expect(await authorizeClientViewerAssociation(env, request, "viewer.share.create")).toBeNull();
  });

  it("introspects the exact live authorization and fails after version drift or a feature rollback", async () => {
    const { database, env } = await fixture();
    await grantViewerSharing(database);
    await addSourceAuthorization(database);
    const input = { authorizationId: "source-auth-one", authorizationVersion: 1, subject: "subject-one",
      modelId: "viewer-model-one", shareId: "share-one" };
    expect(await introspectClientViewerSourceAuthorization(env, input)).toMatchObject({
      active: true, authorizationId: input.authorizationId, authorizationVersion: input.authorizationVersion,
      subject: input.subject, modelId: input.modelId,
    });
    expect(await introspectClientViewerSourceAuthorization({ ...env, VIEWER_PUBLIC_SHARES_ENABLED: "false" }, input))
      .toMatchObject({ active: false });
    await database.prepare("UPDATE viewer_model_associations SET association_version=2 WHERE id='association-one'").run();
    expect(await introspectClientViewerSourceAuthorization(env, input)).toMatchObject({ active: false });
    expect(await introspectClientViewerSourceAuthorization(env, input)).toMatchObject({ active: false });
    expect(await database.prepare("SELECT COUNT(*) FROM audit_events WHERE action='viewer.client_share.authorization_denied'")
      .first<number>("COUNT(*)")).toBe(1);
    expect(await introspectClientViewerSourceAuthorization(env, { ...input, modelId: "other-model" }))
      .toMatchObject({ active: false });
  });

  it("does not let another identity in the workspace enumerate or revoke the creator's shares", async () => {
    const { database, env } = await fixture();
    await grantViewerSharing(database);
    await addSourceAuthorization(database);
    await applySql(database, `
      INSERT INTO portal_v2_identities VALUES ('identity-two','https://clients.example.test','subject-two','other@example.test','active',NULL);
      INSERT INTO portal_v2_workspace_memberships VALUES ('workspace-one','identity-two','active',NULL,datetime('now','+20 minutes'));
      INSERT INTO client_identity_links VALUES ('legacy-identity-two','account-one',NULL);
      INSERT INTO client_account_members VALUES ('account-one','legacy-identity-two','manager',NULL);
      INSERT INTO portal_v2_entitlements VALUES ('workspace-one','identity-two','delivery.view','allow','active',NULL,
        datetime('now','-1 minute'),NULL,'workspace','workspace-one');
      INSERT INTO portal_v2_entitlements VALUES ('workspace-one','identity-two','viewer.share.create','allow','active',NULL,
        datetime('now','-1 minute'),NULL,'workspace','workspace-one');
    `);
    const other = {
      protocolVersion: 1 as const, workspaceId: request.workspaceId, identityId: "identity-two",
      legacyAccountId: request.legacyAccountId, legacyIdentityId: "legacy-identity-two",
      principalIssuer: request.principalIssuer, principalSubject: "subject-two",
      projectId: request.projectId, associationId: request.associationId,
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ shares: [{
      id: "share-one", modelId: "viewer-model-one", versionPolicy: "latest", modelVersionId: null,
      hasPassword: false, permissions: { view: true, measure: true, cameras: true, download: false },
      label: null, createdBy: "identity-one", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, revokedBy: null, revokeReason: null, accessCount: 0, lastAccessedAt: null,
      shareClass: "client", sourceAuthorization: { type: "client_grant", id: "source-auth-one", version: 1,
        subject: "subject-one", expiresAt: null },
    }] })));
    expect(await listClientViewerShares(env, other)).toEqual({ ok: true, protocolVersion: 1, shares: [] });
    expect(await revokeClientViewerShare(env, { ...other, shareId: "share-one", idempotencyKey: "share-revoke-key-0002" }))
      .toEqual({ ok: false, protocolVersion: 1, code: "not_found" });
  });

  it("derives a service idempotency namespace and replays without storing access codes or bearer URLs", async () => {
    const { database, env } = await fixture();
    await grantViewerSharing(database);
    const serviceKeys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      serviceKeys.push(headers["Idempotency-Key"]!);
      const body = JSON.parse(String(init?.body));
      return Response.json({
        share: {
          id: "share-created", modelId: "viewer-model-one", versionPolicy: "latest", modelVersionId: null,
          hasPassword: true, permissions: { view: true, measure: true, cameras: true, download: false },
          label: "Engineer", createdBy: "identity-one", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          expiresAt: body.expiresAt, revokedAt: null, revokedBy: null, revokeReason: null, accessCount: 0, lastAccessedAt: null,
          displayUnits: "imperial", shareClass: "client", sourceAuthorization: body.sourceAuthorization,
        },
        token: "secure_client_share_token_00000001",
        viewUrl: "https://viewer.example.test/view/secure_client_share_token_00000001",
        embedUrl: "https://viewer.example.test/embed/secure_client_share_token_00000001",
      }, { status: 201 });
    }));
    const createRequest = {
      protocolVersion: 1 as const, workspaceId: request.workspaceId, identityId: request.identityId,
      legacyAccountId: request.legacyAccountId, legacyIdentityId: request.legacyIdentityId,
      principalIssuer: request.principalIssuer, principalSubject: request.principalSubject,
      projectId: request.projectId, associationId: request.associationId,
      idempotencyKey: "browser-chosen-key-0001", label: "Engineer", expiresAt: null,
      password: "model-passcode", displayUnits: "imperial" as const,
    };
    expect(await createClientViewerShare(env, createRequest)).toMatchObject({ ok: true, replayed: false });
    expect(await createClientViewerShare(env, createRequest)).toMatchObject({ ok: true, replayed: true });
    expect(serviceKeys).toHaveLength(2);
    expect(serviceKeys[0]).toBe(serviceKeys[1]);
    expect(serviceKeys[0]).toMatch(/^client-share-[A-Za-z0-9_-]{43}$/);
    expect(serviceKeys[0]!).not.toContain(createRequest.idempotencyKey);
    expect(await createClientViewerShare(env, { ...createRequest, password: "different-passcode" }))
      .toEqual({ ok: false, protocolVersion: 1, code: "idempotency_conflict" });
    const stored = await database.prepare("SELECT request_fingerprint FROM client_viewer_source_authorizations")
      .first<string>("request_fingerprint");
    expect(stored).not.toContain("model-passcode");
    const audits = await database.prepare("SELECT details_json FROM audit_events WHERE action LIKE 'viewer.client_share.%'")
      .all<{ details_json: string }>();
    expect(JSON.stringify(audits.results)).not.toMatch(/model-passcode|secure_client_share_token|viewer\.example\.test/);
  });

  it("prunes only old revocation receipts and retains source authorization tombstones", async () => {
    const { database, env } = await fixture();
    await addSourceAuthorization(database);
    await database.prepare("UPDATE client_viewer_source_authorizations SET status='revoked',revoked_at=datetime('now','-1 year')").run();
    await database.prepare(`INSERT INTO client_viewer_share_revocation_receipts VALUES
      ('identity-one','old-receipt-key-0001','share-one','{}',datetime('now','-91 days')),
      ('identity-one','new-receipt-key-0002','share-two','{}',datetime('now'))`).run();
    expect(await pruneClientViewerShareReceipts(env)).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) FROM client_viewer_share_revocation_receipts").first<number>("COUNT(*)")).toBe(2);
    expect(await database.prepare("SELECT response_json FROM client_viewer_share_revocation_receipts WHERE idempotency_key='old-receipt-key-0001'")
      .first("response_json")).toBeNull();
    expect(await database.prepare("SELECT response_json FROM client_viewer_share_revocation_receipts WHERE idempotency_key='new-receipt-key-0002'")
      .first<string>("response_json")).toBe("{}");
    expect(await database.prepare("SELECT COUNT(*) FROM client_viewer_source_authorizations").first<number>("COUNT(*)")).toBe(1);
  });

  it("keeps redacted revocation keys conflict-safe and reconstructs same-share replay", async () => {
    const { database, env } = await fixture();
    await addSourceAuthorization(database);
    await database.prepare(`INSERT INTO client_viewer_share_revocation_receipts
      (identity_id,idempotency_key,share_id,response_json,created_at)
      VALUES('identity-one','revoke-browser-key-0001','share-one',NULL,datetime('now','-91 days'))`).run();
    const serviceKeys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      serviceKeys.push((init?.headers as Record<string, string>)["Idempotency-Key"]!);
      return Response.json({ share: {
        id: "share-one", modelId: "viewer-model-one", versionPolicy: "latest", modelVersionId: null,
        hasPassword: false, permissions: { view: true, measure: true, cameras: true, download: false }, label: null,
        createdBy: "identity-one", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: null, revokedAt: new Date().toISOString(), revokedBy: "ops-v1", revokeReason: "client_owner_revoked",
        accessCount: 0, lastAccessedAt: null, shareClass: "client",
        sourceAuthorization: { type: "client_grant", id: "source-auth-one", version: 1, subject: "subject-one", expiresAt: null },
      } });
    }));
    const authorization = {
      protocolVersion: 1 as const, workspaceId: request.workspaceId, identityId: request.identityId,
      legacyAccountId: request.legacyAccountId, legacyIdentityId: request.legacyIdentityId,
      principalIssuer: request.principalIssuer, principalSubject: request.principalSubject,
      projectId: request.projectId, associationId: request.associationId,
    };
    expect(await revokeClientViewerShare(env, { ...authorization, shareId: "share-one", idempotencyKey: "revoke-browser-key-0001" }))
      .toMatchObject({ ok: true, replayed: true });
    expect(serviceKeys[0]).toMatch(/^client-share-revoke-[A-Za-z0-9_-]{43}$/);
    expect(serviceKeys[0]).not.toContain("revoke-browser-key-0001");
    expect(await revokeClientViewerShare(env, { ...authorization, shareId: "share-two", idempotencyKey: "revoke-browser-key-0001" }))
      .toEqual({ ok: false, protocolVersion: 1, code: "idempotency_conflict" });
    expect(serviceKeys).toHaveLength(1);
  });

  it("stays unavailable until both rollout gates are enabled", async () => {
    const { env } = await fixture();
    expect(await authorizeClientViewerAssociation({ ...env, CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "false" }, request))
      .toBeNull();
    expect(await authorizeClientViewerAssociation({ ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" }, request))
      .toBeNull();
  });
});
