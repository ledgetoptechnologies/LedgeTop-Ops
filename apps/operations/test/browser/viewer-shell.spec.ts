import { expect, test } from "@playwright/test";

test("Operations Viewer shell owns route issuance and rejects missing or mismatched model identity", async ({ page }) => {
  const grants = [
    "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
  ];
  let bootstrapRequests = 0;
  const sessionPaths: string[] = [];
  const idempotencyKeys: string[] = [];

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" && request.method() === "GET") {
      bootstrapRequests += 1;
      return route.fulfill({ json: { csrfToken: "csrf-viewer-shell" } });
    }
    if (/^\/api\/viewer\/associations\/association-(?:one|two|missing|mismatch)\/session$/.test(path) && request.method() === "POST") {
      sessionPaths.push(path);
      expect(request.headers()["x-csrf-token"]).toBe("csrf-viewer-shell");
      idempotencyKeys.push(request.headers()["idempotency-key"] || "");
      const grant = grants[sessionPaths.length - 1];
      const modelId = path.includes("association-one") ? "model-one"
        : path.includes("association-two") ? "model-two"
          : path.includes("association-mismatch") ? "different-model" : undefined;
      return route.fulfill({ status: 201, json: {
        ...(modelId ? { modelId } : {}),
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
  expect(page.url()).not.toContain(grants[0]);
  expect(await page.evaluate(() => window.opener === null)).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute("src", `https://viewer.ledgetopdroneservices.com/session/${grants[0]}`);
  await page.waitForTimeout(250);
  expect(bootstrapRequests).toBe(1);
  expect(sessionPaths).toEqual(["/api/viewer/associations/association-one/session"]);
  expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto("/viewer/session/association-two/model-two");
  await expect(page.locator("iframe")).toHaveAttribute("src", `https://viewer.ledgetopdroneservices.com/session/${grants[1]}`);
  expect(bootstrapRequests).toBe(2);
  expect(sessionPaths).toEqual([
    "/api/viewer/associations/association-one/session",
    "/api/viewer/associations/association-two/session",
  ]);
  expect(idempotencyKeys[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);

  for (const path of ["/viewer/session/association-missing/model-three", "/viewer/session/association-mismatch/model-four"]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toHaveText("Viewer session does not match the requested model");
    await expect(page.locator("iframe")).toHaveCount(0);
  }
});
