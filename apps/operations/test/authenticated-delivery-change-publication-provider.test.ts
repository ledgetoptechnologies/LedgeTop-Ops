import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  authenticatedDeliveryChangeCandidatesSql,
  authorizeAuthenticatedDeliveryChangeBatch,
  recordAuthenticatedDeliveryObjectChange,
  saveAuthenticatedDeliveryNotificationPolicy,
  stageAuthenticatedDeliveryChangeForTarget,
  type AuthenticatedDeliveryChangeTarget,
} from "../src/worker/authenticated-delivery-change-notifications";
import type { Env } from "../src/worker/types";

type ChangeBatch = Parameters<typeof authorizeAuthenticatedDeliveryChangeBatch>[1];

describe("authenticated delivery publication provider fence — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let counter = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "delivery-provider-fence" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    for (const name of [
      "0170_authenticated_delivery_change_notifications.sql",
      "0204_delivery_change_receipts.sql",
      "0205_authenticated_delivery_change_sequence.sql",
      "0206_delivery_index_provider_identity.sql",
      "0208_authenticated_delivery_change_batch_provider_identity.sql",
    ]) await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8"))
      .map(sql => db.prepare(sql)));
    env = { DELIVERY_DB: db, AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true" } as Env;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function fixture(label: string, mode: "added" | "both" = "added") {
    counter += 1;
    const suffix = `${label}-${counter}`, workspace = `workspace-${suffix}`, identity = `identity-${suffix}`,
      principal = `principal-${suffix}`, organization = `organization-${suffix}`, project = `project-${suffix}`,
      generation = `generation-${suffix}`, binding = `binding-${suffix}`, grant = `grant-${suffix}`,
      logical = `logical-${suffix}`, prefix = `Jobs/Clients/${suffix}/`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)")
        .bind(identity, "https://access.example.test", `subject-${suffix}`, `${suffix}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id) VALUES(?,'organization',?,?,'active','project-alpha:primary')")
        .bind(workspace, organization, `Workspace ${suffix}`),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES(?,?,?,'operations','active')")
        .bind(`membership-${suffix}`, workspace, identity),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)")
        .bind(generation, workspace, generation),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,?,'v1')")
        .bind(workspace, generation, organization, `Organization ${suffix}`),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'v1')")
        .bind(workspace, generation, project, organization, `Project ${suffix}`),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace, generation),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'operations','v1')")
        .bind(binding, workspace, project, prefix),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,'pv1','active')")
        .bind(workspace, principal, identity, `${suffix}@example.test`, `Person ${suffix}`),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')")
        .bind(`entitlement-${suffix}`, workspace, identity, project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant, logical, workspace, binding, principal),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')`)
        .bind(grant, workspace, principal, identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: grant, identityId: identity, expectedPolicyVersion: null, accessNoticeEnabled: true,
      changeMode: mode, idempotencyKey: `policy-${suffix}-00000000`,
    });
    return { suffix, identity, grant, prefix };
  }

  async function target(f: Awaited<ReturnType<typeof fixture>>, key: string, eventAt: string, kind: "added" | "removed" = "added") {
    const row = await db.prepare(authenticatedDeliveryChangeCandidatesSql()).bind(key, kind, eventAt, 201)
      .first<AuthenticatedDeliveryChangeTarget>();
    expect(row).toBeTruthy();
    return row!;
  }

  async function setIndex(key: string, provider: string | null, etag: string) {
    await db.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,'image/jpeg','image') ON CONFLICT(r2_key) DO UPDATE SET
        provider_version=excluded.provider_version,etag=excluded.etag,uploaded_at=excluded.uploaded_at`)
      .bind(key, provider, etag, 1, new Date().toISOString()).run();
  }

  function withHead(version: string): Env {
    return { ...env, DATA_BUCKET: { head: async () => ({ httpEtag: "same-content", version }) } as unknown as R2Bucket } as Env;
  }

  function withoutBatchSequenceSchema(): Env {
    let proxy: D1Database;
    proxy = new Proxy(db, { get(target, key) {
      if (key === "withSession") return () => proxy;
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT accepted_sequence,provider_object_version")
          && sql.includes("portal_authenticated_delivery_change_batch_items")) throw new Error("no such column: accepted_sequence");
        return target.prepare(sql);
      };
      const member = target[key as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return { ...env, DELIVERY_DB: proxy } as Env;
  }

  it("denies a sealed older same-ETag receipt when either the current index or R2 HEAD names a newer provider upload", async () => {
    const f = await fixture("provider");
    const key = `${f.prefix}photo.jpg`, eventAt = new Date(Date.now() + 60_000).toISOString(), savedTarget = await target(f, key, eventAt);
    await setIndex(key, "upload-v1", "same-content");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env, savedTarget, {
      key, present: true, objectVersion: "same-content", eventAt, acceptedSequence: 1, providerObjectVersion: "upload-v1",
    })).toBe("staged");
    const older = await db.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(f.grant).first<ChangeBatch>();
    expect(older).toBeTruthy();
    if (!older) throw new Error("provider fixture batch missing");
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET status='processing',sealed_at=datetime('now') WHERE id=?")
      .bind(older.id).run();
    expect(await stageAuthenticatedDeliveryChangeForTarget(env, savedTarget, {
      key, present: true, objectVersion: "same-content", eventAt, acceptedSequence: 2, providerObjectVersion: "upload-v2",
    })).toBe("staged");
    expect(await db.prepare(`SELECT accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_batch_items
      WHERE batch_id=?`).bind(older.id).first()).toMatchObject({ accepted_sequence: 1, provider_object_version: "upload-v1" });

    await setIndex(key, "upload-v2", "same-content");
    expect(await authorizeAuthenticatedDeliveryChangeBatch(withHead("upload-v2"), older)).toBeNull();
    await setIndex(key, "upload-v1", "same-content");
    expect(await authorizeAuthenticatedDeliveryChangeBatch(withHead("upload-v2"), older)).toBeNull();
    expect(await authorizeAuthenticatedDeliveryChangeBatch(withHead("upload-v1"), older)).toMatchObject({ recipient_email: expect.any(String) });
  });

  it("keeps legacy unsequenced batches on their original ETag-only authorization path", async () => {
    const f = await fixture("legacy");
    const key = `${f.prefix}legacy.jpg`, eventAt = new Date(Date.now() + 60_000).toISOString();
    await setIndex(key, null, "legacy-content");
    expect(await recordAuthenticatedDeliveryObjectChange(env, key, true, "legacy-content", eventAt)).toBe(1);
    const batch = await db.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(f.grant).first<ChangeBatch>();
    expect(batch).toBeTruthy();
    if (!batch) throw new Error("legacy fixture batch missing");
    expect(await db.prepare("SELECT accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_batch_items WHERE batch_id=?")
      .bind(batch.id).first()).toMatchObject({ accepted_sequence: null, provider_object_version: null });
    expect(await authorizeAuthenticatedDeliveryChangeBatch(env, batch)).toMatchObject({ recipient_email: expect.any(String) });
  });

  it("fails durable staging clearly when 0208 item identity storage is unavailable", async () => {
    const f = await fixture("missing-batch-schema");
    const key = `${f.prefix}photo.jpg`, eventAt = new Date(Date.now() + 60_000).toISOString();
    await expect(stageAuthenticatedDeliveryChangeForTarget(withoutBatchSequenceSchema(), await target(f, key, eventAt), {
      key, present: true, objectVersion: "content", eventAt, acceptedSequence: 1, providerObjectVersion: "upload-v1",
    })).rejects.toThrow("batch-sequence-schema-unavailable");
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(f.grant).first("count")).toBe(0);
  });

  it("fails closed for sequenced removals without R2 and when a replacement is present", async () => {
    const f = await fixture("removed", "both");
    const key = `${f.prefix}removed.jpg`, eventAt = new Date(Date.now() + 60_000).toISOString();
    expect(await stageAuthenticatedDeliveryChangeForTarget(env, await target(f, key, eventAt, "removed"), {
      key, present: false, objectVersion: "old-content", eventAt, acceptedSequence: 1, providerObjectVersion: "removed-upload-v1",
    })).toBe("staged");
    const batch = await db.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(f.grant).first<ChangeBatch>();
    expect(batch).toBeTruthy();
    if (!batch) throw new Error("removal fixture batch missing");
    expect(await authorizeAuthenticatedDeliveryChangeBatch(env, batch)).toBeNull();
    expect(await authorizeAuthenticatedDeliveryChangeBatch(withHead("replacement-upload-v2"), batch)).toBeNull();
  });
});
