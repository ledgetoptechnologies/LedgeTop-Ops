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

async function fixture(page: import("@playwright/test").Page, recovery = false) {
  const requestedPaths: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    requestedPaths.push(path);
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "admin",
        email: "admin@example.test",
        displayName: "Admin",
        status: "Active",
        profileType: "Administrator",
        isAdministrator: true,
        permissions: ["administration.view", "integrations.manage", "audit.view", "operations.manage"],
        divisions: [],
      },
      csrfToken: "csrf",
      timezone: "America/Chicago",
      mapStyleUrl: null,
      mapboxPublicToken: null,
      capabilities: recovery ? { clientWorkspaceManagerRecovery: { enabled: true } } : {},
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
    if (path === "/api/admin/client-workspaces/recovery") return route.fulfill({ json: { workspaces: [{
      id: "workspace-layout", displayName: "A customer workspace with a deliberately long but readable organization name",
      members: [
        { identityId: "outgoing-layout", email: "outgoing@example.test", status: "active", source: "local", manager: true },
        { identityId: "replacement-layout", email: "replacement@example.test", status: "active", source: "local", manager: false },
      ],
    }] } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return requestedPaths;
}

test("Administration keeps control panels readable and contained across viewports", async ({ page }) => {
  const requests = await fixture(page);
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
      const panelBoxes = await page.locator(".administration-panels > .administration-panel").evaluateAll(elements =>
        elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, width: rect.width }; }));
      expect(panelBoxes.length).toBeGreaterThan(0);
      expect(new Set(panelBoxes.map(item => item.x)).size).toBe(1);
      expect(new Set(panelBoxes.map(item => item.width)).size).toBe(1);
    } else {
      const compactBoxes = await page.locator(".administration-panels > .administration-panel:not(.administration-panel-wide)").evaluateAll(elements =>
        elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; }));
      expect(compactBoxes).toHaveLength(2);
      expect(Math.abs(compactBoxes[0]!.y - compactBoxes[1]!.y)).toBeLessThanOrEqual(1);
      expect(compactBoxes[0]!.x + compactBoxes[0]!.width).toBeLessThanOrEqual(compactBoxes[1]!.x);
    }
  }
  expect(requests).not.toContain("/api/admin/client-workspaces/recovery");
});

test("Administration spaces and contains enabled recovery and audit panels", async ({ page }) => {
  const requests = await fixture(page, true);
  await page.goto("/administration");
  const secondary = page.locator(".administration-secondary-panels");
  await expect(secondary.getByRole("heading", { name: "Client workspace manager recovery" })).toBeVisible();
  await expect(secondary.getByRole("heading", { name: "Audit history", exact: true })).toBeVisible();
  await expect(secondary.locator(":scope > .administration-panel")).toHaveCount(2);
  const action = secondary.getByRole("button", { name: "Transfer manager authority", exact: true });
  await expect(action).toBeEnabled();
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll(".administration-secondary-panels *")]
      .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth)
      .map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const main = await page.locator(".administration-panels").boundingBox();
    const boxes = await secondary.locator(":scope > .administration-panel").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    expect(main).not.toBeNull();
    expect(boxes[0]!.top - (main!.y + main!.height)).toBeGreaterThanOrEqual(15);
    expect(boxes[1]!.top - boxes[0]!.bottom).toBeGreaterThanOrEqual(15);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    const actionBox = await action.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.height).toBeGreaterThanOrEqual(44);
    expect(actionBox!.x).toBeGreaterThanOrEqual(boxes[0]!.x);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(boxes[0]!.right);
  }
  expect(requests).toContain("/api/admin/client-workspaces/recovery");
  expect(requests).not.toContain("/api/admin/client-delegated-shares");
});
