import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const mail = vi.hoisted(() => vi.fn());
vi.mock("../src/worker/mailer", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/worker/mailer")>()),
  sendNotificationMail: mail,
}));
const { processClientPortalRequestNotifications } = await import("../src/worker/notifications");

describe("native PA draft client notifications — real D1 dispatcher", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let sequence = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "native-pa-draft-notices" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const testBindings = {
      DELIVERY_DB: db,
      DELIVERY_BASE_URL: "https://client.example.test",
      PUBLIC_BASE_URL: "https://ops.example.test",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
    } satisfies Partial<Env>;
    // The dispatcher only reads these bindings here; mail transport is module-mocked.
    env = testBindings as Env;
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function fixture(label: string, options: { scopeStale?: boolean } = {}) {
    sequence += 1;
    const suffix = `${label}-${sequence}`, source = `project-alpha:native-${sequence}`, account = `account-${suffix}`,
      storage = `storage-${suffix}`, workspace = `workspace-${suffix}`, identity = `portal-${suffix}`,
      request = `request-${suffix}`, receipt = `receipt-${suffix}`, outbox = `outbox-${suffix}`, root = `org-${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES(?,?, 'active',?,?)`).bind(account, `Account ${suffix}`, root, source),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?, 'https://issuer.test',?,?)")
        .bind(storage, account, `storage-${suffix}`, `${suffix}@example.test`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?, 'manager')").bind(account, storage),
      db.prepare(`INSERT INTO pa_portal_source_authorities
        (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,?,'https://native.example.test','/api/portal','native_test','pending',1,1,1,1)`)
        .bind(source, `binding-${suffix}`),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions
        (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'native-test-credential','https://native.example.test','operations','native-test-subject','native-key',?,'test')`)
        .bind(source, "a".repeat(64)),
      db.prepare("UPDATE pa_portal_source_authorities SET state='active',version=2 WHERE source_id=?").bind(source),
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspace, source, `source-workspace-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Native workspace','active',?)`).bind(workspace, root, source),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?, 'https://issuer.test',?,?, 'active')")
        .bind(identity, `portal-${suffix}`, `${suffix}@example.test`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES(?,?,?,'project_alpha','active','member-v1')`).bind(`membership-${suffix}`, workspace, identity),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,'Native owner','member-v1','active')`).bind(workspace, `principal-${suffix}`, identity, `${suffix}@example.test`),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES(?,?,?,1,'active',1,datetime('now'))`).bind(`generation-${suffix}`, workspace, `generation-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,'Native organization','v1',1)`).bind(workspace, `generation-${suffix}`, root),
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(`generation-${suffix}`, workspace),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace, `generation-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,'request.create','allow','organization',?,'project_alpha','active')`).bind(`entitlement-${suffix}`, workspace, identity, root),
      db.prepare(`INSERT INTO portal_native_request_storage_bindings(workspace_id,source_id,account_id,storage_identity_id,state)
        VALUES(?,?,?,?, 'active')`).bind(workspace, source, account, storage),
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id,portal_workspace_id,portal_identity_id,portal_project_public_id)
        VALUES(?,?,NULL,?,'service','Native PA draft','Native root request','accepted_pending_pa_linkage',?,?,?, ?,?,NULL)`)
        .bind(request, account, storage, `request-key-${suffix}`, "b".repeat(43), source, workspace, identity),
      db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES(?,?,1,'client',?,'submitted','{}')`).bind(`revision-${suffix}`, request, storage),
      db.prepare(`INSERT INTO request_pa_draft_quote_commands
        (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
        VALUES(?,?,1,0,?,'https://native.example.test/api/drafts','operations','https://native.example.test',?,?,?,'{}','staff')`)
        .bind(`command-${suffix}`, request, source, "c".repeat(64), `command-key-${suffix}`, "d".repeat(64)),
      db.prepare(`INSERT INTO request_pa_draft_quote_receipts
        (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,project_alpha_receipt_id,project_alpha_artifact_public_id,artifact_status,artifact_version,editor_path,scope_stale_at,created_by,source_id,command_id)
        VALUES(?,?,1,0,?,?,'pa-receipt','pa-draft','draft',1,'/drafts/pa-draft',?,'staff',?,?)`)
        .bind(receipt, request, `command-key-${suffix}`, "d".repeat(64), options.scopeStale ? "2026-09-01T00:00:00.000Z" : null, source, `command-${suffix}`),
      db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        VALUES(?,?,'pa_draft_quote_created',NULL,'native_request_owner',?,'{}')`)
        .bind(outbox, request, `pa_draft_quote_created:${receipt}:native_request_owner`),
    ]);
    return { account, storage, identity, workspace, request, receipt, outbox, root, source };
  }

  it("writes one exact native inbox notice, audit, and sent outbox state without mailing", async () => {
    const row = await fixture("delivered");
    await expect(processClientPortalRequestNotifications(env)).resolves.toBe(1);
    expect(mail).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT event_type,source_id,dedupe_key FROM client_portal_notifications WHERE source_id=?")
      .bind(row.request).first()).toEqual({ event_type: "pa_draft_quote_created", source_id: row.request, dedupe_key: `service-request:${row.outbox}` });
    expect(await db.prepare("SELECT status,attempt_count,last_error FROM client_portal_notification_outbox WHERE id=?").bind(row.outbox).first())
      .toEqual({ status: "sent", attempt_count: 1, last_error: null });
    expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE action='client_request_notification.sent' AND entity_id=?").bind(row.request).first<number>("n")).toBe(1);

    await db.prepare("UPDATE client_portal_notification_outbox SET status='pending',attempt_count=0,lease_expires_at=NULL WHERE id=?").bind(row.outbox).run();
    await expect(processClientPortalRequestNotifications(env)).resolves.toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM client_portal_notifications WHERE source_id=?").bind(row.request).first<number>("n")).toBe(1);
    expect(await db.prepare("SELECT status,attempt_count FROM client_portal_notification_outbox WHERE id=?").bind(row.outbox).first())
      .toEqual({ status: "sent", attempt_count: 1 });
    expect(mail).not.toHaveBeenCalled();
  });

  it("suppresses a revoked native owner without inbox delivery or mail", async () => {
    const row = await fixture("revoked");
    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(row.workspace, row.identity).run();
    await expect(processClientPortalRequestNotifications(env)).resolves.toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM client_portal_notifications WHERE source_id=?").bind(row.request).first<number>("n")).toBe(0);
    expect(await db.prepare("SELECT status,last_error FROM client_portal_notification_outbox WHERE id=?").bind(row.outbox).first())
      .toEqual({ status: "suppressed", last_error: "native-recipient-no-longer-authorized" });
    expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE action='client_request_notification.suppressed' AND entity_id=?").bind(row.request).first<number>("n")).toBe(1);
    expect(mail).not.toHaveBeenCalled();
  });

  it.each(["scope stale", "request revision", "area revision", "conflicting inbox", "root denied", "request entitlement revoked"] as const)(
    "suppresses a native PA draft intent when its current authority is invalid: %s", async scenario => {
      const row = await fixture(`invalid-${scenario.replaceAll(" ", "-")}`, { scopeStale: scenario === "scope stale" });
      if (scenario === "request revision") await db.prepare(`INSERT INTO request_revisions
        (id,request_id,revision_number,author_type,author_id,action,snapshot_json)
        VALUES(?,?,2,'staff','staff','status_changed','{}')`).bind(`revision-changed-${row.request}`, row.request).run();
      if (scenario === "area revision") await db.prepare(`INSERT INTO client_service_request_area_revisions
        (id,request_id,revision_number,base_request_updated_at,area_geojson,poi_points_json,reason,change_summary,created_by,mutation_key,mutation_fingerprint)
        VALUES(?,?,1,'2026-08-01T00:00:00.000Z',NULL,'[]','Reviewed boundary','Changed area','staff',?,?)`)
        .bind(`area-changed-${row.request}`, row.request, `area-key-${row.request}`, "e".repeat(64)).run();
      if (scenario === "conflicting inbox") await db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES(?,?,?,'pa_draft_quote_created','service_request',?,?,'Conflicting title','Conflicting body','/portal/requests')`)
        .bind(`conflict-${row.request}`, row.account, row.storage, row.request, `service-request:${row.outbox}`).run();
      if (scenario === "root denied") await db.prepare(`INSERT INTO portal_v2_root_access_policies
        (projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
        VALUES(?,'organization',?,'revoked','test-revoked','staff','staff')`).bind(row.source, row.root).run();
      if (scenario === "request entitlement revoked") await db.prepare(`UPDATE portal_v2_entitlements
        SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=? AND capability='request.create'`)
        .bind(row.workspace, row.identity).run();

      await expect(processClientPortalRequestNotifications(env)).resolves.toBe(1);
      expect(await db.prepare("SELECT status,last_error FROM client_portal_notification_outbox WHERE id=?").bind(row.outbox).first())
        .toEqual({ status: "suppressed", last_error: "native-recipient-no-longer-authorized" });
      expect(await db.prepare("SELECT count(*) n FROM client_portal_notifications WHERE source_id=?").bind(row.request).first<number>("n"))
        .toBe(scenario === "conflicting inbox" ? 1 : 0);
      expect(await db.prepare("SELECT count(*) n FROM audit_log WHERE action='client_request_notification.suppressed' AND entity_id=?").bind(row.request).first<number>("n")).toBe(1);
      expect(mail).not.toHaveBeenCalled();
    },
  );
});
