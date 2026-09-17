import { describe, expect, it } from "vitest";
import { buildConnectionSummaries, PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS, projectAlphaHealthIsStale, projectAlphaQuoteFreshness } from "../src/worker/integration-health";

const now = Date.parse("2026-07-23T12:00:00Z");

describe("Project Alpha integration health", () => {
  it("stays fresh between successful daily snapshots", () => {
    expect(projectAlphaHealthIsStale({ integration: "project-alpha", status: "healthy", last_success_at: "2026-07-22 12:01:00" }, now)).toBe(false);
  });

  it("becomes stale after the daily snapshot recovery window", () => {
    expect(projectAlphaHealthIsStale({ integration: "project-alpha", status: "healthy", last_success_at: "2026-07-22 09:59:00" }, now)).toBe(true);
    expect(PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS).toBe(26 * 60 * 60 * 1000);
  });

  it("reports failed or missing Project Alpha synchronization", () => {
    expect(projectAlphaHealthIsStale({ integration: "project-alpha", status: "error", last_success_at: "2026-07-23 11:59:00" }, now)).toBe(true);
    expect(projectAlphaHealthIsStale({ integration: "project-alpha", status: "healthy", last_success_at: null }, now)).toBe(true);
  });

  it("does not apply Project Alpha freshness rules to other integrations", () => {
    expect(projectAlphaHealthIsStale({ integration: "other", status: "error", last_success_at: null }, now)).toBe(false);
  });

  it("summarizes every configured provider without exposing configuration values", () => {
    const connections = buildConnectionSummaries({
      integrations: [{ integration: "project-alpha", status: "healthy", last_success_at: "2026-07-23 11:59:00", stale: false }],
      projectAlphaConfigured: true,
      viewerConfigured: true,
      deliveryConfigured: true,
    });
    expect(connections.map(connection => connection.id)).toEqual(["project-alpha", "viewer", "delivery"]);
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "project-alpha", status: "healthy", lastSuccessAt: "2026-07-23 11:59:00" }),
      expect.objectContaining({ id: "viewer", label: "3D Viewer", status: "configured", href: "/viewer" }),
      expect.objectContaining({ id: "delivery", status: "configured", href: "/delivery" }),
    ]));
    expect(JSON.stringify(connections)).not.toMatch(/secret|api.?key|bucket/i);
  });

  it("marks financial summaries as last verified when their exact PA source is unavailable or unmonitored", () => {
    const unavailable = projectAlphaQuoteFreshness({
      sourceId: "project-alpha:secondary", quoteVerifiedAt: "2026-07-23T10:00:00Z",
      incidentStateJson: JSON.stringify({ category: "unavailable", lastProbeStartedAt: now }), activeIdentityMatched: true,
    });
    expect(unavailable).toEqual({ sourceId: "project-alpha:secondary", availability: "unavailable",
      lastVerifiedAt: "2026-07-23T10:00:00Z", lastCheckedAt: "2026-07-23T12:00:00.000Z" });
    expect(projectAlphaQuoteFreshness({ sourceId: "project-alpha:primary", quoteVerifiedAt: "invalid", incidentStateJson: undefined, activeIdentityMatched: false }))
      .toEqual({ sourceId: "project-alpha:primary", availability: "unknown", lastVerifiedAt: null, lastCheckedAt: null });
    expect(projectAlphaQuoteFreshness({ sourceId: "project-alpha:primary", quoteVerifiedAt: null,
      incidentStateJson: JSON.stringify({ category: "disabled", lastProbeStartedAt: now }), activeIdentityMatched: true }).availability).toBe("monitor_disabled");
    expect(projectAlphaQuoteFreshness({ sourceId: "project-alpha:primary", quoteVerifiedAt: "2026-07-23T10:00:00Z",
      incidentStateJson: JSON.stringify({ category: "verified", lastProbeStartedAt: now }), activeIdentityMatched: false }).availability).toBe("unknown");
  });
});
