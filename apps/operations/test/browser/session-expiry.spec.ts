import { expect, test } from "@playwright/test";

test("account menu shows a live server-timed session above Logout and refreshes on reopen", async ({ page }) => {
  let statusRequests = 0;
  let failed = false;
  let serverError = false;
  let seconds = 4;
  await page.clock.install();
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions: ["dashboard.view"], divisions: [] },
      csrfToken: "test", timezone: "America/Chicago", capabilities: {},
    } });
    if (path === "/api/session/status") {
      statusRequests++;
      if (failed) return route.fulfill({ status: 401, json: { error: "Expired" } });
      if (serverError) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      // Deliberately different from the browser clock: elapsed time comes from the server.
      const now = Date.parse("2030-01-01T12:00:00Z");
      return route.fulfill({ json: { userId: "staff-a", serverTime: new Date(now).toISOString(),
        expiresAt: new Date(now + seconds * 1000).toISOString() } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Account menu for Staff User" });
  await expect(trigger).toBeVisible();
  expect(statusRequests).toBe(0);
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("timer")).toHaveText(/0m [34]s/);
  await expect(menu.getByRole("menuitem", { name: "Get the app" })).toBeFocused();
  const order = await menu.evaluate(node => {
    const status = node.querySelector(".account-session-status")!;
    const logout = node.querySelector('a[role="menuitem"][href="/cdn-cgi/access/logout"]')!;
    return Boolean(status.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  await page.clock.fastForward(2500);
  await expect(menu.getByRole("timer")).toHaveText(/0m [12]s/);
  await page.clock.fastForward(2000);
  await expect(menu.getByText("Session expired", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  seconds = 3600;
  await trigger.click();
  await expect(menu.getByRole("timer")).toHaveText(/(?:1h 0m 0s|59m 59s)/);
  expect(statusRequests).toBe(2);
  seconds = 7200;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(menu.getByRole("timer")).toHaveText(/(?:2h 0m 0s|1h 59m 59s)/);
  serverError = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(menu.getByText("Session time unavailable", { exact: true })).toBeVisible();
  await expect(menu.getByRole("timer")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const closedRequests = statusRequests;
  await page.clock.fastForward(61000);
  expect(statusRequests).toBe(closedRequests);
  failed = true;
  await trigger.click();
  await expect(menu.getByText("Session expired", { exact: true })).toBeVisible();
  await expect(menu.getByRole("timer")).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Logout" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
});

test("missing timing is shown as unavailable, with no made-up countdown", async ({ page }) => {
  await page.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions: ["dashboard.view"], divisions: [] },
      csrfToken: "test", timezone: "America/Chicago", capabilities: {},
    } });
    if (new URL(route.request().url()).pathname === "/api/session/status")
      return route.fulfill({ json: { userId: "staff-a", serverTime: new Date().toISOString(), expiresAt: null } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu for Staff User" }).click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByText("Session time unavailable", { exact: true })).toBeVisible();
  await expect(menu.getByRole("timer")).toHaveCount(0);
});
