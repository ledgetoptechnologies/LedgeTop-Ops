import { expect, test, type Page } from "@playwright/test";

async function mockDisabledViewer(page: Page, permissions: string[]) {
  let preflightRequests = 0;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-a", email: "staff@example.test", displayName: "Staff User", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions, divisions: [],
      },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/viewer") return route.fulfill({ json: {
      enabled: false, publicSharesEnabled: false, models: [], projects: [], associations: [],
    } });
    if (path === "/api/viewer/processing") return route.fulfill({ json: {
      enabled: false, viewerBaseUrl: null, permissions: [], units: { default: "imperial", resolved: "imperial" }, events: [],
    } });
    if (path === "/api/viewer/connection-preflight") {
      preflightRequests += 1;
      expect(request.method()).toBe("GET");
      return route.fulfill({ json: {
        integrationEnabled: false,
        configured: true,
        publicHealthReachable: true,
        publicHealthOk: true,
        publicReadyReachable: true,
        publicReady: false,
        readinessIssueCount: 1,
        serviceAuthReachable: true,
        modelCount: 4,
        readyModelCount: 3,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return () => preflightRequests;
}

test("viewer managers can test a disabled Viewer connection without enabling it", async ({ page }) => {
  const preflightRequests = await mockDisabledViewer(page, ["viewer.view", "viewer.manage"]);
  await page.goto("/operations/processing");

  await expect(page.getByRole("heading", { name: "3D Viewer", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "3D Viewer is disabled" })).toBeVisible();
  const testConnection = page.getByRole("button", { name: "Test Viewer connection" });
  await expect(testConnection).toBeVisible();
  await testConnection.click();

  const result = page.getByRole("status");
  await expect(result).toContainText("Configuration: ready");
  await expect(result).toContainText("Public health: healthy");
  await expect(result).toContainText("Public readiness: not ready (1 checks failed)");
  await expect(result).toContainText("Signed service authentication: connected");
  await expect(result).toContainText("Catalog: 3 ready of 4 models");
  expect(preflightRequests()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("viewer.view alone cannot see the connection preflight control", async ({ page }) => {
  const preflightRequests = await mockDisabledViewer(page, ["viewer.view"]);
  await page.goto("/operations/processing");
  await expect(page.getByRole("heading", { name: "3D Viewer is disabled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test Viewer connection" })).toHaveCount(0);
  expect(preflightRequests()).toBe(0);
});
