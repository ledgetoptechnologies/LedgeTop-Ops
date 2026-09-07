import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { acceptAuthenticatedDeliveryChangeReceipt } from "../src/worker/delivery-change-receipts";
import {
  prepareDeliveryIndexCreateAcceptance,
  prepareDeliveryIndexDeleteAcceptance,
  readDeliveryIndexObservation,
} from "../src/worker/delivery-index-acceptance";
import type { Env } from "../src/worker/types";

describe("delivery index provider-identity acceptance — migrated real D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let counter = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "delivery-index-acceptance" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    for (const name of ["0170_authenticated_delivery_change_notifications.sql", "0204_delivery_change_receipts.sql", "0206_delivery_index_provider_identity.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    env = { DELIVERY_DB: db, AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: "true" } as Env;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  function session() {
    return db.withSession("first-primary");
  }

  function object(key: string, version: string, etag = "same-content-etag", uploaded = new Date("2026-09-07T00:00:00.000Z")) {
    return { key, version, httpEtag: etag, size: 12, uploaded };
  }

  async function stored(key: string) {
    return db.prepare(`SELECT file_record.r2_key,file_record.provider_version,file_record.notification_observation_version,file_record.etag,
        file_record.size,file_record.uploaded_at,revisions.revision
      FROM delivery_file_index_revisions revisions LEFT JOIN file_index file_record ON file_record.r2_key=revisions.r2_key
      WHERE revisions.r2_key=?`).bind(key).first<Record<string, unknown>>();
  }

  async function acceptIndex(key: string, version: string, etag = "same-content-etag", uploaded = new Date("2026-09-07T00:00:00.000Z")) {
    const primary = session();
    const snapshot = await readDeliveryIndexObservation(primary, key);
    // D1 metadata counts trigger writes too. Receipt acceptance deliberately
    // uses SQLite changes(), which counts only the immediate index mutation.
    const results = await primary.batch<{applied:number}>([
      prepareDeliveryIndexCreateAcceptance(primary, snapshot, object(key, version, etag, uploaded)),
      primary.prepare("SELECT changes() applied"),
    ]);
    return { snapshot, applied: results[1]!.results[0]!.applied };
  }

  async function insertLegacy(key: string, etag = "legacy-etag") {
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,12,'2026-09-07T00:00:00.000Z','application/octet-stream','other')`).bind(key, etag).run();
  }

  it("fences a stale pre-HEAD snapshot across an absent-present-absent ABA and accepts only a fresh revision", async () => {
    const key = "Jobs/Clients/cas-aba/document.bin";
    const primary = session();
    const absent = await readDeliveryIndexObservation(primary, key);
    expect(absent).toMatchObject({ key, revision: 0, current: null });

    await insertLegacy(key, "racing-etag");
    await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run();
    const stale = await prepareDeliveryIndexCreateAcceptance(primary, absent, object(key, "provider-v1")).run();
    expect(stale.meta.changes).toBe(0);
    expect(await stored(key)).toMatchObject({ r2_key: null, revision: 2 });

    const accepted = await acceptIndex(key, "provider-v1");
    expect(accepted.snapshot).toMatchObject({ revision: 2, current: null });
    expect(accepted.applied).toBe(1);
    expect(await stored(key)).toMatchObject({ r2_key: key, provider_version: "provider-v1",
      notification_observation_version: "provider-v1", etag: "same-content-etag", revision: 3 });
  });

  it("clears a carried provider identity for a legacy metadata write, then accepts a same-content new provider once", async () => {
    const key = "Jobs/Clients/legacy-writer/document.bin";
    await acceptIndex(key, "provider-v1", "same-content-etag", new Date("2026-09-07T01:00:00.000Z"));
    await db.prepare("UPDATE file_index SET size=?,uploaded_at=? WHERE r2_key=?")
      .bind(13, "2026-09-07T01:01:00.000Z", key).run();
    const legacy = await stored(key);
    expect(legacy).toMatchObject({ r2_key: key, provider_version: null,
      notification_observation_version: "provider-v1", etag: "same-content-etag", size: 13 });

    const replacement = await acceptIndex(key, "provider-v2", "same-content-etag", new Date("2026-09-07T01:01:00.000Z"));
    expect(replacement.applied).toBe(1);
    const accepted = await stored(key);
    expect(accepted).toMatchObject({ provider_version: "provider-v2", notification_observation_version: "provider-v2",
      etag: "same-content-etag", size: 12, uploaded_at: "2026-09-07T01:01:00.000Z" });

    const alreadyAccepted = await acceptIndex(key, "provider-v2", "same-content-etag", new Date("2026-09-07T01:01:00.000Z"));
    expect(alreadyAccepted.applied).toBe(0);
    expect(await stored(key)).toEqual(accepted);
  });

  it("marks a pre-indexed provider without an observation marker exactly once", async () => {
    const key = "Jobs/Clients/pre-indexed/document.bin";
    await db.prepare(`INSERT INTO file_index(r2_key,provider_version,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,12,'2026-09-07T02:00:00.000Z','application/octet-stream','other')`)
      .bind(key, "provider-pre-indexed", "same-content-etag").run();
    expect((await readDeliveryIndexObservation(session(), key)).current).toMatchObject({ providerVersion: "provider-pre-indexed",
      notificationObservationVersion: null });

    const first = await acceptIndex(key, "provider-pre-indexed", "same-content-etag", new Date("2026-09-07T02:00:00.000Z"));
    expect(first.applied).toBe(1);
    expect(await stored(key)).toMatchObject({ provider_version: "provider-pre-indexed",
      notification_observation_version: "provider-pre-indexed" });
    const second = await acceptIndex(key, "provider-pre-indexed", "same-content-etag", new Date("2026-09-07T02:00:00.000Z"));
    expect(second.applied).toBe(0);
  });

  it("rejects missing or legacy delete identity and fences deletion after a replacement", async () => {
    const missing = await readDeliveryIndexObservation(session(), "Jobs/Clients/delete/missing.bin");
    expect(() => prepareDeliveryIndexDeleteAcceptance(session(), missing)).toThrow("removal-identity-unavailable");

    const legacyKey = "Jobs/Clients/delete/legacy.bin";
    await insertLegacy(legacyKey);
    const legacy = await readDeliveryIndexObservation(session(), legacyKey);
    expect(() => prepareDeliveryIndexDeleteAcceptance(session(), legacy)).toThrow("removal-identity-unavailable");

    const key = "Jobs/Clients/delete/replacement.bin";
    await acceptIndex(key, "provider-old", "old-etag", new Date("2026-09-07T03:00:00.000Z"));
    const primary = session();
    const beforeReplacement = await readDeliveryIndexObservation(primary, key);
    await db.prepare(`UPDATE file_index SET provider_version=?,notification_observation_version=?,etag=?,size=?,uploaded_at=? WHERE r2_key=?`)
      .bind("provider-new", "provider-new", "replacement-etag", 14, "2026-09-07T03:01:00.000Z", key).run();
    const removed = await prepareDeliveryIndexDeleteAcceptance(primary, beforeReplacement).run();
    expect(removed.meta.changes).toBe(0);
    expect(await stored(key)).toMatchObject({ r2_key: key, provider_version: "provider-new",
      notification_observation_version: "provider-new", etag: "replacement-etag", size: 14,
      uploaded_at: "2026-09-07T03:01:00.000Z" });
  });

  it("commits one index acceptance and its receipt despite auxiliary revision trigger writes", async () => {
    const key = "Jobs/Clients/receipt-success/document.bin";
    const primary = session();
    const snapshot = await readDeliveryIndexObservation(primary,key);
    const input = { key,present:true,objectVersion:"provider-accepted",etag:"accepted-etag",eventAt:"2026-09-07T04:00:00.000Z",
      delivery:{queue:"test-file-events",id:"accepted-with-revision-trigger"} };
    const accepted = await acceptAuthenticatedDeliveryChangeReceipt(env,input,
      prepareDeliveryIndexCreateAcceptance(primary,snapshot,object(key,input.objectVersion,input.etag)));
    expect(accepted.disposition).toBe("accepted");
    expect(await stored(key)).toMatchObject({provider_version:input.objectVersion,notification_observation_version:input.objectVersion,revision:1});
    expect(await db.prepare("SELECT index_applied FROM portal_authenticated_delivery_change_receipts WHERE receipt_key=?")
      .bind(accepted.receiptKey).first("index_applied")).toBe(1);
  });

  it("rolls back receipt acceptance so the index row and revision retain their authoritative pre-acceptance state", async () => {
    const key = "Jobs/Clients/receipt-rollback/document.bin";
    await acceptIndex(key, "provider-old", "old-etag", new Date("2026-09-07T04:00:00.000Z"));
    const before = await stored(key);
    const primary = session();
    const snapshot = await readDeliveryIndexObservation(primary, key);
    const mutation = prepareDeliveryIndexCreateAcceptance(primary, snapshot,
      object(key, "provider-new", "new-etag", new Date("2026-09-07T04:01:00.000Z")));
    await db.prepare(`CREATE TRIGGER test_delivery_index_receipt_abort BEFORE INSERT ON portal_authenticated_delivery_change_receipts
      BEGIN SELECT RAISE(ABORT,'test receipt rollback'); END`).run();
    counter++;
    try {
      await expect(acceptAuthenticatedDeliveryChangeReceipt(env, {
        key, present: true, objectVersion: "provider-new", etag: "new-etag", eventAt: "2026-09-07T04:01:00.000Z",
        delivery: { queue: "test-file-events", id: `rollback-${counter}` },
      }, mutation)).rejects.toThrow("test receipt rollback");
    } finally {
      await db.exec("DROP TRIGGER test_delivery_index_receipt_abort");
    }
    expect(await stored(key)).toEqual(before);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_receipts WHERE r2_key=?")
      .bind(key).first("count")).toBe(0);
  });
});
