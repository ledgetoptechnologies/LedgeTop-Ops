import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const smtp = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("cloudflare:sockets", () => ({ connect: smtp.connect }));

import {
  incomingUploadReceivedDigestStatement,
  processIncomingUploadNotifications,
} from "../src/worker/incoming-upload-notifications";

const instances: Miniflare[] = [];
let delivery: D1Database;
let ops: D1Database;
let env: Env;

function scriptedSocket(options: { authCode?: number; suppressFinalReply?: boolean } = {}) {
  const writes: string[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let step = 0;
  let closed = false;
  const replies = [250, 334, 334, options.authCode ?? 235, 250, 250, 354, 250];
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode("220 Ready\r\n"));
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(value) {
      const line = new TextDecoder().decode(value);
      writes.push(line);
      const code = replies[step++];
      if (code === undefined) throw new Error("Unexpected SMTP write");
      if (options.suppressFinalReply && step === replies.length) return;
      controller.enqueue(new TextEncoder().encode(`${code} Synthetic response\r\n`));
    },
  });
  return {
    socket: {
      readable,
      writable,
      close: async () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      },
    },
    writes,
  };
}

async function row() {
  return delivery.prepare(`SELECT status,attempt_count,delivered_at,last_error_code
    FROM incoming_upload_notification_digests`).first();
}

async function makeDue(): Promise<void> {
  await delivery.prepare(`UPDATE incoming_upload_notification_digests SET
    quiet_until=datetime('now','-1 second'),next_attempt_at=datetime('now','-1 second')`).run();
}

beforeEach(async () => {
  const instance = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DELIVERY_DB: "joined-smtp-delivery", OPS_DB: "joined-smtp-ops" },
  });
  instances.push(instance);
  delivery = await instance.getD1Database("DELIVERY_DB") as unknown as D1Database;
  ops = await instance.getD1Database("OPS_DB") as unknown as D1Database;
  for (const name of [
    "0090_aliases_incoming_requests.sql",
    "0093_reusable_incoming_uploads.sql",
    "0116_incoming_upload_hardening.sql",
    "0198_incoming_upload_owner_notifications.sql",
    "0199_incoming_upload_pickup_lifecycle.sql",
    "0211_incoming_upload_verification_lifecycle.sql",
  ]) {
    const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")
      .replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
    await delivery.exec(sql.replace(/\s*\n\s*/g, " "));
  }
  await ops.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,
      access_subject TEXT,project_alpha_user_id TEXT,status TEXT NOT NULL);
    CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL);
    CREATE TABLE staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,
      scope TEXT NOT NULL,division_id TEXT);
    INSERT INTO staff_users VALUES('owner-staff','owner@example.test','Owner','owner-subject',NULL,'active');
    INSERT INTO role_permissions VALUES('role-owner','file_requests.view');
    INSERT INTO staff_role_assignments VALUES('owner-staff','role-owner','global',NULL);`.replace(/\s*\n\s*/g, " "));
  await delivery.batch([
    delivery.prepare(`INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version)
      VALUES('request-one','public-one','Field intake','owner-staff',datetime('now','+1 day'),10,1000,1)`),
    delivery.prepare(`INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash)
      VALUES('contributor-one','request-one','Taylor','contributor@example.test','address-hash')`),
    delivery.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,
      declared_size,actual_size,content_type,status,completed_at)
      VALUES('upload-one','request-one','contributor-one','quarantine/private/upload-one','multipart-one',
        'private.pdf',4,4,'application/pdf','quarantined',datetime('now'))`),
  ]);
  await incomingUploadReceivedDigestStatement(delivery, "upload-one").run();
  await makeDue();
  env = {
    DELIVERY_DB: delivery,
    OPS_DB: ops,
    SMTP_NOTIFICATIONS_ENABLED: "true",
    SMTP_HOST: "smtp.example.test",
    SMTP_USERNAME: "sender@example.test",
    SMTP_PASSWORD: "synthetic-password",
    SMTP_FROM: "sender@example.test",
  } as Env;
  smtp.connect.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(instances.splice(0).map(instance => instance.dispose()));
});

describe("incoming upload notification joined SMTP outcomes", () => {
  it("persists final DATA 250 as sent and never repeats it", async () => {
    const accepted = scriptedSocket();
    smtp.connect.mockReturnValue(accepted.socket);

    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "sent", attempt_count: 1,
      delivered_at: expect.any(String), last_error_code: null });
    expect(await processIncomingUploadNotifications(env)).toBe(0);
    expect(smtp.connect).toHaveBeenCalledOnce();
    expect(accepted.writes.at(-1)).toContain("\r\n.\r\n");
  });

  it("retries a definite SMTP 535 rejection before DATA", async () => {
    const rejected = scriptedSocket({ authCode: 535 });
    smtp.connect.mockReturnValue(rejected.socket);

    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "retry", attempt_count: 1,
      delivered_at: null, last_error_code: "mail-transport-failed" });
    expect(rejected.writes).toHaveLength(4);
  });

  it("fails configured-transport preflight before persisting a send marker", async () => {
    const missingPassword = { ...env, SMTP_PASSWORD: "" };
    expect(await processIncomingUploadNotifications(missingPassword)).toBe(1);
    expect(await row()).toEqual({ status: "retry", attempt_count: 1,
      delivered_at: null, last_error_code: "mail-transport-failed" });
    expect(smtp.connect).not.toHaveBeenCalled();
  });

  it("holds a missing final DATA acknowledgement for reconciliation without repeating", async () => {
    const uncertain = scriptedSocket({ suppressFinalReply: true });
    smtp.connect.mockReturnValue(uncertain.socket);

    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "failed", attempt_count: 1, delivered_at: null,
      last_error_code: "mail-delivery-uncertain-reconciliation-required" });
    expect(await processIncomingUploadNotifications(env)).toBe(0);
    expect(smtp.connect).toHaveBeenCalledOnce();
  }, 30_000);

  it("does not resend after DATA 250 when persisting the sent receipt fails", async () => {
    const first = scriptedSocket();
    const duplicate = scriptedSocket();
    smtp.connect.mockReturnValueOnce(first.socket).mockReturnValueOnce(duplicate.socket);
    const real = delivery;
    let failSentReceipt = true;
    const database = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (failSentReceipt && /UPDATE incoming_upload_notification_digests SET\s+status='sent'/.test(sql)) {
            failSentReceipt = false;
            return { bind: () => ({ run: async () => { throw new Error("synthetic D1 receipt failure"); } }) };
          }
          return target.prepare(sql);
        };
      },
    }) as unknown as D1Database;

    expect(await processIncomingUploadNotifications({ ...env, DELIVERY_DB: database })).toBe(1);
    expect(await row()).toEqual({ status: "failed", attempt_count: 1,
      delivered_at: null, last_error_code: "mail-delivery-uncertain-reconciliation-required" });
    await makeDue();
    expect(await processIncomingUploadNotifications(env)).toBe(0);
    expect(smtp.connect).toHaveBeenCalledOnce();
  });

  it("does not send when the exact-attempt marker CAS loses ownership", async () => {
    const real = delivery;
    const database = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => /SET\s+last_error_code=\?,updated_at/.test(sql)
          ? { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
          : target.prepare(sql);
      },
    }) as unknown as D1Database;

    expect(await processIncomingUploadNotifications({ ...env, DELIVERY_DB: database })).toBe(0);
    expect(smtp.connect).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: "processing", attempt_count: 1, last_error_code: null });
  });

  it("does not send when persisting the exact-attempt marker fails", async () => {
    const real = delivery;
    const database = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => /SET\s+last_error_code=\?,updated_at/.test(sql)
          ? { bind: () => ({ run: async () => { throw new Error("synthetic marker failure"); } }) }
          : target.prepare(sql);
      },
    }) as unknown as D1Database;

    await expect(processIncomingUploadNotifications({ ...env, DELIVERY_DB: database }))
      .rejects.toThrow("synthetic marker failure");
    expect(smtp.connect).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: "processing", attempt_count: 1, last_error_code: null });
  });

  it("does not adopt a newer claimant's attempt during post-claim readback", async () => {
    const real = delivery;
    let replaceClaim = true;
    const database = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!/WHERE digest\.id=\? AND digest\.status='processing'/.test(sql)) return prepared;
          return { bind: (...values: unknown[]) => {
            const bound = prepared.bind(...values);
            return { first: async () => {
              if (replaceClaim) {
                replaceClaim = false;
                await real.prepare(`UPDATE incoming_upload_notification_digests SET
                  attempt_count=attempt_count+1,lease_expires_at=datetime('now','+10 minutes')
                  WHERE id='incoming-upload-digest:request-one:contributor-one:v1'`).run();
              }
              return bound.first();
            } };
          } };
        };
      },
    }) as unknown as D1Database;

    expect(await processIncomingUploadNotifications({ ...env, DELIVERY_DB: database })).toBe(1);
    expect(smtp.connect).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: "processing", attempt_count: 2, last_error_code: null });
  });

  it("holds marked or exhausted expired work and increments a reclaimable unmarked attempt", async () => {
    await delivery.prepare(`UPDATE incoming_upload_notification_digests SET status='processing',attempt_count=3,
      lease_expires_at=datetime('now','-1 second'),last_error_code='mail-send-attempted:a3'`).run();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "failed", attempt_count: 3, delivered_at: null,
      last_error_code: "mail-delivery-uncertain-reconciliation-required" });
    expect(smtp.connect).not.toHaveBeenCalled();

    await delivery.prepare(`UPDATE incoming_upload_notification_digests SET status='processing',attempt_count=3,
      lease_expires_at=datetime('now','-1 second'),last_error_code=NULL`).run();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "failed", attempt_count: 3,
      delivered_at: null, last_error_code: "mail-transport-failed" });
    expect(smtp.connect).not.toHaveBeenCalled();

    await delivery.prepare(`UPDATE incoming_upload_notification_digests SET status='processing',attempt_count=2,
      lease_expires_at=datetime('now','-1 second'),last_error_code=NULL`).run();
    const accepted = scriptedSocket();
    smtp.connect.mockReturnValue(accepted.socket);
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "sent", attempt_count: 3,
      delivered_at: expect.any(String), last_error_code: null });
    expect(smtp.connect).toHaveBeenCalledOnce();
  });

  it("leaves the marker durable when the terminal hold write fails, then holds it after lease expiry", async () => {
    const accepted = scriptedSocket();
    smtp.connect.mockReturnValue(accepted.socket);
    const real = delivery;
    let failReceipt = true;
    let failHold = true;
    const database = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (failReceipt && /status='sent'/.test(sql)) {
            failReceipt = false;
            return { bind: () => ({ run: async () => { throw new Error("synthetic receipt failure"); } }) };
          }
          if (failHold && /status='failed'/.test(sql)) {
            failHold = false;
            return { bind: () => ({ run: async () => { throw new Error("synthetic hold failure"); } }) };
          }
          return target.prepare(sql);
        };
      },
    }) as unknown as D1Database;

    expect(await processIncomingUploadNotifications({ ...env, DELIVERY_DB: database })).toBe(1);
    expect(await row()).toMatchObject({ status: "processing", attempt_count: 1,
      last_error_code: "mail-send-attempted:a1" });
    await delivery.prepare("UPDATE incoming_upload_notification_digests SET lease_expires_at=datetime('now','-1 second')").run();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await row()).toEqual({ status: "failed", attempt_count: 1, delivered_at: null,
      last_error_code: "mail-delivery-uncertain-reconciliation-required" });
    expect(smtp.connect).toHaveBeenCalledOnce();
  });
});
