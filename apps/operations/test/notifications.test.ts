import { describe, expect, it, vi } from "vitest";
import {
  buildServiceRequestNotificationSnapshot,
  parseServiceRequestNotificationSnapshot,
  PRIMARY_ALPHA_SOURCE_ID,
} from "@ltds/shared";
import {
  enqueueExpiringNotifications,
  normalizeRecipientEmail,
  notificationDedupeKey,
  processClientPortalRequestNotifications,
  renderClientRequestNotification,
  renderNotification,
} from "../src/worker/notifications";
import { buildSmtpMessage, smtpNotificationsEnabled } from "../src/worker/mailer";
import type { Env } from "../src/worker/types";

interface D1Call { sql: string; binds: unknown[] }

function recordingDatabase(callbacks: {
  first?: (call: D1Call) => unknown;
  all?: (call: D1Call) => unknown[];
  changes?: (call: D1Call) => number;
  run?: (call: D1Call) => void;
}) {
  const calls: D1Call[] = [];
  const database = {
    withSession() { return database; },
    prepare(sql: string) {
      const call: D1Call = { sql, binds: [] };
      calls.push(call);
      const statement = {
        bind(...binds: unknown[]) { call.binds = binds; return statement; },
        async first<T>() { return (callbacks.first?.(call) ?? null) as T | null; },
        async all<T>() { return { results: (callbacks.all?.(call) ?? []) as T[] }; },
        async run<T>() {
          callbacks.run?.(call);
          return { results: [] as T[], meta: { changes: callbacks.changes?.(call) ?? 1 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map(statement => statement.run()));
    },
  };
  return { database: database as unknown as D1Database, calls };
}

function requestNotificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "notice-source",
    request_id: "request-source",
    catalog_source_id: PRIMARY_ALPHA_SOURCE_ID,
    account_source_id: PRIMARY_ALPHA_SOURCE_ID,
    project_source_id: null,
    event_type: "request_status_changed",
    status_value: "under_review",
    recipient_kind: "client_requester",
    payload_json: "{}",
    attempt_count: 0,
    title: "North site imagery",
    project_id: null,
    service_category: "Progress mapping",
    location_text: "North site",
    latitude: null,
    longitude: null,
    project_name: null,
    requester_email: "client@example.test",
    account_id: "account-source",
    requester_identity_id: "identity-source",
    ...overrides,
  };
}

describe("client notifications", () => {
  it("keeps legacy expiring-share notifications active before recipient snapshots", async () => {
    const value = recordingDatabase({
      first: call => call.sql.includes("sqlite_master") ? { count: 0 } : null,
      all: call => call.sql.includes("FROM shares s JOIN projects p") ? [{
        id: "share-legacy",
        recipient_email: "legacy@example.test",
        recipient_principal_public_id: null,
        public_id: "public-legacy",
        client_name: "Acme",
        project_name: "North site",
        r2_prefix: "Jobs/Clients/Acme/North/",
        expires_at: "2026-08-16 12:00:00",
      }] : [],
    });
    await expect(enqueueExpiringNotifications({
      DELIVERY_DB: value.database,
    } as unknown as Env)).resolves.toBe(1);
    expect(value.calls.some(call => call.sql.includes("JOIN delivery_share_audience_snapshots"))).toBe(false);
    const insert = value.calls.find(call => call.sql.includes("INSERT OR IGNORE INTO delivery_notifications"));
    expect(insert?.binds[1]).toBe("expiring_72h:share-legacy:2026-08-16 12:00:00");
    expect(insert?.binds[4]).toBe("legacy@example.test");
  });

  it("delivers request email without retrying when the additive portal inbox is absent", async () => {
    let outboxReads = 0;
    const snapshot = buildServiceRequestNotificationSnapshot({
      title: "North site imagery",
      projectId: null,
      serviceCategory: "Progress mapping",
      locationLabel: "North site",
      lifecycle: "under_review",
      action: "open_client_portal",
    });
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 0 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) {
          outboxReads += 1;
          return outboxReads === 1 ? {
            id: "notice-legacy",
            request_id: "request-legacy",
            catalog_source_id: PRIMARY_ALPHA_SOURCE_ID,
            account_source_id: PRIMARY_ALPHA_SOURCE_ID,
            project_source_id: null,
            event_type: "request_status_changed",
            status_value: "under_review",
            recipient_kind: "client_requester",
            payload_json: JSON.stringify(snapshot),
            attempt_count: 0,
            title: "North site imagery",
            project_id: null,
            service_category: "Progress mapping",
            location_text: "North site",
            latitude: null,
            longitude: null,
            project_name: null,
            requester_email: "client@example.test",
            account_id: "account-legacy",
            requester_identity_id: "identity-legacy",
          } : null;
        }
        return null;
      },
    });
    const send = async () => undefined;
    const emailSend = vi.fn(send);
    await expect(processClientPortalRequestNotifications({
      DELIVERY_DB: value.database,
      DELIVERY_BASE_URL: "https://client.example",
      PUBLIC_BASE_URL: "https://ops.example",
      NOTIFICATION_FROM: "notifications@example.test",
      NOTIFICATION_EMAIL: { send: emailSend },
    } as unknown as Env)).resolves.toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(value.calls.some(call => call.sql.includes("INSERT OR IGNORE INTO client_portal_notifications"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(true);
  });

  it.each(["project-alpha:secondary", null, undefined])("terminally suppresses client notices without a supported explicit source (%s), before rendering or delivery", async source => {
    let outboxReads = 0;
    const row = requestNotificationRow({
      catalog_source_id: source,
      // These fail if recipient resolution or rendering runs before suppression.
      requester_email: "not-an-email",
      payload_json: "not-json",
    });
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 1 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) return ++outboxReads === 1 ? row : null;
        return null;
      },
    });
    const emailSend = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({
      DELIVERY_DB: value.database,
      DELIVERY_BASE_URL: "not-a-url",
      NOTIFICATION_EMAIL: { send: emailSend },
    } as unknown as Env)).resolves.toBe(1);
    expect(emailSend).not.toHaveBeenCalled();
    expect(value.calls.some(call => call.sql.includes("INSERT OR IGNORE INTO client_portal_notifications"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("next_attempt_at=datetime('now',?)"))).toBe(false);
    const claimIndex = value.calls.findIndex(call => call.sql.includes("SET status='processing'"));
    const suppressIndex = value.calls.findIndex(call => call.sql.includes("SET status='suppressed'"));
    expect(claimIndex).toBeGreaterThan(-1);
    expect(suppressIndex).toBeGreaterThan(claimIndex);
    expect(value.calls[suppressIndex]?.binds).toEqual(["unsupported-catalog-source", row.id, 1]);
    expect(value.calls[suppressIndex]?.sql).toContain("lease_expires_at=NULL");
    expect(value.calls[suppressIndex]?.sql).toContain("AND status='processing'");
    const audit = value.calls.find(call => call.sql.includes("INSERT INTO audit_log"));
    expect(audit?.binds[0]).toBe("client_request_notification.suppressed");
    expect(JSON.parse(String(audit?.binds[2]))).toMatchObject({ attempt: 1, reason: "unsupported-catalog-source" });
    expect(value.calls.find(call => call.sql.includes("FROM client_portal_notification_outbox"))?.sql).toContain("r.catalog_source_id");
  });

  it.each(["account_source_id", "project_source_id"])("suppresses client notices with secondary %s before mail or inbox delivery", async field => {
    let reads = 0;
    const row = requestNotificationRow({ [field]: "project-alpha:secondary", requester_email: "invalid", payload_json: "invalid" });
    const value = recordingDatabase({ first: call => {
      if (call.sql.includes("sqlite_master")) return { count: 1 };
      if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? row : null;
      return null;
    } });
    const send = vi.fn();
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database, NOTIFICATION_EMAIL: { send } } as unknown as Env)).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(value.calls.some(call => call.sql.includes("INSERT OR IGNORE INTO client_portal_notifications"))).toBe(false);
    expect(value.calls.find(call => call.sql.includes("SET status='suppressed'"))?.binds).toEqual(["unsupported-business-source", row.id, 1]);
  });

  it.each([
    { source: PRIMARY_ALPHA_SOURCE_ID, recipientKind: "client_requester", to: "client@example.test", inbox: true },
    { source: "project-alpha:secondary", recipientKind: "staff_triage", to: "triage@example.test", inbox: false },
  ])("preserves $recipientKind delivery for $source", async ({ source, recipientKind, to, inbox }) => {
    let outboxReads = 0;
    const row = requestNotificationRow({ catalog_source_id: source, account_source_id: source, recipient_kind: recipientKind });
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 1 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) return ++outboxReads === 1 ? row : null;
        return null;
      },
    });
    const emailSend = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({
      DELIVERY_DB: value.database,
      DELIVERY_BASE_URL: "https://client.example",
      PUBLIC_BASE_URL: "https://ops.example",
      CLIENT_REQUEST_TRIAGE_TO: "triage@example.test",
      NOTIFICATION_FROM: "notifications@example.test",
      NOTIFICATION_EMAIL: { send: emailSend },
    } as unknown as Env)).resolves.toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({ to }));
    expect(value.calls.some(call => call.sql.includes("INSERT OR IGNORE INTO client_portal_notifications"))).toBe(inbox);
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(true);
    expect(value.calls.some(call => call.sql.includes("SET status='suppressed'"))).toBe(false);
    const audit = value.calls.find(call => call.sql.includes("INSERT INTO audit_log"));
    expect(audit?.binds[0]).toBe("client_request_notification.sent");
  });

  it("retries a database delivery failure instead of suppressing the claimed request notice", async () => {
    let reads = 0;
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 0 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? requestNotificationRow() : null;
        return null;
      },
      run: call => { if (call.sql.includes("SET status='sent'")) throw new Error("d1-temporary"); },
    });
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database, DELIVERY_BASE_URL: "https://client.example", PUBLIC_BASE_URL: "https://ops.example", NOTIFICATION_FROM: "notifications@example.test", NOTIFICATION_EMAIL: { send: async () => undefined } } as unknown as Env)).resolves.toBe(1);
    const retry = value.calls.find(call => call.sql.includes("next_attempt_at=datetime('now',?)"));
    expect(retry?.binds).toEqual(["pending", "+10 minutes", "d1-temporary", "notice-source", 1]);
    expect(value.calls.some(call => call.sql.includes("SET status='suppressed'"))).toBe(false);
  });

  it("does not overwrite a newer outbox state when the claimed attempt lease is stale", async () => {
    let reads = 0;
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 0 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? requestNotificationRow() : null;
        return null;
      },
      changes: call => call.sql.includes("SET status='sent'") ? 0 : 1,
    });
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database, DELIVERY_BASE_URL: "https://client.example", PUBLIC_BASE_URL: "https://ops.example", NOTIFICATION_FROM: "notifications@example.test", NOTIFICATION_EMAIL: { send: async () => undefined } } as unknown as Env)).resolves.toBe(1);
    const sent = value.calls.find(call => call.sql.includes("delivered_at=datetime('now')"));
    expect(sent?.sql).toContain("attempt_count=?");
    expect(sent?.sql).toContain("lease_expires_at");
    expect(sent?.binds).toEqual(["notice-source", 1]);
    expect(value.calls.some(call => call.sql.includes("INSERT INTO audit_log"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("next_attempt_at=datetime('now',?)"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("SET status='suppressed'"))).toBe(false);
  });

  it.each([true, false])("rechecks primary draft receipt before delivery (current=%s)", async current => {
    let reads = 0;
    const row = requestNotificationRow({ event_type: "pa_draft_quote_created" });
    const value = recordingDatabase({ first: call => {
      if (call.sql.includes("sqlite_master")) return { count: 1 };
      if (call.sql.includes("SELECT EXISTS(") && call.sql.includes("request_pa_draft_quote_receipts")) return current ? 1 : 0;
      if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? row : null;
      return null;
    } });
    const send = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database,
      DELIVERY_BASE_URL: "https://client.example", PUBLIC_BASE_URL: "https://ops.example",
      NOTIFICATION_FROM: "notifications@example.test", NOTIFICATION_EMAIL: { send },
    } as unknown as Env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(current ? 1 : 0);
    const receipt = value.calls.find(call => call.sql.includes("SELECT EXISTS(") && call.sql.includes("request_pa_draft_quote_receipts"));
    expect(receipt?.sql).toContain("receipt.scope_stale_at IS NULL");
    expect(receipt?.sql).toContain("receipt.request_revision=");
    expect(receipt?.sql).toContain("receipt.area_revision=");
    expect(receipt?.binds).toEqual([row.id, 1, row.request_id, row.account_id, row.requester_identity_id, PRIMARY_ALPHA_SOURCE_ID]);
    expect(value.calls.some(call => call.sql.includes("INSERT OR IGNORE INTO client_portal_notifications"))).toBe(current);
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(current);
    expect(value.calls.some(call => call.sql.includes("last_error='draft-receipt-no-longer-current'"))).toBe(!current);
  });

  it("delivers a current secondary native request owner only to the in-app inbox, with a live scope and revocation guard", async () => {
    let reads = 0;
    const row = requestNotificationRow({
      catalog_source_id: "project-alpha:secondary", account_source_id: "project-alpha:secondary",
      recipient_kind: "native_request_owner", event_type: "pa_draft_quote_created",
      portal_workspace_id: "workspace-native", portal_identity_id: "identity-native", requester_email: "not-an-email",
    });
    const value = recordingDatabase({
      first: call => {
        if (call.sql.includes("sqlite_master")) return { count: 1 };
        if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? row : null;
        if (call.sql.includes("FROM client_service_requests request")) return {
          rootType: "organization", rootPublicId: "org-native", generationId: "generation-native", sourceSequence: 7,
          authorityRevision: 3, authorityVersion: 9, connectorRevision: 4, connectorVersion: 11,
        };
        if (call.sql.includes("SELECT portal_project_public_id")) return "project-native";
        return null;
      },
      all: call => call.sql.includes("WITH RECURSIVE") ? [
        { entity_type: "project", public_id: "project-native", retained: 1, depth: 0 },
        { entity_type: "organization", public_id: "org-native", retained: 1, depth: 1 },
      ] : [],
    });
    const emailSend = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({
      DELIVERY_DB: value.database, DELIVERY_BASE_URL: "https://client.example", NOTIFICATION_EMAIL: { send: emailSend },
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
    } as unknown as Env)).resolves.toBe(1);
    expect(emailSend).not.toHaveBeenCalled();
    const inbox = value.calls.find(call => call.sql.includes("INSERT INTO client_portal_notifications"));
    expect(inbox?.binds).toContain("pa_draft_quote_created");
    expect(inbox?.sql).toContain("portal_v2_entitlements");
    expect(inbox?.sql).toContain("portal_v2_identity_denials");
    expect(inbox?.sql).toContain("checkpoint.active_generation_id=?");
    expect(value.calls.some(call => call.sql.includes("unsupported-catalog-source"))).toBe(false);
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(true);
  });

  it("suppresses a native draft notice when the current generation no longer contains its project, without sending mail", async () => {
    let reads = 0;
    const row = requestNotificationRow({ catalog_source_id: "project-alpha:secondary", account_source_id: "project-alpha:secondary",
      recipient_kind: "native_request_owner", event_type: "pa_draft_quote_created", portal_workspace_id: "workspace-native", portal_identity_id: "identity-native" });
    const value = recordingDatabase({ first: call => {
      if (call.sql.includes("sqlite_master")) return { count: 1 };
      if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? row : null;
      if (call.sql.includes("FROM client_service_requests request")) return { rootType: "organization", rootPublicId: "org-native", generationId: "generation-next", sourceSequence: 8, authorityRevision: 3, authorityVersion: 9, connectorRevision: 4, connectorVersion: 11 };
      if (call.sql.includes("SELECT portal_project_public_id")) return "project-revoked";
      return null;
    }, all: () => [] });
    const emailSend = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database, NOTIFICATION_EMAIL: { send: emailSend } } as unknown as Env)).resolves.toBe(1);
    expect(emailSend).not.toHaveBeenCalled();
    expect(value.calls.find(call => call.sql.includes("SET status='suppressed'") && call.sql.includes("last_error='native-recipient-no-longer-authorized'"))?.binds).toEqual([row.id, 1]);
  });

  it("delivers a root-scoped native draft notice without inventing a project grant", async () => {
    let reads = 0;
    const row = requestNotificationRow({ catalog_source_id: "project-alpha:secondary", account_source_id: "project-alpha:secondary", recipient_kind: "native_request_owner", event_type: "pa_draft_quote_created", portal_workspace_id: "workspace-root", portal_identity_id: "identity-root" });
    const value = recordingDatabase({ first: call => {
      if (call.sql.includes("sqlite_master")) return { count: 1 };
      if (call.sql.includes("FROM client_portal_notification_outbox")) return ++reads === 1 ? row : null;
      if (call.sql.includes("FROM client_service_requests request")) return { rootType: "organization", rootPublicId: "org-root", generationId: "generation-root", sourceSequence: 1, authorityRevision: 1, authorityVersion: 1, connectorRevision: 1, connectorVersion: 1 };
      if (call.sql.includes("SELECT portal_project_public_id")) return { project_public_id: null };
      return null;
    }, all: call => call.sql.includes("WITH RECURSIVE") ? [{ entity_type: "organization", public_id: "org-root", retained: 1, depth: 0 }] : [] });
    const send = vi.fn(async () => undefined);
    await expect(processClientPortalRequestNotifications({ DELIVERY_DB: value.database, DELIVERY_BASE_URL: "https://client.example", NOTIFICATION_EMAIL: { send } } as unknown as Env)).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(value.calls.some(call => call.sql.includes("SET status='sent'"))).toBe(true);
  });

  it("normalizes optional recipient email and rejects malformed values", () => {
    expect(normalizeRecipientEmail("  Client@Example.com ")).toBe("client@example.com");
    expect(normalizeRecipientEmail(null)).toBeNull();
    expect(() => normalizeRecipientEmail("not-an-email")).toThrow("invalid");
  });

  it("uses stable first-access keys and never renders an access code", () => {
    expect(notificationDedupeKey("first_access", "share-1")).toBe("first_access:share-1");
    const message = renderNotification("share_created", { projectName: "Demo", shareUrl: "https://delivery.example/s/id#secret" });
    expect(message.text).toContain("https://delivery.example/s/id#secret");
    expect(message.text.toLowerCase()).not.toContain("access code");
  });

  it("enables SMTP only through an explicit flag and renders injection-safe MIME", () => {
    expect(smtpNotificationsEnabled({ SMTP_NOTIFICATIONS_ENABLED: "true" } as never)).toBe(true);
    expect(smtpNotificationsEnabled({ SMTP_NOTIFICATIONS_ENABLED: "TRUE" } as never)).toBe(false);
    const mail = { to: "client@example.com", fromName: "LTDS", subject: "Hello\r\nBcc: attacker@example.com", text: "Plain text", html: "<p>HTML</p>", messageIdKey: "outbox-request-42" };
    const message = buildSmtpMessage(mail, "no-reply@example.com");
    expect(message).toContain("Subject: Hello Bcc: attacker@example.com");
    expect(message).not.toContain("\r\nBcc:");
    expect(message).toContain("Content-Transfer-Encoding: base64");
    expect(message).toContain("Message-ID: <outbox-request-42@example.com>");
    expect(buildSmtpMessage(mail, "no-reply@example.com")).toContain("Message-ID: <outbox-request-42@example.com>");
  });

  it("renders a stable existing-project triage message without internal or financial fields", () => {
    const stored = {
      ...buildServiceRequestNotificationSnapshot({
        title: "North site progress imagery",
        projectId: "project-north",
        projectName: "North Distribution Center",
        serviceCategory: "Progress mapping",
        locationLabel: "Broadway, Green Bay, Wisconsin",
        lifecycle: "submitted",
        action: "review_in_operations",
      }),
      requestType: "flight",
      internalStatus: "accepted_pending_pa_linkage",
      estimateAmountMinor: 125000,
      currency: "USD",
      quoteDocumentNumber: "Q-0042",
      siteContactEmail: "site-contact@example.com",
      billingContact: "billing@example.com",
    };
    const snapshot = parseServiceRequestNotificationSnapshot(stored);
    expect(snapshot).not.toBeNull();
    const rendered = renderClientRequestNotification(snapshot!, "https://ops.example/operations/client-requests/request-north");
    expect(rendered.subject).toBe("New service request: North site progress imagery");
    expect(rendered.text).toContain("Existing project — North Distribution Center");
    expect(rendered.text).toContain("Scope: Progress mapping");
    expect(rendered.text).toContain("Location: Broadway, Green Bay, Wisconsin");
    expect(rendered.text).toContain("Review in LTDS Operations: https://ops.example/operations/client-requests/request-north");
    const serialized = JSON.stringify(rendered);
    for (const excluded of ["flight", "accepted_pending_pa_linkage", "125000", "USD", "Q-0042", "site-contact@example.com", "billing@example.com"])
      expect(serialized).not.toContain(excluded);
  });

  it("renders new or one-off client lifecycle copy with a neutral coordinate fallback", () => {
    const lifecycles = [
      ["under_review", "Service request under review", "Under review"],
      ["accepted_pending_pa_linkage", "Service request approved for quote preparation", "Approved — Project Alpha draft pending"],
      ["accepted_linked", "Project Alpha draft quote created", "PA draft quote created"],
      ["declined", "Service request declined", "Declined"],
      ["cancelled", "Service request cancelled", "Cancelled"],
      ["completed", "Service request completed", "Completed"],
      ["estimate_ready", "Operational estimate ready", "Estimate ready"],
    ] as const;
    for (const [lifecycle, subject, status] of lifecycles) {
      const snapshot = buildServiceRequestNotificationSnapshot({
        title: "Riverside roof documentation",
        projectId: null,
        serviceCategory: null,
        latitude: 44.5132,
        longitude: -88.0831,
        lifecycle,
        action: "open_client_portal",
      });
      const rendered = renderClientRequestNotification(snapshot, "https://client.example/portal/requests");
      expect(rendered.subject).toBe(`${subject}: Riverside roof documentation`);
      expect(rendered.text).toContain("Context: New or one-off service");
      expect(rendered.text).toContain("Scope: General service");
      expect(rendered.text).toContain("Location: Near 44.5132, -88.0831");
      expect(rendered.text).toContain(`Status: ${status}`);
      expect(rendered.text).not.toContain("accepted_pending_pa_linkage");
    }
  });

  it("renders the staff response event and escapes all snapshot and action-link HTML", () => {
    const snapshot = buildServiceRequestNotificationSnapshot({
      title: "Roof <script>alert(1)</script>",
      projectId: null,
      serviceCategory: "Inspection & documentation",
      locationLabel: "Main < Annex",
      lifecycle: "client_response_received",
      action: "review_in_operations",
    });
    const rendered = renderClientRequestNotification(snapshot, "https://ops.example/review?id=1&next=2");
    expect(rendered.subject).toBe("Client response received: Roof <script>alert(1)</script>");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("Roof &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain("Inspection &amp; documentation");
    expect(rendered.html).toContain("id=1&amp;next=2");
  });

  it("renders a bounded client-safe staff work-area change summary", () => {
    const snapshot = buildServiceRequestNotificationSnapshot({
      title: "North site mapping",
      projectId: "project-a",
      projectName: "North Site",
      serviceCategory: "2D mapping",
      locationLabel: "North parcel",
      lifecycle: "work_area_changed",
      action: "open_client_portal",
      changeSummary: "Service-area boundary adjusted; 1 point added",
    });
    const rendered = renderClientRequestNotification(snapshot, "https://client.example/portal/requests");
    expect(rendered.subject).toBe("Service request work area updated: North site mapping");
    expect(rendered.text).toContain("Status: Work area updated");
    expect(rendered.text).toContain("Change: Service-area boundary adjusted; 1 point added");
    expect(rendered.html).toContain("<strong>Change:</strong>");
    expect(JSON.stringify(rendered)).not.toMatch(/longitude|latitude|geojson|staff-area/i);
  });
});
