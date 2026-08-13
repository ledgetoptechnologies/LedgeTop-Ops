import { describe, expect, it } from "vitest";
import {
  buildServiceRequestNotificationSnapshot,
  parseServiceRequestNotificationSnapshot,
} from "@ltds/shared";
import { normalizeRecipientEmail, notificationDedupeKey, renderClientRequestNotification, renderNotification } from "../src/worker/notifications";
import { buildSmtpMessage, smtpNotificationsEnabled } from "../src/worker/mailer";

describe("client notifications", () => {
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
      ["accepted_pending_pa_linkage", "Service request accepted", "Accepted — next steps being prepared"],
      ["accepted_linked", "Service request accepted", "Accepted"],
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
