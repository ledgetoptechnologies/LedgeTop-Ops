import { describe, expect, it } from "vitest";
import { normalizeRecipientEmail, notificationDedupeKey, renderNotification } from "../src/worker/notifications";

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
});
