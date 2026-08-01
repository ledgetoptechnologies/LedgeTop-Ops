import { describe, expect, it } from "vitest";
import { normalizeRecipientEmail, notificationDedupeKey, renderNotification } from "../src/worker/notifications";
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
    const message = buildSmtpMessage({ to: "client@example.com", fromName: "LTDS", subject: "Hello\r\nBcc: attacker@example.com", text: "Plain text", html: "<p>HTML</p>" }, "no-reply@example.com");
    expect(message).toContain("Subject: Hello Bcc: attacker@example.com");
    expect(message).not.toContain("\r\nBcc:");
    expect(message).toContain("Content-Transfer-Encoding: base64");
  });
});
