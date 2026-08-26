import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDeliveryNotifications, processProjectAlphaDeliveryPortalNotifications } from "../src/worker/notifications";
import { sendNotificationMail } from "../src/worker/mailer";
import type { Env } from "../src/worker/types";

vi.mock("../src/worker/mailer", () => ({ sendNotificationMail: vi.fn(async () => undefined) }));
const directory = new URL("../../client/migrations/", import.meta.url);
const migrations = readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name)).sort()
  .map(name => readFileSync(new URL(name, directory), "utf8"));
const prefix = "jobs/shared/project/", email = "same-email@example.test";

// Real production SQL and full migration chain. Only mail transport is mocked;
// the D1-shaped adapter never fabricates query or authorization results.
function asD1(db: DatabaseSync): D1Database {
  const adapter = {
    withSession: () => adapter,
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) { bindings = values; return statement; },
        async first(column?: string) {
          const row = db.prepare(sql).get(...bindings);
          return column === undefined ? row ?? null : row?.[column] ?? null;
        },
        async all() { return { results: db.prepare(sql).all(...bindings) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...bindings).changes) } }; },
      };
      return statement;
    },
  };
  return adapter as unknown as D1Database;
}

describe("delivery notification source and live ownership", () => {
  let db: DatabaseSync, env: Env;
  beforeEach(() => {
    vi.mocked(sendNotificationMail).mockClear();
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) { db.exec("BEGIN"); db.exec(sql); db.exec("COMMIT"); }
    env = { DELIVERY_DB: asD1(db), DELIVERY_BASE_URL: "https://client.example.test",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true" } as Env;
    for (const name of ["primary", "secondary"]) {
      const source = `project-alpha:${name}`, workspace = `workspace-${name}`, generation = `generation-${name}`;
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .run(workspace, source, workspace);
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
        VALUES(?,'organization','same-organization',?,?)`).run(workspace, name, source);
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'snapshot',1,'active',1)`).run(generation, workspace);
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .run(workspace, generation);
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'project','same-project',NULL,'Project','binding-v1')`).run(workspace, generation);
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES(?,?,'project','same-project',?,'project_alpha','binding-v1')`).run(`binding-${name}`, workspace, prefix);
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
        VALUES(?,'same-principal',?,?,'principal-v1','active')`).run(workspace, email, name);
    }
  });
  afterEach(() => { expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]); db.close(); });

  function receipt(name: string, kind: "guest" | "portal", resource: string) {
    db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,project_alpha_source_id)
      VALUES(?,?,?,?,?,?)`).run(`receipt-${name}`, `delivery-${name}`, "a".repeat(64), kind, resource, `project-alpha:${name}`);
  }
  function guest(name: string) {
    db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES(?,'Client','Project',?,?,'same-project')`).run(`project-${name}`, prefix, `project-alpha:${name}`);
    db.prepare(`INSERT INTO shares(id,project_id,token_hash,r2_prefix,created_by_type,created_by_id,recipient_email)
      VALUES(?,?,?,?,'integration',?,?)`).run(`share-${name}`, `project-${name}`, `hash-${name}`, prefix, `delivery-${name}`, email);
    receipt(name, "guest", `share-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_guest_authority
      (share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,principal_public_id,principal_source_version)
      VALUES(?,?,?,'binding-v1',?,'same-principal','principal-v1')`)
      .run(`share-${name}`, `workspace-${name}`, `binding-${name}`, `generation-${name}`);
    db.prepare(`INSERT INTO delivery_notifications(id,dedupe_key,share_id,kind,recipient_email,payload_json)
      VALUES(?,?,?,'share_created',?,?)`).run(`notice-${name}`, `dedupe-${name}`, `share-${name}`, email,
        JSON.stringify({ projectName: "Project", shareUrl: "https://delivery.example.test/r/test-only" }));
  }
  function portal(name: string, attempted = true) {
    receipt(name, "portal", `grant-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
      (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,actor_id)
      VALUES(?,?,?,?,'binding-v1','principal','same-principal','principal-v1',?)`)
      .run(`grant-${name}`, `receipt-${name}`, `workspace-${name}`, `binding-${name}`, `delivery-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox
      (id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type,attempt_count)
      VALUES(?,?,?,'same-principal','principal-v1','granted',?)`).run(`notice-${name}`, `receipt-${name}`, `grant-${name}`, attempted ? 1 : 0);
  }

  it("sends valid primary guest mail despite another source's identical prefix, IDs and email", async () => {
    guest("primary");
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: "notice-primary" }));
    expect(db.prepare("SELECT status FROM delivery_notifications").get()?.status).toBe("sent");
  });

  it("suppresses guest mail rather than borrowing the overlapping primary recipient", async () => {
    guest("secondary");
    db.exec("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-secondary'");
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,last_error FROM delivery_notifications").get())
      .toEqual({ status: "failed", last_error: "recipient-no-longer-eligible" });
    expect(db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get()?.action).toBe("notification.suppressed");
  });

  it("suppresses a guest notice whose exact source generation is no longer selected", async () => {
    guest("primary");
    db.exec(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES('generation-next','workspace-primary','snapshot-next',2,'active',1);
      UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-next',source_sequence=2 WHERE workspace_id='workspace-primary'`);
    await processDeliveryNotifications(env);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM delivery_notifications").get()?.status).toBe("failed");
  });

  it("retains attempted primary portal mail while terminally suppressing a synthetic secondary portal notice", async () => {
    portal("primary"); portal("secondary");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: "notice-primary" }));
    expect(db.prepare("SELECT id,status FROM project_alpha_delivery_portal_notification_outbox ORDER BY id").all()).toEqual([
      { id: "notice-primary", status: "sent" }, { id: "notice-secondary", status: "suppressed" },
    ]);
    expect(db.prepare("SELECT last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.last_error)
      .toBe("authorization-no-longer-live");
  });

  it("stages untouched primary portal mail without borrowing another source's overlapping recipient", async () => {
    portal("primary", false); portal("secondary", false);
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(0);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    const staged = db.prepare("SELECT id,status,source_id FROM portal_delivery_notification_batches").all();
    expect(staged).toEqual([{ id: expect.any(String), status: "pending", source_id: "project-alpha:primary" }]);
    expect(db.prepare("SELECT last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.last_error)
      .toBe("authorization-no-longer-live");
    db.exec("UPDATE portal_delivery_notification_batches SET eligible_at=datetime('now','-1 second')");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: `native-batch-${staged[0]!.id}` }));
    expect(db.prepare("SELECT status FROM portal_delivery_notification_batches").get()?.status).toBe("sent");
  });

  it.each(["guest", "portal"] as const)("suppresses %s mail when the owner's source revision no longer matches its binding", async kind => {
    if (kind === "guest") guest("primary"); else portal("primary");
    db.exec("UPDATE portal_v2_directory_entities SET source_version='owner-v2' WHERE workspace_id='workspace-primary'");
    if (kind === "guest") await processDeliveryNotifications(env); else await processProjectAlphaDeliveryPortalNotifications(env);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    const table = kind === "guest" ? "delivery_notifications" : "project_alpha_delivery_portal_notification_outbox";
    expect(db.prepare(`SELECT status FROM ${table}`).get()?.status).toBe(kind === "guest" ? "failed" : "suppressed");
  });
});
