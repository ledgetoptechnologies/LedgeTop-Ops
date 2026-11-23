import { expect, test as base, type Page } from "@playwright/test";
import { isolatedBrowserArgs, startProxySink, unexpectedHosts, type ProxySink } from "../browser-network-guard";

// The fixture server sends the Worker's own opener policy for each path, so this
// proves in a real browser what the header lets Viewer keep. Operations reads the
// Viewer address from its API, so a reserved cross-site name stands in for it. The
// browser cannot resolve or reach any other host, and trying to fails the test.
const viewerHost = "viewer.example.test", viewer = `https://${viewerHost}`;
// Never fulfilled: proves the guard is live.
const controlHost = "blocked.example.test";
const declared = [viewerHost, controlHost];
const session = { version: 1, sessionId: "session-workspace-one", subject: "ops:staff-one", expiresAt: new Date(Date.now() + 60_000).toISOString() };

interface NetworkGuard {
  /** Hosts this test asked for, by page request and by any browser connection. */
  hosts(): string[];
}

const test = base.extend<{ network: NetworkGuard }, { sink: ProxySink }>({
  sink: [async ({}, use) => {
    const sink = await startProxySink();
    await use(sink);
    await sink.close();
    // Connections made after the last test's own check.
    const unexpected = unexpectedHosts(sink.hosts, declared);
    if (unexpected.length) throw new Error(`The browser tried to reach: ${unexpected.join(", ")}`);
  }, { scope: "worker" }],
  launchOptions: [async ({ launchOptions, sink }, use) => {
    await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...isolatedBrowserArgs(sink.port)] });
  }, { scope: "worker" }],
  network: [async ({ context, sink }, use) => {
    const requested: string[] = [], start = sink.hosts.length;
    context.on("request", request => {
      const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol)) requested.push(url.hostname);
    });
    context.on("page", page => page.on("websocket", socket => requested.push(new URL(socket.url()).hostname)));
    const hosts = () => [...requested, ...sink.hosts.slice(start)];
    await use({ hosts });
    expect(unexpectedHosts(hosts(), declared), "no host except loopback and the declared reserved names").toEqual([]);
  }, { auto: true }],
});

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

test("the network guard is live: an unfulfilled host is recorded and unreachable", async ({ page, network }) => {
  await expect(page.goto(`https://${controlHost}/`)).rejects.toThrow(/net::ERR_/u);
  // Once as the page's request and at least once as a connection at the sink.
  await expect.poll(() => network.hosts().filter(host => host === controlHost).length).toBeGreaterThanOrEqual(2);
});

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
  expect((await request.get(new URL(source!, page.url()).pathname)).headers()["cross-origin-opener-policy"]).toBe("same-origin");
});
