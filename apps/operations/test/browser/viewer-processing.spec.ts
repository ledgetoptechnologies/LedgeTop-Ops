import { expect, test } from "@playwright/test";

test("Operations shows a bounded Viewer overview and opens management on the Viewer domain", async ({ page, context }) => {
  const operationsRequests: string[] = [];
  let adminGrantCount = 0;
  await context.route("https://viewer.ledgetopdroneservices.com/workspace/**", route =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><title>LTDS Viewer workspace</title><body>
      <script>
        const session = { version: 1, sessionId: "session-workspace-one", subject: "ops:staff-one", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        addEventListener("message", event => {
          if (event.source !== opener || event.data?.type !== "ltds-viewer:renew-workspace-session") return;
          document.body.dataset.renewalGrant = event.data.grant;
        });
        setTimeout(() => opener.postMessage({ ...session, type: "ltds-viewer:workspace-ready" }, "*"), 50);
        setTimeout(() => opener.postMessage({ ...session, type: "ltds-viewer:workspace-session-expiring", requestId: "workspace-renew-0001" }, "*"), 100);
      </script>
    </body>` }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    operationsRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true,
        permissions: ["viewer.view"], divisions: [],
      },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      units: { default: "imperial", resolved: "imperial" }, capabilities: {},
    } });
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: {
      enabled: true,
      viewerBaseUrl: "https://viewer.ledgetopdroneservices.com",
      overview: {
        schemaVersion: 1, generatedAt: "2026-08-18T14:00:00.000Z",
        projects: { active: 4, total: 5 },
        models: { published: 8, total: 11, bytes: 4_294_967_296 },
        jobs: { queued: 2, running: 1, reviewReady: 3, failed: 1 },
        providers: { enabled: 2, healthy: 2, total: 3 },
        storage: { usedBytes: 8_589_934_592, availableBytes: 107_374_182_400 },
        platform: { ready: true, workerLive: true, lifecycleBlocked: false },
      },
    } });
    if (url.pathname === "/api/viewer/admin-grant" && request.method() === "POST") {
      adminGrantCount += 1;
      const grant = (adminGrantCount === 1 ? "g" : "h").repeat(43);
      return route.fulfill({ status: 201, json: {
      grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
      workspaceUrl: `https://viewer.ledgetopdroneservices.com/workspace/${grant}`,
      units: { default: "imperial", resolved: "imperial" },
    } }); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/operations/processing");
  await expect(page.getByRole("heading", { name: "3D models" })).toBeVisible();
  await expect(page.getByText("11 total · 4.0 GB")).toBeVisible();
  await expect(page.getByText("3", { exact: true })).toBeVisible();
  await expect(page.getByText("2 healthy")).toBeVisible();
  await expect(page.getByText(/1 processing job needs attention/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Processing platform" })).toHaveCount(0);
  expect(operationsRequests.some(value => value.includes("/api/viewer/processing"))).toBe(false);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  const openedPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open Viewer workspace" }).click();
  const opened = await openedPromise;
  await opened.waitForURL(`https://viewer.ledgetopdroneservices.com/workspace/${"g".repeat(43)}`);
  expect(opened.url()).toBe(`https://viewer.ledgetopdroneservices.com/workspace/${"g".repeat(43)}`);
  await expect.poll(() => opened.evaluate(() => document.body.dataset.renewalGrant)).toBe("h".repeat(43));
  expect(operationsRequests.filter(value => value === "POST /api/viewer/admin-grant")).toHaveLength(2);
});
