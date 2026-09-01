import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const calls: string[] = [];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "reviewer", email: "reviewer@example.test", displayName: "Reviewer", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions: ["team.view", "operations.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { clientFeedback: { enabled: true } },
    } });
    if (path === "/api/client-service-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/api/client-hub") return route.fulfill({ json: { clients: [], capabilities: { directory: true, requests: true, delivery: true, viewer: true } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

for (const width of [390, 1280]) test(`legacy staff inbox redirects to Client Hub without duplicate queue probes at ${width}px`, async ({ page }) => {
  const calls = await fixture(page);
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/operations/inbox");
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole("heading", { name: "Client Hub", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Staff inbox" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Needs attention" })).toHaveCount(0);
  expect(calls.some(path => path === "/api/operations/inbox/requests" || path === "/api/operations/feedback" || path === "/api/notifications/deliveries")).toBe(false);
});
