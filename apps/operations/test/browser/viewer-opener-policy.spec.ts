import { expect, test, type Page } from "@playwright/test";

// The fixture server sends the Worker's own opener policy for each path, so this
// proves in a real browser what the header lets Viewer keep. Viewer is cross-site.
const viewer = "https://viewer.ledgetopdroneservices.com";
const session = { version: 1, sessionId: "session-workspace-one", subject: "ops:staff-one", expiresAt: new Date(Date.now() + 60_000).toISOString() };

async function mock(page: Page) {
  let grants = 0;
  await page.context().route(`${viewer}/**`, route => route.fulfill({ contentType: "text/html",
    headers: { "Cross-Origin-Opener-Policy": "unsafe-none" }, body: `<!doctype html><title>Viewer</title><body><script>
      document.body.dataset.opener = String(Boolean(opener));
      addEventListener("message", event => {
        if (event.source === opener && event.data?.type === "ltds-viewer:renew-workspace-session") document.body.dataset.renewalGrant = event.data.grant;
      });
      if (opener) {
        const session = ${JSON.stringify(session)};
        setTimeout(() => opener.postMessage({ ...session, type: "ltds-viewer:workspace-ready" }, "*"), 50);
        setTimeout(() => opener.postMessage({ ...session, type: "ltds-viewer:workspace-session-expiring", requestId: "workspace-renew-0001" }, "*"), 1_500);
      }
    </script></body>` }));
  await page.route("**/api/**", route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["viewer.view"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      units: { default: "imperial", resolved: "imperial" }, capabilities: {},
    } });
    if (pathname === "/api/viewer/overview") return route.fulfill({ json: { enabled: true, viewerBaseUrl: viewer, overview: {
      schemaVersion: 1, generatedAt: "2026-08-18T14:00:00.000Z", projects: { active: 4, total: 5 },
      models: { published: 8, total: 11, bytes: 4_294_967_296 }, jobs: { queued: 2, running: 1, reviewReady: 3, failed: 1 },
      providers: { enabled: 2, healthy: 2, total: 3 }, storage: { usedBytes: 8_589_934_592, availableBytes: 107_374_182_400 },
      platform: { ready: true, workerLive: true, lifecycleBlocked: false },
    } } });
    if (pathname === "/api/viewer/admin-grant" && route.request().method() === "POST") {
      const grant = (++grants === 1 ? "g" : "h").repeat(43);
      return route.fulfill({ status: 201, json: { grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: `${viewer}/api/v1/admin-sessions/redeem`, workspaceUrl: `${viewer}/workspace/${grant}`,
        units: { default: "imperial", resolved: "imperial" } } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

test("the Operations shell keeps the Viewer tab it opened and renews it through that opener", async ({ page, context }) => {
  await mock(page);
  const response = await page.goto("/viewer");
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open Viewer workspace" }).click();
  const popup = await opened;
  await popup.waitForURL(`${viewer}/workspace/${"g".repeat(43)}`);
  await expect(popup.locator("body")).toHaveAttribute("data-opener", "true");
  // The renewal request waits past the one-second check that stops listening to a closed (or severed) tab.
  await expect(popup.locator("body")).toHaveAttribute("data-renewal-grant", "h".repeat(43), { timeout: 10_000 });
});

for (const path of ["/r/public-link", "/unknown"])
  test(`a page outside the shell route cannot keep a cross-site tab: ${path}`, async ({ page, context }) => {
    await mock(page);
    const response = await page.goto(path);
    expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    const opened = context.waitForEvent("page");
    await page.evaluate(url => { window.open(url, "_blank"); }, `${viewer}/workspace/${"g".repeat(43)}`);
    const popup = await opened;
    await popup.waitForURL(`${viewer}/workspace/${"g".repeat(43)}`);
    await expect(popup.locator("body")).toHaveAttribute("data-opener", "false");
  });

test("static assets keep the strict policy", async ({ page, request }) => {
  await page.goto("/viewer");
  const source = await page.locator("script[src]").first().getAttribute("src");
  expect((await request.get(source!)).headers()["cross-origin-opener-policy"]).toBe("same-origin");
});
