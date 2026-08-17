import { expect, test, type Page } from "@playwright/test";

async function mockSession(page: Page, permissions: string[], identity?: { displayName: string; email: string }) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "staff-a", email: identity?.email ?? "staff@example.com", displayName: identity?.displayName ?? "Staff User", status: "Active", profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
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

const allNavigationPermissions = ["dashboard.view", "operations.view", "operations.manage", "sops.view", "airspace.view", "delivery.browse", "viewer.view", "team.view", "administration.view"];

test("desktop navigation exposes canonical client requests and independently authorizes Administration items", async ({ page }) => {
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

  await primary.getByRole("button", { name: "Administration" }).click();
  const viewerLink = primary.getByRole("link", { name: "3D Viewer" });
  await expect(viewerLink).toBeVisible();
  await expect(viewerLink).toHaveAttribute("href", "/operations/processing");
  await expect(primary.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Administration" })).toBeVisible();
  const menuLayout = await page.locator(".ops-header").evaluate((header) => {
    const navigation = header.querySelector<HTMLElement>(".ops-desktop-nav");
    const popover = header.querySelector<HTMLElement>(".ops-manage-popover");
    if (!navigation || !popover) throw new Error("desktop Administration menu is missing");
    const headerBox = header.getBoundingClientRect();
    const popoverBox = popover.getBoundingClientRect();
    return {
      navigationScrollWidth: navigation.scrollWidth,
      navigationClientWidth: navigation.clientWidth,
      navigationOverflowX: getComputedStyle(navigation).overflowX,
      navigationOverflowY: getComputedStyle(navigation).overflowY,
      headerBottom: headerBox.bottom,
      popoverTop: popoverBox.top,
      popoverRight: popoverBox.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(menuLayout.navigationScrollWidth).toBeLessThanOrEqual(menuLayout.navigationClientWidth + 1);
  expect(menuLayout.navigationOverflowX).toBe("visible");
  expect(menuLayout.navigationOverflowY).toBe("visible");
  expect(menuLayout.popoverTop).toBeGreaterThanOrEqual(menuLayout.headerBottom - 1);
  expect(menuLayout.popoverRight).toBeLessThanOrEqual(menuLayout.viewportWidth);

  await viewerLink.click();
  await expect(page).toHaveURL(/\/operations\/processing$/);
  await expect(page.getByRole("heading", { name: "3D Viewer" })).toBeVisible();
  await primary.getByRole("button", { name: "Administration" }).click();
  await expect(primary.getByRole("link", { name: "3D Viewer" })).toHaveAttribute("aria-current", "page");
});

test("Team remains visible without Administration permission", async ({ page }) => {
  await mockSession(page, ["dashboard.view", "team.view"]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await primary.getByRole("button", { name: "Administration" }).click();
  await expect(primary.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "3D Viewer" })).toHaveCount(0);
  await expect(primary.getByRole("link", { name: "Administration" })).toHaveCount(0);
});

test("administration.view opens the read-only Administration page without privileged API probes", async ({ page }) => {
  let privilegedProbe = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-administration-viewer",
          email: "viewer@example.test",
          displayName: "Administration Viewer",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["administration.view"],
          divisions: [],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: {
          delegatedShareProvisioning: { enabled: true },
          clientWorkspaceManagerRecovery: { enabled: true },
        },
      } });
      return;
    }
    if (path.startsWith("/api/admin/")) privilegedProbe = true;
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/administration");
  await expect(page).toHaveURL(/\/administration$/);
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Alpha" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Audit history" })).toHaveCount(0);
  expect(privilegedProbe).toBe(false);
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
    await expect(drawer.locator(".ops-mobile-nav-label")).toHaveText("Administration");
    await expect(drawer.getByRole("link", { name: "Dashboard" })).toBeFocused();
    await expect(drawer.getByRole("link", { name: "Client Requests" })).toHaveCSS("min-height", "44px");
    await expect(drawer.getByRole("link", { name: "3D Viewer" })).toHaveAttribute("href", "/operations/processing");
    await expect(drawer.getByRole("link", { name: "3D Viewer" })).toHaveCSS("min-height", "44px");
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

test("operations shell contains very long identity text and reflows at a 200% zoom equivalent", async ({ page }) => {
  const displayName = `Staff${"N".repeat(180)}`;
  const email = `${"e".repeat(180)}@example.test`;
  await mockSession(page, allNavigationPermissions, { displayName, email });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const profile = page.locator(".profile");
  await expect(profile).toContainText(displayName);
  await expect(profile).toContainText(email);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // A 640 CSS-pixel viewport is the reflow equivalent of 200% browser zoom
  // on the 1280-pixel desktop canvas above.
  await page.setViewportSize({ width: 640, height: 800 });
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await expect(trigger).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const headerBottom = await page.locator(".ops-header").evaluate(node => node.getBoundingClientRect().bottom);
  const headingTop = await page.getByRole("heading", { name: "Operations dashboard" }).evaluate(node => node.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
});

test("account identity menu provides keyboard-safe same-origin Access logout on desktop and mobile", async ({ page }) => {
  await mockSession(page, allNavigationPermissions);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Account menu for Staff User" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  let menu = page.getByRole("menu", { name: "Account" });
  const logout = menu.getByRole("menuitem", { name: "Logout" });
  await expect(logout).toBeFocused();
  await expect(logout).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Dashboard" }).focus();
  await expect(page.getByRole("menu", { name: "Account" })).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveCSS("min-height", "44px");
  await trigger.click();
  menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Logout" })).toHaveCSS("min-height", "44px");
  const bounds = await menu.evaluate(node => ({ right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
