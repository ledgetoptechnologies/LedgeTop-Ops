import { expect, test } from "@playwright/test";

test("Operations shows a bounded Viewer overview and opens management on the Viewer domain", async ({ page, context }) => {
  const operationsRequests: string[] = [];
  let adminGrantCount = 0;
  await context.route("https://viewer.ledgetopdroneservices.com/workspace/**", route =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><title>LTDS Viewer workspace</title><body>
      <script>
        const session = { version: 1, sessionId: "session-workspace-one", subject: "ops:staff-one", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        addEventListener("message", event => {
          if (event.source !== opener) return;
          if (event.data?.type === "ltds-viewer:workspace-session-renewal-failed") {
            document.body.dataset.failedRequest = event.data.requestId;
            document.body.dataset.retryable = String(event.data.retryable);
            return;
          }
          if (event.data?.type !== "ltds-viewer:renew-workspace-session") return;
          document.body.dataset.renewalGrant = event.data.grant;
          document.body.dataset.renewalRequest = event.data.requestId;
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
      if (adminGrantCount === 4 || adminGrantCount === 5) return route.fulfill({
        status: adminGrantCount === 4 ? 503 : 403, json: { error: "Renewal unavailable" },
      });
      const grant = (adminGrantCount === 1 ? "g" : "h").repeat(43);
      return route.fulfill({ status: 201, json: {
      grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
      workspaceUrl: `https://viewer.ledgetopdroneservices.com/workspace/${grant}`,
      units: { default: "imperial", resolved: "imperial" },
    } }); }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/viewer");
  await expect(page.getByRole("heading", { name: "3D models", exact: true })).toBeVisible();
  await expect(page.getByText("11 total · 4.0 GB")).toBeVisible();
  await expect(page.getByText("3", { exact: true })).toBeVisible();
  await expect(page.getByText("2 healthy")).toBeVisible();
  await expect(page.getByText(/1 processing job needs attention/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Processing platform" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Providers" })).toHaveCount(0);
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
  await expect.poll(() => opened.evaluate(() => document.body.dataset.renewalRequest)).toBe("workspace-renew-0001");
  const requestRenewal = (requestId: string, subject = "ops:staff-one") => opened.evaluate(({ requestId, subject }) => {
    window.opener.postMessage({ version: 1, type: "ltds-viewer:workspace-session-expiring", requestId,
      sessionId: "session-workspace-one", subject, expiresAt: new Date(Date.now() - 1_000).toISOString() }, "*");
  }, { requestId, subject });
  // An expired Viewer session may request fresh server authority; cached expiry
  // itself is never extended by this controller.
  await requestRenewal("workspace-renew-0002");
  await expect.poll(() => opened.evaluate(() => document.body.dataset.renewalRequest)).toBe("workspace-renew-0002");
  await requestRenewal("workspace-renew-0002"); // duplicate must not issue twice
  await requestRenewal("workspace-renew-other", "ops:another-staff");
  await requestRenewal("workspace-renew-0003");
  await expect.poll(() => opened.evaluate(() => document.body.dataset.failedRequest)).toBe("workspace-renew-0003");
  await expect.poll(() => opened.evaluate(() => document.body.dataset.retryable)).toBe("true");
  await requestRenewal("workspace-renew-0004");
  await expect.poll(() => opened.evaluate(() => document.body.dataset.failedRequest)).toBe("workspace-renew-0004");
  await expect.poll(() => opened.evaluate(() => document.body.dataset.retryable)).toBe("false");
  expect(adminGrantCount).toBe(5);
  expect(opened.url()).toBe(`https://viewer.ledgetopdroneservices.com/workspace/${"g".repeat(43)}`);
});

test("Operations keeps disabled Viewer management out of the Data hub", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-viewer", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Employee", isAdministrator: false,
        permissions: ["viewer.view", "viewer.manage"], divisions: [],
      },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      units: { default: "imperial", resolved: "imperial" }, capabilities: {},
    } });
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: {
      enabled: false, viewerBaseUrl: null, overview: null,
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/viewer");
  await expect(page.getByText("3D Viewer overview is off", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test Viewer connection" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tasks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Providers" })).toHaveCount(0);
  expect(requests.some(value => value.includes("/api/viewer/processing"))).toBe(false);
  expect(requests.some(value => value.includes("/api/viewer/connection-preflight"))).toBe(false);
});

test("an authenticated Viewer bounce issues one fixed-origin grant and returns the same browser nonce", async ({ page, context }) => {
  const state = "r".repeat(32);
  const grant = "z".repeat(43);
  let issued = 0;
  await context.route("https://viewer.ledgetopdroneservices.com/workspace/**", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Reauthorized Viewer</title>" }));
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["viewer.view"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: {
      enabled: true, viewerBaseUrl: "https://viewer.ledgetopdroneservices.com", overview: null,
    } });
    if (url.pathname === "/api/viewer/admin-grant" && request.method() === "POST") {
      issued += 1;
      return route.fulfill({ status: 201, json: {
        grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
        workspaceUrl: `https://viewer.ledgetopdroneservices.com/workspace/${grant}`,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto(`/viewer/reauthorize?state=${state}`);
  await page.waitForURL(`https://viewer.ledgetopdroneservices.com/workspace/${grant}#reauthorize=${state}`);
  expect(issued).toBe(1);
});

async function mockReauthorization(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext, workspaceOrigin = "https://viewer.ledgetopdroneservices.com") {
  const grant = "z".repeat(43), counts = { issued: 0 };
  await context.route("https://*.ledgetopdroneservices.com/workspace/**", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Reauthorized Viewer</title>" }));
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["viewer.view"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: {
      enabled: true, viewerBaseUrl: "https://viewer.ledgetopdroneservices.com", overview: null,
    } });
    if (url.pathname === "/api/viewer/admin-grant" && request.method() === "POST") {
      counts.issued += 1;
      expect(request.headers()["x-csrf-token"]).toBe("csrf");
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      return route.fulfill({ status: 201, json: {
        grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem",
        workspaceUrl: `${workspaceOrigin}/workspace/${grant}`,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { grant, counts };
}

test("an explicit current-tab recovery bounce echoes its mode beside the same nonce", async ({ page, context }) => {
  const state = "s".repeat(32);
  const { grant, counts } = await mockReauthorization(page, context);
  await page.goto(`/viewer/reauthorize?state=${state}&recoveryMode=same-tab`);
  await page.waitForURL(`https://viewer.ledgetopdroneservices.com/workspace/${grant}#reauthorize=${state}&recoveryMode=same-tab`);
  expect(counts.issued).toBe(1);
});

for (const [label, search] of [
  ["an unknown mode", `state=${"s".repeat(32)}&recoveryMode=popup`],
  ["a repeated mode", `state=${"s".repeat(32)}&recoveryMode=same-tab&recoveryMode=same-tab`],
  ["a repeated nonce", `state=${"s".repeat(32)}&state=${"t".repeat(32)}&recoveryMode=same-tab`],
  ["a malformed nonce", "state=short&recoveryMode=same-tab"],
  ["a mode without a nonce", "recoveryMode=same-tab"],
] as const) test(`a Viewer bounce with ${label} is refused before any grant is issued`, async ({ page, context }) => {
  const { counts } = await mockReauthorization(page, context);
  await page.goto(`/viewer/reauthorize?${search}`);
  await expect(page.getByText("This Viewer sign-in link isn't valid. Open the Viewer from Operations again.")).toBeVisible();
  await page.waitForTimeout(300);
  expect(counts.issued).toBe(0);
  expect(new URL(page.url()).origin).not.toBe("https://viewer.ledgetopdroneservices.com");
});

test("a current-tab recovery never follows a grant for a foreign Viewer origin", async ({ page, context }) => {
  const { counts } = await mockReauthorization(page, context, "https://evil.ledgetopdroneservices.com");
  await page.goto(`/viewer/reauthorize?state=${"s".repeat(32)}&recoveryMode=same-tab`);
  await expect(page.getByText("3D Viewer returned an invalid reauthorization link")).toBeVisible();
  expect(counts.issued).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/viewer/reauthorize");
});

for (const invalidOrigin of [false, true]) {
  test(`blocked Viewer pop-ups offer authenticated same-tab navigation${invalidOrigin ? " and reject an unexpected origin" : ""}`, async ({ page, context }) => {
    const viewerOrigin = "https://viewer.ledgetopdroneservices.com";
    const grant = "s".repeat(43);
    let issued = 0;
    await page.addInitScript(() => { window.open = () => null; });
    await context.route(`${viewerOrigin}/workspace/**`, route =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer same tab</title>" }));
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/session") return route.fulfill({ json: {
        user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
          profileType: "Administrator", isAdministrator: true, permissions: ["viewer.view"], divisions: [] },
        csrfToken: "csrf-same-tab", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
        units: { default: "imperial", resolved: "imperial" }, capabilities: {},
      } });
      if (path === "/api/viewer/overview") return route.fulfill({ json: {
        enabled: true, viewerBaseUrl: viewerOrigin, overview: {
          schemaVersion: 1, generatedAt: "2026-10-15T00:00:00.000Z",
          projects: { active: 1, total: 1 }, models: { published: 1, total: 1, bytes: 0 },
          jobs: { queued: 0, running: 0, reviewReady: 0, failed: 0 },
          providers: { enabled: 1, healthy: 1, total: 1 }, storage: { usedBytes: 0, availableBytes: 1000 },
          platform: { ready: true, workerLive: true, lifecycleBlocked: false },
        },
      } });
      if (path === "/api/viewer/admin-grant" && request.method() === "POST") {
        issued += 1;
        expect(request.headers()["x-csrf-token"]).toBe("csrf-same-tab");
        expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
        return route.fulfill({ status: 201, json: {
          grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
          redeemUrl: `${viewerOrigin}/api/v1/admin-sessions/redeem`,
          workspaceUrl: `${invalidOrigin ? "https://unexpected.example.test" : viewerOrigin}/workspace/${grant}`,
        } });
      }
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    });

    await page.goto("/viewer");
    await expect(page.getByRole("button", { name: "Open Viewer in this tab" })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Viewer workspace" }).click();
    await expect(page.getByText("Your browser doesn't support pop-ups. Open the Viewer in this tab to continue.")).toBeVisible();
    expect(issued).toBe(0);
    expect(context.pages()).toHaveLength(1);
    await page.getByRole("button", { name: "Open Viewer in this tab" }).click();
    if (invalidOrigin) {
      await expect(page.getByText("3D Viewer returned an invalid workspace link")).toBeVisible();
      await expect(page).toHaveURL(/\/viewer$/);
    } else {
      await expect(page).toHaveURL(`${viewerOrigin}/workspace/${grant}`);
      await expect(page).toHaveTitle("Viewer same tab");
      expect(await page.evaluate(() => window.opener === null)).toBe(true);
    }
    expect(issued).toBe(1);
    expect(context.pages()).toHaveLength(1);
  });
}
