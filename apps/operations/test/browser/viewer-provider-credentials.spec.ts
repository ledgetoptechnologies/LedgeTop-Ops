import { expect, test } from "@playwright/test";

test("provider credentials are configured, rotated, probed, and cleared without being rendered", async ({ page }) => {
  const createdToken = "create-token-kept-only-in-request";
  const rotatedToken = "rotated-token-kept-only-in-request";
  const viewerBodies: Array<{ path: string; body: unknown }> = [];
  let provider: Record<string, unknown> | null = null;
  let canWrite = true;

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "viewer.ledgetopdroneservices.com") {
      if (url.pathname === "/api/v1/admin-sessions/redeem") return route.fulfill({ json: {
        accessToken: "a".repeat(43),
        session: { id: "session-provider", subject: "ops:staff-one", permissions: ["viewer.projects.read", "viewer.datasets.read", "viewer.processing.read", "viewer.providers.read", ...(canWrite ? ["viewer.providers.write"] : [])], expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        units: { default: "imperial", resolved: "imperial" },
      } });
      if (url.pathname === "/api/v1/processing/providers" && request.method() === "POST") {
        const body = request.postDataJSON(); viewerBodies.push({ path: url.pathname, body });
        provider = {
          id: "provider-one", type: body.type, displayName: body.displayName, endpoint: body.endpoint,
          enabled: false, admissionLimit: body.admissionLimit, activeAttempts: 0,
          credential: { configured: true, updatedAt: "2026-08-16T20:00:00.000Z" },
          capabilities: null, capabilityFingerprint: null, lastHealth: null, lastHealthAt: null,
          createdAt: "2026-08-16T20:00:00.000Z", updatedAt: "2026-08-16T20:00:00.000Z",
        };
        return route.fulfill({ status: 201, json: { provider } });
      }
      if (url.pathname === "/api/v1/processing/providers/provider-one/credential" && request.method() === "PUT") {
        const body = request.postDataJSON(); viewerBodies.push({ path: url.pathname, body });
        provider = { ...provider!, enabled: false, credential: { configured: true, updatedAt: "2026-08-16T20:02:00.000Z" }, capabilities: null, capabilityFingerprint: null, lastHealth: null, lastHealthAt: null, updatedAt: "2026-08-16T20:02:00.000Z" };
        return route.fulfill({ json: { provider } });
      }
      if (url.pathname === "/api/v1/processing/providers/provider-one/credential" && request.method() === "DELETE") {
        viewerBodies.push({ path: url.pathname, body: null });
        provider = { ...provider!, enabled: false, credential: { configured: false, updatedAt: null }, capabilities: null, capabilityFingerprint: null, lastHealth: null, lastHealthAt: null, updatedAt: "2026-08-16T20:03:00.000Z" };
        return route.fulfill({ json: { provider } });
      }
      if (url.pathname === "/api/v1/processing/providers/provider-one/capabilities/probe" && request.method() === "POST") {
        viewerBodies.push({ path: url.pathname, body: request.postDataJSON() });
        provider = { ...provider!, lastHealth: "healthy", lastHealthAt: "2026-08-16T20:01:00.000Z", capabilityFingerprint: "f".repeat(64), capabilities: { engine: "NodeODM", engineVersion: "2.2.3", compatibilityWarning: null } };
        return route.fulfill({ json: { capabilities: (provider as { capabilities: unknown }).capabilities, fingerprint: "f".repeat(64) } });
      }
      if (url.pathname === "/api/v1/processing/providers/provider-one" && request.method() === "PATCH") {
        const body = request.postDataJSON(); viewerBodies.push({ path: url.pathname, body });
        provider = { ...provider!, enabled: body.enabled, updatedAt: "2026-08-16T20:01:30.000Z" };
        return route.fulfill({ json: { provider } });
      }
      if (url.pathname === "/api/v1/processing/providers") return route.fulfill({ json: { providers: provider ? [provider] : [], nextCursor: null } });
      if (url.pathname === "/api/v1/projects") return route.fulfill({ json: { projects: [], nextCursor: null } });
      if (url.pathname === "/api/v1/datasets") return route.fulfill({ json: { datasets: [], nextCursor: null } });
      if (url.pathname === "/api/v1/tasks") return route.fulfill({ json: { tasks: [], nextCursor: null } });
      if (url.pathname === "/api/v1/processing/outputs") return route.fulfill({ json: { outputs: [], nextCursor: null, totalCount: 0, totalBytes: 0 } });
      if (url.pathname === "/api/v1/processing/presets") return route.fulfill({ json: { presets: [] } });
      if (url.pathname === "/api/v1/storage") return route.fulfill({ json: { storage: {
        datasets: { available: 1, total: 1, reserve: 0, required: 0, ok: true },
        models: { available: 1, total: 1, reserve: 0, required: 0, ok: true },
        cache: { available: 1, total: 1, reserve: 0, required: 0, ok: true },
        trash: { available: 1, total: 1, reserve: 0, required: 0, ok: true },
      }, trash: { items: [], nextCursor: null, totalCount: 0, totalBytes: 0 } } });
      return route.fulfill({ status: 404, json: { error: "not found" } });
    }

    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["viewer.view", "viewer.processing.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      units: { default: "imperial", resolved: "imperial" }, capabilities: { viewerProcessing: { enabled: true } },
    } });
    if (url.pathname === "/api/viewer") return route.fulfill({ json: { enabled: true, publicSharesEnabled: false, models: [], projects: [], associations: [] } });
    if (url.pathname === "/api/viewer/processing") return route.fulfill({ json: {
      enabled: true, viewerBaseUrl: "https://viewer.ledgetopdroneservices.com",
      permissions: ["viewer.projects.read", "viewer.datasets.read", "viewer.processing.read", "viewer.providers.read", ...(canWrite ? ["viewer.providers.write"] : [])],
      units: { default: "imperial", resolved: "imperial" }, events: [],
    } });
    if (url.pathname === "/api/viewer/admin-grant") return route.fulfill({ status: 201, json: {
      grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: "https://viewer.ledgetopdroneservices.com/api/v1/admin-sessions/redeem", units: { default: "imperial", resolved: "imperial" },
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/operations/processing");
  await page.getByRole("button", { name: "Providers" }).click();
  await page.getByLabel("Name").fill("Primary ClusterODM");
  await page.getByLabel("HTTPS or private endpoint").fill("http://192.168.50.80:3000");
  await page.getByLabel("Provider token (optional)").fill(createdToken);
  await page.getByRole("button", { name: "Add disabled provider" }).click();
  await expect(page.getByText("Credential configured")).toBeVisible();
  await expect(page.getByLabel("Provider token (optional)")).toHaveValue("");
  expect(viewerBodies[0]).toEqual({ path: "/api/v1/processing/providers", body: expect.objectContaining({ credential: { token: createdToken }, enabled: false }) });

  await page.getByRole("button", { name: "Probe capabilities" }).click();
  await expect(page.getByText("healthy", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable" })).toBeEnabled();
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText(/0 active · enabled/)).toBeVisible();

  await page.getByLabel("Replacement provider token").fill(rotatedToken);
  await page.getByRole("button", { name: "Rotate credential" }).click();
  await expect(page.getByLabel("Replacement provider token")).toHaveValue("");
  await expect(page.getByText("not probed", { exact: true })).toBeVisible();
  expect(viewerBodies).toContainEqual({ path: "/api/v1/processing/providers/provider-one/credential", body: { token: rotatedToken } });

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Clear credential" }).click();
  await expect(page.getByText("Credential missing")).toBeVisible();
  await expect(page.getByRole("button", { name: "Probe capabilities" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enable" })).toBeDisabled();
  await expect(page.getByText(createdToken)).toHaveCount(0);
  await expect(page.getByText(rotatedToken)).toHaveCount(0);
  expect(await page.evaluate(({ one, two }) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(one) && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(two), { one: createdToken, two: rotatedToken })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  canWrite = false;
  await page.reload();
  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.getByText("Credential missing")).toBeVisible();
  await expect(page.getByLabel("Provider token (optional)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /credential|probe|enable/i })).toHaveCount(0);
});
