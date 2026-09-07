import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

vi.mock("../src/worker/client-folder-grants", () => ({
  recordClientFolderFileChange: vi.fn(async () => undefined),
}));
vi.mock("../src/worker/image-thumbnails", () => ({
  canonicalThumbnailSourceKey: vi.fn(() => false),
  enqueueThumbnailJob: vi.fn(async () => undefined),
  handleRemovedPrebuiltThumbnail: vi.fn(async () => undefined),
  prebuiltThumbnailArtifactKey: vi.fn(() => false),
  removeThumbnailStateForPath: vi.fn(async () => undefined),
  THUMBNAIL_PREBUILT_GRACE_SECONDS: 0,
  THUMBNAIL_SIDECAR_GRACE_SECONDS: 0,
  thumbnailSourceEligible: vi.fn(() => false),
}));
vi.mock("../src/worker/image-locations", () => ({
  deleteImageLocation: vi.fn(async () => undefined),
  enqueueImageLocationJob: vi.fn(async () => undefined),
}));

import { consumeFileEvents, type R2Notification } from "../src/worker/file-events";
import { saveAuthenticatedDeliveryNotificationPolicy } from "../src/worker/authenticated-delivery-change-notifications";
import { recordClientFolderFileChange } from "../src/worker/client-folder-grants";
import type { Env } from "../src/worker/types";

interface StoredObject { etag: string; uploaded: Date; }

const configuredFileEventRetries = (() => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = config.match(/"queue"\s*:\s*"ltds-file-events"[\s\S]*?"max_retries"\s*:\s*(\d+)/);
  if (!match) throw new Error("file-events queue retry configuration missing");
  return Number(match[1]);
})();

describe("file-event authenticated-change staging replay — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let opsDb: D1Database;
  let env: Env;
  let counter = 0;
  let objects = new Map<string, StoredObject>();
  let consoleError: { mockRestore(): void } | undefined;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: {
        DELIVERY_DB: "file-event-notification-replay", OPS_DB: "file-event-notification-replay-ops",
      } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const opsMigration = readFileSync(new URL("../migrations/0011_r2_crud_jobs.sql", import.meta.url), "utf8");
    const suppressionTable = splitD1MigrationStatements(opsMigration)
      .find(sql => sql.includes("CREATE TABLE IF NOT EXISTS r2_event_suppressions"));
    if (!suppressionTable) throw new Error("r2 event suppression migration missing");
    await opsDb.prepare(suppressionTable).run();
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0170_authenticated_delivery_change_notifications.sql", import.meta.url), "utf8"))
      .map(sql => db.prepare(sql)));
    env = {
      DELIVERY_DB: db,
      OPS_DB: opsDb,
      DATA_BUCKET: bucket(),
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true",
      DELIVERY_BASE_URL: "https://client.example.test",
    } as Env;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  }, 180_000);

  afterAll(async () => {
    consoleError?.mockRestore();
    await runtime?.dispose();
  });

  function bucket(): R2Bucket {
    return {
      head: vi.fn(async (key: string) => {
        const object = objects.get(key);
        return object ? {
          key, size: 12, uploaded: object.uploaded, httpEtag: object.etag,
          httpMetadata: { contentType: "application/octet-stream" }, customMetadata: {},
        } : null;
      }),
    } as unknown as R2Bucket;
  }

  async function fixture(label: string) {
    counter++;
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
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')")
        .bind(grant, workspace, principal, identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: grant, identityId: identity, expectedPolicyVersion: null, accessNoticeEnabled: true, changeMode: "both",
      idempotencyKey: `policy-${suffix}-00000000`,
    });
    return { workspace, prefix };
  }

  function event(action: string, key: string, etag: string, at = new Date(Date.now() + 1_000).toISOString()): R2Notification {
    return { action, object: { key, eTag: etag }, eventTime: at };
  }

  async function deliver(runEnv: Env, body: R2Notification, timestamp = new Date()) {
    const ack = vi.fn(), retry = vi.fn();
    await consumeFileEvents({ messages: [{ id: "file-event", timestamp, attempts: 1, body, ack, retry }] } as unknown as MessageBatch<R2Notification>, runEnv);
    return { ack, retry };
  }

  function envWithStageFailures(failures: number): Env {
    let proxy: D1Database;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "all") return async () => {
          if (sql.includes("FROM portal_authenticated_delivery_notification_policies policy") && failures-- > 0)
            throw new Error("injected-stage-failure-after-index-commit");
          return target.all();
        };
        const member = target[property as keyof D1PreparedStatement];
        return typeof member === "function" ? member.bind(target) : member;
      } });
      return wrapped;
    };
    proxy = new Proxy(db, { get(target, property) {
      if (property === "withSession") return () => proxy;
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const member = target[property as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return { ...env, DELIVERY_DB: proxy } as Env;
  }

  async function stagedCount(workspace: string) {
    return Number(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_batches WHERE workspace_id=?")
      .bind(workspace).first("count"));
  }

  it("recovers one matching create after a staging failure following its committed index write", async () => {
    const f = await fixture("transient");
    const key = `${f.prefix}receipt.bin`, at = new Date(Date.now() + 1_000).toISOString();
    objects.set(key, { etag: "v1", uploaded: new Date(at) });
    const retrying = envWithStageFailures(1);

    const first = await deliver(retrying, event("PutObject", key, "v1", at));
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v1");
    expect(await stagedCount(f.workspace)).toBe(0);

    const replay = await deliver(retrying, event("PutObject", key, "v1", at));
    expect(replay.ack).toHaveBeenCalledTimes(1);
    expect(replay.retry).not.toHaveBeenCalled();
    expect(await stagedCount(f.workspace)).toBe(1);
    expect(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_batch_items item
      JOIN portal_authenticated_delivery_change_batches batch ON batch.id=item.batch_id WHERE batch.workspace_id=?`).bind(f.workspace).first("count")).toBe(1);
  });

  it("recovers one matching delete after a staging failure following its committed index removal", async () => {
    const f = await fixture("transient-delete");
    const key = `${f.prefix}receipt.bin`, at = new Date(Date.now() + 1_000).toISOString();
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", at).run();
    objects.delete(key);
    const retrying = envWithStageFailures(1);

    const first = await deliver(retrying, event("DeleteObject", key, "v1", at));
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBeNull();
    expect(await stagedCount(f.workspace)).toBe(0);

    const replay = await deliver(retrying, event("DeleteObject", key, "v1", at));
    expect(replay.ack).toHaveBeenCalledTimes(1);
    expect(replay.retry).not.toHaveBeenCalled();
    expect(await stagedCount(f.workspace)).toBe(1);
    expect(await db.prepare("SELECT added_count FROM portal_authenticated_delivery_change_batches WHERE workspace_id=?")
      .bind(f.workspace).first("added_count")).toBe(0);
    expect(await db.prepare("SELECT removed_count FROM portal_authenticated_delivery_change_batches WHERE workspace_id=?")
      .bind(f.workspace).first("removed_count")).toBe(1);
  });

  it("characterizes the pending durable-receipt gap when every configured queue delivery fails staging", async () => {
    const f = await fixture("exhausted");
    const key = `${f.prefix}event.bin`, at = new Date(Date.now() + 1_000).toISOString();
    objects.set(key, { etag: "v1", uploaded: new Date(at) });
    const simulatedDeliveries = configuredFileEventRetries + 1; // initial delivery plus checked-in queue retries
    const retrying = envWithStageFailures(simulatedDeliveries);

    for (let attempt = 0; attempt < simulatedDeliveries; attempt++) {
      const delivery = await deliver(retrying, event("PutObject", key, "v1", at));
      expect(delivery.retry).toHaveBeenCalledTimes(1);
      expect(delivery.ack).not.toHaveBeenCalled();
    }
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v1");
    expect(await stagedCount(f.workspace)).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_object_versions WHERE grant_id LIKE ?")
      .bind("grant-exhausted-%").first("count")).toBe(0);
    // This models the configured delivery budget; consumeFileEvents itself does
    // not evict queue messages. A future receipt changes this expectation to
    // one retained receipt that drains exactly once after staging recovers.
  });

  it("does not turn a stale replacement create into a notice", async () => {
    const f = await fixture("stale-create");
    const key = `${f.prefix}replacement.bin`, at = new Date(Date.now() + 1_000).toISOString();
    objects.set(key, { etag: "v2", uploaded: new Date(at) });

    const delivery = await deliver(env, event("PutObject", key, "v1", at));
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v2");
    expect(await stagedCount(f.workspace)).toBe(0);
  });

  it("does not turn a stale delete for a replacement version into a removal notice", async () => {
    const f = await fixture("stale-delete");
    const key = `${f.prefix}replacement.bin`, at = new Date(Date.now() + 1_000).toISOString();
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v2", at).run();
    objects.delete(key);

    const delivery = await deliver(env, event("DeleteObject", key, "v1", at));
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v2");
    expect(await stagedCount(f.workspace)).toBe(0);
  });

  it("uses the original queue timestamp for a delete without eventTime, so a later policy cannot backfill it", async () => {
    const f = await fixture("delete-queue-time");
    const key = `${f.prefix}receipt.bin`, queuedAt = new Date(Date.now() - 60_000);
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", queuedAt.toISOString()).run();
    objects.delete(key);
    const body = event("DeleteObject", key, "v1");
    delete body.eventTime;

    const delivery = await deliver(env, body, queuedAt);
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await stagedCount(f.workspace)).toBe(0);
  });

  it("retries before delete side effects when neither payload nor queue time is usable", async () => {
    const f = await fixture("delete-invalid-queue-time");
    const key = `${f.prefix}receipt.bin`, uploaded = new Date().toISOString();
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", uploaded).run();
    objects.delete(key);
    const body = event("DeleteObject", key, "v1");
    delete body.eventTime;
    const legacyNotice = vi.mocked(recordClientFolderFileChange);
    legacyNotice.mockClear();

    const delivery = await deliver(env, body, new Date("invalid"));
    expect(delivery.retry).toHaveBeenCalledTimes(1);
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v1");
    expect(legacyNotice).not.toHaveBeenCalled();
    expect(await stagedCount(f.workspace)).toBe(0);
  });

  it("retries a delete without eventTime using its fixed queue timestamp", async () => {
    const f = await fixture("delete-queue-time-retry");
    const key = `${f.prefix}receipt.bin`, queuedAt = new Date(Date.now() + 1_000);
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", queuedAt.toISOString()).run();
    objects.delete(key);
    const body = event("DeleteObject", key, "v1");
    delete body.eventTime;
    const retrying = envWithStageFailures(1);

    const first = await deliver(retrying, body, queuedAt);
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    const replay = await deliver(retrying, body, queuedAt);
    expect(replay.ack).toHaveBeenCalledTimes(1);
    expect(replay.retry).not.toHaveBeenCalled();
    expect(await db.prepare(`SELECT observed_event_at FROM portal_authenticated_delivery_change_object_versions
      WHERE grant_id LIKE ?`).bind("grant-delete-queue-time-retry-%").first("observed_event_at")).toBe(queuedAt.toISOString());
  });

  it("uses the queue timestamp for a delete with malformed eventTime", async () => {
    const f = await fixture("delete-malformed-time");
    const key = `${f.prefix}receipt.bin`, queuedAt = new Date(Date.now() + 1_000);
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", queuedAt.toISOString()).run();
    objects.delete(key);
    const body = event("DeleteObject", key, "v1");
    body.eventTime = "not-a-timestamp";

    const delivery = await deliver(env, body, queuedAt);
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await db.prepare(`SELECT observed_event_at FROM portal_authenticated_delivery_change_object_versions
      WHERE grant_id LIKE ?`).bind("grant-delete-malformed-time-%").first("observed_event_at")).toBe(queuedAt.toISOString());
  });

  it("uses head.uploaded when a create eventTime is malformed instead of silently skipping staging", async () => {
    const f = await fixture("create-malformed-time");
    const key = `${f.prefix}receipt.bin`, uploaded = new Date(Date.now() + 1_000);
    objects.set(key, { etag: "v1", uploaded });
    const body = event("PutObject", key, "v1");
    body.eventTime = "not-a-timestamp";

    const delivery = await deliver(env, body, new Date(uploaded.getTime() + 1_000));
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await stagedCount(f.workspace)).toBe(1);
  });

  it("indexes the current HEAD for a stale create with invalid transport time without staging a notice", async () => {
    const f = await fixture("stale-create-invalid-time");
    const key = `${f.prefix}replacement.bin`, uploaded = new Date(Date.now() + 1_000);
    objects.set(key, { etag: "v2", uploaded });
    const body = event("PutObject", key, "v1", "invalid-source-time");

    const delivery = await deliver(env, body, new Date("invalid"));
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v2");
    expect(await stagedCount(f.workspace)).toBe(0);
  });

  it("does not require notification time for ordinary deletion when authenticated notices are disabled", async () => {
    const f = await fixture("disabled-delete-time");
    const key = `${f.prefix}receipt.bin`, uploaded = new Date().toISOString();
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", uploaded).run();
    const body = event("DeleteObject", key, "v1", "invalid-source-time");
    vi.mocked(recordClientFolderFileChange).mockClear();

    const delivery = await deliver({ ...env, AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "false" }, body, new Date("invalid"));
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBeNull();
    expect(recordClientFolderFileChange).toHaveBeenCalledWith(expect.anything(), key, false);
    expect(await stagedCount(f.workspace)).toBe(0);
  });
});
