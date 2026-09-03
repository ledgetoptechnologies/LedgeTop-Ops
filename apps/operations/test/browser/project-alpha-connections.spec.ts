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
  portal?: { available: boolean; authorities: Array<{ sourceId: string; state: Connector["state"]; version: number; activeRevision: number; connectorRevision: number }>;
    recovery: { version: number; sourceId: string; action: string; startedAt: string } | null };
  projectManagement?: Array<{ sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null }>;
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
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: { ready: false, workflows: {
      nativeFeedback: { state: "unverified", reasons: ["client_runtime_unverified"] },
      serviceRequests: { state: "unverified", reasons: ["client_runtime_unverified"] },
      requestAttachments: { state: "unverified", reasons: ["client_runtime_unverified"] },
      delegatedSharing: { state: "blocked", reasons: ["client_runtime_unverified", "operations_feature_disabled"] },
      expiryNotices: { state: "blocked", reasons: ["operations_feature_disabled"] },
    } } });
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

test("legacy business health never implies that exact-source portal enrollment exists", async ({ page }) => {
  const data = { ...directory([]), legacyPrimary: true };
  data.health.push({ sourceId: primary, status: "healthy", lastAttemptAt: "2026-09-02T20:27:05Z",
    lastSuccessAt: "2026-09-02T20:27:09Z", lastErrorCode: null });
  await fixture(page, data);
  await page.goto("/administration");
  const card = page.locator(".alpha-connection").filter({ has: page.getByRole("heading", { name: "Primary connection", exact: true }) });
  await expect(card).toContainText("Business record sync");
  await expect(card).toContainText("Sync: healthy");
  await expect(card).toContainText("Exact-source connector upgrade · Not enrolled");
  await expect(card).toContainText("separately configured portal producer remain unchanged");
  await expect(card).toContainText("sync health alone is not portal-access authority");

  data.connectors.push(connector(primary, "pending"));
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(card).toContainText("Exact-source connector upgrade · Staged for review");
  await expect(card).not.toContainText("Exact-source connector upgrade · Enrolled");
});

test("project management config is exact-source, reviewed, versioned and never creates a local project", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), connector()]), projectManagement: [] };
  const requests = await fixture(page, data, async (route, path) => {
    if (route.request().method() !== "PUT" || !path.endsWith("/project-management")) return false;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(path).toBe(`${endpoint}/${encodeURIComponent(secondary)}/project-management`);
    expect(body.expectedConnectorVersion).toBe(3); expect(body.expectedVersion).toBeNull();
    expect(body.reviewedUrlTemplate).toBe("https://business-b.example.test/clients/{recordId}/projects/create");
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const saved = { sourceId: secondary, version: 1, revision: 1, enabled: true, reviewedUrlTemplate: body.reviewedUrlTemplate as string };
    data.projectManagement = [saved];
    await route.fulfill({ json: { projectManagement: { ...saved, replayed: false } } }); return true;
  });
  await page.goto("/administration");
  const primaryCard = page.getByRole("region", { name: "Primary company connection" });
  const secondaryCard = page.getByRole("region", { name: "Business B connection" });
  await expect(primaryCard.getByRole("group", { name: "Project management" })).toContainText("Not configured");
  const projectManagement = secondaryCard.getByRole("group", { name: "Project management" });
  await projectManagement.getByRole("checkbox", { name: "Enable external project creation" }).check();
  await projectManagement.getByLabel("Reviewed Project Alpha URL template").fill("https://business-b.example.test/clients/{recordId}/projects/create");
  await confirmation(page, () => projectManagement.getByRole("button", { name: "Save project route" }).click(), /exact source.*does not grant Project Alpha access or create a project in Operations/i, true);
  await expect(projectManagement).toContainText("Enabled");
  expect(requests.filter(row => row.method === "PUT")).toHaveLength(1);
  expect(requests.filter(row => row.method === "PUT")[0]!.csrf).toBe("csrf-fixture");
  expect(requests.some(row => row.path === "/api/projects" || row.path.includes("/create-project"))).toBe(false);
});

test("project management rejects unsafe templates locally and reports unavailable registry and source state", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), { ...connector(), state: "suspended", readVisible: true }]) };
  const requests = await fixture(page, data);
  await page.goto("/administration");
  await expect(page.getByRole("region", { name: "Primary company connection" }).getByRole("group", { name: "Project management" }))
    .toContainText("Requires coordinated database upgrade");
  expect(requests.filter(row => row.method === "PUT")).toHaveLength(0);

  data.projectManagement = [];
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(page.getByRole("region", { name: "Business B connection" }).getByRole("group", { name: "Project management" }))
    .toContainText("Activate this connection");
  data.connectors[1]!.state = "active";
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  const projectManagement = page.getByRole("region", { name: "Business B connection" }).getByRole("group", { name: "Project management" });
  await projectManagement.getByRole("checkbox", { name: "Enable external project creation" }).check();
  await projectManagement.getByLabel("Reviewed Project Alpha URL template").fill("http://user:secret@example.test/projects?token=secret");
  await projectManagement.getByRole("button", { name: "Save project route" }).click();
  await expect(projectManagement.getByRole("alert")).toContainText("must use HTTPS");
  expect(requests.filter(row => row.method === "PUT")).toHaveLength(0);
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

test("pending primary enrollment preserves legacy synchronization and submits references, never credentials", async ({ page }) => {
  const data = { ...directory([]), legacyPrimary: true };
  const requests = await fixture(page, data, async (route, path) => {
    if (route.request().method() === "POST" && path === `${endpoint}/primary-preflight`) {
      await route.fulfill({ json: { preflight: { ready: true, sourceId: primary, profile: "primary_legacy", reasons: [],
        expected: { snapshotOrigin: "https://registered.example.test", snapshotBasePath: "/api/exports", applicationKey: "external_operations" } } } }); return true;
    }
    if (route.request().method() !== "POST" || path !== endpoint) return false;
    data.connectors.push({ ...connector(primary, "pending"), displayName: "Registered company", version: 1 });
    await route.fulfill({ json: { connector: data.connectors[0] } }); return true;
  });
  await page.goto("/administration");
  const form = await fillRegistration(page, primary);
  await expect(form.locator('input[type="password"]')).toHaveCount(0);
  await expect(form.getByLabel(/API token|API secret|Signing key|Private key|Password/i)).toHaveCount(0);
  await expect(form.getByLabel("Credential reference")).toHaveAttribute("placeholder", "Deployed secret reference, not the secret");
  await expect(form.getByRole("button", { name: "Register pending connection" })).toBeDisabled();
  await form.getByRole("button", { name: "Check primary readiness" }).click();
  await expect(form.getByRole("status")).toContainText("Ready to stage");
  await expect(form.getByRole("button", { name: "Register pending connection" })).toBeEnabled();
  await form.getByLabel("Connection label").fill("Changed company");
  await expect(form.getByRole("button", { name: "Register pending connection" })).toBeDisabled();
  await form.getByLabel("Connection label").fill("Registered company");
  await form.getByRole("button", { name: "Check primary readiness" }).click();
  await expect(form.getByRole("status")).toContainText("Ready to stage");
  await confirmation(page, () => form.getByRole("button", { name: "Register pending connection" }).click(), /current deployment connection keeps synchronizing until you activate/, false);
  expect(requests.filter(row => row.method === "POST" && row.path === endpoint)).toHaveLength(0);
  await confirmation(page, () => form.getByRole("button", { name: "Register pending connection" }).click(), /must match the deployed producer and signing keys/, true);
  const request = requests.find(row => row.method === "POST" && row.path === endpoint)!;
  expect(request.csrf).toBe("csrf-fixture");
  expect(request.body).toEqual({ sourceId: primary, producerBindingId: "producer-registered", displayName: "Registered company",
    snapshotOrigin: "https://registered.example.test", applicationKey: "external_operations", profile: "primary_legacy",
    revision: { credentialRef: "PA_REGISTERED", snapshotBasePath: "/api/exports", accessIssuer: "https://team.cloudflareaccess.com",
      accessAudience: "audience-registered", accessSubject: "producer-subject" } });
  const card = page.getByRole("region", { name: "Registered company connection" });
  await expect(card).toContainText("pending");
  await expect(card).toContainText("existing deployment connection remains active");
  const legacyCard = page.locator(".alpha-connection").filter({ has: page.getByRole("heading", { name: "Primary connection", exact: true }) });
  await expect(legacyCard).toContainText("Exact-source connector upgrade · Staged for review");
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: /Hide business records|Show business records/ })).toHaveCount(0);
});

test("primary registration stays blocked with a clear bounded readiness reason", async ({ page }) => {
  const requests = await fixture(page, { ...directory([]), legacyPrimary: true }, async (route, path) => {
    if (route.request().method() !== "POST" || path !== `${endpoint}/primary-preflight`) return false;
    await route.fulfill({ json: { preflight: { ready: false, sourceId: primary, profile: "primary_legacy",
      expected: { snapshotOrigin: "https://primary.example.test", snapshotBasePath: "/", applicationKey: "external_operations" },
      reasons: [{ code: "connector_credentials_unavailable", message: "The selected deploy-managed credential reference is unavailable or invalid." }] } } });
    return true;
  });
  await page.goto("/administration");
  const form = await fillRegistration(page, primary);
  const register = form.getByRole("button", { name: "Register pending connection" });
  await expect(register).toBeDisabled();
  await form.getByRole("button", { name: "Check primary readiness" }).click();
  await expect(form.getByRole("status")).toContainText("Primary enrollment blocked");
  await expect(form.getByRole("status")).toContainText("connector_credentials_unavailable");
  await expect(register).toBeDisabled();
  expect(requests.filter(row => row.method === "POST" && row.path === endpoint)).toHaveLength(0);
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

test("portal configuration reuses the selected connection and activation is a separate confirmed action", async ({ page }, testInfo) => {
  const data: Directory = { ...directory([connector(primary), connector()]), portal: { available: true, authorities: [], recovery: null } };
  const requests = await fixture(page, data, async route => {
    if (!new URL(route.request().url()).pathname.endsWith("/portal")) return false;
    const body = route.request().postDataJSON();
    const old = data.portal!.authorities[0];
    expect(body).toEqual({ expectedVersion: 3, expectedPortalVersion: old?.version ?? null, action: body.action });
    const updated = { sourceId: secondary, state: body.action === "activate" ? "active" as const : body.action === "suspend" ? "suspended" as const : "pending" as const,
      version: (old?.version ?? 0) + 1, activeRevision: 1, connectorRevision: 1 };
    data.portal!.authorities = [updated];
    await route.fulfill({ json: { authority: updated } }); return true;
  });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  const portal = card.getByRole("group", { name: "Client portal connection" });
  await expect(portal).toContainText("Not configured");
  await expect(portal.locator("input")).toHaveCount(0);
  await confirmation(page, () => portal.getByRole("button", { name: "Configure client portal" }).click(), /current deployed signing credentials/, false);
  expect(requests.filter(row => row.method !== "GET")).toHaveLength(0);
  await confirmation(page, () => portal.getByRole("button", { name: "Configure client portal" }).click(), /explicitly activate/, true);
  await expect(portal).toContainText("pending");
  expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
  await confirmation(page, () => portal.getByRole("button", { name: "Activate client portal" }).click(), /does not merge customer permissions/, true);
  await expect(portal.getByRole("button", { name: "Pause client portal" })).toBeVisible();
  await confirmation(page, () => portal.getByRole("button", { name: "Pause client portal" }).click(), /records and grants are retained/, true);
  await expect(portal.getByRole("button", { name: "Activate client portal" })).toBeEnabled();
  expect(requests.filter(row => row.method === "POST").map(row => row.body?.action)).toEqual(["configure", "activate", "suspend"]);
  expect(requests.filter(row => row.method === "POST").every(row => row.csrf === "csrf-fixture")).toBe(true);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 1000 });
    await portal.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const button of await portal.getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await page.screenshot({ path: testInfo.outputPath(`portal-purpose-${width}.png`) });
  }
});

test("portal activation stays unavailable for suspended sources, paused primary or outdated credentials", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary, "suspended"), connector()]), portal: { available: true,
    authorities: [{ sourceId: secondary, state: "pending", version: 1, activeRevision: 1, connectorRevision: 1 }], recovery: null } };
  const requests = await fixture(page, data);
  await page.goto("/administration");
  const portal = page.getByRole("region", { name: "Business B connection" }).getByRole("group", { name: "Client portal connection" });
  await expect(portal.getByRole("button", { name: "Activate client portal" })).toBeDisabled();
  data.connectors[0]!.state = "active"; data.connectors[1]!.state = "suspended";
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(portal.getByRole("button", { name: "Activate client portal" })).toBeDisabled();
  data.connectors[1]!.state = "active"; data.connectors[1]!.activeRevision = 2;
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(portal).toContainText("Configure the portal using the current connection revision");
  await expect(portal.getByRole("button", { name: "Activate client portal" })).toBeDisabled();
  expect(requests.filter(row => row.method !== "GET")).toHaveLength(0);
});

test("uncertain portal updates block mutations and offer explicit recovery without automatic reactivation", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), connector()]), portal: { available: true,
    authorities: [{ sourceId: secondary, state: "pending", version: 1, activeRevision: 1, connectorRevision: 1 }], recovery: null } };
  const requests = await fixture(page, data, async (route, path) => {
    if (route.request().method() !== "POST") return false;
    if (path.endsWith("/portal")) {
      data.portal!.recovery = { version: 9, sourceId: secondary, action: "activate", startedAt: "2026-08-26T14:00:00Z" };
      await route.fulfill({ status: 503, json: { error: "The update could not be confirmed. Recover the unfinished update." } }); return true;
    }
    if (path.endsWith("/recover-portal-update")) {
      expect(route.request().postDataJSON()).toEqual({ expectedVersion: 9 });
      data.portal!.recovery = null; data.portal!.authorities[0]!.state = "suspended"; data.portal!.authorities[0]!.version = 2;
      await route.fulfill({ json: { recovered: true } }); return true;
    }
    return false;
  });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Business B connection" });
  await confirmation(page, () => card.getByRole("button", { name: "Activate client portal" }).click(), /independently authorized/, true);
  const recover = page.getByRole("button", { name: "Recover unfinished connection update" });
  await expect(recover).toBeEnabled();
  await expect(card.getByRole("button", { name: "Activate client portal" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Suspend sync" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Sync now", exact: true })).toBeDisabled();
  await confirmation(page, () => recover.click(), /pause all registered secondary client portals/, false);
  expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
  await confirmation(page, () => recover.click(), /review and reactivate each portal afterward/, true);
  await expect(recover).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Activate client portal" })).toBeEnabled();
  expect(requests.filter(row => row.method === "POST")).toHaveLength(2);
});

test("a stale portal version reloads state but never retries activation automatically", async ({ page }) => {
  const data: Directory = { ...directory([connector(primary), connector()]), portal: { available: true,
    authorities: [{ sourceId: secondary, state: "pending", version: 1, activeRevision: 1, connectorRevision: 1 }], recovery: null } };
  const requests = await fixture(page, data, async route => {
    if (!new URL(route.request().url()).pathname.endsWith("/portal")) return false;
    const expected = route.request().postDataJSON().expectedPortalVersion;
    if (expected === 1) {
      data.portal!.authorities[0]!.version = 2;
      await route.fulfill({ status: 409, json: { error: "Portal connection changed. Refresh its status before continuing" } });
    } else {
      expect(expected).toBe(2); data.portal!.authorities[0]!.state = "active"; data.portal!.authorities[0]!.version = 3;
      await route.fulfill({ json: { authority: data.portal!.authorities[0] } });
    }
    return true;
  });
  await page.goto("/administration");
  const activate = page.getByRole("button", { name: "Activate client portal" });
  await confirmation(page, () => activate.click(), /independently authorized/, true);
  await expect(page.getByRole("alert")).toContainText("Portal connection changed");
  await expect(activate).toBeEnabled();
  expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
  await confirmation(page, () => activate.click(), /independently authorized/, true);
  await expect(page.getByRole("button", { name: "Pause client portal" })).toBeVisible();
  expect(requests.filter(row => row.method === "POST").map(row => row.body?.expectedPortalVersion)).toEqual([1, 2]);
});
