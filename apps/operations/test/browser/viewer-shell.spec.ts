import { expect, test } from "@playwright/test";

test("Operations Viewer shell bootstraps CSRF and keeps the bearer grant out of its URL", async ({ page }) => {
  const grant = "11111111-1111-4111-8111-111111111111";
  let bootstrapRequests = 0;
  let sessionRequests = 0;
  let idempotencyKey = "";

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" && request.method() === "GET") {
      bootstrapRequests += 1;
      return route.fulfill({ json: { csrfToken: "csrf-viewer-shell" } });
    }
    if (path === "/api/viewer/associations/association-one/session" && request.method() === "POST") {
      sessionRequests += 1;
      expect(request.headers()["x-csrf-token"]).toBe("csrf-viewer-shell");
      idempotencyKey = request.headers()["idempotency-key"] || "";
      return route.fulfill({ status: 201, json: {
        grant,
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        sessionTtlSeconds: 1800,
        redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/sessions/redeem",
        embedUrl: `https://viewer.ledgetopdroneservices.com/session/${grant}`,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.context().route("https://viewer.ledgetopdroneservices.com/**", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer</title>" }));

  await page.goto("/viewer/session/association-one/model-one");

  await expect(page).toHaveURL(/\/viewer\/session\/association-one\/model-one$/);
  expect(page.url()).not.toContain(grant);
  expect(await page.evaluate(() => window.opener === null)).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute("src", `https://viewer.ledgetopdroneservices.com/session/${grant}`);
  expect(bootstrapRequests).toBe(1);
  expect(sessionRequests).toBe(1);
  expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});
