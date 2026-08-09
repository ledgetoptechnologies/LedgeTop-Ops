import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  auditStatement: vi.fn(),
  sendNotificationMail: vi.fn(),
  sendAdminAlert: vi.fn(),
}));

vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  requirePermission: mocks.requirePermission,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  auditStatement: mocks.auditStatement,
}));
vi.mock("../src/worker/mailer", () => ({ sendNotificationMail: mocks.sendNotificationMail }));
vi.mock("../src/worker/alerts", () => ({ sendAdminAlert: mocks.sendAdminAlert }));

import {
  createClientFolderGrant,
  processClientFolderGrantNotifications,
  revokeClientFolderGrant,
} from "../src/worker/client-folder-grants";
import { d1ClientPortalRepository } from "../../client/src/worker/client-portal/repository";

const principal = { id: "initial-beau-koltz", email: "admin@example.test", displayName: "Admin", accessSubject: "access-admin", projectAlphaUserId: "3" };
const request = new Request("https://ops.example.test/api/client-portal/accounts/account-a/folder-grants", { method: "POST" });

describe("direct authenticated client folder grants", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: any;
  let folderAssociations: Array<{
    division_id: string;
    r2_prefix: string;
    project_alpha_client_id: string | null;
    project_alpha_organization_id: string | null;
  }>;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "internal-folder-grants" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const migrationsDirectory = fileURLToPath(new URL("../../client/migrations/", import.meta.url));
    for (const migration of readdirSync(migrationsDirectory).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(`../../client/migrations/${migration}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
      if (migration === "0107_thumbnail_cleanup_jobs.sql" || migration === "0111_thumbnail_render_provenance.sql") { await db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ")); continue; }
      const statements = sql.split(/;\s*(?:\n|$)/)
        .map(statement => statement.replace(/^\s*--.*$/gm, "").trim())
        .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement))
        .map(statement => db.prepare(statement));
      if (migration === "0103_client_portal_workspace.sql") await db.batch(statements);
      else for (const statement of statements) await statement.run();
    }
    await db.prepare("PRAGMA foreign_keys = ON").run();
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id) VALUES('account-a','Acme','active','pa-client-a','pa-org-a')"),
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id) VALUES('account-b','Other','active','pa-client-b','pa-org-b')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('identity-a','account-a','https://issuer.test','subject-a','client-a@example.test')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('identity-b','account-b','https://issuer.test','subject-b','client-b@example.test')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-a','identity-a','manager')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-b','identity-b','manager')"),
      db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','\"etag-a\"',12,'2026-08-02T12:00:00Z','image/jpeg','image')"),
      db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('Jobs/Clients/Acme/Second/report.pdf','etag-b',20,'2026-08-02T12:00:00Z','application/pdf','pdf')"),
      db.prepare("INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status,processed_at) VALUES('Jobs/Clients/Acme/Delivery/photo.jpg','etag-a','Jobs/Clients/Acme/Delivery/',44.5,-88.1,'ready',datetime('now'))"),
    ]);
    const opsDb = {
      withSession() { return this; },
      prepare(sql: string) {
        if (!sql.includes("FROM project_folders")) throw new Error(`unexpected-ops-query:${sql}`);
        return { async all() { return { results: folderAssociations }; } };
      },
      async batch() { return []; },
    };
    env = {
      DELIVERY_DB: db,
      DELIVERY_BASE_URL: "https://client.example.test",
      OPS_DB: opsDb,
    };
  });

  beforeEach(() => {
    folderAssociations = [
      { division_id: "division-a", r2_prefix: "Jobs/Clients/Acme/", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
      { division_id: "division-a", r2_prefix: "Jobs/Clients/Acme/Delivery/", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
    ];
    mocks.requirePermission.mockReset().mockResolvedValue(undefined);
    mocks.auditStatement.mockReset().mockResolvedValue({});
    mocks.sendNotificationMail.mockReset().mockResolvedValue(undefined);
    mocks.sendAdminAlert.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => miniflare.dispose());

  it("creates only a client-scoped grant and suppresses mail when revoked during the grace window", async () => {
    const created = await createClientFolderGrant(env, request, principal, {
      accountId: "account-a",
      divisionId: "division-a",
      r2Prefix: "Jobs/Clients/Acme/Delivery",
      recipientIdentityId: "identity-a",
    }, "folder-grant-create-0001");
    expect(created).toMatchObject({ accountId: "account-a", r2Prefix: "Jobs/Clients/Acme/Delivery/", version: 1, idempotentReplay: false });
    expect(mocks.requirePermission.mock.calls[0]?.slice(1)).toEqual([principal, "delivery.share.create", { divisionId: "division-a" }, true]);
    expect(await db.prepare("SELECT scope_type FROM client_folder_associations WHERE id=?").bind(created.id).first("scope_type")).toBe("client");
    expect(await db.prepare("SELECT division_id FROM client_folder_associations WHERE id=?").bind(created.id).first("division_id")).toBe("division-a");
    expect(await db.prepare("SELECT COUNT(*) count FROM shares").first("count")).toBe(0);
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(created.id).first("status")).toBe("pending");
    const session = { accountId: "account-a", displayName: "Acme", identityId: "identity-a", role: "manager" as const, canViewBilling: false };
    expect((await d1ClientPortalRepository.listPastDeliveries(env, session)).files.map(file => file.key)).toContain("Jobs/Clients/Acme/Delivery/photo.jpg");
    expect(await d1ClientPortalRepository.listPastDeliveryLocations(env, session)).toEqual({
      points: [{ latitude: 44.5, longitude: -88.1, imageCount: 1 }],
      imageCount: 1,
      truncated: false,
    });

    await revokeClientFolderGrant(env, request, principal, "account-a", created.grantId);
    expect(mocks.requirePermission.mock.calls.at(-1)?.slice(1)).toEqual([principal, "delivery.share.revoke", { divisionId: "division-a" }, true]);
    expect((await d1ClientPortalRepository.listPastDeliveries(env, session)).files.map(file => file.key)).not.toContain("Jobs/Clients/Acme/Delivery/photo.jpg");
    expect(await d1ClientPortalRepository.listPastDeliveryLocations(env, session)).toEqual({ points: [], imageCount: 0, truncated: false });
    await db.prepare("UPDATE client_folder_grant_notifications SET next_attempt_at=datetime('now','-1 minute') WHERE association_id=?").bind(created.id).run();
    await processClientFolderGrantNotifications(env);
    expect(mocks.sendNotificationMail).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(created.id).first("status")).toBe("suppressed");
    expect(await db.prepare("SELECT revoked_at IS NOT NULL revoked FROM client_folder_associations WHERE id=?").bind(created.id).first("revoked")).toBe(1);
  });

  it("delivers a valid grant once after grace using only authenticated portal navigation and replays idempotently", async () => {
    const input = {
      accountId: "account-a",
      divisionId: "division-a",
      r2Prefix: "Jobs/Clients/Acme/Second/",
      recipientIdentityId: "identity-a",
    };
    const created = await createClientFolderGrant(env, request, principal, input, "folder-grant-create-0002");
    const replay = await createClientFolderGrant(env, request, principal, input, "folder-grant-create-0002");
    expect(replay).toMatchObject({ id: created.id, grantId: created.grantId, idempotentReplay: true });
    expect(await db.prepare("SELECT COUNT(*) count FROM client_folder_grant_notifications WHERE association_id=?").bind(created.id).first("count")).toBe(1);

    await db.prepare("UPDATE client_folder_grant_notifications SET next_attempt_at=datetime('now','-1 minute') WHERE association_id=?").bind(created.id).run();
    await processClientFolderGrantNotifications(env);
    await processClientFolderGrantNotifications(env);
    expect(mocks.sendNotificationMail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendNotificationMail.mock.calls[0]![1];
    expect(mail.to).toBe("client-a@example.test");
    expect(mail.text).toContain("https://client.example.test/portal/deliveries");
    expect(JSON.stringify(mail)).not.toMatch(/\/s\/|publicId|token|signature|expires/i);
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(created.id).first("status")).toBe("sent");
  });

  it("suppresses a superseded grant and does not notify for a narrowing replacement", async () => {
    const broad = await createClientFolderGrant(env, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/", recipientIdentityId: "identity-a",
    }, "folder-grant-broad-00001");
    const narrow = await createClientFolderGrant(env, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/Delivery/", grantId: broad.grantId, recipientIdentityId: "identity-a",
    }, "folder-grant-narrow-0001");
    expect(narrow.version).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) count FROM client_folder_grant_notifications WHERE association_id=?").bind(narrow.id).first("count")).toBe(0);
    await db.prepare("UPDATE client_folder_grant_notifications SET next_attempt_at=datetime('now','-1 minute') WHERE association_id=?").bind(broad.id).run();
    await processClientFolderGrantNotifications(env);
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(broad.id).first("status")).toBe("suppressed");
    expect(mocks.sendNotificationMail).not.toHaveBeenCalled();
  });

  it("rejects a recipient from another client and fails explicitly without DELIVERY_DB", async () => {
    await expect(createClientFolderGrant(env, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/Cross/", recipientIdentityId: "identity-b",
    }, "folder-grant-cross-00001")).rejects.toMatchObject({ status: 409 });
    await expect(createClientFolderGrant({} as any, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/Missing/",
    }, "folder-grant-missing-db")).rejects.toThrow("delivery-db-binding-required");
    await expect(processClientFolderGrantNotifications({} as any)).rejects.toThrow("delivery-db-binding-required");
  });

  it("derives the longest-prefix division and rejects forged, missing, ambiguous, or wrong-client associations", async () => {
    folderAssociations = [
      { division_id: "division-a", r2_prefix: "Jobs/Clients/Acme/", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
      { division_id: "division-b", r2_prefix: "Jobs/Clients/Acme/Delivery/", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
    ];
    const scopedInput = {
      accountId: "account-a",
      divisionId: "division-a",
      r2Prefix: "Jobs/Clients/Acme/Delivery/Scoped/",
    };
    await expect(createClientFolderGrant(env, request, principal, scopedInput, "folder-grant-forged-0001"))
      .rejects.toMatchObject({ status: 409 });
    expect(mocks.requirePermission).not.toHaveBeenCalled();

    const created = await createClientFolderGrant(env, request, principal, { ...scopedInput, divisionId: "division-b" }, "folder-grant-derived-0001");
    expect(mocks.requirePermission).toHaveBeenLastCalledWith(env, principal, "delivery.share.create", { divisionId: "division-b" }, true);
    expect(mocks.auditStatement).toHaveBeenLastCalledWith(env, request, principal, "client.folder.granted", "client_folder_grant", created.grantId, "division-b", expect.any(Object));
    expect(await db.prepare("SELECT division_id FROM client_folder_associations WHERE id=?").bind(created.id).first("division_id")).toBe("division-b");
    await db.prepare("UPDATE client_folder_associations SET division_id='forged-division' WHERE id=?").bind(created.id).run();
    await revokeClientFolderGrant(env, request, principal, "account-a", created.grantId);
    expect(mocks.requirePermission).toHaveBeenLastCalledWith(env, principal, "delivery.share.revoke", { divisionId: "division-b" }, true);
    expect(mocks.auditStatement).toHaveBeenLastCalledWith(env, request, principal, "client.folder.revoked", "client_folder_grant", created.grantId, "division-b", expect.objectContaining({ storedDivisionId: "forged-division" }));

    await expect(createClientFolderGrant(env, request, principal, {
      ...scopedInput,
      accountId: "account-b",
      divisionId: "division-b",
    }, "folder-grant-wrong-client-0001")).rejects.toMatchObject({ status: 404 });
    await expect(createClientFolderGrant(env, request, principal, {
      ...scopedInput,
      r2Prefix: "Jobs/Clients/Unmapped/",
    }, "folder-grant-unmapped-0001")).rejects.toMatchObject({ status: 404 });

    folderAssociations = [
      { division_id: "division-a", r2_prefix: "Jobs/Clients/Acme", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
      { division_id: "division-b", r2_prefix: "Jobs/Clients/Acme/", project_alpha_client_id: "pa-client-a", project_alpha_organization_id: "pa-org-a" },
    ];
    await expect(createClientFolderGrant(env, request, principal, {
      ...scopedInput,
      r2Prefix: "Jobs/Clients/Acme/Ambiguous/",
    }, "folder-grant-ambiguous-0001")).rejects.toMatchObject({ status: 409 });
  });

  it("suppresses when no indexed content is newly visible or the recipient membership is revoked", async () => {
    const empty = await createClientFolderGrant(env, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/Empty/", recipientIdentityId: "identity-a",
    }, "folder-grant-empty-00001");
    await db.prepare("UPDATE client_folder_grant_notifications SET next_attempt_at=datetime('now','-1 minute') WHERE association_id=?").bind(empty.id).run();
    await processClientFolderGrantNotifications(env);
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(empty.id).first("status")).toBe("suppressed");

    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('Jobs/Clients/Acme/Third/new.txt','etag-c',8,'2026-08-02T12:00:00Z','text/plain','text')").run();
    const revokedRecipient = await createClientFolderGrant(env, request, principal, {
      accountId: "account-a", divisionId: "division-a", r2Prefix: "Jobs/Clients/Acme/Third/", recipientIdentityId: "identity-a",
    }, "folder-grant-member-0001");
    await db.batch([
      db.prepare("UPDATE client_account_members SET revoked_at=datetime('now') WHERE account_id='account-a' AND identity_id='identity-a'"),
      db.prepare("UPDATE client_folder_grant_notifications SET next_attempt_at=datetime('now','-1 minute') WHERE association_id=?").bind(revokedRecipient.id),
    ]);
    await processClientFolderGrantNotifications(env);
    expect(await db.prepare("SELECT status FROM client_folder_grant_notifications WHERE association_id=?").bind(revokedRecipient.id).first("status")).toBe("suppressed");
    expect(mocks.sendNotificationMail).not.toHaveBeenCalled();
    await db.prepare("UPDATE client_account_members SET revoked_at=NULL WHERE account_id='account-a' AND identity_id='identity-a'").run();
  });
});
