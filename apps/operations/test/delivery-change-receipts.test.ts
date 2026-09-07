import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { saveAuthenticatedDeliveryNotificationPolicy } from "../src/worker/authenticated-delivery-change-notifications";
import { acceptAuthenticatedDeliveryChangeReceipt, readAcceptedDeliveryChangeReceipt, type AcceptedDeliveryChange } from "../src/worker/delivery-change-receipts";
import type { Env } from "../src/worker/types";

describe("accepted authenticated delivery changes — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let counter = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "delivery-change-receipts" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    for (const name of ["0170_authenticated_delivery_change_notifications.sql", "0204_delivery_change_receipts.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    env = { DELIVERY_DB: db, AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true" } as Env;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function fixture(label: string, policy = true) {
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
    if (policy) await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: grant, identityId: identity, expectedPolicyVersion: null, accessNoticeEnabled: true, changeMode: "both",
      idempotencyKey: `policy-${suffix}-00000000`,
    });
    return { suffix, workspace, identity, principal, project, binding, grant, logical, prefix };
  }

  function change(key: string, version: string, etag: string | null = "content-etag", eventAt = new Date(Date.now() + 1_000).toISOString()): AcceptedDeliveryChange {
    counter++;
    return { key, present: true, objectVersion: version, etag, eventAt,
      delivery: { queue: "test-file-events", id: `message-${counter}` } };
  }

  function insertIndex(key: string, etag: string) {
    return db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,12,?,'application/octet-stream','other')`).bind(key, etag, new Date().toISOString());
  }

  async function receipt(key: string) {
    return db.prepare(`SELECT receipt.sequence,receipt.receipt_key,receipt.r2_key,receipt.object_version,receipt.object_etag,
      receipt.current_present,receipt.index_applied,receipt.candidate_count,seal.target_count
      FROM portal_authenticated_delivery_change_receipts receipt
      JOIN portal_authenticated_delivery_change_receipt_seals seal ON seal.receipt_key=receipt.receipt_key
      WHERE receipt.r2_key=? ORDER BY receipt.sequence`).bind(key).all<Record<string, unknown>>();
  }

  it("commits the index CAS, immutable receipt, exact target snapshot, and seal together", async () => {
    const f = await fixture("atomic");
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-atomic");
    const accepted = await acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"));

    expect(accepted).toMatchObject({ disposition: "accepted", sequence: expect.any(Number), receiptKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("content-etag");
    expect((await receipt(key)).results).toMatchObject([{ object_version: "r2-version-atomic", object_etag: "content-etag", current_present: 1,
      index_applied: 1, candidate_count: 1, target_count: 1 }]);
    await expect(db.prepare(`SELECT grant_id,identity_id,workspace_id,source_id,policy_version,folder_binding_id,r2_prefix
      FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?`).bind(accepted.receiptKey).first())
      .resolves.toMatchObject({ grant_id: f.grant, identity_id: f.identity, workspace_id: f.workspace, source_id: "project-alpha:primary",
        policy_version: 1, folder_binding_id: f.binding, r2_prefix: f.prefix });
  });

  it("returns the sealed semantic duplicate without rerunning the index mutation or rediscovering targets", async () => {
    const f = await fixture("duplicate");
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-duplicate");
    const first = await acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"));
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: f.grant, identityId: f.identity, expectedPolicyVersion: 1, accessNoticeEnabled: false, changeMode: "off",
      idempotencyKey: `policy-off-${f.suffix}-0000`,
    });

    const replay = change(key, "r2-version-duplicate");
    const duplicate = await acceptAuthenticatedDeliveryChangeReceipt(env, replay,
      db.prepare("UPDATE file_index SET etag='must-not-run' WHERE r2_key=?").bind(key));
    expect(duplicate).toEqual({ ...first, disposition: "duplicate" });
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("content-etag");
    expect(await db.prepare("SELECT policy_version FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?")
      .bind(first.receiptKey).first("policy_version")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipt_deliveries WHERE receipt_key=?")
      .bind(first.receiptKey).first("count")).toBe(2);
  });

  it("rejects reuse of a queue message ID for a different accepted change", async () => {
    const f = await fixture("delivery-conflict");
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-original");
    await acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"));
    const conflicting = { ...change(key, "r2-version-conflict"), delivery: input.delivery };

    await expect(acceptAuthenticatedDeliveryChangeReceipt(env, conflicting,
      db.prepare("UPDATE file_index SET etag='must-not-run' WHERE r2_key=?").bind(key))).rejects.toThrow("identity-conflict");
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("content-etag");
  });

  it("recovers a lost batch response as a sealed duplicate without rerunning the index mutation", async () => {
    const f = await fixture("lost-response");
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-lost-response");
    let throwAfterCommit = true;
    const flakyDb = new Proxy(db, {
      get(target, property) {
        if (property !== "withSession") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(sessionTarget, sessionProperty) {
              if (sessionProperty !== "batch") {
                const value = Reflect.get(sessionTarget, sessionProperty, sessionTarget);
                return typeof value === "function" ? value.bind(sessionTarget) : value;
              }
              return async (...batchArgs: Parameters<D1DatabaseSession["batch"]>) => {
                const result = await sessionTarget.batch(...batchArgs);
                if (throwAfterCommit) {
                  throwAfterCommit = false;
                  throw new Error("simulated lost batch response");
                }
                return result;
              };
            },
          });
        };
      },
    });

    const accepted = await acceptAuthenticatedDeliveryChangeReceipt({ ...env, DELIVERY_DB: flakyDb }, input,
      insertIndex(key, "content-etag"));
    expect(accepted.disposition).toBe("duplicate");
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("content-etag");
    expect((await receipt(key)).results).toMatchObject([{ candidate_count: 1, target_count: 1 }]);
  });

  it("rolls back without a receipt when the authoritative index CAS affects zero rows", async () => {
    const f = await fixture("cas-zero", false);
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-cas-zero");
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,12,?,'application/octet-stream','other')")
      .bind(key, "v1", new Date().toISOString()).run();

    await expect(acceptAuthenticatedDeliveryChangeReceipt(env, input,
      db.prepare("UPDATE file_index SET etag='v2' WHERE r2_key=? AND etag='wrong-version'").bind(key))).rejects.toThrow();
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("v1");
    expect((await receipt(key)).results).toEqual([]);
  });

  it("rolls back the index when more than 200 eligible candidates would be captured", async () => {
    const f = await fixture("candidate-capacity");
    const additionalCandidates = `WITH RECURSIVE n(value) AS (VALUES(2) UNION ALL SELECT value+1 FROM n WHERE value<201)`;
    await db.prepare(`${additionalCandidates}
      INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
      SELECT ? || '-capacity-' || value, ? || '-capacity-' || value, 1, ?, ?, 'v1', 'principal', ?, 'pv1', 'test', 'staff-a' FROM n`)
      .bind(f.grant, f.logical, f.workspace, f.binding, f.principal).run();
    await db.prepare(`${additionalCandidates}
      INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
      SELECT ? || '-capacity-' || value, ?, ?, ?, 'pv1' FROM n`)
      .bind(f.grant, f.workspace, f.principal, f.identity).run();
    await db.prepare(`${additionalCandidates}
      INSERT INTO portal_authenticated_delivery_notification_policies
        (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
         access_notice_enabled,change_mode,policy_version,updated_by_staff_id)
      SELECT ? || '-capacity-' || value, 1, ? || '-capacity-' || value, ?, 'project-alpha:primary', ?, ?, 'pv1', 1, 'both', 1, 'staff-a' FROM n`)
      .bind(f.grant, f.logical, f.workspace, f.identity, f.principal).run();

    const key = `${f.prefix}capacity.bin`, input = change(key, "r2-version-capacity");
    await expect(acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"))).rejects.toThrow();
    expect(await db.prepare("SELECT 1 FROM file_index WHERE r2_key=?").bind(key).first()).toBeNull();
    expect((await receipt(key)).results).toEqual([]);
  });

  it("rolls back the index mutation when receipt persistence aborts", async () => {
    const f = await fixture("receipt-abort", false);
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-abort");
    await db.prepare(`CREATE TRIGGER test_delivery_change_receipt_abort BEFORE INSERT ON portal_authenticated_delivery_change_receipts
      BEGIN SELECT RAISE(ABORT,'test receipt abort'); END`).run();
    try {
      await expect(acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"))).rejects.toThrow();
    } finally {
      await db.exec("DROP TRIGGER test_delivery_change_receipt_abort");
    }
    expect(await db.prepare("SELECT 1 FROM file_index WHERE r2_key=?").bind(key).first()).toBeNull();
    expect((await receipt(key)).results).toEqual([]);
  });

  it("accepts same-content re-uploads with distinct provider upload versions, but deduplicates the same provider version", async () => {
    const f = await fixture("versions");
    const key = `${f.prefix}receipt.bin`;
    const first = await acceptAuthenticatedDeliveryChangeReceipt(env, change(key, "r2-version-one", "same-content-etag"), insertIndex(key, "same-content-etag"));
    const second = await acceptAuthenticatedDeliveryChangeReceipt(env, change(key, "r2-version-two", "same-content-etag"),
      db.prepare("UPDATE file_index SET etag=?,uploaded_at=? WHERE r2_key=? AND etag=?")
        .bind("same-content-etag", new Date().toISOString(), key, "same-content-etag"));
    const duplicate = await acceptAuthenticatedDeliveryChangeReceipt(env, change(key, "r2-version-two", "same-content-etag"),
      db.prepare("UPDATE file_index SET etag='must-not-run' WHERE r2_key=?").bind(key));

    expect(first.disposition).toBe("accepted");
    expect(second.disposition).toBe("accepted");
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(duplicate).toEqual({ ...second, disposition: "duplicate" });
    expect((await receipt(key)).results.map(row => row.object_version)).toEqual(["r2-version-one", "r2-version-two"]);
  });

  it("recovers the accepted deletion by its queue identity after a replacement appears at the same key", async () => {
    const f = await fixture("delete-replay");
    const key = `${f.prefix}receipt.bin`;
    await insertIndex(key, "old-content-etag").run();
    const deleted = { ...change(key, "r2-version-deleted", null), present: false };
    const accepted = await acceptAuthenticatedDeliveryChangeReceipt(env, deleted,
      db.prepare("DELETE FROM file_index WHERE r2_key=? AND etag=?").bind(key, "old-content-etag"));
    await insertIndex(key, "replacement-content-etag").run();

    await expect(readAcceptedDeliveryChangeReceipt({ ...env, AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "false" }, {
      queue: deleted.delivery.queue, id: deleted.delivery.id, key, present: false,
    })).resolves.toEqual({ receiptKey: accepted.receiptKey, sequence: accepted.sequence, key, present: false,
      objectVersion: "r2-version-deleted", etag: null, eventAt: deleted.eventAt, delivery: deleted.delivery });
    expect(await db.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first("etag")).toBe("replacement-content-etag");
  });

  it("seals an empty recipient set so a later opt-in or direct target insert cannot backfill it", async () => {
    const f = await fixture("empty-seal", false);
    const key = `${f.prefix}receipt.bin`, input = change(key, "r2-version-empty");
    const accepted = await acceptAuthenticatedDeliveryChangeReceipt(env, input, insertIndex(key, "content-etag"));
    expect((await receipt(key)).results).toMatchObject([{ candidate_count: 0, target_count: 0 }]);
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: f.grant, identityId: f.identity, expectedPolicyVersion: null, accessNoticeEnabled: true, changeMode: "both",
      idempotencyKey: `policy-late-${f.suffix}-000000`,
    });
    const duplicate = await acceptAuthenticatedDeliveryChangeReceipt(env, input,
      db.prepare("UPDATE file_index SET etag='must-not-run' WHERE r2_key=?").bind(key));
    expect(duplicate.disposition).toBe("duplicate");
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?")
      .bind(accepted.receiptKey).first("count")).toBe(0);
    await expect(db.prepare(`INSERT INTO portal_authenticated_delivery_change_receipt_targets
      (receipt_key,grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
       access_notice_enabled,change_mode,policy_version,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix)
      VALUES(?,?,1,?,?,?,?,?,'pv1',1,'both',1,?,'v1','project',?,?)`)
      .bind(accepted.receiptKey,f.grant,f.logical,f.workspace,"project-alpha:primary",f.identity,f.principal,f.binding,f.project,f.prefix).run()).rejects.toThrow("sealed");
  });

  it("seals equal-longest policy ambiguity with no chosen target", async () => {
    const f = await fixture("ambiguous");
    const grant2 = `${f.grant}-two`;
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant2, `${f.logical}-two`, f.workspace, f.binding, f.principal),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')")
        .bind(grant2, f.workspace, f.principal, f.identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env, "staff-a", {
      grantId: grant2, identityId: f.identity, expectedPolicyVersion: null, accessNoticeEnabled: true, changeMode: "both",
      idempotencyKey: `policy-${grant2}-00000000`,
    });
    const key = `${f.prefix}receipt.bin`, accepted = await acceptAuthenticatedDeliveryChangeReceipt(env, change(key, "r2-version-ambiguous"), insertIndex(key, "content-etag"));
    expect((await receipt(key)).results).toMatchObject([{ candidate_count: 2, target_count: 0 }]);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipt_targets WHERE receipt_key=?")
      .bind(accepted.receiptKey).first("count")).toBe(0);
  });
});
