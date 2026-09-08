import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reservePrimaryPortalSigningKeys } from "../../client/src/worker/project-alpha-portal-authority";
import { primaryProjectionCheckpointStatement, primaryProjectionSourceStatements, primaryStaffReceiptStatement } from "./helpers/primary-delivery-fixture";

vi.mock("../src/worker/client-folder-grants", () => ({
  recordClientFolderFileChange: vi.fn(async () => 0),
}));
vi.mock("../src/worker/image-locations", () => ({
  deleteImageLocation: vi.fn(async () => undefined),
  enqueueImageLocationJob: vi.fn(async () => undefined),
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

import { consumeFileEvents, reconcileFileIndex, type R2Notification } from "../src/worker/file-events";
import { authorizeAuthenticatedDeliveryChangeBatch, saveAuthenticatedDeliveryNotificationPolicy } from "../src/worker/authenticated-delivery-change-notifications";
import { recordClientFolderFileChange } from "../src/worker/client-folder-grants";
import { enqueueThumbnailJob, canonicalThumbnailSourceKey, thumbnailSourceEligible } from "../src/worker/image-thumbnails";
import { projectAuthenticatedDeliveryChanges } from "../src/worker/delivery-change-projector";
import type { Env } from "../src/worker/types";

type PublicationBatch = Parameters<typeof authorizeAuthenticatedDeliveryChangeBatch>[1];

interface StoredObject {
  version: string;
  etag: string;
  uploaded: Date;
  size?: number;
}

describe("file-event delivery recovery consumer — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let opsDb: D1Database;
  let env: Env;
  let objects = new Map<string, StoredObject>();
  let listedObjects: Array<Record<string, unknown>> = [];
  let bucketHead = vi.fn();
  let bucketList = vi.fn();
  let serial = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: {
        DELIVERY_DB: "file-event-delivery-recovery", OPS_DB: "file-event-delivery-recovery-ops",
      } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    for (const name of [
      "0170_authenticated_delivery_change_notifications.sql",
      "0189_primary_staff_folder_bindings.sql",
      "0204_delivery_change_receipts.sql",
      "0205_authenticated_delivery_change_sequence.sql",
      "0206_delivery_index_provider_identity.sql",
      "0207_delivery_change_projection.sql",
      "0208_authenticated_delivery_change_batch_provider_identity.sql",
      "0209_authenticated_delivery_change_recipient_events.sql",
    ]) await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8"))
      .map(sql => db.prepare(sql)));
    const opsMigration = readFileSync(new URL("../migrations/0011_r2_crud_jobs.sql", import.meta.url), "utf8");
    const suppression = splitD1MigrationStatements(opsMigration).find(sql => sql.includes("CREATE TABLE IF NOT EXISTS r2_event_suppressions"));
    if (!suppression) throw new Error("r2 suppression schema missing");
    await opsDb.prepare(suppression).run();
    await opsDb.batch(splitD1MigrationStatements(`CREATE TABLE delivery_reconciliation_alerts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,alert_type TEXT NOT NULL,details_json TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now')),acknowledged_at TEXT);
      CREATE TABLE delivery_reconciliation_state(
        source TEXT PRIMARY KEY,last_success_at TEXT,last_visible_count INTEGER NOT NULL DEFAULT 0,
        last_visible_bytes INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT(datetime('now')));`)
      .map(sql => opsDb.prepare(sql)));
    env = {
      DELIVERY_DB: db, OPS_DB: opsDb, DATA_BUCKET: bucket(),
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true",
      AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true",
      FILE_EVENTS_QUEUE_NAME: "ltds-file-events",
      DELIVERY_BASE_URL: "https://client.example.test",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: "primary-portal-hmac-test-key-material-at-least-thirty-two-bytes",
    } as Env;
    await reservePrimaryPortalSigningKeys(env);
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  beforeEach(() => {
    objects = new Map();
    vi.clearAllMocks();
    vi.mocked(canonicalThumbnailSourceKey).mockReturnValue(false);
    vi.mocked(thumbnailSourceEligible).mockReturnValue(false);
    vi.mocked(enqueueThumbnailJob).mockResolvedValue({ enqueued: true, state: "pending" });
    listedObjects = [];
  });

  function bucket(): R2Bucket {
    bucketHead = vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value ? {
        key, version: value.version, size: value.size || 12, uploaded: value.uploaded,
        httpEtag: value.etag, httpMetadata: { contentType: "application/octet-stream" }, customMetadata: {},
      } : null;
    });
    bucketList = vi.fn(async () => ({ objects: listedObjects, delimitedPrefixes: [], truncated: false }));
    return { head: bucketHead, list: bucketList } as unknown as R2Bucket;
  }

  function event(action: string, key: string, etag?: string, eventTime = new Date(Date.now() + 60_000).toISOString()): R2Notification {
    return { action, object: { key, ...(etag ? { eTag: etag } : {}) }, eventTime };
  }

  async function deliver(runEnv: Env, body: R2Notification, id = `message-${serial}`) {
    const ack = vi.fn(), retry = vi.fn();
    await consumeFileEvents({ queue: "ltds-file-events", messages: [{ id, timestamp: new Date("2026-09-07T12:00:01.000Z"), attempts: 1, body, ack, retry }] } as unknown as MessageBatch<R2Notification>, runEnv);
    return { ack, retry };
  }

  async function index(key: string) {
    return db.prepare(`SELECT file_record.r2_key,file_record.provider_version,file_record.notification_observation_version,
      file_record.etag,revisions.revision FROM delivery_file_index_revisions revisions
      LEFT JOIN file_index file_record ON file_record.r2_key=revisions.r2_key WHERE revisions.r2_key=?`).bind(key).first<Record<string, unknown>>();
  }

  async function policyFixture(label: string) {
    serial += 1;
    const suffix = `${label}-${serial}`, workspace = `workspace-${suffix}`, identity = `identity-${suffix}`,
      principal = `principal-${suffix}`, organization = `organization-${suffix}`, project = `project-${suffix}`,
      generation = `generation-${suffix}`, binding = `binding-${suffix}`, grant = `grant-${suffix}`,
      logical = `logical-${suffix}`, prefix = `Jobs/Clients/${label}/`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)").bind(identity, "https://access.example.test", `subject-${suffix}`, `${suffix}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id) VALUES(?,'organization',?,?,'active','project-alpha:primary')").bind(workspace, organization, workspace),
      ...primaryProjectionSourceStatements(db,{workspace,snapshot:`snapshot-${suffix}`,
        generation,organization,displayName:workspace}),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES(?,?,?,'operations','active')").bind(`membership-${suffix}`, workspace, identity),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)").bind(generation, workspace, generation),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,?,'v1')").bind(workspace, generation, organization, organization),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'v1')").bind(workspace, generation, project, organization, project),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)").bind(workspace, generation),
      primaryProjectionCheckpointStatement(db,{workspace,generation,snapshot:`snapshot-${suffix}`}),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'operations','v1')").bind(binding, workspace, project, prefix),
      primaryStaffReceiptStatement(db,{binding,workspace,organization,project,generation,snapshot:`snapshot-${suffix}`,prefix}),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,'pv1','active')").bind(workspace, principal, identity, `${suffix}@example.test`, principal),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')").bind(`entitlement-${suffix}`, workspace, identity, project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant, logical, workspace, binding, principal),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')").bind(grant, workspace, principal, identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: grant, identityId: identity, expectedPolicyVersion: null, accessNoticeEnabled: true,
      changeMode: "both", idempotencyKey: `policy-${suffix}-00000000`,
    });
    return { prefix, grant };
  }

  it("atomically records a matching create, sealed target set, projection job, and side-effect enqueue", async () => {
    const fixture = await policyFixture("atomic"), key = `${fixture.prefix}source.bin`;
    objects.set(key, { version: "upload-v1", etag: "etag-v1", uploaded: new Date("2026-09-07T12:00:00Z") });
    vi.mocked(canonicalThumbnailSourceKey).mockReturnValue(true);
    vi.mocked(thumbnailSourceEligible).mockReturnValue(true);
    const result = await deliver(env, event("PutObject", key, "etag-v1"));
    expect(result.ack).toHaveBeenCalledTimes(1);
    expect(await index(key)).toMatchObject({ provider_version: "upload-v1", notification_observation_version: "upload-v1" });
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key IN (SELECT receipt_key FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?)").bind(key).first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key IN (SELECT receipt_key FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?)").bind(key).first("count")).toBe(1);
    expect(enqueueThumbnailJob).toHaveBeenCalledTimes(1);
    expect((await projectAuthenticatedDeliveryChanges(env, { limit: 1 })).completed).toBe(1);
    const batch = await db.prepare("SELECT * FROM portal_authenticated_delivery_change_batches WHERE grant_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(fixture.grant).first<PublicationBatch>();
    expect(batch).toBeTruthy();
    expect(await authorizeAuthenticatedDeliveryChangeBatch(env, batch!)).toMatchObject({ recipient_email: expect.any(String) });
  });

  it("replays a post-commit thumbnail failure through the fixed alias without a second receipt/index acceptance", async () => {
    const key = `Jobs/Clients/replay-${++serial}/source.jpg`;
    objects.set(key, { version: "upload-replay", etag: "etag-replay", uploaded: new Date("2026-09-07T12:00:00Z") });
    vi.mocked(canonicalThumbnailSourceKey).mockReturnValue(true);
    vi.mocked(thumbnailSourceEligible).mockReturnValue(true);
    vi.mocked(enqueueThumbnailJob).mockRejectedValueOnce(new Error("thumbnail-post-commit"));
    const body = event("PutObject", key, "etag-replay");
    const first = await deliver(env, body, "fixed-replay");
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(1);
    const beforeReplay = await index(key);
    const second = await deliver(env, body, "fixed-replay");
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(1);
    expect(await index(key)).toEqual(beforeReplay);
    expect(enqueueThumbnailJob).toHaveBeenCalledTimes(2);
  });

  it("seals a zero-target create so a policy added later cannot fan out the old receipt", async () => {
    const label = `late-${++serial}`, key = `Jobs/Clients/${label}/source.bin`;
    objects.set(key, { version: "upload-zero", etag: "etag-zero", uploaded: new Date("2026-09-07T12:00:00Z") });
    const body = event("PutObject", key, "etag-zero");
    await deliver(env, body, "zero-target");
    const receipt = await db.prepare("SELECT receipt_key FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first<string>("receipt_key");
    expect(receipt).toBeTruthy();
    expect(await db.prepare("SELECT target_count FROM portal_authenticated_delivery_change_receipt_seals WHERE receipt_key=?").bind(receipt).first("target_count")).toBe(0);
    const beforeReplay = await index(key);
    await policyFixture(label);
    const replay = await deliver(env, body, "zero-target");
    expect(replay.ack).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?").bind(receipt).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?").bind(receipt).first("count")).toBe(0);
    expect(await index(key)).toEqual(beforeReplay);
  });

  it("replays a committed delete with an identical-ETag replacement without repeating removal side effects", async () => {
    const key = `Jobs/Clients/delete-${++serial}/source.bin`;
    objects.set(key, { version: "upload-old", etag: "same-etag", uploaded: new Date("2026-09-07T12:00:00Z") });
    const createBody = event("PutObject", key, "same-etag");
    await deliver(env, createBody, "create-before-delete");
    objects.delete(key);
    const deleteBody = event("DeleteObject", key, "same-etag");
    const first = await deliver(env, deleteBody, "delete-fixed");
    expect(first.ack).toHaveBeenCalledTimes(1);
    const removalCalls = vi.mocked(recordClientFolderFileChange).mock.calls.filter(call => call[2] === false).length;
    objects.set(key, { version: "upload-new", etag: "same-etag", uploaded: new Date("2026-09-07T12:01:00Z") });
    const second = await deliver(env, deleteBody, "delete-fixed");
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(await index(key)).toMatchObject({ provider_version: "upload-new", etag: "same-etag" });
    expect(vi.mocked(recordClientFolderFileChange).mock.calls.filter(call => call[2] === false).length).toBe(removalCalls);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=? AND current_present=0").bind(key).first("count")).toBe(1);
  });

  it("cleans up a legacy unknown-provider delete by revision CAS without making a native receipt", async () => {
    const key = `Jobs/Clients/legacy-${++serial}/source.bin`;
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "legacy-etag", "2026-09-07T12:00:00Z").run();
    const result = await deliver(env, event("DeleteObject", key));
    expect(result.ack).toHaveBeenCalledTimes(1);
    expect(await index(key)).toMatchObject({ r2_key: null });
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(0);
  });

  it("fails before mutation when the 0208 batch identity columns are unavailable", async () => {
    let proxy: D1Database;
    proxy = new Proxy(db, { get(target, property) {
      if (property === "withSession") return () => proxy;
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("portal_authenticated_delivery_change_batch_items") && sql.includes("accepted_sequence")) throw new Error("no such column: accepted_sequence");
        return target.prepare(sql);
      };
      const member = target[property as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const key = `Jobs/Clients/missing-schema-${++serial}/source.bin`;
    objects.set(key, { version: "upload-missing", etag: "etag-missing", uploaded: new Date("2026-09-07T12:00:00Z") });
    await expect(consumeFileEvents({ queue: "ltds-file-events", messages: [] } as unknown as MessageBatch<R2Notification>, { ...env, DELIVERY_DB: proxy } as Env)).rejects.toThrow("delivery-index-recovery-schema-unavailable");
    expect(await index(key)).toBeNull();
  });

  it("retries an unrecognized queue instead of accepting a native receipt", async () => {
    const key = `Jobs/Clients/queue-${++serial}/source.bin`;
    objects.set(key, { version: "upload-queue", etag: "etag-queue", uploaded: new Date("2026-09-07T12:00:00Z") });
    const ack = vi.fn(), retry = vi.fn();
    await consumeFileEvents({ queue: "unexpected-queue", messages: [{ id: "wrong-queue", timestamp: new Date(), attempts: 1, body: event("PutObject", key, "etag-queue"), ack, retry }] } as unknown as MessageBatch<R2Notification>, env);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await index(key)).toBeNull();
  });

  it("repairs a stale create ETag using the current provider identity without creating a receipt", async () => {
    const key = `Jobs/Clients/stale-${++serial}/source.bin`;
    objects.set(key, { version: "upload-current", etag: "etag-current", uploaded: new Date("2026-09-07T12:00:00Z") });
    const result = await deliver(env, event("PutObject", key, "etag-old"));
    expect(result.ack).toHaveBeenCalledTimes(1);
    expect(await index(key)).toMatchObject({ provider_version: "upload-current", notification_observation_version: null, etag: "etag-current" });
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(0);
  });

  it("skips R2 HEAD and provider-metadata repair when reconciliation already has the listed provider", async () => {
    const key = `Jobs/Clients/reconcile-same-${++serial}/source.bin`, uploaded = new Date("2026-09-07T12:00:00Z");
    await db.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,12,?,'application/octet-stream','other')`).bind(key, "listed-v1", "etag-v1", uploaded.toISOString()).run();
    listedObjects = [{ key, version: "listed-v1", httpEtag: "etag-v1", size: 12, uploaded,
      httpMetadata: { contentType: "application/octet-stream" }, customMetadata: {} }];
    const before = await index(key);
    await reconcileFileIndex(env);
    expect(bucketHead).not.toHaveBeenCalled();
    expect(await index(key)).toMatchObject({ provider_version: before?.provider_version, etag: before?.etag });
  });

  it("does not downgrade a v2 index from a stale v1 list or mint a receipt", async () => {
    const key = `Jobs/Clients/reconcile-stale-${++serial}/source.bin`, uploaded = new Date("2026-09-07T12:01:00Z");
    await db.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,12,?,'application/octet-stream','other')`).bind(key, "listed-v2", "etag-v2", uploaded.toISOString()).run();
    listedObjects = [{ key, version: "listed-v1", httpEtag: "etag-v1", size: 12, uploaded,
      httpMetadata: { contentType: "application/octet-stream" }, customMetadata: {} }];
    objects.set(key, { version: "listed-v2", etag: "etag-v2", uploaded });
    await reconcileFileIndex(env);
    expect(bucketHead).toHaveBeenCalledTimes(1);
    expect(await index(key)).toMatchObject({ provider_version: "listed-v2", etag: "etag-v2" });
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?").bind(key).first("count")).toBe(0);
  });
});
