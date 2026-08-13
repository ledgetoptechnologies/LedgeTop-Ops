import { expect, test, type Page } from "@playwright/test";

async function mockSession(page: Page, permissions: string[]) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "staff-a", email: "staff@example.com", displayName: "Staff User", status: "Active", profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
      return;
    }
    if (path === "/api/client-service-requests") {
      await route.fulfill({ json: { requests: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

const allNavigationPermissions = ["dashboard.view", "operations.view", "operations.manage", "sops.view", "airspace.view", "delivery.browse", "team.view", "administration.view"];

test("desktop navigation exposes canonical client requests and independently authorizes Manage items", async ({ page }) => {
  await mockSession(page, allNavigationPermissions);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primary.getByRole("link", { name: "Client Requests" })).toHaveAttribute("href", "/operations/client-requests");
  await primary.getByRole("link", { name: "Client Requests" }).click();
  await expect(page).toHaveURL(/\/operations\/client-requests$/);
  await expect(page.getByRole("heading", { name: "Client requests" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Client Requests" })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/operations\/client-requests$/);

  await primary.getByRole("button", { name: "Manage" }).click();
  await expect(primary.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Administration" })).toBeVisible();
});

test("Team remains visible without Administration permission", async ({ page }) => {
  await mockSession(page, ["dashboard.view", "team.view"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await primary.getByRole("button", { name: "Manage" }).click();
  await expect(primary.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Administration" })).toHaveCount(0);
});

for (const width of [320, 390, 768]) {
  test(`mobile navigation is bounded and keyboard-safe at ${width}px`, async ({ page }) => {
    await mockSession(page, allNavigationPermissions);
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "Open navigation" });
    await expect(trigger).toBeVisible();
    expect(await trigger.textContent()).not.toMatch(/[\u00c3\u00c2\u00e2]/);
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Dashboard" })).toBeFocused();
    await expect(drawer.getByRole("link", { name: "Client Requests" })).toHaveCSS("min-height", "44px");
    await drawer.getByRole("link", { name: "Administration" }).focus();
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(drawer.getByRole("link", { name: "Administration" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.mouse.click(4, 400);
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const headerBottom = await page.locator(".ops-header").evaluate((node) => node.getBoundingClientRect().bottom);
    const headingTop = await page.getByRole("heading", { name: "Operations dashboard" }).evaluate((node) => node.getBoundingClientRect().top);
    expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
  });
}
