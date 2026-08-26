import { describe, expect, it } from "vitest";
import { inboxDate, inboxEndpoint, inboxSources, parseInboxPage } from "../src/client/staff-inbox";

const createdAt = "2026-08-25 12:00:00";
describe("staff inbox presentation contract", () => {
  it("only offers independent authorized sources, not inferred service or role access", () => {
    expect(inboxSources({ permissions: [], isAdministrator: true, feedbackEnabled: false })).toEqual([]);
    expect(inboxSources({ permissions: ["operations.manage"], isAdministrator: false, feedbackEnabled: false })).toEqual(["requests"]);
    expect(inboxSources({ permissions: ["delivery.share.audit"], isAdministrator: false, feedbackEnabled: true })).toEqual(["feedback", "deliveries"]);
    expect(inboxSources({ permissions: ["integrations.manage", "administration.view"], isAdministrator: false, feedbackEnabled: false })).toEqual([]);
    expect(inboxSources({ permissions: ["integrations.manage"], isAdministrator: true, feedbackEnabled: false })).toEqual([]);
    expect(inboxSources({ permissions: ["integrations.manage", "administration.view"], isAdministrator: true, feedbackEnabled: false })).toEqual(["connections"]);
  });
  it("encodes literal queries and cursors without interpolating route syntax", () => {
    const url = new URL(inboxEndpoint("feedback", "Acme & Sons/#", "next?cursor=yes"), "https://ops.test");
    expect(url.pathname).toBe("/api/operations/feedback");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "open", q: "Acme & Sons/#", cursor: "next?cursor=yes" });
    expect(inboxEndpoint("connections", "secret search", "ignored")).toBe("/api/admin/integrations/project-alpha/connectors");
  });
  it("keeps stable request identity, status and current detail destination, excluding unrelated payload fields", () => {
    const page = parseInboxPage("requests", { items: [{ id: "request-a", title: "Site visit", accountName: "Acme", projectName: "Plant", status: "accepted_pending_pa_linkage", createdAt, quote_total_minor: 80000 }], nextCursor: "page-two" }, "");
    expect(page).toEqual({ items: [{ id: "request-a", title: "Site visit", detail: "Acme · Plant", status: "Awaiting Alpha linkage", date: createdAt, href: "/clients/requests/request-a", action: "Review request" }], nextCursor: "page-two" });
  });
  it("preserves safe feedback deep links and a bounded comment preview", () => {
    const page = parseInboxPage("feedback", { items: [{ id: "feedback-a", accountName: "Acme", message: "x".repeat(1000), status: "in_progress", createdAt, target: { label: "Roof", projectName: null } }], nextCursor: null }, "");
    expect(page.items[0]?.href).toBe("/operations/feedback/feedback-a?status=all");
    expect(page.items[0]?.detail).toBe(`Acme — ${"x".repeat(240)}…`);
  });
  it("opens the authorized notices workflow and never embeds a recipient or invokes a mutation", () => {
    const page = parseInboxPage("deliveries", { coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true }, items: [{ kind: "folder_changes", id: "batch-a", accountName: "Acme & Sons", folderLabel: "Edited", status: "pending", createdAt, addedCount: 1234, removedCount: 2, recipientEmail: "private@example.test" }], nextCursor: null }, "");
    expect(page.items[0]?.detail).toBe("Acme & Sons · 1,234 added · 2 removed");
    expect(page.items[0]?.href).toBe("/operations/notifications?batchId=batch-a");
    expect(JSON.stringify(page)).not.toContain("private@");
  });
  it("keeps native and folder identities separate and opens exact native notices without recipient leakage or fabricated counts", () => {
    const rows = [
      { kind: "folder_changes", id: "same-id", accountName: "Acme", folderLabel: "Edited", status: "pending", createdAt, addedCount: 2, removedCount: 0 },
      { kind: "portal_delivery", id: "same-id", sourceName: "Survey source", workspaceName: "Acme workspace", eventLabel: "Delivery ready", deliveryMode: "staged", folderLabel: "Edited", status: "pending", createdAt, recipientEmail: "private@example.test" },
    ];
    const page = parseInboxPage("deliveries", { coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true }, items: rows, nextCursor: null }, "");
    expect(page.items.map(row => row.id)).toEqual(["folder_changes:same-id", "portal_delivery:same-id"]);
    expect(page.items[1]?.detail).toBe("Acme workspace · Survey source · Delivery ready");
    expect(page.items[1]?.href).toBe("/operations/notifications?kind=portal_delivery&batchId=same-id");
    expect(JSON.stringify(page)).not.toContain("private@");
    expect(new URL(inboxEndpoint("deliveries", "Acme", null), "https://ops.test").searchParams.get("format")).toBe("combined");
  });
  it("keeps native upgrade-required coverage explicit and rejects native rows when their source is unavailable", () => {
    const page = { coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: false }, items: [], nextCursor: null };
    expect(parseInboxPage("deliveries", page, "").notice).toContain("database upgrade");
    expect(() => parseInboxPage("deliveries", { ...page, items: [{ kind: "portal_delivery", id: "nb_one", sourceName: "Source", workspaceName: "Workspace", eventLabel: "Ready", deliveryMode: "staged", folderLabel: "Folder", status: "pending", createdAt }] }, "")).toThrow();
    expect(() => parseInboxPage("deliveries", { ...page, coverage: "legacy_folder_changes" }, "")).toThrow();
  });
  it("reports only explicit failures from active registered or legacy-primary connections", () => {
    const value = { legacyPrimary: true, connectors: [
      { sourceId: "active", displayName: "Technologies", state: "active" },
      { sourceId: "suspended", displayName: "Paused", state: "suspended" },
      { sourceId: "healthy", displayName: "Healthy", state: "active" },
      { sourceId: "stale", displayName: "Stale", state: "active" },
    ], health: ["project-alpha:primary", "active", "suspended", "hidden"].map(sourceId => ({ sourceId, status: "error", lastAttemptAt: createdAt })).concat([{ sourceId: "healthy", status: "healthy", lastAttemptAt: createdAt }, { sourceId: "stale", status: "stale", lastAttemptAt: createdAt }]) };
    expect(parseInboxPage("connections", value, "").items.map(item => item.id)).toEqual(["project-alpha:primary", "active"]);
    expect(parseInboxPage("connections", value, "TECHNOLOGIES").items.map(item => item.id)).toEqual(["active"]);
    expect(parseInboxPage("connections", { ...value, legacyPrimary: false }, "").items.map(item => item.id)).toEqual(["active"]);
  });
  it("rejects malformed pages, impossible states, unsafe ids, oversized responses and invalid dates", () => {
    const row = { id: "request-a", title: "Visit", accountName: "Acme", projectName: null, status: "submitted", createdAt };
    for (const bad of [{ ...row, id: "../attack" }, { ...row, status: "done" }, { ...row, createdAt: "yesterday" }]) {
      expect(() => parseInboxPage("requests", { items: [bad], nextCursor: null }, "")).toThrow();
    }
    expect(() => parseInboxPage("requests", { items: Array(26).fill(row), nextCursor: null }, "")).toThrow();
    expect(() => parseInboxPage("requests", { items: [], nextCursor: "" }, "")).toThrow();
    expect(() => parseInboxPage("deliveries", { items: [], nextCursor: null, coverage: "all" }, "")).toThrow();
  });
  it("treats SQLite timestamps as UTC while preserving an explicit offset", () => {
    expect(inboxDate(createdAt)).toBe("2026-08-25T12:00:00Z");
    expect(inboxDate("2026-08-25T12:00:00-05:00")).toBe("2026-08-25T12:00:00-05:00");
  });
});
