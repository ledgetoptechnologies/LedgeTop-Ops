import { expect, test } from "@playwright/test";

test("administration no longer exposes the legacy Project Alpha activation bridge", async ({ page }) => {
  let activationRequested = false;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-admin", email: "admin@example.test", displayName: "Admin",
        status: "Active", profileType: "Administrator", isAdministrator: true,
        permissions: ["administration.view", "operations.manage"], divisions: [],
      },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: {},
    } });
    if (path === "/api/admin/client-account-activation" && request.method() === "GET") {
      activationRequested = true;
      return route.fulfill({ status: 500, json: { error: "Legacy activation must not load" } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Client account Project Alpha activation" })).toHaveCount(0);
  expect(activationRequested).toBe(false);
});
