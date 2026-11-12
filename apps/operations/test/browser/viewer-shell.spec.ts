import { expect, test } from "@playwright/test";

const VIEWER = "https://viewer.ledgetopdroneservices.com";

test("linked Operations model stays embedded, renews in place, and keeps its grant out of the Ops URL", async ({ page }) => {
  const grants = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ] as const;
  const sessionPaths: string[] = [];
  const idempotencyKeys: string[] = [];

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" && request.method() === "GET") {
      return route.fulfill({ json: {
        user: {
          id: "staff-viewer", email: "staff@example.test", displayName: "Viewer staff",
          status: "Active", profileType: "Employee", isAdministrator: false,
          permissions: ["viewer.view", "operations.view"], divisions: [],
        },
        csrfToken: "csrf-viewer-shell", timezone: "America/Chicago",
        mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
    }
    if (path === "/api/viewer/associations/association-one/session" && request.method() === "POST") {
      sessionPaths.push(path);
      expect(request.headers()["x-csrf-token"]).toBe("csrf-viewer-shell");
      idempotencyKeys.push(request.headers()["idempotency-key"] || "");
      const grant = grants[sessionPaths.length - 1]!;
      return route.fulfill({ status: 201, json: {
        modelId: "model-one", grant,
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        sessionTtlSeconds: 1800,
        redeemUrl: `${VIEWER}/api/v1/sessions/redeem`,
        embedUrl: `${VIEWER}/session/${grant}`,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.context().route(`${VIEWER}/**`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Viewer fixture</title><main>Embedded Viewer model</main><script>
      const expiry = new Date(Date.now() + 60_000).toISOString();
      addEventListener("load", () => {
        parent.postMessage({version:1,type:"ltds-viewer:ready",modelId:"model-one",expiresAt:expiry}, "*");
        setTimeout(() => parent.postMessage({version:1,type:"ltds-viewer:session-expiring",modelId:"model-one",expiresAt:expiry}, "*"), 100);
      });
      addEventListener("message", event => {
        if (event.data?.type === "ltds-viewer:renew-session") {
          document.body.dataset.renewedGrant = event.data.grant;
          parent.postMessage({version:1,type:"ltds-viewer:session-renewed",modelId:"model-one",expiresAt:new Date(Date.now()+60_000).toISOString()}, "*");
        }
      });
    </script>`,
  }));

  await page.goto("/viewer/session/association-one/model-one");
  await expect(page.locator(".ops-header")).toBeVisible();
  await expect(page.getByRole("region", { name: "3D model: Operations 3D model" })).toBeVisible();
  const iframe = page.locator("iframe");
  await expect(iframe).toHaveAttribute("src", `${VIEWER}/session/${grants[0]}`);
  await expect(iframe).toHaveAttribute("title", "3D model: Operations 3D model");
  expect(page.url()).toMatch(/\/viewer\/session\/association-one\/model-one$/);
  expect(page.url()).not.toContain(grants[0]);
  expect(await page.evaluate(() => window.opener === null)).toBe(true);
  await expect.poll(() => sessionPaths.length).toBe(2);
  expect(sessionPaths).toEqual([
    "/api/viewer/associations/association-one/session",
    "/api/viewer/associations/association-one/session",
  ]);
  expect(idempotencyKeys.every(key => /^[0-9a-f-]{36}$/.test(key))).toBe(true);
  expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);
  await expect(iframe).toHaveAttribute("src", `${VIEWER}/session/${grants[0]}`); // Renewal keeps the mounted model.
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute("data-renewed-grant", grants[1]);

  const nav = page.getByRole("navigation", { name: /^(Primary navigation|Mobile primary navigation)$/ });
  if (!(await nav.first().isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
  await nav.locator('a[href="/operations"]:visible').click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("region", { name: "3D model: Operations 3D model" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute("src", `${VIEWER}/session/${grants[2]}`);
  await page.goto("/operations");
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("a mismatched session model is rejected before any Viewer iframe is mounted", async ({ page }) => {
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-viewer", email: "staff@example.test", displayName: "Viewer staff", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions: ["viewer.view"], divisions: [] },
      csrfToken: "csrf-viewer-shell", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/viewer/associations/association-mismatch/session") return route.fulfill({ status: 201, json: {
      modelId: "different-model", grant: "11111111-1111-4111-8111-111111111111",
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: `${VIEWER}/api/v1/sessions/redeem`, embedUrl: `${VIEWER}/session/11111111-1111-4111-8111-111111111111`,
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/viewer/session/association-mismatch/model-four");
  await expect(page.getByRole("alert")).toHaveText("Viewer session does not match the requested model");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(page.url()).toMatch(/\/viewer\/session\/association-mismatch\/model-four$/);
  expect(page.url()).not.toContain("11111111-1111-4111-8111-111111111111");
});
