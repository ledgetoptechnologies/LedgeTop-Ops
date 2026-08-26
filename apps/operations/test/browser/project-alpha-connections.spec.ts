import { expect, test, type Page, type Route } from "@playwright/test";

const endpoint = "/api/admin/integrations/project-alpha/connectors";
const primary = "project-alpha:primary", secondary = "project-alpha:business-b";
interface Connector {
  sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data";
  state: "pending" | "active" | "suspended" | "retired"; readVisible: boolean; activeRevision: number; version: number;
}
interface Directory {
  connectors: Connector[]; legacyPrimary: boolean;
  health: Array<{ sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null }>;
  recovery?: Array<{ sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
    status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number }> | null;
}
function connector(sourceId = secondary, state: Connector["state"] = "active"): Connector {
  return { sourceId, displayName: sourceId === primary ? "Primary company" : "Business B", producerBindingId: sourceId === primary ? "producer-primary" : "producer-business-b",
    snapshotOrigin: sourceId === primary ? "https://primary.example.test" : "https://business-b.example.test", snapshotBasePath: "/api/exports",
    applicationKey: "external_operations", profile: sourceId === primary ? "primary_legacy" : "business_data", state,
    readVisible: true, activeRevision: 1, version: 3 };
}
const directory = (connectors = [connector()]): Directory => ({ connectors, health: [], legacyPrimary: false });
type Recovery = NonNullable<Directory["recovery"]>[number];
const recovery = (overrides: Partial<Recovery> = {}): Recovery => ({ sourceId: secondary, lastAttemptAt: "2026-08-26T12:00:00Z",
  lastSuccessAt: "2026-08-26T12:00:00Z", nextAttemptAt: "2026-08-27T12:00:00Z", status: "success", errorCode: null, failureCount: 0, ...overrides });
type Handler = (route: Route, path: string) => Promise<boolean>;
async function fixture(page: Page, data: Directory, handler?: Handler, manage = true) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; csrf: string | undefined }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator",
        isAdministrator: manage, permissions: ["administration.view", ...(manage ? ["integrations.manage"] : [])], divisions: [] },
      csrfToken: "csrf-fixture", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (!path.startsWith(endpoint)) return route.fulfill({ status: 404, json: { error: "Unsupported fixture endpoint" } });
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ path, method: request.method(), body, csrf: request.headers()["x-csrf-token"] });
    if (handler && await handler(route, path)) return;
    if (request.method() === "GET" && path === endpoint) return route.fulfill({ json: data });
    const sourceId = decodeURIComponent(path.slice(endpoint.length + 1).split("/")[0]!);
    const current = data.connectors.find(row => row.sourceId === sourceId);
    if (request.method() === "PATCH" && current && body) {
      expect(body.expectedVersion).toBe(current.version);
      if (typeof body.state === "string") current.state = body.state as Connector["state"];
      if (typeof body.readVisible === "boolean") current.readVisible = body.readVisible;
      if (typeof body.displayName === "string") current.displayName = body.displayName;
      current.version += 1;
      return route.fulfill({ json: { connector: current } });
    }
    if (request.method() === "POST" && path.endsWith("/sync")) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 400, json: { error: "Unexpected connection mutation" } });
  });
  return requests;
}
async function confirmation(page: Page, action: () => Promise<unknown>, expected: RegExp, accept: boolean) {
  const dialogPromise = page.waitForEvent("dialog"), clicked = action();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toMatch(expected);
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await clicked;
}
async function fillRegistration(page: Page, sourceId = secondary) {
  const details = page.locator(".alpha-connections > details");
  await details.locator(":scope > summary").click();
  const form = details.locator("form");
  await form.getByLabel("Source ID", { exact: true }).fill(sourceId);
  await form.getByLabel("Connection label", { exact: true }).fill("Registered company");
  await form.getByLabel("Immutable producer ID").fill("producer-registered");
  await form.getByLabel("Snapshot origin").fill("https://registered.example.test");
  await form.getByLabel("Base path").fill("/api/exports");
  await form.getByLabel("Application key").fill("external_operations");
  await form.getByLabel("Credential reference").fill("PA_REGISTERED");
  await form.getByLabel("Access issuer").fill("https://team.cloudflareaccess.com");
  await form.getByLabel("Access audience").fill("audience-registered");
  await form.getByLabel("Producer Access subject").fill("producer-subject");
  return form;
}

test("read-only Administration does not probe privileged connection configuration", async ({ page }) => {
  const requests = await fixture(page, directory(), undefined, false);
  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Security model" })).toBeVisible();
  await expect(page.locator(".alpha-connections")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("initial loading and read failure offer an explicit retry without fabricated health", async ({ page }) => {
  let first: Route | null = null, reads = 0;
  await fixture(page, { ...directory([]), legacyPrimary: true }, async (route, path) => {
    if (path === endpoint && route.request().method() === "GET" && ++reads === 1) { first = route; return true; }
    return false;
  });
  await page.goto("/administration");
  await expect(page.getByText("Loading connections…", { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(first)).toBe(true);
  await first!.fulfill({ status: 503, json: { error: "Connection registry is not ready. Retry shortly." } });
  await expect(page.getByRole("alert")).toContainText("Connection registry is not ready");
  await expect(page.getByRole("button", { name: "Sync primary now" })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(page.getByRole("heading", { name: "Primary connection", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".alpha-connections")).toContainText("Sync: Not yet run");
});

test("state and visibility changes require confirmation and preserve their separate consequences", async ({ page }) => {
  const data = directory([connector(primary), { ...connector(secondary, "pending"), readVisible: false }]);
  const requests = await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await confirmation(page, () => card.getByRole("button", { name: "Activate connection" }).click(), /business-data synchronization only; it grants no staff or client access/, false);
  expect(requests.filter(row => row.method !== "GET")).toHaveLength(0);
  await confirmation(page, () => card.getByRole("button", { name: "Activate connection" }).click(), /business-data synchronization only/, true);
  await expect(card.getByRole("button", { name: "Suspend sync" })).toBeVisible();
  expect(requests.find(row => row.method === "PATCH")?.body).toEqual({ expectedVersion: 3, state: "active", readVisible: false });
  await confirmation(page, () => card.getByRole("button", { name: "Show business records" }).click(), /does not change client access or shared links/, true);
  await expect(card).toContainText("Business records visible");
  await confirmation(page, () => card.getByRole("button", { name: "Suspend sync" }).click(), /Existing business records and client grants are retained/, true);
  await expect(card.getByRole("button", { name: "Activate connection" })).toBeVisible();
  await expect(card).toContainText("Business records visible");
  await card.getByText("Connection details", { exact: true }).click();
  await confirmation(page, () => card.getByRole("button", { name: "Retire connection" }).click(), /Retirement is permanent/, false);
  expect(requests.filter(row => row.method === "PATCH")).toHaveLength(3);
  await confirmation(page, () => card.getByRole("button", { name: "Retire connection" }).click(), /producer identity cannot be reused/, true);
  await expect(card).toContainText("retired");
  await expect(card.getByRole("button", { name: "Activate connection" })).toHaveCount(0);
  expect(requests.filter(row => row.method !== "GET").every(row => row.csrf === "csrf-fixture")).toBe(true);
});

test("primary suspension and retirement warn about every connection before any mutation", async ({ page }) => {
  const requests = await fixture(page, directory([connector(primary), connector()]));
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Primary company connection" });
  await confirmation(page, () => card.getByRole("button", { name: "Suspend sync" }).click(), /pauses synchronization for the primary and all secondary connections until primary is activated again/, false);
  await card.getByText("Connection details", { exact: true }).click();
  await confirmation(page, () => card.getByRole("button", { name: "Retire connection" }).click(), /permanently stops synchronization for all connections\. It cannot be reactivated or replaced here/, false);
  expect(requests.filter(row => row.method !== "GET")).toHaveLength(0);
  await expect(card.getByRole("button", { name: "Suspend sync" })).toBeVisible();
});

test("stale-version conflict remains visible and never silently retries the mutation", async ({ page }) => {
  const data = directory();
  let failed = false;
  const requests = await fixture(page, data, async route => {
    if (route.request().method() !== "PATCH" || failed) return false;
    failed = true; data.connectors[0]!.version = 4;
    await route.fulfill({ status: 409, json: { error: "This connection changed. Refresh and review before trying again." } });
    return true;
  });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  await confirmation(page, () => card.getByRole("button", { name: "Suspend sync" }).click(), /stops new synchronization/, true);
  await expect(page.getByRole("alert")).toContainText("This connection changed");
  await expect.poll(() => requests.filter(row => row.method === "GET").length).toBeGreaterThanOrEqual(2);
  await expect(card.getByRole("button", { name: "Suspend sync" })).toBeEnabled();
  expect(requests.filter(row => row.method === "PATCH")).toHaveLength(1);
  await confirmation(page, () => card.getByRole("button", { name: "Suspend sync" }).click(), /stops new synchronization/, true);
  await expect(card.getByRole("button", { name: "Activate connection" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests.filter(row => row.method === "PATCH").map(row => row.body?.expectedVersion)).toEqual([3, 4]);
});

test("Sync now addresses exactly the selected source and disables competing actions while pending", async ({ page }) => {
  let pending: Route | null = null;
  const requests = await fixture(page, directory([connector(primary), connector()]), async (route, path) => {
    if (path.endsWith("/sync")) { pending = route; return true; }
    return false;
  });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Primary company connection" }).getByRole("button", { name: "Suspend sync" })).toBeDisabled();
  expect(requests.filter(row => row.method === "POST")).toEqual([{ path: `${endpoint}/project-alpha%3Abusiness-b/sync`, method: "POST", body: {}, csrf: "csrf-fixture" }]);
  await pending!.fulfill({ json: { ok: true } });
  await expect(page.getByRole("status").filter({ hasText: "Business B synchronization finished." })).toBeVisible();
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
});

test("primary enrollment warns that pending pauses legacy synchronization and submits references, never credentials", async ({ page }) => {
  const data = { ...directory([]), legacyPrimary: true };
  const requests = await fixture(page, data, async (route, path) => {
    if (route.request().method() !== "POST" || path !== endpoint) return false;
    data.legacyPrimary = false; data.connectors.push({ ...connector(primary, "pending"), displayName: "Registered company", version: 1 });
    await route.fulfill({ json: { connector: data.connectors[0] } }); return true;
  });
  await page.goto("/administration");
  const form = await fillRegistration(page, primary);
  await expect(form.locator('input[type="password"]')).toHaveCount(0);
  await expect(form.getByLabel(/API token|API secret|Signing key|Private key|Password/i)).toHaveCount(0);
  await expect(form.getByLabel("Credential reference")).toHaveAttribute("placeholder", "Deployed secret reference, not the secret");
  await confirmation(page, () => form.getByRole("button", { name: "Register pending connection" }).click(), /Enrollment pauses legacy synchronization until you activate/, false);
  expect(requests.filter(row => row.method === "POST")).toHaveLength(0);
  await confirmation(page, () => form.getByRole("button", { name: "Register pending connection" }).click(), /must match the deployed producer and signing keys/, true);
  const request = requests.find(row => row.method === "POST")!;
  expect(request.csrf).toBe("csrf-fixture");
  expect(request.body).toEqual({ sourceId: primary, producerBindingId: "producer-registered", displayName: "Registered company",
    snapshotOrigin: "https://registered.example.test", applicationKey: "external_operations", profile: "primary_legacy",
    revision: { credentialRef: "PA_REGISTERED", snapshotBasePath: "/api/exports", accessIssuer: "https://team.cloudflareaccess.com",
      accessAudience: "audience-registered", accessSubject: "producer-subject" } });
  const card = page.getByRole("region", { name: "Registered company connection" });
  await expect(card).toContainText("pending");
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: /Hide business records|Show business records/ })).toHaveCount(0);
});

test("revision confirmation preserves immutable destination and uses the chosen source", async ({ page }) => {
  const data = directory();
  const requests = await fixture(page, data, async (route, path) => {
    if (!path.endsWith("/revisions")) return false;
    data.connectors[0]!.activeRevision += 1; data.connectors[0]!.version += 1;
    await route.fulfill({ json: { connector: data.connectors[0] } }); return true;
  });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  await card.getByText("Connection details", { exact: true }).click();
  await card.getByText("Rotate credentials and producer authentication", { exact: true }).click();
  const form = card.locator("form").filter({ has: page.getByLabel("Credential reference") });
  await form.getByLabel("Credential reference").fill("BUSINESS_B_ROTATED");
  await form.getByLabel("Access issuer").fill("https://team.cloudflareaccess.com");
  await form.getByLabel("Access audience").fill("new-audience");
  await form.getByLabel("Producer Access subject").fill("same-producer");
  await confirmation(page, () => form.getByRole("button", { name: "Apply new revision" }).click(), /old-revision syncs will stop before further writes/, true);
  await expect(page.getByRole("status").filter({ hasText: "Connection revision updated." })).toBeVisible();
  expect(requests.find(row => row.path.endsWith("/revisions"))).toMatchObject({ path: `${endpoint}/project-alpha%3Abusiness-b/revisions`,
    method: "POST", body: { expectedVersion: 3, revision: { credentialRef: "BUSINESS_B_ROTATED", snapshotBasePath: "/api/exports",
      accessIssuer: "https://team.cloudflareaccess.com", accessAudience: "new-audience", accessSubject: "same-producer" } } });
  await expect(card).toContainText("https://business-b.example.test/api/exports");
});

test("connection forms and actions remain readable and keyboard accessible across viewport sizes", async ({ page }, testInfo) => {
  const data = directory([{ ...connector(), displayName: "Business B with a long company name for regional field operations",
    snapshotBasePath: `/api/exports/${"long-segment/".repeat(12)}` }]);
  data.health.push({ sourceId: secondary, status: "degraded", lastAttemptAt: "2026-08-26T12:00:00Z", lastSuccessAt: null,
    lastErrorCode: "connector_configuration_unavailable" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page, data);
  await page.goto("/administration");
  await page.getByText("Connection details", { exact: true }).click();
  const form = await fillRegistration(page);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const input = form.getByLabel("Source ID", { exact: true });
    await input.focus(); await expect(input).toBeFocused();
    const bounds = await input.boundingBox();
    expect(bounds!.width).toBeGreaterThan(80);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const labelGap = await input.evaluate(node => { const label = node.parentElement!; return parseFloat(getComputedStyle(label).rowGap); });
    expect(labelGap).toBeGreaterThanOrEqual(4);
    for (const button of await page.locator(".alpha-connection-actions button").all()) {
      const buttonBounds = await button.boundingBox();
      expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(width);
      if (width <= 640) expect(buttonBounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await page.screenshot({ path: testInfo.outputPath(`project-alpha-connections-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`project-alpha-connections-${width}-full.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

for (const availability of ["null", "omitted", "missing-source-row"] as const) test(`scheduled recovery ${availability} is unavailable, never fabricated healthy or unattempted`, async ({ page }) => {
  const data = directory([connector(primary), connector()]);
  if (availability === "null") data.recovery = null;
  if (availability === "missing-source-row") data.recovery = [recovery({ sourceId: "project-alpha:another", errorCode: "other_source_private_error" })];
  const requests = await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" }), status = card.getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText("Eligible by connection state");
  await expect(status).toContainText("Recovery status unavailable");
  await expect(status).not.toContainText(/Succeeded|Not attempted|other_source_private_error|Next attempt not before/);
  await expect(page.getByRole("region", { name: "Primary company connection" }).getByRole("group", { name: "Scheduled recovery" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
  expect(requests.every(row => row.method === "GET")).toBe(true);
});

test("successful secondary recovery shows an earliest time, not a promised next run", async ({ page }) => {
  await fixture(page, { ...directory([connector(primary), connector()]), recovery: [recovery()] });
  await page.goto("/administration");
  const status = page.getByRole("region", { name: "Business B connection" }).getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText("Last attempt: Succeeded");
  await expect(status).toContainText("Last success:");
  await expect(status).toContainText("Next attempt not before:");
  await expect(status.locator('time[datetime="2026-08-27T12:00:00Z"]')).toBeVisible();
  await expect(status).not.toContainText(/Failure count|Last recovery error/);
  await status.getByText("Recovery schedule", { exact: true }).click();
  await expect(status).toContainText("Checked hourly, with at most two connections processed one at a time.");
  await expect(status).toContainText("After success, at least 24 hours pass before another scheduled attempt.");
  await expect(status).toContainText("Earliest times are not guaranteed start times.");
});

test("primary suspension pauses secondary eligibility without rewriting its previous failed attempt", async ({ page }) => {
  const data = { ...directory([connector(primary, "suspended"), connector()]), recovery: [recovery({ status: "failed", errorCode: "snapshot_unavailable", failureCount: 3 })] };
  await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" }), status = card.getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText("Paused: primary connection is not active");
  await expect(status).toContainText("Last attempt: Failed");
  await expect(status).toContainText("Last recovery error: snapshot_unavailable");
  await expect(status).toContainText("Failure count: 3");
  await expect(status).toContainText("Last success:");
  await expect(status).not.toContainText("Next attempt not before:");
  await expect(card.getByRole("button", { name: "Suspend sync", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Hide business records", exact: true })).toBeEnabled();
});

test("pending, suspended, and retired secondaries stay paused independently of prior recovery success", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), connector(secondary, "pending")]), recovery: [recovery()] };
  await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" }), status = card.getByRole("group", { name: "Scheduled recovery" });
  for (const state of ["pending", "suspended", "retired"] as const) {
    if (state !== "pending") {
      data.connectors[1]!.state = state;
      await page.getByRole("button", { name: "Refresh connection status", exact: true }).click();
    }
    await expect(status).toContainText(`Paused: this connection is ${state}`);
    await expect(status).toContainText("Last attempt: Succeeded");
    await expect(status).not.toContainText("Next attempt not before:");
    await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  }
  await expect(card.getByRole("button", { name: "Activate connection", exact: true })).toHaveCount(0);
});

for (const state of ["never", "running", "deferred"] as const) test(`scheduled recovery reports ${state} without implying a successful synchronization`, async ({ page }) => {
  const labels = { never: "Not attempted", running: "Running", deferred: "Deferred" };
  await fixture(page, { ...directory([connector(primary), connector()]), recovery: [recovery({ status: state,
    lastAttemptAt: state === "never" ? null : "2026-08-26T12:00:00Z", lastSuccessAt: null, nextAttemptAt: null })] });
  await page.goto("/administration");
  const status = page.getByRole("region", { name: "Business B connection" }).getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText(`Last attempt: ${labels[state]}`);
  await expect(status).toContainText("Last success: Not recorded");
  await expect(status).not.toContainText(/Succeeded|Next attempt not before|Invalid Date/);
});

test("recovery metadata never changes the manual source control or invents success after a manual sync", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), connector()]), recovery: [recovery({ status: "failed", errorCode: "snapshot_unavailable", failureCount: 1 })] };
  const requests = await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" }), status = card.getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText("Last attempt: Failed");
  await card.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Business B synchronization finished." })).toBeVisible();
  await expect(status).toContainText("Last attempt: Failed");
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled();
  expect(requests.filter(row => row.method !== "GET")).toEqual([{ path: `${endpoint}/project-alpha%3Abusiness-b/sync`, method: "POST", body: {}, csrf: "csrf-fixture" }]);
});

test("scheduled recovery status wraps without overlapping connection controls at all supported widths", async ({ page }, testInfo) => {
  const data: Directory = { ...directory([connector(primary), { ...connector(), displayName: "Business B regional surveying and environmental documentation company" }]),
    recovery: [recovery({ status: "failed", errorCode: "connector_configuration_unavailable_for_scheduled_business_data_recovery", failureCount: 3 })] };
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await fixture(page, data);
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B regional surveying and environmental documentation company connection" });
  const status = card.getByRole("group", { name: "Scheduled recovery" });
  await expect(status).toContainText("Last attempt: Failed");
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 1000 });
    await status.getByText("Recovery schedule", { exact: true }).focus();
    await expect(status.getByText("Recovery schedule", { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const box = (await status.boundingBox())!, actions = (await card.locator(".alpha-connection-actions").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(actions.y - (box.y + box.height)).toBeGreaterThanOrEqual(8);
    for (const button of await card.locator(".alpha-connection-actions button").all()) {
      const buttonBox = (await button.boundingBox())!;
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
      if (width <= 640) expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    }
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`project-alpha-recovery-${width}-viewport.png`) });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`project-alpha-recovery-${width}-full.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
