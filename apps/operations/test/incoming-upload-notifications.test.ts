import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mailer = vi.hoisted(() => ({ sendNotificationMail: vi.fn() }));
vi.mock("../src/worker/mailer", () => ({ sendNotificationMail: mailer.sendNotificationMail }));

import {
  incomingUploadReceivedDigestStatement,
  processIncomingUploadNotifications,
} from "../src/worker/incoming-upload-notifications";

const instances: Miniflare[] = [];
let delivery: D1Database;
let ops: D1Database;
let env: Env;

async function addCompletedUpload(id: string, size: number, contributorId = "contributor-one"): Promise<void> {
  await delivery.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,
      declared_size,actual_size,content_type,status,completed_at)
    VALUES(?,'request-one',?,? ,?,'private-name.pdf',?,?,'application/pdf','quarantined',datetime('now'))`)
    .bind(id, contributorId, `quarantine/private/${id}`, `multipart-${id}`, size, size).run();
  await incomingUploadReceivedDigestStatement(delivery, id).run();
}

async function releaseQuietWindow(): Promise<void> {
  await delivery.prepare("UPDATE incoming_upload_notification_digests SET quiet_until=datetime('now','-1 second') WHERE status='pending'").run();
}

beforeEach(async () => {
  const instance = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DELIVERY_DB: "incoming-notification-delivery", OPS_DB: "incoming-notification-ops" } });
  instances.push(instance);
  delivery = await instance.getD1Database("DELIVERY_DB") as unknown as D1Database;
  ops = await instance.getD1Database("OPS_DB") as unknown as D1Database;
  for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0198_incoming_upload_owner_notifications.sql", "0199_incoming_upload_pickup_lifecycle.sql"]) {
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
    INSERT INTO staff_role_assignments VALUES('owner-staff','role-owner','global',NULL);`
    .replace(/\s*\n\s*/g, " "));
  await delivery.batch([
    delivery.prepare(`INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version)
      VALUES('request-one','public-one','Field intake <North>','owner-staff',datetime('now','+1 day'),10,1000,1)`),
    delivery.prepare(`INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash)
      VALUES('contributor-one','request-one','Taylor <Pilot>','contributor@example.test','address-hash')`),
  ]);
  await addCompletedUpload("upload-one", 4);
  mailer.sendNotificationMail.mockReset().mockResolvedValue(undefined);
  env = { DELIVERY_DB: delivery, OPS_DB: ops } as unknown as Env;
});

afterEach(async () => Promise.all(instances.splice(0).map(instance => instance.dispose())));

describe("incoming upload owner notification digests", () => {
  it("rolls files into one quiet-window digest and sends the active owner a safe summary", async () => {
    await addCompletedUpload("upload-two", 6);
    expect(await delivery.prepare(`SELECT digest_version,file_count,total_bytes,status,
      datetime(quiet_until)>datetime('now') quiet FROM incoming_upload_notification_digests`).first())
      .toEqual({ digest_version: 1, file_count: 2, total_bytes: 10, status: "pending", quiet: 1 });
    expect(await processIncomingUploadNotifications(env)).toBe(0);
    await releaseQuietWindow();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(1);
    const mail = mailer.sendNotificationMail.mock.calls[0]![1] as {
      to: string; subject: string; text: string; html: string; messageIdKey: string;
    };
    expect(mail.to).toBe("owner@example.test");
    expect(mail.subject).toBe("2 new files received and pending verification");
    expect(mail.text).toContain("Taylor <Pilot> uploaded 2 new files (10 bytes)");
    expect(mail.text).toContain("received and are pending verification");
    expect(mail.html).toContain("Taylor &lt;Pilot&gt;");
    expect(mail.html).toContain("Field intake &lt;North&gt;");
    expect(mail.messageIdKey).toBe("incoming-upload-digest:request-one:contributor-one:v1");
    expect(JSON.stringify(mail)).not.toContain("contributor@example.test");
    expect(JSON.stringify(mail)).not.toContain("quarantine/private");
    expect(JSON.stringify(mail)).not.toContain("private-name.pdf");
  });

  it("creates a new immutable generation when a file completes during send", async () => {
    await releaseQuietWindow();
    mailer.sendNotificationMail.mockImplementationOnce(async () => {
      await addCompletedUpload("upload-during-send", 7);
    });
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(await delivery.prepare(`SELECT digest_version,file_count,total_bytes,status
      FROM incoming_upload_notification_digests ORDER BY digest_version`).all()).toMatchObject({ results: [
      { digest_version: 1, file_count: 1, total_bytes: 4, status: "sent" },
      { digest_version: 2, file_count: 1, total_bytes: 7, status: "pending" },
    ] });
    await addCompletedUpload("upload-after-send", 9);
    expect(await delivery.prepare(`SELECT file_count,total_bytes FROM incoming_upload_notification_digests
      WHERE digest_version=2`).first()).toEqual({ file_count: 2, total_bytes: 16 });
    expect(await delivery.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digest_items").first())
      .toEqual({ count: 3 });
  });

  it("suppresses a digest when the request owner is not active", async () => {
    await ops.prepare("UPDATE staff_users SET status='inactive' WHERE id='owner-staff'").run();
    await releaseQuietWindow();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect(await delivery.prepare("SELECT status,last_error_code FROM incoming_upload_notification_digests").first())
      .toEqual({ status: "suppressed", last_error_code: "owner-recipient-unavailable" });
  });

  it("suppresses a queued digest when the owner receives an explicit view deny", async () => {
    await ops.prepare(`INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope,division_id)
      VALUES('owner-staff','file_requests.view','deny','global',NULL)`).run();
    await releaseQuietWindow();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect(await delivery.prepare("SELECT status,last_error_code FROM incoming_upload_notification_digests").first())
      .toEqual({ status: "suppressed", last_error_code: "owner-recipient-unauthorized" });
  });

  it("suppresses a queued digest when the owner's view grant is revoked", async () => {
    await ops.prepare("DELETE FROM staff_role_assignments WHERE staff_id='owner-staff' AND role_id='role-owner'").run();
    await releaseQuietWindow();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect(await delivery.prepare("SELECT status,last_error_code FROM incoming_upload_notification_digests").first())
      .toEqual({ status: "suppressed", last_error_code: "owner-recipient-unauthorized" });
  });

  it("retries instead of stranding a digest when current authorization cannot be read", async () => {
    await ops.prepare("DROP TABLE role_permissions").run();
    await releaseQuietWindow();
    expect(await processIncomingUploadNotifications(env)).toBe(1);
    expect(mailer.sendNotificationMail).not.toHaveBeenCalled();
    expect(await delivery.prepare(`SELECT status,attempt_count,lease_expires_at,last_error_code
      FROM incoming_upload_notification_digests`).first()).toEqual({ status: "retry", attempt_count: 1,
      lease_expires_at: null, last_error_code: "owner-authorization-check-failed" });
  });

  it("keeps retry content immutable, uses one Message-ID, and stops after three attempts", async () => {
    await releaseQuietWindow();
    mailer.sendNotificationMail.mockRejectedValue(new Error("transport included a secret that must not be stored"));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await processIncomingUploadNotifications(env)).toBe(1);
      const row = await delivery.prepare("SELECT status,attempt_count,file_count,total_bytes,last_error_code FROM incoming_upload_notification_digests WHERE digest_version=1").first();
      expect(row).toEqual({ status: attempt === 3 ? "failed" : "retry", attempt_count: attempt,
        file_count: 1, total_bytes: 4, last_error_code: "mail-transport-failed" });
      if (attempt === 1) await addCompletedUpload("upload-after-failure", 5);
      await delivery.prepare("UPDATE incoming_upload_notification_digests SET next_attempt_at=datetime('now','-1 second') WHERE status='retry'").run();
    }
    expect(await processIncomingUploadNotifications(env)).toBe(0);
    expect(mailer.sendNotificationMail).toHaveBeenCalledTimes(3);
    expect(mailer.sendNotificationMail.mock.calls.map(call => call[1].messageIdKey))
      .toEqual(Array(3).fill("incoming-upload-digest:request-one:contributor-one:v1"));
    expect(await delivery.prepare("SELECT digest_version,file_count,total_bytes,status FROM incoming_upload_notification_digests WHERE digest_version=2").first())
      .toEqual({ digest_version: 2, file_count: 1, total_bytes: 5, status: "pending" });
  });

  it("preserves the existing request deletion cascade", async () => {
    expect(await delivery.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digests").first())
      .toEqual({ count: 1 });
    expect(await delivery.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digest_items").first())
      .toEqual({ count: 1 });

    await delivery.prepare("DELETE FROM file_requests WHERE id='request-one'").run();

    expect(await delivery.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digests").first())
      .toEqual({ count: 0 });
    expect(await delivery.prepare("SELECT COUNT(*) count FROM incoming_upload_notification_digest_items").first())
      .toEqual({ count: 0 });
    expect(await delivery.prepare("SELECT COUNT(*) count FROM file_request_uploads").first())
      .toEqual({ count: 0 });
    expect(await delivery.prepare("SELECT COUNT(*) count FROM file_request_contributors").first())
      .toEqual({ count: 0 });
  });
});
