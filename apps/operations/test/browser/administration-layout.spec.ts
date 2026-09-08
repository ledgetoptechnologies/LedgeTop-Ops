import { expect, test } from "@playwright/test";

const workflowReadiness = {
  ready: true,
  workflows: {
    nativeFeedback: { state: "ready", reasons: [] },
    serviceRequests: { state: "ready", reasons: [] },
    requestAttachments: { state: "ready", reasons: [] },
    delegatedSharing: { state: "ready", reasons: [] },
    expiryNotices: { state: "ready", reasons: [] },
  },
};

async function fixture(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "admin",
        email: "admin@example.test",
        displayName: "Admin",
        status: "Active",
        profileType: "Administrator",
        isAdministrator: true,
        permissions: ["administration.view", "integrations.manage", "audit.view"],
        divisions: [],
      },
      csrfToken: "csrf",
      timezone: "America/Chicago",
      mapStyleUrl: null,
      mapboxPublicToken: null,
      capabilities: {},
    } });
    if (path === "/api/admin/integrations/project-alpha/connectors") {
      return route.fulfill({ json: { connectors: [], health: [], legacyPrimary: false } });
    }
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: workflowReadiness });
    if (path === "/api/admin/project-alpha-access-token-expiry") {
      return route.fulfill({ json: {
        generatedAt: "2026-09-08T12:00:00.000Z",
        healthy: true,
        connectors: [
          { connector: "ltds", label: "LTDS", state: "healthy", expiresAt: "2035-09-08T12:00:00.000Z", daysRemaining: 3287 },
          { connector: "ltt", label: "LTT", state: "healthy", expiresAt: "2035-09-08T12:00:00.000Z", daysRemaining: 3287 },
        ],
      } });
    }
    if (path === "/api/admin/delivery-change-recovery") return route.fulfill({ json: {
      enabled: true,
      state: "ready",
      reason: null,
      counts: { pending: 0, processing: 0, completed: 0, failed: 0 },
      failures: [],
      oldestPendingAt: null,
      lastFailureAt: null,
    } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [], nextCursor: null, highWaterId: "0", filters: {} } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
}

test("Administration keeps control panels readable and contained across viewports", async ({ page }) => {
  await fixture(page);
  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await expect(page.locator(".administration-panels")).toBeVisible();
  await expect(page.locator(".administration-panel-wide")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Project Alpha connections", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security model", exact: true })).toBeVisible();

  for (const width of [320, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const panels = page.locator(".administration-panels");
    const box = await panels.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (width <= 760) {
      const panelBoxes = await page.locator(".administration-panel").evaluateAll(elements =>
        elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, width: rect.width }; }));
      expect(panelBoxes.length).toBeGreaterThan(0);
      expect(new Set(panelBoxes.map(item => item.x)).size).toBe(1);
      expect(new Set(panelBoxes.map(item => item.width)).size).toBe(1);
    } else {
      const compactBoxes = await page.locator(".administration-panel:not(.administration-panel-wide)").evaluateAll(elements =>
        elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; }));
      expect(compactBoxes).toHaveLength(2);
      expect(Math.abs(compactBoxes[0]!.y - compactBoxes[1]!.y)).toBeLessThanOrEqual(1);
      expect(compactBoxes[0]!.x + compactBoxes[0]!.width).toBeLessThanOrEqual(compactBoxes[1]!.x);
    }
  }
});
