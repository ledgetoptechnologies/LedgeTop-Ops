import { expect, test } from "@playwright/test";

test("a dashboard that cannot load says so and offers Try again, never All clear or zeros", async ({ page }) => {
  let dashboardCalls = 0;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active",
      profileType: "Employee", isAdministrator: false, permissions: ["dashboard.view"], divisions: [] }, csrfToken: "c", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/dashboard") {
      dashboardCalls += 1;
      return dashboardCalls === 1 ? route.fulfill({ status: 404, json: { error: "Not found" } })
        : route.fulfill({ json: { operations: [], tasks: [], integrations: [], airspace: {}, recentShares: [] } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  const alert = page.getByRole("alert").filter({ hasText: "The dashboard couldn't be loaded." });
  await expect(alert).toBeVisible();
  await expect(page.getByText("All clear.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "0 Open operations" })).toHaveCount(0);
  await expect(page.getByText("Not found", { exact: true })).toHaveCount(0);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: "0 Open operations" })).toBeVisible();
  await expect(alert).toHaveCount(0);
});
