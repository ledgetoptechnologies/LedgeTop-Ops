import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  authenticatedDeliveryChangeCandidatesSql,
  saveAuthenticatedDeliveryNotificationPolicy,
  stageAuthenticatedDeliveryChangeForTarget,
  type AuthenticatedDeliveryChangeTarget,
} from "../src/worker/authenticated-delivery-change-notifications";
import { acceptAuthenticatedDeliveryChangeReceipt } from "../src/worker/delivery-change-receipts";
import {
  deliveryChangeProjectionReady,
  getAuthenticatedDeliveryChangeProjectionCounts,
  projectAuthenticatedDeliveryChanges,
} from "../src/worker/delivery-change-projector";
import type { Env } from "../src/worker/types";

type RecoveryEnv = Env & { AUTHENTICATED_DELIVERY_RECOVERY_ENABLED?: string };

describe("authenticated delivery receipt projection — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: RecoveryEnv;
  let counter = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "delivery-change-projector" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    for (const name of [
      "0170_authenticated_delivery_change_notifications.sql",
      "0204_delivery_change_receipts.sql",
      "0205_authenticated_delivery_change_sequence.sql",
      "0207_delivery_change_projection.sql",
      "0208_authenticated_delivery_change_batch_provider_identity.sql",
    ]) await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8"))
      .map(sql => db.prepare(sql)));
    env = {
      DELIVERY_DB: db,
      AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true",
      AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "true",
    } as RecoveryEnv;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function fixture(label: string) {
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
      changeMode: "both", idempotencyKey: `policy-${suffix}-00000000`,
    });
    return { suffix, workspace, identity, grant, prefix };
  }

  async function accept(f: Awaited<ReturnType<typeof fixture>>, name: string, upload: string, etag: string) {
    const key = `${f.prefix}${name}`, eventAt = new Date(Date.now() + 60_000).toISOString();
    const receipt = await acceptAuthenticatedDeliveryChangeReceipt(env, {
      key, present: true, objectVersion: upload, etag, eventAt,
      delivery: { queue: "file-events", id: `message-${f.suffix}-${upload}` },
    }, db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,1,?,'image/jpeg','image') ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,uploaded_at=excluded.uploaded_at`)
      .bind(key, etag, eventAt));
    return { key, eventAt, receipt };
  }

  function envWithStaleAttemptHook(hook: () => Promise<void>): RecoveryEnv {
    let fired = false;
    let proxy: D1Database;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...bindings: unknown[]) => wrap(target.bind(...bindings), sql);
      if (key === "run") return async () => {
        if (!fired && sql.includes("SET status='processing',attempt_count=attempt_count+1")) {
          fired = true;
          await hook();
        }
        return target.run();
      };
      const member = target[key as keyof D1PreparedStatement];
      return typeof member === "function" ? member.bind(target) : member;
    } }) as D1PreparedStatement;
    proxy = new Proxy(db, { get(target, key) {
      if (key === "withSession") return () => proxy;
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const member = target[key as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return { ...env, DELIVERY_DB: proxy } as RecoveryEnv;
  }

  it("creates one pending exact-target job when an immutable receipt is sealed and honors both gates", async () => {
    const f = await fixture("atomic");
    const accepted = await accept(f, "photo.jpg", "upload-v1", "content-v1");
    expect(await deliveryChangeProjectionReady(env)).toBe(true);
    expect(await db.prepare(`SELECT grant_version,status,attempt_count FROM portal_authenticated_delivery_change_projection_jobs
      WHERE receipt_key=?`).bind(accepted.receipt.receiptKey).all()).toMatchObject({ results: [{ grant_version: 1, status: "pending", attempt_count: 0 }] });

    const paused = { ...env, AUTHENTICATED_DELIVERY_RECOVERY_ENABLED: "false" } as RecoveryEnv;
    expect(await projectAuthenticatedDeliveryChanges(paused, { limit: 1 })).toEqual({ claimed: 0, completed: 0, suppressed: 0, retried: 0, failed: 0 });
    expect(await db.prepare("SELECT status FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?")
      .bind(accepted.receipt.receiptKey).first("status")).toBe("pending");

    expect(await projectAuthenticatedDeliveryChanges(env, { limit: 1 })).toMatchObject({ claimed: 1, completed: 1 });
    expect(await getAuthenticatedDeliveryChangeProjectionCounts(env)).toMatchObject({ pending: 0, processing: 0, completed: 1, failed: 0 });
    expect(await db.prepare("SELECT added_count FROM portal_authenticated_delivery_change_batches WHERE grant_id=?").bind(f.grant).first("added_count")).toBe(1);
  });

  it("orders exact targets by accepted receipt sequence and recovers a post-stage pre-completion crash by deduping sequence", async () => {
    const f = await fixture("ordered");
    const first = await accept(f, "same.jpg", "upload-v1", "content-v1");
    const second = await accept(f, "same.jpg", "upload-v2", "content-v2");
    expect(first.receipt.sequence).toBeLessThan(second.receipt.sequence);

    expect(await projectAuthenticatedDeliveryChanges(env, { limit: 1 })).toMatchObject({ claimed: 1, completed: 1 });
    expect(await db.prepare(`SELECT status FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?`)
      .bind(first.receipt.receiptKey).first("status")).toBe("completed");
    expect(await db.prepare(`SELECT status FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?`)
      .bind(second.receipt.receiptKey).first("status")).toBe("pending");

    const target = await db.prepare(`SELECT target.* FROM portal_authenticated_delivery_change_receipt_targets target
      WHERE target.receipt_key=?`).bind(second.receipt.receiptKey).first<AuthenticatedDeliveryChangeTarget>();
    expect(target).toBeTruthy();
    // Simulate a crash after exact staging committed but before the projector
    // wrote completion. Sequence/provider identity makes the recovery replay a
    // duplicate instead of restaging the same accepted receipt.
    expect(await stageAuthenticatedDeliveryChangeForTarget(env, target!, {
      key: second.key, present: true, objectVersion: "content-v2", eventAt: second.eventAt,
      acceptedSequence: second.receipt.sequence, providerObjectVersion: "upload-v2",
    })).toBe("staged");
    expect(await projectAuthenticatedDeliveryChanges(env, { limit: 1 })).toMatchObject({ claimed: 1, completed: 1 });
    expect(await db.prepare("SELECT added_count FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(f.grant).first("added_count")).toBe(1);
    expect(await db.prepare(`SELECT accepted_sequence,provider_object_version,current_object_version
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=?`).bind(f.grant).first())
      .toMatchObject({ accepted_sequence: second.receipt.sequence, provider_object_version: "upload-v2", current_object_version: "content-v2" });
  });

  it("initializes only sealed receipt targets and never backfills ordinary file-index rows", async () => {
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES('unrelated.jpg','unrelated',1,?,'image/jpeg','image')")
      .bind(new Date().toISOString()).run();
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key='unrelated.jpg'")
      .first("count")).toBe(0);
    expect(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_projection_jobs job
      LEFT JOIN portal_authenticated_delivery_change_receipt_seals seal ON seal.receipt_key=job.receipt_key
      WHERE seal.receipt_key IS NULL`).first("count")).toBe(0);
  });

  it("terminalizes an expired exhausted lease so it cannot block a newer receipt for that saved target", async () => {
    const f = await fixture("exhausted");
    const older = await accept(f, "same.jpg", "upload-v1", "content-v1");
    const newer = await accept(f, "same.jpg", "upload-v2", "content-v2");
    await db.prepare(`UPDATE portal_authenticated_delivery_change_projection_jobs
      SET status='processing',attempt_count=3,lease_token='expired-lease-token',lease_expires_at='2000-01-01T00:00:00.000Z'
      WHERE receipt_key=?`).bind(older.receipt.receiptKey).run();

    expect(await projectAuthenticatedDeliveryChanges(env, { limit: 1 })).toMatchObject({ failed: 1, claimed: 1, completed: 1 });
    expect(await db.prepare("SELECT status,last_reason_code FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?")
      .bind(older.receipt.receiptKey).first()).toMatchObject({ status: "failed", last_reason_code: "staging-failed" });
    expect(await db.prepare("SELECT status FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?")
      .bind(newer.receipt.receiptKey).first("status")).toBe("completed");
  });

  it("does not claim a row after another worker advances its attempt count between selection and claim", async () => {
    const f = await fixture("stale-attempt");
    const accepted = await accept(f, "photo.jpg", "upload-v1", "content-v1");
    let hookFired = false;
    const raced = envWithStaleAttemptHook(async () => {
      hookFired = true;
      await db.prepare(`UPDATE portal_authenticated_delivery_change_projection_jobs SET attempt_count=attempt_count+1
        WHERE receipt_key=?`).bind(accepted.receipt.receiptKey).run();
    });
    expect(await projectAuthenticatedDeliveryChanges(raced, { limit: 1 }))
      .toEqual({ claimed: 0, completed: 0, suppressed: 0, retried: 0, failed: 0 });
    expect(hookFired).toBe(true);
    expect(await db.prepare("SELECT status,attempt_count FROM portal_authenticated_delivery_change_projection_jobs WHERE receipt_key=?")
      .bind(accepted.receipt.receiptKey).first()).toMatchObject({ status: "pending", attempt_count: 1 });
  });
});
