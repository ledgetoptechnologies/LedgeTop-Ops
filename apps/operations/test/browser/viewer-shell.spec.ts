import { expect, test } from "@playwright/test";

test("Operations opens the authorized model in the full Viewer and keeps the grant out of its URL", async ({ page }) => {
  const grants = [
    "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  let bootstrapRequests = 0;
  const sessionPaths: string[] = [];
  const idempotencyKeys: string[] = [];
  const nativeBodies: unknown[] = [];
  const grantModels = new Map<string, string>();

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" && request.method() === "GET") {
      bootstrapRequests += 1;
      return route.fulfill({ json: {
        user: {
          id: "staff-viewer", email: "staff@example.test", displayName: "Viewer staff",
          status: "Active", profileType: "Employee", isAdministrator: false,
          permissions: ["viewer.view"], divisions: [],
        },
        csrfToken: "csrf-viewer-shell", timezone: "America/Chicago",
        mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
    }
    if (/^\/api\/viewer\/(?:native-)?associations\/(?:association-one|association-two|association-missing|association-mismatch)\/session$/.test(path) && request.method() === "POST") {
      sessionPaths.push(path);
      expect(request.headers()["x-csrf-token"]).toBe("csrf-viewer-shell");
      idempotencyKeys.push(request.headers()["idempotency-key"] || "");
      if (path.includes("native-associations")) nativeBodies.push(request.postDataJSON());
      const grant = grants[sessionPaths.length - 1]!;
      const modelId = path.includes("association-one") ? "model-one"
        : path.includes("association-two") ? "model-two"
          : path.includes("association-mismatch") ? "different-model" : undefined;
      if (modelId) grantModels.set(grant, modelId);
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
  await page.context().route("https://viewer.ledgetopdroneservices.com/**", route => {
    const grant = new URL(route.request().url()).pathname.split("/").pop() || "";
    const modelId = grantModels.get(grant) || "unknown-model";
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Viewer</title><main>Full Viewer model</main><script>
        if (${JSON.stringify(modelId)} === "model-one") {
          const expiry = new Date(Date.now() + 60_000).toISOString();
          setTimeout(() => {
            window.opener.postMessage({version:1,type:"ltds-viewer:ready",modelId:${JSON.stringify(modelId)},expiresAt:expiry}, "*");
            setTimeout(() => window.opener.postMessage({version:1,type:"ltds-viewer:session-expiring",modelId:${JSON.stringify(modelId)},expiresAt:expiry}, "*"), 100);
          }, 50);
          window.addEventListener("message", event => {
            if (event.data?.type === "ltds-viewer:renew-session") {
              window.opener.postMessage({version:1,type:"ltds-viewer:session-renewed",modelId:${JSON.stringify(modelId)},expiresAt:new Date(Date.now()+60_000).toISOString()}, "*");
            }
          });
        }
      </script>`,
    });
  });

  await page.goto("/viewer/session/association-one/model-one");
  await expect(page.getByRole("button", { name: "Open full Viewer" })).toBeVisible();
  expect(sessionPaths).toEqual([]); // Do not mint a one-time grant until an intentional launch.
  await expect(page.locator("iframe")).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open full Viewer" }).click();
  const viewer = await popupPromise;
  await expect(viewer).toHaveURL(/^https:\/\/viewer\.ledgetopdroneservices\.com\/session\/[0-9a-f-]+$/);
  await expect(viewer.getByText("Full Viewer model")).toBeVisible();
  await expect(page).toHaveURL(/\/viewer\/session\/association-one\/model-one$/);
  expect(page.url()).not.toContain(grants[0]);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(bootstrapRequests).toBe(2); // Application auth and the launch-time CSRF bootstrap.
  expect(sessionPaths).toEqual(["/api/viewer/associations/association-one/session"]);
  expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => sessionPaths.length).toBe(2); // The opener silently renews the same model session.
  expect(sessionPaths[1]).toBe(sessionPaths[0]);
  expect(idempotencyKeys[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);
  await viewer.close();

  await page.goto("/viewer/session/native/association-two/model-two?sourceId=project-alpha%3Astaging&workspaceId=workspace&projectPublicId=public-123&projectId=project-1&generationId=generation-1&sourceVersion=version-1");
  const nativePopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open full Viewer" }).click();
  const nativeViewer = await nativePopupPromise;
  await expect(nativeViewer).toHaveURL(/^https:\/\/viewer\.ledgetopdroneservices\.com\/session\/[0-9a-f-]+$/);
  expect(nativeBodies).toEqual([{
    sourceId: "project-alpha:staging", workspaceId: "workspace", projectPublicId: "public-123",
    projectId: "project-1", generationId: "generation-1", sourceVersion: "version-1",
  }]);
  expect(new URL(page.url()).searchParams.has("grant")).toBe(false);
  expect(sessionPaths[2]).toBe("/api/viewer/native-associations/association-two/session");
  expect(idempotencyKeys[2]).toMatch(/^[0-9a-f-]{36}$/);
  expect(idempotencyKeys[2]).not.toBe(idempotencyKeys[0]);
  await nativeViewer.close();

  const invalidRoutes: Array<[string, string]> = [
    ["/viewer/session/association-missing/model-three", "model-three"],
    ["/viewer/session/association-mismatch/model-four", "model-four"],
  ];
  for (const [path, model] of invalidRoutes) {
    await page.goto(path);
    const failedPopup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open full Viewer" }).click();
    const rejectedViewer = await failedPopup;
    await expect(page.getByRole("alert")).toHaveText("Viewer session does not match the requested model");
    await expect.poll(() => rejectedViewer.isClosed()).toBe(true);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toContain(model);
  }
});
