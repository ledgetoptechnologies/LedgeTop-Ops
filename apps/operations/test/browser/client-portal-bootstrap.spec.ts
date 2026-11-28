import { expect, test, type Page, type Route } from "@playwright/test";

async function fixture(page: Page, activation: (route: Route) => Promise<unknown>, administrator = true) {
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: administrator ? "Administrator" : "Employee", isAdministrator: administrator, permissions: ["team.view", "operations.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/client-service-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/api/client-hub") return route.fulfill({ json: {
      clients: [], nextCursor: null, capabilities: { directory: true, requests: true, delivery: false, viewer: false },
      sources: [{ source_id: "project-alpha:primary", display_name: "Project Alpha" }],
    } });
    if (url.pathname.startsWith("/api/admin/client-account-activation")) return activation(route);
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

for (const administrator of [true, false]) test(`the Clients page has no legacy portal coverage card (${administrator ? "administrator" : "reviewer"})`, async ({ page }) => {
  let requested = false;
  await fixture(page, route => { requested = true; return route.fulfill({ json: { workspaceMigrationApplied: true, accounts: [], sources: [] } }); }, administrator);
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Portal workspace coverage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review legacy exceptions" })).toHaveCount(0);
  await expect(page.locator("#client-portal-setup")).toHaveCount(0);
  expect(requested).toBe(false);
});
