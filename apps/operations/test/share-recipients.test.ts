import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import recipientMigration from "../../client/migrations/0126_delivery_share_recipient_snapshots.sql?raw";
import { latestShareAudienceSnapshot, resolveShareAudience, searchShareRecipients, shareAudienceSnapshotStatements, shareDirectoryRecipientsEnabled } from "../src/worker/share-recipients";
import type { Env } from "../src/worker/types";

describe("public-share directory recipients", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "share-recipient-test" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE shares(id TEXT PRIMARY KEY,recipient_email TEXT,share_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT NOT NULL,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,complete INTEGER NOT NULL);
      CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT NOT NULL);
      CREATE TABLE portal_v2_directory_entities(workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,entity_type TEXT NOT NULL,public_id TEXT NOT NULL,parent_public_id TEXT,display_name TEXT NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_scope_type TEXT NOT NULL,owner_public_id TEXT NOT NULL,r2_prefix TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE pa_portal_principals(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,email_hint TEXT NOT NULL,display_name TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(workspace_id,public_id));
      CREATE TABLE pa_portal_entitlement_intents(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,principal_public_id TEXT NOT NULL,capability TEXT NOT NULL,effect TEXT NOT NULL,scope_type TEXT NOT NULL,scope_public_id TEXT NOT NULL,status TEXT NOT NULL,valid_from TEXT NOT NULL,expires_at TEXT);
    `.replace(/\s*\n\s*/g, " "));
    await db.exec(recipientMigration.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces(id,status) VALUES('workspace-acme','active')"),
      db.prepare("INSERT INTO portal_v2_directory_generations VALUES('generation-7','workspace-acme','active',1)"),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-acme','generation-7')"),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-acme','generation-7','organization','org-acme',NULL,'Acme',1)"),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-acme','generation-7','department','dept-field','org-acme','Field Team',1)"),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-acme','generation-7','project','project-north','dept-field','North Project',1)"),
      db.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-north','workspace-acme','project','project-north','jobs/acme/north/','active')"),
      db.prepare("INSERT INTO pa_portal_principals VALUES('workspace-acme','principal-org','MANAGER@example.test','Org Manager','active')"),
      db.prepare("INSERT INTO pa_portal_principals VALUES('workspace-acme','principal-duplicate','manager@example.test','Duplicate Manager','active')"),
      db.prepare("INSERT INTO pa_portal_principals VALUES('workspace-acme','principal-denied','denied@example.test','Denied User','active')"),
      db.prepare("INSERT INTO pa_portal_principals VALUES('workspace-acme','principal-other','other@example.test','Other Project','active')"),
      db.prepare("INSERT INTO pa_portal_entitlement_intents VALUES('workspace-acme','allow-org','principal-org','delivery.view','allow','organization','org-acme','active','2020-01-01',NULL)"),
      db.prepare("INSERT INTO pa_portal_entitlement_intents VALUES('workspace-acme','allow-dup','principal-duplicate','delivery.view','allow','project','project-north','active','2020-01-01',NULL)"),
      db.prepare("INSERT INTO pa_portal_entitlement_intents VALUES('workspace-acme','allow-denied','principal-denied','delivery.view','allow','organization','org-acme','active','2020-01-01',NULL)"),
      db.prepare("INSERT INTO pa_portal_entitlement_intents VALUES('workspace-acme','deny-project','principal-denied','delivery.view','deny','project','project-north','active','2020-01-01',NULL)"),
      db.prepare("INSERT INTO pa_portal_entitlement_intents VALUES('workspace-acme','allow-other','principal-other','delivery.view','allow','project','project-south','active','2020-01-01',NULL)"),
    ]);
    env = { DELIVERY_DB: db, DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED: "true" } as Env;
  });

  afterAll(async () => miniflare.dispose());

  it("is exact-string feature gated", () => {
    expect(shareDirectoryRecipientsEnabled({})).toBe(false);
    expect(shareDirectoryRecipientsEnabled({ DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED: "TRUE" })).toBe(false);
    expect(shareDirectoryRecipientsEnabled(env)).toBe(true);
  });

  it("returns only deduped active principals whose scoped delivery access covers the exact folder owner", async () => {
    const result = await searchShareRecipients(env, "jobs/acme/north/photos/", "manager");
    expect(result.audiences).toEqual([
      { audienceType: "principal", publicId: "principal-duplicate", displayName: "Duplicate Manager", email: "manager@example.test", recipientCount: 1 },
    ]);
    expect(JSON.stringify(result)).not.toContain("principal-denied");
    expect(JSON.stringify(result)).not.toContain("principal-other");
  });

  it("does not resolve recipients from an overlapping secondary native workspace", async () => {
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-secondary','active','project-alpha:secondary')"),
      db.prepare("INSERT INTO portal_v2_directory_generations VALUES('generation-secondary','workspace-secondary','active',1)"),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-secondary','generation-secondary')"),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-secondary','generation-secondary','project','project-north',NULL,'Secondary Project',1)"),
      db.prepare("INSERT INTO portal_v2_folder_bindings VALUES('binding-secondary','workspace-secondary','project','project-north','jobs/acme/north/','active')"),
    ]);
    expect((await resolveShareAudience(env, "jobs/acme/north/", "principal", "principal-duplicate")).workspaceId).toBe("workspace-acme");
    await db.prepare("UPDATE portal_v2_folder_bindings SET status='suspended' WHERE id='binding-north'").run();
    try { await expect(searchShareRecipients(env, "jobs/acme/north/", "manager")).rejects.toMatchObject({ status: 409 }); }
    finally { await db.prepare("UPDATE portal_v2_folder_bindings SET status='active' WHERE id='binding-north'").run(); }
  });

  it("offers only the exact folder owner's ancestor organization/department/client/project path", async () => {
    const result = await searchShareRecipients(env, "jobs/acme/north/", "Acme");
    expect(result.audiences).toContainEqual({ audienceType: "organization", publicId: "org-acme", displayName: "Acme" });
  });

  it("resolves and immutably snapshots a deduped authorized group audience", async () => {
    const audience = await resolveShareAudience(env, "jobs/acme/north/", "organization", "org-acme");
    expect(audience).toMatchObject({
      audienceType: "organization",
      audiencePublicId: "org-acme",
      audienceDisplayName: "Acme",
    });
    expect(audience.recipients).toEqual([
      { principalPublicId: "principal-duplicate", displayName: "Duplicate Manager", email: "manager@example.test" },
    ]);
    await db.prepare("INSERT INTO shares(id,recipient_email,share_version) VALUES('share-a',?,2)").bind(audience.recipients[0]!.email).run();
    await db.batch(shareAudienceSnapshotStatements(env, "share-a", 2, audience, "staff-a"));
    expect(await db.prepare("SELECT audience_type,audience_public_id FROM delivery_share_audience_snapshots WHERE share_id='share-a'").first())
      .toMatchObject({ audience_type: "organization", audience_public_id: "org-acme" });
    expect((await db.prepare("SELECT recipient_principal_public_id FROM delivery_share_recipient_members WHERE share_id='share-a'").all()).results)
      .toEqual([{ recipient_principal_public_id: "principal-duplicate" }]);
    await expect(db.prepare("UPDATE delivery_share_audience_snapshots SET audience_display_name='Changed' WHERE share_id='share-a'").run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM delivery_share_recipient_members WHERE share_id='share-a'").run())
      .rejects.toThrow(/immutable/);
    expect(await latestShareAudienceSnapshot(env, "share-a")).toMatchObject({ audiencePublicId: "org-acme" });
    await db.prepare("UPDATE shares SET recipient_email=NULL,share_version=3 WHERE id='share-a'").run();
    expect(await latestShareAudienceSnapshot(env, "share-a")).toBeNull();
  });

  it("rejects unbound folders and does not fall back to a global directory", async () => {
    await expect(searchShareRecipients(env, "jobs/unbound/", "manager")).rejects.toMatchObject({ status: 409 });
  });

  it("fails closed when a previously snapshotted audience no longer has a live authorized recipient", async () => {
    await db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-acme'").run();
    await expect(resolveShareAudience(env, "jobs/acme/north/", "organization", "org-acme"))
      .rejects.toMatchObject({ status: 409 });
    await db.prepare("UPDATE pa_portal_principals SET status='active' WHERE workspace_id='workspace-acme'").run();
  });

  it("hides the endpoint population while disabled", async () => {
    await expect(searchShareRecipients({ ...env, DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED: "false" }, "jobs/acme/north/", "manager"))
      .rejects.toMatchObject({ status: 404 });
  });
});
